// 岗位复核、网页沟通与聊天发送。
let activeDelivery = null;

async function runDeliver(jobIds) {
  const stored = await chrome.storage.local.get('processed');
  state.processed = { ...stored.processed, ...state.processed };
  const cfg = await getCfg();
  const sendImage = settings.sendsImage(cfg);
  const imageToSend = sendImage ? (cfg.resumeImage || '') : '';
  const fixedMode = cfg.greetingMode === 'fixed';
  const fixedGreeting = (cfg.fixedGreeting || '').trim();
  if (sendImage && !imageToSend) throw new Error('已勾选发送简历图片，请先上传图片或取消勾选');
  const invalid = settings.greetingError(cfg);
  if (invalid) throw new Error(invalid[1]);
  const pace = paceProfile(cfg);
  log('节奏模式：' + pace.label + '。弹窗出现「留在此页」时优先留在搜索页；进入网页聊天时按已设置的方式发送。');

  const mode = JobFilters.screeningMode(cfg);
  const reviewed = new Map(state.screened.filter(job => job.match && job.searchMode === mode)
    .map(job => [job.id, job]));
  const ids = [...new Set(Array.isArray(jobIds) ? jobIds : [])].filter(id => reviewed.has(id) && !state.processed[id]);
  const summary = { ok: 0, fail: 0, stayed: 0, unconfirmed: 0 };
  if (!ids.length) {
    log('没有本版本审核通过且未投过的岗位，请重新收集并审核', 'warn');
    return summary;
  }
  let searchTab;
  progress(0, ids.length, '已处理');
  for (let k = 0; k < ids.length; k++) {
    await waitIfPaused();
    if (state.aborted) break;
    const job = reviewed.get(ids[k]);
    let deliveryTab;
    log('[' + (k + 1) + '/' + ids.length + '] ' + job.name + ' - ' + (job.company || ''));
    try {
      const latest = await getCfg();
      assertDeliverable(latest, job);

      log('  读取岗位JD...');
      const { tab, liveJob, jd } = await openReviewedJob(job, { preferredTab: searchTab });
      searchTab = tab;
      deliveryTab = tab;
      assertDeliverable(latest, liveJob, job.searchCity, job.searchMode);

      await humanPause(pace.jdMin, pace.jdMax);
      if (state.aborted) break;
      const beforeContact = await getCfg();
      assertDeliverable(beforeContact, liveJob, job.searchCity, job.searchMode);
      log('  核对目标岗位的网页沟通入口（扩展 ' + chrome.runtime.getManifest().version + '）...');
      const existingTabs = new Set((await chrome.tabs.query({})).map(candidate => candidate.id));
      const preferContinue = settings.dialogAction(beforeContact) === 'continue' || settings.sendsImage(beforeContact);
      activeDelivery = { tabId: tab.id, id: job.id, cityCode: job.searchCity, mode: job.searchMode };
      const contact = await sendDeliveryAction({ type: 'GO_CHAT', job, constraints: settings.constraints(beforeContact), preferContinue });
      if (contact.blocked || contact.timedOut && await isVerificationTab(tab.id)) {
        summary.fail++;
        await stopAtVerification(tab.id, contact.blocked ? contact.error : undefined);
        break;
      }
      if (!activeDelivery.checked || (!contact.success && !contact.disconnected)) {
        const error = contact.timedOut ? '等待沟通按钮或弹窗响应超时' : (contact.error || '建联未通过复核');
        if (contact.timedOut && activeDelivery.checked) {
          await markProcessed(job, 'unconfirmed');
          summary.unconfirmed++;
          log('  ' + error + '，请在 BOSS 确认该岗位的沟通结果', 'warn');
          continue;
        }
        throw new Error(error);
      }
      const verifiedJob = activeDelivery.verifiedJob || liveJob;
      if (contact.stayed) {
        await markProcessed(job, 'stayed');
        summary.stayed++;
        log('  已选「留在此页」，未发送额外招呼语或简历图片', 'success');
      } else {
        const chatTab = await findDeliveryChat(tab.id, existingTabs, contact);
        deliveryTab = chatTab;
        await humanPause(pace.chatMin, pace.chatMax);
        if (state.aborted) break;
        assertDeliverable(await getCfg(), verifiedJob, job.searchCity, job.searchMode);
        log('  已打开网页聊天，正在核对岗位与公司...');
        const greeting = fixedMode ? fixedGreeting : (await GreetingDraft.draft(cfg, verifiedJob, jd)).text;
        if (!greeting) throw new Error('招呼语为空');
        await waitIfPaused();
        if (state.aborted) break;
        log(imageToSend ? '  发简历图片 + 招呼语...' : '  发送招呼语...');
        activeDelivery.tabId = chatTab.id;
        const response = await sendDeliveryAction({ type: 'SEND_ACTIVE', job: verifiedJob, image: imageToSend, greeting });
        if (response.blocked || response.timedOut && await isVerificationTab(chatTab.id)) {
          summary.fail++;
          await stopAtVerification(chatTab.id, response.blocked ? response.error : undefined);
          break;
        }
        if (!response.success) {
          if ((response.timedOut || response.disconnected) && activeDelivery.checked) {
            await markProcessed(job, 'unconfirmed');
            summary.unconfirmed++;
            log('  招呼语或简历的发送结果待确认，请核对 BOSS 会话', 'warn');
            continue;
          }
          throw new Error(response.timedOut ? '等待聊天页发送回执超时' : (response.error || '发送失败'));
        }
        await markProcessed(job, 'sent');
        summary.ok++;
        log('  ✓ 投递成功', 'success');
        if (chatTab.id !== tab.id) await chrome.tabs.remove(chatTab.id).catch(() => {});
      }
    } catch (error) {
      summary.fail++;
      const blockedTab = error.verificationTabId ?? (deliveryTab && await isVerificationTab(deliveryTab.id) ? deliveryTab.id : null);
      if (blockedTab != null) {
        await stopAtVerification(blockedTab, error.verificationTabId ? error.message : undefined);
        break;
      }
      log('  已跳过：' + error.message, 'warn');
    } finally {
      activeDelivery = null;
      progress(k + 1, ids.length, '已处理');
      if (k + 1 < ids.length && !state.aborted) {
        if ((k + 1) % pace.restEvery === 0) {
          const restSec = Math.round((pace.restMin + pace.restMax) / 2000);
          log('  已连续处理 ' + (k + 1) + ' 个岗位，自动休息约 ' + restSec + ' 秒以降低风控风险…');
          await humanPause(pace.restMin, pace.restMax);
        } else {
          const waitMs = randInt(pace.gapMin, pace.gapMax);
          log('  随机停顿 ' + Math.round(waitMs / 1000) + ' 秒后继续下一个岗位…');
          await humanPause(waitMs, waitMs);
        }
      }
    }
  }
  const { ok, fail, stayed, unconfirmed } = summary;
  log('处理完成：留在此页 ' + stayed + ' 个，发送成功 ' + ok + ' 个，失败 ' + fail + ' 个' +
    (unconfirmed ? '，待确认 ' + unconfirmed + ' 个' : ''), unconfirmed || fail ? 'warn' : 'success');
  return summary;
}

function reportContactStage(message, sender) {
  if (!activeDelivery || activeDelivery.tabId !== sender.tab?.id || activeDelivery.id !== message.jobId) return;
  if (message.stage === 'contact-clicked') log('  已触发岗位沟通按钮，等待网页响应');
  if (message.stage === 'continue-clicked') log('  已触发继续沟通，等待进入聊天页');
}
function sendDeliveryAction(message) {
  const expiresAt = Date.now() + pageActionTimeout;
  activeDelivery.expiresAt = expiresAt;
  activeDelivery.checked = false;
  return sendToTab(activeDelivery.tabId, { ...message, expiresAt }, pageActionTimeout);
}
async function findDeliveryChat(sourceId, existingTabs, contact = {}) {
  let fallbackOpened = false;
  for (let attempt = 0; attempt < 16; attempt++) {
    await waitIfPaused();
    if (state.aborted) throw new Error('投递已停止');
    const tabs = (await chrome.tabs.query({})).filter(tab => tab.id === sourceId ||
      (tab.openerTabId === sourceId && !existingTabs.has(tab.id)));
    if (!tabs.length) throw new Error('沟通页面已关闭');
    const chats = [];
    for (const tab of tabs) {
      if (await isVerificationTab(tab.id)) throw verificationError(tab.id);
      if (!tab.url?.startsWith('https://www.zhipin.com/')) continue;
      const status = await sendToTab(tab.id, { type: 'CHECK_VERIFICATION' });
      if (status.blocked) throw verificationError(tab.id, status.error);
      if (status.timedOut) throw new Error('等待聊天页响应超时');
      if (/^\/web\/geek\/chat\/?$/.test(new URL(tab.url).pathname)) chats.push(tab);
    }
    if (chats.length > 1) throw new Error('打开了多个聊天页，无法确定目标会话');
    const chat = chats[0];
    if (chat && chat.status === 'complete') {
      await ensurePageScript(chat.id, 'chat');
      return chat;
    }
    // 若浏览器弹窗拦截器阻止了页面脚本的 window.open，则由扩展安全打开聊天页（进入后仍由 content-chat 严格核验公司与岗位 ID）
    if (!chats.length && !fallbackOpened && attempt >= 3 && (contact.continueClicked || contact.chatUrl)) {
      fallbackOpened = true;
      const targetChatUrl = contact.chatUrl || 'https://www.zhipin.com/web/geek/chat';
      const created = await chrome.tabs.create({ url: targetChatUrl, openerTabId: sourceId, active: true });
      await waitTabComplete(created.id);
    }
    await sleep(700);
  }
  throw new Error('已尝试网页沟通，但没有检测到该岗位打开的聊天页');
}
function directDetailUrl(job) {
  if (typeof job?.link === 'string' && job.link) {
    try {
      const parsed = new URL(job.link);
      if (parsed.origin === 'https://www.zhipin.com' && parsed.pathname === '/job_detail/' + job.id + '.html') {
        return parsed.href;
      }
    } catch (_) {}
  }
  return typeof job?.id === 'string' && /^[\w-]+$/.test(job.id)
    ? 'https://www.zhipin.com/job_detail/' + job.id + '.html'
    : '';
}
async function openReviewedJob(job, { separateTab = false, preferredTab } = {}) {
  const detailUrl = directDetailUrl(job);
  if (!detailUrl) throw new Error('岗位缺少有效链接，请重新收集');
  let tab = preferredTab;
  let reuse = false;
  if (tab) {
    const url = await curUrl(tab.id).catch(() => '');
    if (!url) tab = undefined;
    else if (await isVerificationTab(tab.id)) throw verificationError(tab.id);
    else if (url.startsWith('https://www.zhipin.com/web/geek/job') || url.startsWith('https://www.zhipin.com/job_detail/' + job.id + '.html')) {
      const status = await sendToTab(tab.id, { type: 'HAS_REVIEWED_JOB', job });
      if (status.blocked) throw verificationError(tab.id, status.error);
      reuse = status.present === true;
    }
  }
  if (!reuse) tab = await ensureTab(detailUrl, separateTab ? null : tab, 700, 1400);
  if (await isVerificationTab(tab.id)) throw verificationError(tab.id);
  await ensurePageScript(tab.id, 'search');
  const status = await sendToTab(tab.id, { type: 'CHECK_VERIFICATION' });
  if (status.blocked) throw verificationError(tab.id, status.error);
  const details = await sendToTab(tab.id, { type: 'OPEN_JD', job });
  if (details.blocked || await isVerificationTab(tab.id)) throw verificationError(tab.id, details.error);
  const liveJob = details.job;
  if (!details.success || liveJob?.id !== job.id || !JobFilters.sameEmployerAndTitle(job, liveJob)) {
    throw new Error(details.error || '当前岗位或公司与审核记录不一致，请重新收集');
  }
  return { tab, liveJob, jd: details.jd };
}

async function inspectReviewedContact(id) {
  const job = (await reviewedJobs()).find(candidate => candidate.match && candidate.id === id);
  if (!job) throw new Error('请先收集并勾选一个筛选通过的岗位');
  const cfg = await getCfg();
  assertDeliverable(cfg, job);
  log('开始检查网页沟通入口：' + job.name);
  const { tab, liveJob } = await openReviewedJob(job, { separateTab: true });
  const result = await sendToTab(tab.id, { type: 'INSPECT_CONTACT', job: liveJob, constraints: settings.constraints(cfg) });
  if (!result.success) throw new Error(result.error || '未能检查沟通入口');
  log(result.status + '，未点击沟通', 'success');
}

async function checkBeforeAction(job, sender, expiresAt) {
  await waitIfPaused();
  const delivery = activeDelivery;
  if (state.aborted || !delivery || delivery.tabId !== sender.tab?.id || delivery.id !== job?.id || delivery.expiresAt !== expiresAt) {
    throw new Error('当前投递已停止或目标未获审核');
  }
  const latest = await getCfg();
  if (state.aborted || activeDelivery !== delivery) throw new Error('当前投递已停止');
  if (delivery.expiresAt !== expiresAt) throw new Error('当前投递已停止');
  assertDeliveryTime(expiresAt);
  assertDeliverable(latest, job, delivery.cityCode, delivery.mode);
  delivery.verifiedJob = job;
  delivery.checked = true;
}
function assertDeliverable(cfg, job, cityCode = job.searchCity, mode = job.searchMode) {
  if (!cityCode || resolveCity(cfg).code !== cityCode) throw new Error('当前城市与审核时不同，请重新收集');
  if (JobFilters.screeningMode(cfg) !== mode) throw new Error('筛选模式已变化，请重新收集并审核');
  const rejection = JobFilters.deliveryRejection(cfg, job);
  if (rejection) throw new Error(rejection);
}
async function markProcessed(job, outcome) {
  state.processed[job.id] = outcome;
  await chrome.storage.local.set({ processed: state.processed });
}

