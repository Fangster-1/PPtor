'use strict';

/**
 * Markdown 智能分块
 *
 * 目标：把长文档切成适合大模型的片段，同时**保证结构零破坏**。
 * 三个关键设计：
 *  1. 状态机感知围栏代码块（``` / ~~~）与数学块（$$），绝不从中间切断；
 *  2. 优先在空行（段落边界）处切分，超长段落用 1.6 倍阈值兜底强切；
 *  3. 每块记录尾部空行，重组时原样拼回 —— 因此译文与原文的行结构完全一致。
 */

const { estimateTokens } = require('./context');

/** 判断一个片段是否值得送去翻译 */
function isTranslatable(content) {
  const s = content.trim();
  if (!s) return false;

  // 纯图片、纯公式块、纯代码块、纯 HTML 注释
  if (/^!\[[^\]]*\]\([^)]*\)$/.test(s)) return false;
  if (/^\$\$[\s\S]*\$\$$/.test(s)) return false;
  if (/^(```|~~~)[\s\S]*\1$/.test(s)) return false;
  if (/^<!--[\s\S]*-->$/.test(s)) return false;

  // 完全不含字母/汉字（纯数字、符号、公式）没有翻译价值
  if (!/\p{L}/u.test(s)) return false;

  return true;
}

function normalizedSectionHeading(value) {
  return String(value || '')
    .trim()
    .replace(/^#{0,6}\s*/, '')
    .replace(/^\d+[.\s]*/, '')
    .trim();
}

function isReferencesHeading(value) {
  const heading = normalizedSectionHeading(value);
  // \b 只识别 ASCII 单词边界，不能放在“参考文献”后；这里同时覆盖
  // 带页码、编号的 MinerU 变体和纯中文标题。
  return /^(?:references|bibliography|literature cited)(?:\b[\s\d.\-–—]*)?$/i.test(heading) ||
    /^(?:参考文献|引用文献)[\s\d.\-–—]*$/.test(heading);
}

function isAppendixHeading(value) {
  const heading = normalizedSectionHeading(value);
  return /^(?:appendix|appendices|supplementary)(?:\b|[\s\d.\-–—])/i.test(heading) ||
    /^(?:附录|补充材料)(?:$|[\s（(A-Za-z0-9一二三四五六七八九十])/i.test(heading);
}

/**
 * @param {string} markdown
 * @param {{maxTokens?: number}} [options]
 * @returns {Array<{id:number, content:string, trailing:string, tokens:number, translatable:boolean}>}
 */
function splitMarkdown(markdown, options = {}) {
  const maxTokens = options.maxTokens || 1200;
  const hardLimit = Math.round(maxTokens * 1.6);

  const lines = String(markdown).split(/\r?\n/);
  const segments = [];

  let buf = [];
  let bufTokens = 0;
  let inFence = false;
  let fenceMarker = '';
  let inMath = false;
  let inHtmlTable = false;
  let inMdTable = false;
  let inRefs = false; // 参考文献区：条目一律不翻译（翻了就找不回原文献）

  const isTableRow = (str) => {
    const s = str.trim();
    return s.startsWith('|') || (s.includes('|') && s.endsWith('|'));
  };

  const isTableDivider = (str) => {
    return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(str.trim());
  };

  const isCaption = (str) => {
    const s = str.trim();
    return /^\s*(?:[*_~`#\s]*|[(\[（【]\s*)?(?:附录?|补充)?(?:图|表|表格|Figure|Fig\.|Table|Tab\.)\s*(?:[SsAaBbCcDdEeFf]\s*[-.]?\s*)?[\d一二三四五六七八九十IVXLCDMivxlcdm]+/i.test(s);
  };

  const flush = () => {
    if (!buf.length) return;

    const raw = buf.join('\n');
    const trailing = (raw.match(/\n+$/) || [''])[0];
    const content = trailing ? raw.slice(0, raw.length - trailing.length) : raw;
    const heading = content.trim();

    // 进入「参考文献」区后，后续片段保持原文；遇到附录再恢复翻译
    // 放宽匹配：兼容 MinerU 带编号/页码/大小写变体（如 "REFERENCES 12"、"1. References"）
    if (isReferencesHeading(heading)) {
      inRefs = true;
    } else if (isAppendixHeading(heading)) {
      inRefs = false;
    }

    segments.push({
      id: segments.length,
      content,
      trailing,
      tokens: bufTokens,
      translatable: inRefs ? false : isTranslatable(content)
    });

    buf = [];
    bufTokens = 0;
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const t = line.trim();
    const safe = !inFence && !inMath && !inHtmlTable && !inMdTable;

    /* --- 围栏代码块：让它独占一个片段，既不切分、也不必送翻译 --- */
    if (safe && /^(```|~~~)/.test(t)) {
      flush();
      inFence = true;
      fenceMarker = t.slice(0, 3);
      buf.push(line);
      bufTokens += estimateTokens(line) + 1;
      continue;
    }
    if (inFence && t.startsWith(fenceMarker)) {
      buf.push(line);
      bufTokens += estimateTokens(line) + 1;
      inFence = false;
      flush();
      continue;
    }

    /* --- 数学块：同样独占，避免公式被切碎或浪费 token --- */
    if (safe && t.startsWith('$$')) {
      const singleLine = t.length > 4 && t.endsWith('$$');
      if (!singleLine) {
        flush();
        inMath = true;
        buf.push(line);
        bufTokens += estimateTokens(line) + 1;
        continue;
      }
    }
    if (inMath && t.endsWith('$$')) {
      buf.push(line);
      bufTokens += estimateTokens(line) + 1;
      inMath = false;
      flush();
      continue;
    }

    /* --- HTML 表格：绝不在表格内部切断，保留完整 <table>...</table> --- */
    if (safe && /<table\b/i.test(t)) {
      if (bufTokens >= maxTokens * 0.4) flush();
      if (!/<\/table\s*>/i.test(t)) {
        inHtmlTable = true;
      }
      buf.push(line);
      bufTokens += estimateTokens(line) + 1;
      continue;
    }
    if (inHtmlTable) {
      buf.push(line);
      bufTokens += estimateTokens(line) + 1;
      if (/<\/table\s*>/i.test(t)) {
        inHtmlTable = false;
        if (bufTokens >= maxTokens * 0.6) flush();
      }
      continue;
    }

    /* --- Markdown 表格：检测表头与分割线，保持整张表格在同一片段 --- */
    const nextLine = idx + 1 < lines.length ? lines[idx + 1] : '';
    const isMdTableStart = safe && isTableRow(line) && isTableDivider(nextLine);
    if (isMdTableStart) {
      if (bufTokens >= maxTokens * 0.4) flush();
      inMdTable = true;
    }
    if (inMdTable) {
      buf.push(line);
      bufTokens += estimateTokens(line) + 1;
      // 表格结束判定：下一行为空行或非表格行
      const nextT = nextLine.trim();
      if (!nextT || (!isTableRow(nextLine) && !isTableDivider(nextLine))) {
        inMdTable = false;
        if (bufTokens >= maxTokens * 0.6) flush();
      }
      continue;
    }

    /* --- 表名/图名预感知：如果紧接着是表格，尽量把标题和表格留在同一片段 --- */
    if (safe && isCaption(t) && idx + 1 < lines.length) {
      const nextIsTable = isTableRow(nextLine) || /<table\b/i.test(nextLine);
      if (nextIsTable && bufTokens >= maxTokens * 0.3) {
        flush();
      }
    }

    /* --- 参考文献 / 附录标题：强制单独成段，这样 flush 里的区间判定才准确 --- */
    if (safe && (isReferencesHeading(t) || isAppendixHeading(t))) {
      flush();
      buf.push(line);
      bufTokens += estimateTokens(line) + 1;
      flush();
      continue;
    }

    /* --- 普通行：累积到阈值后，优先在空行边界切分 --- */
    buf.push(line);
    bufTokens += estimateTokens(line) + 1;

    if (safe && !t && bufTokens >= maxTokens * 0.6) {
      flush();
    } else if (safe && bufTokens >= hardLimit) {
      // 兜底强切：优先回退到句界（。！？.!? + 引号），避免拦腰断句。
      const joined = buf.join('\n');
      const m = joined.match(/[\u3002\uff01\uff1f.!?]["'”』）)]?\s*\n?/g);
      if (m && buf.length > 3) {
        // 已在句界附近：直接切（当前 buf 即一整段，最多只是略超限）。
        flush();
      } else {
        // 尝试按句号切出前半段：找最后一个句界位置
        const lastBoundary = Math.max(
          joined.lastIndexOf('。'),
          joined.lastIndexOf('！'),
          joined.lastIndexOf('？'),
          joined.lastIndexOf('. '),
          joined.lastIndexOf('! '),
          joined.lastIndexOf('? ')
        );
        if (lastBoundary > joined.length * 0.4) {
          const head = joined.slice(0, lastBoundary + 1);
          const tail = joined.slice(lastBoundary + 1).replace(/^\n+/, '');
          buf = tail ? tail.split('\n') : [];
          bufTokens = buf.reduce((n, l) => n + estimateTokens(l) + 1, 0);
          const trailing = (head.match(/\n+$/) || [''])[0];
          const content = trailing ? head.slice(0, head.length - trailing.length) : head;
          segments.push({
            id: segments.length,
            content,
            trailing,
            tokens: estimateTokens(content),
            translatable: isTranslatable(content)
          });
        } else {
          flush(); // 实在无句界才硬切
        }
      }
    }
  }

  flush();
  return segments;
}

/**
 * 用译文回填片段，重组为完整 Markdown。
 * @param {Array} segments splitMarkdown 的结果
 * @param {Map<number,string>} translations id → 译文
 */
function reassemble(segments, translations) {
  return segments
    .map((seg) => {
      const translated = seg.translatable ? translations.get(seg.id) : null;
      const body = translated != null && translated.trim() ? translated : seg.content;
      return body + seg.trailing;
    })
    .join('\n');
}

/** 生成双语对照：原文一段、译文紧随其后 */
function buildBilingual(segments, translations, opts = {}) {
  const mark = opts.separator || '> **[译]**';
  const out = [];

  for (const seg of segments) {
    const translated = seg.translatable ? translations.get(seg.id) : null;
    const hasTranslation = translated != null && translated.trim() && translated.trim() !== seg.content.trim();

    if (!hasTranslation) {
      out.push(seg.content + seg.trailing);
      continue;
    }

    if (!seg.content.trim()) {
      out.push(seg.content + seg.trailing);
      continue;
    }

    // 引用块形式承载译文，既醒目又不干扰 Markdown 结构
    const quoted = translated
      .trim()
      .split(/\r?\n/)
      .map((l) => (l.trim() ? `> ${l}` : '>'))
      .join('\n');

    out.push(`${seg.content}\n\n${mark}\n${quoted}${seg.trailing || '\n'}`);
  }

  return out.join('\n');
}

module.exports = { splitMarkdown, reassemble, buildBilingual, estimateTokens, isTranslatable, isReferencesHeading, isAppendixHeading };
