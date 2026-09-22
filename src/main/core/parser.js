'use strict';

/**
 * PDF 转 Markdown 解析层（MinerU 云端 API / 本地命令行）
 *
 * 统一输出格式：
 *   { markdown: string, images: [{ name, data }], meta: {...} }
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { unzip, findBySuffix } = require('./zip');
const { CancelledError } = require('./errors');
const { addCancelHandler, sleep } = require('./async');

const MINERU_HOST = 'https://mineru.net';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_RESULT_ZIP_BYTES = 512 * 1024 * 1024;
const MAX_RESULT_UNZIPPED_BYTES = 768 * 1024 * 1024;
const MAX_RESULT_ENTRY_BYTES = 128 * 1024 * 1024;
const NETWORK_RETRY_DELAYS_MS = [800, 1800, 3500];

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i;

/** 只接受 ZIP 内的相对资源名，避免解析结果写盘时出现路径穿越。 */
function safeArchiveEntryName(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) return '';
  const normalized = path.posix.normalize(raw).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return '';
  return normalized;
}

function assetRefs(markdownName, imageName) {
  const refs = new Set([imageName]);
  const relative = path.posix.relative(path.posix.dirname(markdownName), imageName);
  if (relative && relative !== '.') refs.add(relative);
  return [...refs];
}
const MINERU_HINT = {
  A0202: 'Token 无效，请检查是否填错',
  A0211: 'Token 已过期，请到 mineru.net 重新创建',
  '-60002': '文件格式无法识别',
  '-60005': '文件超过 200MB 上限',
  '-60006': '页数超过 600 页上限',
  '-60008': '文件 URL 拉取超时'
};

function elapsedText(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

function networkDetail(err) {
  const parts = [];
  let current = err;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.cause) {
    const code = current.code ? `[${current.code}]` : '';
    const message = String(current.message || '').trim();
    if (message) parts.push(`${code}${message}`);
  }
  return [...new Set(parts)].join('；') || '未知网络错误';
}

function isTransientNetworkError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const detail = networkDetail(err);
  return /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENOTFOUND|超时/i.test(detail);
}

/**
 * MinerU 的轮询请求会跨越数分钟，企业代理、Wi-Fi 切换等偶发断连不应立刻终止任务。
 * 仅用于幂等的「查询状态」接口，不能包在创建任务或上传文件外层，避免重复创建/上传。
 */
async function retryMinerUPoll(request, onProgress, signal) {
  let attempt = 0;
  for (;;) {
    try {
      return await request();
    } catch (err) {
      if (signal?.cancelled) throw new CancelledError();
      if (!isTransientNetworkError(err) || attempt >= NETWORK_RETRY_DELAYS_MS.length) throw err;
      const delay = NETWORK_RETRY_DELAYS_MS[attempt];
      attempt += 1;
      onProgress({
        stage: 'parse',
        message: `MinerU 网络连接暂时中断，${Math.ceil(delay / 1000)} 秒后重试（${attempt}/${NETWORK_RETRY_DELAYS_MS.length}）…`
      });
      await sleep(delay, signal);
    }
  }
}

/* ================================================================== *
 * 通用 HTTP 小工具
 * ================================================================== */

async function httpJson(url, options = {}, timeoutMs = 60000, signal) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const removeCancel = addCancelHandler(signal, () => ctrl.abort());
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }

    if (json.code !== undefined && json.code !== 0) {
      const hint = MINERU_HINT[String(json.code)];
      throw new Error(`MinerU 错误 ${json.code}：${json.msg || '未知错误'}${hint ? `（${hint}）` : ''}`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}：${json.msg || json.message || text.slice(0, 200)}`);
    }
    return json;
  } catch (err) {
    if (signal?.cancelled) throw new CancelledError();
    if (timedOut) throw new Error(`网络请求超时（${Math.ceil(timeoutMs / 1000)} 秒）`, { cause: err });
    throw err;
  } finally {
    clearTimeout(timer);
    removeCancel();
  }
}

/* ================================================================== *
 * 通道一：本地 CLI
 * ================================================================== */

/**
 * 解码子进程输出。
 *
 * Windows 中文环境下 CLI（尤其 Python 写的）输出的是 GBK 字节，
 * 直接按 utf8 解会得到 '' 这类乱码。这里先按严格 utf8 试，
 * 失败再退回 GBK —— 两种都能正确处理，不必依赖系统区域设置。
 */
function decodeOutput(buf) {
  if (!buf || !buf.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return Buffer.from(buf).toString('utf8');
    }
  }
}

/** 探测本机是否存在可用的 MinerU 命令行 */
function detectLocalMinerU() {
  const probes = [
    { cmd: 'mineru', args: ['--version'] },
    { cmd: 'magic-pdf', args: ['--version'] }
  ];

  for (const probe of probes) {
    try {
      // 不传 encoding，拿原始 Buffer 自己解码（见 decodeOutput）
      const r = spawnSync(probe.cmd, probe.args, {
        timeout: 20000,
        shell: true, // Windows 下才能解析 .cmd / .bat
        windowsHide: true
      });
      if (r.error) continue;

      // 只有退出码为 0 才算真的探测到。
      // 命令不存在时 cmd 会返回 1，并把「'mineru' 不是内部或外部命令」
      // 写到 stderr —— 旧实现把这句话当成了版本号，于是误报「已检测到」。
      if (r.status !== 0) continue;

      const out = `${decodeOutput(r.stdout)}${decodeOutput(r.stderr)}`.trim();
      return { found: true, cmd: probe.cmd, version: out.split(/\r?\n/)[0] || '版本未知' };
    } catch {
      /* 换下一个候选 */
    }
  }
  return { found: false, cmd: null, version: null };
}

/** 异步版本：启动时探测不能用 spawnSync 卡住主进程。 */
async function detectLocalMinerUAsync() {
  const probes = [
    { cmd: 'mineru', args: ['--version'] },
    { cmd: 'magic-pdf', args: ['--version'] }
  ];
  for (const probe of probes) {
    const result = await new Promise((resolve) => {
      let settled = false;
      const child = spawn(probe.cmd, probe.args, { shell: true, windowsHide: true });
      const stdout = [];
      const stderr = [];
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
        finish({ found: false });
      }, 20000);
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      child.stdout?.on('data', (chunk) => stdout.push(chunk));
      child.stderr?.on('data', (chunk) => stderr.push(chunk));
      child.on('error', () => finish({ found: false }));
      child.on('close', (status) => {
        if (status !== 0) return finish({ found: false });
        const out = `${decodeOutput(Buffer.concat(stdout))}${decodeOutput(Buffer.concat(stderr))}`.trim();
        finish({ found: true, cmd: probe.cmd, version: out.split(/\r?\n/)[0] || '版本未知' });
      });
    });
    if (result.found) return result;
  }
  return { found: false, cmd: null, version: null };
}

async function parseLocal(pdfPath, outDir, opts, onProgress, signal) {
  const cli = detectLocalMinerU();
  if (!cli.found) {
    throw new Error('本机未找到 mineru / magic-pdf 命令。请改用云端通道，或先安装 MinerU。');
  }

  // Windows 下 .cmd 包装器需要 shell:true 才能运行。绝不将用户可控的文件名
  // 拼进命令行：先复制进本次唯一工作目录，给 shell 的只有固定安全路径。
  const cliInputDir = path.join(path.dirname(outDir), 'cli-input');
  const safePdfPath = path.join(cliInputDir, 'source.pdf');
  await fs.promises.mkdir(cliInputDir, { recursive: true });
  await fs.promises.copyFile(pdfPath, safePdfPath);

  const args = ['-p', safePdfPath, '-o', outDir];
  if (cli.cmd === 'mineru') {
    // 新版 mineru 支持 -b 指定解析后端
    const backend = ['pipeline', 'vlm', 'hybrid'].includes(opts.modelVersion) ? opts.modelVersion : 'pipeline';
    args.push('-b', backend);
  } else {
    // 旧版 magic-pdf 用 -m 指定解析方式
    args.push('-m', opts.isOcr ? 'ocr' : 'auto');
  }

  const startedAt = Date.now();
  onProgress({ stage: 'parse', message: `调用本地 ${cli.cmd}（${cli.version}）解析…` });

  return new Promise((resolve, reject) => {
    const child = spawn(cli.cmd, args, { shell: true, windowsHide: true });
    let stderrBuf = '';
    const heartbeat = setInterval(() => {
      onProgress({ stage: 'parse', message: `本地 MinerU 正在解析（已用 ${elapsedText(startedAt)}，可取消）` });
    }, 4000);
    heartbeat.unref?.();
    const finish = () => clearInterval(heartbeat);

    const onCancel = () => {
      try {
        child.kill();
      } catch {
        /* 进程可能已结束 */
      }
    };
    const removeCancel = addCancelHandler(signal, onCancel);

    const pipeLine = (chunk) => {
      const text = chunk.toString().trim();
      if (!text) return;
      const last = text.split(/\r?\n/).filter(Boolean).pop();
      onProgress({ stage: 'parse', message: `MinerU：${(last || '').slice(0, 120)}` });
    };

    child.stdout.on('data', pipeLine);
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      pipeLine(chunk);
    });

    child.on('error', (err) => {
      finish();
      reject(err);
    });
    child.on('close', async (code) => {
      finish();
      removeCancel();
      if (signal?.cancelled) return reject(new CancelledError());
      if (code !== 0) {
        return reject(new Error(`本地 MinerU 退出码 ${code}\n${stderrBuf.slice(-800)}`));
      }
      try {
        resolve(await collectLocalResult(outDir));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** 从本地输出目录里找出主 Markdown 与图片（异步：图片可能多且大） */
async function collectLocalResult(outDir) {
  const mdFiles = [];
  const imageFiles = [];

  const walk = async (dir) => {
    let items = [];
    try {
      items = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else if (item.name.toLowerCase().endsWith('.md')) {
        mdFiles.push({ full, size: (await fs.promises.stat(full)).size });
      } else if (IMAGE_EXT.test(item.name)) {
        imageFiles.push(full);
      }
    }
  };
  await walk(outDir);

  if (!mdFiles.length) throw new Error('本地 MinerU 未产出 Markdown，请检查其运行日志');
  mdFiles.sort((a, b) => b.size - a.size); // 主文档通常最大

  const mainMarkdown = mdFiles[0].full;
  const markdown = await fs.promises.readFile(mainMarkdown, 'utf8');
  const images = [];
  for (const full of imageFiles) {
    const canonicalName = safeArchiveEntryName(path.relative(outDir, full));
    if (!canonicalName) continue;
    const relativeToMarkdown = path.relative(path.dirname(mainMarkdown), full).replace(/\\/g, '/');
    images.push({
      name: canonicalName,
      refs: [...new Set([canonicalName, relativeToMarkdown])].filter(Boolean),
      data: await fs.promises.readFile(full)
    });
  }
  return { markdown, images, meta: { source: 'local', mdPath: mainMarkdown } };
}

/* ================================================================== *
 * 云端 API（Token）
 * ================================================================== */

async function parseCloud(pdfPath, workDir, opts, onProgress, signal) {
  const token = (opts.mineruToken || '').trim();
  if (!token) throw new Error('未配置 MinerU Token，请右键宠物 →「配置 MinerU 解析」填写（mineru.net 免费申请）');

  const rawFileName = path.basename(pdfPath);
  // 向云端申请上传链接时净化文件名：剔除非 ASCII 特殊字符（如弯引号、控制字符）、限制长度，
  // 彻底避免 OSS 预签名 URL 编码或云端 Python 处理路径时的崩溃。实际产物仍使用正文提取的中文标题。
  const safeUploadName =
    rawFileName.replace(/[^\w\u4e00-\u9fa5.-]/g, '_').slice(0, 80) || 'paper.pdf';

  const startedAt = Date.now();
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  onProgress({ stage: 'parse', message: '申请 MinerU 上传链接…' });
  const created = await httpJson(`${MINERU_HOST}/api/v4/file-urls/batch`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      files: [{ name: safeUploadName.endsWith('.pdf') ? safeUploadName : `${safeUploadName}.pdf`, is_ocr: !!opts.isOcr }],
      model_version: opts.modelVersion || 'vlm',
      enable_formula: true,
      enable_table: true,
      language: opts.language || 'ch'
    })
  }, 60000, signal);

  const batchId = created?.data?.batch_id;
  const uploadUrl = created?.data?.file_urls?.[0];
  if (!batchId || !uploadUrl) throw new Error('申请上传链接失败：返回结构异常');

  await uploadFile(uploadUrl, pdfPath, onProgress, signal);
  onProgress({ stage: 'parse', message: 'PDF 已上传，等待 MinerU 解析队列…' });

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let pollCount = 0;
  for (;;) {
    if (signal?.cancelled) throw new CancelledError();
    if (Date.now() > deadline) throw new Error('MinerU 解析超时（超过 30 分钟）');
    // 前几次采用较短轮询间隔（2.5s），快速获取结果；之后放缓到 4s
    const pollInterval = pollCount < 4 ? 2500 : 4000;
    pollCount++;
    await sleep(pollInterval, signal);

    let res;
    try {
      res = await retryMinerUPoll(
        () => httpJson(`${MINERU_HOST}/api/v4/extract-results/batch/${batchId}`, {
          headers: { Authorization: `Bearer ${token}` }
        }, 60000, signal),
        onProgress,
        signal
      );
    } catch (err) {
      if (isTransientNetworkError(err)) {
        throw new Error(`查询 MinerU 解析进度失败，请检查网络或代理后重试：${networkDetail(err)}`, { cause: err });
      }
      throw err;
    }
    const item = res?.data?.extract_result?.[0];
    const state = item?.state;

    if (state === 'done') {
      if (!item.full_zip_url) throw new Error('解析完成但未返回结果包地址');
      onProgress({ stage: 'parse', message: '下载并解压解析结果…' });
      return await downloadZip(item.full_zip_url, workDir, signal);
    }
    if (state === 'failed') {
      throw new Error(`MinerU 解析失败：${item.err_msg || '未知原因'}`);
    }
    onProgress({
      stage: 'parse',
      message: `MinerU ${state || 'running'}（已用 ${elapsedText(startedAt)}，可取消）`
    });
  }
}

/**
 * PUT 上传本地 PDF
 * 常见学术论文（<= 64MB）采用整块 Buffer 上传，彻底杜绝 Stream 竞争与锁死问题。
 * 大文件使用 PassThrough 安全流管道，绝不在可读流上直接消费数据。
 */
async function uploadFile(uploadUrl, pdfPath, onProgress, signal) {
  const { size } = await fs.promises.stat(pdfPath);
  onProgress({ stage: 'parse', message: `上传 PDF（${(size / 1048576).toFixed(1)} MB）…` });

  const isBufferUpload = size <= 64 * 1024 * 1024;

  for (let attempt = 0;; attempt += 1) {
    const ctrl = new AbortController();
    const removeCancel = addCancelHandler(signal, () => ctrl.abort());
    try {
      let body;
      if (isBufferUpload) {
        body = await fs.promises.readFile(pdfPath);
      } else {
        const { PassThrough } = require('node:stream');
        const pass = new PassThrough();
        const fileStream = fs.createReadStream(pdfPath);
        let uploaded = 0;
        let lastReport = 0;
        pass.on('data', (chunk) => {
          uploaded += chunk.length;
          const now = Date.now();
          if (now - lastReport < 400 && uploaded < size) return;
          lastReport = now;
          const pct = Math.min(100, Math.round((uploaded / size) * 100));
          onProgress({
            stage: 'parse',
            message: `上传 PDF ${pct}%（${(uploaded / 1048576).toFixed(1)} / ${(size / 1048576).toFixed(1)} MB）`
          });
        });
        fileStream.pipe(pass);
        body = pass;
      }

      const res = await fetch(uploadUrl, {
        method: 'PUT',
        body,
        headers: { 'Content-Length': String(size) },
        duplex: 'half',
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error(`上传失败：HTTP ${res.status}`);
      return;
    } catch (err) {
      if (signal?.cancelled) throw new CancelledError();
      if (!isTransientNetworkError(err) || attempt >= NETWORK_RETRY_DELAYS_MS.length) {
        if (isTransientNetworkError(err)) {
          throw new Error(`上传 PDF 失败，请检查网络或代理后重试：${networkDetail(err)}`, { cause: err });
        }
        throw err;
      }
      const delay = NETWORK_RETRY_DELAYS_MS[attempt];
      onProgress({
        stage: 'parse',
        message: `上传连接暂时中断，${Math.ceil(delay / 1000)} 秒后重试（${attempt + 1}/${NETWORK_RETRY_DELAYS_MS.length}）…`
      });
      await sleep(delay, signal);
    } finally {
      removeCancel();
    }
  }
}

/** 下载结果 ZIP 并抽出 Markdown / 图片 */
async function downloadZip(zipUrl, workDir, signal) {
  const ctrl = new AbortController();
  const removeCancel = addCancelHandler(signal, () => ctrl.abort());
  try {
    // 取消监听必须覆盖整个响应体读取阶段；只包住 fetch 会在收到响应头后
    // 提前移除监听，导致无数据流卡住时 job:cancel 无法中止请求。
    const res = await fetch(zipUrl, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`下载结果包失败：HTTP ${res.status}`);

    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_RESULT_ZIP_BYTES) {
      throw new Error(`解析结果包过大（超过 ${MAX_RESULT_ZIP_BYTES / 1048576} MB），已停止下载`);
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body || []) {
      if (signal?.cancelled) throw new CancelledError();
      total += chunk.length;
      if (total > MAX_RESULT_ZIP_BYTES) {
        try {
          await res.body?.cancel();
        } catch {
          /* 忽略取消流失败 */
        }
        throw new Error(`解析结果包过大（超过 ${MAX_RESULT_ZIP_BYTES / 1048576} MB），已停止下载`);
      }
      chunks.push(chunk);
    }
    const entries = unzip(Buffer.concat(chunks, total), {
      maxTotalBytes: MAX_RESULT_UNZIPPED_BYTES,
      maxEntryBytes: MAX_RESULT_ENTRY_BYTES
    });

    const mdEntry =
      findBySuffix(entries, 'full.md') ||
      entries
        .filter((e) => e.name.toLowerCase().endsWith('.md'))
        .sort((a, b) => b.size - a.size)[0];

    if (!mdEntry) throw new Error('结果包中未找到 Markdown 文件');

    const markdownName = safeArchiveEntryName(mdEntry.name);
    if (!markdownName) throw new Error('结果包中的 Markdown 路径不安全');
    const images = entries
      .filter((e) => IMAGE_EXT.test(e.name))
      .map((e) => ({ entry: e, name: safeArchiveEntryName(e.name) }))
      .filter((item) => item.name)
      .map(({ entry, name }) => ({ name, refs: assetRefs(markdownName, name), data: entry.data }));

    return {
      markdown: mdEntry.data.toString('utf8'),
      images,
      meta: { source: 'cloud', entries: entries.length }
    };
  } catch (err) {
    if (signal?.cancelled) throw new CancelledError();
    throw err;
  } finally {
    removeCancel();
  }
}

/* ================================================================== *
 * 统一入口
 * ================================================================== */

async function validatePdfInput(pdfPath) {
  let handle;
  try {
    const stat = await fs.promises.stat(pdfPath);
    if (!stat.isFile()) throw new Error('不是普通文件');
    if (stat.size < 5) throw new Error('文件过小');
    handle = await fs.promises.open(pdfPath, 'r');
    const header = Buffer.alloc(5);
    await handle.read(header, 0, header.length, 0);
    if (header.toString('ascii') !== '%PDF-') throw new Error('文件头不是 PDF');
  } catch (err) {
    throw new Error(`无法读取有效 PDF：${err.message || err}`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * @param {object} p
 * @param {string} p.pdfPath
 * @param {string} p.workDir   临时工作目录
 * @param {object} p.parserConfig  config.parser
 * @param {(e:{stage:string,message:string})=>void} p.onProgress
 * @param {{cancelled:boolean}} [p.signal]
 */
async function parse({ pdfPath, workDir, parserConfig, onProgress, signal }) {
  if (signal?.cancelled) throw new CancelledError();
  await validatePdfInput(pdfPath);
  await fs.promises.mkdir(workDir, { recursive: true });

  // 只认 local / cloud；老配置里的 cloud-free 一律按 cloud 处理
  const mode = parserConfig.mode === 'local' ? 'local' : 'cloud';
  const started = Date.now();

  let result;
  if (mode === 'local') {
    result = await parseLocal(pdfPath, path.join(workDir, 'mineru-out'), parserConfig, onProgress, signal);
  } else {
    result = await parseCloud(pdfPath, workDir, parserConfig, onProgress, signal);
  }

  if (!result.markdown || !result.markdown.trim()) {
    throw new Error('解析结果为空，可能是扫描件需要开启 OCR，或 PDF 内容异常');
  }

  // 图片落盘，保持 Markdown 里的 images/xxx 相对路径可解析
  if (result.images.length) {
    const imgDir = path.join(workDir, 'parsed', 'images');
    await fs.promises.mkdir(imgDir, { recursive: true });
    for (const img of result.images) {
      const name = safeArchiveEntryName(img.name);
      if (!name) continue;
      const destination = path.join(imgDir, ...name.split('/'));
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.writeFile(destination, img.data);
    }
  }

  result.meta.elapsedMs = Date.now() - started;
  result.meta.imageCount = result.images.length;
  return result;
}

/**
 * 测试 MinerU 连接状态（0 额度消耗，不产生任何解析费用）
 * cloud 模式：探针探测 Token 鉴权与网络连通性
 * local 模式：探测本地 mineru / magic-pdf 命令行是否可用
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function checkParserConnectivity(parserConfig) {
  const cfg = parserConfig || {};
  const mode = cfg.mode === 'local' ? 'local' : 'cloud';

  if (mode === 'local') {
    const cli = await detectLocalMinerUAsync();
    return { ok: cli.found, reason: cli.found ? cli.version : '未找到本地命令' };
  }

  const token = (cfg.mineruToken || '').trim();
  if (!token) {
    return { ok: false, reason: 'unconfigured' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);
  try {
    // 使用真实的“查询批次结果”路由和固定不存在的 UUID：不创建任务、不消耗额度，
    // 但能验证 Token 与 MinerU 网关。旧的 check-probe 并不是公开 API 路由。
    const res = await fetch(`${MINERU_HOST}/api/v4/extract-results/batch/00000000-0000-4000-8000-000000000000`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal
    });
    clearTimeout(timer);

    // MinerU 在 token 有效时返回 200（任务不存在 code: -60012），未授权时返回 401
    if (res.ok) {
      return { ok: true };
    }
    const reason = res.status === 401 ? 'HTTP 401 Token 失效' : `HTTP ${res.status}`;
    return { ok: false, reason };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return { ok: false, reason: '连接超时' };
    return { ok: false, reason: err.message || '网络连接失败' };
  }
}

module.exports = { parse, detectLocalMinerU, detectLocalMinerUAsync, checkParserConnectivity, safeArchiveEntryName };
