// ===== 聊天页 content script：打开会话 + 先发图片 + 再发招呼语 =====
(function () {
  const { selectors: SELECTORS, protocol, verificationStatus, assertDeliveryTime, sleep, jitter, humanHoverAndPress } = globalThis.JobCopilotPage;
  if (window.__bossToudiChat === protocol) return;
  window.__bossToudiChat = protocol;

  // 多选择器找第一个可见元素
  function findVisible(selList) {
    for (const sel of selList) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (el && (el.offsetParent !== null || getComputedStyle(el).position === 'fixed')) return el;
      }
    }
    return null;
  }
  async function waitVisible(selList, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const el = findVisible(selList);
      if (el) return el;
      await sleep(250);
    }
    return null;
  }

  const INPUT_SELS = ['#chat-input', '.chat-input[contenteditable]', '.chat-editor textarea'];
  const SEND_SELS = ['button.btn-send', '.chat-editor .btn-send'];
  const IMG_SELS = '.btn-sendimg input[type=file], .chat-editor .toolbar input[type=file]';
  const CONVERSATION_HEAD = '.chat-conversation .user-info, .chat-conversation .chat-header, .chat-conversation .job-card, .chat-conversation .relation-job, .chat-box .title-box, .chat-box .job-card, .chat-box .chat-header';
  const CHAT_JOB_TITLE = '.job-name, .position-name, .job-title, [data-job-name]';

  // 诊断：把页面里可编辑元素结构dump成字符串（找不到输入框时回传，便于定位）
  function dumpInputs() {
    const out = [];
    document.querySelectorAll('[contenteditable="true"], textarea, div[id*="input"], div[class*="input"]').forEach((el, i) => {
      if (i < 8) out.push(el.tagName + '#' + (el.id || '') + '.' + (typeof el.className === 'string' ? el.className.slice(0, 40) : ''));
    });
    return out.join(' | ') || '无可编辑元素';
  }

  function dataURLtoFile(dataUrl, name) {
    const parts = dataUrl.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const bin = atob(parts[1]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name || 'resume.png', { type: mime });
  }

  function activeTarget(job) {
    for (const header of document.querySelectorAll(CONVERSATION_HEAD)) {
      if (header.offsetParent === null) continue;
      const position = header.querySelector(CHAT_JOB_TITLE);
      const name = position?.getAttribute('data-job-name') || position?.textContent;
      const companies = [...header.querySelectorAll(SELECTORS.jobs.company)]
        .map(el => (el.getAttribute('data-company-name') || el.textContent).trim()).filter(Boolean);
      const listings = [...header.querySelectorAll('a[href*="/job_detail/"]')];
      if (listings.some(listing => new URL(listing.href).pathname !== '/job_detail/' + job.id + '.html')) continue;
      if (!JobFilters.sameEmployerAndTitle(job, { name, companyAliases: companies }) &&
        !(listings.length && !companies.length && (!name || JobFilters.identity(name) === JobFilters.identity(job.name)))) continue;
      return { ...job, companyAliases: [...(job.companyAliases || []), ...companies] };
    }
    return null;
  }

  async function verifyTarget(job, expiresAt) {
    const blocked = verificationStatus();
    if (blocked) throw new Error(blocked.error);
    const observed = activeTarget(job);
    if (!observed) throw new Error('当前聊天无法核实岗位与公司，已阻止发送');
    const approval = await chrome.runtime.sendMessage({ type: 'CHECK_DELIVERY', job: observed, expiresAt });
    if (!approval?.ok) throw Object.assign(new Error(approval?.error || '发送前复核未通过'), { timedOut: !!approval?.timedOut });
    const restriction = verificationStatus();
    if (restriction) throw new Error(restriction.error);
    if (!activeTarget(job)) throw new Error('当前聊天已切换，已阻止发送');
    assertDeliveryTime(expiresAt);
  }

  async function sendImage(image, job, expiresAt) {
    if (!image) return true;
    const input = document.querySelector(IMG_SELS);
    if (!input) return false;
    const file = dataURLtoFile(image, 'resume.png');
    const dt = new DataTransfer();
    dt.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files').set;
    await verifyTarget(job, expiresAt);
    if (!input.isConnected) return false;
    setter.call(input, dt.files);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(2500);
    return true;
  }

  function inputText(el) { return (el.isContentEditable || el.getAttribute('contenteditable') === 'true') ? (el.textContent || '') : (el.value || ''); }

  function pressEnter(el) {
    const opt = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opt));
    el.dispatchEvent(new KeyboardEvent('keypress', opt));
    el.dispatchEvent(new KeyboardEvent('keyup', opt));
  }

  async function sendText(greeting, job, expiresAt) {
    const input = await waitVisible(INPUT_SELS, 8000);
    if (!input) return { ok: false, err: '未找到输入框｜页面候选：' + dumpInputs() };
    await verifyTarget(job, expiresAt);
    if (!input.isConnected || input !== findVisible(INPUT_SELS)) return { ok: false, err: '输入框已变化' };
    const editable = input.isContentEditable || input.getAttribute('contenteditable') === 'true';
    try { input.focus(); } catch (_) {}
    await sleep(jitter(280, 650));

    const chunks = [];
    for (let pos = 0; pos < greeting.length; ) {
      const step = Math.max(2, Math.min(6, Math.ceil(greeting.length / 18) + Math.floor(Math.random() * 3)));
      chunks.push(greeting.slice(pos, pos + step));
      pos += step;
    }
    let typed = '';
    const setter = !editable ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set : null;
    for (const chunk of chunks) {
      assertDeliveryTime(expiresAt);
      if (!input.isConnected) return { ok: false, err: '输入框已变化' };
      typed += chunk;
      if (editable) {
        input.textContent = typed;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: chunk }));
      } else if (setter) {
        setter.call(input, typed);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        input.value = typed;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await sleep(jitter(40, 85));
    }
    await sleep(jitter(550, 1100));
    if (!inputText(input).trim()) return { ok: false, err: '文字未填入输入框' };

    const before = document.querySelectorAll(SELECTORS.chat.messageSent).length;
    await verifyTarget(job, expiresAt);
    if (!input.isConnected || input !== findVisible(INPUT_SELS) || inputText(input).trim() !== greeting.trim()) {
      return { ok: false, err: '招呼语或输入框已变化' };
    }
    const btn = findVisible(SEND_SELS);
    if (btn && !btn.classList.contains('disabled') && !btn.disabled) {
      await humanHoverAndPress(btn);
      btn.click();
    } else pressEnter(input);

    // 验证：输入框被清空 或 新增自己消息气泡 => 成功
    for (let i = 0; i < 12; i++) {
      await sleep(300);
      const cleared = !inputText(input).trim();
      const after = document.querySelectorAll(SELECTORS.chat.messageSent).length;
      if (cleared || after > before) return { ok: true };
    }
    return { ok: false, err: '发送未确认（输入框未清空、未见新气泡）' };
  }

  async function sendActive(image, greeting, job, expiresAt) {
    if (!job?.id || !greeting?.trim()) return { success: false, error: '缺少审核岗位或招呼语' };
    const input = await waitVisible(INPUT_SELS, 6000);
    if (!input) return { success: false, error: '未找到输入框｜' + dumpInputs() };
    for (let attempt = 0; attempt < 16 && !activeTarget(job); attempt++) {
      const restriction = verificationStatus();
      if (restriction) return restriction;
      await sleep(250);
    }
    await verifyTarget(job, expiresAt);
    const imgOk = await sendImage(image, job, expiresAt);
    if (!imgOk) return { success: false, error: '简历图片发送失败，已停止发送' };
    const tr = await sendText(greeting, job, expiresAt);
    if (!tr.ok) return { success: false, error: tr.err };
    return { success: true, imageOk: imgOk };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CHECK_VERIFICATION') {
      sendResponse(verificationStatus() || { success: true });
      return;
    }
    if (msg.type === 'JOBCOPILOT_PAGE_READY' && msg.page === 'chat') {
      sendResponse({ protocol });
      return;
    }
    if (msg.type === 'SEND_ACTIVE') {
      const restriction = verificationStatus();
      if (restriction) { sendResponse(restriction); return; }
      sendActive(msg.image, msg.greeting, msg.job, msg.expiresAt).then(result => sendResponse(verificationStatus() || result))
        .catch(error => sendResponse(verificationStatus() || { success: false, error: error.message, timedOut: !!error.timedOut }));
      return true;
    }
  });
})();
