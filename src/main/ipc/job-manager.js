'use strict';

/**
 * 翻译任务管理（从 ipc.js 抽出）：队列、取消信号、partial 结果与进度广播。
 * 忙时投喂不再直接拒绝：排队等待，前一个完成后自动起下一个。
 */
const fs = require('node:fs');
const path = require('node:path');

const { run } = require('../core/pipeline');
const { flushCache } = require('../core/translator');
const { withDeadline } = require('../core/async');
const { isCancelled } = require('../core/errors');
const registry = require('../core/registry');
const { root } = require('../paths');
const { getConfig, saveConfig, normalizeFormats } = require('../config');
const { printHtmlToPdf } = require('../pet/pdf-print');
const petWin = require('../pet/window');
const { broadcast } = require('./broadcast');

const PREFLIGHT_TIMEOUT_MS = 30000;

function createJobManager({ askViaPet, qaCreateSession, getCacheReady }) {
  let currentJob = null;
  const jobQueue = [];

  function createJobSignal() {
    const handlers = new Set();
    const signal = {
      cancelled: false,
      addCancelHandler(handler) {
        if (typeof handler !== 'function') return () => {};
        if (signal.cancelled) {
          try {
            handler();
          } catch {
            /* 取消清理不能阻断其它清理器 */
          }
          return () => {};
        }
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      cancel() {
        if (signal.cancelled) return;
        signal.cancelled = true;
        for (const handler of [...handlers]) {
          try {
            handler();
          } catch {
            /* 子进程/请求可能已结束 */
          }
        }
        handlers.clear();
      }
    };
    return signal;
  }

  /** 译文和原文只保留在主进程 QA 语料中，不通过 IPC 再复制一份到 renderer。 */
  function publicJobResult(result) {
    const results = (result.results || []).map((item) => {
      const { markdown: _markdown, translatedMarkdown: _translatedMarkdown, ...rest } = item;
      return rest;
    });
    const { papers: _papers, results: _results, ...summary } = result;
    return { ...summary, results };
  }

  async function runJobCore({ files, force, push, signal, done, resolveDone }) {
    let config = getConfig();
    // 补上文档库默认路径：<软件根目录>/translated（走 saveConfig，不直接变异单例）
    if (!config.output.libraryDir || !String(config.output.libraryDir).trim()) {
      config = saveConfig({ output: { libraryDir: path.join(root(), 'translated') } });
    }
    try {
      // 过去这些步骤既无进度也无期限。失联的网盘/U 盘会把界面永久留在“准备中”。
      for (let i = 0; i < files.length; i++) {
        const fileName = path.basename(files[i]);
        push({
          stage: 'prepare',
          percent: 0,
          phasePercent: null,
          phaseIndeterminate: true,
          message: `正在检查文件 ${i + 1}/${files.length}：${fileName}`
        });
        try {
          await withDeadline(() => fs.promises.access(files[i], fs.constants.R_OK), {
            timeoutMs: PREFLIGHT_TIMEOUT_MS,
            signal,
            label: `读取文件「${fileName}」`
          });
        } catch (err) {
          if (err?.code === 'ENOENT') throw new Error(`文件不存在：${files[i]}`);
          if (err?.code === 'EACCES') throw new Error(`无权读取文件：${files[i]}`);
          throw err;
        }
      }

      // 启动时缓存可后台加载；真正开工前等待它，避免读盘结果覆盖本次翻译写入。
      push({
        stage: 'prepare',
        percent: 0,
        phasePercent: null,
        phaseIndeterminate: true,
        message: '正在准备翻译缓存…'
      });
      const cacheReady = getCacheReady();
      if (cacheReady) {
        await withDeadline(() => cacheReady, {
          timeoutMs: PREFLIGHT_TIMEOUT_MS,
          signal,
          label: '准备翻译缓存'
        });
      }
      const result = await run({
        files,
        config,
        onProgress: push,
        signal,
        printPdf: (html, pdfPath, opts) => printHtmlToPdf({ html, pdfPath, ...opts }),
        force: !!force,
        onBeforeTranslate: async (info) => {
          const answer = await askViaPet({
            message: `${info.fileName}\n\n${info.reason}。\n还要继续翻译吗？`,
            options: [
              { value: 'translate', label: '仍然翻译' },
              { value: 'skip', label: '跳过这篇' }
            ],
            signal,
            askId: info.fileName
          });
          return answer === 'translate';
        }
      });

      // 本次任务读过的论文成为独立问答会话（旧会话保留，可切换）；
      // 失败/跳过任务没有语料，不建空会话
      const session = qaCreateSession(result.papers || []);
      const sources = session ? session.sources : [];

      const message = result.failed
        ? `${result.succeeded ? '部分翻译失败' : '翻译失败'}：${(result.failures || []).map((f) => `${f.name}：${f.message}`).join('\n')}`
        : result.succeeded ? '翻译完成' : '任务结束，没有生成新译文';
      push({ stage: result.failed ? 'error' : 'done', percent: 100, message });
      return { ...publicJobResult(result), message, qaSources: sources };
    } catch (err) {
      const message = (err && err.message) || String(err);
      // 取消时返回已完成的部分，供界面展示“已完成 N 篇 / 重试剩余”。
      if (isCancelled(err) && currentJob && Array.isArray(currentJob.partialResults) && currentJob.partialResults.length) {
        push({ stage: 'error', percent: 0, message });
        return { ok: false, message, cancelled: true, partialResults: currentJob.partialResults };
      }
      push({ stage: 'error', percent: 0, message });
      return { ok: false, message, cancelled: isCancelled(err) };
    } finally {
      currentJob = null;
      await flushCache();
      resolveDone();
      // 忙时排队的下一批自动开工
      const next = jobQueue.shift();
      if (next) {
        const sig = createJobSignal();
        let rd;
        const dn = new Promise((resolve) => { rd = resolve; });
        currentJob = { signal: sig, done: dn, files: next.files };
        const push2 = (data) => broadcast('job:progress', data);
        push2({ stage: 'prepare', percent: 0, message: `上一批完成，接着处理排队的 ${next.files.length} 篇…` });
        runJob({ files: next.files, force: next.force, push: push2, signal: sig, done: dn, resolveDone: rd })
          .then(next.resolve, next.reject);
      }
    }
  }

  /**
   * 任务包装层：结束（含排队续跑的每一批）后向所有窗口广播结果，
   * 供聊天窗渲染结果卡。广播失败不影响任务本身。
   */
  async function runJob(args) {
    const result = await runJobCore(args);
    try {
      broadcast('job:result', result);
    } catch {
      /* 窗口可能在广播瞬间被关闭 */
    }
    return result;
  }

  /** job:start 的处理主体 */
  async function start(payload) {
    const raw = payload && payload.files;
    const files = Array.isArray(raw) ? raw.filter(Boolean) : raw ? [raw] : [];
    if (!files.length) return { ok: false, message: '没有拿到文件路径' };

    const config = getConfig();
    if (!config.translate.apiKey) {
      return { ok: false, code: 'NO_API_KEY', message: '还没配置翻译模型的 API Key' };
    }

    if (currentJob) {
      // 不再直接拒绝：入队并告诉界面排队位置
      const position = jobQueue.length + 1;
      return new Promise((resolve, reject) => {
        jobQueue.push({ files, force: !!(payload && payload.force), resolve, reject });
        const win = petWin.getPetWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('job:progress', {
            stage: 'prepare', percent: 0, phaseIndeterminate: true,
            message: `已排队（第 ${position} 位），当前任务完成后自动开始，共 ${files.length} 篇`
          });
        }
      });
    }

    const signal = createJobSignal();
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    currentJob = { signal, done, files };

    const push = (data) => {
      broadcast('job:progress', data);
      // 记录已完成的部分，供取消时返回 partialResults
      if (data && data.stage === 'done') {
        currentJob.partialResults = (currentJob.partialResults || []).concat([data]);
      }
    };

    return runJob({ files, force: !!(payload && payload.force), push, signal, done, resolveDone });
  }

  function cancel() {
    if (!currentJob) return { ok: false, message: '当前没有进行中的任务' };
    currentJob.signal.cancel();
    return { ok: true, message: '已请求取消' };
  }

  function isBusy() {
    return !!currentJob;
  }

  /** 渲染层翻译前的去重预检（并发限流 4，原来是串行 withDeadline，N 篇延迟叠加） */
  async function checkFiles(files) {
    const config = getConfig();
    const targetFormats = normalizeFormats(config.output?.formats);

    const list = Array.isArray(files) ? files : [];
    const CONC = 4;
    const out = new Array(list.length);
    let cursor = 0;
    async function worker() {
      for (;;) {
        const idx = cursor++;
        if (idx >= list.length) return;
        const f = list[idx];
        try {
          const hit = await withDeadline(() => registry.lookup(f, { targetFormats }), {
            timeoutMs: PREFLIGHT_TIMEOUT_MS,
            label: `检查文件「${path.basename(f)}」`
          });
          out[idx] = {
            file: f,
            translated: hit.translated,
            record: hit.record,
            existingFormats: hit.existingFormats || [],
            missingFormats: hit.missingFormats || [],
            hasBundle: !!hit.hasBundle,
            outputsDeleted: !!hit.outputsDeleted
          };
        } catch {
          out[idx] = {
            file: f,
            translated: false,
            record: null,
            existingFormats: [],
            missingFormats: [],
            hasBundle: false
          };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, Math.max(1, list.length)) }, worker));
    return out;
  }

  /** 退出阶段：尽力等待任务收尾（最多 5 秒），随后由调用方 flush 缓存 */
  async function shutdown() {
    const job = currentJob;
    if (job) {
      job.signal.cancel();
      try {
        await Promise.race([job.done, new Promise((resolve) => setTimeout(resolve, 5000))]);
      } catch {
        /* 退出阶段尽力等待，不能阻止应用关闭 */
      }
    }
  }

  return { start, cancel, isBusy, checkFiles, shutdown };
}

module.exports = { createJobManager };
