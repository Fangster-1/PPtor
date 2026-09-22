'use strict';

/* 气泡组件：对话 / 表单 / 确认问询 / 进度卡的唯一渲染出口 */

let bubbleToken = 0;

/** 气泡或菜单栏(交互界面)是否可见 */
function overlayVisible() {
  const b = $('bubble');
  const m = $('menuPanel');
  const bubbleOpen = !!(b && !b.classList.contains('is-hidden'));
  const menuOpen = !!(m && !m.classList.contains('is-hidden'));
  return bubbleOpen || menuOpen;
}

function showBubble({ hideProgress = true } = {}) {
  hideMenuPanel();
  $('bubble').classList.remove('is-hidden');
  if (hideProgress) $('progress').classList.add('is-hidden');
  forceInteractive(true);
  refreshDialogPlacement();
}

function hideBubble() {
  bubbleToken += 1;
  state.onboardingNotice = false;
  const b = $('bubble');
  if (b) b.classList.add('is-hidden');
  if ($('bubbleBody')) $('bubbleBody').innerHTML = '';
  if ($('bubbleTitle')) $('bubbleTitle').textContent = '';
  if ($('bubbleActions')) $('bubbleActions').innerHTML = '';
  forceInteractive(state.busy || isMenuPanelVisible());
}

function hideBubbleNoReset() {
  bubbleToken += 1;
  const b = $('bubble');
  if (b) b.classList.add('is-hidden');
}

function renderBubble({ title = '', texts = [], actions = [], hideProgress = true, asHtml = false, taskDialog = false }) {
  $('bubble').classList.toggle('task-dialog', taskDialog);
  $('bubbleTitle').textContent = title;

  const body = $('bubbleBody');
  body.innerHTML = '';
  for (const t of texts) {
    if (!t) continue;
    const d = document.createElement('div');
    d.className = 'bubble-text';
    if (asHtml) d.innerHTML = t;
    else d.textContent = t;
    body.appendChild(d);
  }

  const bar = $('bubbleActions');
  bar.innerHTML = '';
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = `btn ${a.variant || 'ghost'}`;
    btn.textContent = a.label;
    btn.addEventListener('click', a.onClick);
    bar.appendChild(btn);
  }

  showBubble({ hideProgress });
}

function say(text, timeout) {
  if (state.busy) {
    // 任务期间的提示只能进入进度区，不能销毁确认气泡或覆盖任务动画。
    if (!state.task.waiting) {
      state.task.message = String(text || '');
      showProgress(state.task.progress, state.task.message);
    }
    return;
  }
  bubbleToken += 1;
  const mine = bubbleToken;
  renderBubble({ texts: [text] });
  if (timeout) {
    // 错误类提示不自动消失，普通提示至少 5s，照顾阅读障碍用户
    const isError = /失败|错误|无法|不能|异常/.test(String(text || ''));
    const delay = isError ? 0 : Math.max(timeout || 0, 5000);
    if (delay > 0) {
      setTimeout(() => {
        if (mine === bubbleToken) hideBubble();
      }, delay);
    }
  }
}

function showForm({ title, text, fields = [], submitLabel = '确定', link = null, onSubmit, onCancel, onBack, backLabel = '上一步' }) {
  bubbleToken += 1;
  $('bubble').classList.remove('task-dialog');

  $('bubbleTitle').textContent = title || '';

  const body = $('bubbleBody');
  body.innerHTML = '';

  if (text) {
    const d = document.createElement('div');
    d.className = 'bubble-text';
    d.textContent = text;
    body.appendChild(d);
  }

  const inputs = {};
  for (const f of fields) {
    const wrap = document.createElement('label');
    wrap.className = 'f-field';

    if (f.label) {
      const lb = document.createElement('span');
      lb.className = 'f-label';
      lb.textContent = f.label;
      wrap.appendChild(lb);
    }

    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      for (const opt of f.options) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === f.value) o.selected = true;
        input.appendChild(o);
      }
    } else {
      input = document.createElement('input');
      input.type = f.type || 'text';
      input.value = f.value || '';
      if (f.placeholder) input.placeholder = f.placeholder;
      input.autocomplete = 'off';
      input.spellcheck = false;
    }

    wrap.appendChild(input);
    body.appendChild(wrap);
    inputs[f.key] = input;
  }

  /* 外链按钮：直达 Key / Token 申请页 */
  if (link && link.url) {
    const a = document.createElement('button');
    a.type = 'button';
    a.className = 'link-btn';
    a.textContent = link.label || '打开申请页面';
    a.addEventListener('click', () => api.openExternal(link.url));
    body.appendChild(a);
  }

  const bar = $('bubbleActions');
  bar.innerHTML = '';

  const ok = document.createElement('button');
  ok.className = 'btn primary';
  ok.textContent = submitLabel;
  ok.addEventListener('click', () => {
    const values = {};
    for (const [k, el] of Object.entries(inputs)) values[k] = String(el.value).trim();
    onSubmit(values);
  });
  bar.appendChild(ok);

  if (typeof onBack === 'function') {
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'btn ghost';
    backBtn.textContent = backLabel;
    backBtn.addEventListener('click', () => {
      onBack();
    });
    bar.appendChild(backBtn);
  }

  const cancel = document.createElement('button');
  cancel.className = 'btn ghost';
  cancel.textContent = onCancel ? '取消' : '收起';
  cancel.addEventListener('click', () => {
    hideBubble();
    if (onCancel) onCancel();
  });
  bar.appendChild(cancel);

  showBubble();

  // 自动聚焦第一个输入框，省一次点击
  const first = Object.values(inputs)[0];
  if (first && first.focus) setTimeout(() => first.focus(), 60);

  return inputs;
}

function showProgress(percent, text, { keepBubble = false } = {}) {
  if (!keepBubble) hideBubbleNoReset();
  state.task.progress = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : state.task.progress;
  state.task.message = text || state.task.message;
  $('progress').classList.remove('is-hidden');
  $('barFill').style.width = `${state.task.progress}%`;
  const pt = $('progressText');
  if (pt) {
    pt.textContent = state.task.message || '';
    pt.title = state.task.message || '';
  }
  updateStatusUI();
  forceInteractive(false);
  refreshDialogPlacement();
}

function refreshDialogPlacement() {
  try { api.petBounds?.().then(updateDialogPlacement).catch(() => {}); } catch { /* ignore */ }
}

function hideProgress() {
  $('progress').classList.add('is-hidden');
  $('progress').classList.remove('has-prompt', 'is-cancelling');
}

/** 主进程抛来的确认问题（目前用于「疑似非英文文献」），Esc 不可丢弃，可点进度条召回 */
function showAsk({ message, options }) {
  const list = Array.isArray(options) && options.length ? options : [{ value: 'ok', label: '知道了' }];
  const first = list[0];
  const second = list[1];

  state.askOpen = true;
  state.lastAsk = { message, options };
  if (state.busy) {
    state.task.waiting = true;
    state.task.phase = 'waiting';
    setTaskAnimation('waiting', true);
    $('progress').classList.add('has-prompt');
    const pt = $('progressText');
    if (pt) pt.title = '点击此处召回确认框';
  } else {
    setAnim('waiting', { source: 'ambient', restart: true });
  }

  renderBubble({
    title: '确认一下（请点按钮选择，Esc 不会关闭）',
    texts: [message],
    actions: [
      {
        label: first.label || '确定',
        variant: 'primary',
        onClick: () => {
          state.askOpen = false;
          if (state.busy) restoreTaskProgress();
          hideBubble();
          state.lastAsk = null;
          api.answer(first.value);
        }
      },
      {
        label: second ? second.label : '取消',
        onClick: () => {
          state.askOpen = false;
          if (state.busy) restoreTaskProgress();
          hideBubble();
          state.lastAsk = null;
          api.answer(second ? second.value : first.value);
        }
      }
    ],
    hideProgress: !state.busy
  });
}
