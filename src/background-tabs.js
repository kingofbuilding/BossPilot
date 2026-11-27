// BOSS 标签页导航、通信和人工验证状态。
const pageActionTimeout = 45000;

async function ensurePageScript(tabId, page) {
  const probe = { type: 'JOBCOPILOT_PAGE_READY', page };
  if ((await sendToTab(tabId, probe)).protocol === protocol) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/selectors.js', 'src/job-filters.js', 'src/content-' + page + '.js']
    });
  } catch (error) {
    throw new Error('招聘页面脚本加载失败：' + error.message);
  }
  if ((await sendToTab(tabId, probe)).protocol !== protocol) {
    throw new Error('招聘页面脚本版本不一致，请刷新 BOSS 直聘页面后重试');
  }
}
function sendToTab(tabId, msg, timeoutMs = ['NEXT_RESULTS', 'OPEN_JD'].includes(msg.type) ? pageActionTimeout : 7500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ success: false, timedOut: true, error: '网页在等待时间内未响应' }), timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        clearTimeout(timer);
        const error = chrome.runtime.lastError?.message;
        if (error) {
          resolve({ success: false, error, disconnected: /port.*closed|channel.*closed|receiving end does not exist|back\/forward cache/i.test(error) });
        } else resolve(resp || { success: false, error: '网页未返回操作结果' });
      });
    } catch (error) {
      clearTimeout(timer);
      resolve({ success: false, error: error.message });
    }
  });
}
function waitTabComplete(tabId) {
  return new Promise((resolve) => {
    function finish(loaded) {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(lis);
      resolve(loaded);
    }
    function lis(id, info) { if (id === tabId && info.status === 'complete') finish(true); }
    const timeout = setTimeout(() => finish(false), 15000);
    chrome.tabs.onUpdated.addListener(lis);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) finish(false);
      else if (tab?.status === 'complete') finish(true);
    });
  });
}
function resolveCity(cfg) {
  const name = (cfg.city || '').trim().replace(/市$/, '') || '全国';
  return { name, code: Object.hasOwn(cities, name) ? cities[name] : '' };
}
function buildSearchUrl(keyword, cityCode, mode) {
  const terms = JobFilters.list(keyword);
  if (terms.length !== 1 || terms[0] !== keyword) throw new Error('搜索地址只能包含一个关键词，请重新收集');
  const params = new URLSearchParams({ query: keyword, city: cityCode });
  const jobType = JobFilters.searchJobType(mode);
  if (jobType) params.set('jobType', jobType);
  return 'https://www.zhipin.com/web/geek/jobs?' + params.toString();
}
async function ensureTab(url, tab, settleMin = 1200, settleMax = 2200) {
  if (!tab) tab = await chrome.tabs.create({ url });
  else await chrome.tabs.update(tab.id, { url });
  if (!(await waitTabComplete(tab.id))) throw new Error('打开页面超时');
  await humanPause(settleMin, settleMax);
  return tab;
}
async function curUrl(tabId) { return (await chrome.tabs.get(tabId)).url || ''; }

async function isVerificationTab(tabId) {
  try {
    const url = new URL(await curUrl(tabId));
    return /(?:^|\.)zhipin\.com$/i.test(url.hostname) &&
      /(?:^|\/)(?:security|verify|captcha|safe)(?:[-_/]|\.html|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function stopAtVerification(tabId, reason) {
  if (tabId != null) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  log(reason || 'BOSS 页面要求人工验证。已停止本批操作，请在打开的页面手动处理。', 'warn');
}

async function recoverSearchPage(tabId, query, cityCode, mode) {
  if (!(await waitTabComplete(tabId))) throw new Error('页面连接中断，等待加载超时');
  if (await isVerificationTab(tabId)) throw verificationError(tabId);
  const url = new URL(await curUrl(tabId));
  if (url.origin !== 'https://www.zhipin.com' || url.pathname.replace(/\/$/, '') !== '/web/geek/jobs' ||
    url.searchParams.get('query') !== query || url.searchParams.get('city') !== cityCode ||
    (url.searchParams.get('jobType') || '') !== JobFilters.searchJobType(mode)) {
    throw new Error('页面连接中断后，无法确认当前搜索条件');
  }
  await ensurePageScript(tabId, 'search');
}

function verificationError(tabId, message = 'BOSS 页面要求人工验证，已停止本批操作') {
  return Object.assign(new Error(message), { verificationTabId: tabId });
}

