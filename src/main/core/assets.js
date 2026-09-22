'use strict';

/**
 * 导出资源与图片引用解析
 */

const path = require('node:path');

const MIME_BY_EXT = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

// 透明 PNG 而非 SVG：Node 回归和无 BrowserWindow 的 Word 导出都能直接嵌入，
// 不会让“缺图降级”反过来变成一次 SVG 转码失败。
const EMPTY_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL7jQAAAABJRU5ErkJggg==';

function normaliseRef(value) {
  let ref = String(value || '').trim();
  try {
    ref = decodeURIComponent(ref);
  } catch {
    /* 保留原字符串，下面仍可按 basename 匹配 */
  }
  ref = path.posix.normalize(ref.replace(/\\/g, '/')).replace(/^\.\//, '').toLowerCase();
  return ref;
}

function mimeFor(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function toDataUri(data, name, mime) {
  if (typeof data === 'string' && /^data:/i.test(data)) return data;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
  return `data:${mime || mimeFor(name)};base64,${buf.toString('base64')}`;
}

function buildAssetIndex(images = []) {
  const byRef = new Map();
  const byName = new Map();
  const setUnique = (map, key, cell) => {
    if (!key) return;
    const previous = map.get(key);
    // 同名图只能按完整相对路径解析；歧义时宁可报告缺图，也不能静默嵌入错误插图。
    if (previous && previous !== cell) map.set(key, null);
    else if (!map.has(key)) map.set(key, cell);
  };
  for (const image of Array.isArray(images) ? images : []) {
    if (!image || !image.name || image.data == null) continue;
    // 惰性包装单元：仅在真正被 Markdown 引用时才转 Base64，且 byRef/byName 共享同一个 Data URI 字符串
    const cell = {
      _uri: null,
      get uri() {
        if (!this._uri) {
          this._uri = toDataUri(image.data, image.name, image.mime);
        }
        return this._uri;
      }
    };
    const refs = new Set([image.name, ...(Array.isArray(image.refs) ? image.refs : [])]);
    for (const rawRef of refs) {
      const ref = normaliseRef(rawRef);
      setUnique(byRef, ref, cell);
      setUnique(byName, path.posix.basename(ref), cell);
    }
  }
  return { byRef, byName };
}

function resolveAsset(ref, index) {
  const source = String(ref || '').trim();
  if (/^data:/i.test(source)) return source;
  const key = normaliseRef(source);
  // 精确路径出现歧义时，不能退回到同名文件：那会静默嵌入错误的图。
  // 只有没有精确路径索引时，才允许按唯一文件名兜底。
  const item = index.byRef.has(key)
    ? index.byRef.get(key)
    : (index.byName.get(path.posix.basename(key)) || null);
  if (!item) return null;
  return typeof item === 'string' ? item : item.uri;
}

/**
 * 将 Markdown 图片引用替换成 data URI。
 * 缺图不再让整个导出失败：用占位图 + 缺图清单降级，保证其它格式仍可产出。
 * 默认阻断外部 http(s) 图片，避免“自包含译文”在打开/打印时泄露网络请求。
 * @returns {string} 内嵌后的 Markdown（缺图清单挂在 .missing 上）
 */
function inlineMarkdownImages(markdown, images = [], options = {}) {
  const index = buildAssetIndex(images);
  const missing = [];
  const noteMissing = (src) => {
    const s = String(src || '');
    if (s && !missing.includes(s)) missing.push(s);
    console.warn(`[assets] 缺图，已用占位图代替：${s}`);
  };
  let output = String(markdown || '');
  const definitions = new Map();
  const definitionLines = new Map();
  const usedDefinitions = new Set();
  // CommonMark 图片定义：[figure-a]: images/figure-a.png 或 [figure-a]: <...>
  output = output.replace(
    /^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))(?:\s+(?:&quot;|\"|')([^\"']*)(?:&quot;|\"|'))?\s*$/gim,
    (full, label, bracketed, bare) => {
      definitions.set(normaliseRef(label), bracketed || bare);
      definitionLines.set(normaliseRef(label), full);
      return `\uE100${label}\uE101`;
    }
  );
  output = output.replace(
    /!\[([^\]]*)\]\[([^\]]*)\]/g,
    (_full, alt, label) => {
      const key = normaliseRef(label || alt);
      const src = definitions.get(key);
      if (!src) {
        noteMissing(`[${label || alt}]`);
        usedDefinitions.add(key);
        return `![${alt}](${EMPTY_IMAGE})`;
      }
      usedDefinitions.add(key);
      if (/^https?:/i.test(src)) {
        if (options.allowExternalImages) return `![${alt}](${src})`;
        noteMissing(`外部图片已阻断：${src}`);
        return `![${alt}](${EMPTY_IMAGE})`;
      }
      const uri = resolveAsset(src, index);
      if (!uri) {
        noteMissing(src);
        return `![${alt}](${EMPTY_IMAGE})`;
      }
      return `![${alt}](${uri})`;
    }
  );
  output = output.replace(
    /!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+(?:&quot;|\")([^\"]*)(?:&quot;|\"))?\s*\)/g,
    (_full, alt, src, title) => {
      if (/^https?:/i.test(src)) {
        if (options.allowExternalImages) return _full;
        noteMissing(`外部图片已阻断：${src}`);
        return `![${alt}](${EMPTY_IMAGE})`;
      }
      if (/^data:/i.test(src)) return _full;
      const uri = resolveAsset(src, index);
      if (!uri) {
        noteMissing(src);
        const titlePart = title ? ` "${String(title).replace(/"/g, '&quot;')}"` : '';
        return `![${alt}](${EMPTY_IMAGE}${titlePart})`;
      }
      const titlePart = title ? ` "${String(title).replace(/"/g, '&quot;')}"` : '';
      return `![${alt}](${uri}${titlePart})`;
    }
  );
  output = output.replace(/\uE100([^\uE101]+)\uE101/g, (full, label) =>
    usedDefinitions.has(normaliseRef(label)) ? '' : definitionLines.get(normaliseRef(label)) || full
  );
  // MinerU 某些版本会在 Markdown 中混入原生 HTML <img>，同样改成
  // data URI；外部 http(s) 保留，缺图用占位。
  output = output.replace(
    /(<img\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)\2/gi,
    (_full, prefix, quote, src) => {
      if (/^data:/i.test(src)) return _full;
      if (/^https?:/i.test(src)) {
        if (options.allowExternalImages) return _full;
        noteMissing(`外部图片已阻断：${src}`);
        return `${prefix}${quote}${EMPTY_IMAGE}${quote}`;
      }
      const uri = resolveAsset(src, index);
      if (!uri) {
        noteMissing(src);
        return `${prefix}${quote}${EMPTY_IMAGE}${quote}`;
      }
      return `${prefix}${quote}${uri}${quote}`;
    }
  );
  // 字符串挂属性在严格模式下会抛错，用 String 对象包装保持兼容：调用方仍可当字符串用
  const boxed = new String(output);
  boxed.missing = missing;
  return boxed;
}

function dataUriToBuffer(uri) {
  const m = String(uri || '').match(/^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([\s\S]*)$/i);
  if (!m) return null;
  try {
    return { mime: m[1] || 'application/octet-stream', data: Buffer.from(m[2], 'base64') };
  } catch {
    return null;
  }
}

module.exports = {
  EMPTY_IMAGE,
  buildAssetIndex,
  dataUriToBuffer,
  inlineMarkdownImages,
  mimeFor,
  normaliseRef,
  resolveAsset,
  toDataUri
};
