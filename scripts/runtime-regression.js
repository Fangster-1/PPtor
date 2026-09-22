'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const runtimeFiles = [
  'src/main/main.js',
  'src/main/ipc/index.js',
  'src/main/ipc/broadcast.js',
  'src/main/ipc/ask-gateway.js',
  'src/main/ipc/job-manager.js',
  'src/main/ipc/qa-sessions.js',
  'src/main/ipc/doc-loader.js',
  'src/main/config.js',
  'src/main/menu.js',
  'src/main/preload.js',
  'src/main/chat/window.js',
  'src/main/assets/tray-dot.js',
  'src/main/pet/window.js',
  'src/main/core/pipeline.js',
  'src/main/core/library.js',
  'src/main/core/registry.js',
  'src/main/core/bundles.js',
  'src/main/core/extract.js',
  'src/main/core/errors.js',
  'src/main/core/llm-client.js',
  'src/main/core/translator.js',
  'src/main/core/parser.js',
  'src/main/core/async.js',
  'src/main/core/context.js',
  'src/main/core/qa.js',
  'src/main/paths.js'
];

function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

for (const file of runtimeFiles) {
  check(`syntax ${file}`, () => execFileSync(process.execPath, ['--check', path.join(projectRoot, file)], { stdio: 'pipe' }));
}

const pipelineSource = fs.readFileSync(path.join(projectRoot, 'src/main/core/pipeline.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(projectRoot, 'src/main/main.js'), 'utf8');
const ipcSource = fs.readFileSync(path.join(projectRoot, 'src/main/ipc/index.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(projectRoot, 'src/main/preload.js'), 'utf8');
check('connectivity starts only after renderer-ready handshake and shares the main status source', () => {
  assert.match(mainSource, /const startConnectivityChecks/);
  assert.match(mainSource, /setTimeout\(startConnectivityChecks, 8000\)/);
  assert.match(ipcSource, /connectivity:rendererReady/);
  assert.match(preloadSource, /connectivityReady/);
  assert.match(mainSource, /runCheck: \(\) => checkConnectivity\(getConfig\(\)\.translate\)/);
  // 连通性状态机工厂化后，防旧请求覆盖新状态的序号守卫在 tracker 闭包内
  assert.match(mainSource, /createConnectivityTracker/);
  assert.match(mainSource, /myId !== requestId/);
  assert.match(mainSource, /currentRequestId/);
  assert.match(mainSource, /getConnectivityStatus/);
  assert.match(ipcSource, /testModelConnectivity\(\{ force: true \}\)/);
  assert.match(mainSource, /testModelConnectivity: \(options\) => controller\.testModelConnectivity\(options\)/);
  assert.match(mainSource, /getConnectivityStatus: \(\) => controller\.getConnectivityStatus\(\)/);
});
check('pipeline guards missing PDF output', () => {
  assert.match(pipelineSource, /PDF 导出未准备好打印内容/);
  assert.match(pipelineSource, /PDF 导出未生成文件/);
});
check('pipeline has atomic staging commit (flat library output)', () => {
  assert.match(pipelineSource, /pptor-\$\{process\.pid\}/);
  assert.match(pipelineSource, /commitStagedFiles/);
  // 平铺输出：暂存目录里的产物逐个原子 rename 到译文库根目录，不再建「标题」子目录
  assert.match(pipelineSource, /path\.join\(libraryDir, path\.basename\(file\.path\)\)/);
  assert.doesNotMatch(pipelineSource, /path\.join\(libraryDir, baseName\)\s*;?\s*\/\/ 子目录/);
});
check('pipeline does not copy source PDF into output', () => {
  assert.doesNotMatch(pipelineSource, /copyFile\(pdfPath/);
});
check('pipeline separates indeterminate parse from exact translation progress', () => {
  const { makeReporter } = require(path.join(projectRoot, 'src/main/core/pipeline.js'));
  const events = [];
  const report = makeReporter((event) => events.push(event), { index: 0, total: 1, fileName: 'paper.pdf' });
  report({ stage: 'parse', message: 'MinerU running' });
  report({ stage: 'translate', message: '1/2', percent: 50 });
  assert.equal(events[0].phasePercent, null);
  assert.equal(events[0].phaseIndeterminate, true);
  assert.equal(events[1].phasePercent, 50);
  assert.equal(events[1].phaseIndeterminate, false);
  assert.ok(events[1].percent > events[0].percent);
});
check('pipeline reports preflight record checking with a deadline', () => {
  assert.match(pipelineSource, /stage: 'prepare', percent: 50, message: '正在检查翻译记录/);
  assert.match(pipelineSource, /读取文件「\$\{fileName\}」的翻译记录/);
});
check('library exposes an asynchronous match path for dragged files', () => {
  const library = require(path.join(projectRoot, 'src/main/core/library.js'));
  assert.equal(typeof library.matchAsync, 'function');
});

(async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pptor-runtime-'));
  try {
    await checkAsync('preflight deadline stops a stalled operation', async () => {
      const { withDeadline } = require(path.join(projectRoot, 'src/main/core/async.js'));
      await assert.rejects(
        withDeadline(() => new Promise(() => {}), { timeoutMs: 25, label: '测试文件读取' }),
        /测试文件读取超时/
      );
    });

    await checkAsync('preflight deadline responds to cancellation', async () => {
      const { withDeadline } = require(path.join(projectRoot, 'src/main/core/async.js'));
      const handlers = new Set();
      const signal = {
        cancelled: false,
        addCancelHandler(handler) {
          handlers.add(handler);
          return () => handlers.delete(handler);
        },
        cancel() {
          this.cancelled = true;
          for (const handler of [...handlers]) handler();
        }
      };
      const pending = withDeadline(() => new Promise(() => {}), {
        timeoutMs: 1000,
        signal,
        label: '测试文件读取'
      });
      setTimeout(() => signal.cancel(), 25);
      await assert.rejects(pending, /已取消/);
    });

    const library = require(path.join(projectRoot, 'src/main/core/library.js'));
    const root = path.join(temp, 'library');
    const work = path.join(root, '中文标题');
    await fsp.mkdir(work, { recursive: true });
    // 模拟 PDF-only 译文库：问答语料仍应能通过登记的二进制产物恢复。
    const pdf = path.join(work, '中文标题.pdf');
    await fsp.writeFile(pdf, Buffer.from('%PDF-1.7\ntranslated'));
    const src = path.join(temp, 'source.pdf');
    await fsp.writeFile(src, 'pdf', 'utf8');

    check('library writes internal index', () => {
      const record = library.registerWork(root, {
        title: '中文标题',
        dirName: '中文标题',
        source: { path: src, name: 'source.pdf' },
        files: [{ path: pdf, name: '中文标题.pdf' }],
        qaMarkdown: '# 译文\n\n![图](data:image/png;base64,QUJDRA==)\n\n正文'
      });
      assert.ok(record.outputs.length === 1);
      assert.equal(fs.existsSync(path.join(root, '_index.json')), false);
      assert.equal(library.match(root, pdf).via, 'fingerprint');
      assert.match(library.readQa(root, record), /\[内嵌图片\]/);
      assert.doesNotMatch(library.readQa(root, record), /data:image/);
    });

    check('smoke isolation path is outside project output', () => {
      const smokePath = path.join(os.tmpdir(), 'pptor-smoke', String(process.pid));
      const projectPrefix = `${path.resolve(projectRoot).toLowerCase()}${path.sep}`;
      assert.equal(path.resolve(smokePath).toLowerCase().startsWith(projectPrefix), false);
    });

    await checkAsync('pipeline removes failed PDF staging directory', async () => {
      const Module = require('node:module');
      const pipelinePath = path.join(projectRoot, 'src/main/core/pipeline.js');
      const originalLoad = Module._load;
      const sourcePdf = path.join(temp, 'source.pdf');
      await fsp.writeFile(sourcePdf, 'pdf', 'utf8');
      const makeStubs = () => ({
        './parser': { parse: async () => ({ markdown: '# source', images: [], meta: {} }) },
        './chunker': {
          splitMarkdown: () => [{ id: 0, content: 'Text', trailing: '', translatable: true }],
          reassemble: () => '# 译文'
        },
        './translator': { translateSegments: async () => new Map([[0, '译文']]), flushCache: async () => {} },
        './exporter': {
          exportResults: async ({ outDir, baseName, pendingPdf }) => {
            await fsp.mkdir(outDir, { recursive: true });
            const pdfPath = path.join(outDir, `${baseName}.pdf`);
            pendingPdf.html = '<html><body>译文</body></html>';
            pendingPdf.path = pdfPath;
            return { outDir, translatedMarkdown: '# 译文', files: [{ path: pdfPath, pending: true }] };
          }
        },
        './text': {
          detectEnglishPaper: () => ({ isEnglish: true, cjkRatio: 0, reason: '' }),
          extractTitle: () => '标题',
          uniqueDirName: () => '标题',
          uniqueBaseName: () => '标题'
        },
        './registry': { markDone: async () => {}, lookup: async () => ({ translated: false }) },
        './library': { registerWork: () => {} }
      });
      Module._load = function (request, parent, isMain) {
        if (parent && parent.filename === pipelinePath) {
          const stubs = makeStubs();
          if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
        }
        return originalLoad.call(this, request, parent, isMain);
      };
      delete require.cache[require.resolve(pipelinePath)];
      const { runOne } = require(pipelinePath);
      const config = {
        parser: { mode: 'cloud' },
        translate: { chunkTokens: 1200 },
        output: { libraryDir: path.join(temp, 'failed-lib'), formats: ['pdf'], layout: 'generic', content: 'mono' }
      };
      try {
        await assert.rejects(
          runOne({ pdfPath: sourcePdf, config, report: () => {}, signal: { cancelled: false }, printPdf: async () => {} }),
          /PDF 导出未生成文件/
        );
        assert.deepEqual(await fsp.readdir(config.output.libraryDir), []);
      } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve(pipelinePath)];
      }
    });

    await checkAsync('pipeline cancels before atomic commit', async () => {
      const Module = require('node:module');
      const pipelinePath = path.join(projectRoot, 'src/main/core/pipeline.js');
      const originalLoad = Module._load;
      const sourcePdf = path.join(temp, 'source-cancel.pdf');
      await fsp.writeFile(sourcePdf, 'pdf', 'utf8');
      const config = {
        parser: { mode: 'cloud' },
        translate: { chunkTokens: 1200 },
        output: { libraryDir: path.join(temp, 'cancel-lib'), formats: ['pdf'], layout: 'generic', content: 'mono' }
      };
      Module._load = function (request, parent, isMain) {
        if (parent && parent.filename === pipelinePath) {
          if (request === './parser') return { parse: async () => ({ markdown: '# source', images: [], meta: {} }) };
          if (request === './chunker') return { splitMarkdown: () => [{ id: 0, content: 'Text', trailing: '', translatable: true }], reassemble: () => '# 译文' };
          if (request === './translator') return { translateSegments: async () => new Map([[0, '译文']]), flushCache: async () => {} };
          if (request === './exporter') return { exportResults: async ({ outDir, baseName, pendingPdf }) => {
            await fsp.mkdir(outDir, { recursive: true });
            pendingPdf.html = '<html></html>';
            pendingPdf.path = path.join(outDir, `${baseName}.pdf`);
            return { files: [{ path: pendingPdf.path, pending: true }], outDir, translatedMarkdown: '# 译文' };
          } };
          if (request === './text') return { detectEnglishPaper: () => ({ isEnglish: true, cjkRatio: 0 }), extractTitle: () => '标题', uniqueDirName: () => '标题', uniqueBaseName: () => '标题' };
          if (request === './registry') return { markDone: async () => {}, lookup: async () => ({ translated: false }) };
          if (request === './library') return { registerWork: () => {} };
        }
        return originalLoad.call(this, request, parent, isMain);
      };
      delete require.cache[require.resolve(pipelinePath)];
      const { runOne } = require(pipelinePath);
      const signal = { cancelled: false };
      try {
        await assert.rejects(
          runOne({
            pdfPath: sourcePdf,
            config,
            report: () => {},
            signal,
            printPdf: async (_html, pdfPath) => {
              await fsp.writeFile(pdfPath, 'pdf', 'utf8');
              signal.cancelled = true;
            }
          }),
          /已取消/
        );
        assert.deepEqual(await fsp.readdir(config.output.libraryDir), []);
      } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve(pipelinePath)];
      }
    });

    await checkAsync('pipeline commits a complete paper into one child directory', async () => {
      const Module = require('node:module');
      const pipelinePath = path.join(projectRoot, 'src/main/core/pipeline.js');
      const originalLoad = Module._load;
      const sourcePdf = path.join(temp, 'source-complete.pdf');
      await fsp.writeFile(sourcePdf, 'pdf', 'utf8');
      Module._load = function (request, parent, isMain) {
        if (parent && parent.filename === pipelinePath) {
          if (request === './parser') return { parse: async () => ({ markdown: '# source', images: [], meta: {} }) };
          if (request === './chunker') return {
            splitMarkdown: () => [{ id: 0, content: 'Text', trailing: '', translatable: true }],
            reassemble: () => '# 中文标题\n\n译文正文'
          };
          if (request === './translator') return { translateSegments: async () => new Map([[0, '译文正文']]), flushCache: async () => {} };
          if (request === './exporter') return { exportResults: async ({ outDir, baseName }) => {
            await fsp.mkdir(outDir, { recursive: true });
            const md = path.join(outDir, `${baseName}.md`);
            const html = path.join(outDir, `${baseName}.html`);
            await fsp.writeFile(md, '# 中文标题\n\n译文正文', 'utf8');
            await fsp.writeFile(html, '<h1>中文标题</h1>', 'utf8');
            return { files: [{ path: md }, { path: html }], embeddedMarkdown: '# 中文标题\n\n译文正文' };
          } };
          if (request === './text') return { detectEnglishPaper: () => ({ isEnglish: true, cjkRatio: 0 }), extractTitle: () => '中文标题', uniqueBaseName: () => '中文标题' };
          if (request === './registry') return {
            lookup: async () => ({ translated: false }), markDone: async () => {}, fingerprint: async () => ({ key: 'complete' }), saveBundle: async () => {}
          };
          if (request === './library') return { registerWork: () => {} };
        }
        return originalLoad.call(this, request, parent, isMain);
      };
      delete require.cache[require.resolve(pipelinePath)];
      const { runOne } = require(pipelinePath);
      const libraryDir = path.join(temp, 'complete-lib');
      try {
        const result = await runOne({
          pdfPath: sourcePdf,
          config: { parser: {}, translate: { chunkTokens: 1200, model: 'test', targetLang: 'zh' }, output: { libraryDir, formats: ['md', 'html'], layout: 'generic', content: 'mono' } },
          report: () => {}, signal: { cancelled: false }
        });
        // 平铺输出：产物直接落在译文库根目录，不再建「中文标题」子文件夹
        assert.equal(result.outDir, libraryDir);
        assert.deepEqual((await fsp.readdir(libraryDir)).sort(), ['中文标题.html', '中文标题.md']);
        assert.ok(result.files.every((file) => path.dirname(file.path) === libraryDir));
      } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve(pipelinePath)];
      }
    });

    await checkAsync('config normalizes mono/docx formats', () => {
      const config = require(path.join(projectRoot, 'src/main/config.js'));
      assert.deepEqual(config.normalizeFormats(['bilingual', 'word', 'md', 'md']), ['docx', 'md']);
      assert.equal(config.deepMerge(config.DEFAULTS, { output: { content: 'bilingual' } }).output.content, 'bilingual');
    });

    await checkAsync('config migrates removed siliconflow provider to custom without losing the active key', async () => {
      const isolated = path.join(temp, 'config-siliconflow-migration');
      const configDir = path.join(isolated, 'config');
      const file = path.join(configDir, 'settings.json');
      await fsp.mkdir(configDir, { recursive: true });
      await fsp.writeFile(file, JSON.stringify({
        translate: {
          provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct',
          apiKey: 'legacy-key', providerKeys: { siliconflow: 'legacy-key', custom: 'stale-key' }
        },
        parser: { mode: 'cloud' }, output: { content: 'mono', formats: ['pdf'] }
      }), 'utf8');
      const source = "const c=require('./src/main/config');c.initStore();process.stdout.write(JSON.stringify(c.getConfig().translate));";
      const raw = execFileSync(process.execPath, ['-e', source, '--', '--smoke'], {
        cwd: projectRoot, env: { ...process.env, PPTOR_DATA_DIR: isolated }, encoding: 'utf8'
      });
      const translate = JSON.parse(raw);
      assert.equal(translate.provider, 'custom');
      assert.equal(translate.apiKey, 'legacy-key');
      assert.equal(translate.providerKeys.custom, 'legacy-key');
      assert.equal(Object.hasOwn(translate.providerKeys, 'siliconflow'), false);
      const persisted = JSON.parse(await fsp.readFile(file, 'utf8'));
      assert.equal(Object.hasOwn(persisted.translate.providerKeys || {}, 'siliconflow'), false);
    });

    await checkAsync('config save normalizes an isolated smoke store', async () => {
      const isolated = path.join(temp, 'config-smoke');
      const source = [
        "const c=require('./src/main/config');",
        'c.initStore();',
        "const r=c.saveConfig({output:{content:'bilingual',formats:['word']}});",
        "process.stdout.write(JSON.stringify({content:r.output.content,formats:r.output.formats}));"
      ].join('');
      const raw = execFileSync(process.execPath, ['-e', source, '--', '--smoke'], {
        cwd: projectRoot,
        env: { ...process.env, PPTOR_DATA_DIR: isolated },
        encoding: 'utf8'
      });
      assert.deepEqual(JSON.parse(raw), { content: 'bilingual', formats: ['docx'] });
      assert.equal(fs.existsSync(path.join(projectRoot, 'config', 'settings.json')), true);
    });

    await checkAsync('config init avoids an unnecessary startup write', async () => {
      const isolated = path.join(temp, 'config-noop');
      const configDir = path.join(isolated, 'config');
      await fsp.mkdir(configDir, { recursive: true });
      const file = path.join(configDir, 'settings.json');
      const content = JSON.stringify({
        translate: { targetLang: 'zh', apiKey: '', apiKeyEnc: 'already-encrypted' },
        parser: { mode: 'cloud', mineruTokenEnc: 'already-encrypted' },
        output: { content: 'mono', formats: ['pdf'] }
      });
      await fsp.writeFile(file, content, 'utf8');
      const before = await fsp.stat(file);
      await new Promise((resolve) => setTimeout(resolve, 20));
      execFileSync(process.execPath, ['-e', "require('./src/main/config').initStore()", '--', '--smoke'], {
        cwd: projectRoot,
        env: { ...process.env, PPTOR_DATA_DIR: isolated },
        stdio: 'pipe'
      });
      const after = await fsp.stat(file);
      assert.equal(after.mtimeMs, before.mtimeMs);
      assert.equal(await fsp.readFile(file, 'utf8'), content);
    });

    await checkAsync('translator aborts an in-flight request promptly', async () => {
      const translator = require(path.join(projectRoot, 'src/main/core/translator.js'));
      await translator.initCache(path.join(temp, 'cache'));
      const oldFetch = global.fetch;
      global.fetch = (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      const handlers = new Set();
      const signal = {
        cancelled: false,
        addCancelHandler(handler) {
          handlers.add(handler);
          return () => handlers.delete(handler);
        },
        cancel() {
          this.cancelled = true;
          for (const handler of [...handlers]) handler();
        }
      };
      try {
        const pending = translator.translateSegments(
          [{ id: 1, content: 'This request must be cancelled.', translatable: true }],
          { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', model: 'test', sourceLang: 'en', targetLang: 'zh', maxRetries: 0 },
          { signal }
        );
        setTimeout(() => signal.cancel(), 25);
        await assert.rejects(pending, /已取消/);
      } finally {
        global.fetch = oldFetch;
      }
    });

    await checkAsync('translator testApi resolves model aliases without a scope error', async () => {
      const translator = require(path.join(projectRoot, 'src/main/core/translator.js'));
      const oldFetch = global.fetch;
      let requestBody = null;
      global.fetch = async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: '快速的棕色狐狸。' } }] })
        };
      };
      try {
        const result = await translator.testApi({
          baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test', model: 'deepseek-flash'
        });
        assert.equal(result.ok, true);
        assert.equal(requestBody.model, 'deepseek-flash');
      } finally {
        global.fetch = oldFetch;
      }
    });

    await checkAsync('MinerU polling retries transient network failures and preserves their cause', async () => {
      const parser = require(path.join(projectRoot, 'src/main/core/parser.js'));
      const pdf = path.join(temp, 'network-retry.pdf');
      await fsp.writeFile(pdf, '%PDF-1.4 test');
      const oldFetch = global.fetch;
      const progress = [];
      let polls = 0;
      let uploads = 0;
      const json = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
      global.fetch = async (url, options = {}) => {
        if (String(url).includes('/file-urls/batch')) {
          return json({ code: 0, data: { batch_id: 'network-retry', file_urls: ['https://upload.test/paper.pdf'] } });
        }
        if (options.method === 'PUT') {
          uploads += 1;
          if (uploads <= 3) {
            const cause = Object.assign(new Error('upload socket closed'), { code: 'ECONNRESET' });
            throw Object.assign(new TypeError('fetch failed'), { cause });
          }
          return { ok: true, status: 200 };
        }
        if (String(url).includes('/extract-results/batch/')) {
          polls += 1;
          const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
          throw Object.assign(new TypeError('fetch failed'), { cause });
        }
        throw new Error(`unexpected URL ${url}`);
      };
      try {
        await assert.rejects(
          parser.parse({
            pdfPath: pdf,
            workDir: path.join(temp, 'network-retry-work'),
            parserConfig: { mode: 'cloud', mineruToken: 'test-token' },
            onProgress: (event) => progress.push(event),
            signal: { cancelled: false }
          }),
          /查询 MinerU 解析进度失败[\s\S]*ECONNRESET/
        );
        assert.equal(uploads, 4);
        assert.equal(polls, 4);
        assert.equal(progress.filter((event) => event.message.includes('上传连接暂时中断')).length, 3);
        assert.equal(progress.filter((event) => event.message.includes('网络连接暂时中断')).length, 3);
      } finally {
        global.fetch = oldFetch;
      }
    });

    await checkAsync('translator sends only text and strips embedded image payloads', async () => {
      const translator = require(path.join(projectRoot, 'src/main/core/translator.js'));
      await translator.initCache(path.join(temp, 'text-only-cache'));
      const oldFetch = global.fetch;
      let request;
      global.fetch = async (_url, options) => {
        request = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: '译文 [[PPTOR_IMAGE_0001]]' } }] })
        };
      };
      try {
        const dataUri = 'data:image/png;base64,' + 'A'.repeat(4096);
        const result = await translator.translateSegments(
          [{ id: 2, content: `Figure ![sample](${dataUri})`, translatable: true }],
          { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test', model: 'deepseek-flash', sourceLang: 'en', targetLang: 'zh', thinking: 'off', maxRetries: 0 },
          { signal: { cancelled: false } }
        );
        const user = request.messages.find((message) => message.role === 'user');
        assert.equal(typeof user.content, 'string');
        assert.doesNotMatch(user.content, /data:image|AAAA/);
        assert.match(user.content, /PPTOR_IMAGE_0001/);
        assert.deepEqual(request.thinking, { type: 'disabled' });
        assert.equal(request.tool_choice, 'none');
        assert.ok(request.max_tokens >= 768 && request.max_tokens <= 4096);
        assert.match(result.get(2), new RegExp(dataUri));
      } finally {
        global.fetch = oldFetch;
      }
    });

    await checkAsync('translator cache stays under the byte budget', async () => {
      const translator = require(path.join(projectRoot, 'src/main/core/translator.js'));
      await translator.initCache(path.join(temp, 'bounded-cache'));
      const oldFetch = global.fetch;
      const largeTranslation = 'x'.repeat(390000);
      global.fetch = async (_url, _options) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: largeTranslation } }] })
      });
      try {
        const segments = Array.from({ length: 100 }, (_, id) => ({
          id,
          content: `segment ${id}`,
          translatable: true
        }));
        const result = await translator.translateSegments(
          segments,
          { baseUrl: 'http://cache.test/v1', apiKey: 'test', model: 'test', sourceLang: 'en', targetLang: 'zh', concurrency: 10, maxRetries: 0 },
          { signal: { cancelled: false } }
        );
        const stats = translator.cacheStats();
        assert.equal(result.size, 100);
        assert.ok(stats.bytes <= stats.maxBytes, `cache bytes ${stats.bytes} exceed ${stats.maxBytes}`);
        assert.ok(stats.entries < 100, 'large entries should be LRU-evicted by the byte budget');
      } finally {
        global.fetch = oldFetch;
      }
    });
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }

  if (process.exitCode) process.exit(process.exitCode);
  console.log('Runtime regression passed.');
})().catch((err) => {
  console.error(`FATAL ${err.stack || err.message}`);
  process.exitCode = 1;
});
