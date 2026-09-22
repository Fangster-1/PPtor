'use strict';

/**
 * 翻译记录台账（避免重复翻译，支持多格式免重翻极速导出）。
 *
 * 记录文件：<软件根目录>/config/translated.json
 * 成果快照的存取在 ./bundles.js，本地格式解析器在 ./extract.js。
 * 键为「文件内容 SHA-1 + 大小」——文件改名/移动后仍能识别为同一篇论文。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { dataFile } = require('../paths');
const { writeJsonAtomic } = require('./fsx');
const bundles = require('./bundles');
const { normalizeFormat } = bundles;

const REGISTRY_VERSION = 2;
const MAX_ENTRIES = 2000;

const SUPPORTED_EXTS = ['.pdf', '.docx', '.md', '.html'];
const EXT_TO_FORMAT = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.md': 'md',
  '.html': 'html'
};

let entries = null; // Map<key, record>

function registryPath() {
  return dataFile('translated.json');
}

/* ------------------------------ 指纹 ------------------------------ */

/**
 * 文件指纹：内容 hash（大文件只取头尾+抽样，避免整读大 PDF 卡 UI；异步读取）
 * @returns {Promise<{key: string, size: number}>}
 */
async function fingerprint(filePath) {
  const stat = await fs.promises.stat(filePath);
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { key } = readFingerprintSync(fh.fd, stat.size);
    return { key, size: stat.size };
  } finally {
    await fh.close();
  }
}

/**
 * 同步指纹 —— 与 fingerprint 同算法（大小 + 头 4MB + 尾 1MB 的 SHA-1）。
 * 登记发生在翻译刚结束时，文件还在 OS 缓存里，同步读代价可接受。
 */
function fingerprintSync(filePath) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  try {
    const { key } = readFingerprintSync(fd, stat.size);
    return { key, size: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

function readFingerprintSync(fd, size) {
  const headLen = Math.min(4 * 1024 * 1024, size);
  const head = Buffer.alloc(headLen);
  fs.readSync(fd, head, 0, headLen, 0);

  let tail = Buffer.alloc(0);
  if (size > headLen) {
    const tailLen = Math.min(1024 * 1024, size - headLen);
    tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  }

  const key = crypto
    .createHash('sha1')
    .update(`${size}`)
    .update(head)
    .update(tail)
    .digest('hex');
  return { key };
}

/* ---------------------------- 记录读写 ---------------------------- */

/** 懒加载（异步：translated.json 可达数百 KB，同步读会卡主进程） */
async function load() {
  if (entries) return entries;
  entries = new Map();
  try {
    const raw = JSON.parse(await fs.promises.readFile(registryPath(), 'utf8'));
    if (Array.isArray(raw.entries)) {
      for (const e of raw.entries) entries.set(e.key, e);
    }
  } catch {
    /* 首次运行或文件损坏（原子写后基本不会发生） */
  }
  return entries;
}

async function persist() {
  try {
    // 上限保护，超出时丢最旧的
    if (entries.size > MAX_ENTRIES) {
      const sorted = [...entries.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
      for (const e of sorted.slice(0, entries.size - MAX_ENTRIES)) entries.delete(e.key);
    }
    await writeJsonAtomic(registryPath(), {
      version: REGISTRY_VERSION,
      entries: [...entries.values()]
    });
  } catch (err) {
    console.warn('[registry] 保存失败：', err.message);
  }
}

/**
 * 扫描记录在磁盘上实际存在的产物文件与格式。
 * 如果用户将部分或全部译文删除了，记录能精准感知。
 */
function inspectRecordOutputs(record) {
  if (!record) {
    return { hasAny: false, existingFiles: [], existingFormats: [] };
  }

  const existingFiles = [];
  const existingFormatsSet = new Set();

  // 1. 若记录了具体的文件清单，以 record.files 为准检验磁盘文件
  if (Array.isArray(record.files) && record.files.length > 0) {
    for (const f of record.files) {
      const p = typeof f === 'string' ? f : (f.path || (record.outDir && path.join(record.outDir, f.name)));
      if (!p) continue;
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile() && fs.statSync(p).size > 0) {
          const ext = path.extname(p).toLowerCase();
          const format = normalizeFormat(f.format || EXT_TO_FORMAT[ext] || ext.slice(1));
          existingFiles.push({
            path: p,
            name: path.basename(p),
            format
          });
          if (format) existingFormatsSet.add(format);
        }
      } catch {
        /* ignore */
      }
    }
  } else if (record.outDir && fs.existsSync(record.outDir)) {
    // 2. 仅当未记录 files 清单时（如历史旧版本），回退扫描输出目录下与 baseName / title 匹配的文件
    const baseNames = [
      record.baseName,
      record.title
    ].filter(Boolean);

    for (const base of baseNames) {
      for (const ext of SUPPORTED_EXTS) {
        const target = path.join(record.outDir, `${base}${ext}`);
        if (fs.existsSync(target)) {
          try {
            if (fs.statSync(target).size > 0) {
              const format = EXT_TO_FORMAT[ext];
              if (!existingFiles.some((item) => item.path === target)) {
                existingFiles.push({
                  path: target,
                  name: path.basename(target),
                  format
                });
              }
              if (format) existingFormatsSet.add(format);
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  const existingFormats = [...existingFormatsSet];
  return {
    hasAny: existingFiles.length > 0,
    existingFiles,
    existingFormats
  };
}

/**
 * 检查翻译产物文件是否在磁盘上实际存在。
 * 如果用户将译文删除了，记录与磁盘脱节，必须能被识别出来。
 */
function hasExistingOutputs(record) {
  return inspectRecordOutputs(record).hasAny;
}

/**
 * 查一个文件是否翻译过。
 * 支持生命周期实时检测（4种状态判定）：
 * 1. 场景 A（译文存在，快照存在）：正常已翻译；
 * 2. 场景 B（译文被删，快照存在）：标记 outputsDeleted=true, hasBundle=true，允许免重翻重新生成；
 * 3. 场景 C（译文存在，快照被删）：0 Token 自动从译文补全快照，自愈为 hasBundle=true；
 * 4. 场景 D（译文与快照均被删）：彻底清除翻译记录，返回未翻译以供全新翻译。
 */
async function lookup(filePath, { targetFormats = [] } = {}) {
  const { key } = await fingerprint(filePath);
  const store = await load();
  let record = store.get(key) || null;
  const bundleStat = bundles.inspectBundleFile(key);

  if (!record && !bundleStat.exists) {
    return {
      translated: false,
      key,
      record: null,
      existingFormats: [],
      missingFormats: [],
      hasBundle: false,
      outputsDeleted: false
    };
  }

  // 若 store 中遗漏记录但本地存在快照，自动尝试重构记录
  if (!record && bundleStat.exists) {
    const bundleData = await bundles.getBundle(key);
    if (bundleData) {
      record = {
        key,
        at: bundleData.at || bundleStat.mtime || Date.now(),
        file: path.basename(filePath),
        title: bundleData.title || '',
        baseName: bundleData.baseName || '',
        outDir: bundleData.outDir || '',
        formats: bundleData.formats || [],
        files: bundleData.files || [],
        model: bundleData.model || '',
        targetLang: bundleData.targetLang || 'zh'
      };
      store.set(key, record);
      await persist();
    }
  }

  if (!record) {
    return {
      translated: false,
      key,
      record: null,
      existingFormats: [],
      missingFormats: [],
      hasBundle: false,
      outputsDeleted: false
    };
  }

  const inspected = inspectRecordOutputs(record);
  const hasOutputs = inspected.hasAny;
  let hasBundle = bundleStat.exists;

  // 场景 D：哈希压缩文件删除了，同时译文文档也被删除了
  if (!hasOutputs && !hasBundle) {
    store.delete(key);
    await persist();
    return {
      translated: false,
      key,
      record: null,
      outputsDeleted: true,
      existingFormats: [],
      missingFormats: [],
      hasBundle: false
    };
  }

  // 场景 C：哈希压缩文件删除了，但是译文文档还在 -> 0 Token 自动补全！
  if (hasOutputs && !hasBundle) {
    const replenished = await bundles.replenishBundle(key, record, inspected);
    if (replenished) {
      hasBundle = true;
    }
  }

  // 场景 B：译文文档被删除，但是哈希压缩的译文文件还在
  if (!hasOutputs && hasBundle) {
    record.outputsDeleted = true;
    record.hasBundle = true;
    record.bundlePath = bundleStat.path;
    record.bundleSize = bundleStat.size;
    record.bundleMtime = bundleStat.mtime;
    record.files = [];
    record.formats = [];
    await persist();

    const normalizedTargets = targetFormats
      .map(normalizeFormat)
      .filter((f) => SUPPORTED_EXTS.map((e) => e.slice(1)).includes(f));
    const missingFormats = normalizedTargets.length > 0 ? normalizedTargets : (record.formats?.length ? record.formats : ['pdf']);

    return {
      translated: true,
      key,
      record,
      outputsDeleted: true,
      existingFormats: [],
      missingFormats,
      hasBundle: true
    };
  }

  // 场景 A：译文文档存在且哈希压缩文件存在（正常已翻译）
  record.outputsDeleted = false;
  record.hasBundle = true;
  record.bundlePath = bundleStat.path;
  record.bundleSize = bundleStat.size;
  record.bundleMtime = bundleStat.mtime;
  record.files = inspected.existingFiles;
  record.formats = inspected.existingFormats;
  await persist();

  const normalizedTargets = targetFormats
    .map(normalizeFormat)
    .filter((f) => SUPPORTED_EXTS.map((e) => e.slice(1)).includes(f));
  const missingFormats = normalizedTargets.filter((fmt) => !inspected.existingFormats.includes(fmt));

  return {
    translated: true,
    key,
    record,
    outputsDeleted: false,
    existingFormats: inspected.existingFormats,
    missingFormats,
    hasBundle: true
  };
}

/** 标记一篇已完成（若重新翻译，覆盖旧快照并更新记录） */
async function markDone(filePath, info = {}) {
  const { key, size } = await fingerprint(filePath);
  const rawFiles = Array.isArray(info.files) ? info.files : [];
  const normalizedFiles = rawFiles
    .filter((f) => f && f.path)
    .map((f) => {
      const ext = path.extname(f.path).toLowerCase();
      return {
        path: f.path,
        name: f.name || path.basename(f.path),
        format: normalizeFormat(f.format || EXT_TO_FORMAT[ext] || ext.slice(1))
      };
    });

  const formats = Array.isArray(info.formats)
    ? info.formats.map(normalizeFormat)
    : [...new Set(normalizedFiles.map((f) => f.format).filter(Boolean))];

  const bStat = bundles.inspectBundleFile(key);
  const record = {
    key,
    at: Date.now(),
    file: path.basename(filePath),
    size,
    ...info,
    formats,
    files: normalizedFiles,
    outputsDeleted: false,
    hasBundle: bStat.exists,
    bundlePath: bStat.path,
    bundleSize: bStat.size,
    bundleMtime: bStat.mtime
  };

  (await load()).set(key, record);
  await persist();
}

/**
 * 增量更新已翻译记录的输出文件与格式列表
 */
async function updateOutputs(key, { files = [], formats = [], outDir } = {}) {
  const store = await load();
  const record = store.get(key);
  if (!record) return false;

  const currentFiles = Array.isArray(record.files) ? [...record.files] : [];
  for (const f of files) {
    if (!f || !f.path) continue;
    const ext = path.extname(f.path).toLowerCase();
    const item = {
      path: f.path,
      name: f.name || path.basename(f.path),
      format: normalizeFormat(f.format || EXT_TO_FORMAT[ext] || ext.slice(1))
    };
    const idx = currentFiles.findIndex((cf) => cf.path === item.path || cf.name === item.name);
    if (idx >= 0) {
      currentFiles[idx] = item;
    } else {
      currentFiles.push(item);
    }
  }

  const currentFormats = new Set(Array.isArray(record.formats) ? record.formats.map(normalizeFormat) : []);
  for (const fmt of formats) currentFormats.add(normalizeFormat(fmt));
  for (const f of currentFiles) if (f.format) currentFormats.add(normalizeFormat(f.format));

  const bStat = bundles.inspectBundleFile(key);
  record.files = currentFiles;
  record.formats = [...currentFormats];
  record.outputsDeleted = false; // 重新生成后重置标记
  record.hasBundle = bStat.exists;
  record.bundlePath = bStat.path;
  record.bundleSize = bStat.size;
  record.bundleMtime = bStat.mtime;
  if (outDir) record.outDir = outDir;
  record.at = Date.now();

  await persist();
  return true;
}

/** 清除一篇的记录（强制重翻前调用） */
async function forget(filePath) {
  const { key } = await fingerprint(filePath);
  (await load()).delete(key);
  await persist();

  // 清除对应的快照文件
  try {
    const p = bundles.bundleFilePath(key);
    if (fs.existsSync(p)) await fs.promises.unlink(p);
  } catch {
    /* ignore */
  }
}

/** 全部记录（供 UI 展示，包含磁盘强校验、脏数据自动清理与 0 Token 自愈） */
async function list() {
  const store = await load();
  let changed = false;
  const result = [];

  for (const [key, record] of store.entries()) {
    const bundleStat = bundles.inspectBundleFile(key);
    const inspected = inspectRecordOutputs(record);
    const hasOutputs = inspected.hasAny;
    const hasBundle = bundleStat.exists;

    // 场景 D：两者均不存在 -> 清除记录
    if (!hasOutputs && !hasBundle) {
      store.delete(key);
      changed = true;
      continue;
    }

    // 场景 C：产物存在但 bundle 丢失 -> 0 Token 自动补全
    if (hasOutputs && !hasBundle) {
      const replenished = await bundles.replenishBundle(key, record, inspected);
      if (replenished) {
        const newStat = bundles.inspectBundleFile(key);
        record.hasBundle = true;
        record.bundlePath = newStat.path;
        record.bundleSize = newStat.size;
        record.bundleMtime = newStat.mtime;
        changed = true;
      }
    }

    // 场景 B：产物不存在但 bundle 存在 -> 标记 outputsDeleted
    if (!hasOutputs && hasBundle) {
      if (!record.outputsDeleted || (record.files && record.files.length > 0)) {
        record.outputsDeleted = true;
        record.files = [];
        record.formats = [];
        changed = true;
      }
    } else if (hasOutputs) {
      if (record.outputsDeleted || (record.files || []).length !== inspected.existingFiles.length) {
        record.outputsDeleted = false;
        record.files = inspected.existingFiles;
        record.formats = inspected.existingFormats;
        changed = true;
      }
    }

    const finalStat = bundles.inspectBundleFile(key);
    record.hasBundle = finalStat.exists;
    record.bundlePath = finalStat.path;
    record.bundleSize = finalStat.size;
    record.bundleMtime = finalStat.mtime;

    result.push(record);
  }

  if (changed) {
    await persist();
  }

  return result.sort((a, b) => (b.at || 0) - (a.at || 0));
}

module.exports = {
  lookup,
  markDone,
  updateOutputs,
  forget,
  list,
  fingerprint,
  fingerprintSync,
  inspectRecordOutputs,
  hasExistingOutputs,
  normalizeFormat,
  // 以下为拆分前的旧导出符号，继续透传保持调用方兼容
  inspectBundleFile: bundles.inspectBundleFile,
  replenishBundle: bundles.replenishBundle,
  extractMarkdownFromDocx: require('./extract').extractMarkdownFromDocx,
  extractTextFromPdf: require('./extract').extractTextFromPdf,
  saveBundle: bundles.saveBundle,
  getBundle: bundles.getBundle,
  updateBundle: bundles.updateBundle
};
