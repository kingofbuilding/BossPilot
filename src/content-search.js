// ===== 搜索页 content script：收集岗位 + 建立联系（立即沟通→继续沟通跳聊天页）=====
(function () {
  const { selectors: SELECTORS, protocol, verificationStatus, assertDeliveryTime, sleep, jitter, humanHoverAndPress } = globalThis.JobCopilotPage;
  if (window.__bossToudiSearch === protocol) return;
  window.__bossToudiSearch = protocol;
  const immediateLabels = ['立即沟通', '立即联系', '马上沟通'];
  const continuationLabels = ['继续沟通', '前往聊天', '去沟通'];
  const stayLabels = ['留在此页', '留在当前页', '留在本页'];
  const appOnlyPattern = /去App|在App|打开App|下载App|扫码沟通|与BOSS随时随地沟通/i;
  const contactLabels = immediateLabels.concat(continuationLabels);

  function getCards() { return Array.from(document.querySelectorAll(SELECTORS.jobs.jobCard)); }

  function attachedShadowRoot(el) {
    try {
      if (chrome.dom && typeof chrome.dom.openOrClosedShadowRoot === 'function') return chrome.dom.openOrClosedShadowRoot(el) || el.shadowRoot || null;
    } catch (e) {}
    return el.shadowRoot || null;
  }

  // 普通 textContent 不包含组件内部的 Shadow DOM；只读合并实际展示的文本。
  function composedText(node, depth, omit) {
    if (!node || (depth || 0) > 12) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (omit && node.matches?.(omit)) return '';
    if (/^(STYLE|SCRIPT|NOSCRIPT|TEMPLATE)$/.test(node.tagName || '')) return '';
    const shadow = node.nodeType === 1 || node.tagName ? attachedShadowRoot(node) : null;
    let children;
    if (shadow) children = shadow.childNodes;
    else if (node.tagName === 'SLOT' && typeof node.assignedNodes === 'function') children = node.assignedNodes({ flatten: true });
    else children = node.childNodes;
    if (!children || !children.length) return node.innerText || node.textContent || '';
    return Array.from(children).map(child => composedText(child, (depth || 0) + 1, omit)).join('');
  }

  const salarySelector = '.job-salary, .salary, .salary-text, [data-salary]';

  function readTitle(scope) {
    for (const selector of ['a.job-name, .job-name, [data-job-name]', 'h1, h2', SELECTORS.jobs.detailTitle]) {
      const element = scope.querySelector(selector);
      if (!element) continue;
      const name = (element.getAttribute('data-job-name') || composedText(element, 0, salarySelector)).trim();
      if (name) return name;
    }
    return '';
  }

  // kanzhun-mix 将 U+E031..U+E03A 显示为 0..9；仅转换该字体下的薪资文本。
  function normalizedSalaryText(el) {
    const raw = composedText(el).trim() || el.getAttribute('data-salary') || '';
    let text = raw;
    if (/[\ue031-\ue03a]/.test(raw)) {
      let fontFamily = '';
      try { fontFamily = getComputedStyle(el).fontFamily || ''; } catch (e) {}
      if (/(?:^|[\s,"'])kanzhun-mix(?:$|[\s,"'])/i.test(fontFamily)) {
        text = raw.replace(/[\ue031-\ue03a]/g, ch => String(ch.charCodeAt(0) - 0xe031));
      }
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  // 薪资可能使用 salary / job-salary 等不同类名；保留日薪、月薪和薪数单位。
  function readSalary(card) {
    const candidates = Array.from(card.querySelectorAll(salarySelector))
      .flatMap(el => [normalizedSalaryText(el), el.getAttribute('data-salary')])
      .filter(text => text && !/[\ue000-\uf8ff]/.test(text));
    return candidates.find(text => JobFilters.parseSalary(text)) || candidates[0] || '';
  }

  function readCompanies(card) {
    const field = SELECTORS.jobs.company;
    const names = Array.from(card.querySelectorAll(field))
      .flatMap(el => [el.getAttribute('data-company-name'), composedText(el)]);
    for (const link of card.querySelectorAll(SELECTORS.jobs.companyLink)) {
      const name = link.querySelector('.boss-name');
      names.push(name && (composedText(name).trim() || name.getAttribute('title')));
    }
    for (const footer of card.querySelectorAll('.job-card-footer')) {
      if (!footer.querySelector('.company-location')) continue;
      for (const brand of footer.querySelectorAll('.boss-info, .company-info, .brand-info')) {
        const logo = brand.querySelector('img.company-logo, img.brand-logo, .company-logo img, .brand-logo img');
        const name = brand.querySelector('.boss-name, .company-name, .brand-name');
        if (logo && name) names.push(composedText(name).trim() || name.getAttribute('title'));
      }
    }
    return [...new Set(names.map(value => (value || '').trim()).filter(value => value && !/[\uE000-\uF8FF]/.test(value)))];
  }

  function parseCard(card) {
    const linkEl = card.querySelector('a[href*="/job_detail/"]');
    const link = linkEl ? linkEl.href : '';
    const match = link.match(/\/job_detail\/([\w-]+)\.html(?:[?#]|$)/);
    const tags = Array.from(card.querySelectorAll(SELECTORS.jobs.tagList + ', .job-type-tag, .job-tag, .job-label'))
      .map(el => composedText(el).trim()).filter(Boolean);
    const companies = readCompanies(card);
    const locations = Array.from(card.querySelectorAll(SELECTORS.jobs.location))
      .flatMap(el => [el.getAttribute('data-job-location'), el.getAttribute('data-job-address'), el.getAttribute('title'), composedText(el)])
      .map(value => (value || '').trim()).filter(Boolean);
    const cityEl = card.querySelector('.job-city, [data-job-city]');
    const districtEl = card.querySelector('.job-district, [data-job-district]');
    const city = cityEl ? cityEl.getAttribute('data-job-city') || composedText(cityEl).trim() : '';
    const district = districtEl ? districtEl.getAttribute('data-job-district') || composedText(districtEl).trim() : '';
    const location = [...new Set([city, district, ...locations].filter(Boolean))].join(' · ');
    const distances = Array.from(card.querySelectorAll(SELECTORS.jobs.distance))
      .flatMap(el => [el.getAttribute('data-distance-text'), composedText(el)]).filter(Boolean);
    const locationDistance = location.match(/(?:^|[\s·•|｜（(])((?:距离(?:我|您|当前位置)?|距(?:我|您|当前位置)|离(?:我|您)|直线距离)\s*[:：]?\s*\d+(?:\.\d+)?\s*(?:千米|公里|km|米|m))(?=$|[\s·•|｜）)])/i)?.[1];
    const distanceText = distances.find(value => JobFilters.parseDistance(value) !== null) || locationDistance || '';
    const typeEl = card.querySelector('.job-type, .employment-type, [data-job-type]');
    const employmentType = typeEl ? (composedText(typeEl).trim() || typeEl.getAttribute('data-job-type') || '') : '';
    return {
      id: match ? match[1] : '',
      name: readTitle(card),
      salary: readSalary(card),
      tags: tags,
      company: companies[0] || '',
      companyAliases: [...new Set(companies.slice(1))],
      location,
      distanceText,
      employmentType,
      link: link
    };
  }

  function findCardByJob(job) {
    const cards = getCards();
    for (const c of cards) { const j = parseCard(c); if (job.id && j.id === job.id) return c; }
    return null;
  }

  const paginatorSelector = '.pagination, .pagination-area, .ui-page, .page-wrap, .el-pagination, .pager, .page-list, nav[aria-label*="分页"]';
  const currentPageSelector = '[aria-current="page"], .page-current, .ui-page-active, .pagination-item.active, .el-pager .is-active, .active, .current';
  const nextPageSelector = '.btn-next, .next, .page-next, .ui-page-next, .pagination-next, [rel="next"]';
  const disabledPageSelector = '[disabled], [aria-disabled="true"], .disabled, .is-disabled';

  function pageNumber(element) {
    const label = (element?.textContent || '').trim();
    return /^\d+$/.test(label) ? Number(label) : null;
  }

  function pageInfo() {
    const paginators = [...document.querySelectorAll(paginatorSelector)].filter(isVisible);
    const controls = new Set();
    let number = null;
    for (const paginator of paginators) {
      for (const element of paginator.querySelectorAll(currentPageSelector)) {
        if (!isVisible(element)) continue;
        number ??= pageNumber(element);
      }
      for (const element of paginator.querySelectorAll('a, button, li, [role="button"], ' + nextPageSelector)) {
        if (isVisible(element)) controls.add(element);
      }
    }
    const visible = [...controls];
    const clickable = visible.filter(element => !element.closest(disabledPageSelector));
    const explicit = visible.filter(element => element.matches(nextPageSelector) ||
      [element.textContent, element.title, element.getAttribute('aria-label')].some(label =>
        /^(?:下一页|下页|next(?:\s+page)?|›|»|>)$/i.test((label || '').trim())));
    const next = clickable.find(element => explicit.includes(element) &&
      element.matches('a, button, [role="button"]')) ||
      clickable.find(element => explicit.includes(element)) ||
      (number !== null && (clickable.find(element => element.matches('a, button, [role="button"]') && pageNumber(element) === number + 1) ||
        clickable.find(element => pageNumber(element) === number + 1))) || null;
    return { next, number, atEnd: !next && (explicit.some(element => element.closest(disabledPageSelector)) ||
      (number !== null && visible.some(element => pageNumber(element) < number) &&
        !visible.some(element => pageNumber(element) > number))) };
  }

  function resultKeys(cards = getCards()) {
    return [...new Set(cards.map(card => card.querySelector('a[href*="/job_detail/"]')?.pathname).filter(Boolean))];
  }

  function resultState() {
    return { keys: resultKeys(), url: location.href, number: pageInfo().number };
  }

  function resultsLoading() {
    return [...document.querySelectorAll('.job-list-container[aria-busy="true"], .job-list-box[aria-busy="true"], .job-list-container .loading, .job-list-container .loading-more.is-loading, .job-list-box .loading')].some(isVisible);
  }

  function loadMoreResults() {
    const controls = document.querySelectorAll('.job-list-container :is(button, a, [role="button"], .load-more), .search-job-result :is(button, a, [role="button"], .load-more)');
    return [...controls].find(control => isVisible(control) && !control.closest(disabledPageSelector) &&
      /^(?:加载更多(?:职位|岗位)?|查看更多(?:职位|岗位)?|显示更多(?:职位|岗位)?)$/.test(JobFilters.identity(control.innerText || control.getAttribute('aria-label'))) &&
      !control.matches('a[href]:not([href^="#"])'));
  }

  function resultScrollContainers() {
    const last = getCards().at(-1);
    const containers = [];
    let container = last?.parentElement;
    while (container && container !== document.body) {
      if (container.scrollHeight > container.clientHeight && /auto|scroll/.test(getComputedStyle(container).overflowY)) {
        containers.push(container);
      }
      container = container.parentElement;
    }
    const scrolling = document.scrollingElement;
    if (scrolling && scrolling.scrollHeight > scrolling.clientHeight && !containers.includes(scrolling)) containers.push(scrolling);
    return containers;
  }

  function scrollResultContainers() {
    const containers = resultScrollContainers();
    let moved = false;
    for (const scrollable of containers) {
      const end = scrollable.scrollHeight - scrollable.clientHeight;
      if (scrollable.scrollTop < end - 2) {
        const before = scrollable.scrollTop;
        const ratio = 0.55 + Math.random() * 0.28;
        const nextTop = Math.min(end, scrollable.scrollTop + Math.max(240, Math.round(scrollable.clientHeight * ratio)));
        try { scrollable.scrollTo({ top: nextTop, behavior: 'smooth' }); } catch (_) {}
        scrollable.scrollTop = nextTop;
        if (scrollable.scrollTop > before + 1) moved = true;
      }
    }
    return moved;
  }

  async function revisitListEnd(initial, existing) {
    const containers = resultScrollContainers();
    const atBottom = containers.find(scrollable => scrollable.scrollTop > 0 &&
      scrollable.scrollTop >= scrollable.scrollHeight - scrollable.clientHeight - 2);
    if (!atBottom) return false;
    atBottom.scrollTop = Math.max(0, atBottom.scrollTop - Math.max(240, atBottom.clientHeight * 0.85));
    await sleep(250);
    const last = getCards().at(-1);
    last?.scrollIntoView({ block: 'end' });
    atBottom.scrollTop = atBottom.scrollHeight;
    return waitForResultChange(initial, existing, 12, true);
  }

  async function waitForResultChange(initial, existing, attempts, allowPageChange) {
    const previous = new Set(initial.keys);
    let stablePage = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await sleep(350);
      const current = resultState();
      if (current.keys.some(key => !existing.has(key) && !previous.has(key))) return true;
      const moved = allowPageChange && (current.url !== initial.url || current.number !== initial.number && current.number !== null);
      if (moved && current.keys.length && !resultsLoading()) {
        const marker = JSON.stringify([current.url, current.number, current.keys]);
        const replaced = current.keys.join('|') !== initial.keys.join('|');
        if (stablePage === marker && (replaced || attempt >= 5)) return true;
        stablePage = marker;
      } else stablePage = null;
    }
    return false;
  }

  function paginationUrl(href, keyword) {
    const current = new URL(location.href);
    const next = new URL(href, current);
    if (next.origin !== current.origin || next.pathname !== current.pathname) return null;
    const city = current.searchParams.get('city');
    const jobType = current.searchParams.get('jobType');
    if (next.searchParams.has('query') && next.searchParams.get('query') !== keyword ||
      next.searchParams.has('city') && next.searchParams.get('city') !== city ||
      next.searchParams.has('jobType') && next.searchParams.get('jobType') !== jobType) return null;
    if (!['page', 'pageNum', 'pageNo', 'pageIndex', 'offset', 'cursor'].some(key =>
      next.searchParams.has(key) && next.searchParams.get(key) !== current.searchParams.get(key))) return null;
    for (const [key, value] of current.searchParams) {
      if (!next.searchParams.has(key) && !['page', 'pageNum', 'pageNo', 'pageIndex', 'offset', 'cursor'].includes(key)) {
        next.searchParams.append(key, value);
      }
    }
    next.searchParams.set('query', keyword);
    if (city) next.searchParams.set('city', city);
    return next.href;
  }

  async function advanceResults(visited, keyword, retry = 0) {
    const existing = new Set(visited);
    const initial = resultState();
    if (initial.keys.some(key => !existing.has(key))) return { advanced: true };
    let scrolling = false;
    for (let step = 0; step < 16; step++) {
      scrolling = scrollResultContainers();
      await sleep(jitter(520, 980));
      if (await waitForResultChange(initial, existing, scrolling ? 2 : 8, false)) return { advanced: true };
      if (!scrolling) break;
    }
    if (scrolling) return { advanced: false, scrolling: true };
    if (resultsLoading()) {
      return await waitForResultChange(initial, existing, 24, true) ? { advanced: true } :
        { advanced: false, reason: '职位列表仍在加载或没有返回新结果' };
    }
    const more = loadMoreResults();
    if (more) {
      more.click();
      return await waitForResultChange(initial, existing, 24, true) ? { advanced: true } :
        { advanced: false, reason: '点击加载更多后没有返回新岗位' };
    }
    const { next: button, atEnd } = pageInfo();
    if (!button) {
      if (!atEnd && retry > 0 && await revisitListEnd(initial, existing)) return { advanced: true };
      return { advanced: false, exhausted: atEnd, reason: atEnd ? '分页控件已到最后一页' : '列表滚动到底后未发现下一页或新增岗位' };
    }
    const href = button.getAttribute('href');
    if (href && !href.startsWith('#') && !/^javascript:/i.test(href.trim())) {
      const url = paginationUrl(href, keyword);
      return url ? { advanced: true, url } : { advanced: false, reason: '无法核实下一页链接的搜索条件' };
    }
    if (href && /^javascript:/i.test(href.trim()) && !/^javascript:\s*(?:;|void\s*\(\s*0\s*\)\s*;?)$/i.test(href.trim())) {
      return { advanced: false, reason: '下一页链接无法确认' };
    }
    if (href && /^javascript:/i.test(href.trim())) {
      button.addEventListener('click', event => event.preventDefault(), { capture: true, once: true });
    }
    button.click();
    if (await waitForResultChange(initial, existing, 24, true)) return { advanced: true };
    return { advanced: false, reason: '下一页未在等待时间内加载完成' };
  }

  function isVisible(element) {
    if (!element?.isConnected || !element.getClientRects().length) return false;
    const { visibility } = getComputedStyle(element);
    return visibility !== 'hidden' && visibility !== 'collapse';
  }

  function contactControl(scope, labels) {
    return [...scope.querySelectorAll(SELECTORS.jobs.contact)].find(element => {
      if (!isVisible(element) || element.closest('[disabled], [aria-disabled="true"], .disabled, .is-disabled')) return false;
      return [element.innerText, composedText(element), element.getAttribute('aria-label'), element.title]
        .some(label => labels.includes(JobFilters.identity(label)));
    });
  }

  // 弹窗内的「留在此页 / 继续沟通」在 BOSS 新版 UI 中常为 <span> 或 <div class="...btn...">，需兼容非 button 标签。
  function dialogControl(scope, labels) {
    const direct = contactControl(scope, labels);
    if (direct) return direct;
    const candidates = [...scope.querySelectorAll('[class*="btn"], [class*="button"], [class*="cancel"], [class*="sure"], [class*="confirm"], span, div')]
      .filter(el => isVisible(el) && !el.closest('[disabled], [aria-disabled="true"], .disabled, .is-disabled') &&
        labels.includes(JobFilters.identity(el.innerText || composedText(el))));
    if (!candidates.length) return null;
    const picked = candidates.at(-1);
    const wrapper = picked.closest('button, a, [role="button"], [class*="btn"], [class*="button"], [class*="cancel"], [class*="sure"], [class*="confirm"]');
    return wrapper && scope.contains(wrapper) && labels.includes(JobFilters.identity(wrapper.innerText || composedText(wrapper))) ? wrapper : picked;
  }

  function visibleDialogs() {
    const found = new Set([...document.querySelectorAll(SELECTORS.jobs.dialog)].filter(isVisible));
    const dialogLabels = stayLabels.concat(continuationLabels);
    for (const el of document.querySelectorAll('button, a, [role="button"], [class*="btn"], span, div')) {
      if (el.children.length > 2 || !isVisible(el)) continue;
      if (el.closest(SELECTORS.jobs.jobCard) || el.closest(SELECTORS.jobs.detail)) continue;
      const text = JobFilters.identity(el.innerText || el.textContent);
      if (!dialogLabels.includes(text)) continue;
      const container = el.closest('[role="dialog"], [aria-modal="true"], [class*="popup"], [class*="dialog"], [class*="modal"], [class*="layer"]')
        || el.parentElement?.parentElement;
      if (container && container !== document.body && isVisible(container)) found.add(container);
    }
    return [...found];
  }

  async function dismissResidualGreetingDialog() {
    for (const dialog of visibleDialogs()) {
      const stay = dialogControl(dialog, stayLabels);
      if (!stay) continue;
      await clickContact(stay);
      for (let i = 0; i < 8 && isVisible(dialog); i++) await sleep(120);
    }
  }

  function detailCompanies(panel) {
    const names = readCompanies(panel);
    for (const employer of panel.querySelectorAll('.job-boss-info .boss-info-attr, .boss-info .boss-info-attr, .boss-info-attr')) {
      const value = composedText(employer).split(/\s*[·•]\s*/)[0].trim();
      if (value && !/[\uE000-\uF8FF]/.test(value)) names.push(value);
    }
    return [...new Set(names)];
  }

  function verifiedDetail(job) {
    const panels = [...document.querySelectorAll(SELECTORS.jobs.detail)].filter(isVisible);
    return panels.find(panel => {
      const name = readTitle(panel);
      if (!name || JobFilters.identity(name) !== JobFilters.identity(job.name)) return false;
      const listing = panel.querySelector('.job-detail-header a[href*="/job_detail/"], .job-detail-title a[href*="/job_detail/"]');
      const panelId = panel.getAttribute('data-job-id');
      const urlMatch = /^\/job_detail\/([\w-]+)\.html$/.exec(location.pathname);
      if (listing && !new URL(listing.href).pathname.endsWith('/' + job.id + '.html')) return false;
      if (panelId && panelId !== job.id) return false;
      if (urlMatch && urlMatch[1] !== job.id) return false;
      const companyAliases = detailCompanies(panel);
      return !!listing || panelId === job.id || urlMatch?.[1] === job.id ||
        JobFilters.sameEmployerAndTitle(job, { name, companyAliases });
    }) || null;
  }

  function availableContact(card, job, constraints) {
    const cardButton = contactControl(card, contactLabels);
    if (cardButton) return { button: cardButton, job };
    const panel = verifiedDetail(job);
    const button = panel && contactControl(panel, contactLabels);
    if (!button) return null;
    const verified = { ...job, companyAliases: [...new Set([...job.companyAliases, ...detailCompanies(panel)])] };
    const rejection = JobFilters.deliveryRejection(constraints, verified);
    if (rejection) throw new Error('沟通前复核：' + rejection);
    return { button, job: verified };
  }

  async function waitForContact(card, job, constraints) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const control = availableContact(card, job, constraints);
      if (control) return control;
      await sleep(250);
    }
    return null;
  }

  function detailPageJobId() {
    const match = /^\/job_detail\/([\w-]+)\.html$/.exec(location.pathname);
    return match ? match[1] : '';
  }

  function readDetailPageCompanies() {
    const names = detailCompanies(document);
    for (const el of document.querySelectorAll('.sider-company .company-info a, .sider-company a[href*="/gongsi/"], .company-info a[href*="/gongsi/"], .level-list .company-name')) {
      const text = (el.getAttribute('title') || composedText(el)).trim();
      if (text && !/[\uE000-\uF8FF]/.test(text)) names.push(text);
    }
    return [...new Set(names.filter(Boolean))];
  }

  function readDetailPageJob(job) {
    const id = detailPageJobId();
    const banner = document.querySelector('.job-banner, .info-primary, .job-detail-header') || document.body;
    const title = readTitle(banner) || readTitle(document);
    const companies = readDetailPageCompanies();
    const liveSalary = readSalary(banner);
    const jdEl = document.querySelector('.job-sec-text, .job-detail-section, .detail-content') ||
      document.querySelector(SELECTORS.jobs.detail);
    const jd = (jdEl?.innerText || '').trim().slice(0, 1800);
    const liveJob = {
      ...job,
      id: id || job.id,
      name: title || job.name,
      salary: liveSalary || job.salary || '',
      company: companies[0] || job.company || '',
      companyAliases: [...new Set([...(job.companyAliases || []), ...companies])]
    };
    return { liveJob, jd, title, companies };
  }

  function findDetailPageContact() {
    const scopes = [
      document.querySelector('.job-banner, .info-primary, .job-op, .btn-container'),
      document.querySelector(SELECTORS.jobs.detail),
      document.body
    ].filter(Boolean);
    for (const scope of scopes) {
      const btn = contactControl(scope, contactLabels);
      if (btn) return btn;
    }
    return null;
  }

  async function inspectContact(job, constraints) {
    const blocked = verificationStatus();
    if (blocked) return blocked;
    if (detailPageJobId() === job.id) {
      if (!constraints) throw new Error('当前页面无法确认目标岗位');
      const { liveJob } = readDetailPageJob(job);
      if (!JobFilters.sameEmployerAndTitle(job, liveJob)) throw new Error('岗位名称或公司与审核记录不一致');
      const rejection = JobFilters.deliveryRejection(constraints, liveJob);
      if (rejection) throw new Error(rejection);
      for (let attempt = 0; attempt < 12; attempt++) {
        if (findDetailPageContact()) return { success: true, status: '找到已核实的网页沟通按钮' };
        await sleep(200);
      }
      return { success: false, error: '详情页已核实，但没有可用的「立即沟通」按钮' };
    }
    const card = findCardByJob(job);
    if (!card || !constraints) throw new Error('当前页面无法确认目标岗位');
    const fresh = readVerifiedCard(card, job, constraints);
    if (await waitForContact(card, fresh, constraints)) return { success: true, status: '找到已核实的网页沟通按钮' };
    return { success: false, error: contactFailure(card, fresh) };
  }

  function contactFailure(card, job) {
    const detail = verifiedDetail(job);
    if ([card, detail].some(scope => scope && appOnlyPattern.test(JobFilters.identity(scope.innerText)))) {
      return '页面显示 App 沟通入口，未找到属于该岗位的网页沟通按钮';
    }
    if (detail) return '右侧岗位已核实，但没有可用的「立即沟通」按钮';
    const first = [...document.querySelectorAll(SELECTORS.jobs.detail)].find(isVisible);
    const displayedCompany = first && detailCompanies(first)[0];
    return '无法核对右侧详情。页面：' + (first && readTitle(first) || '未读到岗位标题') +
      ' / ' + (displayedCompany || '未读到公司') + '；目标：' + job.name + ' / ' + job.company;
  }

  async function clickContact(control) {
    const href = control.getAttribute('href')?.trim() || '';
    if (/^javascript:/i.test(href)) {
      if (!/^javascript:\s*(?:;|void\s*\(\s*0\s*\)\s*;?)$/i.test(href)) {
        throw new Error('无法核实沟通入口，请手动打开岗位');
      }
      control.addEventListener('click', event => event.preventDefault(), { capture: true, once: true });
    }
    await humanHoverAndPress(control);
    if (typeof control.click === 'function') control.click();
    else control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }

  function contactStage(job, stage) {
    chrome.runtime.sendMessage({ type: 'CONTACT_STAGE', jobId: job.id, stage }).catch(() => {});
  }

  function readVerifiedCard(card, job, constraints) {
    const fresh = parseCard(card);
    if (!card.isConnected || fresh.id !== job.id || !JobFilters.sameEmployerAndTitle(job, fresh)) {
      throw new Error('岗位名称或公司与审核记录不一致');
    }
    const rejection = JobFilters.deliveryRejection(constraints, fresh);
    if (rejection) throw new Error(rejection);
    return fresh;
  }

  // 点开卡片 → 抓取右侧详情面板的完整JD（若已在直达岗位详情页则直接读取，无需翻页找卡片）
  async function openJD(job) {
    const blocked = verificationStatus();
    if (blocked) return blocked;
    await dismissResidualGreetingDialog();
    if (detailPageJobId() === job.id) {
      for (let attempt = 0; attempt < 16; attempt++) {
        const restriction = verificationStatus();
        if (restriction) return restriction;
        const { liveJob, jd, title, companies } = readDetailPageJob(job);
        if (title && companies.length && JobFilters.sameEmployerAndTitle(job, liveJob)) {
          return { success: true, jd, job: liveJob };
        }
        await sleep(180);
      }
      const { liveJob, jd } = readDetailPageJob(job);
      return { success: true, jd, job: liveJob };
    }
    const card = findCardByJob(job);
    if (!card) return { success: false, error: '未找到岗位卡片' };
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(jitter(350, 750));
    const beforeOpen = verificationStatus();
    if (beforeOpen) return beforeOpen;
    if (!card.isConnected || parseCard(card).id !== job.id) return { success: false, error: '岗位卡片已经变化' };
    const liveJob = parseCard(card);
    await humanHoverAndPress(card);
    card.click();
    for (let attempt = 0; attempt < 14; attempt++) {
      const restriction = verificationStatus();
      if (restriction) return restriction;
      const detail = verifiedDetail(liveJob);
      if (detail) return { success: true, jd: (detail.innerText || '').trim().slice(0, 1800), job: parseCard(card) };
      await sleep(180);
    }
    return { success: true, jd: '', job: parseCard(card) };
  }

  // 卡片已打开或直达详情页 → 点立即沟通 → 处理「留在此页 / 继续沟通」弹窗
  async function goChat(job, constraints, expiresAt, preferContinue = false) {
    const blocked = verificationStatus();
    if (blocked) return blocked;
    await dismissResidualGreetingDialog();
    const isDirectDetail = detailPageJobId() === job.id;
    let card = null;
    let fresh = null;
    let target = null;
    if (isDirectDetail) {
      if (!constraints) return { success: false, error: '当前页面无法确认目标岗位' };
      const { liveJob } = readDetailPageJob(job);
      if (!JobFilters.sameEmployerAndTitle(job, liveJob)) {
        return { success: false, error: '岗位名称或公司与审核记录不一致' };
      }
      const rejection = JobFilters.deliveryRejection(constraints, liveJob);
      if (rejection) return { success: false, error: rejection };
      fresh = liveJob;
      let btn = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        btn = findDetailPageContact();
        if (btn) break;
        await sleep(220);
      }
      if (!btn) {
        return verificationStatus() || {
          success: false,
          error: appOnlyPattern.test(JobFilters.identity(document.body?.innerText || ''))
            ? '页面显示 App 沟通入口，未找到属于该岗位的网页沟通按钮'
            : '详情页已核实，但没有可用的「立即沟通」按钮'
        };
      }
      target = { button: btn, job: fresh };
    } else {
      card = findCardByJob(job);
      if (!card || !constraints) return { success: false, error: '当前页面无法确认目标岗位' };
      fresh = readVerifiedCard(card, job, constraints);
      target = await waitForContact(card, fresh, constraints);
      if (!target) return verificationStatus() || { success: false, error: contactFailure(card, fresh) };
    }
    const permission = await chrome.runtime.sendMessage({ type: 'CHECK_DELIVERY', job: target.job, expiresAt });
    if (!permission?.ok) return { success: false, timedOut: !!permission?.timedOut, error: permission?.error || '投递复核未通过' };
    const beforeClick = verificationStatus();
    if (beforeClick) return beforeClick;
    let current = fresh;
    if (!isDirectDetail) {
      current = readVerifiedCard(card, fresh, constraints);
      const stillAvailable = availableContact(card, current, constraints);
      if (stillAvailable?.button !== target.button ||
        JSON.stringify(stillAvailable.job.companyAliases) !== JSON.stringify(target.job.companyAliases) ||
        current.salary !== fresh.salary || current.location !== fresh.location ||
        current.distanceText !== fresh.distanceText || current.employmentType !== fresh.employmentType) {
        return { success: false, error: '页面已变化，请重新审核岗位' };
      }
    } else {
      const stillBtn = findDetailPageContact();
      if (!stillBtn || detailPageJobId() !== job.id) {
        return { success: false, error: '详情页已变化，请重新审核岗位' };
      }
    }
    const existingDialogs = new Map(visibleDialogs().map(dialog => [dialog, JobFilters.identity(dialog.innerText)]));
    assertDeliveryTime(expiresAt);
    await sleep(jitter(280, 650));
    await clickContact(target.button);
    contactStage(job, 'contact-clicked');
    for (let attempt = 0; attempt < 28; attempt++) {
      const restriction = verificationStatus();
      if (restriction) return restriction;
      if (/^\/web\/geek\/chat\/?$/.test(location.pathname)) return { success: true };
      for (const dialog of visibleDialogs()) {
        if (existingDialogs.get(dialog) === JobFilters.identity(dialog.innerText)) continue;
        const stay = dialogControl(dialog, stayLabels);
        const go = dialogControl(dialog, continuationLabels);
        if (stay || go) {
          const useStay = stay && (!preferContinue || !go);
          if (useStay) {
            assertDeliveryTime(expiresAt);
            await sleep(jitter(320, 680));
            await clickContact(stay);
            for (let check = 0; check < 14; check++) {
              const blockedAfterStay = verificationStatus();
              if (blockedAfterStay) return blockedAfterStay;
              if (!isVisible(dialog) || !dialogControl(dialog, stayLabels)) return { success: true, stayed: true };
              await sleep(120);
            }
            const closeBtn = dialog.querySelector('.boss-popup__close, .icon-close, .close, [aria-label="关闭"]');
            if (closeBtn && isVisible(closeBtn)) {
              await clickContact(closeBtn);
              await sleep(250);
              if (!isVisible(dialog)) return { success: true, stayed: true };
            }
            return { success: false, error: '已点击「留在此页」，但弹窗未关闭' };
          }
          let confirmed = target.job;
          if (!isDirectDetail) {
            const activeCard = card.isConnected ? card : (findCardByJob(job) || card);
            const latestCard = activeCard.isConnected ? readVerifiedCard(activeCard, current, constraints) : current;
            confirmed = { ...target.job, salary: latestCard.salary, location: latestCard.location,
              distanceText: latestCard.distanceText, employmentType: latestCard.employmentType, tags: latestCard.tags };
          }
          const continuation = await chrome.runtime.sendMessage({ type: 'CHECK_DELIVERY', job: confirmed, expiresAt });
          if (!continuation?.ok || dialogControl(dialog, continuationLabels) !== go) {
            return { success: false, timedOut: !!continuation?.timedOut, error: continuation?.error || '沟通弹窗按钮已变化' };
          }
          const beforeContinue = verificationStatus();
          if (beforeContinue) return beforeContinue;
          assertDeliveryTime(expiresAt);
          const anchor = go.closest('a[href]') || go.querySelector?.('a[href]');
          let chatUrl = '';
          try {
            const parsed = anchor && new URL(anchor.getAttribute('href'), location.origin);
            if (parsed && parsed.origin === 'https://www.zhipin.com' && /^\/web\/geek\/chat\b/.test(parsed.pathname)) {
              chatUrl = parsed.href;
            }
          } catch (_) {}
          await sleep(jitter(300, 680));
          await clickContact(go);
          contactStage(job, 'continue-clicked');
          return { success: true, continueClicked: true, chatUrl };
        }
        if (appOnlyPattern.test(JobFilters.identity(dialog.innerText))) {
          return { success: false, error: '点击后页面要求在 BOSS 直聘 App 沟通，请手动处理' };
        }
      }
      await sleep(250);
    }
    return { success: true, pendingNavigation: true };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CHECK_VERIFICATION') {
      sendResponse(verificationStatus() || { success: true });
      return;
    }
    if (msg.type === 'JOBCOPILOT_PAGE_READY' && msg.page === 'search') {
      sendResponse({ protocol });
      return;
    }
    if (msg.type === 'READ_RESULTS') {
      const restriction = verificationStatus();
      if (restriction) { sendResponse(restriction); return; }
      const cards = getCards();
      sendResponse({ success: true, jobs: cards.map(parseCard), keys: resultKeys(cards), pageNumber: pageInfo().number, loading: resultsLoading() });
      return;
    }
    if (msg.type === 'NEXT_RESULTS') {
      const restriction = verificationStatus();
      if (restriction) { sendResponse(restriction); return; }
      advanceResults(msg.visited || [], msg.keyword, msg.retry).then(result => sendResponse(verificationStatus() || result))
        .catch(error => sendResponse({ advanced: false, reason: error.message }));
      return true;
    }
    if (msg.type === 'OPEN_JD') {
      openJD(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'HAS_REVIEWED_JOB') {
      sendResponse(verificationStatus() || { success: true, present: detailPageJobId() === msg.job?.id || !!findCardByJob(msg.job) });
      return;
    }
    if (msg.type === 'GO_CHAT') {
      goChat(msg.job, msg.constraints, msg.expiresAt, msg.preferContinue === true).then(r => sendResponse(r))
        .catch(error => sendResponse({ success: false, error: error.message, timedOut: !!error.timedOut }));
      return true;
    }
    if (msg.type === 'INSPECT_CONTACT') {
      inspectContact(msg.job, msg.constraints).then(sendResponse)
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;
    }
  });
})();
