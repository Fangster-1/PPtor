'use strict';

/**
 * 译文产物质量检查（纯 Node，无 Electron）。
 * 用法: node scripts/e2e-inspect.js <产物目录> [--content=mono|bilingual]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);
const dir = ARGV.find((a) => !a.startsWith('--'));
const content = (ARGV.find((a) => a.startsWith('--content=')) || '--content=mono').slice(10);

if (!dir || !fs.existsSync(dir)) {
  console.error('用法: node scripts/e2e-inspect.js <产物目录> [--content=mono|bilingual]');
  process.exit(2);
}

const names = fs.readdirSync(dir);
const read = (ext) => {
  const hit = names.find((n) => n.toLowerCase().endsWith(ext));
  return hit ? fs.readFileSync(path.join(dir, hit)) : null;
};

const out = { dir, content, files: {} };

const md = read('.md');
if (md) {
  const t = md.toString('utf8');
  out.files.md = {
    bytes: md.length,
    blockMath: Math.floor((t.match(/\$\$/g) || []).length / 2),
    images: (t.match(/!\[[^\]]*\]\(/g) || []).length,
    mdTableRows: (t.match(/^\|/gm) || []).length,
    htmlTables: (t.match(/<table\b/gi) || []).length,
    bilingualMarks: (t.match(/> \*\*\[译\]\*\*/g) || []).length,
    cjkChars: (t.match(/[\u4e00-\u9fff]/g) || []).length,
    // 正文残留的英文长句（参考文献区之外；排除 SMILES 等无空格数据串）
    englishBody: (() => {
      const cut = t.search(/\n#+\s*(References|参考文献|Bibliography)/i);
      const body = cut > 0 ? t.slice(0, cut) : t;
      const raw = body.replace(/> \*\*\[译\]\*\*/g, '').match(/[A-Za-z][A-Za-z ,.'()]{100,}/g) || [];
      return raw.filter((s) => s.split(' ').length > 10).length;
    })()
  };
  if (content === 'bilingual') {
    out.files.md.hasEnglishOriginal = /[A-Za-z][A-Za-z ,.'()]{120,}/.test(t.replace(/> \*\*\[译\]\*\*/g, ''));
  }
}

const html = read('.html');
if (html) {
  const t = html.toString('utf8');
  out.files.html = {
    bytes: html.length,
    katex: (t.match(/class="katex/g) || []).length,
    dataImages: (t.match(/src="data:image/g) || []).length,
    tables: (t.match(/<table\b/g) || []).length,
    csp: /Content-Security-Policy/.test(t),
    layoutFaithful: /max-width:\s*760px/.test(t),
    layoutGeneric: /max-width:\s*820px/.test(t)
  };
}

const pdf = read('.pdf');
if (pdf) {
  out.files.pdf = {
    bytes: pdf.length,
    header: pdf.subarray(0, 5).toString('ascii'),
    embeddedImages: (pdf.toString('latin1').match(/\/Subtype \/Image/g) || []).length
  };
}

const docx = read('.docx');
if (docx) {
  try {
    const { unzip } = require(path.join(ROOT, 'src/main/core/zip'));
    const entries = unzip(docx);
    const doc = entries.find((e) => e.name === 'word/document.xml');
    const xml = doc ? doc.data.toString('utf8') : '';
    out.files.docx = {
      bytes: docx.length,
      oMath: (xml.match(/<m:oMath[> ]/g) || []).length,
      images: (xml.match(/<a:blip /g) || []).length,
      mediaFiles: entries.filter((e) => e.name.startsWith('word/media/') && e.data.length).length,
      tables: (xml.match(/<w:tbl>/g) || []).length,
      cjkChars: (xml.match(/[\u4e00-\u9fff]/g) || []).length,
      hasEnglishOriginal: /[A-Za-z][A-Za-z ,.'()]{120,}/.test(xml)
    };
  } catch (err) {
    out.files.docx = { error: err.message };
  }
}

console.log(JSON.stringify(out, null, 1));
