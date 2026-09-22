'use strict';

/**
 * 译文库索引
 *
 * 维护译文产物文件指纹与翻译记录的映射，支持根据译文文件反查所属论文。
 *
 * 匹配策略：
 *   1) 内容指纹匹配（精确匹配）
 *   2) 所在目录名与文件名回退匹配（支持编辑后的译文识别）
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { writeJsonAtomicSync, writeTextAtomicSync } = require('./fsx');
const { fingerprint, fingerprintSync } = require('./registry');
const { dataFile, root: projectRoot } = require('../paths');
const { getConfig } = require('../config');

const INDEX_VERSION = 1;
const INDEX_NAME = '_index.json';
const INTERNAL_INDEX_DIR = 'library-index';
const MAX_WORKS = 1000;
const MAX_QA_CHARS = 12 * 1024 * 1024;

/**
 * 译文库根目录（全仓唯一实现）。
 * 规则：配置 output.libraryDir 为空时取 <软件根目录>/translated。
 */
function root() {
  const cfg = getConfig();
  const dir = ((cfg.output && cfg.output.libraryDir) || '').trim();
  return dir || path.join(projectRoot(), 'translated');
}

function indexPath(libraryRoot) {
  const key = crypto.createHash('sha1').update(path.resolve(libraryRoot)).digest('hex').slice(0, 20);
  // Node 自测/脚本没有 Electron 的用户数据目录，落到临时目录，绝不污染译文输出或源码。
  const base = process.versions.electron
    ? dataFile(path.join(INTERNAL_INDEX_DIR, `${key}.json`))
    : path.join(os.tmpdir(), 'pptor', INTERNAL_INDEX_DIR, `${key}.json`);
  return base;
}

function qaPath(libraryRoot, key) {
  const hash = crypto
    .createHash('sha1')
    .update(`${path.resolve(libraryRoot)}\0${String(key || '')}`)
    .digest('hex');
  return path.join(path.dirname(indexPath(libraryRoot)), `${hash}.md`);
}

/** 内部问答语料不需要图片二进制，去掉 Markdown/HTML 中的 data URI 以控制内存和文件体积。 */
function stripDataUris(markdown) {
  return String(markdown || '').replace(/data:image\/[^;]+;base64,[^\s)"']+/gi, '[内嵌图片]');
}

/** 同步读清单（体积很小，且匹配动作发生在用户拖入时，要求即时） */
function load(libraryRoot) {
  const file = indexPath(libraryRoot);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && Array.isArray(raw.works)) return raw;
  } catch {
    /* 首次运行或文件损坏 → 尝试读取旧版本输出目录内的清单，之后新记录只写内部索引 */
    try {
      const legacy = JSON.parse(fs.readFileSync(path.join(libraryRoot, INDEX_NAME), 'utf8'));
      if (legacy && Array.isArray(legacy.works)) return legacy;
    } catch {
      /* 空清单 */
    }
  }
  return { version: INDEX_VERSION, works: [] };
}

function save(libraryRoot, data) {
  data.version = INDEX_VERSION;
  data.updatedAt = new Date().toISOString();
  writeJsonAtomicSync(indexPath(libraryRoot), data);
}

/** 算出所有产物文件的指纹（用于登记与反查） */
function fingerprintFiles(files) {
  const out = [];
  for (const f of files) {
    try {
      const st = fs.statSync(f.path);
      const { key } = fingerprintSync(f.path);
      out.push({ name: f.name || path.basename(f.path), fingerprint: key, size: st.size });
    } catch {
      /* 已被删/不可读则跳过 */
    }
  }
  return out;
}

/**
 * 登记一篇译文。
 * @param {string} libraryRoot 翻译文档库根目录
 * @param {object} info { title, dirName, source:{path,name,fingerprint,size}, files:[{path,name}], model, targetLang }
 */
function registerWork(libraryRoot, info) {
  const data = load(libraryRoot);
  const sourceFp = info.source && info.source.path ? safeFingerprint(info.source.path) : null;

  const record = {
    id: `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: info.title || '',
    dir: info.dirName || '',
    source: {
      name: info.source ? info.source.name : '',
      fingerprint: sourceFp ? sourceFp.key : null,
      size: sourceFp ? sourceFp.size : null
    },
    outputs: fingerprintFiles(info.files || []),
    model: info.model || '',
    targetLang: info.targetLang || 'zh',
    at: Date.now()
  };

  const qaKeySource = info.dirName || info.title || record.id;
  if (typeof info.qaMarkdown === 'string' && info.qaMarkdown.trim()) {
    const qaFile = qaPath(libraryRoot, qaKeySource);
    const qaText = stripDataUris(info.qaMarkdown);
    writeTextAtomicSync(qaFile, qaText.slice(0, MAX_QA_CHARS));
    record.qaKey = path.basename(qaFile);
  }

  // 同一目录或同名作品重复登记时覆盖旧记录，避免清单里堆重复项
  const list = data.works.filter((w) => {
    if (record.dir && w.dir) return w.dir !== record.dir;
    return w.title !== record.title;
  });
  list.unshift(record);
  data.works = list.slice(0, MAX_WORKS);
  save(libraryRoot, data);
  return record;
}

function safeFingerprint(p) {
  try {
    return fingerprintSync(p);
  } catch {
    return null;
  }
}

/** 内容指纹与路径回退共用的匹配规则。 */
function findMatch(data, filePath, fp, libraryRoot) {
  const name = path.basename(filePath);
  const parent = path.basename(path.dirname(filePath));

  if (fp) {
    for (const w of data.works) {
      for (const o of w.outputs || []) {
        if (o.fingerprint === fp.key) {
          return { work: w, via: 'fingerprint', modified: false, file: o };
        }
      }
    }
  }

  // 二级：目录名 + 文件名（译文被改过、指纹已变，但还在原地）
  const fileDir = path.resolve(path.dirname(filePath));
  const resolvedRoot = libraryRoot ? path.resolve(libraryRoot) : null;
  for (const w of data.works) {
    if (w.dir) {
      if (w.dir !== parent) continue;
    } else if (resolvedRoot && fileDir !== resolvedRoot) {
      continue;
    }
    for (const o of w.outputs || []) {
      if (o.name === name) {
        return {
          work: w,
          via: 'path',
          modified: !!(fp && o.fingerprint && o.fingerprint !== fp.key),
          file: o
        };
      }
    }
  }
  return null;
}

/** 清单里的全部作品（新的在前） */
function list(libraryRoot) {
  return load(libraryRoot).works.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
}

/**
 * 反查：这个文件是不是译文库里的某篇产物？
 * @returns {{work: object, via: 'fingerprint'|'path', modified: boolean, file: object}|null}
 */
function match(libraryRoot, filePath) {
  if (!filePath) return null;
  const data = load(libraryRoot);
  if (!data.works.length) return null;
  return findMatch(data, filePath, safeFingerprint(filePath), libraryRoot);
}

/**
 * 拖入文件走异步指纹，避免同步读大型 PDF 或失联网络盘阻塞 Electron 主进程。
 */
async function matchAsync(libraryRoot, filePath) {
  if (!filePath) return null;
  const data = load(libraryRoot);
  if (!data.works.length) return null;
  let fp = null;
  try {
    fp = await fingerprint(filePath);
  } catch {
    /* 文件不能读取时仍允许走路径回退 */
  }
  return findMatch(data, filePath, fp, libraryRoot);
}

/** 该作品的产物目录绝对路径 */
function workDir(libraryRoot, work) {
  return work && work.dir ? path.join(libraryRoot, work.dir) : libraryRoot;
}

/** 读取某作品的内部问答语料；输出目录即使只有 PDF/Word 也可恢复问答。 */
function readQa(libraryRoot, work) {
  if (!work) return '';
  try {
    if (work.qaKey) {
      const file = path.join(path.dirname(indexPath(libraryRoot)), path.basename(work.qaKey));
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_QA_CHARS * 4) return '';
      return fs.readFileSync(file, 'utf8').slice(0, MAX_QA_CHARS);
    }
    // 兼容早期内部索引曾直接保存的短文本记录。
    return typeof work.qaMarkdown === 'string' ? stripDataUris(work.qaMarkdown).slice(0, MAX_QA_CHARS) : '';
  } catch {
    return '';
  }
}

module.exports = {
  INDEX_NAME,
  root,
  indexPath,
  qaPath,
  load,
  list,
  registerWork,
  match,
  matchAsync,
  workDir,
  readQa,
  stripDataUris,
  fingerprintSync
};
