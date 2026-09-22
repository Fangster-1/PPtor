'use strict';

/**
 * 问答语料加载（从 ipc.js 抽出，可独立单测）。
 * 三级回退：哈希成果包 → 译文库索引反查 → 直接读纯文本。
 */
const fs = require('node:fs');
const path = require('node:path');

const registry = require('../core/registry');
const library = require('../core/library');

/**
 * 从文件列表加载问答语料。
 * @param {string[]} files
 * @returns {Promise<{papers: Array<{name:string, markdown:string}>}>}
 */
async function loadPapersFromFiles(files) {
  const papers = [];

  for (const f of Array.isArray(files) ? files : []) {
    try {
      if (!fs.existsSync(f)) continue;

      // 1. 优先尝试从哈希压缩成果包（bundle.gz）中极速读取纯净译文（0 本地解析、0 Token 浪费，最稳定命中 Prefix Cache）
      try {
        const fp = await registry.fingerprint(f);
        if (fp) {
          const bundle = await registry.getBundle(fp.key);
          const bundleText = (bundle && (bundle.translatedMarkdown || bundle.embeddedMarkdown)) || '';
          if (bundleText.trim()) {
            const clean = library.stripDataUris(bundleText);
            if (clean.trim()) {
              papers.push({
                name: bundle.title ? `${bundle.title}.md` : path.basename(f),
                markdown: clean
              });
              continue;
            }
          }
        }
      } catch {
        /* 成果包未命中时平滑向下回退 */
      }

      // 2. 二进制/富格式降级回退：通过译文库索引反查
      const ext = path.extname(f).toLowerCase();
      if (['.pdf', '.docx', '.html', '.htm'].includes(ext)) {
        // PDF/Word/HTML 可能是二进制或带大量内嵌图片，不能直接按 utf8 读取。
        const hit = library.match(library.root(), f);
        const markdown = hit ? library.readQa(library.root(), hit.work) : '';
        if (markdown.trim()) papers.push({ name: hit.work.title ? `${hit.work.title}.md` : path.basename(f), markdown });
        continue;
      }

      // 3. 纯文本/Markdown 文本直接读取（异步 + 5MB 上限，避免网盘大文件卡主进程）
      try {
        const stat = await fs.promises.stat(f);
        if (stat.size > 5 * 1024 * 1024) {
          console.warn('[qa] 文件过大已跳过：', f);
          continue;
        }
        const text = await fs.promises.readFile(f, 'utf8');
        if (!text.trim()) continue;
        const clean = library.stripDataUris(text.slice(0, 1500000));
        if (clean.trim()) papers.push({ name: path.basename(f), markdown: clean });
      } catch {
        continue;
      }
    } catch (err) {
      console.warn('[qa] 读取失败：', f, err.message);
    }
  }

  return { papers };
}

module.exports = { loadPapersFromFiles };
