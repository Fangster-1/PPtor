'use strict';

/* 翻译任务状态机：进度条 + 阶段条 + 宠物动画 + 完成结果气泡 */

function beginTask(files) {
  state.busy = true;
  state.task = {
    runId: state.task.runId + 1,
    phase: 'prepare',
    resumePhase: 'prepare',
    progress: 0,
    phasePercent: null,
    phaseIndeterminate: true,
    message: files.length > 1 ? `准备处理 ${files.length} 篇论文…` : '准备处理论文…',
    waiting: false,
    cancelRequested: false
  };
  $('pet').classList.add('is-busy');
  $('dropVeil').classList.remove('is-busy');
  return state.task.runId;
}

function taskIsActive(runId) {
  return state.busy && state.task.runId === runId;
}

function setTaskAnimation(name, restart = false) {
  return setAnim(name, { source: 'task', restart });
}

function markTaskProgress(e) {
  if (!state.busy || !e) return;
  const previousPhase = state.task.phase;
  if (state.task.waiting) {
    // 主进程可能在弹出确认框后又推送一条进度；只记住恢复点，
    // 不要把 waiting 表情换回工作动画。
    if (e.stage) state.task.resumePhase = e.stage;
  } else {
    state.task.phase = e.stage || state.task.phase;
    state.task.resumePhase = state.task.phase;
  }
  if (Number.isFinite(e.percent)) state.task.progress = Math.max(0, Math.min(100, e.percent));
  if (e.phaseChanged || (e.stage && e.stage !== previousPhase)) {
    state.task.phasePercent = null;
    state.task.phaseIndeterminate = true;
  }
  if (Number.isFinite(e.phasePercent)) {
    state.task.phasePercent = Math.max(0, Math.min(100, e.phasePercent));
    state.task.phaseIndeterminate = false;
  } else if (e.phaseIndeterminate) {
    state.task.phasePercent = null;
    state.task.phaseIndeterminate = true;
  }
  state.task.message = e.message || state.task.message;
  if (!state.task.waiting && e.stage && STAGE_ANIM[e.stage]) {
    const next = STAGE_ANIM[e.stage];
    setTaskAnimation(next, state.anim !== next);
  }
  updateStatusUI();
}

function updateStatusUI() {
  const label = {
    prepare: '准备中',
    parsing: '解析中',
    translating: '翻译中',
    exporting: '整理译文',
    parse: '解析中',
    lang: '判断语种',
    chunk: '整理结构',
    translate: '翻译中',
    export: '整理译文',
    print: '导出 PDF',
    archive: '归档中',
    waiting: '等你确认',
    done: '已完成',
    cancelling: '正在取消…',
    cancelled: '已取消',
    error: '失败'
  }[state.task.phase] || '工作中';
  const el = $('progressState');
  if (el) el.textContent = label;
  const phaseLabel = $('phaseLabel');
  if (phaseLabel) phaseLabel.textContent = `当前阶段 · ${label}`;
  const phaseText = $('phasePercent');
  if (phaseText) {
    phaseText.textContent = state.task.phaseIndeterminate || !Number.isFinite(state.task.phasePercent)
      ? '处理中…'
      : `${Math.round(state.task.phasePercent)}%`;
  }
  const phaseBar = $('phaseBar');
  if (phaseBar) phaseBar.classList.toggle('is-indeterminate', state.task.phaseIndeterminate || !Number.isFinite(state.task.phasePercent));
  const phaseFill = $('phaseBarFill');
  if (phaseFill && Number.isFinite(state.task.phasePercent)) phaseFill.style.width = `${state.task.phasePercent}%`;
  const overall = $('overallPercent');
  if (overall) overall.textContent = `${Math.round(state.task.progress || 0)}%`;
  const cancel = $('cancelJob');
  if (cancel) {
    cancel.disabled = !state.busy || state.task.cancelRequested;
    cancel.textContent = state.task.cancelRequested ? '正在取消…' : '取消';
  }
  $('progress')?.classList.toggle('is-cancelling', !!state.task.cancelRequested);
}

function restoreTaskProgress() {
  if (!state.busy) return;
  showProgress(state.task.progress, state.task.message, { keepBubble: true });
  state.task.waiting = false;
  state.askOpen = false;
  state.task.phase = state.task.resumePhase || state.task.phase;
  const next = STAGE_ANIM[state.task.phase] || 'translating';
  setTaskAnimation(next, state.anim !== next);
  $('progress')?.classList.remove('has-prompt');
}

async function requestCancel() {
  if (!state.busy || state.task.cancelRequested) return;
  state.task.cancelRequested = true;
  // 取消中单独状态：界面显示“正在取消…”，仅主进程回包后才置 cancelled/已取消
  state.task.phase = 'cancelling';
  state.task.message = '正在停止当前任务…';
  setTaskAnimation('cancelled', true);
  showProgress(state.task.progress, state.task.message, { keepBubble: true });
  updateStatusUI();
  try {
    await api.cancelJob();
  } catch {
    /* 任务结束时主进程可能已销毁，最终结果仍由 startJob 给出 */
  }
}

function showCancelled(partial) {
  setAnim('cancelled', { source: 'task', restart: true });
  const doneCount = Array.isArray(partial) ? partial.length : 0;
  const texts = doneCount
    ? [`已取消。这次先停在这里，已完成 ${doneCount} 篇可直接查看，剩余的可重新拖入继续。`]
    : ['这次先停在这里，已经生成的文件不会被覆盖。'];
  const actions = [];
  if (doneCount && state.lastOutDir) {
    actions.push({ label: '打开文件夹', variant: 'primary', onClick: () => api.openPath(state.lastOutDir) });
  }
  actions.push({ label: '知道了', variant: actions.length ? 'ghost' : 'primary', onClick: () => { hideBubble(); restoreAmbientAnimation(); drainPendingQueue(); } });
  renderBubble({ title: '已取消', texts, actions, taskDialog: true });
}

function finishTask({ keepVisible = false } = {}) {
  state.busy = false;
  state.task.waiting = false;
  state.askOpen = false;
  state.lastAsk = null;
  $('pet').classList.remove('is-busy');
  $('progress')?.classList.remove('has-prompt', 'is-cancelling');
  if (!keepVisible) hideProgress();
}

function drainPendingQueue() {
  if (!state.pendingQueue.length || state.busy) return;
  const next = state.pendingQueue.shift();
  if (next && next.length) {
    say(`接着处理排队的 ${next.length} 篇…`, 3000);
    setTimeout(() => handleFiles(next), 600);
  }
}

function onCancelJobClick(e) {
  e.preventDefault();
  requestCancel();
}

async function startTranslate(files, force) {
  const runId = beginTask(files);
  let res;
  try {
    hideBubble();
    setTaskAnimation('parsing', true);

    const count = files.length;
    showProgress(0, count > 1 ? `准备吃下 ${count} 篇论文…` : `准备吃下《${basename(files[0])}》…`);

    res = await api.startJob({ files, force });
  } catch (err) {
    res = { ok: false, message: err.message || String(err) };
  }

  if (!taskIsActive(runId)) return;
  const cancelled = state.task.cancelRequested || (res && (res.message === '已取消' || res.cancelled));
  // 完成结果是唯一的终态窗口；必须立即收起进度卡，避免叠层和“处理中”残留。
  finishTask();

  if (cancelled) {
    const partial = (res && res.partialResults) || [];
    if (partial.length) {
      state.lastOutDir = (partial.find((r) => r.outDir) || {}).outDir || state.lastOutDir;
    }
    showCancelled(partial);
    return;
  }

  if (res && Array.isArray(res.results)) {
    state.lastOutDir = (res.results.find((r) => r.outDir) || {}).outDir || null;
    state.lastTranslatedFiles = (Array.isArray(files) ? files : [files]).slice();
    api.saveConfig({ lastFiles: state.lastTranslatedFiles }).catch(() => {});
    const jumpAnim = res.failed ? 'failed' : 'jumping';
    setAnim(jumpAnim, { source: 'task', restart: true });
    // 完成动画保持到用户确认：延迟回 idle，不再 600ms 闪回
    showBatchResult(res);
    // 排队任务自动续跑
    if (state.pendingQueue.length) {
      setTimeout(drainPendingQueue, 800);
    }
    return;
  }

  if (res && res.code === 'NO_API_KEY') {
    promptSetup(files);
    return;
  }

  setAnim('failed', { source: 'task', restart: true });
  showForm({
    title: '出了点问题',
    text: (res && res.message) || '未知错误',
    fields: [],
    submitLabel: '知道了',
    onSubmit: () => {
      hideBubble();
      setAnim('idle');
    }
  });
}

function onProgress(e) {
  if (!e || !state.busy) return;
  if (e.stage === 'error') {
    if (state.task.cancelRequested || /已取消|cancel/i.test(String(e.message || ''))) {
      state.task.phase = 'cancelled';
      state.task.message = '正在停止当前任务…';
      setTaskAnimation('cancelled', true);
    } else {
      state.task.phase = 'error';
      state.task.message = e.message || '任务失败';
      setTaskAnimation('failed', true);
    }
    updateStatusUI();
    return;
  }

  state.task.phase = e.stage || state.task.phase;
  state.task.message = e.message || state.task.message;
  state.task.progress = Number.isFinite(e.percent) ? e.percent : state.task.progress;
  state.task.phasePercent = Number.isFinite(e.phasePercent) ? e.phasePercent : null;
  state.task.phaseIndeterminate = !!e.phaseIndeterminate;

  const next = STAGE_ANIM[state.task.phase] || 'translating';
  setTaskAnimation(next, state.anim !== next);

  showProgress(state.task.progress, state.task.message, { keepBubble: true });
  updateStatusUI();
}

function showBatchResult(res) {
  const secs = Math.max(1, Math.round((res.elapsedMs || 0) / 1000));
  const done = (res.results || []).filter((r) => !r.skipped && r.outDir);

  const texts = [];

  if (done.length) {
    const isAllReExport = done.every((r) => r.isReExport);
    const anyReExport = done.some((r) => r.isReExport);
    if (isAllReExport) {
      texts.push(`极速导出完成！${done.length} 篇（0 Token 消耗），用时 ${secs} 秒。`);
    } else if (anyReExport) {
      texts.push(`任务完成！${done.length} 篇（含免重翻极速导出），用时 ${secs} 秒。`);
    } else {
      texts.push(`吐出来了！${done.length} 篇，用时 ${secs} 秒。`);
    }
    for (const r of done.slice(0, 5)) {
      texts.push(`《${r.title || r.sourceName || r.name}》`);
    }
    if (done.length > 5) texts.push(`…共 ${done.length} 篇`);
  } else {
    texts.push(`这次没吃成…用时 ${secs} 秒。`);
  }

  if (res.skipped) {
    const extra = res.skippedNonEnglish ? `，其中 ${res.skippedNonEnglish} 篇非英文` : '';
    texts.push(`跳过 ${res.skipped} 篇${extra}。`);
  }
  if (res.failed) {
    texts.push(`失败 ${res.failed} 篇：`);
    for (const failure of res.failures || []) {
      texts.push(`${failure.name}\n${failure.message || '未知错误'}`);
    }
  }

  const actions = [];

  if (done.length) {
    const first = done[0];
    actions.push({
      label: done.length > 1 ? `打开第一篇译文（共 ${done.length} 篇）` : '打开译文',
      variant: 'primary',
      onClick: () => {
        const files = first.files || [];
        const translated = files.find(
          (f) => /\.pdf$/i.test(f.path) && !/原文-/.test(basename(f.path))
        );
        api.openPath(translated ? translated.path : first.outDir);
      }
    });
    actions.push({
      label: done.length > 1 ? '打开文档库' : '打开文件夹',
      onClick: () => api.openPath(first.outDir)
    });
  } else {
    actions.push({
      label: '知道了',
      variant: 'primary',
      onClick: () => {
        hideBubble();
        hideProgress();
        setAnim('idle');
      }
    });
  }

  if (res.succeeded) {
    actions.push({ label: '论文问答…', onClick: () => { hideProgress(); void api.chatToggle().catch(() => {}); } });
  } else if (done.length) {
    actions.push({ label: '收起', onClick: () => { hideBubble(); hideProgress(); setAnim('idle'); } });
  }

  renderBubble({
    title: res.failed ? (done.length ? '部分翻译失败' : '翻译失败') : '任务完成',
    texts,
    actions,
    taskDialog: true
  });
}
