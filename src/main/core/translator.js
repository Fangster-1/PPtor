'use strict';

/**
 * 大模型翻译引擎
 *
 * 对接「OpenAI 兼容」接口（预设 DeepSeek / 智谱 GLM，或自定义地址），
 * 只需改 baseUrl + apiKey + model 三处。
 *
 * 工程要点：
 *  - 并发池：默认 3 路并发，兼顾速度与限流
 *  - 指数退避重试：网络抖动、429 自动恢复
 *  - 结果缓存：按「模型 + 语言 + 原文」哈希缓存，重复翻译同一段不再花钱
 *  - 提示词强约束：公式、代码、图片、引用标记一律原样保留
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { writeJsonAtomic } = require('./fsx');
const { withDeadline, addCancelHandler, sleep } = require('./async');
const { CancelledError, isCancelled } = require('./errors');
const { chatCompletion } = require('./llm-client');
const {
  checkContextBudget,
  getModelContextLimit,
  recordLearnedContextLimit,
  extractContextLimitFromModelObj,
  extractContextLimitFromError
} = require('./context');

const PROMPT_VERSION = 'v9-glossary-aware';
const DEFAULT_TEMPERATURE = 0.2;
// 一段 1200 token 左右的学术文本在正常网络下不应等待数分钟。旧的 180 秒
// 超时会让 3 路并发一起“看似卡死”；超时后仍按既有策略重试。
const REQUEST_TIMEOUT_MS = 90000;
const MAX_CACHE_ENTRIES = 30000;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_VALUE_CHARS = 400000;
// 缓存只是优化，绝不能让损坏的磁盘、网盘或安全软件扫描阻塞整篇翻译。
const CACHE_LOAD_TIMEOUT_MS = 15000;

const LANG_NAME = {
  en: '英语',
  zh: '简体中文',
  'zh-tw': '繁体中文',
  ja: '日语',
  ko: '韩语',
  de: '德语',
  fr: '法语',
  ru: '俄语',
  es: '西班牙语'
};

/** 连接测试与正式翻译共用的服务商模型别名归一化。 */
function resolveModelAlias(baseUrl, model) {
  const m = String(model || '').trim();
  // DeepSeek 的旧 chat/reasoner 别名已下线；不能把当前 Flash 反向改回旧名。
  if (/deepseek\.com/i.test(baseUrl || '') && ['deepseek-chat', 'deepseek-reasoner'].includes(m)) return 'deepseek-flash';
  if (/googleapis\.com|google\.com/i.test(baseUrl || '')) {
    const lower = m.toLowerCase();
    if (lower === 'gemini-2.5-pro' || lower === 'gemini-2.0-pro' || lower === 'gemini-pro') return 'gemini-2.0-flash';
    if (lower === 'gemini-2.5-flash' || lower === 'gemini-flash') return 'gemini-2.0-flash';
  }
  return m;
}

/**
 * 翻译系统提示词
 */
const SYSTEM_PROMPT = `你是一位学术论文翻译专家，精通各学科专业术语。你的任务是把学术论文的 Markdown 片段忠实翻译成目标语言。

【翻译原则】
所有信息必须来自原文，不得添加解释、总结或评论，不得删减原文内容或改写论述结构。

【表格】
- 表格以 HTML（<table>）或 Markdown（| |）形式出现时：完整保留表格结构，只翻译表头与单元格中的自然语言文本
- 单元格中的数值、单位、符号、统计标记（如 ***、p<0.01）一字不改，不得四舍五入或换算单位
- 严禁增加、删除、合并行列；不得把非表格内容改写成表格

【公式】
- 行内公式 $...$ 与块级公式 $$...$$ 内部字符保持原样，包括 LaTeX 命令、变量名、上下标
- 公式编号 (1) (2) 等原样保留在公式行末
- 公式上下文中的变量说明照常翻译，变量名本身保持原样

【图片与引用】
- 图片语法 ![](...) 原样保留，路径保持不变
- 文献引用保留原文形式：[1]、[12,13]、(Author et al., 2021) 等原样保留
- 保留 et al. 格式，严禁将 et al. 汉化为“等人”，年份后严禁加“年”（如规范写作 (Author et al., 2021)，不要写成 (Author 等人, 2021年)）
- 参考文献章节（References / Bibliography / 参考文献）条目不翻译，整段原样返回
- DOI、URL、ISBN 原样保留

【专有名词与缩写】
- 专业术语使用学科通行译名；首次出现时写作「中文译名（English Term）」，之后使用中文
- 缩写、指标名、模型名、数据集名、方法名保留英文原样，严禁凭字面猜测缩写含义或强行汉化
- 未知缩写一律保持原样，不得臆测含义
- 避免中英混合半汉化（不得把专有名词或方法名生硬拆分或中英杂糅拼接）
- 机构名、地名、人名按通行译法；无通行译法时保留原文

【Markdown 结构】
- 完整保留：标题层级（#）、列表符号、引用（>）、加粗斜体、链接语法、HTML 标签、段落空行
- 代码块（围栏内全部内容）原样保留，不翻译

【输出格式】
- 只输出译文本身，不要前言、解释、总结或代码围栏包裹
- 保持学术语体：准确、简洁、客观
- 整段译完，不遗漏未翻译文本（专有名词与缩写除外）
- 若片段不含任何可翻译的自然语言（只有公式、图片或符号），原样返回`;

/**
 * 组装 system prompt：基础提示词 +（可选）用户术语表
 * 术语表格式：每行一条 `English=中文译名`
 */
function buildSystemPrompt(glossary) {
  const text = String(glossary || '').trim();
  if (!text) return SYSTEM_PROMPT;
  return (
    SYSTEM_PROMPT +
    `\n\n【术语表（最高优先级，逐条遵守）】
下列术语必须使用表中给出的中文译名，一个字都不能改，也不要换成你认为更常见的别的叫法。
表中若给出缩写与中文全称，输出形如「中文全称（ABBR）」；只给缩写的，原样保留缩写。
**这张表本身不是待翻译内容，严禁把它或其任何部分写进译文。**
${text}`
  );
}

/* ================================================================== *
 * 缓存
 * ================================================================== */

let cachePath = null;
let cacheMap = null;
let cacheDirty = false;
let cacheReady = Promise.resolve();
let cacheBytes = 0;

function cacheEntryBytes(key, value) {
  return Buffer.byteLength(String(key)) + Buffer.byteLength(String(value)) + 8;
}

/**
 * 初始化翻译缓存（异步：缓存文件可能达数 MB，同步读会卡主进程启动）
 * @param {string} dir 缓存目录（由调用方决定，避免 core 层依赖 Electron）
 */
async function initCache(dir) {
  if (!dir) {
    cacheReady = Promise.resolve();
    return cacheReady;
  }
  cachePath = path.join(dir, 'translate-cache.json');
  cacheMap = new Map();
  cacheDirty = false;
  cacheBytes = 0;
  cacheReady = (async () => {
    try {
      const raw = await withDeadline(async () => {
        const stat = await fs.promises.stat(cachePath);
        if (stat.size > MAX_CACHE_BYTES) return { tooLarge: stat.size };
        return fs.promises.readFile(cachePath, 'utf8');
      }, {
        timeoutMs: CACHE_LOAD_TIMEOUT_MS,
        label: '读取翻译缓存'
      });
      if (raw && typeof raw === 'object' && raw.tooLarge) {
        console.warn(`[cache] 缓存文件过大（${Math.round(raw.tooLarge / 1048576)} MB），本次按空缓存启动`);
        return;
      }
      const parsed = JSON.parse(raw);
      const pairs = Object.entries(parsed && typeof parsed === 'object' ? parsed : {}).filter(
        ([, value]) => typeof value === 'string' && value.length <= MAX_CACHE_VALUE_CHARS
      );
      // JSON 对象保持写入顺序；只取最新的一段，避免旧版本无限膨胀占用内存。
      cacheMap = new Map(pairs.slice(-MAX_CACHE_ENTRIES));
      cacheBytes = [...cacheMap].reduce((sum, [key, value]) => sum + cacheEntryBytes(key, value), 0);
      // 文件大小检查不能替代解码后的实际占用检查：JSON 转义和对象开销
      // 可能令内存中的 UTF-8 估算值略高于磁盘大小。沿用文件顺序作为
      // LRU 顺序，从最旧项开始淘汰，保证 load 与 set 服从同一上限。
      while (cacheMap.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
        const key = cacheMap.keys().next().value;
        if (key === undefined) break;
        cacheBytes -= cacheEntryBytes(key, cacheMap.get(key));
        cacheMap.delete(key);
      }
    } catch (err) {
      /* 首次运行或文件损坏（原子写后基本不会发生）→ 空缓存 */
      if (err?.message?.includes('超时')) console.warn(`[cache] ${err.message}，本次按空缓存启动`);
    }
  })();
  await cacheReady;
  return cacheReady;
}

function glossaryHash(cfg) {
  try {
    const normalized = resolveGlossary(cfg) || '';
    return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
  } catch {
    return 'nogloss';
  }
}

function cacheKey(cfg, content, previousContext = '') {
  // 缓存必须感知会影响译文的一切维度：术语表、temperature、thinking、baseUrl。
  // 否则换词表/换参数后会静默命中旧译文。
  const gloss = glossaryHash(cfg);
  const temp = Number.isFinite(Number(cfg && cfg.temperature)) ? String(cfg.temperature) : String(DEFAULT_TEMPERATURE);
  const thinking = String((cfg && cfg.thinking) || 'auto');
  const host = String((cfg && cfg.baseUrl) || '').toLowerCase().replace(/\/+$/, '');
  const contextHash = crypto.createHash('sha1').update(String(previousContext || '')).digest('hex').slice(0, 16);
  return crypto
    .createHash('sha1')
    .update(`${PROMPT_VERSION}|${cfg.model}|${cfg.sourceLang}->${cfg.targetLang}|t=${temp}|th=${thinking}|h=${host}|g=${gloss}|ctx=${contextHash}|${content}`)
    .digest('hex');
}

function cacheGet(key) {
  if (!cacheMap) return null;
  const hit = cacheMap.get(key);
  if (hit === undefined) return null;
  // LRU：命中后重插到「最新」端，超限淘汰的是最久未命中的而非最早写入的
  cacheMap.delete(key);
  cacheMap.set(key, hit);
  return hit;
}

function cacheSet(key, value) {
  if (!cacheMap) return;
  if (typeof value !== 'string' || value.length > MAX_CACHE_VALUE_CHARS) return;
  const previous = cacheMap.get(key);
  if (previous !== undefined) cacheBytes -= cacheEntryBytes(key, previous);
  cacheMap.set(key, value);
  cacheBytes += cacheEntryBytes(key, value);
  cacheDirty = true;
  // 同时限制条数和 UTF-8 实际占用，防止小值条数上限被大段译文撑爆内存。
  while (cacheMap.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    // 淘汰最旧（Map 迭代序 = 插入序；配合 cacheGet 的重插，即 LRU）
    const k = cacheMap.keys().next().value;
    if (k === undefined) break;
    const old = cacheMap.get(k);
    cacheBytes -= cacheEntryBytes(k, old);
      cacheMap.delete(k);
  }
}

function cacheStats() {
  return { entries: cacheMap ? cacheMap.size : 0, bytes: cacheBytes, maxEntries: MAX_CACHE_ENTRIES, maxBytes: MAX_CACHE_BYTES };
}

async function flushCache() {
  await cacheReady;
  if (!cacheDirty || !cachePath) return;
  cacheDirty = false; // 先清标记：写盘期间若又有 cacheSet 会重新置位，下次 flush 不丢
  try {
    await writeJsonAtomic(cachePath, Object.fromEntries(cacheMap));
  } catch (err) {
    cacheDirty = true;
    console.warn('[cache] 写入失败：', err.message);
  }
}

/* ================================================================== *
 * 术语表
 * ================================================================== */

let glossaryFile = '';
let glossaryReady = Promise.resolve();

/**
 * 加载可选的术语表文件（若文件存在则加载，不自动创建模板）
 * @param {string} filePath 术语表文件路径
 */
function initGlossary(filePath) {
  glossaryFile = '';
  if (!filePath) {
    glossaryReady = Promise.resolve();
    return glossaryReady;
  }
  glossaryReady = (async () => {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      glossaryFile = cleanGlossary(await fs.promises.readFile(filePath, 'utf8'));
    } catch {
      glossaryFile = '';
    }
  })();
  return glossaryReady;
}

/** 只保留有效行（英文=中文），去掉注释与空行——注释曾被模型抄进译文 */
function cleanGlossary(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .join('\n');
}

/**
 * 规范化并确定性排序术语表：
 * 1. 拆分键值（英文=中文）并清除前后空白
 * 2. 去重（配置项覆盖文件项）
 * 3. 按 key 严格字母序升序排序
 * 4. 保证 System Prompt 字节流 100% 确定，极大提升大模型服务端 Prefix Cache 命中率
 */
function resolveGlossary(cfg) {
  const map = new Map();
  const parseLines = (text) => {
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = line.slice(0, eqIdx).trim();
      const val = line.slice(eqIdx + 1).trim();
      if (key && val) {
        map.set(key, val);
      }
    }
  };

  parseLines(glossaryFile);
  parseLines(cfg && cfg.glossary);

  if (!map.size) return '';
  const sortedKeys = Array.from(map.keys()).sort((a, b) => a.localeCompare(b));
  return sortedKeys.map((k) => `${k}=${map.get(k)}`).join('\n');
}

/* ================================================================== *
 * 单次请求
 * ================================================================== */

function buildUserPrompt(content, cfg) {
  const from = LANG_NAME[cfg.sourceLang] || cfg.sourceLang || '原文语言';
  const to = LANG_NAME[cfg.targetLang] || cfg.targetLang || '中文';
  return `把下面的 Markdown 从${from}翻译成${to}。只输出译文本身，不要复述这句话。\n\n${content}`;
}

/**
 * 翻译接口只接收字符串消息。即便用户选择的是视觉模型，也绝不把 PDF、图片 URL
 * 或 data URI 作为 image/file content part 发送。解析器若混入 Markdown/HTML 的
 * 内嵌图片，先用短占位符保护，避免 base64 被当作文本 token 计费，再逐个还原。
 */
function protectNonTextPayloads(content) {
  const saved = [];
  let serial = 0;
  const hold = (value) => {
    const token = `[[PPTOR_IMAGE_${String(++serial).padStart(4, '0')}]]`;
    saved.push({ token, value });
    return token;
  };

  let text = String(content || '');
  // 图片本身没有自然语言翻译价值，完整保护也能避免模型改写路径。
  text = text.replace(/<img\b[^>]*>/gi, hold);
  text = text.replace(/!\[[^\]\r\n]*\]\((?:<[^>\r\n]*>|[^)\r\n])*\)/g, hold);
  // 引用式图片或表格残留的 data URI 仍可能存在，至少剔除高成本二进制正文。
  text = text.replace(/data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,[a-z0-9+/=_-]+/gi, hold);

  return {
    text,
    restore(output) {
      let result = String(output || '');
      for (const item of saved) {
        if (!result.includes(item.token)) {
          throw new Error('模型未保留图片占位符，已停止写入不完整译文');
        }
        result = result.split(item.token).join(item.value);
      }
      return result;
    }
  };
}

/**
 * 相邻段落上下文只用于消解指代。先将图片语法缩为短占位符，避免 Base64
 * 在“上下文”这条路径里绕过正文的非文本保护。
 */
function previousContextTail(content) {
  return protectNonTextPayloads(String(content || '')).text.trim().slice(-300);
}

/** 为译文设置上限，避免多模态/推理模型默认的超大输出窗口拖慢并抬高费用；同时适配小窗口模型 */
function outputTokenLimit(text, modelLimit) {
  const raw = String(text || '');
  const cjk = (raw.match(/[\u3400-\u9fff\uf900-\ufaff]/gi) || []).length;
  const inputTokens = cjk + Math.max(0, raw.length - cjk) / 3.6;
  let calculated = Math.max(768, Math.min(4096, Math.ceil(inputTokens * 1.85 + 240)));
  if (modelLimit && Number.isFinite(modelLimit) && modelLimit > 0) {
    // 适配小窗口模型（如 4K/8K），限制生成 Token 不超过模型容量的 25%，防止挤占输入空间
    const maxAllowed = Math.max(512, Math.floor(modelLimit * 0.25));
    calculated = Math.min(calculated, maxAllowed);
  }
  return calculated;
}

/**
 * 译文后处理：规范化文献引用格式并清理提示词残留
 */
function postProcess(text) {
  let t = String(text);

  // 1) 提示词 / 术语表回声
  t = t.replace(/【\s*待翻译内容\s*】/g, '').replace(/【\s*译文\s*】/g, '');

  // 2) 括号里含「等人」的整块引用（可能是多条连写）统一还原成学术写法
  t = t.replace(/[（(]([^（）()\n]*等人[^（）()\n]*)[）)]/g, (_m, inner) => {
    const s = inner
      .replace(/([^\s，,;；:：]+)\s*等人/g, '$1 et al.')
      .replace(/[，,]\s*(\d{4})\s*年?/g, ', $1')
      .replace(/[；;]\s*/g, '; ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return '(' + s + ')';
  });

  // 3) 残留的单条「（作者，YYYY年）」
  t = t.replace(/([（(])\s*([^（）()\n]{1,60}?)\s*[，,]\s*(\d{4})\s*年\s*([）)])/g, '($2, $3)');

  // 4) 括号外的「英文作者 等人（YYYY年）」或「等人（YYYY）」
  t = t.replace(
    /([A-Z][A-Za-z''\-.]*(?:\s+[A-Z][A-Za-z''\-.]*){0,3})\s*等人\s*[（(]\s*(\d{4})\s*年?\s*[）)]/g,
    '$1 et al. ($2)'
  );

  return t;
}

/** 去掉模型自作主张加上的整段代码围栏 */
function stripFenceWrapper(text) {
  const t = String(text).trim();
  const m = t.match(/^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```$/);
  return m ? m[1] : t;
}

async function requestOnce(content, cfg, signal, opts = {}) {
  await glossaryReady;
  const baseUrl = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('未配置 API 地址');
  if (!cfg.apiKey) throw new Error('未配置 API Key');

  const protectedContent = protectNonTextPayloads(content);
  // 跨段 continuity：把上一段原文尾部作为只读上下文前缀，不参与缓存键，
  // 用于缓解代词/缩写指代断裂。译文仍只针对本段，模型不得复述上下文。
  const prevContext = String(opts.prevContext || '').trim().slice(-300);
  const userText = prevContext
    ? `【上段末尾（仅供指代参考，不要翻译/复述它）】\n${prevContext}\n\n【本段待翻译】\n${protectedContent.text}`
    : protectedContent.text;
  const contextLimit = getModelContextLimit(cfg.model, cfg.contextWindow);
  const maxOutput = outputTokenLimit(protectedContent.text, contextLimit);
  const messages = [
    { role: 'system', content: buildSystemPrompt(resolveGlossary(cfg)) },
    // 必须保持 string：DeepSeek 只会把 content parts 数组中的 image_url/file
    // 当作多模态输入；这里固定字符串，传入永远是文本。
    { role: 'user', content: buildUserPrompt(userText, cfg) }
  ];

  // 预算检测：检查单段输入+提示词+最大生成是否触碰 80% 安全线
  const budget = checkContextBudget({
    model: cfg.model,
    customLimit: cfg.contextWindow,
    input: messages,
    maxOutputTokens: maxOutput,
    thresholdRatio: 0.8
  });

  if (budget.exceedsThreshold) {
    console.warn(
      `[translator] 单段文本估算 Token（${budget.totalEstimatedTokens}）接近模型窗口 80%（上限 ${budget.contextLimit}）`
    );
  }

  try {
    const effectiveModel = resolveModelAlias(baseUrl, cfg.model);
    const isGoogle = /googleapis\.com|google\.com/i.test(baseUrl);

    const json = await chatCompletion({
      api: cfg,
      body: {
        model: effectiveModel,
        messages,
        // 翻译是保真任务，默认低随机度；智谱上限为 1。
        temperature: /bigmodel\.cn/i.test(baseUrl)
          ? Math.min(cfg.temperature ?? DEFAULT_TEMPERATURE, 1)
          : cfg.temperature ?? DEFAULT_TEMPERATURE,
        // 思考参数：翻译任务关闭 thinking 模式以节省 Token 并提升响应速度
        ...thinkingParam(baseUrl, cfg.thinking),
        max_tokens: maxOutput,
        ...(isGoogle ? {} : { tool_choice: 'none' }),
        stream: false
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
      timeoutMessage: `翻译接口 ${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒未响应，正在按重试策略恢复`,
      signal
    });

    const out = json?.choices?.[0]?.message?.content;
    if (typeof out !== 'string' || !out.trim()) {
      throw new Error('模型返回内容为空');
    }
    return protectedContent.restore(postProcess(stripFenceWrapper(out)));
  } catch (err) {
    if (signal?.cancelled) throw new CancelledError();
    throw err;
  }
}

/** 指数退避重试：4xx（除 429）不重试，其余重试；400 上下文超限自愈学习允许重试 1 次 */
async function withRetry(fn, maxRetries = 3, onRetry, signal) {
  let lastErr;
  let calibratedRetried = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.cancelled) throw new CancelledError();
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.status;
      // 若因 400 上下文超限但成功逆向学习到新上限，允许自动自愈重试 1 次
      if (err.isContextOverflow && !calibratedRetried) {
        calibratedRetried = true;
        if (onRetry) onRetry(attempt + 1, `已自动校准模型上下文上限至 ${err.learnedLimit}，正在重试…`);
        await sleep(300, signal);
        continue;
      }
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === maxRetries) break;

      const delay = 800 * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
      if (onRetry) onRetry(attempt + 1, err.message);
      await sleep(delay, signal);
    }
  }
  throw lastErr;
}

/* ================================================================== *
 * 翻译质量轻量校验
 * ================================================================== */

/** 数块级公式的对数（$$ 成对出现） */
function countBlockMath(text) {
  return Math.floor((String(text).match(/\$\$/g) || []).length / 2);
}

/**
 * 翻译结果启发式校验（不追求完美，只挡「明显翻车」）：
 *  - 块级公式对数不一致 → 公式疑似被吞或被造
 *  - 译文长度异常（过短疑似漏译 / 过长疑似输出了讲解）
 *    短段（标题、单行）长度波动大，不做比例判断
 *
 * 纯函数，selftest 直接测。
 * @returns {{ok: boolean, reason?: string}}
 */
function countInlineCode(text) {
  return (String(text).match(/`[^`]+`/g) || []).length;
}

function countImagePlaceholders(text) {
  return (String(text).match(/\[\[PPTOR_IMAGE_\d+\]\]|!\[[^\]]*\]\([^)]*\)|<img\b/gi) || []).length;
}

function countTableRows(text) {
  const lines = String(text).split(/\r?\n/);
  let n = 0;
  for (const ln of lines) {
    const t = ln.trim();
    if (t.startsWith('|') || /^<table\b/i.test(t) || /^<\/table/i.test(t)) n++;
  }
  return n;
}

function checkTranslationQuality(original, translated) {
  const src = String(original || '');
  const out = String(translated || '');
  if (!src.trim() || !out.trim()) return { ok: false, reason: '译文为空' };

  const srcMath = countBlockMath(src);
  const outMath = countBlockMath(out);
  if (srcMath !== outMath) {
    return { ok: false, reason: `公式块数量不一致（原文 ${srcMath}，译文 ${outMath}）` };
  }

  // 图片占位符必须守恒：丢一张就是丢一张图
  const srcImg = countImagePlaceholders(src);
  const outImg = countImagePlaceholders(out);
  if (srcImg !== outImg) {
    return { ok: false, reason: `图片数量不一致（原文 ${srcImg}，译文 ${outImg}）` };
  }

  // 表格行数差异过大 → 疑似吞行/造行
  const srcRows = countTableRows(src);
  const outRows = countTableRows(out);
  if (srcRows > 0 && Math.abs(srcRows - outRows) > Math.max(2, Math.ceil(srcRows * 0.3))) {
    return { ok: false, reason: `表格行数差异大（原文 ${srcRows}，译文 ${outRows}）` };
  }

  // 文献引用标记抽查：[12] / (Author et al., 2021) 不应整体消失
  const srcCites = (src.match(/\[\d[\d,\s-]*\]|et al\./gi) || []).length;
  const outCites = (out.match(/\[\d[\d,\s-]*\]|et al\./gi) || []).length;
  if (srcCites >= 3 && outCites < Math.ceil(srcCites * 0.5)) {
    return { ok: false, reason: `引用标记丢失较多（原文 ${srcCites}，译文 ${outCites}）` };
  }

  // 数值、百分比和 p 值属于论文结论的硬约束；自然语言质量仍交给模型，
  // 但不能让明显的数字遗漏静默进入成品。
  const srcNumbers = src.match(/(?<![A-Za-z])(?:\d+(?:[,.]\d+)?%?|p\s*[<=>]\s*0?\.\d+)(?![A-Za-z])/gi) || [];
  const outNumbers = out.match(/(?<![A-Za-z])(?:\d+(?:[,.]\d+)?%?|p\s*[<=>]\s*0?\.\d+)(?![A-Za-z])/gi) || [];
  if (srcNumbers.length >= 3 && outNumbers.length < srcNumbers.length) {
    return { ok: false, reason: `数值或统计标记疑似丢失（原文 ${srcNumbers.length}，译文 ${outNumbers.length}）` };
  }

  // 短段也要做空译/回声检查：过短且与原文几乎相同 → 疑似未翻译
  if (src.trim().length < 120) {
    if (out.trim().length < 2) return { ok: false, reason: '译文异常短' };
    return { ok: true };
  }

  if (src.length >= 120) {
    const ratio = out.length / src.length;
    if (ratio < 0.2) return { ok: false, reason: `译文异常短（约 ${Math.round(ratio * 100)}%）` };
    if (ratio > 5) return { ok: false, reason: `译文异常长（约 ${Math.round(ratio * 100)}%）` };
  }
  return { ok: true };
}

/* ================================================================== *
 * 并发池
 * ================================================================== */

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    })
  );
  return results;
}

/* ================================================================== *
 * 对外主流程
 * ================================================================== */

/**
 * @param {Array} segments  chunker.splitMarkdown 的产物
 * @param {object} cfg       config.translate
 * @param {object} hooks     { onProgress, signal }
 * @returns {Promise<Map<number,string>>} id → 译文
 */
async function translateSegments(segments, cfg, hooks = {}) {
  const { onProgress = () => {}, signal } = hooks;
  await glossaryReady;
  const translations = new Map();

  const targets = segments.filter((s) => s.translatable);
  const total = targets.length;
  if (!total) return translations;

  // 请求上下文与缓存身份必须使用同一份数据；否则相同段落会复用不同语境的旧译文。
  const previousContexts = new Map();
  for (let index = 0; index < targets.length; index += 1) {
    previousContexts.set(targets[index].id, index > 0 ? previousContextTail(targets[index - 1].content) : '');
  }

  const pending = [];
  for (const [targetIndex, seg] of targets.entries()) {
    const prevContext = previousContexts.get(seg.id) || '';
    const key = cacheKey(cfg, seg.content, prevContext);
    const hit = cacheGet(key);
    if (hit) {
      translations.set(seg.id, hit);
    } else {
      pending.push({ seg, key, position: targetIndex + 1, prevContext });
    }
  }

  const cached = total - pending.length;
  onProgress({
    stage: 'translate',
    message: cached ? `共 ${total} 段，命中缓存 ${cached} 段，需翻译 ${pending.length} 段` : `共 ${total} 段待翻译`,
    percent: Math.round((cached / total) * 100)
  });

  let done = cached;
  const failedIds = [];
  const active = new Map();
  const reportActivity = () => {
    if (!active.size) return;
    onProgress({
      stage: 'translate',
      percent: Math.round((done / total) * 100),
      message: `翻译 ${done}/${total} 段…`
    });
  };
  const heartbeat = setInterval(reportActivity, 4000);
  heartbeat.unref?.();

  try {
    let abortRest = false;
    await mapLimit(pending, cfg.concurrency || 3, async ({ seg, key, position, prevContext }) => {
      if (signal?.cancelled) throw new CancelledError();
      if (abortRest) {
        // 共享取消：已有 worker 因取消失败，后续不再烧 Token，直接回填原文。
        translations.set(seg.id, seg.content);
        failedIds.push(seg.id);
        return;
      }
      active.set(seg.id, { position, startedAt: Date.now() });
      reportActivity();
      try {
        let translated;
        try {
          translated = await withRetry(
            () => requestOnce(seg.content, cfg, signal, { prevContext }),
            cfg.maxRetries ?? 3,
            (attempt, msg) =>
              onProgress({ stage: 'translate', message: `第 ${position} 段第 ${attempt} 次重试：${msg.slice(0, 80)}` }),
            signal
          );
        } catch (err) {
          if (signal?.cancelled || isCancelled(err)) {
            abortRest = true;
            throw err;
          }
          // 单段失败不拖垮整篇：回填原文并记录，整篇标记部分成功。
          console.warn(`[translator] 第 ${position} 段失败，已回填原文：${(err && err.message) || err}`);
          translations.set(seg.id, seg.content);
          failedIds.push(seg.id);
          done++;
          onProgress({
            stage: 'translate',
            message: `翻译进度 ${done}/${total}（第 ${position} 段失败，已保留原文）`,
            percent: Math.round((done / total) * 100)
          });
          return;
        }

        // 轻量质量校验：公式/图片/表格/引用守恒 + 长度比例；不过关保留两版取优。
        const quality = checkTranslationQuality(seg.content, translated);
        if (!quality.ok) {
          onProgress({ stage: 'translate', message: `第 ${position} 段${quality.reason}，重试一次…` });
          try {
            const retried = await withRetry(() => requestOnce(seg.content, cfg, signal, { prevContext }), 1, null, signal);
            const second = checkTranslationQuality(seg.content, retried);
            // 保留更优一版：第二版通过则采用，否则保留第一版。
            if (second.ok && !quality.ok) translated = retried;
            else if (!second.ok) {
              onProgress({ stage: 'translate', message: `第 ${position} 段质量问题仍未消除（${quality.reason}），已保留较优结果` });
            }
          } catch {
            /* 内容级重试失败 → 保留第一版结果 */
          }
        }

        translations.set(seg.id, translated);
        cacheSet(key, translated);

        done++;
        onProgress({
          stage: 'translate',
          message: `翻译进度 ${done}/${total}`,
          percent: Math.round((done / total) * 100)
        });
      } finally {
        active.delete(seg.id);
      }
    });
  } finally {
    clearInterval(heartbeat);
  }

  await flushCache();
  if (failedIds.length) translations.failedIds = failedIds;
  return translations;
}

/** 设置面板里的「测试连接」 */
async function testApi(api) {
  const cfg = { ...api, sourceLang: 'en', targetLang: 'zh' };
  cfg.model = resolveModelAlias(cfg.baseUrl || '', cfg.model);
  const sample = 'The quick brown fox jumps over the lazy dog.';
  const out = await requestOnce(sample, cfg);
  return { ok: true, sample: out.slice(0, 120) };
}

/**
 * 拉取服务商支持的模型列表（OpenAI 兼容的 GET /models）
 * 失败会 throw，由调用方决定是回退到手填模型名还是提示用户。
 * @returns {Promise<string[]>} 模型 id 列表（去重、排序）
 */
async function listModels(api) {
  const baseUrl = String(api.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('未配置 API 地址');
  if (!api.apiKey) throw new Error('未配置 API Key');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);

  try {
    const isGoogle = /googleapis\.com/i.test(baseUrl);
    const reqUrl = (isGoogle && !baseUrl.includes('key='))
      ? `${baseUrl}/models?key=${encodeURIComponent(api.apiKey)}`
      : `${baseUrl}/models`;

    let res;
    if (isGoogle) {
      // 优先请求 Google 原生 v1beta/models 端点（仅通过 ?key= 鉴权）
      const nativeUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(api.apiKey)}`;
      try {
        res = await fetch(nativeUrl, { method: 'GET', signal: ctrl.signal });
      } catch {
        res = null;
      }
      // 若原生不可达或返回非 2xx，尝试 OpenAI 兼容端点（仅通过 Authorization 头鉴权）
      if (!res || !res.ok) {
        try {
          const compatUrl = `${baseUrl}/models`;
          const compatRes = await fetch(compatUrl, {
            method: 'GET',
            headers: { Authorization: `Bearer ${api.apiKey}` },
            signal: ctrl.signal
          });
          if (compatRes.ok || !res) res = compatRes;
        } catch (err) {
          if (!res) throw err;
        }
      }
    } else {
      res = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${api.apiKey}` },
        signal: ctrl.signal
      });
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`接口返回非 JSON（HTTP ${res.status}）`);
    }

    if (!res.ok) {
      const msg = json?.error?.message || json?.message || text.slice(0, 200);
      const err = new Error(`HTTP ${res.status}：${msg}`);
      err.status = res.status;
      throw err;
    }

    let raw = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    if (isGoogle && Array.isArray(json?.models)) {
      // 过滤出可用于翻译/问答的 Gemini 模型（排除 text-embedding、aqa 等纯嵌入/专用模型）
      raw = raw.filter((item) => {
        const id = String((item && (item.id || item.name)) || '').toLowerCase();
        const methods = Array.isArray(item?.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
        if (methods.length && !methods.includes('generateContent')) return false;
        return id.includes('gemini');
      });
    }
    const contexts = {};
    for (const item of raw) {
      let id = String((item && (item.id || item.name)) || '').trim();
      if (!id) continue;
      // 剥离 Google 原生 models/ 前缀
      id = id.replace(/^models\//i, '');
      const limit = extractContextLimitFromModelObj(item) || (item.inputTokenLimit && Number(item.inputTokenLimit)) || 0;
      if (limit > 0) {
        contexts[id] = limit;
        recordLearnedContextLimit(id, limit);
      }
    }

    let models = [...new Set(raw.map((m) => {
      let id = String((m && (m.id || m.name)) || '').trim();
      return id.replace(/^models\//i, '');
    }).filter(Boolean))];

    if (isGoogle) {
      const freeModels = [
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-1.5-flash',
        'gemini-1.5-flash-8b'
      ];
      // 仅保留官方免费的 Flash 系列模型，排除 Pro / 实验版等非免费模型
      models = models.filter((m) => {
        const lower = m.toLowerCase();
        return freeModels.includes(lower) || (lower.includes('flash') && !lower.includes('pro') && !lower.includes('exp'));
      });
      const priorityOrder = [
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-1.5-flash',
        'gemini-1.5-flash-8b'
      ];
      models.sort((a, b) => {
        const ai = priorityOrder.indexOf(a);
        const bi = priorityOrder.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.localeCompare(b);
      });
      if (!models.length) {
        models = priorityOrder.slice();
      }
    } else {
      models.sort();
    }

    if (!models.length) throw new Error('没返回任何模型');

    models.contexts = contexts;
    return models;
  } finally {
    clearTimeout(timer);
  }
}

/** 支持 thinking 参数的服务端 */
const THINKING_HOSTS = /deepseek\.com|bigmodel\.cn/i;

/**
 * 思考参数生成
 */
function thinkingParam(baseUrl, setting) {
  const mode = setting || 'auto';
  if (mode === 'off') return { thinking: { type: 'disabled' } };
  if (mode === 'on') return { thinking: { type: 'enabled' } };
  return THINKING_HOSTS.test(baseUrl) ? { thinking: { type: 'disabled' } } : {};
}

/**
 * 测试翻译模型 API 连接性
 * 首选：GET /models（0 Token 消耗，不产生任何 API 费用）
 * 降级：若服务端未实现 /models 路由（404/405），降级为极微小请求（max_tokens: 1）
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function checkConnectivity(api) {
  const baseUrl = String(api?.baseUrl || '').replace(/\/+$/, '');
  const apiKey = String(api?.apiKey || '').trim();
  if (!baseUrl || !apiKey) {
    return { ok: false, reason: 'unconfigured' };
  }

  // 1. 优先 0 Token 探测：GET /models
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal
    });
    clearTimeout(timer);

    if (res.ok) {
      return { ok: true };
    }
    // 仅当 404 或 405 时尝试降级；401（未授权）/ 403 / 402（欠费）等直接视为连接失败
    if (res.status !== 404 && res.status !== 405) {
      const reason = res.status === 401 ? 'HTTP 401 密钥失效' : `HTTP ${res.status}`;
      return { ok: false, reason };
    }
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, reason: '连接超时' };
    return { ok: false, reason: err.message || '网络连接失败' };
  }

  // 2. 降级方案：极小请求（1 Token 消耗兜底）
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: resolveModelAlias(baseUrl, api?.model || 'deepseek-flash'),
        messages: [{ role: 'user', content: '1' }],
        max_tokens: 1,
        stream: false
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    return { ok: res.ok, reason: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, reason: '连接超时' };
    return { ok: false, reason: err.message || '连接失败' };
  }
}

module.exports = {
  translateSegments,
  testApi,
  checkConnectivity,
  listModels,
  initCache,
  initGlossary,
  flushCache,
  cacheStats,
  cacheKey,
  checkTranslationQuality,
  countBlockMath,
  protectNonTextPayloads,
  previousContextTail,
  outputTokenLimit,
  resolveGlossary,
  resolveModelAlias,
  cleanGlossary,
  DEFAULT_TEMPERATURE,
  PROMPT_VERSION,
  LANG_NAME
};
