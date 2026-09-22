'use strict';

/**
 * 文本分析工具：语言识别 + 标题提取与文件名净化
 *
 * 两件事都在这里做，因为它们共用同一套「逐字符统计」的实现。
 */

/* ================================================================== *
 * 语言识别
 * ================================================================== */

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
const LATIN_RE = /[A-Za-z]/;

/**
 * 统计文本的字符构成
 * @returns {{cjk:number, latin:number, total:number, cjkRatio:number, latinRatio:number}}
 */
function analyze(text) {
  const s = String(text || '');
  let cjk = 0;
  let latin = 0;

  for (const ch of s) {
    if (CJK_RE.test(ch)) cjk += 1;
    else if (LATIN_RE.test(ch)) latin += 1;
  }

  const total = cjk + latin;
  return {
    cjk,
    latin,
    total,
    cjkRatio: total ? cjk / total : 0,
    latinRatio: total ? latin / total : 0
  };
}

/**
 * 判断这篇论文是否「英文论文」
 *
 * 判据：拉丁字母占绝对多数且中文字符很少。
 * 之所以不只看英文占比：公式、数字、符号会稀释比例，所以同时设了绝对门槛。
 *
 * @returns {{isEnglish:boolean, cjkRatio:number, latinRatio:number, reason:string}}
 */
function detectEnglishPaper(markdown) {
  const text = String(markdown || '');
  const { cjk, latin, cjkRatio, latinRatio, total } = analyze(text);

  // 日/韩字符单独统计，避免与中文混淆
  const ja = (text.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
  const ko = (text.match(/[\uac00-\ud7af]/g) || []).length;

  // 样本太小不做判断，交给用户
  if (total < 80) {
    return { isEnglish: true, cjkRatio, latinRatio, reason: '文本过短，按英文处理' };
  }

  if (ko > 50) {
    return { isEnglish: false, cjkRatio, latinRatio, reason: `检测到韩文字符约 ${ko} 个，疑似韩文文献` };
  }
  if (ja > 50) {
    return { isEnglish: false, cjkRatio, latinRatio, reason: `检测到日文假名约 ${ja} 个，疑似日文文献` };
  }

  // 大文档抽样投票：参考文献混中文易误伤，抽头/中/尾三段投票
  let votes = 0;
  if (text.length > 20000) {
    const parts = [text.slice(0, 8000), text.slice(Math.floor(text.length / 2) - 4000, Math.floor(text.length / 2) + 4000), text.slice(-8000)];
    for (const p of parts) {
      const a = analyze(p);
      if (a.cjkRatio >= 0.25 || a.cjk > 300) votes++;
    }
    if (votes >= 2) {
      return { isEnglish: false, cjkRatio, latinRatio, reason: `多段抽样均含较多中文（${votes}/3 段），疑似中文文献` };
    }
  }

  // 中文字符本身就不少 → 大概率是中文论文
  if (cjkRatio >= 0.25 || cjk > 800) {
    return {
      isEnglish: false,
      cjkRatio,
      latinRatio,
      reason: `中文字符占比 ${(cjkRatio * 100).toFixed(0)}%，看起来已经是中文文献`
    };
  }

  if (latinRatio >= 0.6) {
    // 拉丁语系小语种提示：德/法等仍走英文通道，但给出原因供确认框展示
    return { isEnglish: true, cjkRatio, latinRatio, reason: '以拉丁字母正文为主（英文或其它欧洲语言），按英文通道处理' };
  }

  // 拉丁字母不多但中文也少（可能是公式密集或小语种）
  return {
    isEnglish: latin > cjk * 2,
    cjkRatio,
    latinRatio,
    reason: '文本构成不明确，按主要字符集判断'
  };
}

/* ================================================================== *
 * 标题提取与文件名净化
 * ================================================================== */

/** Windows 文件名非法字符 */
const ILLEGAL_FILENAME_RE = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 保留字（Windows 不允许作为文件名） */
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

/**
 * 把任意字符串净化为安全的文件名（不含扩展名）
 * @param {string} raw
 * @param {number} [maxLen=80]
 */
function safeFileName(raw, maxLen = 80) {
  let s = String(raw || '').trim();

  // 去掉 Markdown 标记与首尾引号
  s = s
    .replace(/^#+\s*/, '')
    .replace(/[*_`~]/g, '')
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .trim();

  // 非法字符 → 空格，再压缩空白
  s = s.replace(ILLEGAL_FILENAME_RE, ' ').replace(/\s+/g, ' ').trim();

  // 去掉结尾的标点与空白
  // Windows 不允许文件名以点或空格结尾；中文标题常以「。」结尾，也要一并处理
  s = s.replace(/[\s.。．，,、；;：:！!？?]+$/g, '').trim();

  // 保留字加下划线
  if (RESERVED.has(s.toUpperCase())) s = `${s}_`;

  if (s.length > maxLen) s = s.slice(0, maxLen).trim();

  return s;
}

/**
 * 从译文里提取中文标题，用于给产物命名
 *
 * 优先级：
 *   1. 第一个一级标题 `# xxx`（翻译后通常就是中文标题）
 *   2. 第一个任意级别的标题
 *   3. 首个非空行（截断）
 *   4. 回退到原文件名
 *
 * @param {string} translatedMarkdown 译文
 * @param {string} fallback 原文件名（不含扩展名）
 */
function extractTitle(translatedMarkdown, fallback = '') {
  const text = String(translatedMarkdown || '');

  // 跳过 frontmatter / 分隔线，找标题
  const h1 = text.match(/^\s*#\s+(.+)$/m);
  if (h1) {
    const t = safeFileName(h1[1]);
    if (t) return t;
  }

  const anyHeading = text.match(/^\s*#{2,6}\s+(.+)$/m);
  if (anyHeading) {
    const t = safeFileName(anyHeading[1]);
    if (t) return t;
  }

  // 首个有意义的非空行（但排除明显是正文句子的情况）
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^[-=*>|`]/.test(t)) continue; // 跳过分隔线、表格、引用
    if (/^!\[/.test(t)) continue; // 跳过图片

    // 以句末标点结尾 → 更像正文句子，不适合当标题
    if (/[。！？.!?]$/.test(t)) break;

    const cleaned = safeFileName(t).slice(0, 60);
    if (cleaned.length >= 4) return cleaned;
    break;
  }

  return safeFileName(fallback) || '未命名论文';
}

/**
 * 让目录名在目标路径下不冲突
 * @deprecated 当前流水线使用 uniqueBaseName（单文件多格式），本函数暂无调用，仅保留兼容。
 * @param {string} dir 期望目录
 * @param {string} name 目录名
 */
function uniqueDirName(dir, name) {
  const fs = require('node:fs');
  const path = require('node:path');

  let candidate = name;
  let i = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${name} (${i})`;
    i += 1;
    if (i > 999) break;
  }
  return candidate;
}

/**
 * 让论文产物目录和旧版扁平产物文件名都不冲突。
 * @param {string} dir 期望存放目录
 * @param {string} name 期望的基础文件名
 * @param {string[]} [exts] 需要校验的文件后缀
 */
function uniqueBaseName(dir, name, exts = ['.md', '.html', '.pdf', '.docx']) {
  const fs = require('node:fs');
  const path = require('node:path');

  let candidate = name;
  let i = 2;
  const exists = (base) => fs.existsSync(path.join(dir, base))
    || exts.some((ext) => fs.existsSync(path.join(dir, `${base}${ext}`)));
  while (exists(candidate)) {
    candidate = `${name} (${i})`;
    i += 1;
    if (i > 999) break;
  }
  return candidate;
}

module.exports = { analyze, detectEnglishPaper, safeFileName, extractTitle, uniqueDirName, uniqueBaseName };
