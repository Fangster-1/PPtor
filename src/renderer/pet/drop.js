'use strict';

/* 投喂入口：拖放 / 粘贴 / 去重对话框 / 非 PDF 捉弄 / 未配 Key 拦截 */

/** 拖入统一入口：先按译文库索引识别，再把未登记的 PDF 作为翻译源。
 *
 * PDF 也必须先 matchLibrary，因为导出的译文 PDF 仍然是 PDF；命中的
 * PDF / DOCX / HTML / Markdown 直接读回问答，只有未命中的 PDF 才翻译。
 */
const LIBRARY_DROP_EXTS = new Set(['.pdf', '.docx', '.html', '.htm', '.md', '.markdown']);

function onDragEnter(e) {
  e.preventDefault();
  state.dragDepth += 1;
  $('dropVeil').classList.remove('is-hidden');
  $('dropVeil').classList.toggle('is-busy', state.busy);
  $('dropVeilText').textContent = state.busy ? '当前任务进行中…' : '松手，我吃掉它';
  if (!state.busy) setAnim('waving', { source: 'interaction', restart: true });
}

function onDragOver(e) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}

function onDragLeave(e) {
  e.preventDefault();
  state.dragDepth -= 1;
  if (state.dragDepth > 0) return;

  state.dragDepth = 0;
  $('dropVeil').classList.add('is-hidden');
  if (!state.busy) restoreAmbientAnimation();
}

function onDrop(e) {
  e.preventDefault();
  state.dragDepth = 0;
  $('dropVeil').classList.add('is-hidden');

  const list = (e.dataTransfer && e.dataTransfer.files) || [];
  if (!list.length) return;

  const paths = [];

  for (const file of list) {
    let p = '';
    try {
      p = api.getFilePath(file);
    } catch {
      /* 回退 */
    }
    if (!p) {
      const uri = (e.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/)[0];
      if (uri.startsWith('file:')) {
        try {
          p = decodeURIComponent(new URL(uri).pathname).replace(/^\//, '').replace(/\//g, '\\');
        } catch {
          /* ignore */
        }
      }
    }
    if (!p) continue;

    paths.push(p);
  }

  if (paths.length) handleDroppedPaths(paths);
}

async function handleDroppedPaths(paths) {
  const unique = [...new Set((paths || []).filter(Boolean))];
  // 文件夹拖入：明确提示请拖入 PDF 文件，而不是“未知格式”
  const noExt = unique.filter((p) => !pathExtension(p));
  if (noExt.length && !unique.some((p) => LIBRARY_DROP_EXTS.has(pathExtension(p)))) {
    say('请把 PDF 文件拖给我，文件夹我吃不下。', 5000);
    return;
  }
  if (state.busy) {
    // 忙时排队：暂存，当前任务完成后自动开工，不再直接拒绝丢任务
    state.pendingQueue.push(unique);
    say(`我还在嚼上一波呢，已排队（第 ${state.pendingQueue.length} 位），完成后自动开工。`, 5000);
    return;
  }

  const candidates = unique.filter((p) => LIBRARY_DROP_EXTS.has(pathExtension(p)));
  const unsupported = unique.filter((p) => !LIBRARY_DROP_EXTS.has(pathExtension(p)));
  if (!candidates.length) {
    if (unsupported.length) teaseNonPdf(unsupported[0]);
    return;
  }

  const checked = await Promise.all(candidates.map(async (file) => {
    let hit = null;
    try {
      hit = await api.matchLibrary(file);
    } catch {
      /* 索查询失败时按未命中处理；未命中的 PDF 仍可翻译 */
    }
    return { file, hit, ext: pathExtension(file) };
  }));

  const matched = checked.filter((x) => x.hit);
  const sourcePdfs = checked.filter((x) => !x.hit && x.ext === '.pdf').map((x) => x.file);
  const unknownDocs = checked.filter((x) => !x.hit && x.ext !== '.pdf');

  if (matched.length) {
    // 命中的译文直接按文件走 bundle/索引回读（平铺库下不再按目录扫描）
    const r = await api.qaLoadDoc({ files: matched.map((x) => x.file) });
    if (r && r.ok) {
      setAnim('jumping', { source: 'task', restart: true });
      const title = matched.length === 1
        ? `认出这是《${(matched[0].hit.work && matched[0].hit.work.title) || basename(matched[0].file)}》的译文`
        : `认出 ${matched.length} 份已登记译文`;
      const edited = matched.some((x) => x.hit.modified);
      say(`${title}${edited ? '（部分内容改过）' : ''}。我读完了，在聊天窗里随便问～`, 5000);
      void api.chatToggle().catch(() => {});
    } else {
      say((r && r.message) || '没能读到这份译文', 4000);
    }
  }

  // 命中的译文不会再次翻译；所有未命中 PDF 仍按原顺序成批处理。
  if (sourcePdfs.length) handleFiles(sourcePdfs);

  if (unknownDocs.length && !matched.length && !sourcePdfs.length) {
    teaseNonPdf(unknownDocs[0].file);
  }
}

// 兼容旧调用点和自动化探针。
function handleNonPdfDrop(paths) {
  return handleDroppedPaths(paths);
}

/* ---------------------------- 吃到非 PDF 的捉弄 ---------------------------- */

const JUNK_REPLIES = [
  '{name}\n\n我嚼了一下……这是 {ext}，既不是论文也不是译文。硌牙。（吐出来）',
  '{name}\n\n呸。我要的是论文 PDF，你给我 {ext}。退给你。',
  '{name}\n\n（咔嚓）（沉默）……这个不能吃，还你。我只消化英文论文，或我自己译出的译文。',
  '{name}\n\n尝出来了，是 {ext}。我挑食，谢谢。'
];

let teasing = false;

function teaseNonPdf(filePath) {
  if (teasing || state.busy) return;
  const runIdAtEntry = state.task.runId;
  teasing = true;

  const name = basename(filePath);
  const extMatch = name.match(/\.[^.]+$/);
  const ext = extMatch ? extMatch[0].slice(1).toUpperCase() : '未知格式';
  const tpl = JUNK_REPLIES[Math.floor(Math.random() * JUNK_REPLIES.length)];
  const text = tpl.replace('{name}', name).replace('{ext}', ext);

  // 演出：张嘴 → 咀嚼 → 嫌弃 → 吐出来
  setAnim('waving', { restart: true });
  say('唔…这是什么味道？', 900);

  setTimeout(() => {
    if (!teasing) return;
    if (state.busy || state.task.runId !== runIdAtEntry) { teasing = false; return; }
    setAnim('running', { restart: true });
  }, 950);

  setTimeout(() => {
    if (!teasing) return;
    if (state.busy || state.task.runId !== runIdAtEntry) { teasing = false; return; }
    setAnim('failed', { restart: true });
    renderBubble({
      title: '呸！',
      texts: [text],
      actions: [
        {
          label: '知道了',
          variant: 'primary',
          onClick: () => {
            hideBubble();
            setAnim('idle');
          }
        },
        {
          label: '再试一次',
          onClick: () => {
            hideBubble();
            setAnim('idle');
            say('把 PDF 拖到我身上就行。', 4500);
          }
        }
      ]
    });
    teasing = false;
  }, 1900);
}

async function onPaste(e) {
  // 气泡里只要有输入框（配置表单），Ctrl+V 就归输入框所有。
  // 只看事件目标不够：焦点可能落在按钮或气泡上，那样仍会触发「喂 PDF」把表单冲掉。
  const bubbleEl = document.getElementById('bubble');
  if (bubbleEl && !bubbleEl.classList.contains('is-hidden') && bubbleEl.querySelector('input, textarea')) {
    return;
  }

  const t = e && e.target;
  const tag = t && t.tagName;
  if (t && (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable)) return;

  if (e && e.preventDefault) e.preventDefault();
  if (state.busy) {
    say('正在翻译中，稍等…', 2500);
    return;
  }

  const r = await api.readClipboardFiles(['.pdf']);
  if (r.ok && r.ok.length) {
    handleDroppedPaths(r.ok);
    return;
  }
  say('剪贴板里没有 PDF。先在资源管理器里 Ctrl+C 复制文件，再按 Ctrl+V。', 4500);
}

function complain(message) {
  setAnim('failed', { restart: true });
  say(message, 4000);
  setTimeout(() => {
    if (!state.busy) setAnim('idle');
  }, 4300);
}

/** 没配 Key：拦下这批文件，引导去配置；配好后自动接着翻 */
function promptSetup(files) {
  state.pendingFiles = files && files.length ? [...files] : null;
  setAnim('waving', { restart: true });
  showForm({
    title: '还没配翻译模型',
    text: '翻译和问答需要大模型 API Key。配好就接着翻这几篇。',
    fields: [],
    submitLabel: '现在配置',
    onSubmit: () => wizardTranslate(false),
    onCancel: () => {
      state.pendingFiles = null;
      setAnim('idle');
    }
  });
}

/** 统一入口：先查重，再决定怎么翻 */
async function handleFiles(files) {
  dismissOnboardingNotice();
  if (state.busy) {
    state.pendingQueue.push([...new Set(files)]);
    say(`我还在嚼上一波呢，已排队（第 ${state.pendingQueue.length} 位），完成后自动开工。`, 5000);
    return;
  }

  const unique = [...new Set(files)];

  if (needsSetup()) {
    promptSetup(unique);
    return;
  }

  let checks = [];
  try {
    checks = await api.checkRegistry(unique);
  } catch {
    /* 查重失败就直接翻 */
  }

  const dup = checks.filter((c) => c.translated);
  const fresh = unique.filter((f) => !dup.some((d) => d.file === f));

  if (!dup.length) {
    startTranslate(unique, false);
    return;
  }

  showDupDialog(unique, dup, fresh);
}

function formatLabelName(fmt) {
  const f = String(fmt || '').toLowerCase().trim();
  if (f === 'pdf') return 'PDF';
  if (f === 'docx' || f === 'word') return 'Word';
  if (f === 'md' || f === 'markdown') return 'Markdown';
  if (f === 'html') return 'HTML';
  return f.toUpperCase();
}

function showDupDialog(all, dup, fresh) {
  const outputsDeletedList = dup.filter((d) => d.outputsDeleted && d.hasBundle);
  const canReExport = dup.filter((d) => !d.outputsDeleted && Array.isArray(d.missingFormats) && d.missingFormats.length > 0 && d.hasBundle);

  const lines = [];
  for (const d of dup) {
    if (d.outputsDeleted && d.hasBundle) {
      lines.push(`· ${basename(d.file)}\n  译文文档已被删除（本地备份完好）\n  是否需要重新生成译文文档？无需重新翻译。`);
    } else {
      const existing = (d.existingFormats || []).map(formatLabelName).join('、') || '已有格式';
      const missing = (d.missingFormats || []).map(formatLabelName).join('、');
      if (missing && d.hasBundle) {
        lines.push(`· ${basename(d.file)}\n  已生成：${existing}；未生成：${missing}`);
      } else if (existing) {
        lines.push(`· ${basename(d.file)}（已生成：${existing}）`);
      } else {
        lines.push(`· ${basename(d.file)}`);
      }
    }
  }

  if (outputsDeletedList.length > 0) {
    lines.push('可直接从本地备份重新生成译文文档，无需重新翻译！');
  } else if (canReExport.length > 0) {
    const allMissing = [...new Set(canReExport.flatMap((d) => d.missingFormats || []))];
    const missingText = allMissing.map(formatLabelName).join('、');
    lines.push(`检测到勾选了新格式【${missingText}】，可直接使用已有译文极速导出，无需重新翻译。`);
  }

  if (fresh.length) lines.push(`另有 ${fresh.length} 篇新论文。`);

  const actions = [];

  if (outputsDeletedList.length > 0) {
    actions.push({
      label: '重新生成译文文档（无需重翻）',
      variant: 'primary',
      onClick: () => startTranslate(all, false)
    });
  } else if (canReExport.length > 0) {
    const allMissing = [...new Set(canReExport.flatMap((d) => d.missingFormats || []))];
    const missingText = allMissing.map(formatLabelName).join('、');
    actions.push({
      label: `补出【${missingText}】（无需重翻）`,
      variant: 'primary',
      onClick: () => startTranslate(all, false)
    });
  } else if (fresh.length) {
    actions.push({
      label: `只翻新的 ${fresh.length} 篇`,
      variant: 'primary',
      onClick: () => startTranslate(fresh, false)
    });
  } else {
    actions.push({
      label: '知道了',
      variant: 'primary',
      onClick: () => {
        hideBubble();
        setAnim('idle');
      }
    });
  }

  actions.push({
    label: outputsDeletedList.length > 0 ? '重新翻译' : '强行重翻',
    onClick: () => startTranslate(all, true)
  });
  actions.push({ label: '论文问答…', onClick: () => qaOpenFromRecords(dup) });
  if (outputsDeletedList.length > 0 || canReExport.length > 0 || fresh.length) {
    actions.push({
      label: '关闭',
      onClick: () => {
        hideBubble();
        setAnim('idle');
      }
    });
  }

  const title = outputsDeletedList.length > 0
    ? '译文已被删除（可免重翻恢复）'
    : (canReExport.length > 0 ? '检测到新输出格式' : '这篇我翻过了');

  renderBubble({
    title,
    texts: lines,
    actions
  });
}

/** 从「已翻译过」的记录直接进入问答：按原文件 bundle 回读译文后打开聊天窗 */
async function qaOpenFromRecords(dup) {
  const files = dup.map((d) => d.file).filter(Boolean);
  if (!files.length) {
    say('记录里没有原文信息，请在聊天窗里「添加文档」。', 4500);
    return;
  }

  const r = await api.qaLoadDoc({ files });
  if (!r.ok) {
    say(r.message || '没能读到译文文件', 4500);
    return;
  }

  hideBubble();
  void api.chatToggle().catch(() => {});
}
