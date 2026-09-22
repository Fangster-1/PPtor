'use strict';

/**
 * 成果快照存取（从 registry.js 拆出）：
 * 哈希寻址的 zlib 高压缩译文快照（${key}.bundle.gz），
 * 以及“快照被删但译文仍在 → 0 Token 补全”的自愈通道。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { dataFile, cacheDir } = require('../paths');
const {
  extractMarkdownFromHtml,
  extractMarkdownFromDocx,
  extractTextFromPdf
} = require('./extract');

const MAX_BUNDLES = 200;

function bundleDir() {
  const dir = path.join(cacheDir(), 'translations');
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  return dir;
}

function bundleFilePath(key) {
  return path.join(bundleDir(), `${key}.bundle.gz`);
}

/**
 * 实时检测哈希压缩快照文件是否存在、大小和时间戳
 */
function inspectBundleFile(key) {
  if (!key) return { exists: false, path: '', size: 0, mtime: 0 };
  const filePath = bundleFilePath(key);
  try {
    if (fs.existsSync(filePath)) {
      const st = fs.statSync(filePath);
      if (st.isFile() && st.size > 0) {
        return { exists: true, path: filePath, size: st.size, mtime: st.mtimeMs };
      }
    }
  } catch {
    /* ignore */
  }
  return { exists: false, path: filePath, size: 0, mtime: 0 };
}

function normalizeFormat(format) {
  const f = String(format || '').toLowerCase().trim();
  if (f === 'markdown') return 'md';
  if (f === 'word') return 'docx';
  return f;
}

async function saveBundle(key, bundle) {
  if (!key || !bundle) return false;
  try {
    const dir = bundleDir();
    const filePath = bundleFilePath(key);
    const tmpPath = path.join(dir, `.${key}.${process.pid}-${Date.now()}.tmp`);

    const payload = JSON.stringify({
      version: 1,
      key,
      title: bundle.title || '',
      baseName: bundle.baseName || '',
      sourceName: bundle.sourceName || '',
      outDir: bundle.outDir || '',
      embeddedMarkdown: bundle.embeddedMarkdown || '',
      translatedMarkdown: bundle.translatedMarkdown || '',
      formats: Array.isArray(bundle.formats) ? bundle.formats.map(normalizeFormat) : [],
      files: Array.isArray(bundle.files) ? bundle.files : [],
      model: bundle.model || '',
      targetLang: bundle.targetLang || 'zh',
      layout: bundle.layout || 'generic',
      at: Date.now()
    });

    const compressed = zlib.gzipSync(Buffer.from(payload, 'utf8'), { level: 9 });
    await fs.promises.writeFile(tmpPath, compressed);
    await fs.promises.rename(tmpPath, filePath);

    // 异步清理最旧快照
    cleanOldBundles().catch(() => {});
    return true;
  } catch (err) {
    console.warn('[bundles] 成果包压缩保存失败：', err.message);
    return false;
  }
}

async function getBundle(key, record) {
  if (!key) return null;

  // 1. 优先读取哈希压缩快照文件（毫秒级解压）
  const filePath = bundleFilePath(key);
  try {
    if (fs.existsSync(filePath)) {
      const compressed = await fs.promises.readFile(filePath);
      const raw = zlib.gunzipSync(compressed).toString('utf8');
      const data = JSON.parse(raw);
      if (data && data.embeddedMarkdown) {
        return data;
      }
    }
  } catch (err) {
    console.warn('[bundles] 读取成果压缩包失败：', err.message);
  }

  // 2. 降级容错：如果用户清理了缓存或该记录为旧版本产物，尝试直接从输出目录读取同名 .md
  if (record && record.outDir && (record.baseName || record.title)) {
    try {
      const base = record.baseName || record.title;
      const mdPath = path.join(record.outDir, `${base}.md`);
      if (fs.existsSync(mdPath)) {
        const mdText = await fs.promises.readFile(mdPath, 'utf8');
        if (mdText && mdText.trim()) {
          return {
            key,
            title: record.title || base,
            baseName: base,
            sourceName: record.file ? path.basename(record.file, path.extname(record.file)) : base,
            outDir: record.outDir,
            embeddedMarkdown: mdText,
            translatedMarkdown: mdText,
            formats: record.formats || ['md'],
            files: record.files || [{ path: mdPath, name: path.basename(mdPath), format: 'md' }],
            model: record.model || '',
            targetLang: record.targetLang || 'zh',
            layout: 'generic',
            at: record.at || Date.now()
          };
        }
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}

async function updateBundle(key, patch = {}) {
  if (!key) return false;
  const existing = await getBundle(key);
  if (!existing) return false;
  const next = { ...existing, ...patch, at: Date.now() };
  return saveBundle(key, next);
}

async function cleanOldBundles() {
  try {
    const dir = bundleDir();
    const files = await fs.promises.readdir(dir);
    const bundleFiles = files.filter((f) => f.endsWith('.bundle.gz'));
    if (bundleFiles.length <= MAX_BUNDLES) return;

    const stats = await Promise.all(
      bundleFiles.map(async (name) => {
        const p = path.join(dir, name);
        try {
          const st = await fs.promises.stat(p);
          return { name, path: p, mtime: st.mtimeMs };
        } catch {
          return null;
        }
      })
    );
    const valid = stats.filter(Boolean).sort((a, b) => a.mtime - b.mtime);
    const toRemove = valid.slice(0, valid.length - MAX_BUNDLES);
    for (const item of toRemove) {
      await fs.promises.unlink(item.path).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

/**
 * 0 Token 补全机制：当哈希压缩快照被删除但译文文档仍在时，
 * 依次从本地内部影子索引、.md、.html、.docx、.pdf 中提取翻译内容，
 * 重新生成并写入 ${key}.bundle.gz，0 Token 消耗！
 */
async function replenishBundle(key, record, inspectedOutputs) {
  if (!key || !record) return null;
  const existingFiles = inspectedOutputs?.existingFiles || [];
  if (!existingFiles.length) return null;

  try {
    let extractedText = '';
    const base = record.baseName || record.title || path.basename(record.file || '', path.extname(record.file || ''));

    // 0. 优先检查本地内部索引中的 qaMarkdown 影子备份（100% 原始译文，0 Token）
    //    影子文件路径公式与 library.qaPath 完全一致（此处按 record.outDir 作为库根，
    //    兼容旧版“根目录平铺产物”的记录）。
    if (record.outDir) {
      try {
        // 惰性 require：library → registry → bundles 存在模块环，运行期再加载安全。
        const library = require('./library');
        const keySource = record.dirName || record.title || record.baseName || base;
        const shadowPath = library.qaPath(record.outDir, keySource);
        if (fs.existsSync(shadowPath)) {
          const shadow = await fs.promises.readFile(shadowPath, 'utf8');
          if (shadow && shadow.trim()) {
            extractedText = shadow.trim();
          }
        }
      } catch {
        /* ignore */
      }
    }

    // 1. 优先读取同名或已存在的 .md 文件（保真度 100%，含 Base64 图片与完整公式）
    if (!extractedText) {
      const mdItem = existingFiles.find((f) => f.format === 'md' || (f.path && f.path.endsWith('.md')));
      if (mdItem && fs.existsSync(mdItem.path)) {
        extractedText = await fs.promises.readFile(mdItem.path, 'utf8');
      }
    }

    // 2. 次级读取同名或已存在的 .html 文件
    if (!extractedText) {
      const htmlItem = existingFiles.find((f) => f.format === 'html' || (f.path && f.path.endsWith('.html')));
      if (htmlItem && fs.existsSync(htmlItem.path)) {
        const rawHtml = await fs.promises.readFile(htmlItem.path, 'utf8');
        extractedText = extractMarkdownFromHtml(rawHtml);
      }
    }

    // 3. 读取 .docx 文件（纯本地提取段落、标题、表格与内嵌媒体图片，0 Token）
    if (!extractedText) {
      const docxItem = existingFiles.find((f) => f.format === 'docx' || (f.path && f.path.endsWith('.docx')));
      if (docxItem && fs.existsSync(docxItem.path)) {
        const docxBuf = await fs.promises.readFile(docxItem.path);
        extractedText = extractMarkdownFromDocx(docxBuf);
      }
    }

    // 4. 读取 .pdf 文件（纯本地解析文本流，0 Token）
    if (!extractedText) {
      const pdfItem = existingFiles.find((f) => f.format === 'pdf' || (f.path && f.path.endsWith('.pdf')));
      if (pdfItem && fs.existsSync(pdfItem.path)) {
        const pdfBuf = await fs.promises.readFile(pdfItem.path);
        extractedText = extractTextFromPdf(pdfBuf);
      }
    }

    if (!extractedText || !extractedText.trim()) return null;

    const bundleData = {
      title: record.title || base,
      baseName: base,
      sourceName: record.file ? path.basename(record.file, path.extname(record.file)) : base,
      outDir: record.outDir || path.dirname(existingFiles[0].path),
      embeddedMarkdown: extractedText,
      translatedMarkdown: extractedText,
      formats: inspectedOutputs.existingFormats || [],
      files: existingFiles,
      model: record.model || '',
      targetLang: record.targetLang || 'zh',
      layout: record.layout || 'generic',
      at: record.at || Date.now()
    };

    const saved = await saveBundle(key, bundleData);
    if (saved) {
      console.log(`[bundles] 已通过本地译文文档 0 Token 成功补全哈希压缩文件：${key}.bundle.gz`);
      return bundleData;
    }
  } catch (err) {
    console.warn('[bundles] 补全哈希压缩文件失败：', err.message);
  }
  return null;
}

module.exports = {
  bundleDir,
  bundleFilePath,
  inspectBundleFile,
  normalizeFormat,
  saveBundle,
  getBundle,
  updateBundle,
  cleanOldBundles,
  replenishBundle
};
