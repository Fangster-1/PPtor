'use strict';


const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);

// Key 是 Chromium OSCrypt（"v10" 前缀）加密的，解密钥存在 userData/Local State。
// 打包版的 userData 是 %APPDATA%/paper-translator，必须指到同一目录才解得开。
// 回退用系统临时目录，避免把 Chromium 缓存写进项目。
try {
  app.setPath('userData', path.join(process.env.APPDATA || os.tmpdir(), 'paper-translator'));
} catch {
  /* 保持默认 */
}

// 无界面脚本：必须禁用硬件加速，否则 GPU 进程会崩（FATAL: GPU process isn't usable）
// 然后整个进程被带走，表现为「申请 MinerU 上传链接…」之后就没了
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

function arg(name, def) {
  const hit = ARGV.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

/* ---------------------------- 质量检查 ---------------------------- */

const KNOWN_BAD = [];

function inspectQuality(original, translated) {
  const count = (re) => (translated.match(re) || []).length;
  const issues = [];

  for (const [bad, why] of KNOWN_BAD) {
    const n = count(new RegExp(bad, 'g'));
    if (n) issues.push(`缩写臆测 ×${n}：${why}`);
  }

  const denden = count(/等人/g);
  const etAl = count(/et al\./g);
  if (denden) issues.push(`et al. 被译为「等人」×${denden}`);
  if (etAl && denden) issues.push(`引用格式不一致：et al. ${etAl} 处 vs「等人」${denden} 处`);

  // 注意排除年份区间「（2003–2020 年）」—— 这种加「年」是正确中文，不是误译。
  const yearInCite = (
    translated.match(/[（(][^（）()\n]{0,60}?(?<!\d{4}\s*[–—-]\s*)\d{4}\s*年[^（）()\n]{0,20}?[）)]/g) || []
  ).length;
  if (yearInCite > 2) issues.push(`引用年份被加「年」×${yearInCite}`);

  // 中英半汉化（不跨行；软件名/工具名保留英文是正常的）
  const SOFT = /^(Google|Python|R|Matlab|SPSS|Excel|Linux|Windows|Docker|CUDA)/i;
  const halfRaw = translated.match(/[\u4e00-\u9fa5]{2,} [A-Z][A-Za-z]{2,}/g) || [];
  const half = halfRaw.filter((s) => !SOFT.test(s.split(' ').pop()));
  if (half.length > 20) issues.push(`疑似中英半汉化 ×${half.length}（多为机构/人名/软件名，可忽略）`);

  const dBefore = (original.match(/\$/g) || []).length;
  const dAfter = (translated.match(/\$/g) || []).length;
  if (dBefore && dAfter < dBefore * 0.9) issues.push(`公式符号疑似丢失：$ ${dBefore} → ${dAfter}`);

  const cBefore = (original.match(/\[[0-9,\s-]+\]/g) || []).length;
  const cAfter = (translated.match(/\[[0-9,\s-]+\]/g) || []).length;
  if (cBefore && cAfter < cBefore * 0.9) issues.push(`引用标记疑似丢失：${cBefore} → ${cAfter}`);

  // 未翻译英文长句：参考文献区保留原文是正确行为，先切掉再统计
  const refCut = translated.search(/\n#+\s*(References|参考文献|Bibliography)/i);
  const bodyOnly = refCut > 0 ? translated.slice(0, refCut) : translated;
  const leftEn = (bodyOnly.match(/[A-Za-z][A-Za-z ,.'()]{80,}/g) || []).length;
  if (leftEn > 8) issues.push(`正文里疑似未翻译的英文长句 ×${leftEn}`);

  return { issues, stats: { chars: translated.length, etAl, 等人: denden, 引用年份加年: yearInCite, half: half.length } };
}

/* ------------------------------- 主流程 ------------------------------- */

app.whenReady().then(async () => {
  try {
    const { parse } = require(path.join(ROOT, 'src/main/core/parser'));
    const { splitMarkdown, reassemble } = require(path.join(ROOT, 'src/main/core/chunker'));
    const translator = require(path.join(ROOT, 'src/main/core/translator'));

    const pdf = ARGV.find((a) => !a.startsWith('--'));
    if (!pdf || !fs.existsSync(pdf)) {
      console.log('用法: electron scripts/translate-run.js "<PDF路径>" [--model=xx]');
      app.exit(1);
      return;
    }

    const cfgFile = arg('config', path.join(ROOT, 'dist', 'config', 'settings.json'));
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));

    const dec = (enc) => {
      if (!enc) return '';
      try {
        console.log('  safeStorage 可用: ' + safeStorage.isEncryptionAvailable());
        return safeStorage.decryptString(Buffer.from(enc, 'base64'));
      } catch (err) {
        console.log('  解密失败: ' + err.message);
        return '';
      }
    };

    const api = { ...(cfg.translate || {}) };
    if (!api.apiKey && cfg.translate && cfg.translate.apiKeyEnc) api.apiKey = dec(cfg.translate.apiKeyEnc);
    if (arg('model')) api.model = arg('model');
    if (arg('thinking')) api.thinking = arg('thinking'); // auto | off | on

    const parserConfig = { ...(cfg.parser || {}) };
    if (!parserConfig.mineruToken && cfg.parser && cfg.parser.mineruTokenEnc) {
      parserConfig.mineruToken = dec(cfg.parser.mineruTokenEnc);
    }
  
    if (!api.apiKey) {
      console.log('解密后仍无 API Key，无法测试');
      app.exit(1);
      return;
    }

    const outDir = arg('out', path.join(ROOT, 'test-out'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-run-'));

    translator.initCache(work);
    translator.initGlossary(path.join(path.dirname(cfgFile), 'glossary.txt'));

    console.log('─'.repeat(60));
    console.log('论文: ' + path.basename(pdf));
    console.log('模型: ' + api.model + '  @ ' + api.baseUrl);
    console.log('解析: ' + (parserConfig.mode || 'cloud') + (parserConfig.mineruToken ? '（有 Token）' : '（无 Token）'));
    console.log('Key : 已解密，长度 ' + api.apiKey.length);
    console.log('─'.repeat(60));

    const signal = { cancelled: false };
    const t0 = Date.now();

    const parsed = await parse({ pdfPath: pdf, workDir: work, parserConfig, onProgress: (p) => p && p.message && console.log('  [解析] ' + p.message), signal });
    console.log(`解析完成: ${parsed.markdown.length} 字符 / 图片 ${parsed.meta.imageCount} 张 / ${((Date.now() - t0) / 1000).toFixed(0)}s`);

    const segments = splitMarkdown(parsed.markdown, { maxTokens: api.chunkTokens || 1200 });
    console.log(`分块: ${segments.length} 段，需翻译 ${segments.filter((s) => s.translatable).length} 段`);

    const t1 = Date.now();
    let last = '';
    const translations = await translator.translateSegments(segments, api, {
      signal,
      onProgress: (p) => {
        if (p && p.message && p.message !== last) {
          last = p.message;
          console.log('  [翻译] ' + p.message);
        }
      }
    });
    console.log(`翻译完成: ${translations.size} 段 / ${((Date.now() - t1) / 1000).toFixed(0)}s`);

    const merged = reassemble(segments, translations);
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.basename(pdf, '.pdf');
    const mdPath = path.join(outDir, base + '.zh.md');
    fs.writeFileSync(mdPath, merged, 'utf8');
    const imgDir = path.join(outDir, 'images');
    if (parsed.images.length) {
      fs.mkdirSync(imgDir, { recursive: true });
      for (const img of parsed.images) fs.writeFileSync(path.join(imgDir, img.name), img.data);
    }
    console.log('译文: ' + mdPath);

    const q = inspectQuality(parsed.markdown, merged);
    console.log('\n质量检查');
    console.log(`  译文 ${q.stats.chars} 字符 | et al. 保留 ${q.stats.etAl} | 「等人」${q.stats.等人} | 引用年份加年 ${q.stats.引用年份加年} | 半汉化 ${q.stats.half}`);
    console.log(q.issues.length ? q.issues.map((x) => '  ✗ ' + x).join('\n') : '  ✓ 未发现已知问题');

    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    app.exit(0);
  } catch (err) {
    console.log('失败: ' + (err && err.message ? err.message : err));
    app.exit(1);
  }
});
