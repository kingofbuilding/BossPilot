// ── 流程：收集 + 筛选 ──
async function runCollect() {
  const cfg = await getCfg();
  const mode = JobFilters.screeningMode(cfg);
  const invalid = JobFilters.validate(cfg);
  if (invalid) throw new Error(invalid[1]);

  const city = resolveCity(cfg);
  if (!city.code) throw new Error('未识别城市「' + city.name + '」，请修改城市后重试。');
  const count = settings.searchCount(cfg);
  if (count === null) {
    throw new Error('总目标数量须为 1–' + JobFilters.maxSearchCount + '。');
  }
  const keywords = JobFilters.list(cfg.keyword);
  const constraints = settings.constraints(cfg);
  const pace = paceProfile(cfg);
  const accepted = new Map();
  const rejected = new Map();
  let verificationStopped = false;
  let sharedTab = null;
  let currentTabOwner = null;
  const fairShare = Math.max(1, Math.ceil(count / keywords.length));
  const searches = keywords.map(keyword => {
    const queries = JobFilters.searchQueries(keyword, constraints);
    return { keyword, queries, query: queries.shift(), visited: new Set(), checkedKeys: new Set(),
      urls: new Set(), fingerprints: new Set(), resumeUrl: '', pages: 0, queryPages: 0, retries: 0, irrelevantBatches: 0,
      needsRead: true, retained: 0, quota: fairShare, done: false };
  });
  const finishQuery = (search, reason) => {
    const query = search.queries.shift();
    log('「' + search.query + '」' + reason + (query ? '，接着搜索「' + query + '」' : ''), query ? 'info' : 'warn');
    if (!query) {
      search.done = true;
      return;
    }
    search.query = query;
    search.resumeUrl = '';
    search.needsRead = true;
    search.queryPages = 0;
    search.retries = 0;
    search.irrelevantBatches = 0;
    search.visited.clear();
    search.urls.clear();
    search.fingerprints.clear();
  };
  const scheduleRetry = (search, reason) => {
    search.retries++;
    if (search.retries >= 3) finishQuery(search, '暂无法继续：' + reason);
    else log('「' + search.query + '」等待后重试：' + reason);
  };
  log(city.name + ' · ' + keywords.length + ' 个关键词 · 总目标 ' + count + ' 个合格岗位（' + pace.label + '，单标签顺序浏览）');
  if (mode === 'internship') log('搜索链接已加入 BOSS 的「实习」条件，收录时仍核对标题和岗位方向。');
  progress(0, count, '合格岗位');
  try {
    while (!verificationStopped && accepted.size < count && searches.some(search => !search.done)) {
      for (let idx = 0; idx < searches.length; idx++) {
        const search = searches[idx];
        if (search.done || accepted.size >= count) continue;
        // 动态顺延配额：如果前面的关键词没凑够，把剩余缺口直接均摊给后面还没跑的关键词，避免来回切页
        const remainingInPass = searches.slice(idx).filter(s => !s.done).length;
        const dynamicTarget = search.retained + Math.max(1, Math.ceil((count - accepted.size) / Math.max(1, remainingInPass)));
        if (dynamicTarget > search.quota) search.quota = dynamicTarget;
        if (currentTabOwner && currentTabOwner !== search) {
          search.queryPages = 0;
          search.retries = 0;
          search.needsRead = true;
          search.urls.clear();
          search.fingerprints.clear();
          await humanPause(pace.kwMin, pace.kwMax);
        }
        while (!verificationStopped && !search.done && accepted.size < count && search.retained < search.quota) {
          await waitIfPaused();
          if (state.aborted) return;
          const { keyword, query } = search;
          try {
            if (!search.queryPages && !search.retries) {
              const url = search.resumeUrl || buildSearchUrl(query, city.code, mode);
              log((search.resumeUrl ? '继续浏览 BOSS 搜索「' : '打开 BOSS 搜索「') + query + '」');
              if (!sharedTab) sharedTab = await chrome.tabs.create({ url, active: true });
              else await chrome.tabs.update(sharedTab.id, { url, active: true });
              currentTabOwner = search;
              if (!(await waitTabComplete(sharedTab.id))) throw new Error('打开搜索页超时');
              await humanPause(2000, 3600);
              await ensurePageScript(sharedTab.id, 'search');
            } else if (!search.needsRead) {
              await humanPause(pace.pageMin, pace.pageMax);
              if (state.aborted) return;
              let next = await sendToTab(sharedTab.id, { type: 'NEXT_RESULTS', keyword: query, visited: [...search.visited], retry: search.retries });
              if (state.aborted) return;
              if (next.blocked) {
                await stopAtVerification(sharedTab.id, next.error);
                sharedTab = null;
                verificationStopped = true;
                break;
              }
              if (next.scrolling) continue;
              if (next.disconnected) {
                await recoverSearchPage(sharedTab.id, query, city.code, mode);
                log('「' + query + '」已重新连接，先读取当前页');
                next = { advanced: true };
              }
              if (next.url && search.urls.has(next.url)) {
                finishQuery(search, '下一页链接回到了已浏览页面');
                continue;
              }
              if (next.exhausted && search.retries >= 1) {
                finishQuery(search, next.reason);
                continue;
              }
              if (!next.advanced) {
                scheduleRetry(search, next.reason || next.error || '分页未响应');
                continue;
              }
              if (next.url) {
                await ensureTab(next.url, sharedTab);
                await ensurePageScript(sharedTab.id, 'search');
              }
            }
            search.needsRead = true;
            let response = await sendToTab(sharedTab.id, { type: 'READ_RESULTS' });
            if (response.disconnected) {
              await recoverSearchPage(sharedTab.id, query, city.code, mode);
              response = await sendToTab(sharedTab.id, { type: 'READ_RESULTS' });
            }
            for (let attempt = 0; response.success && (!response.keys.length || response.loading) && attempt < 12 && !state.aborted && !response.blocked; attempt++) {
              await sleep(850);
              response = await sendToTab(sharedTab.id, { type: 'READ_RESULTS' });
            }
            if (response.blocked) {
              await stopAtVerification(sharedTab.id, response.error);
              sharedTab = null;
              verificationStopped = true;
              break;
            }
            if (!response.success) throw new Error(response.error);
            if (state.aborted) return;
            const resultUrl = await curUrl(sharedTab.id);
            if (mode === 'internship') {
              const actualQuery = new URL(resultUrl).searchParams.get('query');
              if (actualQuery !== query) throw new Error('BOSS 页面实际搜索词为「' +
                (actualQuery || '空') + '」，与「' + query + '」不一致');
            }
            if (!response.keys.length || response.loading) {
              scheduleRetry(search, response.loading ? '职位列表仍在加载' : '当前页面尚未读到岗位');
              continue;
            }
            search.needsRead = false;
            const fresh = response.keys.filter(key => !search.visited.has(key));
            const freshIds = new Set(fresh.map(key => /^\/job_detail\/([\w-]+)\.html$/.exec(key)?.[1]).filter(Boolean));
            const fingerprint = JSON.stringify([resultUrl, response.pageNumber ?? null, response.keys.slice().sort()]);
            if (!fresh.length && search.fingerprints.has(fingerprint)) {
              scheduleRetry(search, '页面尚未变化');
              continue;
            }
            for (const key of fresh) search.visited.add(key);
            search.fingerprints.add(fingerprint);
            search.urls.add(resultUrl);
            search.resumeUrl = resultUrl;
            search.retries = 0;
            search.pages++;
            search.queryPages++;
            for (const key of fresh) search.checkedKeys.add(key);
            const previousCount = accepted.size;
            const exclusions = new Map();
            let duplicates = 0;
            let differentTitle = 0;
            let notInternship = 0;
            let relevant = 0;
            const rejectedTitles = [];
            for (const job of response.jobs) {
              if (!freshIds.has(job.id)) continue;
              const wrongType = mode === 'internship' && !JobFilters.isInternship(job);
              const matchedKeywords = wrongType ? [] : keywords.filter(term => JobFilters.matchesSearchTitle(job.name, term, constraints, job.tags));
              if (wrongType || !matchedKeywords.length) {
                if (wrongType) notInternship++;
                else differentTitle++;
                if (job.name && rejectedTitles.length < 2 && !rejectedTitles.includes(job.name)) rejectedTitles.push(job.name);
                continue;
              }
              relevant++;
              const previous = accepted.get(job.id);
              if (previous) {
                for (const mk of matchedKeywords) {
                  if (!previous.searchKeywords.includes(mk)) previous.searchKeywords.push(mk);
                }
                duplicates++;
                continue;
              }
              const reason = JobFilters.check(constraints, job);
              const entry = { ...job, searchKeywords: matchedKeywords, searchCity: city.code, searchMode: mode,
                searchQuery: query, resultUrl, resultPage: search.queryPages, filterVersion: settings.filterVersion, match: !reason, reason };
              if (reason) {
                exclusions.set(reason, (exclusions.get(reason) || 0) + 1);
                if (rejected.size < 200 || rejected.has(job.id)) rejected.set(job.id, entry);
              } else {
                rejected.delete(job.id);
                accepted.set(job.id, entry);
                search.retained++;
                if (accepted.size >= count) break;
              }
            }
            log('「' + query + '」第 ' + search.queryPages + ' 批，检查 ' + fresh.length + ' 个页面岗位，新增合格 ' +
              (accepted.size - previousCount) + ' 个，累计 ' + accepted.size + '/' + count);
            const excluded = [...exclusions].sort((left, right) => right[1] - left[1])
              .slice(0, 2).map(([reason, amount]) => amount + ' 个' + reason);
            if (differentTitle) excluded.unshift(differentTitle + ' 个岗位方向不符');
            if (notInternship) excluded.unshift(notInternship + ' 个不符合实习要求');
            if (duplicates) excluded.unshift(duplicates + ' 个已被其他关键词收录');
            if (excluded.length) log('  本批排除：' + excluded.join('、'));
            if (rejectedTitles.length) log('  标题未匹配示例：' + rejectedTitles.join('、'));
            progress(accepted.size, count, '合格岗位');
            if (fresh.length) search.irrelevantBatches = relevant === 0 && notInternship + differentTitle >= 5
              ? search.irrelevantBatches + 1 : 0;
            if (accepted.size < count && search.queries.length && search.irrelevantBatches >= 3) {
              finishQuery(search, '连续 3 批没有符合岗位类型和方向的结果');
            }
          } catch (error) {
            if (error.verificationTabId != null || sharedTab && await isVerificationTab(sharedTab.id)) {
              await stopAtVerification(error.verificationTabId ?? sharedTab.id, error.verificationTabId ? error.message : undefined);
              sharedTab = null;
              verificationStopped = true;
              break;
            }
            finishQuery(search, '搜索中断：' + error.message);
          }
        }
      }
      if (!verificationStopped && accepted.size < count) {
        const remaining = searches.filter(s => !s.done);
        if (remaining.length) {
          const boost = Math.max(1, Math.ceil((count - accepted.size) / remaining.length));
          remaining.forEach(s => { s.quota = s.retained + boost; });
        }
      }
    }
  } finally {
    if (sharedTab) await chrome.tabs.remove(sharedTab.id).catch(() => {});
  }
  if (state.aborted) return;
  for (const search of searches) {
    log('「' + search.keyword + '」共读 ' + search.pages + ' 批、' + search.checkedKeys.size + ' 个不同岗位，贡献 ' +
      search.retained + ' 个合格岗位。');
  }
  const screened = [...accepted.values(), ...rejected.values()];
  await chrome.storage.local.set({ sw_screened: screened });
  state.screened = screened;
  log((verificationStopped ? '验证中止，已保留：' : '筛选完成：') + accepted.size + '/' + count + ' 个合格岗位，保留 ' + rejected.size + ' 个排除示例。',
    accepted.size >= count ? 'success' : 'warn');
  return true;
}

