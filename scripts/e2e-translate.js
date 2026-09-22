'use strict';

/**
 * E2E 翻译测试驱动（Electron CLI）。
 *
 * 完整跑真实软件管线：MinerU 解析 → 分块 → LLM 翻译（真实缓存）→
 * 四格式导出 → PDF 打印 → registry/library 登记。
 *
 * 用法:
 *   electron scripts/e2e-translate.js "<PDF>" --model=deepseek-flash \
 *     --config=dist/config/settings.json --layout=generic --content=mono \
 *     --formats=pdf,docx,md,html --library=test-out/e2e/<目录> [--force]
 *
 * 说明:
 *   - --config 只决定翻译模型与 Key（GLM 用 dist 配置，DeepSeek 用项目配置）
 *   - 解析 Token 一律取项目 config/settings.json（MinerU 云端）
 *   - 翻译缓存使用真实 cache/ 目录（复跑同篇应命中缓存，验证缓存功能）
 *   - 结束时输出 JSON 结果 + 产物检查（公式/图片/表格/双语标记）
 */
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);

try {
  app.setPath('userData', path.join(process.env.APPDATA || os.tmpdir(), 'paper-translator'));
} catch {
  /* 保持默认 */
}
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

// 关键：PDF 打印的隐藏窗口销毁后，Electron 默认行为是退出进程（window-all-closed → quit），
// 会让登记/快照/汇总来不及落盘。与 main.js 相同，注册空 handler 阻止默认退出，由脚本自行控制退出。
app.on('window-all-closed', () => { /* 由脚本末尾 app.exit 控制 */ });

function arg(name, def) {
  const hit = ARGV.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

/* ---------------------------- 产物质量检查 ---------------------------- */

function inspectOutputs(outDir, { content }) {
  const report = { outDir, files: {} };
  if (!outDir || !fs.existsSync(outDir)) return report;
  const names = fs.readdirSync(outDir);
  const read = (ext) => {
    const hit = names.find((n) => n.toLowerCase().endsWith(ext));
    return hit ? fs.readFileSync(path.join(outDir, hit)) : null;
  };

  const md = read('.md');
  if (md) {
    const text = md.toString('utf8');
    report.files.md = {
      bytes: md.length,
      blockMath: Math.floor((text.match(/\$\$/g) || []).length / 2),
      images: (text.match(/!\[[^\]]*\]\(/g) || []).length,
      mdTableRows: (text.match(/^\|/gm) || []).length,
      htmlTables: (text.match(/<table\b/gi) || []).length,
      bilingualMarks: (text.match(/> \*\*\[译\]\*\*/g) || []).length,
      cjkChars: (text.match(/[\u4e00-\u9fff]/g) || []).length,
      latinWords: (text.match(/[A-Za-z]{2,}/g) || []).length
    };
    if (content === 'bilingual') {
      // 双语对照：正文应同时含成段英文原文与中文译文
      report.files.md.hasEnglishParagraph = /[A-Za-z][A-Za-z ,.'()]{120,}/.test(
        text.replace(/> \*\*\[译\]\*\*/g, '')
      );
    }
  }

  const html = read('.html');
  if (html) {
    const text = html.toString('utf8');
    report.files.html = {
      bytes: html.length,
      katexSpans: (text.match(/class="katex/g) || []).length,
      dataImages: (text.match(/src="data:image/g) || []).length,
      tables: (text.match(/<table\b/g) || []).length,
      csp: /Content-Security-Policy/.test(text),
      // faithful 版式的紧凑 CSS 标记
      layoutFaithful: /max-width:\s*760px/.test(text),
      layoutGeneric: /max-width:\s*820px/.test(text)
    };
  }

  const pdf = read('.pdf');
  if (pdf) {
    report.files.pdf = {
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
      const media = entries.filter((e) => e.name.startsWith('word/media/') && e.data.length).length;
      report.files.docx = {
        bytes: docx.length,
        oMath: (xml.match(/<m:oMath[> ]/g) || []).length,
        images: (xml.match(/<a:blip /g) || []).length,
        mediaFiles: media,
        tables: (xml.match(/<w:tbl>/g) || []).length,
        cjkChars: (xml.match(/[\u4e00-\u9fff]/g) || []).length,
        hasEnglishParagraph: /[A-Za-z][A-Za-z ,.'()]{120,}/.test(xml)
      };
    } catch (err) {
      report.files.docx = { error: err.message };
    }
  }
  return report;
}

/* ------------------------------- 主流程 ------------------------------- */

app.whenReady().then(async () => {
  const summary = { ok: false };
  try {
    // 数据隔离：registry / cache / 译文库全部进 --data 目录（默认 test-out/e2e/data）。
    // 复跑同一 --data 即可验证缓存命中、去重跳过与 0-Token 补出，且不污染真实数据
    // （selftest 等脚本会覆写真实 config/translated.json，必须隔离）。
    const dataDir = path.resolve(ROOT, arg('data', path.join('test-out', 'e2e', 'data')));
    process.env.PPTOR_DATA_DIR = dataDir;
    process.argv.push('--smoke'); // 仅让 paths.js 启用隔离根；本脚本不经过 main.js，不会触发自检流程

    const { run } = require(path.join(ROOT, 'src/main/core/pipeline'));
    const translator = require(path.join(ROOT, 'src/main/core/translator'));
    const { printHtmlToPdf } = require(path.join(ROOT, 'src/main/pet/pdf-print'));
    const { cacheDir, dataFile } = require(path.join(ROOT, 'src/main/paths'));

    const pdf = ARGV.find((a) => !a.startsWith('--'));
    if (!pdf || !fs.existsSync(pdf)) {
      console.error('用法: electron scripts/e2e-translate.js "<PDF>" [--model=.. --config=.. --layout=.. --content=.. --formats=.. --library=..] [--force]');
      app.exit(2);
      return;
    }

    const projectCfgFile = path.join(ROOT, 'config', 'settings.json');
    const projectCfg = JSON.parse(fs.readFileSync(projectCfgFile, 'utf8'));
    const cfgFile = path.resolve(ROOT, arg('config', path.join(ROOT, 'dist', 'config', 'settings.json')));
    const modelCfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));

    const dec = (enc) => {
      try {
        return enc ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : '';
      } catch {
        return '';
      }
    };

    // 翻译模型来自 --config（GLM=dist / DeepSeek=项目），解析 Token 一律取项目配置
    const config = {
      parser: { ...projectCfg.parser },
      translate: { ...modelCfg.translate },
      output: { ...projectCfg.output, ...(modelCfg.output || {}) }
    };
    if (!config.translate.apiKey && config.translate.apiKeyEnc) {
      config.translate.apiKey = dec(config.translate.apiKeyEnc);
    }
    if (!config.parser.mineruToken && projectCfg.parser.mineruTokenEnc) {
      config.parser.mineruToken = dec(projectCfg.parser.mineruTokenEnc);
    }
    if (arg('model')) config.translate.model = arg('model');
    if (arg('layout')) config.output.layout = arg('layout');
    if (arg('content')) config.output.content = arg('content');
    if (arg('formats')) {
      config.output.formats = arg('formats').split(',').map((s) => s.trim()).filter(Boolean);
    }
    config.output.libraryDir = path.resolve(ROOT, arg('library', config.output.libraryDir || 'translated'));
    const force = ARGV.includes('--force');

    if (!config.translate.apiKey) {
      console.error('E2E 失败: 无可用 API Key（' + cfgFile + '）');
      app.exit(2);
      return;
    }

    // 真实缓存 + 术语表（验证软件真实结构；复跑同篇应命中缓存）
    await translator.initCache(cacheDir());
    translator.initGlossary(dataFile('glossary.txt'));

    summary.run = {
      paper: path.basename(pdf),
      model: config.translate.model,
      provider: /bigmodel/i.test(config.translate.baseUrl || '') ? 'zhipu' : /deepseek/i.test(config.translate.baseUrl || '') ? 'deepseek' : (config.translate.provider || 'custom'),
      layout: config.output.layout,
      content: config.output.content,
      formats: config.output.formats,
      library: config.output.libraryDir,
      force
    };

    const progressLog = [];
    const t0 = Date.now();
    const result = await run({
      files: [pdf],
      config,
      force,
      printPdf: (html, pdfPath, opts) => printHtmlToPdf({ html, pdfPath, ...opts }),
      onProgress: (e) => {
        if (e && e.message) progressLog.push(e.message);
      },
      // 测试环境自动确认（非英文文献不弹窗）
      onBeforeTranslate: async () => true
    });

    summary.elapsedMs = Date.now() - t0;
    summary.ok = result.ok;
    summary.succeeded = result.succeeded;
    summary.skipped = result.skipped;
    summary.failed = result.failed;
    summary.failures = result.failures;
    summary.cacheHitMsg = progressLog.filter((m) => /命中缓存/.test(m));
    summary.skipMsg = progressLog.filter((m) => /跳过/.test(m));
    summary.reExportMsg = progressLog.filter((m) => /免重翻|0\s*Token/i.test(m));

    const done = (result.results || []).filter((r) => !r.skipped);
    summary.outputs = done.map((r) => ({
      title: r.title,
      outDir: r.outDir,
      isReExport: !!r.isReExport,
      reExportFormats: r.reExportFormats || [],
      files: (r.files || []).map((f) => path.basename(f.path)),
      stats: r.stats
    }));

    // 产物检查（每个输出目录）
    summary.inspect = done.map((r) => inspectOutputs(r.outDir, { content: config.output.content }));
    // 跳过/补出的记录没有新产物，不重复检查

    // 汇总双保险：stderr（stdout 大 JSON 会被作业宿主吞掉）+ 隔离区内落盘
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'e2e-summary.json'), JSON.stringify(summary, null, 1), 'utf8');
    } catch (err) {
      console.error('E2E 汇总写盘失败: ' + err.message);
    }
    console.error('E2E-RESULT ' + JSON.stringify(summary));
    app.exit(result.ok ? 0 : 1);
  } catch (err) {
    summary.error = (err && err.stack) || String(err);
    console.error('E2E-RESULT ' + JSON.stringify(summary));
    app.exit(1);
  }
});
