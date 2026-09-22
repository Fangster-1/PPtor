'use strict';

/**
 * 可取消的异步原语（全仓唯一定义处）。
 *
 * - withDeadline：带期限的异步等待。文件位于网盘、U 盘或失联的映射盘时，
 *   Windows 的异步文件 I/O 也可能长期不返回。业务层不能把这种等待直接
 *   暴露为“准备中”，因此统一在边界处给出有意义的错误；底层 I/O 随后
 *   返回时，其结果会被安全忽略。
 * - addCancelHandler / sleep：原先在 async / parser / translator 三处各有一份
 *   复制实现，现收敛于此。
 */
const { CancelledError } = require('./errors');

function addCancelHandler(signal, handler) {
  if (!signal || typeof handler !== 'function') return () => {};
  if (typeof signal.addCancelHandler === 'function') return signal.addCancelHandler(handler);

  // 兼容旧的轻量测试 signal；正式 IPC signal 使用 Set，可同时中止多个请求。
  const previous = signal.onCancel;
  const wrapped = () => {
    try {
      if (typeof previous === 'function') previous();
    } finally {
      handler();
    }
  };
  signal.onCancel = wrapped;
  return () => {
    if (signal.onCancel === wrapped) signal.onCancel = previous || null;
  };
}

/** 可取消的 sleep；signal 取消时以 CancelledError 拒绝 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.cancelled) {
      reject(new CancelledError());
      return;
    }
    const timer = setTimeout(() => {
      removeCancel();
      resolve();
    }, ms);
    const removeCancel = addCancelHandler(signal, () => {
      clearTimeout(timer);
      removeCancel();
      reject(new CancelledError());
    });
  });
}

/**
 * @param {() => Promise<unknown>|unknown} operation 延迟执行，避免取消后仍启动 I/O
 * @param {{timeoutMs?:number, signal?:object, label?:string}} options
 */
function withDeadline(operation, { timeoutMs = 0, signal, label = '操作' } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.cancelled) {
      reject(new CancelledError());
      return;
    }

    let settled = false;
    let timer = null;
    let removeCancel = () => {};
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      removeCancel();
      fn(value);
    };

    removeCancel = addCancelHandler(signal, () => finish(reject, new CancelledError()));
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => finish(reject, new Error(`${label}超时（超过 ${Math.ceil(timeoutMs / 1000)} 秒）`)),
        timeoutMs
      );
    }

    let pending;
    try {
      pending = operation();
    } catch (err) {
      finish(reject, err);
      return;
    }
    Promise.resolve(pending).then(
      (value) => finish(resolve, value),
      (err) => finish(reject, err)
    );
  });
}

module.exports = { withDeadline, addCancelHandler, sleep };
