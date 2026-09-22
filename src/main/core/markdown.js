'use strict';

let katex = null;
let katexCss = '';
let katexLoaded = false;
let katexError = null;

/** KaTeX 资源只在第一次真正渲染公式时加载，避免拖慢桌宠冷启动。 */
function loadKatex() {
  if (katexLoaded) return katex;
  katexLoaded = true;
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    katex = require('katex');
    const cssPath = require.resolve('katex/dist/katex.min.css');
    const fontsDir = path.join(path.dirname(cssPath), 'fonts');
    katexCss = fs
      .readFileSync(cssPath, 'utf8')
      // HTML/PDF 必须离线可用；只保留 woff2，并把字体本身写入 CSS。
      .replace(/,url\(fonts\/[^)]+\.(?:woff|ttf)\) format\("[^"]+"\)/g, '')
      .replace(/url\(fonts\/([^.)]+\.woff2)\)/g, (_m, name) => {
        const fontPath = path.join(fontsDir, name);
        if (!fs.existsSync(fontPath)) throw new Error(`KaTeX 字体缺失：${name}`);
        const font = fs.readFileSync(fontPath);
        return `url(data:font/woff2;base64,${font.toString('base64')})`;
      });
  } catch (err) {
    // 生产包会把 katex 与 fonts 一起打包；缺失时保留可读源码并让 buildHtml
    // 在需要公式 CSS 时给出清晰错误，而不是写入空字体 URL。
    katex = null;
    katexCss = '';
    katexError = err;
  }
  return katex;
}

/**
 * Markdown 转 HTML 渲染器
 * 支持标题、段落、列表、引用、代码块、表格、公式及行内标记
 */

const DOC_CSS = `
:root { --ink:#000000; --muted:#000000; --line:#000000; --bg:#ffffff; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 48px 24px 96px; background: #ffffff; color: var(--ink);
  font-family: "Times New Roman", SimSun, "宋体", "Songti SC", serif;
  font-size: 16px; line-height: 1.85;
}
.paper {
  max-width: 820px; margin: 0 auto; background: var(--bg); padding: 56px 64px;
  border-radius: 0; box-shadow: none; border: none;
}
h1,h2,h3,h4,h5,h6 { line-height: 1.35; margin: 1.6em 0 .6em; font-weight: bold; color: #000000; }
h1 { font-size: 1.9em; border-bottom: 1px solid #000000; padding-bottom: .3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #000000; padding-bottom: .25em; }
h3 { font-size: 1.22em; }
h4 { font-size: 1.08em; }
p { margin: .85em 0; text-indent: 2em; line-height: 1.85; color: #000000; orphans: 3; widows: 3; }
blockquote p { text-indent: 0; }
li, li p { text-indent: 0 !important; }
.caption, h3.caption, h4.caption { text-align: center; text-indent: 0 !important; font-weight: bold; color: #000000; margin: .6em auto 1.2em; display: block; break-inside: avoid; }
.img-container { text-align: center; text-indent: 0 !important; margin: 1.2em auto .4em; break-inside: avoid; }
.img-container img { display: inline-block; margin: 0 auto; }
.refs p, p.ref-item { text-indent: 0 !important; padding-left: 2em; text-indent: -2em; font-size: .93em; margin: .4em 0; }
.refs { margin-top: 1em; }
.img-broken { color: #000; background: #fff; border: 1px dashed #000; padding: .1em .4em; font-size: .9em; }
sup, sub { font-size: 75%; line-height: 0; position: relative; vertical-align: baseline; }
sup { top: -0.5em; }
sub { bottom: -0.25em; }
a { color: #000000; text-decoration: underline; }
a:hover { text-decoration: underline; }
code {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: .88em; background: #ffffff; color: #000000; padding: .15em .38em; border: 1px solid #000000; border-radius: 2px;
}
pre {
  background: #ffffff; border: 1px solid #000000; border-radius: 4px;
  padding: 14px 16px; overflow-x: auto; line-height: 1.6; color: #000000;
}
pre code { background: none; padding: 0; font-size: .86em; border: none; }
blockquote {
  margin: .9em 0; padding: .1em 1em; color: #000000;
  border-left: 3px solid #000000; background: #ffffff;
}
.table-container { width: 100%; overflow-x: auto; margin: 1.2em auto; text-align: center; }
table { border-collapse: collapse; margin: 1.2em auto; max-width: 100%; font-size: .95em; text-align: left; border: 1px solid #000000; }
th, td { border: 1px solid #000000; padding: 8px 12px; vertical-align: top; word-break: break-word; color: #000000; }
th { background: #ffffff; font-weight: bold; text-align: center; }
img { max-width: 100%; height: auto; display: block; margin: 1.2em auto; }
hr { border: none; border-top: 1px solid #000000; margin: 2em 0; }
ul, ol { padding-left: 1.6em; margin: .8em 0; color: #000000; }
li { margin: .3em 0; }
.math-block { display: block; text-align: center; margin: 1.1em 0; overflow-x: auto; }
.math-inline, .math-block { font-family: "Cambria Math", "STIX Two Math", "Times New Roman", serif; }
.math-inline { white-space: nowrap; }
.math-block { white-space: pre-wrap; }
@media print {
  body { background: #fff; padding: 0; font-size: 12pt; color: #000; }
  .paper { box-shadow: none; border-radius: 0; max-width: none; padding: 0; }
  h1, h2, h3, h4, h5, h6 { page-break-after: avoid; break-after: avoid; }
  pre, img, blockquote, .caption, .img-container, .math-block, li { page-break-inside: avoid; break-inside: avoid; }
  .table-container { overflow-x: visible; }
  table { page-break-inside: auto; margin: 1em auto; }
  tr { page-break-inside: avoid; page-break-after: auto; }
  thead { display: table-header-group; }
  @page { size: A4; margin: 18mm 16mm; }
}
`;

function renderMath(tex, display, enabled = true) {
  const source = String(tex || '').trim();
  if (!enabled || !source) return `<span class="math-source">${escapeHtml(source)}</span>`;
  const renderer = loadKatex();
  if (renderer) {
    try {
      return renderer.renderToString(source, {
        displayMode: !!display,
        throwOnError: false,
        output: 'htmlAndMathml'
      });
    } catch {
      /* 公式语法损坏时仍保留原始内容，不能让整篇导出失败 */
    }
  }
  return `<span class="math-source">${escapeHtml(source)}</span>`;
}

/* ================================================================== *
 * 行内渲染
 * ================================================================== */

function escapeHtml(s) {
  return String(s)
    // 剥离 C0 控制字符（保留 \t=\u0009、\n=\u000a、\r=\u000d）：
    // 既能挡住原文里混入的乱码控制符，也避免与 renderInline 的 \u0000 占位符冲突
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(text, options = {}) {
  const stash = [];
  const hold = (html) => {
    stash.push(html);
    // 使用私有区字符作为占位符；escapeHtml 会有意剥离 C0 控制字符。
    return `\uE000${stash.length - 1}\uE001`;
  };

  // 内嵌图片可能来自 MinerU 混合 HTML/Markdown 输出；保留已经由
  // assets.inlineMarkdownImages 校验过的 data URI 图片标签。
  let source = String(text || '').replace(/<img\b[^>]*\bsrc\s*=\s*(["'])data:[^"']+\1[^>]*>/gi, (tag) => hold(tag));

  // 保留 HTML 上标和下标标签（常用于论文作者机构标记、单位、化学式等）
  source = source.replace(/<(sup|sub)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, tag, inner) => {
    const cleanInner = escapeHtml(inner.replace(/\\([*_,^~[\]])/g, '$1'));
    return hold(`<${tag.toLowerCase()}>${cleanInner}</${tag.toLowerCase()}>`);
  });

  // 预先暂存转义字符（如 \*、\_、\^、\~、\[、\]），避免被后续强调规则破坏且还原多余的反斜杠
  source = source.replace(/\\([*_,^~[\]])/g, (_, ch) => hold(escapeHtml(ch)));

  let s = escapeHtml(source);

  // 行内代码优先，避免内部符号被后续规则破坏
  s = s.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${code}</code>`));

  // 数学公式（先块级再行内，行内支持跨行换行但不跨段落）
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => hold(renderMath(tex, true, options.renderMath !== false)));
  s = s.replace(/\$([^$\r\n]+(?:\r?\n[^\$\r\n]+)*?)\$/g, (_, tex) => hold(renderMath(tex, false, options.renderMath !== false)));

  // 图片 / 链接（白名单校验：危险 scheme 降级为纯文本，避免 XSS/非预期跳转）
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, src) => {
    if (!isSafeImgSrc(src)) return hold(`<span class="img-broken">[图片：${escapeHtml(alt || src)}]</span>`);
    return hold(`<img src="${src}" alt="${alt}" loading="lazy">`);
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, label, href) => {
    if (!isSafeHref(href)) return hold(`${label}`);
    return hold(`<a href="${href}" target="_blank" rel="noopener">${label}</a>`);
  });

  // 强调
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\^([^^]+)\^/g, '<sup>$1</sup>');

  return s.replace(/\uE000(\d+)\uE001/g, (_, i) => stash[Number(i)]);
}

/* ================================================================== *
 * 块级渲染
 * ================================================================== */

function isBlockStarter(t) {
  if (!t) return true;
  if (/^(```|~~~)/.test(t)) return true;
  if (/^\$\$/.test(t)) return true;
  if (/^#{1,6}\s/.test(t)) return true;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return true;
  if (t.startsWith('|')) return true;
  if (t.startsWith('>')) return true;
  if (/^([-*+]|\d+\.)\s+/.test(t)) return true;
  return false;
}

function splitRow(row) {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function isSafeHref(href) {
  const h = String(href || '').trim();
  if (!h) return false;
  if (/^(?:https?:|mailto:|#)/i.test(h)) return true;
  if (/^data:image\//i.test(h)) return true;
  // 相对路径（无 scheme）放行；含冒号的其它 scheme（如 javascript:/data:text）一律拦截
  if (!/:/.test(h)) return true;
  return false;
}

function isSafeImgSrc(src) {
  const s = String(src || '').trim();
  if (!s) return false;
  if (/^data:/i.test(s)) return true;
  // 译文导出不应在打开或打印时联网；外部图必须先由 assets 层内嵌，
  // 历史快照里残留的 http(s) 链接在此处也会降级为缺图提示。
  if (/^https?:/i.test(s)) return false;
  // 相对路径仅兼容导出前的中间 Markdown；最终产物应已转为 data URI。
  if (!/:/.test(s)) return true;
  return false;
}

function isReferencesSectionTitle(value) {
  const heading = String(value || '')
    .trim()
    .replace(/^#{0,6}\s*/, '')
    .replace(/^\d+[.\s]*/, '')
    .trim();
  return /^(?:references|bibliography|literature cited)(?:\b[\s\d.\-–—]*)?$/i.test(heading) ||
    /^(?:参考文献|引用文献)[\s\d.\-–—]*$/.test(heading);
}

function isAppendixSectionTitle(value) {
  const heading = String(value || '').trim().replace(/^#{0,6}\s*/, '').replace(/^\d+[.\s]*/, '').trim();
  return /^(?:appendix|appendices|supplementary)(?:\b|[\s\d.\-–—])/i.test(heading) ||
    /^(?:附录|补充材料)(?:$|[\s（(A-Za-z0-9一二三四五六七八九十])/i.test(heading);
}

function sanitizeTableHtml(html) {
  let out = String(html || '')
    .replace(/<\/?(?:script|style|iframe|object|embed|link|meta)[^>]*>[\s\S]*?<\/?(?:script|style|iframe|object|embed)>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // href/src 白名单：放行 http/https/mailto/#/data:image，仅剥离 javascript:/data:text 等危险 scheme
  out = out.replace(/\s+(href)\s*=\s*(["'])([\s\S]*?)\2/gi, (m, attr, q, val) => {
    return isSafeHref(val) ? m : '';
  });
  out = out.replace(/\s+(src)\s*=\s*(["'])([\s\S]*?)\2/gi, (m, attr, q, val) => {
    if (/^data:/i.test(val) || /^https?:/i.test(val)) return m;
    return '';
  });
  out = out.replace(/<table\b([^>]*)>/gi, '<table$1>');
  return out;
}

function renderTableHtml(html, options = {}) {
  const sanitized = sanitizeTableHtml(html);
  // 对表格内每一个 <td> / <th> 单元格内容执行 renderInline，确保公式（如 SPLIT、R^2）与标记能被 KaTeX 渲染
  return sanitized.replace(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi, (_match, tag, attrs, inner) => {
    const trimmed = inner.trim();
    if (!trimmed) return `<${tag}${attrs}></${tag}>`;
    return `<${tag}${attrs}>${renderInline(trimmed, options)}</${tag}>`;
  });
}

/**
 * 将 HTML 表格转换为标准 GitHub Flavored Markdown (GFM) 管道表格
 * 支持 rowspan 与 colspan，解决 Markdown 查看器无法原生渲染 <table> 标签的问题
 */
function htmlTableToMarkdown(html) {
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  const rawRows = [];
  let rowMatch;
  while ((rowMatch = rowRe.exec(String(html || '')))) {
    const cells = [];
    const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      const attrs = cellMatch[2] || '';
      const span = (name) => {
        const m = attrs.match(new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, 'i'));
        return m ? Math.max(1, parseInt(m[1], 10)) : 1;
      };
      let text = cellMatch[3]
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<(?:sup|sub)\b[^>]*>([\s\S]*?)<\/(?:sup|sub)>/gi, '^$1^')
        .replace(/<[^>]+>/g, '')
        .replace(/[\r\n]+/g, ' ')
        .trim();
      text = text.replace(/(?<!\\)\|/g, '\\|');
      cells.push({
        text,
        rowSpan: span('rowspan'),
        colSpan: span('colspan')
      });
    }
    if (cells.length) rawRows.push(cells);
  }
  if (!rawRows.length) return html;

  const grid = [];
  for (let r = 0; r < rawRows.length; r++) {
    if (!grid[r]) grid[r] = [];
    let colIdx = 0;
    for (const cell of rawRows[r]) {
      while (grid[r][colIdx] !== undefined) colIdx++;
      for (let rs = 0; rs < cell.rowSpan; rs++) {
        for (let cs = 0; cs < cell.colSpan; cs++) {
          const targetR = r + rs;
          const targetC = colIdx + cs;
          if (!grid[targetR]) grid[targetR] = [];
          grid[targetR][targetC] = cell.text;
        }
      }
      colIdx += cell.colSpan;
    }
  }

  if (!grid.length || !grid[0].length) return html;
  const numCols = Math.max(...grid.map((row) => row.length));
  for (const row of grid) {
    while (row.length < numCols) row.push('');
  }

  const lines = [];
  lines.push('| ' + grid[0].map((c) => c || '-').join(' | ') + ' |');
  lines.push('| ' + new Array(numCols).fill('---').join(' | ') + ' |');
  for (let r = 1; r < grid.length; r++) {
    lines.push('| ' + grid[r].map((c) => c || '').join(' | ') + ' |');
  }
  return lines.join('\n');
}

function convertHtmlTablesToMarkdown(markdown) {
  if (!markdown || !/<table\b/i.test(markdown)) return markdown;
  return markdown.replace(/<table\b[\s\S]*?<\/table\s*>/gi, (tbl) => {
    try {
      return '\n\n' + htmlTableToMarkdown(tbl) + '\n\n';
    } catch {
      return tbl;
    }
  });
}

const CAPTION_RE = /^\s*(?:[*_~`#\s]*|[(\[（【]\s*)?(?:附录?|补充)?(?:图|表|表格|Figure|Fig\.|Table|Tab\.)\s*(?:[SsAaBbCcDdEeFf]\s*[-.]?\s*)?[\d一二三四五六七八九十IVXLCDMivxlcdm]+(?:[-.][\d一二三四五六七八九十IVXLCDMivxlcdm]+)*(?:\([a-zA-Z\d]+\)|（[a-zA-Z\d]+）)?(?:\s*[:：.)）\]】]|\s*(?:\*\*|__|\*|_)|[\s\u3000]|$)/i;

const FIG_CAPTION_RE = /^\s*(?:[*_~`#\s]*|[(\[（【]\s*)?(?:附录?|补充)?(?:图|Figure|Fig\.)\s*(?:[SsAaBbCcDdEeFf]\s*[-.]?\s*)?[\d一二三四五六七八九十IVXLCDMivxlcdm]+/i;
const TAB_CAPTION_RE = /^\s*(?:[*_~`#\s]*|[(\[（【]\s*)?(?:附录?|补充)?(?:表|表格|Table|Tab\.)\s*(?:[SsAaBbCcDdEeFf]\s*[-.]?\s*)?[\d一二三四五六七八九十IVXLCDMivxlcdm]+/i;

function isCaptionText(text) {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 350) return false;
  return CAPTION_RE.test(clean);
}

function isFigureCaption(text) {
  const clean = String(text || '').trim();
  return isCaptionText(clean) && FIG_CAPTION_RE.test(clean);
}

function isTableCaption(text) {
  const clean = String(text || '').trim();
  return isCaptionText(clean) && TAB_CAPTION_RE.test(clean);
}

function isImageBlock(text) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  return /^(!\[[^\]]*\]\([^\)]+\)|<img\b[^>]*>|<p\s+class="img-container">[\s\S]*?<\/p>)$/i.test(clean) ||
    (/^(!\[[^\]]*\]\([^\)]+\)\s*)+$/.test(clean));
}

function isTableBlock(text) {
  const clean = String(text || '').trim();
  return clean.startsWith('|') || /^<table\b/i.test(clean);
}

function isHeadingBlock(text) {
  const clean = String(text || '').trim();
  return /^#{1,6}\s/.test(clean);
}

function boldCaptionText(caption) {
  const clean = String(caption || '').trim();
  if (!clean) return caption;
  if (clean.startsWith('**') && clean.endsWith('**')) return clean;
  return `**${clean.replace(/^\*\*+|\*\*+$/g, '')}**`;
}

/**
 * 中英文混排规范化（仅普通文本）：
 * 中文与半角英文/数字/符号之间补空格，全半角标点统一为中文标点。
 * 跳过 code/math/table/URL/图片占位符，避免破坏 Formel 与链接。
 */
function applyCjkSpacing(markdown) {
  if (!markdown) return '';
  const lines = String(markdown).split(/\r?\n/);
  let inFence = false;
  let fenceMarker = '';
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!inFence && /^(```|~~~)/.test(t)) {
      inFence = true;
      fenceMarker = t.slice(0, 3);
      out.push(line);
      continue;
    }
    if (inFence) {
      if (t.startsWith(fenceMarker)) inFence = false;
      out.push(line);
      continue;
    }
    if (!t || t.startsWith('|') || t.startsWith('$$') || /<table\b/i.test(t) || /^#{1,6}\s/.test(t) || /^(!\[|<img)/.test(t) || /^\[\[PPTOR_IMAGE_/.test(t)) {
      out.push(line);
      continue;
    }
    let s = line;
    // 保护 URL / DOI / 占位符 / 行内公式 / 行内代码
    const stash = [];
    s = s.replace(/(https?:\/\/[^\s)>\]]+|\[\[PPTOR_IMAGE_\d+\]\]|\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|`[^`]+`)/g, (m) => {
      stash.push(m);
      return `\uE002${stash.length - 1}\uE003`;
    });
    // 中文 ⟷ 半角字母/数字之间补空格（已存在空格则不重复）
    s = s.replace(/([\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff])([A-Za-z0-9])/g, '$1 $2');
    s = s.replace(/([A-Za-z0-9])([\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff])/g, '$1 $2');
    // 中文括号/引号与英文之间不补空格，保持紧凑（回退上一步的过度空格）
    s = s.replace(/([\u4e00-\u9fff])\s+([（【「『])/g, '$1$2');
    s = s.replace(/([）】」』])\s+([\u4e00-\u9fff])/g, '$1$2');
    // 半角逗号/分号/冒号/问号/感叹号在中文语境下统一为全角（数字千分位与小数点除外）
    s = s.replace(/([\u4e00-\u9fff])\s*,\s*/g, '$1，');
    s = s.replace(/([\u4e00-\u9fff])\s*;\s*/g, '$1；');
    s = s.replace(/([\u4e00-\u9fff])\s*:\s*/g, '$1：');
    s = s.replace(/\s+/g, (m) => (m.length > 2 ? m : m)); // 保留原有空格节奏，不压缩
    s = s.replace(/\uE002(\d+)\uE003/g, (_, i) => stash[Number(i)]);
    out.push(s);
  }
  return out.join('\n');
}

/**
 * 段落隔离（核心排版约束，generic 与 faithful 均强制执行）：
 * 公式块 / 表格 / 图片 / 正文四类块级元素各自独立成段，互不嵌套。
 * - $$ 块独占段落，前后补空行
 * - <table> 独占段落，前后补空行
 * - 图片行（![] / <img>）若与正文混排则拆段
 * - 标题行若粘连正文则拆段
 */
function isolateBlockElements(markdown) {
  if (!markdown) return '';
  const lines = String(markdown).split(/\r?\n/);
  const out = [];
  let inFence = false;
  let fenceMarker = '';
  let inMath = false;
  let inHtmlTable = false;

  const flushBlank = () => {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (!inFence && /^(```|~~~)/.test(t)) {
      inFence = true;
      fenceMarker = t.slice(0, 3);
      flushBlank();
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      if (t.startsWith(fenceMarker)) {
        inFence = false;
        out.push('');
      }
      continue;
    }

    // $$ 块：开始/结束均隔离
    if (!inHtmlTable && t.startsWith('$$')) {
      const singleLine = t.length > 4 && t.endsWith('$$');
      flushBlank();
      out.push(line);
      if (singleLine) {
        out.push('');
      } else if (!inMath) {
        inMath = true;
      } else {
        inMath = false;
        out.push('');
      }
      continue;
    }
    if (inMath) {
      out.push(line);
      if (t.endsWith('$$')) {
        inMath = false;
        out.push('');
      }
      continue;
    }

    // HTML 表格隔离
    if (!inHtmlTable && /<table\b/i.test(t)) {
      flushBlank();
      inHtmlTable = !/<\/table\s*>/i.test(t);
      out.push(line);
      if (!inHtmlTable) out.push('');
      continue;
    }
    if (inHtmlTable) {
      out.push(line);
      if (/<\/table\s*>/i.test(t)) {
        inHtmlTable = false;
        out.push('');
      }
      continue;
    }

    // 图片与正文混排 → 拆段：行内同时含图片语法与其它文字时，图片独立成行
    const hasMdImage = /!\[[^\]]*\]\([^)]*\)/.test(t);
    const hasHtmlImage = /<img\b/i.test(t);
    if ((hasMdImage || hasHtmlImage) && t.length > 0) {
      // 去掉图片语法后仍有实质文字 → 需要拆
      const textWithoutImages = t
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/<img\b[^>]*>/gi, '')
        .replace(/[*_~`#>\s|]/g, '')
        .trim();
      if (textWithoutImages.length > 0 && (hasMdImage || hasHtmlImage)) {
        // 尝试按图片边界拆成多行：图片行独立
        const parts = t.split(/(!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>)/gi).map((s) => s.trim()).filter(Boolean);
        flushBlank();
        for (const p of parts) {
          out.push(p);
          out.push('');
        }
        continue;
      }
      // 纯图片行：前后隔离
      if (!textWithoutImages.length) {
        flushBlank();
        out.push(line);
        out.push('');
        continue;
      }
    }

    // Markdown 表格行由 normalizeMarkdownTables 统一处理，这里只保证标题独立
    if (/^#{1,6}\s/.test(t)) {
      flushBlank();
      out.push(line);
      out.push('');
      continue;
    }

    out.push(line);
  }

  // 压缩 3+ 空行为 2 个换行（一段空行），保留段落节奏
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * 绑定图片与图名（保守版）：
 * 仅当中间块为空/短过渡句（<40 字或纯连接词）才重排为“图上、注下”；
 * 否则保持原文顺序 + keepTogether，避免改变阅读顺序与多图配错。
 * 表注同图注处理（绑定不断页）。
 */
function isTransitionalText(text) {
  const clean = String(text || '').trim();
  if (!clean) return true;
  if (clean.length < 40) return true;
  if (/^(如图所示|如下|如下所示|见图|见表|如表|其中|注[:：])/.test(clean)) return true;
  return false;
}

function bondFiguresAndCaptions(markdown) {
  if (!markdown) return '';
  const rawBlocks = String(markdown).split(/\n\s*\n+/);
  const blocks = rawBlocks.map((b) => b.trim()).filter(Boolean);
  const result = [];
  let i = 0;

  while (i < blocks.length) {
    const b = blocks[i];

    // 情况 1：当前块是图片，后方找图名
    if (isImageBlock(b)) {
      let captionIdx = -1;
      for (let j = i + 1; j < Math.min(blocks.length, i + 4); j++) {
        if (isFigureCaption(blocks[j])) {
          captionIdx = j;
          break;
        }
        if (isImageBlock(blocks[j]) || isTableBlock(blocks[j]) || isHeadingBlock(blocks[j])) {
          break;
        }
      }

      if (captionIdx !== -1) {
        const middle = blocks.slice(i + 1, captionIdx);
        const canReorder = middle.every(isTransitionalText);
        const captionBlock = boldCaptionText(blocks[captionIdx]);
        if (canReorder) {
          // 短过渡才重排：图上、注下，过渡句顺延到注后
          result.push(b);
          result.push(captionBlock);
          for (const m of middle) result.push(m);
        } else {
          // 长正文保持原序，不静默挪动阅读顺序
          result.push(b);
          for (const m of middle) result.push(m);
          result.push(captionBlock);
        }
        i = captionIdx + 1;
        continue;
      }

      result.push(b);
      i++;
      continue;
    }

    // 情况 2：当前块是图名，后方找图片
    if (isFigureCaption(b)) {
      let imageIdx = -1;
      for (let j = i + 1; j < Math.min(blocks.length, i + 4); j++) {
        if (isImageBlock(blocks[j])) {
          imageIdx = j;
          break;
        }
        if (isTableBlock(blocks[j]) || isHeadingBlock(blocks[j]) || isFigureCaption(blocks[j])) {
          break;
        }
      }

      if (imageIdx !== -1) {
        const middle = blocks.slice(i + 1, imageIdx);
        const canReorder = middle.every(isTransitionalText);
        const captionBlock = boldCaptionText(b);
        if (canReorder) {
          result.push(blocks[imageIdx]);
          result.push(captionBlock);
          for (const m of middle) result.push(m);
        } else {
          result.push(captionBlock);
          for (const m of middle) result.push(m);
          result.push(blocks[imageIdx]);
        }
        i = imageIdx + 1;
        continue;
      }

      result.push(boldCaptionText(b));
      i++;
      continue;
    }

    // 情况 3：表名加粗（表注与表格绑定不断页，由渲染层 keepTogether 保证）
    if (isTableCaption(b)) {
      result.push(boldCaptionText(b));
      i++;
      continue;
    }

    result.push(b);
    i++;
  }

  return result.join('\n\n');
}

/**
 * 规范化 Markdown 文档中的表格格式：
 * 保证所有 Markdown 表格块及 HTML <table> 块与前后段落之间均具有标准空行，
 * 消除多余的 4 空格缩进（防止被误识别为代码块），使导出的 .md 在任何查看器中均能正确渲染表格。
 */
function normalizeMarkdownTables(markdown) {
  if (!markdown) return '';
  const lines = String(markdown).split(/\r?\n/);
  const result = [];
  let inTable = false;
  let inHtmlTable = false;
  let inFence = false;
  let fenceMarker = '';

  const isTableRow = (str) => {
    const s = str.trim();
    return s.startsWith('|') || (s.includes('|') && s.endsWith('|'));
  };

  const isTableDivider = (str) => {
    return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(str.trim());
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    // 围栏代码块内部不做改动
    if (!inFence && /^(```|~~~)/.test(t)) {
      inFence = true;
      fenceMarker = t.slice(0, 3);
      result.push(line);
      continue;
    }
    if (inFence) {
      if (t.startsWith(fenceMarker)) inFence = false;
      result.push(line);
      continue;
    }

    // HTML 表格规范化
    if (!inHtmlTable && /<table\b/i.test(t)) {
      if (result.length > 0 && result[result.length - 1].trim() !== '') {
        result.push('');
      }
      inHtmlTable = !/<\/table\s*>/i.test(t);
      result.push(t);
      if (!inHtmlTable) {
        const next = i + 1 < lines.length ? lines[i + 1].trim() : '';
        if (next) result.push('');
      }
      continue;
    }
    if (inHtmlTable) {
      result.push(t);
      if (/<\/table\s*>/i.test(t)) {
        inHtmlTable = false;
        const next = i + 1 < lines.length ? lines[i + 1].trim() : '';
        if (next) result.push('');
      }
      continue;
    }

    // Markdown 表格规范化
    const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
    const isStart = !inTable && isTableRow(line) && isTableDivider(nextLine);
    if (isStart) {
      if (result.length > 0 && result[result.length - 1].trim() !== '') {
        result.push('');
      }
      inTable = true;
    }

    if (inTable) {
      result.push(t);
      const nextT = nextLine.trim();
      if (!nextT || (!isTableRow(nextLine) && !isTableDivider(nextLine))) {
        inTable = false;
        if (nextT) result.push('');
      }
      continue;
    }

    result.push(line);
  }

  return result.join('\n');
}

function renderMarkdown(markdown, options = {}) {
  const lines = String(markdown).split(/\r?\n/);
  const out = [];
  let i = 0;
  // 参考文献区跟踪：进入后段落加 ref-item 类（悬挂缩进），附录后恢复。
  let inRefs = false;

  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();

    if (!t) {
      i++;
      continue;
    }

    /* --- MinerU/解析器偶尔输出 HTML 表格，保留 rowspan/colspan 等结构，并包裹居中容器 --- */
    if (/^<table\b/i.test(t)) {
      const table = [raw];
      i++;
      if (!/<\/table\s*>/i.test(raw)) {
        while (i < lines.length && !/<\/table\s*>/i.test(lines[i])) table.push(lines[i++]);
        if (i < lines.length) table.push(lines[i++]);
      }
      out.push(`<div class="table-container">${renderTableHtml(table.join('\n'), options)}</div>`);
      continue;
    }

    /* --- 围栏代码块 --- */
    if (/^(```|~~~)/.test(t)) {
      const marker = t.slice(0, 3);
      const lang = t.slice(3).trim();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        code.push(lines[i]);
        i++;
      }
      i++; // 跳过结束围栏
      out.push(`<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    /* --- 数学块 --- */
    if (t.startsWith('$$')) {
      if (t.length > 4 && t.endsWith('$$')) {
        out.push(renderMath(t.slice(2, -2), true, options.renderMath !== false));
        i++;
        continue;
      }
      const tex = [t];
      i++;
      while (i < lines.length && !lines[i].trim().endsWith('$$')) {
        tex.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        tex.push(lines[i]);
        i++;
      }
      const formula = tex.join('\n').replace(/^\$\$/, '').replace(/\$\$$/, '');
      out.push(renderMath(formula, true, options.renderMath !== false));
      continue;
    }

    /* --- 标题（图/表名误写成标题时保留语义标题，不断大纲/书签） --- */
    const heading = t.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const inner = heading[2];
      // 参考文献区跟踪（标题级）
      if (isReferencesSectionTitle(inner)) {
        inRefs = true;
      } else if (isAppendixSectionTitle(inner)) {
        inRefs = false;
      }
      if (isCaptionText(inner)) {
        // 收窄：仅“图/表 + 紧跟编号”才视为 caption，避免合法小节被吞；
        // 保留标题语义 h3/h4，保证 TOC/书签/Word 导航不断裂。
        const strictCaption = /^\s*(?:图|表|表格|Figure|Fig\.|Table|Tab\.)\s*[\d一二三四五六七八九十IVXLCDMivxlcdm]+/i.test(inner.trim());
        if (strictCaption) {
          const capLevel = Math.min(4, Math.max(3, level));
          out.push(`<h${capLevel} class="caption">${renderInline(inner, options)}</h${capLevel}>`);
        } else {
          out.push(`<h${level}>${renderInline(inner, options)}</h${level}>`);
        }
      } else {
        out.push(`<h${level}>${renderInline(inner, options)}</h${level}>`);
      }
      i++;
      continue;
    }

    /* --- 水平线 --- */
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      out.push('<hr>');
      i++;
      continue;
    }

    /* --- 表格：包裹在居中容器内，自适应防截断 --- */
    const nextIsDivider = i + 1 < lines.length && /^\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1].trim());
    if (t.startsWith('|') && nextIsDivider) {
      const head = splitRow(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${head.map((c) => `<th>${renderInline(c, options)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c, options)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`;
      out.push(`<div class="table-container"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    /* --- 引用 --- */
    if (t.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), options)}</blockquote>`);
      continue;
    }

    /* --- 列表 --- */
    if (/^([-*+]|\d+\.)\s+/.test(t)) {
      const ordered = /^\d+\.\s+/.test(t);
      const items = [];
      while (i < lines.length && /^([-*+]|\d+\.)\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^([-*+]|\d+\.)\s+/, ''));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((x) => `<li>${renderInline(x, options)}</li>`).join('')}</${tag}>`);
      continue;
    }

    /* --- 段落（强制隔离：块级公式/图片若混入段落则拆段，互不嵌套） --- */
    const para = [];
    while (i < lines.length && !isBlockStarter(lines[i].trim())) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) {
      const rawPara = para.join('\n');
      // 参考文献纯文本标题（无 #）同样触发 refs 区
      if (isReferencesSectionTitle(rawPara)) {
        inRefs = true;
      } else if (isAppendixSectionTitle(rawPara)) {
        inRefs = false;
      }
      // 段落内若含块级 $$（多行公式被压成一段），拆出独立公式块
      if (/\$\$[\s\S]+?\$\$/.test(rawPara) && rawPara.replace(/\$\$[\s\S]+?\$\$/g, '').trim().length > 0) {
        const parts = rawPara.split(/(\$\$[\s\S]+?\$\$)/g).map((s) => s.trim()).filter(Boolean);
        for (const part of parts) {
          if (/^\$\$[\s\S]+\$\$$/.test(part)) {
            out.push(renderMath(part.slice(2, -2), true, options.renderMath !== false));
          } else if (part) {
            const rendered = renderInline(part, options);
            const cls = inRefs ? ' class="ref-item"' : '';
            out.push(`<p${cls}>${rendered}</p>`);
          }
        }
      } else {
        const rendered = renderInline(rawPara, options);
        if (isCaptionText(rawPara)) {
          out.push(`<p class="caption">${rendered}</p>`);
        } else if (/^\s*(?:<a\b[^>]*>)?\s*<img\b[^>]+>\s*(?:<\/a>)?\s*$/i.test(rendered)) {
          out.push(`<p class="img-container">${rendered}</p>`);
        } else if (inRefs) {
          out.push(`<p class="ref-item">${rendered}</p>`);
        } else {
          out.push(`<p>${rendered}</p>`);
        }
      }
    } else {
      i++; // 防御：任何未识别行都不至于造成死循环
    }
  }

  return out.join('\n');
}

/** 组装完整 HTML 文档。layout=faithful 时用更接近论文的紧凑版式 */
function buildHtmlDocument({ title, bodyHtml, renderMath = true, layout = 'generic' }) {
  const paperCss =
    layout === 'faithful'
      ? `body{padding-top:32px} .paper{max-width:760px;padding:44px 52px;font-size:15.5px} h2{border-bottom:none;margin-top:1.4em}`
      : '';
  const hasRenderedMath = renderMath && /class=["'][^"']*katex/.test(String(bodyHtml || ''));
  if (hasRenderedMath) {
    loadKatex();
    if (!katexCss && katexError) throw new Error(`KaTeX 资源不可用：${katexError.message}`);
  }
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none';">
<title>${escapeHtml(title)}</title>
<style>${DOC_CSS}${hasRenderedMath ? katexCss : ''}${paperCss}</style>
</head>
<body>
<article class="paper">
      ${bodyHtml}
</article>
</body>
</html>`;
}

/** 取内联 KaTeX 样式（聊天窗注入回答排版用；资源缺失时返回空串降级） */
function getKatexCss() {
  loadKatex();
  return katexCss || '';
}

module.exports = {
  renderMarkdown,
  buildHtmlDocument,
  escapeHtml,
  isCaptionText,
  isFigureCaption,
  isTableCaption,
  normalizeMarkdownTables,
  bondFiguresAndCaptions,
  isolateBlockElements,
  applyCjkSpacing,
  isSafeHref,
  isSafeImgSrc,
  htmlTableToMarkdown,
  convertHtmlTablesToMarkdown,
  renderTableHtml,
  getKatexCss
};
