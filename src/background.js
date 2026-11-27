// 任务状态、配置读取和侧栏消息。页面操作、收集和投递分别由下列脚本处理。
importScripts('/src/selectors.js', '/src/job-filters.js', '/src/settings.js', '/src/greeting.js',
  '/src/background-tabs.js', '/src/background-collect.js', '/src/background-deliver.js');
const { cities, protocol, assertDeliveryTime } = globalThis.JobCopilotPage;
const settings = globalThis.JobCopilotSettings;

const state = { phase: 'idle', paused: false, aborted: false, progress: null, screened: null, processed: {} };
let activeRun = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

function paceProfile(cfg) {
  const mode = settings.paceMode(cfg);
  if (mode === 'fast') {
    return { label: '高效快速', pageMin: 1200, pageMax: 2200, kwMin: 1500, kwMax: 2500, jdMin: 500, jdMax: 1000, chatMin: 500, chatMax: 1000, gapMin: 2000, gapMax: 4000, restEvery: 20, restMin: 8000, restMax: 12000 };
  }
  if (mode === 'safe') {
    return { label: '稳健防风控', pageMin: 2600, pageMax: 4500, kwMin: 3000, kwMax: 5000, jdMin: 1200, jdMax: 2200, chatMin: 900, chatMax: 1600, gapMin: 6000, gapMax: 11000, restEvery: 12, restMin: 18000, restMax: 26000 };
  }
  return { label: '均衡自然', pageMin: 1800, pageMax: 3200, kwMin: 2200, kwMax: 3600, jdMin: 800, jdMax: 1500, chatMin: 700, chatMax: 1200, gapMin: 3500, gapMax: 6500, restEvery: 15, restMin: 12000, restMax: 18000 };
}

async function humanPause(minMs, maxMs) {
  const total = randInt(minMs, maxMs);
  let remaining = total;
  while (remaining > 0 && !state.aborted) {
    await waitIfPaused();
    if (state.aborted) break;
    const slice = Math.min(300, remaining);
    await sleep(slice);
    remaining -= slice;
  }
  return total;
}

function configureSidePanel() {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(configureSidePanel);
configureSidePanel();

function publish(type, data = {}) {
  chrome.runtime.sendMessage({ type, ...data }).catch(() => {});
}
function log(text, level = 'info') { publish('LOG', { text, level }); }
function phaseStatus() {
  const running = activeRun === 'collecting' || activeRun === 'delivering';
  return { phase: state.phase, paused: running && state.paused, stopping: running && state.aborted };
}
function setPhase(phase) {
  state.phase = phase;
  state.progress = null;
  publish('PHASE', phaseStatus());
}
function progress(cur, total, label) {
  state.progress = { cur, total, label };
  publish('PROGRESS', state.progress);
}
async function waitIfPaused() {
  while (state.paused && !state.aborted) await sleep(400);
}
function getCfg() { return chrome.storage.local.get(settings.storageFields); }

async function reviewedJobs() {
  if (state.screened !== null) return state.screened;
  const { sw_screened } = await chrome.storage.local.get('sw_screened');
  state.screened ??= (sw_screened || []).filter(job => job.filterVersion === settings.filterVersion);
  return state.screened;
}

async function previewGreeting(id) {
  const [cfg, jobs] = await Promise.all([getCfg(), reviewedJobs()]);
  const job = jobs.find(candidate => candidate.id === id && candidate.match && candidate.searchMode === JobFilters.screeningMode(cfg));
  if (!job) throw new Error('请先收集并选中一个合格岗位');
  const reason = JobFilters.check(cfg, job);
  if (reason) throw new Error(reason);
  const invalid = settings.greetingError(cfg);
  if (invalid) throw new Error(invalid[1]);
  if (cfg.greetingMode === 'fixed') return { text: cfg.fixedGreeting.trim(), fixed: true };
  return GreetingDraft.draft(cfg, job);
}

async function processedJobs() {
  const { processed } = await chrome.storage.local.get('processed');
  state.processed = { ...processed, ...state.processed };
  return state.processed;
}

async function executeBatch(phase, task) {
  activeRun = phase;
  state.aborted = false;
  state.paused = false;
  setPhase(phase);
  // Chrome may suspend the worker during a long pause or a slow page response.
  const heartbeat = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  let result;
  try {
    await reviewedJobs();
    if (!state.aborted) result = await task();
  } catch (error) {
    if (!state.aborted) log(error.message, 'error');
  } finally {
    clearInterval(heartbeat);
    activeRun = null;
  }
  if (state.aborted) log('已停止，保留审核列表和投递记录', 'warn');
  const completed = result && !state.aborted;
  const previousReview = state.screened?.length ? 'review' : 'idle';
  const latestProcessed = await processedJobs();
  if (result && phase === 'collecting') publish('SCREENED', { screened: state.screened, processed: latestProcessed });
  if (phase === 'delivering') publish('DONE', { ...(result || {}), processed: latestProcessed });
  setPhase(completed ? (phase === 'delivering' ? 'done' : 'review') : previousReview);
}

async function exclusiveOperation(task) {
  if (activeRun) throw new Error('当前任务尚未结束，请稍候再试');
  activeRun = 'operation';
  try {
    return await task();
  } finally {
    activeRun = null;
  }
}

async function resetReview() {
  await chrome.storage.local.set({ processed: {}, sw_screened: [] });
  state.processed = {};
  state.screened = [];
  setPhase('idle');
  log('已重置（清空已投记录）', 'warn');
}

async function readState() {
  const [screened, processed] = await Promise.all([reviewedJobs(), processedJobs()]);
  const phase = phaseStatus();
  if (phase.phase === 'idle' && screened.length) phase.phase = 'review';
  return { ...phase, screened, processed, progress: state.progress };
}

function reply(promise, sendResponse) {
  promise.then(sendResponse, error => sendResponse({ ok: false, error: error.message, timedOut: !!error.timedOut }));
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'CONTACT_STAGE':
      reportContactStage(msg, sender);
      sendResponse({ ok: true });
      return;
    case 'CHECK_DELIVERY':
      return reply(checkBeforeAction(msg.job, sender, msg.expiresAt).then(() => ({ ok: true })), sendResponse);
    case 'PREVIEW_GREETING':
      return reply(previewGreeting(msg.jobId).then(draft => ({ ok: true, draft })), sendResponse);
    case 'INSPECT_REVIEWED_CONTACT':
      return reply(exclusiveOperation(() => inspectReviewedContact(msg.jobId)).then(() => ({ ok: true })), sendResponse);
    case 'RESET':
      return reply(exclusiveOperation(resetReview).then(() => ({ ok: true })), sendResponse);
    case 'GET_STATE':
      return reply(readState(), sendResponse);
    case 'START_COLLECT':
    case 'START_DELIVER':
      if (activeRun) {
        sendResponse({ ok: false, error: '当前任务尚未结束，请稍候再试' });
        return;
      }
      if (msg.type === 'START_COLLECT') void executeBatch('collecting', runCollect);
      else void executeBatch('delivering', () => runDeliver(msg.jobIds));
      sendResponse({ ok: true });
      return;
    case 'PAUSE':
    case 'RESUME':
    case 'STOP':
      if ((activeRun !== 'collecting' && activeRun !== 'delivering') || state.aborted) {
        sendResponse({ ok: false, error: '目前没有可以操作的任务' });
        return;
      }
      state.paused = msg.type === 'PAUSE';
      state.aborted = msg.type === 'STOP';
      publish('PHASE', phaseStatus());
      if (state.aborted) log('正在停止，等待当前步骤结束', 'warn');
      else log(state.paused ? '已暂停' : '继续');
      sendResponse({ ok: true });
  }
});
