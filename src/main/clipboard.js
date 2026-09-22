'use strict';

/**
 * 剪贴板读取：拿到「用户刚刚复制的文件路径」
 *
 * Windows 上不同来源复制的文件，剪贴板格式不一样，这里逐个尝试：
 *   FileNameW    UTF-16LE，\0 分隔、\0\0 结尾       （PowerShell / 多数程序）
 *   CF_HDROP     DROPFILES 结构 + 路径列表          （资源管理器 Ctrl+C）
 *   FileName     本地编码路径列表
 *   text/uri-list / text                            （从浏览器或路径文本复制）
 *
 * 只要命中一种就返回绝对路径列表；全都拿不到就返回空数组，由 UI 提示手动选择。
 */
const fs = require('node:fs');
const path = require('node:path');
const { clipboard } = require('electron');

/** 解析 UTF-16LE 的多字符串列表（\0 分隔，\0\0 结束） */
function parseWideList(buf) {
  const out = [];
  let start = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      const chunk = buf.subarray(start, i);
      if (!chunk.length) {
        start = i + 2;
        continue;
      }
      out.push(chunk.toString('utf16le'));
      start = i + 2;
    }
  }
  if (start < buf.length) {
    const tail = buf.subarray(start).toString('utf16le').replace(/\u0000+$/, '');
    if (tail) out.push(tail);
  }
  return out.filter(Boolean);
}

/** 解析 DROPFILES 结构（CF_HDROP） */
function parseDropFiles(buf) {
  if (buf.length < 20) return [];

  const offset = buf.readUInt32LE(0);
  const wide = buf.readUInt32LE(16) !== 0;
  if (offset <= 0 || offset >= buf.length) return [];

  const body = buf.subarray(offset);
  return wide
    ? parseWideList(body)
    : body
        .toString('latin1')
        .split('\u0000')
        .map((s) => s.trim())
        .filter(Boolean);
}

function fromUriList(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('file:'))
    .map((l) => {
      try {
        return decodeURIComponent(new URL(l).pathname).replace(/^\//, '').replace(/\//g, '\\');
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

/**
 * 读取剪贴板中的文件路径
 * @returns {{files: string[], source: string}}
 */
function readClipboardFiles() {
  const attempts = [
    ['FileNameW', parseWideList],
    ['CF_HDROP', parseDropFiles],
    ['FileName', (b) => b.toString('latin1').split('\u0000').map((s) => s.trim()).filter(Boolean)]
  ];

  for (const [format, parser] of attempts) {
    try {
      const buf = clipboard.readBuffer(format);
      if (!buf || !buf.length) continue;
      const files = parser(buf)
        .map((p) => p.replace(/\\+$/, ''))
        .filter((p) => p && fs.existsSync(p) && fs.statSync(p).isFile());
      if (files.length) return { files, source: format };
    } catch {
      /* 该格式不存在，试下一个 */
    }
  }

  // 退路：纯文本里可能是路径或 URI
  try {
    const text = clipboard.readText();
    if (text) {
      const uris = fromUriList(text);
      if (uris.length) return { files: uris, source: 'uri-list' };

      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim().replace(/^"|"$/g, ''))
        .filter((l) => l && /\.(pdf|md|markdown|txt)$/i.test(l) && fs.existsSync(l));
      if (lines.length) return { files: lines, source: 'text' };
    }
  } catch {
    /* 忽略 */
  }

  return { files: [], source: 'none' };
}

/**
 * 校验路径列表：只保留存在的文件，并给出被过滤掉的项
 * @param {string[]} paths
 * @param {string[]} allowedExt 例：['.pdf']
 */
function filterPaths(paths, allowedExt) {
  const ok = [];
  const rejected = [];

  for (const p of paths || []) {
    try {
      const abs = path.resolve(p);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        rejected.push({ path: p, reason: '文件不存在' });
        continue;
      }
      if (allowedExt && !allowedExt.includes(path.extname(abs).toLowerCase())) {
        rejected.push({ path: p, reason: `不支持的格式（需要 ${allowedExt.join(' / ')}）` });
        continue;
      }
      ok.push(abs);
    } catch (err) {
      rejected.push({ path: p, reason: err.message });
    }
  }

  // 去重（同一文件被选多次）
  return { files: [...new Set(ok)], rejected };
}

module.exports = { readClipboardFiles, filterPaths };
