'use strict';

/* 全局状态与基础工具（pet/*.js 为经典脚本，共享全局作用域） */

const $ = (id) => document.getElementById(id);
const api = window.pt;

const state = {
  config: null,
  env: null,
  pet: null,
  spec: null,
  states: new Map(),
  scale: 1,
  anim: 'idle',
  askOpen: false,
  lastAsk: null,
  pendingQueue: [],
  busy: false,
  task: {
    runId: 0,
    phase: 'idle',
    resumePhase: 'idle',
    progress: 0,
    phasePercent: null,
    phaseIndeterminate: true,
    message: '',
    waiting: false,
    cancelRequested: false
  },
  animSource: 'ambient',
  animToken: 0,
  dragging: null,
  ignoring: null,
  onboardingNotice: false,
  dragDepth: 0,
  lastOutDir: null,
  pendingFiles: null, // 因「没配 Key」被拦下的文件，配好后自动接着翻
  lastTranslatedFiles: [] // 最近翻译完成的论文文件路径，用于重新修改排版后重新排版
};

/** 最近一次鼠标位置（client 坐标）：拖动结束后补算鼠标穿透用 */
let lastMouseClient = { x: -1, y: -1 };

function basename(p) {
  return String(p).split(/[\\/]/).pop();
}

function pathExtension(p) {
  const match = basename(p).match(/\.[^.]+$/);
  return match ? match[0].toLowerCase() : '';
}
