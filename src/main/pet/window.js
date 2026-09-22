'use strict';

/**
 * 桌宠窗口
 *
 * 窗口是「宠物本体 + 上下对话框区」的矩形，其余部分透明（点击穿透）。
 *
 * 布局（默认 scale=1 时 320×958 = 宠物 192×208 居中 + 上方 380 + 下方 370）：
 *   ┌────────────────┐  ← 窗口 320 × 958
 *   │  上方对话框区   │     气泡 / 进度卡 / 菜单默认显示在宠物上方
 *   │   宠物 192×208 │     水平居中
 *   │  透明下方缓冲区 │
 *   └────────────────┘
 *
 * 宠物可自由拖到屏幕任意位置；对话框和菜单固定锚定在宠物头顶。
 */
const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

const { getConfig, saveConfig } = require('../config');

const PET_W = 192;
const PET_H = 208;
const PAD_X = 64; // 左右留白：容纳头顶对话框的水平宽度
const PAD_TOP = 380; // 上方：容得下配置向导与菜单全部展开
const PAD_BOTTOM = 16; // 下方透明缓冲，和渲染层 --pad-b 保持一致

let petWindow = null;
let ignoringMouse = false;
let cursorWatchTimer = null;

function computeSize(scale) {
  // 上限 2：scale=3 在 768p 笔记本上会顶出屏幕（704×992），钳制以保可用。
  const s = Math.max(0.5, Math.min(2, Number(scale) || 1));
  const petW = Math.round(PET_W * s);
  const petH = Math.round(PET_H * s);
  return {
    width: petW + PAD_X * 2,
    height: petH + PAD_TOP + PAD_BOTTOM,
    petW,
    petH,
    scale: s
  };
}

/** 由窗口尺寸推宠物矩形（宠物水平居中、顶部在 PAD_TOP） */
function petRectAt(winX, winY, w, h) {
  const petW = w - PAD_X * 2;
  const petH = h - PAD_TOP - PAD_BOTTOM;
  return {
    x: Math.round(winX + (w - petW) / 2),
    y: winY + PAD_TOP,
    width: petW,
    height: petH
  };
}

/** 由宠物矩形反推窗口位置 */
function windowPosForPet(petX, petY, w) {
  const petW = w - PAD_X * 2;
  return { x: Math.round(petX - (w - petW) / 2), y: Math.round(petY - PAD_TOP) };
}

/** 当前宠物屏幕矩形 + 所在显示器工作区。 */
function getPetBounds() {
  if (!petWindow || petWindow.isDestroyed()) return null;
  try {
    const b = petWindow.getBounds();
    const pet = petRectAt(b.x, b.y, b.width, b.height);
    const { workArea } = screen.getDisplayMatching(pet);
    return { pet, workArea };
  } catch {
    return null;
  }
}

/* -------- 宠物边界广播 -------- */

let boundsTimer = null;

function emitPetBounds() {
  if (!petWindow || petWindow.isDestroyed()) return;
  try {
    const data = getPetBounds();
    if (data) petWindow.webContents.send('pet:bounds', data);
  } catch {
    /* 窗口可能在发送瞬间被关闭 */
  }
}

/** 节流广播（拖动时 move 事件每帧触发） */
function notifyPetBoundsSoon() {
  if (boundsTimer) return;
  boundsTimer = setTimeout(() => {
    boundsTimer = null;
    emitPetBounds();
  }, 60);
}

/**
 * `setIgnoreMouseEvents(true)` 后，Windows 不保证渲染层能继续收到足够的
 * 移动事件来重新命中宠物。穿透期间由主进程提供光标坐标，避免鼠标一旦离开
 * 宠物就再也无法点回来的死锁。
 */
function getCursorPosition() {
  if (!petWindow || petWindow.isDestroyed()) return null;
  const point = screen.getCursorScreenPoint();
  const bounds = petWindow.getBounds();
  return { x: point.x - bounds.x, y: point.y - bounds.y };
}

function emitCursorPosition() {
  if (!ignoringMouse || !petWindow || petWindow.isDestroyed()) return;
  try {
    const point = getCursorPosition();
    if (point) petWindow.webContents.send('pet:pointer', point);
  } catch {
    /* 窗口销毁或显示器查询失败时，下次状态切换会重试。 */
  }
}

function stopCursorWatch() {
  if (!cursorWatchTimer) return;
  clearInterval(cursorWatchTimer);
  cursorWatchTimer = null;
}

function startCursorWatch() {
  if (cursorWatchTimer) return;
  emitCursorPosition();
  cursorWatchTimer = setInterval(emitCursorPosition, 50);
}

/**
 * 计算宿主窗口位置，使可见宠物矩形而不是透明宿主窗口贴住工作区右下角。
 * workArea 可注入，供无 Electron 屏幕对象的几何回归测试复用。
 */
function bottomRightPosition(size, displayWorkArea) {
  const workArea = displayWorkArea || screen.getPrimaryDisplay().workArea;
  const marginX = 24;
  const marginY = 10;
  const petW = Number(size.petW) || Math.max(0, size.width - PAD_X * 2);
  const petH = Number(size.petH) || Math.max(0, size.height - PAD_TOP - PAD_BOTTOM);

  // 宿主窗口允许落在 workArea 外（它包含透明的上下缓冲区），但宠物矩形
  // 在可容纳时始终完整落在工作区内。工作区小于宠物本体时只能贴近原点，
  // 避免额外的宿主窗口钳制把本体推离屏幕。
  const petX = workArea.width >= petW
    ? Math.max(workArea.x, workArea.x + workArea.width - marginX - petW)
    : workArea.x;
  const petY = workArea.height >= petH
    ? Math.max(workArea.y, workArea.y + workArea.height - marginY - petH)
    : workArea.y;
  return {
    x: Math.round(petX - PAD_X),
    y: Math.round(petY - PAD_TOP)
  };
}

function createPetWindow() {
  if (petWindow && !petWindow.isDestroyed()) return petWindow;
  const cfg = getConfig();
  const size = computeSize(cfg.pet.scale);
  const pos = bottomRightPosition(size);

  petWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    alwaysOnTop: false,
    skipTaskbar: false, // 需求：任务栏要能看到图标
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'PPtor',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  const isSmokeWin = process.argv.includes('--smoke');
  petWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'), isSmokeWin ? { query: { smoke: '1' } } : {});

  petWindow.once('ready-to-show', () => {
    saveConfig({ pet: { hidden: false } });
    setIgnoreMouse(false);
    moveToBottomRight();
    petWindow.show();
    emitPetBounds();
  });

  // 拖动/程序性移动都会触发 move；缩放触发 resize：节流广播。
  petWindow.on('move', notifyPetBoundsSoon);
  petWindow.on('resize', notifyPetBoundsSoon);

  petWindow.on('focus', () => {
    if (petWindow && !petWindow.isDestroyed()) petWindow.moveTop();
  });

  petWindow.on('closed', () => {
    stopCursorWatch();
    ignoringMouse = false;
    petWindow = null;
  });

  return petWindow;
}

function getPetWindow() {
  return petWindow;
}

/** 拖动：按增量移动，不限制桌宠在屏幕边缘的位置。 */
function moveBy(dx, dy) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const [x, y] = petWindow.getPosition();
  const nx = Math.round(x + dx);
  const ny = Math.round(y + dy);
  // 取整后位置没变就不调 setPosition：拖动时每帧都省一次窗口重排
  if (nx === Math.round(x) && ny === Math.round(y)) return;
  petWindow.setPosition(nx, ny);
}

/** 鼠标穿透：ignore = true 时事件透传给下层窗口 */
function setIgnoreMouse(ignore) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const next = !!ignore;
  if (next === ignoringMouse) return;
  ignoringMouse = next;
  petWindow.setIgnoreMouseEvents(next, { forward: true });
  if (next) startCursorWatch();
  else stopCursorWatch();
}

/** 应用缩放：保持宠物右下角锚点，不修改用户拖出的屏幕位置。 */
function applyScale(scale) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const b = petWindow.getBounds();
  const oldRect = petRectAt(b.x, b.y, b.width, b.height);
  const size = computeSize(scale);

  const desired = {
    x: oldRect.x + oldRect.width - size.petW,
    y: oldRect.y + oldRect.height - size.petH,
    width: size.petW,
    height: size.petH
  };
  const pos = windowPosForPet(desired.x, desired.y, size.width);

  petWindow.setBounds({ x: pos.x, y: pos.y, width: size.width, height: size.height });
  saveConfig({ pet: { scale: size.scale } });
}

/** 保持当前拖动位置，并广播最新宠物边界。 */
function ensureVisible() {
  if (!petWindow || petWindow.isDestroyed()) return;
  emitPetBounds();
}

function setAlwaysOnTop(on) {
  saveConfig({ pet: { alwaysOnTop: !!on } });
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setAlwaysOnTop(!!on, 'floating');
  }
}

/** 激活并提升窗口至最顶层（点击宠物时触发） */
function bringToTop() {
  if (!petWindow || petWindow.isDestroyed()) return;
  try {
    petWindow.setAlwaysOnTop(true, 'floating');
  } catch { /* ignore */ }
  petWindow.moveTop();
  if (!petWindow.isFocused()) {
    petWindow.focus();
  }
}

/** 宠物隐藏后恢复：回到主屏幕右下角。 */
function moveToBottomRight() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const cfg = getConfig();
  const size = computeSize(cfg.pet?.scale);
  const pos = bottomRightPosition(size);
  petWindow.setPosition(pos.x, pos.y);
  emitPetBounds();
}

module.exports = {
  createPetWindow,
  getPetWindow,
  getPetBounds,
  getCursorPosition,
  moveBy,
  setIgnoreMouse,
  applyScale,
  ensureVisible,
  setAlwaysOnTop,
  bringToTop,
  moveToBottomRight,
  computeSize,
  petRectAt,
  windowPosForPet,
  bottomRightPosition
};
