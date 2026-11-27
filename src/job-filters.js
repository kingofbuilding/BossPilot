(function (root) {
  const fields = ['screeningMode', 'excludedCompanies', 'allowedCompanies', 'excludeBigTech', 'allowedAreas',
    'maxDistanceKm', 'salaryUnit', 'minSalary', 'maxSalary'];
  const maxSearchCount = 1000;
  const bigTech = ['字节跳动', 'ByteDance', '抖音集团', 'TikTok', '腾讯', 'Tencent', '阿里巴巴', '阿里云',
    '蚂蚁集团', '淘宝', '天猫', '支付宝', '百度', '华为', '海思', '京东', '美团', '快手', '小米', '拼多多',
    'Temu', '网易', '哔哩哔哩', 'Bilibili', '小红书', '滴滴出行', '携程集团'];

  function normalize(value) {
    return String(value ?? '').normalize('NFKC').trim().toLowerCase();
  }

  function identity(value) {
    return normalize(value).replace(/[\s\u200b]+/g, '');
  }

  function list(value) {
    return [...new Set(normalize(value).split(/[\r\n,，、;；]+/).map(item => item.trim()).filter(Boolean))];
  }

  function titleMatches(title, keyword) {
    const normalizedTitle = identity(title);
    return !!normalizedTitle && normalize(keyword).split(/\s+/).map(identity)
      .every(term => term && normalizedTitle.includes(term));
  }

  function screeningMode(cfg) {
    return ['employment', 'resume'].includes(cfg.screeningMode) ? 'employment' : 'internship';
  }

  function searchJobType(mode) {
    return mode === 'internship' ? '1902' : '';
  }

  function internshipInTitle(value) {
    const title = normalize(value);
    const marker = title.includes('实习');
    const inconsistent = /(?:非|无|不招|不收|不接受|不提供|拒绝|招满|仅限有)\s*实习|实习生?(?:经验|经历|证明|导师|指导老师|招聘专员|管理岗)|\bnon[-\s]+intern(?:ship)?\b|全职|正式岗[位]?|社招|兼职|\bfull[-\s]*time\b|\bpart[-\s]*time\b/.test(title);
    return marker && !inconsistent;
  }

  function isInternship(job) {
    const type = normalize(job.employmentType);
    return internshipInTitle(job.name) && !/全职|正式岗|社招|兼职|校招|full[-\s]*time|part[-\s]*time/.test(type);
  }

  function isGraduateJob(job) {
    const titleAndType = normalize([job.name, job.employmentType].filter(Boolean).join(' '));
    const evidence = [job.name, job.employmentType, ...(job.tags || [])].map(normalize);
    if (/实习|\bintern(?:ship|s|ships)?\b|兼职|社招|part[-\s]*time/.test(titleAndType) ||
      evidence.some(value => /^(?:实习岗(?:位)?|实习|实习生|intern|internship|兼职|社招)$/.test(value))) return false;
    if (evidence.some(value => /(?:不招|不收|不接受|拒绝|非)\s*(?:应届|校招)|(?:应届|校招)(?:生)?\s*(?:勿投|除外)/.test(value))) return false;
    return evidence.some(value => /校招|校园招聘|应届|\bcampus (?:hire|recruitment)\b|\bnew grad(?:uate)?s?\b/.test(value));
  }

  const internshipEnding = /\s*实习(?:生|岗位?)?$/;
  const agentMarker = /智能体|(?:^|[^a-z0-9])agents?(?![a-z0-9])|(?:^|[^a-z0-9])ai[-\s]?agents?(?![a-z0-9])/;
  const aiDomainMarker = /智能体|人工智能|大模型|多模态|自然语言|深度学习|机器学习|提示词|工作流|对话系统|智能问答|知识库|具身|(?:^|[^a-z0-9])(?:ai|agents?|llm|aigc|rag|mcp|nlp|prompt|workflow|gpt|python)(?![a-z0-9])/;
  const fullStackMarker = /全[栈棧]|(?:^|[^a-z0-9])full[-\s]?stack(?![a-z0-9])/;
  const backendMarker = /后端|後端|服务端|服務端|(?:^|[^a-z0-9])back[-\s]?end(?![a-z0-9])/;
  const developerMarker = /开发|開發|研发|研發|工程师|工程師|工程|交付|解决方案|应用|评测|算法|架构|技术|实习|\b(?:developer|development|engineer|engineering)\b/;
  const nonDevExclude = /产品经理|商业化产品|数据产品|ai产品|产品实习|产品助理|运营|营销|销售|市场|商务|设计|美工|剪辑|视觉|交互|hr|招聘|行政|财务|法务|客服|标注|审核|猎头|顾问|助教|讲师|教研|编辑|文案|新媒体|直播|管培|\b(?:product manager|marketing|sales|design(?:er)?)\b/;
  const unrelatedTechExclude = /前端|(?:\bios\b|android|安卓|鸿蒙|flutter|小程序|嵌入式|单片机|fpga|asic|芯片|硬件|pcb|plc|机械|结构|测绘|bim|unity|ue[45]?|游戏客户端|运维|网管|桌面支持)/;

  function internshipRole(role) {
    if (/^(?:(?:ai\s*)?agent|智能体)[\s·/-]*算法(?:工程师|研发)?$/.test(role)) return 'agent-algorithm';
    if (/^(?:(?:ai\s*)?agent|智能体)[\s·/-]*(?:应用[\s·/-]*)?(?:开发|研发|工程师|开发工程师)$/.test(role)) return 'agent-development';
    if (/^(?:全[栈棧]|full[-\s]?stack)\s*(?:开发|研发|工程师|开发工程师|developer|engineer)?$/.test(role)) return 'full-stack';
    if (/^(?:后端|後端|服务端|服務端|back[-\s]?end)\s*(?:开发|研发|工程师|开发工程师|developer|engineer)?$/.test(role)) return 'backend';
    return null;
  }

  function graduateRole(keyword) {
    return keyword.replace(/^(?:校招|校园招聘|应届生?)\s*/, '')
      .replace(/\s*(?:校招|校园招聘|应届生?)$/, '').trim();
  }

  function matchesSearchTitle(title, keyword, cfg, tags = []) {
    const term = normalize(keyword);
    const exact = titleMatches(title, term);
    if (screeningMode(cfg) === 'employment') {
      const role = graduateRole(term);
      return exact || (!!role && role !== term && titleMatches(title, role));
    }
    if (!internshipInTitle(title)) return exact;
    const role = term.replace(internshipEnding, '').trim();
    const normalizedTitle = normalize(title);
    const normalizedTags = Array.isArray(tags) ? normalize(tags.join(' ')) : '';
    switch (internshipRole(role)) {
      case 'agent-algorithm':
        return agentMarker.test(normalizedTitle) && /算法|\balgorithms?\b/.test(normalizedTitle);
      case 'agent-development': {
        if (nonDevExclude.test(normalizedTitle)) return false;
        const hasAiInTitle = aiDomainMarker.test(normalizedTitle);
        const hasAiInTags = aiDomainMarker.test(normalizedTags);
        if (unrelatedTechExclude.test(normalizedTitle) && !agentMarker.test(normalizedTitle) && !hasAiInTitle) return false;
        if (hasAiInTitle && developerMarker.test(normalizedTitle)) return true;
        return hasAiInTags && /开发|開發|研发|研發|工程师|工程師|工程|交付|解决方案|应用|评测|算法|架构|\b(?:developer|development|engineer)\b/.test(normalizedTitle);
      }
      case 'backend':
        return backendMarker.test(normalizedTitle) &&
          !/运营|营销|产品经理|\b(?:product manager|marketing)\b/.test(normalizedTitle) &&
          (developerMarker.test(normalizedTitle) || /(?:后端|後端|服务端|服務端|back[-\s]?end)[\s·-]*实习/.test(normalizedTitle));
      case 'full-stack':
        return fullStackMarker.test(normalizedTitle) &&
          !/(?:设计|运营|营销|产品经理|design(?:er)?|product manager|marketing)/.test(normalizedTitle);
      default:
        return exact || (role !== '' && role !== term && titleMatches(title, role));
    }
  }

  function searchQueries(keyword, cfg) {
    if (screeningMode(cfg) === 'employment') {
      const role = graduateRole(keyword);
      return role ? [...new Set([keyword, role + ' 校招', role])] : [keyword];
    }
    const query = keyword.includes('实习') ? keyword : keyword + ' 实习';
    const role = keyword.replace(internshipEnding, '').trim();
    if (!role || role.includes('实习')) return [query];
    const aliases = {
      'agent-algorithm': ['智能体 算法 实习', 'agent 算法 实习'],
      'agent-development': ['智能体 开发 实习', 'agent 研发 实习'],
      'backend': ['后端 研发 实习', '服务端 开发 实习'],
      'full-stack': ['全栈 实习', 'full stack 实习']
    }[internshipRole(role)] || [];
    return [...new Set([query, role + ' 实习', ...aliases])];
  }

  function checkTarget(cfg, job, keyword) {
    const keywords = keyword === undefined ? list(cfg.keyword) : [keyword];
    if (!keywords.some(term => matchesSearchTitle(job.name, term, cfg, job.tags))) return '岗位标题未匹配目标关键词';
    if (screeningMode(cfg) === 'internship') {
      return isInternship(job) ? '' : '岗位标题须含“实习”，且岗位类型不能冲突';
    }
    return isGraduateJob(job) ? '' : '未发现明确的校招或应届信息，或岗位类型冲突';
  }

  function numeric(value) {
    return normalize(value) === '' ? null : Number(value);
  }

  function validate(cfg) {
    const keywords = list(cfg.keyword);
    if (!keywords.length || keywords.length > 10) return ['keyword', '请填写 1–10 个搜索关键词。'];
    for (const field of ['maxDistanceKm', 'minSalary', 'maxSalary']) {
      const value = numeric(cfg[field]);
      if (value !== null && (!Number.isFinite(value) || value <= 0)) return [field, '请输入大于 0 的数字，或留空。'];
    }
    const minSalary = numeric(cfg.minSalary);
    const maxSalary = numeric(cfg.maxSalary);
    if (minSalary !== null && maxSalary !== null && minSalary > maxSalary) {
      return ['maxSalary', '薪资上限不能低于下限。'];
    }
    if ((minSalary !== null || maxSalary !== null) && !['month', 'day', 'year', 'hour'].includes(cfg.salaryUnit)) {
      return ['salaryUnit', '请明确用于比较的薪资单位。'];
    }
    return null;
  }

  function parseSalary(value) {
    let text = normalize(value).replace(/\s+/g, '');
    const label = text.match(/^([月年日天时])薪[:：]?/);
    if (label) text = text.slice(label[0].length);
    const match = text.match(/^(?:薪资[:：]?)?(\d+(?:\.\d+)?)([k千w万])?(?:[-~～—–至](\d+(?:\.\d+)?)([k千w万])?)?(元)?(?:(?:\/|每|一)(小时|时|天|日|月|年)|(?<=元)(小时|时|天|日|月|年))?(?:[·•×x*](\d+)薪)?$/);
    if (!match) return null;
    const [, low, lowScale, high, highScale, yuan, explicitPeriod, yuanPeriod, months] = match;
    const period = explicitPeriod || yuanPeriod;
    const multiplier = { k: 1000, 千: 1000, w: 10000, 万: 10000 };
    const units = { 月: 'month', 年: 'year', 天: 'day', 日: 'day', 时: 'hour', 小时: 'hour' };
    const labelUnit = label ? units[label[1]] : null;
    if (labelUnit && period && labelUnit !== units[period]) return null;
    const unit = period ? units[period] : labelUnit || ((lowScale || highScale) && !yuan ? 'month' : null);
    if (!unit || (months && unit !== 'month')) return null;
    const min = Number(low) * (multiplier[lowScale || highScale] || 1);
    const max = high ? Number(high) * (multiplier[highScale || lowScale] || 1) : min;
    return Number.isFinite(max) && min > 0 && max >= min ? { min, max, unit } : null;
  }

  function parseDistance(value) {
    const match = normalize(value).match(/^(?:(?:距离(?:我|您|当前位置)?|距(?:我|您|当前位置)|离(?:我|您)|直线距离)\s*[:：]?\s*)?(\d+(?:\.\d+)?)\s*(千米|公里|km|米|m)$/);
    if (!match) return null;
    const distance = Number(match[1]) / (/^(?:米|m)$/.test(match[2]) ? 1000 : 1);
    return Number.isFinite(distance) ? distance : null;
  }

  function matchesText(value, items) {
    const normalizedValue = identity(value);
    return items.find(item => normalizedValue.includes(identity(item)));
  }

  function companyNames(job) {
    return [job.company, ...(Array.isArray(job.companyAliases) ? job.companyAliases : [])].filter(item => identity(item));
  }

  function excludesBigTech(cfg) {
    return cfg.excludeBigTech === true || (cfg.filterVersion !== 3 &&
      /(?:不考虑|不接受|不想投|不投|不要|避开|排除|拒绝)(?:投递|投|任何|所有|互联网|头部|知名|那种|这些|的|\s)*大厂/.test(normalize(cfg.jobRequirements)));
  }

  function sameEmployerAndTitle(expected, observed) {
    return !!identity(expected.name) && identity(expected.name) === identity(observed.name) &&
      companyNames(expected).some(company => companyNames(observed).some(name => identity(name) === identity(company)));
  }

  function check(cfg, job) {
    const invalid = validate(cfg);
    if (invalid) return invalid[1];
    const target = checkTarget(cfg, job);
    if (target) return target;
    const deny = list(cfg.excludedCompanies);
    const allow = list(cfg.allowedCompanies);
    const avoidBigTech = excludesBigTech(cfg);
    const companies = companyNames(job);
    for (const company of companies) {
      const blocked = matchesText(company, deny);
      if (blocked) return '命中公司黑名单（' + blocked + '）';
      const major = avoidBigTech && matchesText(company, bigTech);
      if (major) return '命中常见大厂名单（' + major + '）';
    }
    if (allow.length && !companies.some(company => allow.some(name => identity(name) === identity(company)))) {
      return companies.length ? '公司未命中白名单（页面名称：' + companies[0] + '）' : '公司名称未获取，无法核对白名单';
    }
    const city = normalize(cfg.city).replace(/市$/, '');
    const location = normalize(job.location);
    const cityLocations = location.split(/\s*[·•|｜\-/]\s*/);
    if (city && city !== '全国' && !cityLocations.some(value => value === city ||
      value.startsWith(city + '市') || value.startsWith(city + ' '))) {
      return job.location ? '工作地点未显示目标城市（' + city + '）' : '工作地点未知，无法核对城市';
    }
    const areas = list(cfg.allowedAreas);
    if (areas.length && !job.location) return '工作地点未知，无法核对地区';
    if (areas.length && !matchesText(job.location, areas)) return '工作地点未命中允许地区';
    const maxDistance = numeric(cfg.maxDistanceKm);
    if (maxDistance !== null) {
      const distance = parseDistance(job.distanceText);
      if (distance === null) return '页面未提供可核实的距离';
      if (distance > maxDistance) return '页面距离 ' + distance + ' 公里，超过 ' + maxDistance + ' 公里';
    }
    const minSalary = numeric(cfg.minSalary);
    const maxSalary = numeric(cfg.maxSalary);
    if (minSalary !== null || maxSalary !== null) {
      const salary = parseSalary(job.salary);
      if (!salary) return '薪资面议、缺失或格式不明确';
      if (salary.unit !== cfg.salaryUnit) return '岗位薪资单位不同，无法比较';
      if (minSalary !== null && salary.min < minSalary) return '岗位起薪低于 ' + minSalary + ' 元';
      if (maxSalary !== null && salary.max > maxSalary) return '岗位薪资上限高于 ' + maxSalary + ' 元';
    }
    return '';
  }

  function deliveryRejection(cfg, job) {
    return check(cfg, job) || (companyNames(job).length ? '' : '未核实公司名称，请打开原岗位确认后手动投递');
  }

  const api = { fields, maxSearchCount, list, identity, titleMatches, matchesSearchTitle, searchQueries, searchJobType, screeningMode, isInternship, excludesBigTech,
    validate, parseSalary, parseDistance, check, deliveryRejection, sameEmployerAndTitle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JobFilters = api;
})(globalThis);
