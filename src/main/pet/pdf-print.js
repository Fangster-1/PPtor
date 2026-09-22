'use strict';
const { CancelledError } = require('../core/errors');

/**
 * 可靠的 HTML → PDF 打印器。
 *
 * 每次打印使用独立的隐藏 BrowserWindow，并给 loadFile、DOM 资源等待和
 * printToPDF 分别设置期限。任何超时/取消都会销毁窗口、删除临时 HTML，
 * PDF 只在完整字节写入临时文件后原子替换，避免留下损坏的半成品。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { BrowserWindow } = require('electron');

const TIMEOUTS = Object.freeze({
  loadMs: 30000,
  mathMs: 5000,
  imagesMs: 12000,
  printMs: 60000
});

let activeWindow = null;

function isCancelled(signal) {
  return !!(signal && signal.cancelled);
}

function cancelError() {
  return new CancelledError();
}

function timeoutError(label, ms) {
  return new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`);
}

function destroyWindow(win) {
  try {
    if (win && !win.isDestroyed()) win.destroy();
  } catch {
    /* 窗口关闭失败不应覆盖原始打印错误 */
  }
  if (activeWindow === win) activeWindow = null;
}

/** 将一个 Electron Promise 绑定到超时和取消检查。 */
function runStage(operation, { signal, timeoutMs, label, onAbort }) {
  if (isCancelled(signal)) return Promise.reject(cancelError());

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let cancelPoll;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelPoll);
      fn(value);
    };
    const abort = (error) => {
      try {
        if (typeof onAbort === 'function') onAbort();
      } catch {
        /* 继续返回明确的取消/超时错误 */
      }
      finish(reject, error);
    };
    timer = setTimeout(() => abort(timeoutError(label, timeoutMs)), timeoutMs);
    cancelPoll = setInterval(() => {
      if (isCancelled(signal)) abort(cancelError());
    }, 100);

    Promise.resolve()
      .then(operation)
      .then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function tmpName(prefix, ext) {
  return path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`
  );
}

async function renameWithRetry(tmp, target, attempts = 5) {
  // Windows 上 PDF 刚写完时，杀毒/索引器可能短暂占用目标句柄导致 EPERM；
  // 实测为瞬时错误，短退避重试即可恢复。
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.promises.rename(tmp, target);
      return;
    } catch (err) {
      lastErr = err;
      if (err?.code !== 'EPERM' && err?.code !== 'EACCES' && err?.code !== 'EBUSY') throw err;
      await new Promise((resolve) => setTimeout(resolve, 120 * (i + 1)));
    }
  }
  throw lastErr;
}

async function writePdfAtomically(pdfPath, buffer) {
  await fs.promises.mkdir(path.dirname(pdfPath), { recursive: true });
  const tmp = `${pdfPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, buffer);
    // 目标目录由 pipeline 为本次任务新建；不删除已有 PDF，保证失败时
    // 旧文件仍然完整可用。调用方若要覆盖，应先清理任务目录。
    await renameWithRetry(tmp, pdfPath);
  } catch (err) {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

function createPrintWindow() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: true,
      webSecurity: true
    }
  });
  activeWindow = win;
  return win;
}

async function waitForImages(win, signal, timeoutMs) {
  return runStage(
    () =>
      win.webContents.executeJavaScript(
        `(() => {
          for (const img of document.images) img.loading = 'eager';
          const images = Array.from(document.images);
          return Promise.all(images.map((img) => {
          if (img.complete) {
            if (!img.naturalWidth || !img.naturalHeight) throw new Error('图片加载失败');
            return true;
          }
          return new Promise((resolve, reject) => {
            const done = () => {
              img.onload = null;
              img.onerror = null;
              if (!img.naturalWidth || !img.naturalHeight) {
                reject(new Error('图片加载失败'));
                return;
              }
              resolve(true);
            };
            img.onload = done;
            img.onerror = () => {
              img.onload = null;
              img.onerror = null;
              reject(new Error('图片加载失败'));
            };
          });
        }));
        })()`,
        false
      ),
    {
      signal,
      timeoutMs,
      label: '图片加载',
      onAbort: () => destroyWindow(win)
    }
  );
}

async function waitForMath(win, signal, timeoutMs) {
  // 公式由服务端 KaTeX renderToString 预渲染为 HTML（含内联 woff2 字体）；
  // 这里只等待 DOM 字体就绪（document.fonts.ready），超时后由 runStage 销毁窗口。
  return runStage(
    () =>
      win.webContents.executeJavaScript(
        `(() => {
          if (window.__pptorMathReady) return true;
          if (!window.__pptorMathPromise) {
            window.__pptorMathPromise = Promise.all([
              document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve(true),
              document.readyState === 'complete'
                ? Promise.resolve(true)
                : new Promise((resolve) => window.addEventListener('load', () => resolve(true), { once: true }))
            ]).then(() => { window.__pptorMathReady = true; return true; });
          }
          return window.__pptorMathPromise;
        })()`,
        false
      ),
    {
      signal,
      timeoutMs,
      label: '公式排版',
      onAbort: () => destroyWindow(win)
    }
  );
}

/**
 * @param {object} p
 * @param {string} p.html      完整 HTML 文本
 * @param {string} p.pdfPath   输出路径
 * @param {boolean} [p.needsMath]
 * @param {{cancelled:boolean}} [p.signal]
 * @param {object} [p.timeouts] 测试/诊断时覆盖各阶段期限
 * @returns {Promise<string>} pdfPath
 */
async function printHtmlToPdf({ html, pdfPath, needsMath = false, signal, timeouts = {} }) {
  const limits = { ...TIMEOUTS, ...timeouts };
  const tmpHtml = tmpName('pptor-print', '.html');
  const win = createPrintWindow();

  try {
    await fs.promises.writeFile(tmpHtml, String(html || ''), 'utf8');
    await runStage(() => win.loadFile(tmpHtml), {
      signal,
      timeoutMs: limits.loadMs,
      label: 'PDF 页面加载',
      onAbort: () => destroyWindow(win)
    });
    if (isCancelled(signal)) throw cancelError();

    if (needsMath) await waitForMath(win, signal, limits.mathMs);
    await waitForImages(win, signal, limits.imagesMs);
    if (isCancelled(signal)) throw cancelError();

    const buf = await runStage(
      () =>
        win.webContents.printToPDF({
          printBackground: true,
          preferCSSPageSize: true
        }),
      {
        signal,
        timeoutMs: limits.printMs,
        label: 'PDF 打印',
        onAbort: () => destroyWindow(win)
      }
    );
    if (!Buffer.isBuffer(buf) || buf.length < 5 || buf.subarray(0, 5).toString() !== '%PDF-') {
      throw new Error('PDF 打印返回了无效文件');
    }
    if (isCancelled(signal)) throw cancelError();
    await writePdfAtomically(pdfPath, buf);
    return pdfPath;
  } finally {
    try {
      await fs.promises.unlink(tmpHtml);
    } catch {
      /* 临时 HTML 清理失败不影响结果 */
    }
    destroyWindow(win);
  }
}

function dispose() {
  destroyWindow(activeWindow);
}

module.exports = { TIMEOUTS, dispose, printHtmlToPdf };
