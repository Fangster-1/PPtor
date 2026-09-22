'use strict';

/* 宠物窗入口：启动、事件接线、主进程动作分发、自动化探针 */

async function boot() {
  state.config = await api.getConfig();
  state.env = await api.detectEnv();
  state.lastTranslatedFiles = (state.config && Array.isArray(state.config.lastFiles)) ? state.config.lastFiles : [];

  await loadPet();

  bindEvents();
  // 主进程收到该信号后才开始首次检测，避免状态完成事件早于菜单监听器而丢失。
  try { await api.connectivityReady?.(); } catch { /* 主进程尚未升级时保持兼容 */ }

  // 首屏先保持可点击；随后按当前光标位置决定是否穿透。不能先全窗穿透，
  // 否则 Windows 上可能收不到让宠物恢复接收事件的第一条移动消息。
  forceInteractive(true);
  try { onPetPointer(await api.petPointer?.()); } catch { /* 指针查询失败时保持可点击 */ }

  setTimeout(firstGreeting, 700);
}

/* ============================== 宠物资源 ============================== */

async function loadPet() {
  const res = await api.loadPet('');

  if (!res.ok) {
    fatal(`宠物资源加载失败：${res.message}`);
    return;
  }

  const pet = res.pet;
  state.pet = pet;
  state.spec = pet.spec;
  state.states = new Map(pet.states.map((s) => [s.id, s]));

  applyScaleToUI(pet.scale || 1);
  if (pet.accent) document.documentElement.style.setProperty('--accent', pet.accent);

  setAnim('idle', { restart: true });

  console.log(`[pet] 已加载 ${pet.displayName}（矢量形态，${pet.states.length} 个状态，缩放 ${state.scale}）`);
}

/**
 * 把缩放落到界面上：改 state.scale 与 CSS 变量（--pet-w/--pet-h）。
 * 宠物是矢量 SVG，随容器自动缩放；窗口尺寸由主进程按右下角锚点调整。
 */
function applyScaleToUI(scale) {
  if (!state.spec) return false;
  state.scale = scale;

  const cw = Math.round(state.spec.cellWidth * scale);
  const ch = Math.round(state.spec.cellHeight * scale);

  document.documentElement.style.setProperty('--pet-w', `${cw}px`);
  document.documentElement.style.setProperty('--pet-h', `${ch}px`);

  return true;
}

/**
 * Ctrl + 滚轮缩放桌宠。
 * 同时通知主进程调整窗口尺寸（主进程会把右下角锚住，视觉上不跳）。
 *
 * 注意：界面没更新成功就绝不改窗口尺寸 —— 否则窗口缩了、精灵图还是旧尺寸，
 * 看起来就是「缩放后桌宠消失了」。
 */
function onPetWheel(e) {
  if (!e.ctrlKey) return;
  e.preventDefault();

  if (!state.spec) return; // 宠物还没加载完，忽略

  const step = e.deltaY < 0 ? 0.1 : -0.1;
  const next = Math.max(0.5, Math.min(2, Math.round((state.scale + step) * 100) / 100));
  if (next === state.scale) return;

  if (applyScaleToUI(next)) {
    api.setPetScale(next);
  }
}

function fatal(message) {
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;left:8px;right:8px;bottom:8px;padding:12px;background:#fff;' +
    'border-radius:12px;font-size:12px;color:#cf222e;pointer-events:auto;z-index:99';
  box.textContent = message;
  document.body.appendChild(box);
}

/* ============================== 事件绑定 ============================== */

function bindEvents() {
  window.addEventListener('mousedown', () => {
    try { api.bringToTop?.(); } catch { /* ignore */ }
    dismissOnboardingNotice();
  });
  window.addEventListener('blur', dismissOnboardingNotice);
  $('pet').addEventListener('pointerdown', onPetPointerDown);
  $('pet').addEventListener('pointermove', onPetPointerMove);
  $('pet').addEventListener('pointerup', onPetPointerUp);
  $('pet').addEventListener('pointercancel', onPetPointerCancel);
  $('pet').addEventListener('lostpointercapture', onPetLostPointerCapture);
  $('cancelJob').addEventListener('click', onCancelJobClick);
  // Ctrl + 滚轮缩放桌宠（需要 passive:false 才能 preventDefault）
  $('pet').addEventListener('wheel', onPetWheel, { passive: false });

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    toggleMenuPanel();
  });

  bindMenuPanelEvents();

  let mouseIgnoreRaf = null;
  let lastMousePoint = { x: 0, y: 0 };
  document.addEventListener('pointermove', (e) => {
    lastMousePoint.x = e.clientX;
    lastMousePoint.y = e.clientY;
    lastMouseClient.x = e.clientX;
    lastMouseClient.y = e.clientY;
    // 拖动窗口期间跳过穿透检测：此时窗口必须保持可交互，
    // 逐帧做 elementFromPoint + IPC 是拖动卡顿的主要来源，松手后补算一次即可。
    if (state.dragging) return;
    if (mouseIgnoreRaf) return;
    mouseIgnoreRaf = requestAnimationFrame(() => {
      mouseIgnoreRaf = null;
      updateIgnoreMouse(lastMousePoint.x, lastMousePoint.y);
    });
  });

  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);

  // 粘贴读取：复制 PDF 后按 Ctrl+V
  document.addEventListener('paste', onPaste);

  // Esc：确认类气泡（等待用户抉择）不可丢弃，否则任务卡死；进度条可点击召回。
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isMenuPanelVisible()) hideMenuPanel();
      else if (state.askOpen) {
        say('请先点气泡里的按钮确认，否则任务会一直等你。', 5000);
      }
      else hideBubble();
    }
  });
  $('progress')?.addEventListener('click', () => {
    if (state.busy && state.task.waiting && state.lastAsk) {
      showAsk(state.lastAsk);
    }
  });

  document.addEventListener('visibilitychange', onVisibilityChange);

  // 清理旧版自适应布局类；当前菜单和对话框始终固定在宠物头顶。
  try { api.petBounds?.().then(updateDialogPlacement).catch(() => {}); } catch { /* ignore */ }
  api.onPetBounds?.(updateDialogPlacement);
  api.onPetPointer?.(onPetPointer);

  api.onProgress(onProgress);
  api.onAction(onAction);
}

/* ============================== 使用说明 ============================== */

function showHelp() {
  renderBubble({
    title: '使用指南',
    texts: [
      '【翻译】拖 PDF 到我身上 / Ctrl+V 粘贴 / 右键选文件；忙时自动排队。\n' +
      '【输出】右键菜单切换排版、双语/纯译文、PDF/Word/MD/HTML。\n' +
      '【问答】右键「论文问答」打开聊天窗；每个任务是独立会话。\n' +
      '【宠物】拖动移动 · Ctrl+滚轮缩放 · 单击看状态 · Esc 收起气泡。'
    ],
    actions: [{ label: '知道了', variant: 'primary', onClick: hideBubble }]
  });
}

/* ============================== 主进程动作 ============================== */

function onAction(msg) {
  if (!msg) return;
  const { action, payload } = msg;

  if (state.busy && !['ask', 'toast', 'translateFiles'].includes(action)) {
    say('当前任务正在进行，完成后再打开这个功能。', 2600);
    return;
  }

  switch (action) {
    case 'translateFiles':
      handleFiles(payload || []);
      break;

    case 'ask':
      showAsk(payload);
      break;

    case 'pet:shown':
      hideBubble();
      hideMenuPanel();
      // 主进程召回前会关闭鼠标穿透；同步渲染层状态后再按当前光标重算，
      // 避免两端状态不一致时透明宿主窗口短暂挡住桌面点击。
      forceInteractive(true);
      try { api.petPointer?.().then(onPetPointer).catch(() => {}); } catch { /* 保持可交互 */ }
      break;

    case 'wizard:translate':
      wizardTranslate(false);
      break;

    case 'wizard:parser':
      wizardParser(false);
      break;

    case 'help':
      showHelp();
      break;

    case 'toast':
      say(payload, 4000);
      break;

    case 'connectivity:start':
      handleConnectivityStart(payload || {});
      break;

    case 'connectivity:done':
      handleConnectivityDone(payload || {});
      break;

    default:
      break;
  }
}

/* ==================================================================== */

boot().catch((err) => fatal(`界面初始化失败：${err.message || err}`));

// 调试探针：自动化自检（--smoke）会读它来确认界面状态
window.__pt = state;
// UI 回归探针仅在 smoke/dev 下挂载，避免生产版被任意驱动伪造“翻译完成”气泡。
if (location.search.includes('smoke') || location.search.includes('debug') || location.protocol !== 'file:') {
  window.__ptTest = {
    setAnim: (name) => setAnim(String(name || 'idle'), { source: 'task', restart: true }),
    onProgress,
    showStatus: (name, message = '') => {
      state.busy = true;
      state.task.phase = String(name || 'idle');
      state.task.message = String(message || '');
      state.task.progress = 50;
      setTaskAnimation(state.task.phase, true);
      showProgress(state.task.progress, state.task.message);
      updateStatusUI();
    },
    finish: () => {
      finishTask();
      setAnim('complete', { source: 'task', restart: true });
    },
    cancel: requestCancel
  };
}
