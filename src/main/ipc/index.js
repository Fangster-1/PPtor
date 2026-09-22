'use strict';

/**
 * IPC 路由编排：渲染进程（宠物窗 / 聊天窗）↔ 主进程
 *
 * 结构（从原 ipc.js 拆分）：
 *   ./broadcast.js    事件广播（宠物窗 + 聊天窗）
 *   ./ask-gateway.js  主进程 → 宠物气泡的确认问答
 *   ./job-manager.js  翻译任务队列 / 取消 / 去重预检
 *   ./qa-sessions.js  问答多会话存储
 *   ./doc-loader.js   问答语料三级回退加载
 * 本文件只做路由注册与依赖装配，业务规则在上述模块中。
 */
const { ipcMain, dialog, shell, app } = require('electron');

const { getConfig, saveConfig } = require('../config');
const { testApi, flushCache, listModels } = require('../core/translator');
const { detectLocalMinerUAsync } = require('../core/parser');
const { renderMarkdown, getKatexCss } = require('../core/markdown');
const qa = require('../core/qa');
const registry = require('../core/registry');
const library = require('../core/library');
const { loadPet } = require('../pet/loader');
const { readClipboardFiles, filterPaths } = require('../clipboard');
const petWin = require('../pet/window');
const chatWin = require('../chat/window');
const { root, configFile } = require('../paths');

const { broadcast } = require('./broadcast');
const { createAskGateway } = require('./ask-gateway');
const { createJobManager } = require('./job-manager');
const { createQaSessionStore } = require('./qa-sessions');
const { loadPapersFromFiles } = require('./doc-loader');

let askGateway = null;
let jobManager = null;
let qaStore = null;
let qaBusy = false;

function registerIpc(ctl) {
  askGateway = createAskGateway();
  qaStore = createQaSessionStore({ broadcast });
  jobManager = createJobManager({
    askViaPet: askGateway.askViaPet,
    qaCreateSession: qaStore.createSession,
    getCacheReady: () => ctl.cacheReady
  });

  /* ------------------------------ 配置 ------------------------------ */
  ipcMain.handle('config:get', () => getConfig());

  ipcMain.handle('config:save', (_e, patch) => {
    const next = saveConfig(patch || {});
    ctl.refreshMenu();
    // 配置变化后立即重测连通性：否则状态停留在保存前的快照
    // （此前配好 MinerU 后菜单一直显示「测试中」，就是旧状态没被刷新）。
    if (patch && patch.parser) {
      void ctl.testParserConnectivity({ force: true }).catch(() => {});
    }
    if (patch && patch.translate && (patch.translate.apiKey || patch.translate.baseUrl || patch.translate.model)) {
      void ctl.testModelConnectivity({ force: true }).catch(() => {});
    }
    return next;
  });

  ipcMain.handle('config:testApi', async (_e, api) => {
    try {
      const r = await testApi(api);
      ctl.setModelStatus('ok', { sample: r.sample });
      return { ok: true, message: `连接成功。示例译文：${r.sample}`, sample: r.sample };
    } catch (err) {
      ctl.setModelStatus('error', { reason: err.message || '连接失败' });
      return { ok: false, message: err.message };
    }
  });

  /** 拉取服务商支持的模型列表，供配置时下拉选择 */
  ipcMain.handle('config:listModels', async (_e, api) => {
    try {
      const models = await listModels(api || {});
      return { ok: true, models: [...models], contexts: models.contexts || {} };
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
  });

  /** 渲染层回答主进程抛出的问题（用于非英文文献确认等） */
  ipcMain.handle('ui:answer', (_e, value) => askGateway.answer(value));

  /* ------------------------------ 宠物 ------------------------------ */
  ipcMain.handle('pet:load', (_e, id) => {
    try {
      return { ok: true, pet: loadPet(id) };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.on('pet:moveBy', (_e, delta) => {
    if (delta && Number.isFinite(delta.dx) && Number.isFinite(delta.dy)) {
      petWin.moveBy(delta.dx, delta.dy);
    }
  });

  ipcMain.on('pet:setIgnoreMouse', (_e, ignore) => petWin.setIgnoreMouse(ignore));
  /** Ctrl+滚轮缩放：渲染层已自行更新界面，这里只负责把窗口尺寸对齐 */
  ipcMain.on('pet:setScale', (_e, scale) => petWin.applyScale(scale));

  ipcMain.handle('pet:contextMenu', () => {
    ctl.buildMenu().popup({ window: petWin.getPetWindow() });
    return true;
  });

  ipcMain.handle('connectivity:checkModel', () => ctl.testModelConnectivity({ force: true }));
  ipcMain.handle('connectivity:checkParser', () => ctl.testParserConnectivity({ force: true }));
  ipcMain.handle('connectivity:status', () => ctl.getConnectivityStatus());
  ipcMain.handle('connectivity:rendererReady', () => {
    ctl.startConnectivityChecks();
    return true;
  });

  ipcMain.handle('connectivity:setStatus', (_e, payload) => {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.model) ctl.setModelStatus(payload.model, { reason: payload.reason, sample: payload.sample });
    if (payload.parser) ctl.setParserStatus(payload.parser, { reason: payload.reason });
    return true;
  });

  ipcMain.handle('dialog:pickDirectory', async () => {
    const r = await dialog.showOpenDialog(petWin.getPetWindow(), {
      title: '选择翻译文档库（所有译文都归档到这里）',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  ipcMain.on('app:quit', () => ctl.onQuit());

  ipcMain.on('pet:hide', () => ctl.hidePet());
  ipcMain.on('pet:scale', (_e, scale) => petWin.applyScale(scale));

  /** 渲染层启动时读取宠物边界。 */
  ipcMain.handle('pet:bounds', () => petWin.getPetBounds());
  ipcMain.handle('pet:pointer', () => petWin.getCursorPosition());

  ipcMain.handle('pet:setVisibility', (_e, visible) => {
    if (visible) ctl.showPet();
    else ctl.hidePet();
    return true;
  });

  ipcMain.handle('pet:alwaysOnTop', (_e, on) => {
    try {
      petWin.setAlwaysOnTop(!!on);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('pet:bringToTop', () => {
    try {
      petWin.bringToTop();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('pet:ensureVisible', () => {
    try {
      petWin.ensureVisible();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err && err.message) || String(err) };
    }
  });

  /* --------------------------- 环境与文件 --------------------------- */
  ipcMain.handle('env:detect', async () => ({
    mineru: await detectLocalMinerUAsync(),
    appVersion: app.getVersion(),
    rootDir: root(),
    configPath: configFile()
  }));

  /** 选 PDF：multi = true 支持一次选多篇 */
  ipcMain.handle('dialog:pickPdf', async (_e, opts) => {
    const multi = !!(opts && opts.multi);
    const r = await dialog.showOpenDialog(petWin.getPetWindow(), {
      title: multi ? '选择要翻译的论文' : '选择要翻译的 PDF',
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
    });
    if (r.canceled || !r.filePaths.length) return multi ? [] : null;
    return multi ? r.filePaths : r.filePaths[0];
  });

  /** 选已翻译文档（md/txt）用于提问 */
  ipcMain.handle('dialog:pickDoc', async () => {
    const r = await dialog.showOpenDialog(petWin.getPetWindow(), {
      title: '选择已翻译的文档',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '译文文档', extensions: ['md', 'markdown', 'txt', 'pdf', 'docx', 'html'] }]
    });
    return r.canceled ? [] : r.filePaths;
  });

  /** 读取剪贴板里复制的文件（支持批量） */
  ipcMain.handle('clipboard:readFiles', (_e, allowedExt) => {
    const { files, source } = readClipboardFiles();
    const { files: ok, rejected } = filterPaths(files, allowedExt || ['.pdf']);
    return { ok, rejected, source };
  });

  /* ------------------------------ 任务 ------------------------------ */
  ipcMain.handle('job:start', (_e, payload) => jobManager.start(payload));
  ipcMain.handle('job:cancel', () => jobManager.cancel());
  ipcMain.handle('job:busy', () => jobManager.isBusy());

  /* ------------------------------ 聊天窗 ------------------------------ */
  ipcMain.handle('chat:toggle', () => chatWin.toggleChat());
  ipcMain.on('chat:hide', () => chatWin.hideChat());
  ipcMain.on('chat:minimize', () => chatWin.minimizeChat());

  /** 聊天窗启动时一次性取资源：KaTeX 样式（回答公式排版，缺失时降级纯文本） */
  ipcMain.handle('chat:ready', () => {
    let katexCss = '';
    try {
      katexCss = getKatexCss();
    } catch {
      /* 资源缺失不阻塞聊天窗启动 */
    }
    return { katexCss };
  });

  /* ------------------------------ 去重记录 ------------------------------ */
  ipcMain.handle('registry:check', (_e, files) => jobManager.checkFiles(files));
  ipcMain.handle('registry:list', () => registry.list());

  ipcMain.handle('registry:forget', async (_e, file) => {
    try {
      await registry.forget(file);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  /* ------------------------------ 译文库索引 ------------------------------ */
  // 反查：这个文件是不是本机译出的译文？是的话属于哪篇作品？
  ipcMain.handle('library:match', async (_e, filePath) => {
    try {
      const libRoot = library.root();
      const hit = await library.matchAsync(libRoot, filePath);
      if (!hit) return null;
      return { ...hit, dirPath: library.workDir(libRoot, hit.work) };
    } catch {
      return null;
    }
  });

  ipcMain.handle('library:list', () => {
    try {
      return library.list(library.root());
    } catch {
      return [];
    }
  });

  /* ------------------------------ 问答 ------------------------------ */
  ipcMain.handle('qa:loadDoc', async (_e, payload) => {
    const { papers } = await loadPapersFromFiles(payload?.files);
    if (!papers.length) return { ok: false, message: '没有读到可用的文档内容' };
    const sources = qaStore.addPapers(papers);
    return { ok: true, sources, added: papers.length };
  });

  ipcMain.handle('qa:ask', async (_e, payload) => {
    const question = String(payload?.question || '').trim();
    if (!question) return { ok: false, message: '问题不能为空' };

    const active = qaStore.active();
    if (!active || !active.corpus) {
      return { ok: false, code: 'NO_CORPUS', message: '我还没读过论文，先翻译一篇或把译文拖给我' };
    }

    const config = getConfig();
    if (!config.translate.apiKey) {
      return { ok: false, code: 'NO_API_KEY', message: '问答同样需要配置大模型 API Key' };
    }

    if (jobManager.isBusy()) {
      return { ok: false, code: 'BUSY', message: '正在翻译中，等这篇完成后再问我' };
    }
    if (qaBusy) return { ok: false, code: 'BUSY', message: '上一条问题还在思考中' };
    qaBusy = true;

    try {
      const r = await qa.ask({
        corpus: active.corpus,
        question,
        history: active.history,
        api: config.translate
      });

      if (r.compressed && Array.isArray(r.newHistory)) {
        active.history = r.newHistory.slice();
      }
      if (r.learnedLimit && r.learnedLimit > 0) {
        saveConfig({ translate: { contextWindow: r.learnedLimit } });
      }

      active.history.push({ role: 'user', content: question });
      active.history.push({ role: 'assistant', content: r.answer });
      if (active.history.length > 12) active.history = active.history.slice(-12);
      qaStore.noteAnswer(r.answer);

      // 聊天窗用：主进程预渲染的 Markdown/公式 HTML（renderMarkdown 已做转义与白名单）
      let answerHtml = '';
      try {
        answerHtml = renderMarkdown(r.answer, { renderMath: true });
      } catch {
        /* 渲染失败时聊天窗降级显示纯文本 answer */
      }

      return {
        ok: true,
        answer: r.answer,
        answerHtml,
        citedPapers: r.citedPapers,
        sources: active.sources,
        compressed: !!r.compressed
      };
    } catch (err) {
      return { ok: false, message: (err && err.message) || String(err) };
    } finally {
      qaBusy = false;
    }
  });

  ipcMain.handle('qa:state', () => qaStore.publicState());

  /** 切换问答会话：不同论文/不同任务的对话各自独立 */
  ipcMain.handle('qa:switch', (_e, id) => {
    const st = qaStore.switchTo(id);
    if (!st) return { ok: false, message: '会话不存在' };
    return { ok: true, ...st };
  });

  ipcMain.handle('qa:rename', (_e, payload) => {
    const ok = qaStore.rename(payload?.id, payload?.name);
    return ok ? { ok: true, ...qaStore.publicState() } : { ok: false, message: '会话不存在' };
  });

  ipcMain.handle('qa:remove', (_e, id) => {
    const ok = qaStore.remove(id);
    return ok ? { ok: true, ...qaStore.publicState() } : { ok: false, message: '会话不存在' };
  });

  ipcMain.handle('qa:setGroup', (_e, payload) => {
    const ok = qaStore.setGroup(payload?.id, payload?.group);
    return ok ? { ok: true, ...qaStore.publicState() } : { ok: false, message: '会话不存在' };
  });

  ipcMain.handle('qa:reset', () => {
    qaStore.resetActive();
    return { ok: true };
  });

  /* ----------------------------- 产物 ----------------------------- */
  ipcMain.handle('shell:openPath', (_e, target) => shell.openPath(String(target || '')));

  ipcMain.handle('shell:revealPath', (_e, target) => {
    shell.showItemInFolder(String(target || ''));
    return true;
  });

  /** 用系统默认浏览器打开外部网址（Key / Token 申请页直达） */
  ipcMain.handle('shell:openExternal', (_e, url) => {
    const target = String(url || '');
    if (!/^https?:\/\//i.test(target)) return { ok: false, message: '仅支持 http(s) 链接' };
    shell.openExternal(target);
    return { ok: true };
  });
}

async function shutdownIpc() {
  if (askGateway) askGateway.shutdown();
  if (jobManager) await jobManager.shutdown();
  if (qaStore) qaStore.shutdown();
  qaBusy = false;
  await flushCache();
}

module.exports = { registerIpc, shutdownIpc };
