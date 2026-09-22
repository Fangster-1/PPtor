'use strict';

/**
 * 主进程 → 宠物气泡的确认问答网关（从 ipc.js 抽出）。
 * 把问题抛给宠物气泡，等用户在界面上点选（按序排队，支持超时与取消）。
 */
const petWin = require('../pet/window');

function createAskGateway() {
  let pendingAsk = null;
  const askQueue = [];

  function pumpAskQueue() {
    if (pendingAsk || !askQueue.length) return;
    const item = askQueue.shift();
    const win = petWin.getPetWindow();
    if (!win || win.isDestroyed()) {
      item.resolve(item.options[item.options.length - 1].value);
      pumpAskQueue();
      return;
    }
    // 任务可能由聊天窗发起；宠物隐藏时确认气泡无处安放，先按统一顺序召回。
    // 已显示时不重置用户拖出的位置。
    if (!win.isVisible()) {
      try {
        if (win.isMinimized()) win.restore();
        petWin.setIgnoreMouse(false);
        petWin.moveToBottomRight();
        win.show();
      } catch {
        /* 显示失败仍按超时兜底 */
      }
    }
    if (item.signal?.cancelled) {
      item.resolve('skip');
      pumpAskQueue();
      return;
    }
    const timer = setTimeout(() => {
      if (pendingAsk === item) {
        pendingAsk = null;
        item.resolve(item.options[item.options.length - 1].value); // 超时按最后一项处理（通常是跳过）
        pumpAskQueue();
      }
    }, item.timeoutMs);

    const onCancel = () => {
      if (pendingAsk === item) {
        clearTimeout(timer);
        pendingAsk = null;
        item.resolve('skip');
        pumpAskQueue();
      }
    };
    let removeCancel = () => {};
    try {
      if (item.signal && typeof item.signal.addCancelHandler === 'function') {
        removeCancel = item.signal.addCancelHandler(onCancel);
      }
    } catch { /* ignore */ }

    pendingAsk = {
      ...item,
      resolve: (v) => {
        clearTimeout(timer);
        try { removeCancel(); } catch { /* ignore */ }
        pendingAsk = null;
        item.resolve(v);
        pumpAskQueue();
      }
    };

    win.webContents.send('pet:action', { action: 'ask', payload: { message: item.message, options: item.options, askId: item.askId } });
  }

  /** @returns {Promise<string>} 用户选择的 option.value */
  function askViaPet({ message, options, timeoutMs = 180000, signal, askId }) {
    return new Promise((resolve) => {
      askQueue.push({ message, options, timeoutMs, signal, askId: askId || message.slice(0, 40), resolve });
      pumpAskQueue();
    });
  }

  /** 渲染层点了气泡里的按钮（ui:answer） */
  function answer(value) {
    if (pendingAsk) {
      const r = pendingAsk.resolve;
      r(String(value));
    }
    return true;
  }

  /** 退出阶段：排队与进行中的确认一律按跳过放行，避免退出悬挂 */
  function shutdown() {
    if (pendingAsk) {
      const ask = pendingAsk;
      pendingAsk = null;
      try {
        ask.resolve('skip');
      } catch {
        /* 渲染窗口可能已经销毁 */
      }
    }
    while (askQueue.length) {
      const item = askQueue.shift();
      try { item.resolve('skip'); } catch { /* ignore */ }
    }
  }

  return { askViaPet, answer, shutdown, hasPending: () => !!pendingAsk };
}

module.exports = { createAskGateway };
