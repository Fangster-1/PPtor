'use strict';

/* 配置向导：服务商 → Key → 模型（测试连通）→ MinerU → 完成 */

/* ---------------------------- 服务商预设 ---------------------------- */

const PRESETS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    extraModels: ['deepseek-flash', 'deepseek-v4-pro']
  },
  zhipu: {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash', // 免费高性价比主力（128K）
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    // 智谱的 /models 接口只返回付费主力模型，不列 flash 系列（免费模型），
    // 但它们实际可用。这里补上常见的几个，省得手动填。
    extraModels: ['glm-4-flash', 'glm-4-plus', 'glm-4-long', 'glm-4.7-flash', 'glm-4.5-flash']
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    extraModels: [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b'
    ]
  },
  custom: { label: '自定义', baseUrl: '', model: '' }
};

/** MinerU Token 申请页 */
const MINERU_KEY_URL = 'https://mineru.net/apiManage/token';

/** 最近一次拉到的模型列表（换模型重试时用） */
let lastModels = [];

const PARSER_MODES = [
  { value: 'cloud', label: '云端 API' },
  { value: 'local', label: '本地 MinerU' }
];

async function saveAndReload(patch) {
  await api.saveConfig(patch);
  state.config = await api.getConfig();
  if (isMenuPanelVisible()) {
    refreshMenuPanelValues();
  }
}

/** 没配好 API Key = 不可用：翻译、问答都要先回到配置 */
function needsSetup() {
  return !(state.config && state.config.translate && state.config.translate.apiKey);
}

function guessPreset(baseUrl) {
  for (const [key, p] of Object.entries(PRESETS)) {
    if (p.baseUrl && baseUrl && p.baseUrl === baseUrl) return key;
  }
  return 'deepseek';
}

function describeOutput(o) {
  const layout = o.layout === 'faithful' ? '原排版' : '通用模板';
  const content = o.content === 'bilingual' ? '双语' : '只译文';
  const fmt = (o.formats || []).map((f) => f.toUpperCase()).join('+');
  return `${layout} / ${content} / ${fmt}`;
}

/* ------- 首次向导：只问三件事（翻译模型 / MinerU / 输出路径） ------- */

function firstGreeting() {
  // 启动问候是延迟回调，用户可能已经在这 700ms 内投喂了文件；
  // 任务开始后不允许问候气泡覆盖进度区。
  if (state.busy) return;
  if (needsSetup()) {
    setAnim('waving', { restart: true });
    showForm({
      title: '你好，我是 PPtor，你的论文翻译搭子',
      text: '把 PDF 拖到我身上就能翻译。\n要先配好 API Key 才能开工，约 1 分钟。',
      fields: [],
      submitLabel: '开始配置（1/2）',
      onSubmit: () => wizardTranslate(true),
      onCancel: () => say('配好 Key 才能用。点我一下就能继续配置。', 5000)
    });
  } else {
    setAnim('waving', { restart: true });
    say('我准备好啦。把 PDF 拖到我身上就行～', 5000);
  }
}

/** 第 1 步：翻译模型 */
function wizardTranslate(isFirstRun = false) {
  const cfg = state.config.translate || {};
  const currentProvider = cfg.provider || guessPreset(cfg.baseUrl);

  showForm({
    title: isFirstRun ? '第 1 步 / 2 · 翻译模型' : '用哪个翻译模型？',
    text: '翻译和问答都用它。',
    fields: [
      {
        key: 'preset',
        type: 'select',
        value: currentProvider,
        options: Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label }))
      }
    ],
    submitLabel: '下一步',
    onBack: isFirstRun ? () => firstGreeting() : undefined,
    onSubmit: (v) => wizardTranslateKey(v.preset, isFirstRun)
  });
}

function wizardTranslateKey(presetKey, isFirstRun = false) {
  const preset = PRESETS[presetKey] || PRESETS.custom;
  const cfg = state.config.translate || {};
  const providerKeys = cfg.providerKeys || {};
  const currentProvider = cfg.provider || guessPreset(cfg.baseUrl);
  const existingKey = providerKeys[presetKey] || (currentProvider === presetKey ? (cfg.apiKey || '') : '');

  showForm({
    title: isFirstRun ? '第 1 步 / 2 · 填 API Key' : `填 ${preset.label.replace(/（.*?）/, '')} 的 API Key`,
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        value: existingKey,
        placeholder: existingKey ? 'sk-...' : '未配置（请在此填入 Key）'
      },
      { key: 'baseUrl', label: 'API 地址', value: preset.baseUrl || cfg.baseUrl || '' }
    ],
    link: preset.keyUrl ? { label: `去 ${preset.label} 官网拿 Key`, url: preset.keyUrl } : null,
    submitLabel: '下一步：选模型',
    onBack: () => wizardTranslate(isFirstRun),
    onSubmit: async (v) => {
      const apiKey = String(v.apiKey || '').trim();
      const baseUrl = String(v.baseUrl || '').trim();

      if (!apiKey) {
        say('API Key 不能为空。', 3000);
        setTimeout(() => wizardTranslateKey(presetKey, isFirstRun), 1200);
        return;
      }

      const defaultModel = preset.model || cfg.model || '';
      await saveAndReload({
        translate: {
          apiKey,
          baseUrl,
          provider: presetKey,
          model: defaultModel,
          providerKeys: { [presetKey]: apiKey }
        }
      });
      // 首次填入 Key 后立即走与启动/刷新完全相同的主进程状态机；托盘与右键状态灯同步更新。
      void api.checkModelConnectivity().catch(() => {});
      say('正在获取这个 Key 可用的模型…');

      let r;
      try {
        r = await api.listModels({ apiKey, baseUrl });
      } catch (err) {
        r = { ok: false, message: err.message || String(err) };
      }

      if (r.ok && r.models && r.models.length) {
        wizardTranslateModel(r.models, defaultModel, presetKey, isFirstRun, r.contexts || {});
      } else {
        wizardTranslateModelManual(presetKey, isFirstRun, `${r.message || '没拿到模型列表'}，手动填一个。`);
      }
    }
  });
}

/** 拿到模型列表后，让用户自己挑 */
function wizardTranslateModel(models, preferred, presetKey, isFirstRun = false, contexts = {}) {
  lastModels = models.slice();
  const preset = PRESETS[presetKey] || PRESETS.custom;

  const isGemini = presetKey === 'gemini';
  // 接口没列出该服务商的预设模型 / 免费模型时补上，避免「明明能用却选不到」
  let list = models.slice();
  for (const m of [preset.model, ...(preset.extraModels || [])]) {
    if (m && !list.includes(m)) list.push(m);
  }
  if (isGemini) {
    const freeGemini = [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b'
    ];
    list = list.filter((m) => {
      const lower = m.toLowerCase();
      return freeGemini.includes(lower) || (lower.includes('flash') && !lower.includes('pro') && !lower.includes('exp'));
    });
    if (!list.length) {
      list = freeGemini.slice();
    }
  }

  const MODEL_FRIENDLY_LABELS = {
    'deepseek-flash': 'deepseek-flash (DeepSeek Flash · 1M)',
    'deepseek-v4-pro': 'deepseek-v4-pro (DeepSeek V4 Pro)',
    'glm-4-flash': 'glm-4-flash (智谱免费主力 · 128K)',
    'glm-4-plus': 'glm-4-plus (智谱旗舰 · 128K)',
    'glm-4-long': 'glm-4-long (长文本 · 1M)',
    'Qwen/Qwen2.5-7B-Instruct': 'Qwen/Qwen2.5-7B-Instruct (通义千问 2.5 快速轻量)'
  };

  const options = list.map((m) => {
    const ctx = contexts[m];
    const friendly = isGemini ? null : MODEL_FRIENDLY_LABELS[m];
    let label = friendly || m;
    if (!friendly && ctx && !isGemini) {
      label = `${m} (${Math.round(ctx / 1024)}K)`;
    }
    return { value: m, label };
  });
  options.push({ value: '__manual', label: '手动输入模型名…' });
  const def = list.includes(preferred) ? preferred : list[0];

  showForm({
    title: isFirstRun ? '第 1 步 / 2 · 选模型' : '用哪个模型？',
    text: `${models.length} 个可用模型，选择或手动输入模型名字`,
    fields: [{ key: 'model', type: 'select', value: def, options }],
    submitLabel: '测试并保存',
    onBack: () => wizardTranslateKey(presetKey, isFirstRun),
    onSubmit: (v) => {
      if (v.model === '__manual') {
        wizardTranslateModelManual(presetKey, isFirstRun);
        return;
      }
      const detectedContext = contexts[v.model] || 0;
      finishTranslateSetup(v.model, presetKey, isFirstRun, detectedContext);
    },
    // 没配好 Key 不允许跳过：取消就回到向导起点
    onCancel: () => {
      if (needsSetup()) wizardTranslate(isFirstRun);
      else if (isFirstRun) wizardParser(true);
    }
  });
}

/** 服务商没返回列表时的兜底：手填模型名 */
function wizardTranslateModelManual(presetKey, isFirstRun = false, hint = '') {
  const preset = PRESETS[presetKey] || PRESETS.custom;
  const cfg = state.config.translate || {};

  showForm({
    title: isFirstRun ? '第 1 步 / 2 · 填模型名' : '填模型名',
    text: hint || '手动填一个模型名。',
    fields: [
      { key: 'model', label: '模型名', value: preset.model || cfg.model || '', placeholder: preset.model || 'gemini-2.0-flash' }
    ],
    submitLabel: '测试并保存',
    onBack: () => wizardTranslateKey(presetKey, isFirstRun),
    onSubmit: (v) => finishTranslateSetup(v.model, presetKey, isFirstRun),
    // 同上：没配好 Key，取消 = 回到向导起点
    onCancel: () => {
      if (needsSetup()) wizardTranslate(isFirstRun);
      else if (isFirstRun) wizardParser(true);
    }
  });
}

/** 用选定模型测一次连通，成功才写入配置 */
async function finishTranslateSetup(model, presetKey, isFirstRun, contextWindow = 0) {
  const cfg = state.config.translate || {};
  say('正在测试连接…');

  let r;
  try {
    r = await api.testApi({ ...cfg, model });
  } catch (err) {
    r = { ok: false, message: err.message || String(err) };
  }

  if (!r.ok) {
    try {
      await api.setConnectivityStatus({ model: 'error', reason: r.message });
    } catch {
      /* 忽略 IPC 错误 */
    }
    setConnectivityUI('model', 'error', `模型连接失败：${r.message}`);
    refreshMenuPanelValues();
    setAnim('failed', { restart: true });
    say(`连接失败：${r.message}\n换个模型试试。`, 4500);
    setTimeout(() => {
      if (lastModels.length) wizardTranslateModel(lastModels, model, presetKey, isFirstRun);
      else wizardTranslateModelManual(presetKey, isFirstRun, '再换一个模型名试试。');
    }, 1600);
    return;
  }

  const patch = { model, provider: presetKey };
  if (contextWindow > 0) patch.contextWindow = contextWindow;
  await saveAndReload({ translate: patch });
  try {
    await api.setConnectivityStatus({ model: 'ok', sample: r.sample });
  } catch {
    /* 忽略 IPC 错误 */
  }
  setConnectivityUI('model', 'ok', `模型连接正常：${model}`);
  refreshMenuPanelValues();

  if (isFirstRun) {
    setAnim('jumping', { restart: true });
    setTimeout(() => wizardParser(true), 600);
  } else {
    setAnim('jumping', { restart: true });

    // 之前被「没配 Key」拦下的文件，配好就自动接着翻
    const pending = state.pendingFiles;
    state.pendingFiles = null;

    if (pending && pending.length) {
      say(`连上了：${model}\n接着翻刚才那 ${pending.length} 篇。`, 2500);
      setTimeout(() => handleFiles(pending), 1200);
    } else {
      say(`连上了：${model}\n示例译文：${r.sample}`, 6000);
    }
  }
}

/** 第 2 步：MinerU 解析 */
function wizardParser(isFirstRun = false) {
  const cfg = state.config.parser || {};
  const local = state.env && state.env.mineru;
  const localOk = !!(local && local.found);

  showForm({
    title: isFirstRun ? '第 2 步 / 2 · PDF 解析' : 'PDF 用哪种方式解析？',
    text:
      (localOk ? `本机已检测到 ${local.cmd}（${local.version}）。\n` : '') +
      '云端 API 需要 MinerU Token（mineru.net 免费申请），图、表、公式都更准。',
    fields: [
      { key: 'mode', type: 'select', value: cfg.mode || 'cloud', options: PARSER_MODES },
      {
        key: 'mineruToken',
        label: 'MinerU Token',
        type: 'password',
        value: cfg.mineruToken || '',
        placeholder: ' mineru.net 申请'
      }
    ],
    link: { label: '去 mineru.net 拿 Token', url: MINERU_KEY_URL },
    submitLabel: isFirstRun ? '完成配置' : '保存',
    onSubmit: async (v) => {
      await saveAndReload({ parser: v });

      // 配置保存后立即测试，成功/失败都弹提示
      say('正在测试 MinerU 连接…', 3000);
      let r;
      try {
        r = await api.checkParserConnectivity();
      } catch (err) {
        r = { ok: false, reason: (err && err.message) || String(err) };
      }
      if (r && r.ok) {
        setAnim('jumping', { restart: true });
        say(v.mode === 'local' ? '本地 MinerU 可用～' : 'MinerU 连接成功～', 5000);
      } else {
        setAnim('failed', { restart: true });
        say(`MinerU 连接失败：${(r && r.reason) || '网络异常'}`, 6000);
      }

      if (isFirstRun) {
        setTimeout(() => finishOnboarding(), 800);
      }
    },
    onBack: isFirstRun ? () => wizardTranslate(true) : undefined,
    onCancel: isFirstRun ? () => finishOnboarding() : undefined
  });
}

/**
 * 首次配置收尾。
 *
 * 输出路径不再询问：产物统一归档到「软件目录下的 translated」，
 * 排版 / 内容 / 格式用默认值，之后随时可在右键菜单里改。
 */
async function finishOnboarding() {
  await saveAndReload({ onboardingDone: true });
  setAnim('jumping', { restart: true });
  state.onboardingNotice = true;
  renderBubble({
    texts: ['配置完成，可以开始翻译。直接将论文拖到桌宠上即可。']
  });

  // 首次配置前拖入的论文不再停在“配置完成”页面，配置结束后立即开始翻译。
  const pending = state.pendingFiles;
  state.pendingFiles = null;
  if (pending && pending.length) setTimeout(() => handleFiles(pending), 0);
}

function dismissOnboardingNotice() {
  if (!state.onboardingNotice) return;
  state.onboardingNotice = false;
  hideBubble();
  setAnim('idle');
}

async function pickFilesToTranslate() {
  const files = await api.pickPdf({ multi: true });
  const list = Array.isArray(files) ? files : files ? [files] : [];
  if (list.length) handleFiles(list);
}
