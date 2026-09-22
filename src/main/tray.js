'use strict';

/**
 * 系统托盘
 * 宠物被隐藏或误关时，托盘是回到应用的入口。
 */
const fs = require('node:fs');
const { Tray, Menu, nativeImage } = require('electron');

const { assetPath } = require('./paths');

let tray = null;

function loadIcon() {
  const candidates = [assetPath('tray.png'), assetPath('icon.png')];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  }
  return nativeImage.createEmpty();
}

function createTray(ctx) {
  tray = new Tray(loadIcon());
  tray.setToolTip('PPtor · 拖入 PDF 即可翻译 · 单击托盘召回宠物');
  tray.setContextMenu(Menu.buildFromTemplate(ctx.buildTrayMenu()));
  tray.on('click', () => ctx.onShowPet());
  tray.on('double-click', () => ctx.onShowPet());
  return tray;
}

function refreshTray(ctx) {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(ctx.buildTrayMenu()));
}

function getTray() {
  return tray;
}

module.exports = { createTray, refreshTray, getTray };
