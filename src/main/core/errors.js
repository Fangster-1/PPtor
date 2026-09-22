'use strict';

/**
 * 统一错误类型：任务取消信号。
 *
 * 此前全仓用魔法字符串 '已取消'（throw new Error('已取消')），靠
 * message === '已取消' 精确匹配跨进程/跨层传递；提示文案一旦改动，
 * 取消检测就会静默失效。现统一为类型判断：
 *   - 各层统一 throw new CancelledError()
 *   - 边界处用 isCancelled(err) 判断（兼容旧字符串协议，便于渐进迁移）
 */
class CancelledError extends Error {
  constructor(message = '已取消') {
    super(message);
    this.name = 'CancelledError';
    this.cancelled = true;
  }
}

/** 判断错误是否为“任务被取消”（兼容旧的字符串协议） */
function isCancelled(err) {
  if (!err) return false;
  if (err instanceof CancelledError || err.cancelled === true) return true;
  return err.message === '已取消';
}

module.exports = { CancelledError, isCancelled };
