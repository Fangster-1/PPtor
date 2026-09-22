'use strict';

/**
 * 命令行翻译测试

 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const { parse } = require(path.join(ROOT, 'src/main/core/parser'));
const { splitMarkdown, reassemble } = require(path.join(ROOT, 'src/main/core/chunker'));
const translator = require(path.join(ROOT, 'src/main/core/translator'));

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

/* ---------------------------- 质量检查 ---------------------------- */


const KNOWN_BAD = [];

function inspectQuality(original, translated) {
  const count = (re) => (translated.match(re) || []).length;
  const issues = [];

  // 1. 缩写臆测（可根据术语表扩展）
  for (const [bad, why] of KNOWN_BAD) {
    const n = count(new RegExp(bad, 'g'));
    if (n) issues.push(`缩写臆测 ×${n}：${why}`);
  }

  // 2. 引用被汉化
  const denden = count(/等人/g);
  const yearHan = count(/[0-9]{4}\s*年/g);
  const etAl = count(/et al\./g);
  if (denden) issues.push(`et al. 被译为「等人」×${denden}`);
  if (etAl && denden) issues.push(`引用格式不一致：et al. 保留 ${etAl} 处，但「等人」${denden} 处`);

  // 3. 中英半汉化
  const half = translated.match(/[\u4e00-\u9fa5]{2,}\s+[A-Z][A-Za-z]{2,}/g) || [];
  if (half.length) issues.push(`疑似中英半汉化 ×${half.length}：${[...new Set(half)].slice(0, 3).join(' / ')}`);

  // 4. 公式被破坏
  const dollarBefore = (original.match(/\$/g) || []).length;
  const dollarAfter = (translated.match(/\$/g) || []).length;
  if (dollarAfter < dollarBefore * 0.9) {
    issues.push(`公式符号疑似丢失：原文 $ ${dollarBefore} 个 → 译文 $ ${dollarAfter} 个`);
  }

  // 5. 引用标记
  const citeBefore = (original.match(/\[[0-9,\s-]+\]/g) || []).length;
  const citeAfter = (translated.match(/\[[0-9,\s-]+\]/g) || []).length;
  if (citeBefore && citeAfter < citeBefore * 0.9) {
    issues.push(`引用标记疑似丢失：原文 ${citeBefore} 个 → 译文 ${citeAfter} 个`);
  }

  // 6. 残留英文长句
  const leftEnglish = (translated.match(/[A-Za-z][A-Za-z ,.'()]{80,}/g) || []).length;
  if (leftEnglish > 3) issues.push(`疑似未翻译的英文长句 ×${leftEnglish}`);

  return {
    issues,
    stats: {
      chars: translated.length,
      etAl,
      等人: denden,
      年份加年: yearHan,
      halfMixed: half.length
    }
  };
}

/* ------------------------------- 主流程 ------------------------------- */

async function main() {
  const pdf = process.argv[2];
  if (!pdf || pdf.startsWith('--') || !fs.existsSync(pdf)) {
    console.error('用法: node scripts/translate-test.js "<PDF路径>" [--model=xx] [--free]');
    process.exit(1);
  }

  const cfgFile = arg('config', path.join(ROOT, 'config', 'settings.json'));
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  } catch {
    console.error('读不到配置: ' + cfgFile);
    process.exit(1);
  }

  const api = { ...(cfg.translate || {}) };
  if (arg('model')) api.model = arg('model');
  if (arg('url')) api.baseUrl = arg('url');
  if (arg('key')) api.apiKey = arg('key');
  if (!api.apiKey) {
    console.error('配置里没有 API Key（' + cfgFile + '）\n可用 --key=<你的Key> 临时传入');
    process.exit(1);
  }

  const parserConfig = { ...(cfg.parser || {}) };

  const outDir = arg('out', path.join(ROOT, 'test-out'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-test-'));

  translator.initCache(work);
  translator.initGlossary(path.join(path.dirname(cfgFile), 'glossary.txt'));

  console.log('─'.repeat(58));
  console.log('论文: ' + path.basename(pdf));
  console.log('模型: ' + api.model + '  @ ' + api.baseUrl);
  console.log('解析: ' + (parserConfig.mode || 'cloud'));
  console.log('术语表: ' + (cfg.translate && cfg.translate.glossary ? '配置内联' : '') +
    (fs.existsSync(path.join(path.dirname(cfgFile), 'glossary.txt')) ? ' + glossary.txt' : ' (无文件)'));
  console.log('─'.repeat(58));

  const signal = { cancelled: false };
  const t0 = Date.now();

  // 1) 解析
  process.stdout.write('解析中…\n');
  const parsed = await parse({
    pdfPath: pdf,
    workDir: work,
    parserConfig,
    onProgress: (p) => {
      if (p && p.message) process.stdout.write('  ' + p.message + '\n');
    },
    signal
  });
  const original = parsed.markdown;
  console.log(`解析完成: ${original.length} 字符, 图片 ${parsed.meta.imageCount} 张, 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // 2) 分块
  const segments = splitMarkdown(original, { maxTokens: api.chunkTokens || 1200 });
  const targets = segments.filter((s) => s.translatable).length;
  console.log(`分块: 共 ${segments.length} 段，其中 ${targets} 段需翻译`);

  // 3) 翻译
  const t1 = Date.now();
  let lastMsg = '';
  const translations = await translator.translateSegments(segments, api, {
    signal,
    onProgress: (p) => {
      if (p && p.message && p.message !== lastMsg) {
        lastMsg = p.message;
        process.stdout.write('  ' + p.message + '\n');
      }
    }
  });
  const elapsed = ((Date.now() - t1) / 1000).toFixed(0);
  console.log(`翻译完成: ${translations.size} 段, 用时 ${elapsed}s`);

  // 4) 重组 + 落盘
  const merged = reassemble(segments, translations);
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(pdf, '.pdf');
  const mdPath = path.join(outDir, base + '.zh.md');
  fs.writeFileSync(mdPath, merged, 'utf8');

  // 图片一并拷出，方便预览
  const imgDir = path.join(outDir, 'images');
  if (parsed.meta.imageCount) {
    fs.mkdirSync(imgDir, { recursive: true });
    for (const img of parsed.images) fs.writeFileSync(path.join(imgDir, img.name), img.data);
  }

  console.log('译文: ' + mdPath);

  // 5) 质量检查
  if (!process.argv.includes('--no-qa')) {
    const q = inspectQuality(original, merged);
    console.log('\n质量检查');
    console.log(
      `  译文 ${q.stats.chars} 字符 | et al. 保留 ${q.stats.etAl} | 「等人」${q.stats.等人}` +
        ` | 年份加「年」${q.stats.年份加年} | 半汉化 ${q.stats.halfMixed}`
    );
    if (q.issues.length) {
      for (const it of q.issues) console.log('  ✗ ' + it);
    } else {
      console.log('  ✓ 未发现已知问题');
    }
  }

  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    /* 临时目录 */
  }
}

main().catch((err) => {
  console.error('\n失败: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
