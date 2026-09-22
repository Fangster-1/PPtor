'use strict';

/** 向宠物窗与聊天窗广播事件；窗口不存在/已销毁时自动跳过 */
const petWin = require('../pet/window');
const chatWin = require('../chat/window');

function broadcast(channel, data) {
  for (const win of [petWin.getPetWindow(), chatWin.getChatWindow()]) {
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send(channel, data);
      } catch {
        /* 窗口可能在发送瞬间被关闭 */
      }
    }
  }
}

module.exports = { broadcast };
