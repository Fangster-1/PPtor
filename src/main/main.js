'use strict';

/**
 * 主进程入口
 *
 * 这是一个「桌宠形态」的应用：
 *   - 窗口是透明、无边框、置顶的小方块，宠物住在里面
 *   - 配置全部收在右键菜单 + 宠物气泡里
 *   - 问答走独立的微信式聊天窗口（chat/window.js）
 *   - 关掉窗口不退出，靠托盘常驻
 *
 * 结构：窗口/托盘/菜单/IPC 的接线在 createController；
 * 连通性状态机用 createConnectivityTracker 工厂（模型与解析器共用一套逻辑）；
 * 托盘状态圆点图标在 assets/tray-dot.js。
 */
const { app, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { initStore, getConfig, saveConfig } = require('./config');
const { configFile, cacheDir } = require('./paths');
const petWin = require('./pet/window');
const chatWin = require('./chat/window');
const { createTray, refreshTray } = require('./tray');
const { buildPetMenu } = require('./menu');
const { registerIpc, shutdownIpc } = require('./ipc');
const { initCache, initGlossary, checkConnectivity } = require('./core/translator');
const { checkParserConnectivity } = require('./core/parser');
const { getTrayDotIcon } = require('./assets/tray-dot');

/** 聊天窗验收：复用 smoke 的数据目录隔离策略 */
const isChatSmoke = process.argv.includes('--chat-smoke');
if (isChatSmoke && !process.argv.includes('--smoke')) {
  process.argv.push('--smoke'); // 仅供 paths.js / 隔离逻辑识别，不触发完整 smoke
}

/** 自检模式：启动、加载宠物、把渲染层日志回传，然后退出 */
const isSmoke = process.argv.includes('--smoke') && !isChatSmoke;
// GPU smoke 仅用于诊断显卡/驱动环境；产品本身不依赖 WebGL。
const useGpuDiagnostic = isSmoke && process.argv.includes('--smoke-gpu');
const forceDisableGpu = process.argv.includes('--disable-gpu');

if ((isSmoke || isChatSmoke) && !String(process.env.PPTOR_DATA_DIR || '').trim()) {
  // 让 smoke / chat-smoke 的 settings/cache/registry 与用户目录完全分离；paths.js 只在 smoke 下读取它。
  process.env.PPTOR_DATA_DIR = path.join(os.tmpdir(), 'pptor-smoke', String(process.pid));
}

// 仅在 smoke 自测隔离环境（且非显卡诊断）或显式指定 --disable-gpu 时关闭硬件加速。
// 正常日常桌面交互默认开启硬件加速，大幅降低透明桌宠与序列帧动画的 CPU 软解消耗。
if ((isSmoke && !useGpuDiagnostic) || forceDisableGpu) {
  // 无显卡环境（CI / 远程桌面 / 容器）下也能跑通自检。
  app.disableHardwareAcceleration();
}

app.setAppUserModelId('com.pptor.translator');

// 固定 userData 路径为 paper-translator，保持 safeStorage 凭据加密密钥一致性
// （自检类运行使用隔离目录，避免触碰真实凭据与 Local Storage）
app.setPath(
  'userData',
  (isSmoke || isChatSmoke)
    ? path.join(process.env.PPTOR_DATA_DIR, 'userData')
    : path.join(app.getPath('appData'), 'paper-translator')
);

let isQuitting = false;
let trayCtx = null;

/* ================================================================== *
 * 连通性状态机（模型 / 解析器共用一套逻辑，取代原先两份复制实现）
 * ================================================================== */

/**
 * @param {object} p
 * @param {'model'|'parser'} p.target        事件目标
 * @param {() => boolean} p.isConfigured     是否已配置（未配置直接置 unconfigured）
 * @param {() => Promise<{ok:boolean, reason?:string, sample?:string}>} p.runCheck
 * @param {() => void} p.onStateChange       状态变化回调（刷新托盘/自旋动画）
 * @param {(action:string, payload:object) => void} p.sendToPet
 */
function createConnectivityTracker({ target, isConfigured, runCheck, onStateChange, sendToPet }) {
  let status = 'idle';
  let testing = false;
  let activePromise = null;
  // 每次检测/配置确认都取得新的序号。旧请求即使晚返回，也绝不能把托盘和
  // 页面已经确认的状态改回“测试中”或“失败”。
  let requestId = 0;

  async function test({ force = false } = {}) {
    if (activePromise && !force) return activePromise;
    const myId = ++requestId;
    if (!isConfigured()) {
      status = 'unconfigured';
      testing = false;
      activePromise = null;
      onStateChange();
      sendToPet('connectivity:done', { target, requestId: myId, ok: false, reason: 'unconfigured' });
      return { ok: false, reason: 'unconfigured' };
    }

    testing = true;
    status = 'testing';
    onStateChange();
    sendToPet('connectivity:start', { target, requestId: myId });

    const task = (async () => {
      let result = { ok: false };
      try {
        result = await runCheck();
      } catch (err) {
        result = { ok: false, reason: err.message || '连接失败' };
      } finally {
        // 用户刚刷新、重新配置或向导已完成真实试译时，本请求已过期。
        if (myId !== requestId) return;
        status = result.ok ? 'ok' : 'error';
        testing = false;
        if (activePromise === task) activePromise = null;
        onStateChange();
        sendToPet('connectivity:done', { target, requestId: myId, ok: result.ok, reason: result.reason, sample: result.sample });
      }
      return result;
    })();
    activePromise = task;
    return task;
  }

  /** 渲染层（向导“测试并保存”）直接确认状态 */
  function setStatus(next, details = {}) {
    requestId += 1;
    status = next;
    testing = false;
    activePromise = null;
    onStateChange();
    sendToPet('connectivity:done', {
      target, requestId, ok: next === 'ok', reason: details.reason, sample: details.sample
    });
  }

  return {
    test,
    setStatus,
    getStatus: () => status,
    isTesting: () => testing,
    currentRequestId: () => requestId
  };
}

/* ================================================================== *
 * 控制器：把窗口 / 托盘 / 菜单 / IPC 串起来
 * ================================================================== */

function createController() {
  const sendToPet = (action, payload) => {
    const win = petWin.getPetWindow();
    if (win && !win.isDestroyed()) win.webContents.send('pet:action', { action, payload });
  };

  const showPet = () => {
    const win = petWin.getPetWindow();
    if (!win || win.isDestroyed()) {
      createWindow();
      return;
    }
    const wasHidden = !win.isVisible();
    saveConfig({ pet: { hidden: false } });
    if (wasHidden) {
      // 需求：宠物隐藏之后，点击软件图标就默认在右下角打开宠物
      try {
        if (win.isMinimized()) win.restore();
        petWin.setIgnoreMouse(false);
        petWin.moveToBottomRight();
      } catch { /* ignore */ }
    } else {
      try {
        petWin.ensureVisible();
      } catch { /* ignore */ }
    }
    win.show();
    // 需求：点击显示宠物后宠物默认显示在所有软件最上层
    try {
      win.setAlwaysOnTop(true, 'floating');
    } catch { /* ignore */ }
    if (typeof petWin.bringToTop === 'function') {
      petWin.bringToTop();
    } else {
      win.moveTop();
      win.focus();
    }
    // 隐藏重新显示后通知前端收起所有历史气泡/对话框
    sendToPet('pet:shown');
    refreshTray(trayCtx);
  };

  const hidePet = () => {
    saveConfig({ pet: { hidden: true } });
    const win = petWin.getPetWindow();
    if (win) win.hide();
    refreshTray(trayCtx);
  };

  /** 聊天窗打开时临时收起宠物（不写 hidden 配置，关窗即恢复） */
  const hidePetTemporarily = () => {
    const win = petWin.getPetWindow();
    if (win && !win.isDestroyed() && win.isVisible()) {
      win.hide();
      refreshTray(trayCtx);
    }
  };

  /** 聊天窗关闭后恢复宠物（保持既有的置顶与召回规则） */
  const showPetBack = () => {
    const win = petWin.getPetWindow();
    if (!win || win.isDestroyed()) return;
    // 聊天窗临时收起后只在确实隐藏时召回；已显示的普通事件不能重置位置。
    if (!win.isVisible()) {
      try {
        if (win.isMinimized()) win.restore();
        petWin.setIgnoreMouse(false);
        petWin.moveToBottomRight();
        win.show();
      } catch { /* ignore */ }
    }
    const cfg = getConfig();
    if (cfg.pet?.alwaysOnTop !== false) {
      try { win.setAlwaysOnTop(true, 'floating'); } catch { /* ignore */ }
    }
    refreshTray(trayCtx);
  };

  const quit = () => {
    isQuitting = true;
    app.quit();
  };

  const askForPdf = async () => {
    const r = await dialog.showOpenDialog(petWin.getPetWindow(), {
      title: '选择要翻译的论文',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
    });
    if (r.canceled || !r.filePaths.length) return;
    showPet();
    sendToPet('translateFiles', r.filePaths);
  };

  /** 翻译文档库：所有译文归档的根目录（相当于备份位置） */
  const askForLibraryDir = async () => {
    const r = await dialog.showOpenDialog(petWin.getPetWindow(), {
      title: '选择翻译文档库（所有译文都归档到这里）',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths[0]) return;
    saveConfig({ output: { libraryDir: r.filePaths[0] } });
    refreshTray(trayCtx);
    sendToPet('toast', `翻译文档库已设为：${r.filePaths[0]}`);
  };

  /* ------------------------ 托盘自旋动画（模型/解析器共享） ------------------------ */

  const SPIN_FRAMES = ['🗘', '⭮', '⮔', '⭯'];
  let spinFrame = 0;
  let spinTimer = null;

  const startSpinning = () => {
    if (spinTimer) return;
    // 降低到 500ms，且测试期间不重建菜单（避免 150ms 高频 buildFromTemplate 闪烁/CPU）。
    spinTimer = setInterval(() => {
      spinFrame = (spinFrame + 1) % SPIN_FRAMES.length;
    }, 500);
  };

  const syncTray = () => {
    if (modelTracker.isTesting() || parserTracker.isTesting()) {
      startSpinning();
    } else if (spinTimer) {
      clearInterval(spinTimer);
      spinTimer = null;
      spinFrame = 0;
    }
    refreshTray(trayCtx);
  };

  /* ------------------------ 连通性追踪器 ×2 ------------------------ */

  const modelTracker = createConnectivityTracker({
    target: 'model',
    isConfigured: () => !!getConfig().translate?.apiKey,
    // 启动/刷新只验证 Key、网络与服务端鉴权。模型的真实翻译试跑仍在配置向导
    // “测试并保存” 中执行，避免右键状态灯因旧模型名或一次生成请求而长期卡在测试中。
    runCheck: () => checkConnectivity(getConfig().translate),
    onStateChange: syncTray,
    sendToPet
  });

  const parserTracker = createConnectivityTracker({
    target: 'parser',
    isConfigured: () => {
      const p = getConfig().parser;
      return p?.mode === 'local' || !!p?.mineruToken;
    },
    runCheck: () => checkParserConnectivity(getConfig().parser),
    onStateChange: syncTray,
    sendToPet
  });

  // 渲染层绑定 pet:action 后才开始首次检测，确保“完成”事件不会在监听器建立前丢失。
  let connectivityChecksStarted = false;
  const startConnectivityChecks = () => {
    if (connectivityChecksStarted) return;
    connectivityChecksStarted = true;
    void modelTracker.test();
    void parserTracker.test();
  };

  /* ------------------------ 菜单与动作分发 ------------------------ */

  /** 菜单动作分发：需要复杂输入的转交渲染层由宠物引导 */
  const onAction = (action, payload) => {
    switch (action) {
      case 'pickAndTranslate':
        askForPdf();
        break;

      case 'pasteTranslate':
        sendToPet('pasteTranslate');
        break;

      case 'qa:open':
      case 'chat:open':
        chatWin.toggleChat();
        break;

      case 'pick:libraryDir':
        askForLibraryDir();
        break;

      case 'open:libraryDir': {
        const cfg = getConfig();
        const dir = cfg.output && cfg.output.libraryDir;
        if (dir && fs.existsSync(dir)) {
          shell.openPath(dir);
        } else {
          showPet();
          sendToPet('toast', dir ? `文档库路径不存在：${dir}` : '尚未设置翻译文档库（默认保存在源文件同目录）');
        }
        break;
      }

      case 'refresh':
        refreshTray(trayCtx);
        break;

      case 'testModelConnection':
        void modelTracker.test({ force: true });
        break;

      case 'testParserConnection':
        void parserTracker.test({ force: true });
        break;

      case 'pet:scale':
        petWin.applyScale(payload);
        break;

      case 'pet:hide':
        hidePet();
        break;

      case 'help':
      case 'wizard:translate':
      case 'wizard:parser':
      case 'toast':
        showPet();
        sendToPet(action, payload);
        break;

      default:
        sendToPet(action, payload);
    }
  };

  const menuCtx = {
    onAction,
    onQuit: quit,
    getModelStatus: modelTracker.getStatus,
    getParserStatus: parserTracker.getStatus,
    getSpinFrame: () => spinFrame
  };

  const buildMenu = () => buildPetMenu(menuCtx);

  const buildTrayMenu = () => {
    const cfg = getConfig();
    const win = petWin.getPetWindow();
    const visible = !!(win && win.isVisible());

    const items = [];
    // 常驻召回入口：隐藏时也提供“显示宠物/拉回屏幕”，解决找回不可发现问题。
    if (visible) {
      items.push({ label: '隐藏宠物', click: hidePet });
    } else {
      items.push({ label: '显示宠物', click: showPet });
    }
    items.push({ type: 'separator' });
    const parserModeName = cfg.parser?.mode === 'local' ? '本地 MinerU' : '云端 API';

    items.push(
      { label: '翻译论文…', click: askForPdf },
      { type: 'separator' },
      { label: '论文问答…', click: () => onAction('chat:open') },
      { type: 'separator' },
      {
        label: cfg.translate?.apiKey ? `模型：${cfg.translate.model}` : '模型：未配置',
        icon: getTrayDotIcon(cfg.translate?.apiKey ? modelTracker.getStatus() : 'unconfigured'),
        click: () => onAction('wizard:translate')
      },
      {
        label: cfg.parser?.mode === 'local' || cfg.parser?.mineruToken
          ? `解析：${parserModeName}`
          : `解析：${parserModeName}（未配置）`,
        icon: getTrayDotIcon(
          cfg.parser?.mode === 'local' || cfg.parser?.mineruToken ? parserTracker.getStatus() : 'unconfigured'
        ),
        click: () => onAction('wizard:parser')
      },
      { type: 'separator' },
      { label: '退出', click: quit }
    );
    return items;
  };

  return {
    onAction,
    buildMenu,
    refreshMenu: () => {
      refreshTray(trayCtx);
    },
    showPet,
    hidePet,
    testModelConnectivity: (options) => modelTracker.test(options),
    testParserConnectivity: (options) => parserTracker.test(options),
    startConnectivityChecks,
    getModelStatus: modelTracker.getStatus,
    getParserStatus: parserTracker.getStatus,
    getConnectivityStatus: () => ({
      model: modelTracker.getStatus(),
      parser: parserTracker.getStatus(),
      modelRequestId: modelTracker.currentRequestId(),
      parserRequestId: parserTracker.currentRequestId()
    }),
    setModelStatus: (status, details) => modelTracker.setStatus(status, details),
    setParserStatus: (status, details) => parserTracker.setStatus(status, details),
    onQuit: quit,
    start() {
      trayCtx = { buildTrayMenu, onShowPet: showPet };
      createWindow();
      createTray(trayCtx);
      // 聊天窗打开时把宠物临时收进窗口头部；关闭聊天窗后宠物回到桌面
      chatWin.setVisibilityHandler((visible) => {
        if (visible) hidePetTemporarily();
        else showPetBack();
      });
      // 正常情况下由 renderer:ready 触发；兜底避免前端加载异常时永远不检测。
      setTimeout(startConnectivityChecks, 8000);
      // 明文回退必须让用户感知一次（便携包复制即带走 Key 的风险提示）
      try {
        const { wasPlaintextFallback, clearPlaintextFallback } = require('./config');
        if (wasPlaintextFallback()) {
          clearPlaintextFallback();
          setTimeout(() => sendToPet('toast', '提醒：当前 API Key 未能加密（safeStorage 不可用），为明文保存。请勿将本目录随意分享。'), 2500);
        }
      } catch { /* ignore */ }
    }
  };
}

/* ================================================================== *
 * 窗口
 * ================================================================== */

function createWindow() {
  const win = petWin.createPetWindow();

  // 关窗只隐藏，避免用户手滑就把常驻的宠物关没了
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
      saveConfig({ pet: { hidden: true } });
      refreshTray(trayCtx);
    }
  });

  return win;
}

/* ================================================================== *
 * 启动
 * ================================================================== */

let controller = null;

// smoke / chat-smoke 使用隔离数据目录，不能因桌面上已有 PPtor 实例而报告“成功但没测到”。
const gotSingleLock = (isSmoke || isChatSmoke) ? true : app.requestSingleInstanceLock();

if (!gotSingleLock) {
  // 已经有一个实例持有单实例锁。
  // 正常情况：用户重复双击 → 唤起已有实例即可。
  // 异常情况：上次异常退出留下的孤儿进程占着锁 → 必须告诉用户，否则表现为「双击没反应」。
  app.on('ready', () => {
    if (isSmoke) {
      // 自检模式：直接报告，不弹窗（避免无人值守时卡住）
      console.log('[smoke] 单实例锁被占用 —— 已有另一个实例在运行');
      app.exit(0);
      return;
    }

    dialog.showMessageBoxSync({
      type: 'info',
      title: 'PPtor',
      message: '桌宠已经在运行了',
      detail:
        '看不到宠物的话，点系统托盘图标召回。\n' +
        '若上次异常退出留下了残留进程，请先结束 electron.exe 再启动：\n' +
        '    taskkill /F /IM electron.exe',
      buttons: ['知道了'],
      noLink: true
    });
    app.quit();
  });
} else {
  app.on('second-instance', () => {
    if (controller) controller.showPet();
  });

  app.whenReady().then(async () => {
    initStore();
    initGlossary(require('node:path').join(require('node:path').dirname(configFile()), 'glossary.txt'));
    const cacheReady = initCache(cacheDir()); // 后台读缓存，避免大缓存文件挡住桌宠首屏

    controller = createController();
    registerIpc({
      cacheReady,
      buildMenu: () => controller.buildMenu(),
      refreshMenu: () => controller.refreshMenu(),
      showPet: () => controller.showPet(),
      hidePet: () => controller.hidePet(),
      // 连通性 IPC 必须使用与托盘完全相同的 controller 实例；此前遗漏这些
      // 绑定会让右键“刷新”退回到假失败分支，rendererReady 也不会启动检测。
      testModelConnectivity: (options) => controller.testModelConnectivity(options),
      testParserConnectivity: (options) => controller.testParserConnectivity(options),
      startConnectivityChecks: () => controller.startConnectivityChecks(),
      getModelStatus: () => controller.getModelStatus(),
      getParserStatus: () => controller.getParserStatus(),
      getConnectivityStatus: () => controller.getConnectivityStatus(),
      setModelStatus: (status, details) => controller.setModelStatus(status, details),
      setParserStatus: (status, details) => controller.setParserStatus(status, details),
      onQuit: () => controller.onQuit()
    });
    controller.start();

    if (isSmoke) {
      const { runSmoke } = require('./smoke');
      runSmoke();
    } else if (isChatSmoke) {
      require('./chat-smoke').runChatSmoke();
    }

    app.on('activate', () => {
      if (!petWin.getPetWindow()) createWindow();
      else controller.showPet();
    });
  }).catch((err) => {
    console.error('[startup] 初始化失败：', err && err.stack ? err.stack : err);
    if (isSmoke) {
      app.exit(1);
      return;
    }
    dialog.showErrorBox('PPtor 启动失败', (err && err.message) || String(err));
    app.quit();
  });
}

// 桌宠常驻：关掉窗口不退出，退出只能走托盘或右键菜单
app.on('window-all-closed', () => {
  /* 故意留空 */
});

let shutdownPromise = null;
let shutdownComplete = false;
app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  isQuitting = true;
  if (!shutdownPromise) {
    shutdownPromise = shutdownIpc()
      .catch((err) => console.warn('[shutdown] 清理失败：', err.message))
      .finally(() => {
        shutdownComplete = true;
        app.quit();
      });
  }
});
