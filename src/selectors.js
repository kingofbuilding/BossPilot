// BOSS 直聘选择器（借鉴即投实测验证版）
(function (root) {
const selectors = {
  jobs: {
    jobCard: 'li.job-card-box',
    jobSalary: '.job-salary',
    tagList: '.tag-list li',
    company: '.company-name, .company-info > a, .company-info h3 a, .company-info .name, .company-full-name, [data-company-name]',
    companyLink: 'a.boss-info[href*="/gongsi/"], .job-card-footer a[href*="/gongsi/"]',
    location: '.job-area, .job-area-wrapper, .job-location, .job-address, .job-location-name, .company-location, [data-job-location], [data-job-address]',
    distance: '.job-distance, .distance, .distance-text, .job-distance-text, [data-distance-text]',
    detail: '.job-detail-box, .job-detail, .job-detail-section, .job-detail-container, .job-detail-wrap, .job-detail-panel, .job-detail-wrapper',
    detailTitle: '.job-detail-header .name, .job-detail-title .name, .job-banner .name, .job-title',
    contact: 'button, a, [role="button"], .op-btn-chat, .start-chat-btn, .btn-startchat, .btn-chat, .btn-start-chat, .btn-continue-chat',
    dialog: '[role="dialog"], [aria-modal="true"], .boss-popup__wrapper, .boss-popup, .greet-boss-dialog, .greet-boss-container, .dialog-wrap, .dialog-container, .dialog-layer, .el-dialog, .chat-block-dialog, [class*="greet-boss"], [class*="boss-popup"], [class*="dialog-wrap"]'
  },
  chat: {
    userList: '.user-list-content li',
    userName: '.geek-name, .name-text, [class*="name"]',
    userCompany: '.title-box .name-box, [class*="company"]',
    chatInput: 'div#chat-input.chat-input',
    btnSend: 'button.btn-send',
    imageUpload: '.btn-sendimg input[type=file]',
    messageSent: '.item-myself'
  }
};

const cities = {
  '全国':'100010000','北京':'101010100','上海':'101020100','广州':'101280100','深圳':'101280600',
  '杭州':'101210100','成都':'101270100','武汉':'101200100','西安':'101110100','南京':'101190100',
  '苏州':'101190400','天津':'101030100','重庆':'101040100','长沙':'101250100','郑州':'101180100',
  '沈阳':'101070100','青岛':'101120200','合肥':'101220100','厦门':'101230200','福州':'101230100',
  '济南':'101120100','宁波':'101210400','东莞':'101281600','无锡':'101190200','昆明':'101290100',
  '哈尔滨':'101050100','长春':'101060100','大连':'101070200','石家庄':'101090100'
};

function verificationStatus() {
  const markers = document.querySelectorAll('[role="dialog"], .dialog-wrap, .dialog-container, .dialog-layer, .el-dialog, .captcha-container, .verify-container, .geetest_panel');
  const requiresVerification = /请完成(?:安全|人机|滑块)?验证|请进行(?:安全|人机)验证|拖动滑块|访问过于频繁|操作过于频繁|检测到异常访问|安全验证|人机验证/;
  const guardedUrl = /(?:^|\/)(?:security|verify|captcha|safe)(?:[-_/]|\.html|$)/i.test(location.pathname);
  const guardedPage = [...markers].some(marker => marker.getClientRects().length && requiresVerification.test(marker.innerText || '')) ||
    (document.querySelectorAll(selectors.jobs.jobCard).length === 0 && requiresVerification.test((document.body?.innerText || '').slice(0, 500)));
  return guardedUrl || guardedPage ? {
    blocked: true, success: false, error: 'BOSS 页面要求人工验证或限制了操作，已停止本批。请在页面上手动处理。'
  } : null;
}

function assertDeliveryTime(expiresAt) {
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    throw Object.assign(new Error('网页操作已超时'), { timedOut: true });
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

async function humanHoverAndPress(el) {
  try {
    const rect = el.getBoundingClientRect?.();
    if (rect && rect.width > 2 && rect.height > 2) {
      const clientX = Math.round(rect.left + rect.width * (0.28 + Math.random() * 0.44));
      const clientY = Math.round(rect.top + rect.height * (0.28 + Math.random() * 0.44));
      const base = { bubbles: true, cancelable: true, view: window, clientX, clientY };
      el.dispatchEvent(new PointerEvent('pointerover', base));
      el.dispatchEvent(new MouseEvent('mouseover', base));
      await sleep(jitter(60, 130));
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
      await sleep(jitter(45, 90));
      el.dispatchEvent(new PointerEvent('pointerup', base));
      el.dispatchEvent(new MouseEvent('mouseup', base));
    }
  } catch (_) {}
}

root.JobCopilotPage = Object.freeze({ selectors, cities, verificationStatus, assertDeliveryTime, sleep, jitter, humanHoverAndPress, protocol: 208 });
})(globalThis);
