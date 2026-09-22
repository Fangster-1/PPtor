'use strict';

/**
 * 产物导出
 *
 * 输出矩阵（三项均可配置，默认：通用排版 / 只保留译文 / pdf）：
 *   排版 layout    faithful = 严格按原始论文排版（保留 MinerU 解析的原结构顺序）
 *                  generic  = 通用排版（规整的标准文档流）
 *   内容 content   mono     = 只保留译文
 *                  bilingual= 双语对照（原文在上、译文在下）
 *   格式 formats   md / html / pdf / docx
 *
 * 每份产物都是自包含文件：图片会以内联 data URI 写入 Markdown/HTML，
 * Word 则把图片作为 OOXML 关系嵌入 docx。导出目录不再生成 images/meta/mono
 * 等辅助文件，避免用户拿到一堆无法单独使用的副产物。
 * PDF 的生成在主进程的 pet/pdf-print.js（需要 BrowserWindow.printToPDF），
 * 这里只负责产出 md / html 文本与文件落盘。
 */
const fs = require('node:fs');
const path = require('node:path');

const { reassemble, buildBilingual } = require('./chunker');
const { renderMarkdown, buildHtmlDocument, normalizeMarkdownTables, bondFiguresAndCaptions, isolateBlockElements, applyCjkSpacing, convertHtmlTablesToMarkdown } = require('./markdown');
const { inlineMarkdownImages } = require('./assets');

async function writeAtomic(filePath, data, encoding) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data, encoding);
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      /* 临时文件清理失败不覆盖原始错误 */
    }
    throw err;
  }
}

/** @deprecated 保留旧导出符号以兼容外部调用；正式导出始终完整保留参考文献，不再剥离。 */
function stripReferences(md) {
  return String(md);
}

/**
 * 从已内嵌图片的 Markdown 直接导出指定格式（MD / HTML / DOCX / PDF 准备）
 * 0 Token 消耗，不调用 MinerU 与大模型。
 *
 * @param {object} p
 * @param {string} p.outDir
 * @param {string} p.baseName
 * @param {string} p.embeddedMarkdown
 * @param {Set<string>|Array<string>} [p.formats]
 * @param {string} [p.layout]
 * @param {boolean} [p.renderMath]
 * @param {object} [p.pendingPdf]
 * @returns {Promise<{files: Array<{label: string, path: string, format: string, pending?: boolean}>, outDir: string}>}
 */
async function exportFromMarkdown({
  outDir,
  baseName,
  embeddedMarkdown,
  formats: rawFormats = ['pdf'],
  layout = 'generic',
  renderMath = true,
  pendingPdf = {}
}) {
  await fs.promises.mkdir(outDir, { recursive: true });

  // 统一预处理链（generic 与 faithful 均执行，保证四类块隔离）：
  // 内嵌图 → 隔离块（公式/表格/图片/正文各自成段）→ 表格规范 → 图注绑定 → 中英混排
  const withMissing = String(embeddedMarkdown || '');
  const missingImages = (embeddedMarkdown && embeddedMarkdown.missing) || [];
  if (missingImages.length) {
    console.warn(`[exporter] 缺图 ${missingImages.length} 张，已用占位图代替：${missingImages.slice(0, 5).join('；')}${missingImages.length > 5 ? '…' : ''}`);
  }
  const isolated = isolateBlockElements(withMissing);
  const normalizedMarkdown = applyCjkSpacing(bondFiguresAndCaptions(normalizeMarkdownTables(isolated)));

  const supportedFormats = new Set(['md', 'html', 'pdf', 'docx']);
  const formatsIterable = Array.isArray(rawFormats)
    ? rawFormats
    : rawFormats instanceof Set
      ? [...rawFormats]
      : [rawFormats];

  const formats = new Set(
    formatsIterable
      .map((f) => {
        const value = String(f || '').toLowerCase().trim();
        return value === 'markdown' ? 'md' : value === 'word' ? 'docx' : value;
      })
      .filter((value) => supportedFormats.has(value))
  );
  if (!formats.size) formats.add('pdf');

  const files = [];

  /* ---------- .md ---------- */
  if (formats.has('md')) {
    const filePath = path.join(outDir, `${baseName}.md`);
    const mdHint =
      `<!-- PPtor 译文 · ${baseName} -->\n` +
      `<!-- 图片为 data URI 内嵌：单文件体积较大属正常；若阅读器不显示图片请用同目录 HTML/PDF 查看。 -->\n` +
      (missingImages.length ? `<!-- 注意：缺图 ${missingImages.length} 张已用占位图代替。 -->\n` : '') +
      `\n`;
    const mdContent = convertHtmlTablesToMarkdown(normalizedMarkdown);
    await writeAtomic(filePath, mdHint + mdContent, 'utf8');
    files.push({ label: 'Markdown 译文', path: filePath, format: 'md' });
  }

  /* ---------- .html ---------- */
  let htmlText = null;
  if (formats.has('html') || formats.has('pdf')) {
    htmlText = buildHtmlDocument({
      title: baseName,
      bodyHtml: renderMarkdown(normalizedMarkdown, { renderMath: renderMath !== false }),
      renderMath: renderMath !== false,
      layout
    });
  }

  if (formats.has('html')) {
    const filePath = path.join(outDir, `${baseName}.html`);
    await writeAtomic(filePath, htmlText, 'utf8');
    files.push({ label: 'HTML 译文', path: filePath, format: 'html' });
  }

  /* ---------- .docx（真正可编辑的 Word 文档，图片嵌入 OOXML） ---------- */
  if (formats.has('docx')) {
    let markdownToDocx;
    try {
      ({ markdownToDocx } = require('./docx'));
    } catch (err) {
      throw new Error(`Word 导出需要 docx 依赖：${err.message}`);
    }
    const buffer = await markdownToDocx(normalizedMarkdown, { title: baseName });
    const filePath = path.join(outDir, `${baseName}.docx`);
    await writeAtomic(filePath, buffer);
    files.push({ label: 'Word 译文', path: filePath, format: 'docx' });
  }

  /* ---------- .pdf（由外层打印，这里交出 HTML） ---------- */
  if (formats.has('pdf')) {
    const pdfPath = path.join(outDir, `${baseName}.pdf`);
    pendingPdf.html = htmlText;
    pendingPdf.path = pdfPath;
    pendingPdf.needsMath = renderMath !== false;
    files.push({ label: 'PDF 译文', path: pdfPath, format: 'pdf', pending: true });
  }

  return { files, outDir };
}

/**
 * @param {object} p
 * @param {string} p.outDir
 * @param {string} p.baseName
 * @param {Array}  p.segments       chunker 产物
 * @param {Map}    p.translations   id → 译文
 * @param {Array}  p.images
 * @param {object} p.meta
 * @param {object} p.outputConfig   { layout, content, formats, renderMath }
 * @param {object} p.pendingPdf     {md?:string, bilingual?:string, html?:string} 由本函数回填，外层拿去打印
 * @returns {Promise<{files:object[], outDir:string, translatedMarkdown:string, embeddedMarkdown:string}>}
 */
async function exportResults({
  outDir,
  baseName,
  segments,
  translations,
  images = [],
  meta = {},
  outputConfig = {},
  pendingPdf = {}
}) {
  const layout = outputConfig.layout || 'generic'; // faithful | generic
  // 导出边界强制只保留译文，避免旧配置/外部脚本意外生成双语和 .mono 副本。
  const isBilingual = outputConfig && outputConfig.content === 'bilingual';

  /* ---------- 组装 Markdown ---------- */
  const translatedMarkdown = segments && translations ? reassemble(segments, translations) : '';
  const mainMarkdown = isBilingual && segments && translations ? buildBilingual(segments, translations) : translatedMarkdown;
  const displayMarkdown = mainMarkdown;
  const embeddedMarkdown = inlineMarkdownImages(displayMarkdown, images, {
    allowExternalImages: outputConfig.allowExternalImages === true
  });

  const { files } = await exportFromMarkdown({
    outDir,
    baseName,
    embeddedMarkdown,
    formats: outputConfig.formats,
    layout,
    renderMath: outputConfig.renderMath !== false,
    pendingPdf
  });

  return { files, outDir, translatedMarkdown, embeddedMarkdown };
}

module.exports = { exportResults, exportFromMarkdown, stripReferences };
