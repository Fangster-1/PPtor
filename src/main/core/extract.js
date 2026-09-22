'use strict';

/**
 * 纯本地格式解析器（从 registry.js 拆出，供 0 Token 快照补全复用）：
 *  - extractMarkdownFromHtml：轻量离线 HTML → Markdown
 *  - extractMarkdownFromDocx：纯本地 Word(.docx) → 富文本 Markdown（含内嵌媒体图片）
 *  - extractTextFromPdf：纯本地 PDF 文本流提取（FlateDecode + Tj/TJ）
 */
const path = require('node:path');
const zlib = require('node:zlib');

/**
 * 轻量离线 HTML 转 Markdown（供 0 Token 补全快照使用）
 */
function extractMarkdownFromHtml(html) {
  if (!html || typeof html !== 'string') return '';
  const m = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  let content = m ? m[1] : html;

  content = content.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  content = content.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, text) => {
    return `\n\n${'#'.repeat(Number(level))} ${text.replace(/<[^>]+>/g, '').trim()}\n\n`;
  });

  content = content.replace(/<img\b[^>]*src="([^"]+)"[^>]*alt="([^"]*)"[^>]*>/gi, (_m, src, alt) => {
    return `\n\n![${alt}](${src})\n\n`;
  });
  content = content.replace(/<img\b[^>]*alt="([^"]*)"[^>]*src="([^"]+)"[^>]*>/gi, (_m, alt, src) => {
    return `\n\n![${alt}](${src})\n\n`;
  });
  content = content.replace(/<img\b[^>]*src="([^"]+)"[^>]*>/gi, (_m, src) => {
    return `\n\n![](${src})\n\n`;
  });

  content = content.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_m, text) => {
    const clean = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
    return clean ? `\n\n${clean}\n\n` : '';
  });

  content = content.replace(/<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/gi, (_m, lang, code) => {
    const decoded = code.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    return `\n\n\`\`\`${lang || ''}\n${decoded}\n\`\`\`\n\n`;
  });

  content = content.replace(/<br\s*\/?>/gi, '\n');
  content = content.replace(/<\/?[^>]+(>|$)/g, '');

  return content.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 纯本地离线从 Word (.docx) 提取富文本 Markdown（包含段落、标题、表格与内嵌媒体图片），0 Token 消耗！
 */
function extractMarkdownFromDocx(docxBuffer) {
  if (!docxBuffer || !Buffer.isBuffer(docxBuffer)) return '';
  try {
    const { unzip } = require('./zip');
    const entries = unzip(docxBuffer);
    const docEntry = entries.find((e) => e.name === 'word/document.xml');
    if (!docEntry) return '';

    const relsEntry = entries.find((e) => e.name === 'word/_rels/document.xml.rels');
    const relsMap = new Map();
    if (relsEntry) {
      const relsXml = relsEntry.data.toString('utf8');
      const relMatches = relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*>/gi);
      for (const m of relMatches) {
        const id = m[1];
        let target = m[2];
        if (!target.startsWith('word/')) target = 'word/' + target.replace(/^\/?/, '');
        relsMap.set(id, target);
      }
    }

    const mediaMap = new Map();
    for (const entry of entries) {
      if (entry.name.startsWith('word/media/')) {
        const ext = path.extname(entry.name).toLowerCase().slice(1);
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'png'}`;
        mediaMap.set(entry.name, `data:${mime};base64,${entry.data.toString('base64')}`);
      }
    }

    const xml = docEntry.data.toString('utf8');
    const blockMatches = xml.matchAll(/<(w:p|w:tbl)\b[\s\S]*?<\/\1>/gi);
    const lines = [];

    for (const bm of blockMatches) {
      const tag = bm[1];
      const blockXml = bm[0];

      if (tag === 'w:p') {
        const styleMatch = blockXml.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/i);
        const style = styleMatch ? styleMatch[1].toLowerCase() : '';
        let prefix = '';
        if (style.includes('heading1') || style.includes('title')) prefix = '# ';
        else if (style.includes('heading2')) prefix = '## ';
        else if (style.includes('heading3')) prefix = '### ';

        const blipMatch = blockXml.match(/<a:blip\b[^>]*r:embed="([^"]+)"/i);
        if (blipMatch) {
          const rId = blipMatch[1];
          const mediaPath = relsMap.get(rId);
          const dataUri = mediaPath ? mediaMap.get(mediaPath) : null;
          if (dataUri) {
            lines.push(`![图片](${dataUri})`);
            continue;
          }
        }

        const textMatches = blockXml.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi) || [];
        const text = textMatches.map((t) => t.replace(/<[^>]+>/g, '')).join('');
        if (text.trim()) {
          lines.push(prefix ? `${prefix}${text.trim()}` : text.trim());
        }
      } else if (tag === 'w:tbl') {
        const rowMatches = blockXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/gi) || [];
        const tableRows = [];
        for (const rm of rowMatches) {
          const cellMatches = rm.match(/<w:tc\b[\s\S]*?<\/w:tc>/gi) || [];
          const cells = [];
          for (const cm of cellMatches) {
            const tMatches = cm.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi) || [];
            cells.push(tMatches.map((t) => t.replace(/<[^>]+>/g, '')).join('').trim());
          }
          if (cells.length > 0) {
            tableRows.push(cells);
          }
        }
        if (tableRows.length > 0) {
          const header = tableRows[0];
          lines.push(`| ${header.join(' | ')} |`);
          lines.push(`| ${header.map(() => '---').join(' | ')} |`);
          for (let r = 1; r < tableRows.length; r++) {
            lines.push(`| ${tableRows[r].join(' | ')} |`);
          }
        }
      }
    }

    return lines.join('\n\n');
  } catch (err) {
    console.warn('[extract] 从 docx 提取内容失败：', err.message);
    return '';
  }
}

/**
 * 纯本地离线从 PDF 字节流中提取文本内容（支持 FlateDecode 流解压与 Tj/TJ 字符提取），0 Token 消耗！
 */
function extractTextFromPdf(pdfBuffer) {
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) return '';
  try {
    const raw = pdfBuffer.toString('latin1');
    const streamMatches = raw.matchAll(/stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g);
    const textChunks = [];

    for (const sm of streamMatches) {
      let streamData = Buffer.from(sm[1], 'latin1');
      try {
        streamData = zlib.inflateSync(streamData);
      } catch {
        // 非 FlateDecode 流保持原样
      }

      const content = streamData.toString('utf8');
      if (!content.includes('Tj') && !content.includes('TJ')) continue;

      // 提取 [(str1) -10 (str2)] TJ
      const arrayMatches = content.matchAll(/\[(.*?)\]\s*TJ/g);
      for (const am of arrayMatches) {
        const parts = am[1].match(/\(([^)]+)\)/g) || [];
        const line = parts.map((p) => p.slice(1, -1)).join('');
        if (line.trim()) textChunks.push(line.trim());
      }

      // 提取 (str) Tj
      const tjMatches = content.matchAll(/\(([^)]+)\)\s*Tj/g);
      for (const tm of tjMatches) {
        if (tm[1].trim()) textChunks.push(tm[1].trim());
      }

      // 提取 <00410042> Tj (UTF-16BE)
      const hexMatches = content.matchAll(/<([0-9a-fA-F]{4,})>\s*Tj/g);
      for (const hm of hexMatches) {
        try {
          const hexBuf = Buffer.from(hm[1], 'hex');
          const decoded = hexBuf.toString('utf16be');
          if (decoded.trim()) textChunks.push(decoded.trim());
        } catch {
          /* ignore */
        }
      }
    }

    if (textChunks.length > 0) {
      return textChunks.join('\n\n');
    }
  } catch (err) {
    console.warn('[extract] 从 PDF 提取文本失败：', err.message);
  }
  return '';
}

module.exports = { extractMarkdownFromHtml, extractMarkdownFromDocx, extractTextFromPdf };
