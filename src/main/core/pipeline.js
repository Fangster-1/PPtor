'use strict';

/**
 * 任务流水线：解析、分块、翻译、导出与归档
 *
 * 逐篇串行处理，进度按「篇内阶段 + 整体篇序」双维度上报。
 * 译文归档到翻译文档库的独立子目录中。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { parse } = require('./parser');
const { splitMarkdown, reassemble } = require('./chunker');
const translatorMod = require('./translator');
const { translateSegments, flushCache } = translatorMod;
const { exportResults, exportFromMarkdown } = require('./exporter');
const { detectEnglishPaper, extractTitle, uniqueBaseName } = require('./text');
const { rm: rmDir } = require('./fsx');
const { withDeadline } = require('./async');
const { CancelledError, isCancelled } = require('./errors');
const registry = require('./registry');
const library = require('./library');

/** 阶段 → 篇内进度区间 */
const STAGE_RANGE = {
  prepare: [0, 2],
  parse: [0, 32],
  lang: [32, 36],
  chunk: [36, 42],
  translate: [42, 84],
  export: [84, 92],
  print: [92, 96],
  archive: [96, 100]
};

function makeReporter(onProgress, { index, total, fileName }) {
  let lastStage = '';
  return ({ stage, message, percent, ...details }) => {
    const [lo, hi] = STAGE_RANGE[stage] || [0, 100];
    const hasPhasePercent = Number.isFinite(percent);
    // 解析阶段比例不确定时上报 null，由界面展示不确定进度条
    const phasePercent = hasPhasePercent ? Math.max(0, Math.min(100, percent)) : null;
    const inPaper = lo + ((phasePercent ?? 0) / 100) * (hi - lo);

    // 整体进度：已完成的篇 + 当前篇的进度
    const overall = Math.round(((index + inPaper / 100) / total) * 100);

    onProgress({
      stage,
      percent: Math.max(0, Math.min(100, overall)),
      phasePercent,
      phaseIndeterminate: phasePercent === null,
      phaseChanged: stage !== lastStage,
      inPaper: Math.round(inPaper),
      index,
      total,
      fileName,
      ...details,
      message: total > 1 ? `[${index + 1}/${total}] ${fileName} — ${message || ''}` : message
    });
    lastStage = stage;
  };
}

/** 临时目录清理失败不影响主流程 */
function safeRemove(dir) {
  return rmDir(dir).catch(() => {});
}

function isChildPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function moveToUniquePath(source, destinationDir) {
  await fs.promises.mkdir(destinationDir, { recursive: true });
  const parsed = path.parse(source);
  let candidate = path.join(destinationDir, path.basename(source));
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(destinationDir, `${parsed.name} (${index})${parsed.ext}`);
    index += 1;
  }
  await fs.promises.rename(source, candidate);
  return candidate;
}

/**
 * 强制重翻时先可恢复地转存旧产物（平铺文件或旧版子目录产物）。
 * 转存进 .trash，提交失败时按原路放回。
 */
async function stashPreviousOutputs({ libraryDir, existingRecord }) {
  const trashDir = path.join(libraryDir, '.trash', `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  const moved = [];
  const root = path.resolve(libraryDir);

  if (Array.isArray(existingRecord?.files)) {
    for (const file of existingRecord.files) {
      const source = file?.path ? path.resolve(file.path) : '';
      if (!source || source === root || !isChildPath(libraryDir, source) || !fs.existsSync(source)) continue;
      const target = await moveToUniquePath(source, trashDir);
      moved.push({ from: source, to: target });
    }
  }

  return async () => {
    for (const item of moved.reverse()) {
      if (!fs.existsSync(item.to) || fs.existsSync(item.from)) continue;
      await fs.promises.mkdir(path.dirname(item.from), { recursive: true });
      await fs.promises.rename(item.to, item.from);
    }
  };
}

/**
 * 平铺提交：把暂存目录里的产物逐个搬到译文库根目录。
 * 非 force 时 baseName 已保证唯一（uniqueBaseName 同时检查旧子目录名），
 * 不会覆盖任何文件；force 时先转存旧产物再落盘。
 * @returns {Array} 最终的文件清单（绝对路径）
 */
async function commitStagedFiles({ libraryDir, force, existingRecord, files }) {
  if (force) {
    const restore = await stashPreviousOutputs({ libraryDir, existingRecord });
    try {
      const out = [];
      for (const file of files) {
        if (!file.path) continue;
        const target = path.join(libraryDir, path.basename(file.path));
        await fs.promises.rename(file.path, target);
        out.push({ ...file, path: target });
      }
      return out;
    } catch (err) {
      await restore();
      throw err;
    }
  }
  const out = [];
  for (const file of files) {
    if (!file.path) continue;
    const target = path.join(libraryDir, path.basename(file.path));
    if (fs.existsSync(target)) {
      throw new Error(`输出文件已存在，已停止覆盖：${target}`);
    }
    await fs.promises.rename(file.path, target);
    out.push({ ...file, path: target });
  }
  return out;
}

/**
 * 跑单篇
 * @returns 成功 → 结果对象；被用户跳过 → { skipped:true, reason }
 */
async function runOne({ pdfPath, config, report, signal, printPdf, onBeforeTranslate, force = false }) {
  const sourceExt = path.extname(pdfPath).toLowerCase();
  const sourceName = path.basename(pdfPath, sourceExt);
  const workDir = path.join(
    os.tmpdir(),
    'pptor',
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  await fs.promises.mkdir(workDir, { recursive: true });
  let stagingDir = '';

  try {
    /* ---------- 1. 解析 ---------- */
    report({ stage: 'parse', percent: 0, message: '解析 PDF…' });
    const parsed = await parse({
      pdfPath,
      workDir,
      parserConfig: config.parser,
      onProgress: (e) => report({ ...e, percent: undefined }),
      signal
    });
    if (signal?.cancelled) throw new CancelledError();

    /* ---------- 2. 语种检测 ---------- */
    report({ stage: 'lang', percent: 0, message: '判断语种…' });
    const lang = detectEnglishPaper(parsed.markdown);
    report({
      stage: 'lang',
      percent: 100,
      message: lang.isEnglish ? '英文论文，开始翻译' : '疑似非英文文献'
    });

    if (!lang.isEnglish && typeof onBeforeTranslate === 'function') {
      const proceed = await onBeforeTranslate({
        fileName: path.basename(pdfPath),
        sourceName,
        reason: lang.reason,
        cjkRatio: lang.cjkRatio
      });
      if (!proceed) {
        return { name: path.basename(pdfPath), skipped: true, reason: '已跳过（非英文文献）' };
      }
    }
    if (signal?.cancelled) throw new CancelledError();

    /* ---------- 3. 分块 ---------- */
    report({ stage: 'chunk', percent: 40, message: '切分文档结构…' });
    const segments = splitMarkdown(parsed.markdown, {
      maxTokens: config.translate.chunkTokens || 1200
    });
    const translatable = segments.filter((s) => s.translatable).length;
    report({
      stage: 'chunk',
      percent: 100,
      message: `${segments.length} 段（${translatable} 段待翻译）`
    });

    /* ---------- 4. 翻译 ---------- */
    const translations = await translateSegments(segments, config.translate, {
      onProgress: (e) => report(e),
      signal
    });
    if (signal?.cancelled) throw new CancelledError();

    /* ---------- 5. 用译文里的中文标题给产物命名 ---------- */
    const rawTranslated = reassemble(segments, translations);
    // 不在重组后做正则二次改写：导出、快照、问答语料必须使用同一份模型译文。
    const translatedMarkdown = rawTranslated;
    const title = extractTitle(translatedMarkdown, sourceName);

    const libraryDir = (config.output.libraryDir || '').trim();
    if (!libraryDir) throw new Error('未配置翻译文档库路径');
    await fs.promises.mkdir(libraryDir, { recursive: true });

    let existingRecord = null;
    try {
      const hit = await registry.lookup(pdfPath);
      if (hit?.record) {
        existingRecord = hit.record;
      }
    } catch {
      /* ignore */
    }

    let baseName;
    if (force && existingRecord && existingRecord.baseName) {
      baseName = existingRecord.baseName;
    } else if (force) {
      baseName = title;
    } else {
      // 平铺输出：uniqueBaseName 同时检查库根下的同名文件与旧版同名子目录
      baseName = uniqueBaseName(libraryDir, title);
    }
    // 产物直接落在译文库根目录（平铺，不再建「标题名」子文件夹）；
    // 先写隐藏暂存目录，导出、打印、校验全部成功后才逐个原子提交。
    const outDir = libraryDir;
    stagingDir = path.join(
      libraryDir,
      `.${baseName}.pptor-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    );

    /* ---------- 6. 导出 ---------- */
    report({ stage: 'export', percent: 30, message: '生成产物…' });
    const pendingPdf = {};
    let { files, embeddedMarkdown } = await exportResults({
      outDir: stagingDir,
      baseName,
      segments,
      translations,
      images: parsed.images,
      outputConfig: config.output,
      pendingPdf,
      meta: {
        sourcePdf: path.resolve(pdfPath),
        sourceName,
        title,
        isEnglish: lang.isEnglish,
        cjkRatio: Number(lang.cjkRatio.toFixed(3)),
        parserMode: config.parser.mode,
        model: config.translate.model,
        targetLang: config.translate.targetLang,
        layout: config.output.layout,
        content: config.output.content
      }
    });
    if (signal?.cancelled) throw new CancelledError();

    /* ---------- 7. PDF 打印 ---------- */
    const formats = new Set(config.output.formats || ['pdf']);
    if (formats.has('pdf')) {
      if (!pendingPdf.html || !pendingPdf.path) {
        throw new Error('PDF 导出未准备好打印内容，已停止提交产物');
      }
      if (typeof printPdf !== 'function') {
        throw new Error('PDF 导出不可用：打印服务未连接');
      }
      report({ stage: 'print', percent: 0, message: '导出 PDF…' });
      await printPdf(pendingPdf.html, pendingPdf.path, {
        needsMath: pendingPdf.needsMath,
        signal
      });
      if (signal?.cancelled) throw new CancelledError();
      const real = files.find((f) => f.pending);
      if (!real || !fs.existsSync(pendingPdf.path)) {
        throw new Error('PDF 导出未生成文件，已停止提交产物');
      }
      delete real.pending;
      report({ stage: 'print', percent: 100, message: 'PDF 已生成' });
    }

    /* ---------- 8. 原子提交产物至译文库根目录（平铺） ---------- */
    report({ stage: 'archive', percent: 0, message: '提交译文产物…' });
    files = await commitStagedFiles({ libraryDir, force, existingRecord, files });

    /* ---------- 9. 登记（去重）与持久化成果快照（哈希压缩） ---------- */
    const formatsList = [...new Set(files.map((f) => path.extname(f.path).slice(1).toLowerCase()).filter(Boolean))];
    await registry.markDone(pdfPath, {
      outDir,
      title,
      baseName,
      formats: formatsList,
      files: files
        .filter((f) => f.path)
        .map((f) => ({
          path: f.path,
          name: path.basename(f.path),
          format: path.extname(f.path).slice(1).toLowerCase()
        })),
      model: config.translate.model,
      targetLang: config.translate.targetLang
    });

    try {
      const { key } = await registry.fingerprint(pdfPath);
      await registry.saveBundle(key, {
        title,
        baseName,
        sourceName,
        outDir,
        embeddedMarkdown,
        translatedMarkdown,
        formats: formatsList,
        files: files.filter((f) => f.path).map((f) => ({
          path: f.path,
          name: path.basename(f.path),
          format: path.extname(f.path).slice(1).toLowerCase()
        })),
        model: config.translate.model,
        targetLang: config.translate.targetLang,
        layout: config.output.layout || 'generic'
      });
    } catch (err) {
      console.warn('[pipeline] 成果快照持久化失败：', err.message);
    }

    /* ---------- 10. 登记到内部索引（供「拖回译文反查是哪篇」） ---------- */
    // 这一步失败不该让整篇翻译作废：产物已经落盘，索引缺失只影响反查
    try {
      library.registerWork(libraryDir, {
        title,
        dirName: '', // 平铺输出：产物直接在库根，无子目录
        source: { path: pdfPath, name: sourceName },
        files: files
          .filter((f) => f.path)
          .map((f) => ({ path: f.path, name: path.basename(f.path) })),
        model: config.translate.model,
        targetLang: config.translate.targetLang,
        qaMarkdown: translatedMarkdown
      });
    } catch (err) {
      console.warn('[pipeline] 译文库索引登记失败：', err.message);
    }

    report({ stage: 'archive', percent: 100, message: '完成' });

    return {
      name: path.basename(pdfPath),
      sourceName,
      title,
      outDir,
      files,
      isEnglish: lang.isEnglish,
      markdown: parsed.markdown,
      translatedMarkdown,
      stats: {
        segments: segments.length,
        translated: translations.size,
        images: parsed.images.length
      }
    };
  } finally {
    // 未提交：连同半成品一起清理；已提交：staging 只剩空壳，同样清掉
    if (stagingDir) await safeRemove(stagingDir);
    await safeRemove(workDir);
  }
}

/**
 * 极速免重翻补出新格式（0 Token 消耗）
 * 直接读取哈希压缩快照（或磁盘 .md），生成缺失的新格式产物
 */
async function reExportOne({ pdfPath, hit, missingFormats, config, report, signal, printPdf }) {
  const record = hit.record || {};
  const bundle = await registry.getBundle(hit.key, record);
  if (!bundle || !bundle.embeddedMarkdown) {
    throw new Error('未找到已翻译内容的快照数据');
  }

  const sourceExt = path.extname(pdfPath).toLowerCase();
  const sourceName = path.basename(pdfPath, sourceExt);
  const title = record.title || bundle.title || extractTitle(bundle.embeddedMarkdown, sourceName);
  const libraryDir = (config.output?.libraryDir || record.outDir || '').trim();
  if (!libraryDir) throw new Error('未配置翻译文档库路径');
  await fs.promises.mkdir(libraryDir, { recursive: true });

  const baseName = record.baseName || bundle.baseName || uniqueBaseName(libraryDir, title);
  // 平铺输出：新格式产物一律直接写入库根目录；旧版子目录产物原样保留不动。
  const outDir = libraryDir;
  const pendingPdf = {};
  const formatsSet = new Set(missingFormats);
  const fmtLabels = missingFormats.map((f) => (f === 'docx' ? 'Word' : f === 'md' ? 'Markdown' : f.toUpperCase())).join('、');

  // 先写隐藏暂存目录，生成和打印完成后原子移动
  const stagingDir = path.join(
    libraryDir,
    `.${baseName}.pptor-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  );
  await fs.promises.mkdir(stagingDir, { recursive: true });

  try {
    report({ stage: 'export', percent: 40, message: `正在极速导出 ${fmtLabels}（0 Token 消耗）…` });

    let { files: newFiles } = await exportFromMarkdown({
      outDir: stagingDir,
      baseName,
      embeddedMarkdown: bundle.embeddedMarkdown,
      formats: formatsSet,
      layout: config.output?.layout || bundle.layout || 'generic',
      renderMath: config.output?.renderMath !== false,
      pendingPdf
    });
    if (signal?.cancelled) throw new CancelledError();

    // 若包含 PDF 格式，执行打印
    if (formatsSet.has('pdf')) {
      if (!pendingPdf.html || !pendingPdf.path) {
        throw new Error('PDF 导出未准备好打印内容，已停止提交产物');
      }
      if (typeof printPdf !== 'function') {
        throw new Error('PDF 导出不可用：打印服务未连接');
      }
      report({ stage: 'print', percent: 0, message: '导出 PDF…' });
      await printPdf(pendingPdf.html, pendingPdf.path, {
        needsMath: pendingPdf.needsMath,
        signal
      });
      if (signal?.cancelled) throw new CancelledError();
      const real = newFiles.find((f) => f.pending);
      if (!real || !fs.existsSync(pendingPdf.path)) {
        throw new Error('PDF 导出未生成文件，已停止提交产物');
      }
      delete real.pending;
      report({ stage: 'print', percent: 100, message: 'PDF 已生成' });
    }

    // 原子移动至正式目录
    report({ stage: 'archive', percent: 0, message: '提交新格式产物…' });
    const targetFiles = [];
    for (const file of newFiles) {
      if (!file.path) continue;
      const fileName = path.basename(file.path);
      const targetPath = path.join(outDir, fileName);
      if (fs.existsSync(targetPath)) {
        try {
          await fs.promises.unlink(targetPath);
        } catch {
          /* ignore */
        }
      }
      await fs.promises.rename(file.path, targetPath);
      targetFiles.push({ ...file, path: targetPath });
    }
    newFiles = targetFiles;
    await safeRemove(stagingDir);

    // 更新 registry 记录
    await registry.updateOutputs(hit.key, {
      files: newFiles.map((f) => ({
        path: f.path,
        name: path.basename(f.path),
        format: path.extname(f.path).slice(1).toLowerCase()
      })),
      formats: missingFormats,
      outDir
    });

    // 同步更新 bundle 内部记录
    const baseFiles = hit.outputsDeleted ? [] : (bundle.files || []);
    const baseFormats = hit.outputsDeleted ? [] : (bundle.formats || []);
    await registry.updateBundle(hit.key, {
      outDir,
      files: [
        ...baseFiles,
        ...newFiles.map((f) => ({
          path: f.path,
          name: path.basename(f.path),
          format: path.extname(f.path).slice(1).toLowerCase()
        }))
      ],
      formats: [...new Set([...baseFormats, ...missingFormats])]
    });

    // 同步更新 library 内部反查索引
    try {
      library.registerWork(libraryDir, {
        title,
        dirName: '', // 平铺输出：产物直接在库根
        source: { path: pdfPath, name: sourceName },
        files: (record.files || []).concat(
          newFiles.map((f) => ({ path: f.path, name: path.basename(f.path) }))
        ),
        model: record.model || config.translate.model,
        targetLang: record.targetLang || config.translate.targetLang,
        qaMarkdown: bundle.translatedMarkdown || bundle.embeddedMarkdown
      });
    } catch (err) {
      console.warn('[pipeline] 译文库索引更新失败：', err.message);
    }

    report({
      stage: 'archive',
      percent: 100,
      message: `已完成！成功导出【${fmtLabels}】格式（0 Token 消耗）`
    });

    return {
      name: path.basename(pdfPath),
      sourceName,
      title,
      outDir,
      files: newFiles,
      isEnglish: true,
      isReExport: true,
      reExportFormats: missingFormats,
      markdown: '',
      translatedMarkdown: bundle.translatedMarkdown || bundle.embeddedMarkdown,
      stats: {
        segments: 0,
        translated: 0,
        images: 0,
        reExported: true
      }
    };
  } finally {
    if (stagingDir) await safeRemove(stagingDir);
  }
}

/**
 * 批量入口
 *
 * @param {object} p
 * @param {string[]} p.files
 * @param {object} p.config
 * @param {Function} p.onProgress
 * @param {{cancelled:boolean}} [p.signal]
 * @param {Function} [p.printPdf]           (html, pdfPath, opts) => Promise<void>
 * @param {Function} [p.onBeforeTranslate]  (info) => Promise<boolean>  非英文文献时询问用户
 * @param {boolean} [p.force]               跳过去重
 */
async function run({
  files,
  config,
  onProgress = () => {},
  signal,
  printPdf,
  onBeforeTranslate,
  force = false
}) {
  const list = (files || []).filter(Boolean);
  if (!list.length) throw new Error('没有待翻译的文件');

  const startedAt = Date.now();
  const results = [];
  const failures = [];

  const { normalizeFormats } = require('../config');
  const targetFormats = normalizeFormats(config.output?.formats);

  try {
    for (let i = 0; i < list.length; i++) {
      if (signal?.cancelled) throw new CancelledError();

      const pdfPath = list[i];
      const fileName = path.basename(pdfPath);
      const report = makeReporter(onProgress, { index: i, total: list.length, fileName });

      // 去重与格式补全：只有本次投喂明确要求「强行重翻」（force）才不看记录。
      if (!force) {
        try {
          report({ stage: 'prepare', percent: 50, message: '正在检查翻译记录…' });
          const hit = await withDeadline(() => registry.lookup(pdfPath, { targetFormats }), {
            timeoutMs: 30000,
            signal,
            label: `读取文件「${fileName}」的翻译记录`
          });
          if (hit.translated) {
            const missingFormats = hit.missingFormats || [];
            const hasBundle = hit.hasBundle;

            // 1. 若当前配置有尚未导出的新格式（或译文已被删除但快照完好，需要重新生成译文文档），且具备成果快照：
            // 走 0 Token 极速免重翻导出通道！
            const outputsDeleted = Boolean(hit.outputsDeleted);
            if ((missingFormats.length > 0 || outputsDeleted) && hasBundle) {
              const exportFormats = missingFormats.length > 0 ? missingFormats : targetFormats;
              const fmtLabels = exportFormats
                .map((f) => (f === 'docx' ? 'Word' : f === 'md' ? 'Markdown' : f.toUpperCase()))
                .join('、');
              const msg = outputsDeleted
                ? `检测到译文文档已被删除，正在使用哈希快照重新生成【${fmtLabels}】（0 Token 消耗）…`
                : `使用已有译文补出【${fmtLabels}】（免重翻）…`;
              report({
                stage: 'export',
                percent: 30,
                message: msg
              });

              try {
                const reExportResult = await reExportOne({
                  pdfPath,
                  hit,
                  missingFormats: exportFormats,
                  config,
                  report,
                  signal,
                  printPdf
                });
                results.push(reExportResult);
                continue;
              } catch (reErr) {
                console.warn(`[pipeline] 快速导出/补出新格式失败，回退到完整翻译流程：${reErr.message}`);
                // 快速导出若出现特殊异常，向下回退进入常规流程
              }
            }

            // 2. 否则所有勾选格式均已在磁盘上生成，正常跳过
            onProgress({
              stage: 'skip',
              percent: Math.round(((i + 1) / list.length) * 100),
              index: i,
              total: list.length,
              fileName,
              message: `[${i + 1}/${list.length}] 已翻译过且格式完整，跳过：${fileName}`
            });
            results.push({
              name: fileName,
              skipped: true,
              reason: '已翻译过',
              outDir: hit.record?.outDir || null,
              title: hit.record?.title || null,
              files: hit.record?.files || [],
              translatedMarkdown: '',
              markdown: ''
            });
            continue;
          }
        } catch (err) {
          // 普通指纹异常可以继续翻译；超时/取消必须停止，否则会在同一失联文件上
          // 立刻进入解析并再次卡住，且用户仍看不到问题来源。
          if (signal?.cancelled || err?.message?.includes('超时')) throw err;
          /* 指纹失败就当作没翻译过 */
        }
      }

      try {
        const one = await runOne({ pdfPath, config, report, signal, printPdf, onBeforeTranslate, force });
        results.push(one);
      } catch (err) {
        const message = (err && err.message) || String(err);
        failures.push({ name: fileName, message });
        onProgress({
          stage: 'paper-error',
          percent: Math.round(((i + 1) / list.length) * 100),
          index: i,
          total: list.length,
          fileName,
          message: `[${i + 1}/${list.length}] 失败：${fileName} — ${message}`
        });
        if (isCancelled(err)) {
          // 取消时保留已完成的部分，调用方展示“已完成 N 篇 / 重试剩余”。
          err.partialResults = results.slice();
          err.partialFailures = failures.slice();
          throw err;
        }
      } finally {
        await flushCache().catch(() => {});
      }
    }
  } finally {
    // 即使中途取消或抛出致命异常，也必须强制将内存中已完成的段落持久化到磁盘缓存，避免浪费 Token
    await flushCache().catch(() => {});
  }

  const done = results.filter((r) => !r.skipped);
  const skippedNonEnglish = results.filter(
    (r) => r.skipped && typeof r.reason === 'string' && r.reason.includes('非英文')
  );

  return {
    ok: failures.length === 0,
    total: list.length,
    succeeded: done.length,
    skipped: results.filter((r) => r.skipped).length,
    skippedNonEnglish: skippedNonEnglish.length,
    failed: failures.length,
    failures,
    results,
    // 供问答使用的语料来源（本次任务读过的论文）
    papers: results
      .filter((r) => r.translatedMarkdown || r.markdown)
      .map((r) => ({
        name: r.title ? `${r.title}.md` : r.name,
        outDir: r.outDir,
        markdown: r.markdown,
        translatedMarkdown: r.translatedMarkdown
      })),
    elapsedMs: Date.now() - startedAt
  };
}

module.exports = { run, runOne, makeReporter };
