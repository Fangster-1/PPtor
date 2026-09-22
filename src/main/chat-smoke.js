'use strict';

/**
 * 聊天窗原生验收（--chat-smoke）：
 * 验证微信式聊天窗口能创建、DOM 完整（会话分组/右键菜单/分隔条）、
 * qa IPC 可用、窗口可自由缩放、会话不产生空会话。
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const chatWin = require('./chat/window');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runChatSmoke() {
  const startedAt = Date.now();
  const out = path.join(require('./paths').root(), 'chat-smoke-results');
  fs.mkdirSync(out, { recursive: true });
  const report = { checks: [], metrics: {} };
  const check = (name, ok, details) => {
    report.checks.push({ name, ok: !!ok, details });
    console.log(`[chat-smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${details ? ' ' + JSON.stringify(details) : ''}`);
  };

  let done = false;
  function finish(code) {
    if (done) return;
    done = true;
    clearTimeout(watchdog);
    report.elapsedMs = Date.now() - startedAt;
    report.ok = report.checks.every((c) => c.ok);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`[chat-smoke] ${report.ok ? 'OK' : 'FAILED'} ${out}`);
    app.exit(code ?? (report.ok ? 0 : 1));
  }

  const watchdog = setTimeout(() => {
    check('global deadline', false);
    finish(1);
  }, 45000);

  (async () => {
    try {
      chatWin.toggleChat();
      const win = chatWin.getChatWindow();
      if (!win || win.isDestroyed()) throw new Error('chat window missing');

      let ready = false;
      for (let i = 0; i < 120 && !ready; i++) {
        ready = await win.webContents.executeJavaScript('Boolean(window.__chatReady)').catch(() => false);
        if (!ready) await delay(100);
      }
      check('chat renderer ready', ready);

      const ui = await win.webContents.executeJavaScript(`(() => ({
        title: document.title,
        sidebar: !!document.getElementById('sessionList'),
        sideEmpty: !!document.getElementById('sideEmpty'),
        messages: !!document.getElementById('messages'),
        input: !!document.getElementById('input'),
        send: !!document.getElementById('btnSend'),
        addDoc: !!document.getElementById('btnAddDoc'),
        close: !!document.getElementById('btnClose'),
        minimize: !!document.getElementById('btnMinimize'),
        jobChip: !!document.getElementById('jobChip'),
        drag: !!document.querySelector('.drag-region'),
        splitter: !!document.getElementById('splitter'),
        ctxMenu: !!document.getElementById('ctxMenu'),
        headPet: !!document.getElementById('headPet') && !!document.querySelector('#headPet svg'),
        composerToolsGone: !document.getElementById('composerTools') && !document.getElementById('btnPickPdf'),
        api: typeof window.pt.qaAsk === 'function' && typeof window.pt.chatToggle === 'function' &&
             typeof window.pt.qaRename === 'function' && typeof window.pt.qaRemove === 'function' &&
             typeof window.pt.qaSetGroup === 'function'
      }))()`);
      check('chat DOM complete (sessions + splitter + ctx menu + pet in header)',
        ui.sidebar && ui.sideEmpty && ui.messages && ui.input && ui.send && ui.addDoc && ui.close &&
        ui.minimize && ui.jobChip && ui.drag && ui.splitter && ui.ctxMenu && ui.headPet && ui.api, ui);
      check('composer tool buttons removed (single QA entry only)', ui.composerToolsGone, ui.composerToolsGone);
      check('chat window title', ui.title === 'PPtor 论文问答', ui.title);

      // 可自由缩放验证：frameless + resizable 生效
      const [w0, h0] = win.getSize();
      win.setSize(Math.max(620, w0 - 120), Math.max(460, h0 - 80));
      await delay(180);
      const [w1, h1] = win.getSize();
      check('chat window freely resizable', Math.abs(w1 - w0) > 60 && Math.abs(h1 - h0) > 40, { w0, h0, w1, h1 });

      // 侧栏宽度可拖拽调整（splitter 改 CSS 变量）
      const side = await win.webContents.executeJavaScript(`(() => {
        const before = getComputedStyle(document.documentElement).getPropertyValue('--side-w');
        const evt = new MouseEvent('mousedown', { bubbles: true });
        document.getElementById('splitter').dispatchEvent(evt);
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 320 }));
        window.dispatchEvent(new MouseEvent('mouseup'));
        return { before, after: getComputedStyle(document.documentElement).getPropertyValue('--side-w') };
      })()`);
      check('sidebar width resizable via splitter', side.before !== side.after, side);

      // qa:state IPC：空状态下 sessions 为数组且没有空会话入口
      const st = await win.webContents.executeJavaScript('window.pt.qaState()');
      check('qa state IPC works (no empty sessions)', !!st && Array.isArray(st.sessions) &&
        typeof st.ready === 'boolean' && st.sessions.every((s) => s.count > 0), st);

      await fs.promises.writeFile(path.join(out, 'chat.png'), (await win.webContents.capturePage()).toPNG());
      report.metrics.memory = await process.getProcessMemoryInfo();
      finish(0);
    } catch (err) {
      check('chat acceptance run', false, err.stack || err.message);
      finish(1);
    }
  })();
}

module.exports = { runChatSmoke };
