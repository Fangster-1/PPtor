'use strict';

/**
 * OpenAI 兼容 /chat/completions 统一客户端。
 *
 * 此前 translator / qa / context 三处各写一份 fetch + 超时 + 鉴权 + JSON 解析
 * + 400 上下文上限学习，行为细节（超时值、错误形状）各不相同。现收敛为一个入口：
 *   - 统一 AbortController 超时与取消信号联动
 *   - 统一非 JSON / HTTP 错误形状（err.status 供重试策略判断）
 *   - 400 响应自动尝试逆向学习模型上下文上限（err.learnedLimit / isContextOverflow）
 */
const { addCancelHandler } = require('./async');
const { CancelledError } = require('./errors');
// 注意：context.js 也依赖本模块（compressQaHistory），存在模块环；
// context 的两个函数必须在调用点惰性 require，顶层解构会拿到未初始化的导出。

/** HTTP 层错误（带状态码，供调用方重试策略判断可否重试） */
class LlmHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'LlmHttpError';
    this.status = status;
  }
}

/**
 * @param {object} p
 * @param {object} p.api           { baseUrl, apiKey, model }
 * @param {object} p.body          完整请求体（messages/model/temperature/...）
 * @param {number} [p.timeoutMs]   超时毫秒数
 * @param {string} [p.timeoutMessage] 超时时的错误文案（不传则用默认文案）
 * @param {object} [p.signal]      取消信号
 * @returns {Promise<object>} 解析后的响应 JSON
 */
async function chatCompletion({ api, body, timeoutMs = 90000, timeoutMessage, signal }) {
  const baseUrl = String(api?.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('未配置 API 地址');
  if (!api?.apiKey) throw new Error('未配置 API Key');

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const removeCancel = addCancelHandler(signal, () => ctrl.abort());

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${api.apiKey}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      const msg = json?.error?.message || json?.message || text.slice(0, 200);
      const err = new LlmHttpError(`HTTP ${res.status}：${msg}`, res.status);
      if (res.status === 400) {
        const { extractContextLimitFromError, recordLearnedContextLimit } = require('./context');
        const learned = extractContextLimitFromError(msg);
        if (learned > 0) {
          recordLearnedContextLimit(api.model, learned);
          err.learnedLimit = learned;
          err.isContextOverflow = true;
        }
      }
      throw err;
    }

    return json;
  } catch (err) {
    if (signal?.cancelled) throw new CancelledError();
    if (timedOut) {
      const e = new Error(timeoutMessage || `请求 ${Math.round(timeoutMs / 1000)} 秒未响应`);
      e.kind = 'timeout';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    removeCancel();
  }
}

module.exports = { chatCompletion, LlmHttpError };
