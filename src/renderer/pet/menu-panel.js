'use strict';

/* 交互菜单栏（常驻控制面板）与连通性状态 UI */

function isMenuPanelVisible() {
  const m = $('menuPanel');
  return !!(m && !m.classList.contains('is-hidden'));
}

function refreshMenuPanelValues() {
  const cfg = state.config || {};
  const tr = cfg.translate || {};
  const pa = cfg.parser || {};
  const out = cfg.output || {};

  // 模型名与解析模式
  if ($('menuModelName')) {
    const hasKey = !!tr.apiKey;
    const name = tr.model || '未配置';
    $('menuModelName').textContent = hasKey ? name : (tr.model ? `${name}（未配Key）` : '未配置');
    $('menuModelName').title = hasKey ? `当前翻译模型：${name}` : '尚未配置 API Key，点击右侧设置';
  }

  const isLocal = pa.mode === 'local';
  if ($('menuParserName')) {
    $('menuParserName').textContent = isLocal ? '本地 MinerU' : '云端 API';
    $('menuParserName').title = isLocal ? '本地 MinerU 引擎' : 'MinerU 官方云端解析';
  }

  // 排版单选框
  const currentLayout = out.layout || 'generic';
  document.querySelectorAll('input[name="menuLayout"]').forEach((r) => {
    r.checked = (r.value === currentLayout);
  });

  // 内容单选框
  const currentContent = out.content || 'mono';
  document.querySelectorAll('input[name="menuContent"]').forEach((r) => {
    r.checked = (r.value === currentContent);
  });

  // 格式复选框（可多选）
  const fmts = new Set(Array.isArray(out.formats) ? out.formats : ['pdf']);
  if ($('fmtPdf')) $('fmtPdf').checked = fmts.has('pdf');
  if ($('fmtDocx')) $('fmtDocx').checked = fmts.has('docx');
  if ($('fmtMd')) $('fmtMd').checked = fmts.has('md');
  if ($('fmtHtml')) $('fmtHtml').checked = fmts.has('html');
}

async function showMenuPanel() {
  hideBubble();
  const menu = $('menuPanel');
  if (!menu) return;

  // 先让固定窗口内的面板参与布局，再读取主进程的状态快照。
  // 这不会发起网络请求；连通性只由启动、首次保存 Key 或手动刷新触发。
  menu.classList.remove('is-hidden');
  forceInteractive(true);
  refreshMenuPanelValues();
  try { updateDialogPlacement(await api.petBounds?.()); } catch { /* 菜单仍按默认头顶位置显示 */ }
  void updateMenuConnectivityUI();
}

function hideMenuPanel() {
  const menu = $('menuPanel');
  if (menu) menu.classList.add('is-hidden');
  forceInteractive(state.busy || overlayVisible());
}

function toggleMenuPanel() {
  if (isMenuPanelVisible()) {
    hideMenuPanel();
  } else {
    showMenuPanel();
  }
}

async function updateMenuConnectivityUI() {
  const revision = ++connectivityUiRevision;
  const cfg = state.config || {};
  const tr = cfg.translate || {};
  const pa = cfg.parser || {};

  const modelDot = $('menuModelDot');
  const parserDot = $('menuParserDot');

  // 未配置则置为黄色 + 文字说明
  if (!tr.apiKey) {
    setConnectivityUI('model', 'unconfigured', '未配置模型 API Key，点击设置');
  }
  if (pa.mode !== 'local' && !pa.mineruToken) {
    setConnectivityUI('parser', 'unconfigured', '未配置 MinerU Token，点击设置');
  }

  try {
    const st = await api.getConnectivityStatus();
    // 不能让较早的异步快照覆盖刚刚收到的 start/done 事件；主进程是托盘和
    // 页面共享的唯一状态源。
    if (revision !== connectivityUiRevision || !isMenuPanelVisible()) return;
    if (st) {
      if (Number.isFinite(Number(st.modelRequestId))) {
        modelConnectivityRequestId = Math.max(modelConnectivityRequestId, Number(st.modelRequestId));
      }
      if (Number.isFinite(Number(st.parserRequestId))) {
        parserConnectivityRequestId = Math.max(parserConnectivityRequestId, Number(st.parserRequestId));
      }
      if (tr.apiKey && modelDot) {
        if (st.model === 'ok') setConnectivityUI('model', 'ok', `模型连接正常：${tr.model || ''}`);
        else if (st.model === 'error') setConnectivityUI('model', 'error', '模型连接失败，点击重试');
        else if (st.model === 'testing') setConnectivityUI('model', 'gray', '正在测试模型连接…', '测试中…');
        else setConnectivityUI('model', 'gray', '未测试，点击 🗘 测试');
      }

      const hasParserAuth = pa.mode === 'local' || !!pa.mineruToken;
      if (hasParserAuth && parserDot) {
        if (st.parser === 'ok') setConnectivityUI('parser', 'ok', 'MinerU 连接正常');
        else if (st.parser === 'error') setConnectivityUI('parser', 'error', 'MinerU 连接失败，点击重试');
        else if (st.parser === 'testing') setConnectivityUI('parser', 'gray', '正在测试 MinerU 连接…', '测试中…');
        else setConnectivityUI('parser', 'gray', '未测试，点击 🗘 测试');
      }
    }
  } catch {
    /* 忽略读取错误 */
  }
}

function bindMenuPanelEvents() {
  $('menuPanel')?.addEventListener('contextmenu', (e) => {
    e.stopPropagation();
  });

  $('menuCloseBtn')?.addEventListener('click', hideMenuPanel);

  $('menuPickTranslate')?.addEventListener('click', () => {
    hideMenuPanel();
    pickFilesToTranslate();
  });

  // 论文问答 → 微信式聊天窗口（唯一问答入口）
  $('menuQaOpen')?.addEventListener('click', () => {
    hideMenuPanel();
    void api.chatToggle().catch(() => {});
  });

  $('menuConfigModel')?.addEventListener('click', () => {
    hideMenuPanel();
    wizardTranslate(false);
  });

  $('menuConfigParser')?.addEventListener('click', () => {
    hideMenuPanel();
    wizardParser(false);
  });

  $('menuHidePet')?.addEventListener('click', () => {
    hideMenuPanel();
    hideBubble();
    api.hide();
  });

  $('menuHelp')?.addEventListener('click', () => {
    hideMenuPanel();
    showHelp();
  });

  $('menuQuit')?.addEventListener('click', () => {
    api.quitApp();
  });

  // 测试模型连接：旋转双箭头 + 状态灯变灰，原地反馈，不弹任何提示气泡/窗口
  $('menuModelRefresh')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = $('menuModelRefresh');
    if (btn) {
      btn.classList.add('is-spinning');
      btn.disabled = true;
    }
    setConnectivityUI('model', 'gray', '正在测试模型连接与翻译…');

    const minDelay = new Promise((resolve) => setTimeout(resolve, 400));
    try {
      await Promise.all([
        api.checkModelConnectivity(),
        minDelay
      ]);
    } catch {
      // 连接结果由主进程的 connectivity:done 与状态快照统一呈现。
    } finally {
      if (btn) {
        btn.classList.remove('is-spinning');
        btn.disabled = false;
      }
    }

    await updateMenuConnectivityUI();
  });

  // 测试 MinerU 连接：旋转双箭头 + 状态灯变灰，原地反馈，不弹任何提示气泡/窗口
  $('menuParserRefresh')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = $('menuParserRefresh');
    if (btn) {
      btn.classList.add('is-spinning');
      btn.disabled = true;
    }
    setConnectivityUI('parser', 'gray', '正在测试 MinerU 连接…');

    const minDelay = new Promise((resolve) => setTimeout(resolve, 400));
    try {
      await Promise.all([
        api.checkParserConnectivity(),
        minDelay
      ]);
    } catch {
      // 连接结果由主进程的 connectivity:done 与状态快照统一呈现。
    } finally {
      if (btn) {
        btn.classList.remove('is-spinning');
        btn.disabled = false;
      }
    }

    await updateMenuConnectivityUI();
  });

  let retypesetTimer = null;
  function triggerRetypesetIfAvailable() {
    if (retypesetTimer) clearTimeout(retypesetTimer);
    const files = state.lastTranslatedFiles;
    if (!files || !files.length || state.busy) return;
    retypesetTimer = setTimeout(() => {
      retypesetTimer = null;
      if (state.busy) return;
      hideMenuPanel();
      say('已更新排版设置，正在重新生成译文…', 3000);
      startTranslate(files, true);
    }, 600);
  }

  // 输出排版单选：切换即存，面板保持常驻不退出
  document.querySelectorAll('input[name="menuLayout"]').forEach((radio) => {
    radio.addEventListener('change', async (e) => {
      const layout = e.target.value;
      await saveAndReload({ output: { layout } });
      triggerRetypesetIfAvailable();
    });
  });

  // 输出内容单选：切换即存，面板保持常驻不退出
  document.querySelectorAll('input[name="menuContent"]').forEach((radio) => {
    radio.addEventListener('change', async (e) => {
      const content = e.target.value;
      await saveAndReload({ output: { content } });
      triggerRetypesetIfAvailable();
    });
  });

  // 输出格式多选（可多选）：切换即存，面板保持常驻不退出
  ['fmtPdf', 'fmtDocx', 'fmtMd', 'fmtHtml'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', async (e) => {
      const selected = [];
      if ($('fmtPdf')?.checked) selected.push('pdf');
      if ($('fmtDocx')?.checked) selected.push('docx');
      if ($('fmtMd')?.checked) selected.push('md');
      if ($('fmtHtml')?.checked) selected.push('html');

      if (!selected.length) {
        e.target.checked = true;
        say('至少保留一种输出格式', 2000);
        return;
      }

      await saveAndReload({ output: { formats: selected } });
      triggerRetypesetIfAvailable();
    });
  });

  // 打开翻译文档库
  $('menuOpenLib')?.addEventListener('click', async () => {
    const dir = (state.config && state.config.output && state.config.output.libraryDir) || 'translated';
    try {
      await api.openPath(dir);
    } catch (err) {
      say(`无法打开目录：${err.message || err}`, 5000);
    }
  });

  // 更改翻译文档库路径
  $('menuPickLib')?.addEventListener('click', async () => {
    try {
      const newDir = await api.pickDirectory();
      if (newDir) {
        await saveAndReload({ output: { libraryDir: newDir } });
        say(`已更改译文输出路径：\n${newDir}`, 5000);
      }
    } catch (err) {
      say(`更改路径失败：${err.message || err}`, 5000);
    }
  });

  $('menuAlwaysOnTop')?.addEventListener('change', async (e) => {
    await saveAndReload({ pet: { alwaysOnTop: !!e.target.checked } });
    try { await api.setAlwaysOnTop(!!e.target.checked); } catch { /* preload 未暴露时忽略 */ }
  });
}

/* --------------------------- 连通性状态 UI --------------------------- */

function setConnectivityUI(kind, status, title, label) {
  const dot = kind === 'parser' ? $('menuParserDot') : $('menuModelDot');
  const txt = kind === 'parser' ? $('menuParserText') : $('menuModelText');
  const labelMap = { ok: '正常', error: '失败', unconfigured: '未配置', testing: '测试中…', gray: '未测试' };
  if (dot) {
    dot.className = `status-dot-mini ${status}`;
    dot.title = title || '';
  }
  if (txt) {
    txt.textContent = label || labelMap[status] || status;
    txt.title = title || '';
  }
}

let connectivityUiRevision = 0;
let modelConnectivityRequestId = 0;
let parserConnectivityRequestId = 0;

function acceptsConnectivityEvent(target, requestId) {
  const id = Number(requestId);
  if (!Number.isFinite(id) || id <= 0) return true; // 兼容升级前的主进程。
  if (target === 'parser') {
    if (id < parserConnectivityRequestId) return false;
    parserConnectivityRequestId = id;
  } else {
    if (id < modelConnectivityRequestId) return false;
    modelConnectivityRequestId = id;
  }
  return true;
}

function handleConnectivityStart({ target, requestId }) {
  if (!acceptsConnectivityEvent(target, requestId)) return;
  connectivityUiRevision += 1;
  if (target === 'parser') {
    const btn = $('menuParserRefresh');
    if (btn) { btn.classList.add('is-spinning'); btn.disabled = true; }
    setConnectivityUI('parser', 'gray', '正在测试 MinerU 连接…');
  } else {
    const btn = $('menuModelRefresh');
    if (btn) { btn.classList.add('is-spinning'); btn.disabled = true; }
    setConnectivityUI('model', 'gray', '正在测试模型连接与翻译…');
  }
}

function handleConnectivityDone({ target, requestId, ok, reason, sample }) {
  if (!acceptsConnectivityEvent(target, requestId)) return;
  connectivityUiRevision += 1;
  if (target === 'parser') {
    const btn = $('menuParserRefresh');
    if (btn) { btn.classList.remove('is-spinning'); btn.disabled = false; }
    const dot = $('menuParserDot');
    if (dot) dot.classList.remove('is-faded');
    if (ok) {
      setConnectivityUI('parser', 'ok', 'MinerU 连接正常');
    } else if (reason === 'unconfigured') {
      setConnectivityUI('parser', 'unconfigured', 'MinerU 未配置，请点击右侧「设置」');
    } else {
      setConnectivityUI('parser', 'error', `MinerU 连接失败：${reason || '网络超时'}`);
    }
  } else {
    const btn = $('menuModelRefresh');
    if (btn) { btn.classList.remove('is-spinning'); btn.disabled = false; }
    const dot = $('menuModelDot');
    if (dot) dot.classList.remove('is-faded');
    if (ok) {
      setConnectivityUI('model', 'ok', sample ? `模型连接与翻译正常（${sample}）` : '模型连接正常');
    } else if (reason === 'unconfigured') {
      setConnectivityUI('model', 'unconfigured', '模型未配置，请点击右侧「设置」填写 API Key');
    } else {
      setConnectivityUI('model', 'error', `模型连接失败：${reason || '网络超时'}`);
    }
  }
}
