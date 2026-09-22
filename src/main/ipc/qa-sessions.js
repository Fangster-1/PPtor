'use strict';

/**
 * 问答多会话存储（从 ipc.js 抽出，工厂化后可独立单测）。
 * 每个翻译任务 / 文档导入形成独立会话，各自保留论文集与对话历史。
 *
 * 会话操作：切换 / 重命名 / 删除 / 分组。
 * 约束：不创建空会话——每个会话必须至少有一篇译文文档。
 * 持久化：会话元数据（id/label/group/sources/at）存 config/qa-sessions.json；
 * 重启后从译文库（平铺目录）按文件名重新读回语料，读不回的会话自动淘汰。
 */
const fs = require('node:fs');
const path = require('node:path');

const qa = require('../core/qa');
const { dataFile } = require('../paths');
const { writeJsonAtomic } = require('../core/fsx');
const { loadPapersFromFiles } = require('./doc-loader');

const MAX_QA_SESSIONS = 8;

function createQaSessionStore({ broadcast }) {
  let sessions = [];
  let activeId = null;
  let persistTimer = null;

  /* ---------------------------- 持久化 ---------------------------- */

  function sessionsFile() {
    return dataFile('qa-sessions.json');
  }

  function persistSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(async () => {
      persistTimer = null;
      try {
        await writeJsonAtomic(sessionsFile(), {
          version: 1,
          sessions: sessions.map((s) => ({
            id: s.id,
            label: s.label || '',
            group: s.group || '',
            sources: s.sources || [],
            at: s.at || 0
          }))
        });
      } catch (err) {
        console.warn('[qa-sessions] 会话元数据保存失败：', err.message);
      }
    }, 600);
  }

  /**
   * 重启恢复：按持久化的来源文件名，从译文库（平铺目录）读回语料。
   * 读不回任何一篇的会话直接淘汰，保证“每个会话都有文档”。
   */
  async function restoreSessions() {
    let saved = [];
    try {
      const raw = JSON.parse(await fs.promises.readFile(sessionsFile(), 'utf8'));
      if (Array.isArray(raw.sessions)) saved = raw.sessions;
    } catch {
      /* 首次运行或文件损坏 → 空清单 */
    }
    if (!saved.length) return;

    const library = require('../core/library');
    const libRoot = library.root();
    const restored = [];
    for (const item of saved.slice(0, MAX_QA_SESSIONS)) {
      if (!item || !Array.isArray(item.sources) || !item.sources.length) continue;
      const files = item.sources
        .map((name) => path.join(libRoot, path.basename(String(name))))
        .filter((f) => fs.existsSync(f));
      if (!files.length) continue;
      try {
        const { papers } = await loadPapersFromFiles(files);
        if (!papers.length) continue;
        const session = {
          id: item.id || `qa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          papers,
          corpus: qa.buildCorpus(papers),
          history: [],
          sources: papers.map((p) => p.name),
          label: item.label || '',
          group: item.group || '',
          lastMsg: '',
          at: item.at || 0
        };
        restored.push(session);
      } catch {
        /* 单个会话恢复失败跳过 */
      }
    }
    if (restored.length) {
      sessions = restored.sort((a, b) => (b.at || 0) - (a.at || 0));
      activeId = sessions[0].id;
      broadcastChanged();
    }
  }
  restoreSessions().catch(() => { /* 恢复失败按无会话启动 */ });

  /* ---------------------------- 基础操作 ---------------------------- */

  function active() {
    return sessions.find((s) => s.id === activeId) || null;
  }

  function sessionLabel(session) {
    if (session.label) return session.label;
    const names = session.sources || [];
    const first = String(names[0] || '').replace(/\.md$/i, '');
    return names.length > 1 ? `${first.slice(0, 14)} 等${names.length}篇` : first.slice(0, 16);
  }

  /** 渲染层可见的会话状态（含当前会话最近对话，供聊天窗回放） */
  function publicState() {
    const cur = active();
    return {
      ready: !!(cur && cur.corpus),
      sources: cur ? cur.sources : [],
      turns: cur ? Math.floor(cur.history.length / 2) : 0,
      history: cur ? cur.history.slice(-12) : [],
      activeId,
      sessions: sessions.map((s) => ({
        id: s.id,
        label: sessionLabel(s),
        group: s.group || '',
        count: s.sources.length,
        turns: Math.floor(s.history.length / 2),
        at: s.at || 0,
        ready: !!(s.corpus && s.corpus.docs && s.corpus.docs.length),
        lastMsg: s.lastMsg || ''
      }))
    };
  }

  function broadcastChanged() {
    broadcast('qa:changed', publicState());
  }

  /** 新建会话：必须带至少一篇文档，否则不创建 */
  function createSession(papers) {
    if (!papers || !papers.length) return null;
    const session = {
      id: `qa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      papers,
      corpus: qa.buildCorpus(papers),
      history: [],
      sources: papers.map((p) => p.name),
      label: '',
      group: '',
      lastMsg: '',
      at: Date.now()
    };
    sessions.unshift(session);
    if (sessions.length > MAX_QA_SESSIONS) sessions.length = MAX_QA_SESSIONS;
    activeId = session.id;
    persistSoon();
    broadcastChanged();
    return session;
  }

  /** 追加论文（同名去重）到当前会话；没有会话时自动新建（文档为空则不建） */
  function addPapers(papers) {
    const cur = active();
    if (!cur) return createSession(papers)?.sources || [];
    const existing = cur.papers || [];
    const seen = new Set(existing.map((p) => p.name));
    const merged = [...existing, ...papers.filter((p) => !seen.has(p.name))];
    if (merged.length !== existing.length) {
      cur.papers = merged;
      cur.corpus = qa.buildCorpus(merged);
      cur.sources = merged.map((p) => p.name);
      persistSoon();
      broadcastChanged();
    }
    return cur.sources;
  }

  function switchTo(id) {
    const hit = sessions.find((s) => s.id === id);
    if (!hit) return null;
    activeId = hit.id;
    broadcastChanged();
    return publicState();
  }

  /** 重命名会话 */
  function rename(id, name) {
    const hit = sessions.find((s) => s.id === id);
    if (!hit) return false;
    hit.label = String(name || '').trim().slice(0, 40);
    persistSoon();
    broadcastChanged();
    return true;
  }

  /** 删除会话；若删的是当前会话，切到最近的剩余会话 */
  function remove(id) {
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    sessions.splice(idx, 1);
    if (activeId === id) {
      activeId = sessions.length ? sessions[0].id : null;
    }
    persistSoon();
    broadcastChanged();
    return true;
  }

  /** 设置 / 清除会话分组（group 为空串表示未分组） */
  function setGroup(id, group) {
    const hit = sessions.find((s) => s.id === id);
    if (!hit) return false;
    hit.group = String(group || '').trim().slice(0, 20);
    persistSoon();
    broadcastChanged();
    return true;
  }

  function resetActive() {
    const cur = active();
    if (cur) {
      cur.papers = [];
      cur.corpus = null;
      cur.history = [];
      cur.sources = [];
      cur.lastMsg = '';
      broadcastChanged();
    }
  }

  /** 问答成功后更新会话侧栏预览（最后一条消息摘要） */
  function noteAnswer(text) {
    const cur = active();
    if (cur) cur.lastMsg = String(text || '').slice(0, 80);
  }

  function shutdown() {
    sessions = [];
    activeId = null;
  }

  return { active, publicState, createSession, addPapers, switchTo, rename, remove, setGroup, resetActive, noteAnswer, broadcastChanged, shutdown };
}

module.exports = { createQaSessionStore, MAX_QA_SESSIONS };
