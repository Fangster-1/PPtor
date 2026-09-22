'use strict';

/**
 * 模型上下文窗口与 Token 预算管理
 */
const { chatCompletion } = require('./llm-client');

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;

/**
 * 主流大模型官方最新上下文窗口容量表（单位：Tokens）
 * 依据各服务商 2026 最新官方文档更新，正则按特异性从高到低匹配
 */
const MODEL_CONTEXT_RULES = [
  // Google Gemini (2.5 Pro 达 2M；Flash 达 1M)
  { pattern: /gemini-(?:1\.5-pro|2\.0-pro|2\.5-pro)/i, limit: 2000000 },
  { pattern: /gemini-(?:1\.5|2\.0|2\.5)/i, limit: 1000000 },
  { pattern: /gemini/i, limit: 1000000 },

  // Anthropic Claude 系列 (Claude 3.7 / 3.5 达 200K)
  { pattern: /claude-3(?:-7|-5|\.5)?/i, limit: 200000 },
  { pattern: /claude/i, limit: 100000 },

  // DeepSeek 系列
  // 官网 DeepSeek-Flash / V4-Pro 达 1M
  { pattern: /deepseek-(?:flash|v4)/i, limit: 1000000 },
  // DeepSeek-V3 / R1 官方标准支持 128K
  { pattern: /deepseek-(?:v3|r1)/i, limit: 128000 },
  { pattern: /deepseek-(?:chat|coder|reasoner)/i, limit: 128000 },
  { pattern: /deepseek/i, limit: 128000 },

  // 智谱 GLM 系列
  // GLM-5 系列与 GLM-4-Long 达 1M
  { pattern: /glm-(?:5|4-long)/i, limit: 1000000 },
  // GLM-4.7 达 200K
  { pattern: /glm-4\.7/i, limit: 200000 },
  // GLM-4-Plus, GLM-4-Flash, GLM-4-Air, GLM-4.5 标配 128K
  { pattern: /glm-4(?:[.-]|\b)|glm-4\.5/i, limit: 128000 },
  { pattern: /glm-3/i, limit: 32768 },

  // MiniMax 系列 (Text-01 达 1M; abab6.5s 达 245K)
  { pattern: /minimax-text/i, limit: 1000000 },
  { pattern: /abab6\.5/i, limit: 245760 },
  { pattern: /abab/i, limit: 32768 },

  // Moonshot (Kimi)
  { pattern: /moonshot-v1-128k|kimi-latest|kimi/i, limit: 128000 },
  { pattern: /moonshot-v1-32k/i, limit: 32768 },
  { pattern: /moonshot-v1-8k/i, limit: 8192 },

  // OpenAI 系列
  { pattern: /o1|o3-mini/i, limit: 200000 },
  { pattern: /gpt-4o|gpt-4-turbo/i, limit: 128000 },
  { pattern: /gpt-4-32k/i, limit: 32768 },
  { pattern: /gpt-4\b/i, limit: 8192 },
  { pattern: /gpt-3\.5-turbo-16k/i, limit: 16385 },
  { pattern: /gpt-3\.5/i, limit: 16385 },

  // 阿里通义千问 Qwen 系列 (Qwen2.5 原生支持 131K; 硅基部分 7B 部署为 33K)
  { pattern: /qwen2\.5-(?:72b|32b|14b)/i, limit: 131072 },
  { pattern: /qwen2\.5-coder/i, limit: 131072 },
  { pattern: /qwen2\.5-7b/i, limit: 131072 },
  { pattern: /qwen2\.5/i, limit: 32768 },
  { pattern: /qwen-max|qwen-plus|qwen-turbo/i, limit: 131072 },
  { pattern: /qwen2/i, limit: 32768 },
  { pattern: /qwen/i, limit: 32768 },

  // 腾讯混元 Hunyuan
  { pattern: /hunyuan-(?:turbos|large)/i, limit: 131072 },
  { pattern: /hunyuan-mt/i, limit: 32768 },
  { pattern: /hunyuan/i, limit: 32768 },

  // Meta LLaMA 系列
  { pattern: /llama-3\.[123]/i, limit: 131072 },
  { pattern: /llama-3\b/i, limit: 8192 },
  { pattern: /llama-2/i, limit: 4096 },

  // Mistral 系列
  { pattern: /mistral-large|codestral/i, limit: 128000 },
  { pattern: /mistral|mixtral/i, limit: 32768 }
];

/** 无法识别时的保守默认值（32K） */
const DEFAULT_CONTEXT_WINDOW = 32768;

/** 上下文安全警戒水位（默认 80%） */
const DEFAULT_THRESHOLD_RATIO = 0.8;

/** 运行时探测/学习到的模型上下文缓存 (modelName.toLowerCase() -> limit) */
const learnedLimits = new Map();

/**
 * 记录探测或解析到的模型容量
 * @param {string} modelName
 * @param {number} limit
 */
function recordLearnedContextLimit(modelName, limit) {
  const name = String(modelName || '').trim();
  const num = Number(limit);
  if (name && Number.isFinite(num) && num >= 1024 && num <= 10000000) {
    learnedLimits.set(name.toLowerCase(), Math.round(num));
  }
}

/**
 * 获取运行时已学习到的模型容量
 * @param {string} modelName
 * @returns {number} 0 = 未学习过
 */
function getLearnedContextLimit(modelName) {
  const name = String(modelName || '').trim().toLowerCase();
  return learnedLimits.get(name) || 0;
}

/**
 * 从 API /models 返回的模型对象中自动探测提取上下文窗口大小
 * 兼容 vLLM、OpenRouter、OneAPI/NewAPI、LiteLLM、Gemini 等平台
 *
 * @param {object} modelObj
 * @returns {number} 探测到的容量（Token 数），未能探测到返回 0
 */
function extractContextLimitFromModelObj(modelObj) {
  if (!modelObj || typeof modelObj !== 'object') return 0;

  const candidates = [
    modelObj.context_length,
    modelObj.max_model_len,
    modelObj.context_window,
    modelObj.input_token_limit,
    modelObj.inputTokenLimit,
    modelObj.max_context_length,
    modelObj.top_provider?.context_length,
    modelObj.limits?.context,
    modelObj.per_request_limits?.context_length
  ];

  for (const val of candidates) {
    const num = Number(val);
    if (Number.isFinite(num) && num >= 1024 && num <= 10000000) {
      return Math.round(num);
    }
  }

  return 0;
}

/** 各服务商典型的上下文超限 400 报错匹配正则 */
const ERROR_CONTEXT_PATTERNS = [
  /maximum context (?:length|window) is (\d+)/i,
  /context (?:length|window) is (\d+)/i,
  /context (?:limit|window|length) of (\d+)/i,
  /exceeds? the (?:maximum|limit of|context length of) (\d+)/i,
  /tokens? > (\d+) maximum/i,
  /exceeded (?:model )?limit of (\d+)/i,
  /maximum is (\d+)/i,
  /context_length_exceeded.*?(\d{4,8})/i,
  /最大上下文.*?(\d{4,8})/i,
  /上下文.*?超过.*?(\d{4,8})/i
];

/**
 * 从 400 报错信息中提取模型上下文限制
 *
 * @param {Error|string|object} err
 * @returns {number} 提取出的上限（未能提取返回 0）
 */
function extractContextLimitFromError(err) {
  const text = typeof err === 'string' ? err : err?.message || err?.error?.message || String(err || '');
  if (!text) return 0;

  for (const pattern of ERROR_CONTEXT_PATTERNS) {
    const m = text.match(pattern);
    if (m && m[1]) {
      const num = Number(m[1]);
      if (Number.isFinite(num) && num >= 1024 && num <= 10000000) {
        return Math.round(num);
      }
    }
  }

  return 0;
}

/**
 * 获取模型的上下文窗口上限
 * 优先级：用户手动配置 > 运行时学习/探测记录 > 规则库匹配 > 默认兜底 (32K)
 *
 * @param {string} modelName 模型名称
 * @param {number} [customLimit] 用户手动指定的自定义限制（可选，>0 则优先使用）
 * @returns {number} 窗口 Token 上限
 */
function getModelContextLimit(modelName, customLimit = 0) {
  const custom = Number(customLimit);
  if (Number.isFinite(custom) && custom > 0) return Math.round(custom);

  const name = String(modelName || '').trim();
  if (!name) return DEFAULT_CONTEXT_WINDOW;

  // 1. 优先查运行时记录
  const learned = learnedLimits.get(name.toLowerCase());
  if (learned && learned > 0) return learned;

  // 2. 匹配内置规则库
  for (const rule of MODEL_CONTEXT_RULES) {
    if (rule.pattern.test(name)) {
      return rule.limit;
    }
  }

  // 3. 安全默认兜底
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * 粗略估算纯文本 Token 数量：CJK 约 1 token/字，其余约 1 token/3.6 字符
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  const str = String(text || '');
  let count = 0;
  for (const ch of str) {
    count += CJK_RE.test(ch) ? 1 : 0.28;
  }
  return Math.ceil(count);
}

/**
 * 估算整个 messages 数组消耗的 Token 总量
 * 包括 role、content 及结构开销
 * @param {Array<{role:string, content:string}>} messages
 * @returns {number}
 */
function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const msg of messages) {
    if (!msg) continue;
    total += 4;
    total += estimateTokens(msg.role);
    total += estimateTokens(msg.content);
  }
  total += 3;
  return total;
}

/**
 * 检查当前请求是否达到上下文安全阈值（80%）
 */
function checkContextBudget({
  model,
  customLimit,
  input,
  maxOutputTokens = 0,
  thresholdRatio = DEFAULT_THRESHOLD_RATIO
}) {
  const contextLimit = getModelContextLimit(model, customLimit);
  const thresholdTokens = Math.floor(contextLimit * thresholdRatio);

  const inputTokens = Array.isArray(input)
    ? estimateMessagesTokens(input)
    : estimateTokens(input);

  const totalEstimatedTokens = inputTokens + Math.max(0, Math.ceil(maxOutputTokens || 0));
  const usageRatio = Number((totalEstimatedTokens / contextLimit).toFixed(4));
  const exceedsThreshold = totalEstimatedTokens >= thresholdTokens;
  const headroomTokens = Math.max(0, contextLimit - totalEstimatedTokens);

  return {
    contextLimit,
    thresholdTokens,
    totalEstimatedTokens,
    usageRatio,
    exceedsThreshold,
    headroomTokens
  };
}

/**
 * 根据模型窗口大小动态换算 QA 问答中支持的最大论文片段字符数
 */
function resolveDynamicQaChars(model, customLimit) {
  const limit = getModelContextLimit(model, customLimit);
  const snippetTokens = Math.floor(limit * 0.45);
  return Math.max(4000, Math.min(200000, Math.round(snippetTokens * 2.8)));
}

/**
 * 本地降级问答历史压缩
 */
function localCompressHistory(history) {
  const items = (history || []).filter((h) => h && h.content);
  if (!items.length) return '';

  const bulletPoints = [];
  for (let i = 0; i < items.length; i += 2) {
    const q = items[i]?.content || '';
    const a = items[i + 1]?.content || '';
    if (q) {
      const shortQ = q.replace(/^我的问题：/i, '').trim().slice(0, 60);
      const shortA = a.replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
      bulletPoints.push(`- 问：「${shortQ}」 答要点：${shortA}${a.length > 100 ? '…' : ''}`);
    }
  }

  return bulletPoints.join('\n');
}

/**
 * 将多轮历史对话压缩为紧凑的前情提要，以便重置开启全新窗口
 */
async function compressQaHistory(history, api, signal) {
  if (!Array.isArray(history) || history.length <= 2) {
    return history.slice();
  }

  const dialogText = history
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
    .join('\n\n');

  let summary = '';

  if (api && api.baseUrl && api.apiKey && api.model) {
    try {
      const data = await chatCompletion({
        api,
        body: {
          model: api.model,
          messages: [
            {
              role: 'system',
              content:
                '你是一位学术研读摘要专家。请将以下多轮用户与助手的问答历史提炼为一段高信息密度的简短备忘（300字以内）。' +
                '严格保留：讨论过的论文核心概念、重要结论、已确认的数据或公式、用户关心的焦点。' +
                '去除寒暄客套，只输出摘要正文，不要前言。'
            },
            {
              role: 'user',
              content: `请精炼总结以下历史问答：\n\n${dialogText}`
            }
          ],
          temperature: 0.2,
          max_tokens: 500
        },
        timeoutMs: 25000,
        signal
      });
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim()) {
        summary = text.trim();
      }
    } catch {
      /* 回退本地压缩 */
    }
  }

  if (!summary) {
    summary = localCompressHistory(history);
  }

  if (!summary) return history.slice(-2);

  return [
    {
      role: 'user',
      content: `【前情提要 / 历史问答要点摘要】\n${summary}`
    },
    {
      role: 'assistant',
      content: '已获知并记住前文探讨的核心论点与数据。上下文窗口已重新重置，请继续就论文提问。'
    }
  ];
}

module.exports = {
  MODEL_CONTEXT_RULES,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_THRESHOLD_RATIO,
  recordLearnedContextLimit,
  getLearnedContextLimit,
  extractContextLimitFromModelObj,
  extractContextLimitFromError,
  getModelContextLimit,
  estimateTokens,
  estimateMessagesTokens,
  checkContextBudget,
  resolveDynamicQaChars,
  compressQaHistory
};
