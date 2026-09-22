'use strict';

/* 拖动与鼠标穿透：Pointer Events 拖动窗口、点击宠物、动态穿透（setIgnoreMouseEvents） */

let moveRafId = null;
let pendingDx = 0;
let pendingDy = 0;

function flushPendingMove() {
  if (moveRafId) {
    cancelAnimationFrame(moveRafId);
    moveRafId = null;
  }
  if (pendingDx !== 0 || pendingDy !== 0) {
    api.moveBy(pendingDx, pendingDy);
    pendingDx = 0;
    pendingDy = 0;
  }
}

function updateIgnoreMouse(clientX, clientY) {
  // 气泡或菜单展开时保持窗口可交互，不启用动态穿透
  if (overlayVisible()) {
    if (state.ignoring) {
      state.ignoring = false;
      api.setIgnoreMouse(false);
    }
    return;
  }

  const el = document.elementFromPoint(clientX, clientY);
  const interactive = !!(el && el.closest && el.closest('.interactive'));
  const next = !interactive;

  if (next !== state.ignoring) {
    state.ignoring = next;
    api.setIgnoreMouse(next);
  }
}

function forceInteractive(on) {
  state.ignoring = !on;
  api.setIgnoreMouse(!on);
}

/** 穿透期间由主进程采样的光标位置，用于重新命中宠物/已展开菜单。 */
function onPetPointer({ x, y } = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || state.dragging) return;
  lastMouseClient.x = x;
  lastMouseClient.y = y;
  updateIgnoreMouse(x, y);
}

function onPetPointerDown(e) {
  if (e.button !== 0 || (e.isPrimary === false && e.pointerType !== 'mouse')) return;
  if (isMenuPanelVisible()) hideMenuPanel();
  flushPendingMove();
  const pet = e.currentTarget || $('pet');
  if (pet && typeof pet.setPointerCapture === 'function' && Number.isFinite(e.pointerId)) {
    try { pet.setPointerCapture(e.pointerId); } catch { /* pointer may already be cancelled */ }
  }
  state.dragging = {
    pointerId: e.pointerId,
    startX: e.screenX,
    startY: e.screenY,
    lastX: e.screenX,
    lastY: e.screenY,
    moved: false
  };
  $('pet').classList.add('dragging');
  // 拖动开始即锁定为可交互，避免拖动中穿透检测反复开关窗口事件
  forceInteractive(true);
  if (!state.busy) setAnim('dragging', { source: 'interaction', restart: true });
  e.preventDefault();
}

function isDraggingPointer(e) {
  const d = state.dragging;
  return !!d && (e.pointerId == null || e.pointerId === d.pointerId);
}

function onPetPointerMove(e) {
  if (!isDraggingPointer(e)) return;
  const d = state.dragging;
  lastMouseClient.x = e.clientX;
  lastMouseClient.y = e.clientY;

  if (!d.moved && Math.hypot(e.screenX - d.startX, e.screenY - d.startY) > 4) d.moved = true;

  if (d.moved) {
    if (!state.busy && state.anim !== 'dragging') {
      setAnim('dragging', { source: 'interaction', restart: false });
    }
    pendingDx += e.screenX - d.lastX;
    pendingDy += e.screenY - d.lastY;
    d.lastX = e.screenX;
    d.lastY = e.screenY;

    if (!moveRafId) {
      moveRafId = requestAnimationFrame(() => {
        moveRafId = null;
        if (pendingDx !== 0 || pendingDy !== 0) {
          api.moveBy(pendingDx, pendingDy);
          pendingDx = 0;
          pendingDy = 0;
        }
      });
    }
  }
}

/** pointerup / pointercancel / lostpointercapture 共用收尾，避免拖动状态卡死。 */
function finishPointerDrag(e, allowClick) {
  if (!isDraggingPointer(e)) return;
  const d = state.dragging;
  $('pet').classList.remove('dragging');
  state.dragging = null;

  if (!d || !allowClick) {
    flushPendingMove();
    if (d && d.moved && lastMouseClient.x >= 0) {
      updateIgnoreMouse(lastMouseClient.x, lastMouseClient.y);
    }
    if (!d || state.busy) return;
    restoreAmbientAnimation();
    return;
  }
  if (d.moved) {
    flushPendingMove();
    // 拖动期间跳过了鼠标穿透检测，松手后按当前位置补算一次
    if (lastMouseClient.x >= 0) updateIgnoreMouse(lastMouseClient.x, lastMouseClient.y);
  } else {
    onPetClick();
  }
  // 点击会播放完整的 petting 演出；拖动才在松手后恢复待机。
  if (d.moved && !state.busy) restoreAmbientAnimation();
}

function onPetPointerUp(e) {
  finishPointerDrag(e, true);
}

function onPetPointerCancel(e) {
  finishPointerDrag(e, false);
}

function onPetLostPointerCapture(e) {
  finishPointerDrag(e, false);
}

/* 对话框和菜单始终锚定在宠物头顶，不因拖动或屏幕边缘改变位置。 */
function updateDialogPlacement() {
  document.documentElement.classList.remove('dlg-below', 'menu-below', 'dlg-left', 'dlg-right');
}

function onPetClick() {
  if (isMenuPanelVisible()) {
    hideMenuPanel();
    return;
  }
  playPetting();

  // 没配好 Key 时，点我 = 继续配置，不报告状态
  if (needsSetup()) {
    wizardTranslate(true);
    return;
  }

  if (state.busy) {
    say('正在翻译中，稍等一下…', 3000);
    return;
  }

  const cfg = state.config || {};
  const lines = [];

  lines.push(cfg.translate && cfg.translate.apiKey ? `模型：${cfg.translate.model}` : '还没配置翻译模型');
  lines.push(`输出：${(cfg.output && describeOutput(cfg.output)) || '-'}`);
  lines.push('拖入 PDF 翻译，右键打开菜单。');
  say(lines.join('\n'), 5200);
}
