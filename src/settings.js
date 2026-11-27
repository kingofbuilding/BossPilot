(function (root) {
  const formFields = ['dsKey', 'resumeText', 'greetingMode', 'fixedGreeting', 'dialogAction',
    'keyword', 'city', 'count', 'paceMode', ...JobFilters.fields];
  const storageFields = [...formFields, 'filterVersion', 'jobRequirements', 'sendResumeImage', 'resumeImage'];
  const filterVersion = 3;

  function searchCount(cfg) {
    const count = Number(cfg.count ?? 40);
    return Number.isInteger(count) && count >= 1 && count <= JobFilters.maxSearchCount ? count : null;
  }

  function paceMode(cfg) {
    return ['fast', 'normal', 'safe'].includes(cfg?.paceMode) ? cfg.paceMode : 'normal';
  }

  function sendsImage(cfg) {
    return cfg.sendResumeImage === undefined ? !!cfg.resumeImage : cfg.sendResumeImage === true;
  }

  function greetingError(cfg) {
    if (cfg.greetingMode === 'fixed') {
      return cfg.fixedGreeting?.trim() ? null : ['fixedGreeting', '请先填写固定招呼语'];
    }
    if (!cfg.dsKey?.trim()) return ['dsKey', 'AI 招呼语需要 API Key，也可改用固定招呼语。'];
    if (!cfg.resumeText?.trim()) return ['resumeText', 'AI 招呼语需要简历文字，也可改用固定招呼语。'];
    return null;
  }

  function constraints(cfg) {
    const filters = Object.fromEntries(JobFilters.fields.map(field => [field, cfg[field]]));
    return {
      ...filters,
      keyword: cfg.keyword,
      city: cfg.city,
      screeningMode: JobFilters.screeningMode(cfg),
      excludeBigTech: JobFilters.excludesBigTech(cfg),
      filterVersion
    };
  }

  function dialogAction(cfg) {
    return cfg?.dialogAction === 'continue' ? 'continue' : 'stay';
  }

  root.JobCopilotSettings = Object.freeze({ formFields, storageFields, filterVersion, searchCount,
    paceMode, dialogAction, sendsImage, greetingError, constraints });
})(globalThis);
