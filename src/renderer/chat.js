'use strict';

/**
 * 聊天窗逻辑（微信式）：
 *   - 左侧会话列表：每个翻译任务/文档导入是一个会话（好友行），支持分组、
 *     重命名、删除（右键菜单）；列表宽度可拖拽调整
 *   - 右侧消息流：助手白气泡（Markdown+公式 HTML）、用户绿气泡；系统消息居中灰条
 *   - 拖 PDF 到窗口直接开工翻译；任务进度显示在标题栏状态胶囊
 * 业务全部在主进程，这里只做表现。
 */

const api = window.pt;
const $ = (id) => document.getElementById(id);

const state = {
  sessions: [],
  activeId: null,
  history: [],
  sources: [],
  ready: false,
  pending: false,
  collapsed: {} // 分组折叠状态 { 组名: true }
};

const SIDEBAR_KEY = 'pptor.sidebar.width';
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 420;

/* ------------------------------- 基础工具 ------------------------------- */

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function scrollToEnd() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

/** 头像底色：按会话 id 稳定取色（微信式彩色头像） */
const AVATAR_COLORS = ['#5b8def', '#07c160', '#e6a23c', '#f06292', '#7e57c2', '#26a69a', '#ef6c00', '#5d8aa8'];
function avatarColor(seed) {
  let hash = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** 宠物幽灵 SVG（与桌宠同款，聊天窗头部即桌宠的临时居所） */
const GHOST_SVG =
  '<svg viewBox="0 0 200 208" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M100,36 C73,36 52,57 52,86 L52,156 Q64,176 76,156 Q88,176 100,156 Q112,176 124,156 Q136,176 148,156 L148,86 C148,57 127,36 100,36 Z" fill="#ffffff" stroke="rgba(0,0,0,.10)" stroke-width="6"/>' +
  '<ellipse cx="79" cy="96" rx="6" ry="9" fill="#2d2d3a"/><ellipse cx="121" cy="96" rx="6" ry="9" fill="#2d2d3a"/>' +
  '<path d="M87,118 Q100,130 113,118" fill="none" stroke="#2d2d3a" stroke-width="5" stroke-linecap="round"/>' +
  '</svg>';

function avatarNode(seed, isPet) {
  const node = el('div', 'msg-avatar');
  if (isPet) {
    node.style.background = '#5b4dff';
    node.innerHTML = GHOST_SVG;
  } else {
    node.style.background = avatarColor(seed);
    node.textContent = firstChar(seed);
  }
  return node;
}

function firstChar(seed) {
  const s = String(seed || '').trim();
  if (!s) return '文';
  const ch = [...s][0];
  return /[a-zA-Z]/.test(ch) ? ch.toUpperCase() : ch;
}

function fmtTime(at) {
  if (!at) return '';
  const d = new Date(at);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 行内编辑（Electron sandbox 下 window.prompt 不可用，用内联输入框替代） */
function inlineEdit(container, initial, onOk) {
  const input = el('input', 'inline-edit');
  input.type = 'text';
  input.value = initial || '';
  input.maxLength = 40;
  const done = (commit) => {
    input.remove();
    if (commit) onOk(String(input.value || '').trim());
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') done(true);
    else if (e.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(true));
  container.replaceChildren(input);
  input.focus();
  input.select();
}

/* ------------------------------- 会话列表 ------------------------------- */

/** 分组视图：未分组在前，具名分组按名称排序在后 */
function groupSessions(sessions) {
  const ungrouped = sessions.filter((s) => !s.group);
  const groups = new Map();
  for (const s of sessions) {
    if (!s.group) continue;
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  return { ungrouped, groups: [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh')) };
}

function renderSidebar() {
  const list = $('sessionList');
  list.innerHTML = '';
  $('sideEmpty').classList.toggle('is-hidden', state.sessions.length > 0);

  const { ungrouped, groups } = groupSessions(state.sessions);

  for (const s of ungrouped) list.appendChild(sessionRow(s));

  for (const [name, items] of groups) {
    const collapsed = !!state.collapsed[name];
    const head = el('div', 'group-head');
    const arrow = el('span', 'group-arrow', collapsed ? '▸' : '▾');
    head.appendChild(arrow);
    head.appendChild(el('span', 'group-name', name));
    head.appendChild(el('span', 'group-count', String(items.length)));
    head.title = '点击折叠 / 展开 · 双击重命名分组';
    head.addEventListener('click', () => {
      state.collapsed[name] = !collapsed;
      renderSidebar();
    });
    head.addEventListener('dblclick', () => {
      // 重命名分组 = 把组内全部会话改到新组名
      inlineEdit(head.querySelector('.group-name'), name, (next) => {
        if (!next || next === name) return renderSidebar();
        for (const s of items) api.qaSetGroup({ id: s.id, group: next }).catch(() => {});
      });
    });
    list.appendChild(head);
    if (!collapsed) {
      for (const s of items) list.appendChild(sessionRow(s));
    }
  }
}

function sessionRow(s) {
  const row = el('div', 'sess' + (s.id === state.activeId ? ' on' : ''));
  row.title = `${s.label} · ${s.count} 篇 · ${s.turns} 轮对话`;

  const avatar = el('div', 'sess-avatar');
  avatar.style.background = avatarColor(s.id);
  avatar.textContent = firstChar(s.label);

  const main = el('div', 'sess-main');
  const top = el('div', 'sess-top');
  top.appendChild(el('span', 'sess-name', s.label));
  top.appendChild(el('span', 'sess-time', fmtTime(s.at)));
  main.appendChild(top);
  main.appendChild(el('span', 'sess-last', s.lastMsg || `${s.count} 篇 · ${s.turns} 轮`));

  row.appendChild(avatar);
  row.appendChild(main);
  row.addEventListener('click', () => switchSession(s.id));
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openCtxMenu(e, s);
  });
  return row;
}

/* ------------------------------- 右键菜单 ------------------------------- */

let ctxTarget = null;

function openCtxMenu(e, session) {
  ctxTarget = session;
  const menu = $('ctxMenu');
  menu.classList.remove('is-hidden');
  const x = Math.min(e.clientX, window.innerWidth - 170);
  const y = Math.min(e.clientY, window.innerHeight - 160);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

function closeCtxMenu() {
  $('ctxMenu').classList.add('is-hidden');
  ctxTarget = null;
}

function bindCtxMenu() {
  document.addEventListener('click', closeCtxMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCtxMenu();
  });
  $('ctxMenu').addEventListener('click', (e) => e.stopPropagation());

  $('ctxRename').addEventListener('click', () => {
    const s = ctxTarget;
    closeCtxMenu();
    if (!s) return;
    // 找到当前行的名字元素，就地变成输入框
    const rows = [...document.querySelectorAll('.sess')];
    const row = rows.find((r) => r.title.startsWith(s.label));
    const nameEl = row && row.querySelector('.sess-name');
    if (nameEl) {
      inlineEdit(nameEl, s.label, (next) => {
        if (next && next !== s.label) api.qaRename({ id: s.id, name: next }).then(applyState).catch(() => {});
        else renderSidebar();
      });
    }
  });

  $('ctxGroup').addEventListener('click', () => {
    const s = ctxTarget;
    closeCtxMenu();
    if (!s) return;
    // sandbox 渲染层没有 window.prompt，用消息区顶部的轻量输入条
    const box = $('messages');
    const wrap = el('div', 'group-input-bar');
    const input = el('input', 'inline-edit wide');
    input.type = 'text';
    input.placeholder = '输入分组名，回车确认';
    input.maxLength = 20;
    wrap.appendChild(input);
    box.prepend(wrap);
    input.focus();
    const done = (commit) => {
      wrap.remove();
      if (commit && String(input.value || '').trim()) {
        api.qaSetGroup({ id: s.id, group: String(input.value).trim() }).then(applyState).catch(() => {});
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      else if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(false));
  });

  $('ctxUngroup').addEventListener('click', () => {
    const s = ctxTarget;
    closeCtxMenu();
    if (s) api.qaSetGroup({ id: s.id, group: '' }).then(applyState).catch(() => {});
  });

  $('ctxRemove').addEventListener('click', () => {
    const s = ctxTarget;
    closeCtxMenu();
    if (s) api.qaRemove(s.id).then(applyState).catch(() => {});
  });
}

/* ------------------------------- 会话切换 ------------------------------- */

async function switchSession(id) {
  if (id === state.activeId) return;
  try {
    const r = await api.qaSwitch(id);
    if (r && r.ok) applyState(r);
  } catch {
    /* 切换失败保持现状 */
  }
}

/* ------------------------------- 消息流 ------------------------------- */

function applyState(st) {
  if (!st) return;
  state.sessions = Array.isArray(st.sessions) ? st.sessions : [];
  state.activeId = st.activeId;
  state.history = Array.isArray(st.history) ? st.history : [];
  state.sources = st.sources || [];
  state.ready = !!st.ready;

  renderSidebar();
  renderMessages();

  const active = state.sessions.find((s) => s.id === state.activeId);
  $('chatTitle').textContent = active ? active.label : '论文问答';
}

function renderMessages() {
  const box = $('messages');
  box.innerHTML = '';

  if (!state.ready) {
    box.appendChild(el('div', 'msg-empty', '拖入 PDF 翻译，或点左上「添加文档」'));
    return;
  }

  for (const m of state.history) {
    if (!m || !m.content) continue;
    if (m.role === 'user') addUserMsg(m.content, { quiet: true });
    else addBotMsg({ text: m.content, quiet: true });
  }

  if (state.pending) addPendingMsg();
  scrollToEnd();
}

function addUserMsg(text, { quiet = false } = {}) {
  const row = el('div', 'msg me');
  row.appendChild(avatarNode('me', false));
  const bubble = el('div', 'bubble');
  bubble.textContent = text;
  row.appendChild(bubble);
  $('messages').appendChild(row);
  if (!quiet) scrollToEnd();
  return row;
}

function addBotMsg({ text, html, error, pending, quiet = false }) {
  const row = el('div', 'msg them');
  row.appendChild(avatarNode(state.activeId || 'pet', true));
  const bubble = el('div', 'bubble' + (error ? ' error' : '') + (pending ? ' pending' : ''));
  if (html) {
    const md = el('div', 'md');
    md.innerHTML = html; // 主进程 renderMarkdown 产出的白名单安全 HTML
    bubble.appendChild(md);
  } else {
    bubble.textContent = text || '';
  }
  row.appendChild(bubble);
  $('messages').appendChild(row);
  if (!quiet) scrollToEnd();
  return row;
}

function addPendingMsg() {
  return addBotMsg({ text: '正在翻论文…', pending: true, quiet: true });
}

function addSys(text) {
  $('messages').appendChild(el('div', 'sys', text));
  scrollToEnd();
}

function addCite(papers) {
  if (!Array.isArray(papers) || !papers.length) return;
  const line = el('div', 'cite', `引自 · ${papers.slice(0, 3).join('、')}${papers.length > 3 ? ' 等' : ''}`);
  $('messages').appendChild(line);
}

/* ------------------------------- 提问 ------------------------------- */

async function ask() {
  const input = $('input');
  const question = String(input.value || '').trim();
  if (!question || state.pending) return;

  input.value = '';
  addUserMsg(question);
  state.pending = true;
  const pending = addPendingMsg();
  $('btnSend').disabled = true;

  let res;
  try {
    res = await api.qaAsk({ question });
  } catch (err) {
    res = { ok: false, message: (err && err.message) || String(err) };
  }

  state.pending = false;
  $('btnSend').disabled = false;
  pending.remove();

  if (res && res.ok) {
    addBotMsg({ html: res.answerHtml, text: res.answer });
    addCite(res.citedPapers);
    if (Array.isArray(res.sources)) state.sources = res.sources;
  } else if (res && res.code === 'NO_CORPUS') {
    addSys('我还没读过论文。点左上「添加文档」或拖入 PDF。');
  } else if (res && res.code === 'BUSY') {
    addSys(res.message || '正忙，稍后再问。');
  } else {
    addBotMsg({ text: `没能回答：${(res && res.message) || '未知错误'}`, error: true });
  }
  input.focus();
}

/* ------------------------------- 文档导入 ------------------------------- */

async function pickDoc() {
  try {
    const files = await api.pickDoc();
    if (Array.isArray(files) && files.length) await loadDocs(files);
  } catch {
    /* 取消选择 */
  }
}

async function loadDocs(files) {
  let r;
  try {
    r = await api.qaLoadDoc({ files });
  } catch (err) {
    r = { ok: false, message: (err && err.message) || String(err) };
  }
  if (r && r.ok) {
    state.sources = r.sources || [];
    refreshState();
  } else {
    addSys((r && r.message) || '没能读到文档');
  }
}

/* ------------------------------- 任务 ------------------------------- */

function startJob(files) {
  api.startJob({ files }).then((r) => {
    if (r && r.code === 'NO_API_KEY') {
      addSys('还没配置翻译模型的 API Key。右键宠物完成配置后再来。');
    } else if (r && r.ok === false && r.message && !r.results) {
      addSys(`没能开工：${r.message}`);
    }
  }).catch((err) => {
    addSys(`没能开工：${(err && err.message) || err}`);
  });
}

function onJobProgress(e) {
  if (!e) return;
  const chip = $('jobChip');
  const percent = Number.isFinite(e.percent) ? `${Math.round(e.percent)}%` : '…';
  const line = `${e.stage === 'error' ? '出错' : '翻译中'} ${percent} · ${String(e.message || '').slice(0, 60)}`;
  chip.textContent = line;
  chip.title = e.message || '';
  chip.classList.remove('is-hidden');
  chip.classList.toggle('is-error', e.stage === 'error' || e.stage === 'paper-error');
}

function onJobResult(res) {
  if (!res) return;
  const chip = $('jobChip');
  setTimeout(() => chip.classList.add('is-hidden'), 2200);

  if (res.cancelled || res.message === '已取消') {
    addSys('已取消。已完成的产物不受影响。');
  }

  const results = Array.isArray(res.results) ? res.results : [];
  const done = results.filter((r) => !r.skipped && r.outDir);
  if (done.length) {
    const names = done.slice(0, 3).map((r) => `《${r.title || r.name}》`).join('、');
    addSys(`翻译完成 ${done.length} 篇：${names}${done.length > 3 ? ' 等' : ''}`);
  }
  if (res.failed) {
    addSys(`失败 ${res.failed} 篇：${(res.failures || []).map((f) => f.name).join('、')}`);
  }
}

/* ------------------------------- 拖放投喂 ------------------------------- */

let dragDepth = 0;

function onDragEnter(e) {
  e.preventDefault();
  dragDepth += 1;
  $('dropVeil').classList.remove('is-hidden');
}

function onDragOver(e) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}

function onDragLeave(e) {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('dropVeil').classList.add('is-hidden');
}

async function onDrop(e) {
  e.preventDefault();
  dragDepth = 0;
  $('dropVeil').classList.add('is-hidden');

  const list = (e.dataTransfer && e.dataTransfer.files) || [];
  const pdfs = [];
  const docs = [];
  for (const file of list) {
    let p = '';
    try {
      p = api.getFilePath(file);
    } catch {
      /* 回退 */
    }
    if (!p) continue;
    if (/\.pdf$/i.test(p)) pdfs.push(p);
    else if (/\.(md|markdown|txt|html?|docx)$/i.test(p)) docs.push(p);
  }

  if (pdfs.length) {
    startJob(pdfs); // 去重/补格式由主进程流水线处理
  }
  if (docs.length) {
    await loadDocs(docs);
  }
  if (!pdfs.length && !docs.length) {
    addSys('只认论文 PDF 与译文文档（md / txt / html / docx）。');
  }
}

/* ------------------------------- 侧栏宽度 ------------------------------- */

function applySidebarWidth(px) {
  const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, px));
  document.documentElement.style.setProperty('--side-w', `${w}px`);
  return w;
}

function bindSplitter() {
  const saved = Number(localStorage.getItem(SIDEBAR_KEY));
  applySidebarWidth(Number.isFinite(saved) && saved > 0 ? saved : 264);

  const splitter = $('splitter');
  let dragging = false;
  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    e.preventDefault();
    document.body.classList.add('resizing');
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    applySidebarWidth(e.clientX);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    const w = Number(document.documentElement.style.getPropertyValue('--side-w')) || 264;
    localStorage.setItem(SIDEBAR_KEY, String(w));
  });
}

/* ------------------------------- 启动 ------------------------------- */

async function refreshState() {
  try {
    const st = await api.qaState();
    applyState(st);
  } catch {
    /* 主进程尚未就绪 */
  }
}

function handleQaChanged(st) {
  // 新任务完成会自动切到新会话（activeId 变化）；仅刷新列表与标题，
  // 不打断正在输入的当前消息流。
  if (!st) return;
  const activeChanged = st.activeId !== state.activeId;
  state.sessions = Array.isArray(st.sessions) ? st.sessions : [];
  renderSidebar();
  if (activeChanged) {
    refreshState();
  } else {
    const active = state.sessions.find((s) => s.id === state.activeId);
    $('chatTitle').textContent = active ? active.label : '论文问答';
  }
}

async function boot() {
  // KaTeX 样式一次性注入（回答里公式排版用；缺失时降级为纯文本回答）
  try {
    const assets = await api.chatReady();
    if (assets && assets.katexCss) {
      const style = document.createElement('style');
      style.textContent = assets.katexCss;
      document.head.appendChild(style);
    }
  } catch {
    /* 样式注入失败不影响纯文本问答 */
  }

  // 宠物并入聊天窗：头部显示同款幽灵
  $('headPet').innerHTML = GHOST_SVG;

  await refreshState();

  api.onQaChanged(handleQaChanged);
  api.onProgress(onJobProgress);
  api.onJobResult(onJobResult);

  $('btnSend').addEventListener('click', ask);
  $('btnAddDoc').addEventListener('click', pickDoc);
  $('btnClose').addEventListener('click', () => api.chatHide());
  $('btnMinimize').addEventListener('click', () => api.chatMinimize());

  bindCtxMenu();
  bindSplitter();

  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  });
  // 输入框自适应高度（微信式，最多 120px）
  $('input').addEventListener('input', () => {
    const input = $('input');
    input.style.height = 'auto';
    input.style.height = Math.min(120, input.scrollHeight) + 'px';
  });

  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);

  $('input').focus();

  // 调试探针：chat-smoke 用它确认界面加载完成
  window.__chatReady = true;
}

boot().catch((err) => {
  addSys(`界面初始化失败：${(err && err.message) || err}`);
});
