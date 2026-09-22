'use strict';

/**
 * 论文问答聊天窗口（微信风格）：
 *   - 无边框窗口，标题栏拖动移动，边缘自由缩放（resizable + minWidth/Height）
 *   - 位置与大小记忆到配置（chat.bounds）。注意只在用户交互结束事件
 *     （moved / resized）上保存——move / resize 在程序性 setBounds 时也会
 *     连发，曾导致“每次打开窗口位置/大小都漂移”
 *   - 打开时宠物窗临时隐藏（图标并入本窗口头部），关闭后恢复
 */
const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

const { getConfig, saveConfig } = require('../config');

const CHAT_MIN_W = 600;
const CHAT_MIN_H = 440;
const CHAT_DEFAULT_W = 880;
const CHAT_DEFAULT_H = 600;

let chatWindow = null;
/** 聊天窗显隐变化时通知主进程（显示 → 临时隐藏宠物；隐藏 → 恢复宠物） */
let onVisibilityChange = null;

function getChatWindow() {
  return chatWindow;
}

function setVisibilityHandler(fn) {
  onVisibilityChange = typeof fn === 'function' ? fn : null;
  // 注册时同步一次当前状态（窗口可能已存在）
  if (onVisibilityChange && chatWindow && !chatWindow.isDestroyed()) {
    onVisibilityChange(chatWindow.isVisible() && !chatWindow.isMinimized());
  }
}

/** 校正记忆的边界：越界/过小时回退到工作区右侧默认位 */
function normalizeBounds(bounds) {
  const { workArea } = screen.getPrimaryDisplay();
  const w = Math.max(CHAT_MIN_W, Math.min(bounds && bounds.width || CHAT_DEFAULT_W, workArea.width));
  const h = Math.max(CHAT_MIN_H, Math.min(bounds && bounds.height || CHAT_DEFAULT_H, workArea.height));
  let x = Number(bounds && bounds.x);
  let y = Number(bounds && bounds.y);
  if (!Number.isFinite(x) || x < workArea.x - w + 120 || x > workArea.x + workArea.width - 120) {
    x = Math.round(workArea.x + Math.max(40, (workArea.width - w) * 0.55));
  }
  if (!Number.isFinite(y) || y < workArea.y || y > workArea.y + workArea.height - 60) {
    y = Math.round(workArea.y + Math.max(40, (workArea.height - h) * 0.4));
  }
  x = Math.round(Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - w)));
  y = Math.round(Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h)));
  return { x, y, width: Math.round(w), height: Math.round(h) };
}

function createChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) return chatWindow;

  const cfg = getConfig();
  chatWindow = new BrowserWindow({
    ...normalizeBounds(cfg.chat && cfg.chat.bounds),
    minWidth: CHAT_MIN_W,
    minHeight: CHAT_MIN_H,
    frame: false,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    backgroundColor: '#ededed',
    title: 'PPtor 论文问答',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  chatWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'chat.html'));
  chatWindow.once('ready-to-show', () => {
    if (chatWindow && !chatWindow.isDestroyed()) chatWindow.show();
  });

  // 位置大小记忆：仅在用户拖动/缩放结束（moved / resized）后防抖落盘。
  // 不要改回 'move' / 'resize'：程序性 setBounds 也会触发，bounds 会越存越漂。
  let saveTimer = null;
  const persistBounds = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (chatWindow && !chatWindow.isDestroyed() && !chatWindow.isMinimized()) {
        try {
          saveConfig({ chat: { bounds: chatWindow.getNormalBounds ? chatWindow.getNormalBounds() : chatWindow.getBounds() } });
        } catch {
          /* 配置写失败不影响窗口使用 */
        }
      }
    }, 500);
  };
  chatWindow.on('moved', persistBounds);
  chatWindow.on('resized', persistBounds);

  const notifyVisibility = () => {
    if (onVisibilityChange && chatWindow && !chatWindow.isDestroyed()) {
      onVisibilityChange(chatWindow.isVisible() && !chatWindow.isMinimized());
    }
  };
  chatWindow.on('show', notifyVisibility);
  chatWindow.on('hide', notifyVisibility);
  chatWindow.on('minimize', notifyVisibility);
  chatWindow.on('restore', notifyVisibility);

  chatWindow.on('closed', () => {
    chatWindow = null;
    if (onVisibilityChange) onVisibilityChange(false);
  });

  return chatWindow;
}

/** 显示/隐藏切换；窗口不存在时创建 */
function toggleChat() {
  if (!chatWindow || chatWindow.isDestroyed()) {
    createChatWindow();
    return true;
  }
  if (chatWindow.isMinimized()) {
    chatWindow.restore();
    chatWindow.focus();
    return true;
  }
  if (chatWindow.isVisible()) {
    chatWindow.hide();
    return false;
  }
  chatWindow.show();
  chatWindow.focus();
  return true;
}

function hideChat() {
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.hide();
}

function minimizeChat() {
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.minimize();
}

module.exports = { createChatWindow, getChatWindow, toggleChat, hideChat, minimizeChat, setVisibilityHandler };
