'use strict';
/** Isolated native Electron acceptance checks. Never edits real credentials. */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, screen } = require('electron');
const petWin = require('./pet/window');
const { printHtmlToPdf, dispose } = require('./pet/pdf-print');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function runSmoke() {
  const started = Date.now();
  const arg = process.argv.find(x => x.startsWith('--smoke-output='));
  const out = arg ? path.resolve(arg.slice('--smoke-output='.length)) : path.join(require('./paths').root(), 'smoke-results');
  fs.mkdirSync(out, { recursive: true });
  const report = { version: app.getVersion(), packaged: app.isPackaged, checks: [], metrics: {} };
  const check = (name, ok, details) => {
    report.checks.push({ name, ok: !!ok, details });
    console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${details ? ' ' + JSON.stringify(details) : ''}`);
  };
  const watchdog = setTimeout(() => {
    check('global deadline', false);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    app.exit(1);
  }, 90000);
  (async () => {
    try {
      const win = petWin.getPetWindow();
      if (!win) throw new Error('Pet window missing');
      for (let i = 0; i < 100; i++) {
        const ready = await win.webContents.executeJavaScript('Boolean(window.__pt && window.__pt.pet)').catch(() => false);
        if (ready) { report.metrics.rendererReadyUptimeMs = Math.round(process.uptime() * 1000); break; }
        await delay(100);
      }
      win.show();
      await delay(800);
      const ui = await win.webContents.executeJavaScript(`(() => ({
        ready: !!window.__pt?.pet,
        svg: !!document.getElementById('petSvg') && !!document.getElementById('ghost'),
        states: [...window.__pt.states.keys()],
        title: document.title,
        api: typeof window.pt.cancelJob === 'function'
      }))()`);
      check('native renderer ready', ui.ready && ui.svg && ui.api && ui.title === 'PPtor', ui);

      // 位置契约必须验证真实 BrowserWindow，而不是只检查几何函数源码。
      petWin.moveToBottomRight();
      await delay(100);
      const primaryWorkArea = screen.getPrimaryDisplay().workArea;
      const anchored = petWin.getPetBounds();
      check('visible pet is anchored inside the primary work area',
        !!anchored &&
        anchored.pet.x >= primaryWorkArea.x &&
        anchored.pet.y >= primaryWorkArea.y &&
        anchored.pet.x + anchored.pet.width === primaryWorkArea.x + primaryWorkArea.width - 24 &&
        anchored.pet.y + anchored.pet.height === primaryWorkArea.y + primaryWorkArea.height - 10,
        { primaryWorkArea, anchored });

      const beforeOffscreenMove = win.getBounds();
      const offscreenDx = -(primaryWorkArea.width + beforeOffscreenMove.width);
      petWin.moveBy(offscreenDx, 0);
      await delay(100);
      const afterOffscreenMove = win.getBounds();
      check('native window movement is not clamped at the screen edge',
        afterOffscreenMove.x === beforeOffscreenMove.x + offscreenDx &&
        afterOffscreenMove.y === beforeOffscreenMove.y,
        { primaryWorkArea, beforeOffscreenMove, afterOffscreenMove, offscreenDx });
      petWin.moveToBottomRight();
      await delay(100);

      const readMenuLayout = () => win.webContents.executeJavaScript(`(() => {
        const panel = document.getElementById('menuPanel');
        const footer = document.querySelector('.menu-footer');
        const pet = document.getElementById('pet');
        const rect = panel.getBoundingClientRect();
        const footerRect = footer.getBoundingClientRect();
        const petRect = pet.getBoundingClientRect();
        const controls = [
          'menuPickTranslate', 'menuQaOpen', 'menuModelRefresh', 'menuConfigModel',
          'menuParserRefresh', 'menuConfigParser', 'fmtPdf', 'fmtDocx', 'fmtMd',
          'fmtHtml', 'menuOpenLib', 'menuPickLib', 'menuHidePet', 'menuHelp', 'menuQuit'
        ].map((id) => {
          const control = document.getElementById(id);
          const box = control.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        });
        return {
          visible: !panel.classList.contains('is-hidden'),
          top: rect.top,
          bottom: rect.bottom,
          viewportHeight: window.innerHeight,
          overflowY: getComputedStyle(panel).overflowY,
          scrollHeight: panel.scrollHeight,
          clientHeight: panel.clientHeight,
          footerBottom: footerRect.bottom,
          petTop: petRect.top,
          petBottom: petRect.bottom,
          allControlsRendered: controls.every(Boolean)
        };
      })()`);
      await win.webContents.executeJavaScript("document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))");
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const menuLayouts = [];
      for (const scale of [0.5, 1, 1.5, 2]) {
        petWin.applyScale(scale);
        await win.webContents.executeJavaScript(`applyScaleToUI(${scale})`);
        await delay(120);
        menuLayouts.push({ scale, ...(await readMenuLayout()) });
      }
      // 自适应契约：菜单完整可见（不出屏）、不与宠物重叠（上方或下方）；
      // 屏幕空间充足时无滚动条，矮屏/大缩放时内部滚动兜底。
      check('menu stays fully on screen without overlapping the pet at every scale',
        menuLayouts.every((layout) =>
          layout.visible && layout.top >= -1 && layout.bottom <= layout.viewportHeight - 2 &&
          layout.footerBottom <= layout.bottom + 1 &&
          (layout.bottom <= layout.petTop - 4 || layout.top >= layout.petBottom + 4) &&
          (layout.scrollHeight <= layout.clientHeight + 1 || layout.overflowY === 'auto') &&
          layout.allControlsRendered
        ), menuLayouts);
      petWin.applyScale(1);
      await win.webContents.executeJavaScript('applyScaleToUI(1)');
      await delay(80);
      const firstOpenLayout = await readMenuLayout();
      await win.webContents.executeJavaScript(`(async () => {
        document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
        document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      const reopenedMenuLayout = await readMenuLayout();
      check('first and subsequent right-click openings keep identical menu geometry',
        Math.abs(firstOpenLayout.top - reopenedMenuLayout.top) <= 1 &&
        Math.abs(firstOpenLayout.bottom - reopenedMenuLayout.bottom) <= 1 &&
        Math.abs(firstOpenLayout.clientHeight - reopenedMenuLayout.clientHeight) <= 1,
        { firstOpenLayout, reopenedMenuLayout });
      report.metrics.readyAfterSmokeMs = Date.now() - started;
      report.metrics.processUptimeMs = Math.round(process.uptime() * 1000);
      report.metrics.memory = await process.getProcessMemoryInfo();
      report.metrics.processes = app.getAppMetrics().map(({type,memory})=>({type,memory}));
      await fs.promises.writeFile(path.join(out, 'pet-start.png'), (await win.webContents.capturePage()).toPNG());
      const ipc = await win.webContents.executeJavaScript(`(async () => ({busy: await window.pt.isBusy(), qa: await window.pt.qaState()}))()`);
      check('IPC ready', ipc.busy === false && typeof ipc.qa.ready === 'boolean');
      // 本地悬挂探针模拟“旧检测晚返回”。向导确认的正常状态必须保持，不能被
      // 旧请求重新写成 testing/error；不访问任何真实 Key 或外部服务。
      const connectivityServer = require('node:http').createServer(() => {});
      await new Promise(resolve => connectivityServer.listen(0, '127.0.0.1', resolve));
      try {
        const staleConnectivity = await win.webContents.executeJavaScript(`(async () => {
          await saveAndReload({ translate: {
            apiKey: 'isolated-smoke-key',
            baseUrl: 'http://127.0.0.1:${connectivityServer.address().port}',
            model: 'isolated-model'
          }});
          const oldCheck = window.pt.checkModelConnectivity();
          await new Promise(resolve => setTimeout(resolve, 60));
          await window.pt.setConnectivityStatus({ model: 'ok' });
          await new Promise(resolve => setTimeout(resolve, 3800));
          await oldCheck;
          return await window.pt.getConnectivityStatus();
        })()`);
        check('new model status is not overwritten by an older timed-out probe', staleConnectivity.model === 'ok', staleConnectivity);
      } finally {
        connectivityServer.closeAllConnections();
        await new Promise(resolve => connectivityServer.close(resolve));
      }
      // Self-contained long document: images below the viewport must render too.
      const { buildHtmlDocument, renderMarkdown } = require('./core/markdown');
      const png = fs.readFileSync(require('./paths').assetPath('tray.png')).toString('base64');
      const md = '# PDF 回归验证\n\n中文译文与公式 $E=mc^2$。\n\n| 指标 | 数值 |\n| --- | --- |\n| 正确率 | 95.2% |\n\n' + '正文测试。\n\n'.repeat(100) + `![插图](data:image/png;base64,${png})`;
      const html = buildHtmlDocument({title: '导出验证', bodyHtml: renderMarkdown(md)});
      check('no remote document resources', !/(?:src|href)=["']https?:\/\//i.test(html));
      const pdfPath = path.join(out, 'export-regression.pdf');
      const before = BrowserWindow.getAllWindows().length;
      const printStart = Date.now();
      await printHtmlToPdf({html, pdfPath, needsMath: true});
      const buf = fs.readFileSync(pdfPath);
      check('real PDF including image', buf.subarray(0, 5).toString() === '%PDF-' && buf.includes(Buffer.from('/Subtype /Image')), {bytes:buf.length, ms:Date.now()-printStart});
      check('print window released', BrowserWindow.getAllWindows().length === before);
      let cancelled = false;
      const cancelPath = path.join(out, 'cancelled.pdf');
      try { await printHtmlToPdf({html, pdfPath:cancelPath, signal:{cancelled:true}}); }
      catch (err) { cancelled = /取消|cancel/i.test(err.message); }
      check('cancelled export produces no file', cancelled && !fs.existsSync(cancelPath));
      await printHtmlToPdf({html:'<html><body><h1>Second export</h1></body></html>',pdfPath:path.join(out,'repeat.pdf')});
      check('export recovers after cancellation', fs.existsSync(path.join(out,'repeat.pdf')) && BrowserWindow.getAllWindows().length === before);
      // Reproduce a resource that never finishes: timeout and cancellation must settle.
      const server = require('node:http').createServer((_req, _res) => {});
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const hanging = '<html><body><img src="http://127.0.0.1:' + server.address().port + '/never"></body></html>';
        let timeout = false;
        try { await printHtmlToPdf({html:hanging,pdfPath:path.join(out,'timeout.pdf'),timeouts:{loadMs:350,imagesMs:350,printMs:1000}}); }
        catch(err) { timeout = /超时|timeout/i.test(err.message); }
        check('hanging resource deadline', timeout && !fs.existsSync(path.join(out,'timeout.pdf')) && BrowserWindow.getAllWindows().length === before);
        const signal = {cancelled:false};
        const timer = setTimeout(()=>{signal.cancelled=true;},150);
        let stopped = false;
        try { await printHtmlToPdf({html:hanging,pdfPath:path.join(out,'mid-cancel.pdf'),signal}); }
        catch(err) { stopped = /取消|cancel/i.test(err.message); }
        finally {clearTimeout(timer);}
        check('cancel during page load', stopped && !fs.existsSync(path.join(out,'mid-cancel.pdf')) && BrowserWindow.getAllWindows().length === before);
      } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
      const webpDocx = await require('./core/docx').markdownToDocx('![WebP](data:image/webp;base64,UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoEAAIAAUAmJaACdLoB+AADsAD+8Bvf/1wH5wH5wH8WP/zYFc1z7mgA)');
      const webpMedia = require('./core/zip').unzip(webpDocx).filter(e=>e.name.startsWith('word/media/') && e.data.length);
      check('native WebP converts to embedded PNG in Word',webpMedia.length === 1 && webpMedia[0].data.subarray(1,4).toString()==='PNG');
      const fixtureArg = process.argv.find(x=>x.startsWith('--smoke-fixture='));
      if (fixtureArg) {
        const fixture = path.resolve(fixtureArg.slice('--smoke-fixture='.length));
        const md = fs.readFileSync(path.join(fixture,'source.md'),'utf8');
        const imageDir = fs.readFileSync(path.join(fixture,'images-path.txt'),'utf8').trim();
        const images = fs.readdirSync(imageDir).map(name=>({name,data:fs.readFileSync(path.join(imageDir,name))}));
        const pendingPdf = {};
        const actualStarted = Date.now();
        const exported = await require('./core/exporter').exportResults({
          outDir:path.join(out,'actual-paper'),baseName:'实际论文译文',
          segments:require('./core/chunker').splitMarkdown(md),translations:new Map(),images,
          outputConfig:{formats:['pdf','docx','html','md'],renderMath:true},pendingPdf
        });
        const expectedImages = (md.match(/!\[[^\]]*\]\(/g) || []).length;
        const renderedImages = (pendingPdf.html.match(/<img\b/g) || []).length;
        check('actual paper image count preserved', renderedImages === expectedImages, {expectedImages,renderedImages});
        const archive = require('./core/zip').unzip(fs.readFileSync(path.join(exported.outDir,'实际论文译文.docx')));
        const xml = archive.find(e=>e.name === 'word/document.xml').data.toString();
        const wordImages = (xml.match(/<a:blip /g) || []).length;
        check('actual Word image count preserved', wordImages === expectedImages, {expectedImages,wordImages});
        check('actual paper tail preserved',pendingPdf.html.includes('10.1016/J.ECOLIND.2021.108033') && xml.includes('10.1016/J.ECOLIND.2021.108033'));
        await printHtmlToPdf({html:pendingPdf.html,pdfPath:pendingPdf.path,needsMath:true});
        check('actual stalled paper all formats',exported.files.length===4 && exported.files.every(f=>fs.existsSync(f.path)),{ms:Date.now()-actualStarted,files:fs.readdirSync(exported.outDir)});
      }
      const hook = await win.webContents.executeJavaScript('typeof window.__ptTest !== "undefined"');
      report.uiTestHook = hook;
      if (hook) {
        // Exercise the actual renderer entry and real IPC, without remote requests.
        require('./config').saveConfig({ translate: { apiKey: 'isolated-smoke-placeholder' } });
        const missingPdf = path.join(out, 'intentionally-missing.pdf');
        const entry = await win.webContents.executeJavaScript(`(async () => {
          await startTranslate([${JSON.stringify(missingPdf)}], false);
          return { busy: window.__pt.busy, message: document.getElementById('bubbleBody').textContent };
        })()`);
        check('real task entry reaches IPC and releases busy state', !entry.busy && entry.message.includes('文件不存在'), entry);
        require('./config').saveConfig({ parser: { mode: 'cloud', mineruToken: '' } });
        const failure = await win.webContents.executeJavaScript(`(async () => {
          await startTranslate([${JSON.stringify(path.join(out, 'repeat.pdf'))}], true);
          return { busy: window.__pt.busy, title: document.getElementById('bubbleTitle').textContent,
            message: document.getElementById('bubbleBody').textContent };
        })()`);
        check('pipeline failure displays the actual parser error', !failure.busy && failure.title === '翻译失败' && failure.message.includes('未配置 MinerU Token'), failure);
        const hookKeys = await win.webContents.executeJavaScript('Object.keys(window.__ptTest)');
        report.uiTestHookKeys = hookKeys;
        await win.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
        const phasePoses = {};
        for (const phase of ['parsing','translating','exporting','waiting','failed','cancelled','petting']) {
          await win.webContents.executeJavaScript('window.__ptTest.showStatus(' + JSON.stringify(phase) + ',' + JSON.stringify('状态预览：'+phase) + ')');
          await delay(320);
          const pose = await win.webContents.executeJavaScript("({anim:window.__pt.anim,pose:document.getElementById('sprite').dataset.anim})");
          await fs.promises.writeFile(path.join(out,'pet-'+phase+'.png'),(await win.webContents.capturePage()).toPNG());
          phasePoses[phase] = pose;
          check('pet state '+phase, pose.anim === phase && pose.pose === phase, pose);
        }
        check('parsing and exporting have distinct pet poses', phasePoses.parsing.pose === 'parsing' && phasePoses.exporting.pose === 'exporting');
        check('failed and cancelled have distinct pet poses', phasePoses.failed.pose === 'failed' && phasePoses.cancelled.pose === 'cancelled');
        await win.webContents.executeJavaScript("window.__ptTest.showStatus('parsing','MinerU running')");
        await win.webContents.executeJavaScript("window.__ptTest.onProgress({stage:'parse',percent:0,phasePercent:null,phaseIndeterminate:true,message:'MinerU running'})");
        const parseProgress = await win.webContents.executeJavaScript("({indeterminate:document.getElementById('phaseBar').classList.contains('is-indeterminate'),phase:document.getElementById('phasePercent').textContent,overall:document.getElementById('overallPercent').textContent})");
        await win.webContents.executeJavaScript("window.__ptTest.onProgress({stage:'translate',percent:63,phasePercent:50,phaseIndeterminate:false,message:'翻译 5/10 段'})");
        const translateProgress = await win.webContents.executeJavaScript("({indeterminate:document.getElementById('phaseBar').classList.contains('is-indeterminate'),phase:document.getElementById('phasePercent').textContent,overall:document.getElementById('overallPercent').textContent})");
        check('parse and translate progress are separately visible', parseProgress.indeterminate && parseProgress.phase.includes('处理') && !translateProgress.indeterminate && translateProgress.phase === '50%' && translateProgress.overall === '63%', {parseProgress,translateProgress});
        await win.webContents.executeJavaScript("window.__ptTest.showStatus('translating','正在翻译第 2/10 段')");
        await win.webContents.executeJavaScript("window.__ptTest.cancel()");
        const cancelUi = await win.webContents.executeJavaScript("({requested:window.__pt.task.cancelRequested,disabled:document.getElementById('cancelJob').disabled})");
        check('cancel UI is idempotent',cancelUi.requested && cancelUi.disabled);

      }
    } catch (err) {
      check('acceptance run', false, err.stack || err.message);
    } finally {
      dispose();
      clearTimeout(watchdog);
      report.elapsedMs = Date.now() - started;
      report.ok = report.checks.every(x => x.ok);
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
      console.log(`[smoke] ${report.ok ? 'OK' : 'FAILED'} ${out}`);
      app.exit(report.ok ? 0 : 1);
    }
  })();
}
module.exports = { runSmoke };
