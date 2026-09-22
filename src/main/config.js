'use strict';

/**
 * 配置存储
 *
 * 位置：<软件根目录>/config/settings.json
 * 原则：所有可调参数都有合理默认值 —— 用户不填任何东西，也能靠
 *       MinerU 云端解析 + 模型 API 跑通一次完整翻译。
 */
const fs = require('node:fs');
const { safeStorage } = require('electron');

const { configFile } = require('./paths');
const { writeJsonAtomicSync } = require('./core/fsx');

let cache = null;

const DEFAULTS = {
  /* 桌宠外观与行为 */
  pet: {
    scale: 1, // 缩放由桌宠上的 Ctrl+滚轮调整
    x: null, // 窗口坐标，null = 首次启动时贴屏幕右下角
    y: null,
    hidden: false,
    alwaysOnTop: true // 全屏游戏/演示时可关闭，避免打扰
  },

  /* PDF 解析 */
  parser: {
    // local       = 本机已安装的 mineru / magic-pdf 命令行（离线、免费、体积大）
      // cloud       = MinerU 官方 API（需 token，稳定、额度可控）
    mode: 'cloud',
    mineruToken: '',
    modelVersion: 'vlm',
    isOcr: false,
    language: 'ch'
  },

  /* 翻译模型（任意 OpenAI 兼容服务） */
  translate: {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-flash',
    providerKeys: {
      deepseek: '',
      zhipu: '',
      gemini: '',
      custom: ''
    },
    // 翻译是保真任务，低随机度可减少跑偏后的质量重试。
    temperature: 0.2,
    concurrency: 3,
    maxRetries: 3,
    chunkTokens: 1200,
    sourceLang: 'en',
    targetLang: 'zh', // 固定简体中文，界面上不再提供切换（见 initStore 的归一化）
    // 翻译不需要长推理；DeepSeek 默认开启思考，显式关闭以减少耗时与 token。
    thinking: 'off',
    glossary: '', // 术语表配置（每行 English=中文）
    contextWindow: 0 // 上下文窗口上限 Token 数，0 为根据模型自动推断
  },

  /* 输出（默认：通用排版 / 只保留译文 / pdf） */
  output: {
    /* 翻译文档库：所有产物都归档到这里，相当于「备份」
       空 = <软件根目录>/translated
       每个任务一个以「中文标题」命名的子目录 */
    libraryDir: '',

    layout: 'generic', // faithful = 严格按原始论文排版；generic = 通用排版
    content: 'mono', // mono = 只留译文；bilingual = 双语对照
    formats: ['pdf'], // pdf | docx | md | html，可多选
    renderMath: true, // PDF/HTML 中用 KaTeX 渲染公式
    allowExternalImages: false // 保持导出完全离线、自包含
  },

  /* 首次配置向导是否已完成 */
  onboardingDone: false,

  /* 最近一次翻译的文件路径列表 */
  lastFiles: []
};

/* ---------------------------- 深合并 ---------------------------- */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(patch)) return patch === undefined ? out : patch;

  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function normalizeFormats(formats) {
  const aliases = { markdown: 'md', word: 'docx', doc: 'docx' };
  const allowed = new Set(['pdf', 'docx', 'md', 'html']);
  const out = [];
  for (const raw of Array.isArray(formats) ? formats : ['pdf']) {
    const value = aliases[String(raw || '').toLowerCase()] || String(raw || '').toLowerCase();
    if (allowed.has(value) && !out.includes(value)) out.push(value);
  }
  return out.length ? out : ['pdf'];
}

/* ---------------------------- 凭据加密 ---------------------------- */
/*
 * API Key 不再明文落盘：用 Electron safeStorage（Windows 走 DPAPI，绑定当前用户）。
 * 磁盘上存 translate.apiKeyEnc（base64），内存里始终是明文 apiKey（getConfig 的
 * 行为不变，渲染层测试连通 / 拉模型列表照常工作）。
 * 加密不可用时回退明文（旧版本行为），启动时打一条警告。
 */

let lastPlaintextFallback = false;
function wasPlaintextFallback() {
  return lastPlaintextFallback;
}
function clearPlaintextFallback() {
  lastPlaintextFallback = false;
}

function encryptKey(plain) {
  if (!plain) return null;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      lastPlaintextFallback = false;
      return safeStorage.encryptString(plain).toString('base64');
    }
    lastPlaintextFallback = true;
    console.warn('[config] safeStorage 不可用，API Key 将明文保存（已标记，需提示用户）');
  } catch (err) {
    lastPlaintextFallback = true;
    console.warn('[config] 加密失败，API Key 将明文保存：', err.message);
  }
  return null;
}

function decryptKey(enc) {
  if (!enc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return ''; // 换机器 / 换系统后 DPAPI 解不开 → 视为未配置，用户重填即可
  }
}

/* ---------------------------- 读写 ---------------------------- */

function inferProvider(baseUrl) {
  const url = String(baseUrl || '').toLowerCase();
  if (url.includes('deepseek.com')) return 'deepseek';
  if (url.includes('bigmodel.cn')) return 'zhipu';
  if (url.includes('googleapis.com') || url.includes('google.com')) return 'gemini';
  return 'custom';
}

// 硅基流动不再作为内置服务商。旧用户仍可通过“自定义接口”继续使用原地址、模型和 Key。
function migrateRemovedProvider(translate) {
  if (!translate || typeof translate !== 'object') return false;
  const keys = translate.providerKeys && typeof translate.providerKeys === 'object'
    ? translate.providerKeys
    : (translate.providerKeys = {});
  const wasCurrent = translate.provider === 'siliconflow';
  const hadLegacyKey = Object.prototype.hasOwnProperty.call(keys, 'siliconflow');
  if (wasCurrent) {
    const legacyKey = keys.siliconflow || translate.apiKey || '';
    if (legacyKey) keys.custom = legacyKey;
    translate.provider = 'custom';
  }
  if (hadLegacyKey) delete keys.siliconflow;
  return wasCurrent || hadLegacyKey;
}

function initStore() {
  const file = configFile();
  let shouldPersist = false;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

    // 旧版本明文凭据或加密块 → 内存中统一为明文
    const hadApiKeyEnc = !!raw.translate?.apiKeyEnc;
    const hadTokenEnc = !!raw.parser?.mineruTokenEnc;

    if (!raw.translate) raw.translate = {};
    if (!raw.translate.providerKeys || typeof raw.translate.providerKeys !== 'object') {
      raw.translate.providerKeys = {};
    }

    // 解密多模型 providerKeysEnc
    if (raw.translate.providerKeysEnc && typeof raw.translate.providerKeysEnc === 'object') {
      for (const [prov, enc] of Object.entries(raw.translate.providerKeysEnc)) {
        if (enc) {
          raw.translate.providerKeys[prov] = decryptKey(enc);
        }
      }
      delete raw.translate.providerKeysEnc;
    }

    if (raw.translate.apiKeyEnc) {
      const decrypted = decryptKey(raw.translate.apiKeyEnc);
      raw.translate.apiKey = decrypted;
      delete raw.translate.apiKeyEnc;
    }
    if (raw.parser && raw.parser.mineruTokenEnc) {
      raw.parser.mineruToken = decryptKey(raw.parser.mineruTokenEnc);
      delete raw.parser.mineruTokenEnc;
    }

    if (migrateRemovedProvider(raw.translate)) shouldPersist = true;

    // 存量兼容迁移：如果 providerKeys 对应槽位为空，且当前 apiKey 存在，则归档到对应 provider
    const inferred = inferProvider(raw.translate.baseUrl);
    const prov = raw.translate.provider || inferred;
    raw.translate.provider = prov;
    if (raw.translate.apiKey && !raw.translate.providerKeys[inferred]) {
      raw.translate.providerKeys[inferred] = raw.translate.apiKey;
    }
    raw.translate.apiKey = raw.translate.providerKeys[prov] || '';

    // 旧版本明文凭据只在确有内容时触发一次迁移写盘。
    shouldPersist ||= (!!raw.translate?.apiKey && !hadApiKeyEnc) || (!!raw.parser?.mineruToken && !hadTokenEnc);
    cache = deepMerge(DEFAULTS, raw);
  } catch {
    cache = deepMerge(DEFAULTS, {});
  }
  // 已移除的免登录通道无法出图，老配置一律归一到云端 API
  if (cache.parser && cache.parser.mode !== 'local') {
    if (cache.parser.mode !== 'cloud') shouldPersist = true;
    cache.parser.mode = 'cloud';
  }
  // 目标语言固定为简体中文：菜单已移除该设置，老配置里选过别的语言也拉回来
  if (!cache.translate) cache.translate = {};
  if (cache.translate.targetLang !== 'zh') shouldPersist = true;
  cache.translate.targetLang = 'zh';
  // DeepSeek 旧模型名会让实际翻译测试误报连接失败；统一展示并保存为当前 Flash 名称。
  if (inferProvider(cache.translate.baseUrl) === 'deepseek' &&
      ['deepseek-chat', 'deepseek-reasoner'].includes(cache.translate.model)) {
    cache.translate.model = 'deepseek-flash';
    shouldPersist = true;
  }
  // 输出内容支持 mono（只留译文）与 bilingual（双语对照），异常值回退为 mono
  if (!cache.output || typeof cache.output !== 'object') cache.output = {};
  if (cache.output.content !== 'mono' && cache.output.content !== 'bilingual') {
    cache.output.content = 'mono';
    shouldPersist = true;
  }
  if (!Array.isArray(cache.output.formats) || !cache.output.formats.length) {
    cache.output.formats = ['pdf'];
    shouldPersist = true;
  }
  const normalizedFormats = normalizeFormats(cache.output.formats);
  if (JSON.stringify(normalizedFormats) !== JSON.stringify(cache.output.formats)) shouldPersist = true;
  cache.output.formats = normalizedFormats;
  // 存量迁移：旧默认 temperature=1.3 会放大术语漂移，统一钳制回 0.2。
  if (cache.translate && Math.abs(Number(cache.translate.temperature) - 1.3) < 1e-9) {
    cache.translate.temperature = 0.2;
    shouldPersist = true;
  }
  // 只有凭据迁移或旧配置归一化时写盘；普通启动不再同步改写 settings.json。
  if (shouldPersist) persist();
  return cache;
}

function persist() {
  try {
    const t = { ...((cache && cache.translate) || {}) };
    const p = { ...((cache && cache.parser) || {}) };

    const apiKeyEnc = encryptKey(t.apiKey);
    if (apiKeyEnc != null) {
      t.apiKey = '';
      t.apiKeyEnc = apiKeyEnc;
    } else {
      delete t.apiKeyEnc;
    }

    // 加密各服务商各自的独立 Key
    if (t.providerKeys && typeof t.providerKeys === 'object') {
      const pKeysEnc = {};
      for (const [prov, keyVal] of Object.entries(t.providerKeys)) {
        if (keyVal) {
          const enc = encryptKey(keyVal);
          if (enc) pKeysEnc[prov] = enc;
        }
      }
      t.providerKeysEnc = pKeysEnc;
      // 磁盘上不保留明文对象
      t.providerKeys = {};
    }

    const tokenEnc = encryptKey(p.mineruToken);
    if (tokenEnc != null) {
      p.mineruToken = '';
      p.mineruTokenEnc = tokenEnc;
    } else {
      delete p.mineruTokenEnc;
    }

    writeJsonAtomicSync(configFile(), { ...cache, translate: t, parser: p });
  } catch (err) {
    console.warn('[config] 保存失败：', err.message);
  }
}

function cloneConfig(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function getConfig() {
  if (!cache) cache = deepMerge(DEFAULTS, {});
  // 返回深拷贝：防止业务代码持有单例引用并绕过 saveConfig 直接变异。
  return cloneConfig(cache);
}

function getConfigRef() {
  // 仅供内部只读快照需要引用语义时使用，外部请用 getConfig()。
  if (!cache) cache = deepMerge(DEFAULTS, {});
  return cache;
}

const CONFIG_SCHEMA = new Set([
  'pet', 'parser', 'translate', 'output', 'onboardingDone', 'lastFiles'
]);

function sanitizePatch(patch) {
  if (!patch || typeof patch !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (CONFIG_SCHEMA.has(k)) out[k] = v;
    else console.warn(`[config] 忽略未知配置键：${k}`);
  }
  return out;
}

function clampTranslate(cfg) {
  if (!cfg.translate) return;
  // 存量迁移：旧默认 1.3 与越界值一律钳制回保真默认值 0.2。
  const t = Number(cfg.translate.temperature);
  if (!Number.isFinite(t) || t < 0 || t > 1.5) cfg.translate.temperature = 0.2;
  else if (Math.abs(t - 1.3) < 1e-9) cfg.translate.temperature = 0.2;
}

function saveConfig(patch) {
  const clean = sanitizePatch(patch);
  cache = deepMerge(getConfigRef(), clean);
  clampTranslate(cache);

  // 保证 providerKeys 槽位完整同步
  if (patch.translate && patch.translate.providerKeys) {
    cache.translate.providerKeys = {
      ...(cache.translate.providerKeys || {}),
      ...patch.translate.providerKeys
    };
  }
  if (cache.translate) {
    migrateRemovedProvider(cache.translate);
    if (inferProvider(cache.translate.baseUrl) === 'deepseek' &&
        ['deepseek-chat', 'deepseek-reasoner'].includes(cache.translate.model)) {
      cache.translate.model = 'deepseek-flash';
    }
    const curProv = cache.translate.provider || inferProvider(cache.translate.baseUrl);
    cache.translate.provider = curProv;
    if (patch.translate && patch.translate.apiKey !== undefined) {
      if (!cache.translate.providerKeys) cache.translate.providerKeys = {};
      cache.translate.providerKeys[curProv] = patch.translate.apiKey;
    } else if (cache.translate.providerKeys && cache.translate.providerKeys[curProv] !== undefined) {
      cache.translate.apiKey = cache.translate.providerKeys[curProv] || '';
    }
  }

  if (!cache.output || typeof cache.output !== 'object') cache.output = {};
  if (cache.output.content !== 'bilingual' && cache.output.content !== 'mono') {
    cache.output.content = 'mono';
  }
  cache.output.formats = normalizeFormats(cache.output.formats);
  persist();
  return getConfig();
}

module.exports = { initStore, getConfig, getConfigRef, saveConfig, deepMerge, DEFAULTS, configFile, normalizeFormats, wasPlaintextFallback, clearPlaintextFallback };
