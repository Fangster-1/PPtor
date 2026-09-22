'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, cb) {
  const handler = (_evt, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

/**
 * 渲染进程（宠物界面）唯一的安全出口。
 * 只暴露白名单方法，前端碰不到 Node 与文件系统。
 */
contextBridge.exposeInMainWorld('pt', {
  /**
   * 拖入的 File 对象 → 磁盘绝对路径。
   * Electron 32 起移除了 File.path，必须走 webUtils.getPathForFile。
   */
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  /* 配置 */
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  testApi: (api) => ipcRenderer.invoke('config:testApi', api),
  listModels: (api) => ipcRenderer.invoke('config:listModels', api),
  checkModelConnectivity: () => ipcRenderer.invoke('connectivity:checkModel'),
  checkParserConnectivity: () => ipcRenderer.invoke('connectivity:checkParser'),
  getConnectivityStatus: () => ipcRenderer.invoke('connectivity:status'),
  setConnectivityStatus: (payload) => ipcRenderer.invoke('connectivity:setStatus', payload),
  connectivityReady: () => ipcRenderer.invoke('connectivity:rendererReady'),

  /* 宠物 */
  loadPet: (id) => ipcRenderer.invoke('pet:load', id),
  moveBy: (dx, dy) => ipcRenderer.send('pet:moveBy', { dx, dy }),
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:setIgnoreMouse', ignore),
  setPetScale: (scale) => ipcRenderer.send('pet:setScale', scale),
  contextMenu: () => ipcRenderer.invoke('pet:contextMenu'),
  hide: () => ipcRenderer.send('pet:hide'),
  setVisible: (visible) => ipcRenderer.invoke('pet:setVisibility', visible),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('pet:alwaysOnTop', !!on),
  bringToTop: () => ipcRenderer.invoke('pet:bringToTop'),
  quitApp: () => ipcRenderer.send('app:quit'),
  petBounds: () => ipcRenderer.invoke('pet:bounds'),
  onPetBounds: (cb) => subscribe('pet:bounds', cb),
  petPointer: () => ipcRenderer.invoke('pet:pointer'),
  onPetPointer: (cb) => subscribe('pet:pointer', cb),

  /* 环境与文件 */
  detectEnv: () => ipcRenderer.invoke('env:detect'),
  pickPdf: (opts) => ipcRenderer.invoke('dialog:pickPdf', opts),
  pickDoc: () => ipcRenderer.invoke('dialog:pickDoc'),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),

  /* 剪贴板（粘贴读取） */
  readClipboardFiles: (allowedExt) => ipcRenderer.invoke('clipboard:readFiles', allowedExt),

  /* 回答主进程抛出的确认问题 */
  answer: (value) => ipcRenderer.invoke('ui:answer', value),

  /* 任务（支持批量：files 数组） */
  startJob: (payload) => ipcRenderer.invoke('job:start', payload),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),
  isBusy: () => ipcRenderer.invoke('job:busy'),

  /* 问答聊天窗口（微信式：会话列表 + 聊天气泡，可拖动可缩放） */
  chatToggle: () => ipcRenderer.invoke('chat:toggle'),
  chatHide: () => ipcRenderer.send('chat:hide'),
  chatMinimize: () => ipcRenderer.send('chat:minimize'),
  chatReady: () => ipcRenderer.invoke('chat:ready'),
  onJobResult: (cb) => subscribe('job:result', cb),

  /* 去重记录 */
  checkRegistry: (files) => ipcRenderer.invoke('registry:check', files),
  listRegistry: () => ipcRenderer.invoke('registry:list'),
  forgetRegistry: (file) => ipcRenderer.invoke('registry:forget', file),

  /* 论文问答 */
  qaAsk: (payload) => ipcRenderer.invoke('qa:ask', payload),
  qaLoadDoc: (payload) => ipcRenderer.invoke('qa:loadDoc', payload),
  qaSwitch: (id) => ipcRenderer.invoke('qa:switch', id),
  qaRename: (payload) => ipcRenderer.invoke('qa:rename', payload),
  qaRemove: (id) => ipcRenderer.invoke('qa:remove', id),
  qaSetGroup: (payload) => ipcRenderer.invoke('qa:setGroup', payload),
  onQaChanged: (cb) => subscribe('qa:changed', cb),
  matchLibrary: (filePath) => ipcRenderer.invoke('library:match', filePath),
  listLibrary: () => ipcRenderer.invoke('library:list'),
  qaState: () => ipcRenderer.invoke('qa:state'),
  qaReset: () => ipcRenderer.invoke('qa:reset'),

  /* 产物 */
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  revealPath: (p) => ipcRenderer.invoke('shell:revealPath', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  /* 主进程推送 */
  onProgress: (cb) => subscribe('job:progress', cb),
  onAction: (cb) => subscribe('pet:action', cb)
});
