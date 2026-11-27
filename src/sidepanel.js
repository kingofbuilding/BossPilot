const $ = id => document.getElementById(id);
const settings = globalThis.JobCopilotSettings;
const PHASE_LABELS = { idle: '未开始', collecting: '搜索与筛选中', review: '筛选完成，等待审核', delivering: '投递中', done: '已完成' };
const PROCESSED_LABELS = { sent: '✓ 已投递招呼语', stayed: '✓ 已点击「留在此页」', unconfirmed: '沟通结果待确认，请在 BOSS 核对' };
const revisions = { phase: 0, review: 0, progress: 0 };
let configLoaded = false, running = false, pending = false, paused = false, stopping = false, phase = 'idle', toastTimer;
let latestReview = [], processedJobs = {};
let previewing = false;
const busy = () => running || pending;

function switchTab(view) {
  document.querySelectorAll('[data-tab]').forEach(button => {
    const active = button.dataset.tab === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  document.querySelectorAll('[data-view]').forEach(section => { section.hidden = section.dataset.view !== view; });
  document.querySelector('.work-actions').hidden = view !== 'work';
  document.querySelector('.settings-actions').hidden = view !== 'settings';
  document.querySelector('.panel-content').scrollTop = 0;
  if (view === 'work' && configLoaded) {
    updateSummary();
    if (!busy() && latestReview.length && !JobFilters.validate(readCfg())) renderReview(latestReview, true);
  }
}
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
$('adjustSettings').addEventListener('click', () => switchTab('settings'));
function toast(text) {
  clearTimeout(toastTimer);
  $('saved').textContent = text;
  $('saved').hidden = false;
  toastTimer = setTimeout(() => { $('saved').hidden = true; }, 3000);
}
function updateSummary() {
  const keywords = JobFilters.list($('keyword').value);
  $('searchLabel').textContent = keywords.join(' / ') || '请设置岗位关键词';
  $('cityLabel').textContent = $('city').value.trim() || '全国';
  $('countLabel').textContent = '合计目标 ' + ($('count').value || '40') + ' 个';
  const mode = $('screeningMode').value;
  $('screeningLabel').textContent = mode === 'employment' ? '校招就业' : '实习';
  if ($('paceLabel')) $('paceLabel').textContent = { fast: '高效快速', normal: '均衡自然', safe: '稳健防风控' }[$('paceMode').value] || '均衡自然';
  document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
  const salaryUnit = $('salaryUnit').selectedOptions[0]?.textContent.trim() || '';
  const restrictionNames = [
    $('excludedCompanies').value.trim() && '黑名单 ' + JobFilters.list($('excludedCompanies').value).length + ' 家',
    $('allowedCompanies').value.trim() && '白名单 ' + JobFilters.list($('allowedCompanies').value).length + ' 家',
    $('allowedAreas').value.trim() && '地区 ' + $('allowedAreas').value.trim(),
    $('maxDistanceKm').value && '最远 ' + $('maxDistanceKm').value + ' 公里',
    $('minSalary').value && '起薪 ≥ ' + $('minSalary').value + ' ' + salaryUnit,
    $('maxSalary').value && '上限 ≤ ' + $('maxSalary').value + ' ' + salaryUnit
  ].filter(Boolean);
  if ($('excludeBigTech').checked) restrictionNames.unshift('常见大厂排除');
  $('restrictionSummary').textContent = restrictionNames.length ? '已设置：' + restrictionNames.join('、') : '可在求职设置中填写公司、地区、距离和薪资。';
  updateReady();
}
function updateReady() {
  const configured = !!$('keyword').value.trim();
  $('readyText').textContent = !configLoaded ? '加载中' : busy() ? (stopping ? '正在停止' : paused ? '已暂停' : '运行中') :
    phase === 'review' ? '待审核' : configured ? '已就绪' : '待配置';
  document.querySelector('.ready').classList.toggle('needs-config', !configured && !busy());
}
function updateGreetingMode() { $('fixedGreetingBody').hidden = $('greetingMode').value !== 'fixed'; }
$('greetingMode').addEventListener('change', updateGreetingMode);
function changeModule() {
  clearReview();
  applyPhase({ phase: 'idle' });
  updateSummary();
}
$('screeningMode').addEventListener('change', changeModule);
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', async () => {
  if (!configLoaded || busy() || $('screeningMode').value === button.dataset.mode) return;
  $('screeningMode').value = button.dataset.mode;
  changeModule();
  try { await chrome.storage.local.set({ screeningMode: button.dataset.mode }); }
  catch (error) { toast('保存模块失败：' + error.message); }
}));
function showImg(dataUrl, name) {
  const image = document.createElement('img');
  image.className = 'image-preview'; image.alt = '已上传简历图片的预览'; image.src = dataUrl;
  $('imgPrev').replaceChildren(image);
  document.querySelector('.upload-name').textContent = name || '已上传简历图片 · 点击更换';
}
$('resumeImg').addEventListener('change', event => {
  const file = event.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast('请选择图片文件。');
  const reader = new FileReader();
  reader.onerror = () => toast('图片读取失败，请重新选择。');
  reader.onload = async event => {
    try {
      await chrome.storage.local.set({ resumeImage: event.target.result });
      showImg(event.target.result, file.name); toast('图片已保存，是否发送由开关决定。');
    } catch (error) { toast('图片保存失败：' + error.message); }
  };
  reader.readAsDataURL(file);
});
function readCfg() {
  const obj = {};
  settings.formFields.forEach(field => {
    const input = $(field);
    obj[field] = input.type === 'checkbox' ? input.checked : input.value.trim();
  });
  obj.sendResumeImage = $('sendResumeImage').checked;
  obj.filterVersion = settings.filterVersion;
  return obj;
}
function validateCount() {
  if (settings.searchCount({ count: $('count').value }) === null) {
    settingsError('合计目标请填写 1–' + JobFilters.maxSearchCount + ' 的整数。', 'count'); return false;
  }
  return true;
}
function validateFilters() {
  const error = JobFilters.validate(readCfg());
  if (!error) return true;
  settingsError(error[1], error[0]);
  return false;
}
async function saveCfgSync() { await chrome.storage.local.set(readCfg()); updateSummary(); }
$('saveCfg').addEventListener('click', async () => {
  if (!configLoaded || !validateCount() || ($('keyword').value.trim() && !validateFilters())) return;
  try {
    await saveCfgSync();
    if (!busy() && latestReview.length) renderReview(latestReview, true);
    toast('配置已保存，切回工作台即可开始。');
  }
  catch (error) { toast('配置保存失败：' + error.message); }
});
function settingsError(text, field) { addLog(text, 'error'); switchTab('settings'); $(field).focus(); toast(text); }
async function sendCommand(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (!response || response.ok !== true) throw new Error(response?.error || '后台未响应，请重新加载插件');
    return true;
  } catch (error) { toast(error.message); addLog(error.message, 'error'); return false; }
}
async function startBatch(message) {
  setPending(true);
  try {
    await saveCfgSync();
    await sendCommand(message);
  } catch (error) {
    toast('配置保存失败：' + error.message);
  } finally {
    setPending(false);
  }
}
$('btnCollect').addEventListener('click', async () => {
  if (!configLoaded || busy() || !validateCount()) return;
  if (!validateFilters()) return;
  await startBatch({ type: 'START_COLLECT' });
});
$('btnDeliver').addEventListener('click', async () => {
  if (!configLoaded || busy() || !validateFilters()) return;
  const ids = Array.from(document.querySelectorAll('.job-item input:checked:not(:disabled)')).map(input => input.dataset.id);
  if (!ids.length) return toast('请至少勾选一个岗位。');
  const invalid = settings.greetingError(readCfg());
  if (invalid) return settingsError(invalid[1], invalid[0]);
  if ($('sendResumeImage').checked && !$('imgPrev').querySelector('img')) {
    return settingsError('请先上传简历图片，或关闭发送图片。', 'resumeImg');
  }
  await startBatch({ type: 'START_DELIVER', jobIds: ids });
});
$('btnInspectContact').addEventListener('click', async () => {
  if (!configLoaded || busy() || !validateFilters()) return;
  const input = document.querySelector('.job-item input:checked:not(:disabled)');
  if (!input) return;
  setPending(true);
  try {
    await saveCfgSync();
    if (await sendCommand({ type: 'INSPECT_REVIEWED_CONTACT', jobId: input.dataset.id })) {
      toast('已找到网页沟通按钮。检查未点击沟通。');
    }
  } catch (error) {
    toast(error.message);
    addLog(error.message, 'error');
  } finally {
    setPending(false);
  }
});
$('btnPreviewGreeting').addEventListener('click', async () => {
  if (busy() || previewing || !validateFilters()) return;
  const selected = document.querySelector('.job-item input:checked:not(:disabled)');
  const job = selected && latestReview.find(item => item.id === selected.dataset.id);
  if (!job) return;
  previewing = true;
  updateSelection();
  const dialog = $('greetingDialog');
  $('greetingJob').textContent = job.name + (job.company ? ' · ' + job.company : '');
  $('greetingDraft').value = '';
  $('greetingNote').textContent = '正在准备草稿…';
  dialog.showModal();
  try {
    await saveCfgSync();
    const response = await chrome.runtime.sendMessage({ type: 'PREVIEW_GREETING', jobId: job.id });
    if (!response?.ok) throw new Error(response?.error || '没有收到招呼语草稿');
    $('greetingDraft').value = response.draft.text;
    $('greetingNote').textContent = response.draft.fixed ? '来自你填写的固定招呼语。' :
      response.draft.grounded ? '使用简历中的原文。实际投递时会结合岗位详情重新生成。' :
        '没有选到可核对的经历，草稿只表达求职意向。实际投递时会结合岗位详情重新生成。';
  } catch (error) {
    $('greetingNote').textContent = error.message;
  } finally {
    previewing = false;
    updateSelection();
  }
});
$('btnPause').addEventListener('click', async () => {
  await sendCommand({ type: paused ? 'RESUME' : 'PAUSE' });
});
$('btnStop').addEventListener('click', async () => {
  await sendCommand({ type: 'STOP' });
});
$('btnReset').addEventListener('click', async () => {
  setPending(true);
  try {
    if (await sendCommand({ type: 'RESET' })) {
      processedJobs = {};
      clearReview();
    }
  } finally {
    setPending(false);
  }
});
$('clearLog').addEventListener('click', () => $('log').replaceChildren());
function updateSelection() {
  const checks = Array.from(document.querySelectorAll('.job-item input:not(:disabled)'));
  const selected = checks.filter(input => input.checked).length;
  $('selectedCount').textContent = '已选 ' + selected + ' 个';
  $('deliverLabel').textContent = selected ? '投递选中的 ' + selected + ' 个岗位' : '投递选中岗位';
  $('btnDeliver').disabled = !configLoaded || busy() || !selected;
  $('btnInspectContact').disabled = !configLoaded || busy() || !selected;
  $('btnPreviewGreeting').disabled = !configLoaded || busy() || previewing || !selected;
  $('selAll').checked = checks.length > 0 && selected === checks.length;
  $('selAll').indeterminate = selected > 0 && selected < checks.length;
  $('selAll').disabled = !checks.length;
}
$('selAll').addEventListener('change', event => {
  document.querySelectorAll('.job-item input:not(:disabled)').forEach(input => { input.checked = event.target.checked; }); updateSelection();
});
$('reviewList').addEventListener('change', updateSelection);
function setPending(value) {
  pending = value;
  updateControls();
}
function updateControls() {
  $('btnCollect').disabled = !configLoaded || busy();
  $('btnPause').disabled = $('btnStop').disabled = !running || stopping;
  $('btnPause').textContent = paused ? '继续' : '暂停';
  $('btnReset').disabled = !configLoaded || busy();
  $('screeningMode').disabled = busy();
  document.querySelectorAll('[data-mode]').forEach(button => { button.disabled = !configLoaded || busy(); });
  updateSelection(); updateReady();
}
function showProgress(value) {
  $('progText').textContent = value ? (value.label ? value.label + ' ' : '') + value.cur + '/' + value.total : '';
}
function applyPhase(status) {
  if (phase !== status.phase) showProgress(null);
  phase = status.phase;
  running = phase === 'collecting' || phase === 'delivering';
  paused = status.paused === true;
  stopping = status.stopping === true;
  $('phaseText').textContent = stopping ? '正在停止' : paused ? '已暂停' : PHASE_LABELS[phase] || phase;
  const step = { collecting: 0, review: 2, delivering: 3, done: 4 }[phase];
  document.querySelectorAll('.step').forEach((element, index) => {
    element.classList.toggle('done', step !== undefined && index < step);
    element.classList.toggle('current', index === step);
    element.querySelector('b').textContent = step !== undefined && index < step ? '✓' : String(index + 1);
  });
  updateControls();
}
function clearReview() {
  latestReview = [];
  $('progText').textContent = '';
  $('reviewList').innerHTML = '<p class="empty-state">收集并筛选岗位后，在这里审核结果。</p>';
  $('reviewCount').textContent = '等待筛选';
  ['collectedCount', 'matchedCount', 'skippedCount'].forEach(id => { $(id).textContent = '0'; }); updateSelection();
}
function esc(value) { return String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char])); }
function renderReview(screened, preserveSelection = false) {
  if (!Array.isArray(screened)) return;
  const deselected = preserveSelection ? new Set([...document.querySelectorAll('.job-item input:not(:checked):not(:disabled)')]
    .map(input => input.dataset.id)) : new Set();
  latestReview = screened;
  const cfg = readCfg();
  screened = screened.filter(job => job.searchMode === cfg.screeningMode && job.filterVersion === settings.filterVersion).map(job => {
    const rejected = job.match && JobFilters.check(cfg, job);
    return rejected ? { ...job, match: false, reason: rejected } : job;
  });
  const matched = screened.filter(job => job.match), skipped = screened.filter(job => !job.match);
  $('collectedCount').textContent = screened.length; $('matchedCount').textContent = matched.length; $('skippedCount').textContent = skipped.length;
  const doneCount = matched.filter(job => processedJobs[job.id]).length;
  const manual = matched.filter(job => !processedJobs[job.id] && JobFilters.deliveryRejection(cfg, job)).length;
  $('reviewCount').textContent = '匹配 ' + matched.length + ' / ' + screened.length
    + (doneCount ? ' · 已处理 ' + doneCount + ' 个' : '')
    + (manual ? ' · ' + manual + ' 个需人工确认' : '');
  $('reviewList').innerHTML = matched.concat(skipped).map(job => {
    const outcome = job.match && processedJobs[job.id];
    const manualReview = job.match && !outcome && JobFilters.deliveryRejection(cfg, job);
    const canSend = job.match && !outcome && !manualReview;
    const original = typeof job.id === 'string' && /^[\w-]+$/.test(job.id)
      ? '<a class="text-button" href="https://www.zhipin.com/job_detail/' + job.id + '.html" target="_blank" rel="noopener noreferrer">打开原岗位</a>' : '';
    const selection = canSend ? (deselected.has(job.id) ? '' : 'checked') : 'disabled';
    const stateClass = !job.match ? ' skipped skip' : outcome ? (' processed' + (outcome === 'unconfirmed' ? ' unconfirmed' : '')) : '';
    const reasonText = outcome ? (PROCESSED_LABELS[outcome] || '已处理') : (manualReview || job.reason || '通过已启用的筛选条件');
    return '<div class="job job-item' + stateClass + '"><input type="checkbox" ' + selection
      + ' data-id="' + esc(job.id) + '" aria-label="选择 ' + esc(job.name) + '"><div class="job-main"><div class="job-title">' + esc(job.name) + '</div>'
      + '<div class="job-salary">' + esc(job.salary || '薪资未获取') + '</div>'
      + '<div class="company"><svg aria-hidden="true"><use href="#building"/></svg>' + esc(job.company || '公司未获取') + '</div>'
      + '<div class="job-meta">' + esc([job.employmentType, job.location, job.distanceText, (job.searchKeywords || []).join(' / ')].filter(Boolean).join(' · ')) + '</div>'
      + '<div class="reason">' + esc(reasonText) + '</div>'
      + (job.match ? original : '') + '</div></div>';
  }).join('') || '<p class="empty-state">暂无岗位，请调整条件后重新筛选。</p>';
  updateSelection();
}
chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'LOG') addLog(message.text, message.level);
  if (message.type === 'PROGRESS') {
    revisions.progress++;
    showProgress(message);
  }
  if (message.type === 'PHASE') {
    revisions.phase++;
    applyPhase(message);
  }
  if (message.type === 'SCREENED') {
    revisions.review++;
    if (message.processed) processedJobs = message.processed;
    renderReview(message.screened);
    switchTab('work');
  }
  if (message.type === 'DONE') {
    if (message.processed) processedJobs = message.processed;
    if (latestReview.length) renderReview(latestReview, true);
  }
});
function addLog(text, level) {
  const row = document.createElement('div'); row.className = 'log-item ' + (['info', 'success', 'error', 'warn'].includes(level) ? level : 'info');
  const time = document.createElement('span'); time.className = 'log-time'; time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const message = document.createElement('span'); message.className = 'log-message'; message.textContent = String(text ?? '');
  row.append(time, message); $('log').append(row); $('log').scrollTop = $('log').scrollHeight;
}
async function init() {
  switchTab('work');
  const manifest = chrome.runtime.getManifest();
  $('extensionVersion').textContent = manifest.name + ' ' + manifest.version;
  try {
    const data = await chrome.storage.local.get(settings.storageFields);
    settings.formFields.forEach(field => {
      const input = $(field);
      if (input.type === 'checkbox') input.checked = data[field] === true;
      else if (data[field] !== undefined) input.value = data[field];
    });
    $('screeningMode').value = JobFilters.screeningMode(data);
    $('paceMode').value = settings.paceMode(data);
    $('dialogAction').value = settings.dialogAction(data);
    $('excludeBigTech').checked = JobFilters.excludesBigTech(data);
    $('sendResumeImage').checked = settings.sendsImage(data);
    if ($('greetingMode').value !== 'fixed') $('greetingMode').value = 'ai';
    if (data.resumeImage) showImg(data.resumeImage);
    updateGreetingMode();
    const revision = { ...revisions };
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!state?.phase) throw new Error(state?.error || '后台未返回任务状态');
    if (revision.phase === revisions.phase) {
      applyPhase(state);
      if (revision.progress === revisions.progress) showProgress(state.progress);
    }
    if (revision.review === revisions.review) {
      processedJobs = state.processed || {};
      if (state.screened?.length) renderReview(state.screened);
    }
    configLoaded = true; $('saveCfg').disabled = false; updateSummary(); updateControls();
  } catch (error) {
    $('readyText').textContent = '加载失败'; toast('读取配置失败，请重新打开侧栏。'); addLog('读取配置失败：' + error.message, 'error');
  }
}
init();
