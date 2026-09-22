'use strict';

/**
 * 桌宠资源加载器 —— 兼容 Codex Pet 格式
 *
 * Codex Pet 规范（官方 sprite contract）：
 *   目录结构   <pet>/pet.json + <pet>/spritesheet.webp
 *   精灵图     1536 × 1872，8 列 × 9 行，每格 192 × 208，透明背景
 *   9 行状态   idle / running-right / running-left / waving / jumping /
 *              failed / waiting / running / review
 *   每行只用前 N 帧，其后的格子必须完全透明
 *
 * 本加载器同时兼容两种扩展写法：
 *   - pet.json 带 animations 字段（desktop-pet-app / Mate 等格式）→ 按它解析
 *   - pet.json 只有基本字段（官方 Codex Pet）→ 用下面的默认 9 行表
 * 图片格式不限 png / webp，Electron 都能解。
 *
 * 注意：宠物只从随包分发的 pets/ 目录读取，不扫描用户目录，
 *      也不支持切换 —— 应用只用内置的这一只。
 */
const fs = require('node:fs');
const path = require('node:path');

const { builtinPetsDir } = require('../paths');

/** Codex Pet 官方精灵图规格 */
const SPRITE_SPEC = {
  cellWidth: 192,
  cellHeight: 208,
  columns: 8,
  rows: 9,
  totalWidth: 1536,
  totalHeight: 1872
};

/** 官方 9 行状态表（row / 帧数 / 播放速度） */
const DEFAULT_STATES = [
  { id: 'idle', row: 0, frames: 6, fps: 6, loop: true },
  { id: 'running-right', row: 1, frames: 8, fps: 10, loop: true },
  { id: 'running-left', row: 2, frames: 8, fps: 10, loop: true },
  { id: 'waving', row: 3, frames: 4, fps: 6, loop: true },
  { id: 'jumping', row: 4, frames: 5, fps: 8, loop: false },
  { id: 'failed', row: 5, frames: 8, fps: 6, loop: true },
  { id: 'waiting', row: 6, frames: 6, fps: 4, loop: true },
  { id: 'running', row: 7, frames: 6, fps: 12, loop: true },
  { id: 'review', row: 8, frames: 6, fps: 5, loop: true }
];

const IMAGE_EXT = /\.(png|webp|jpe?g|gif|apng|svg)$/i;

// 资源只读且随包分发，进程内缓存可以避免菜单/重载触发重复目录扫描和
// 大图 base64 编码；这对启动后的首次交互延迟也更友好。
let petListCache = null;
const petResourceCache = new Map();

/* ================================================================== *
 * 扫描
 * ================================================================== */

/** 收集某个目录下的所有宠物包 */
function scanDir(baseDir) {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(baseDir, entry.name);
    const manifestPath = path.join(dir, 'pet.json');

    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      continue; // 没有 pet.json 或格式错误，跳过
    }

    const spritesheetName = manifest.spritesheetPath || manifest.spritesheet || 'spritesheet.webp';
    let spritesheetPath = path.join(dir, spritesheetName);

    if (!fs.existsSync(spritesheetPath)) {
      // 清单里的文件名对不上时，退而求其次：目录里找第一张图
      const img = fs.readdirSync(dir).find((f) => IMAGE_EXT.test(f) && f !== 'index.png');
      if (!img) continue;
      spritesheetPath = path.join(dir, img);
    }

    found.push({
      id: manifest.id || entry.name,
      dirName: entry.name,
      displayName: manifest.displayName || manifest.name || entry.name,
      description: manifest.description || '',
      accent: manifest.accent || '#8b7bf0',
      manifest,
      dir,
      spritesheetPath
    });
  }
  return found;
}

/**
 * 列出可用宠物（只含随包分发的内置宠物）。
 * 返回数组是为了保留多宠物时的扩展余地，当前应用只用第一只。
 */
function listPets() {
  if (!petListCache) {
    petListCache = scanDir(builtinPetsDir()).sort((a, b) => a.dirName.localeCompare(b.dirName));
  }
  return petListCache;
}

/* ================================================================== *
 * 加载
 * ================================================================== */

function resolveStates(manifest) {
  const animations = manifest && manifest.animations;

  // 扩展格式：manifest 自带动画定义
  if (animations && typeof animations === 'object' && !Array.isArray(animations)) {
    const list = Object.entries(animations).map(([id, def], index) => ({
      id,
      row: Number.isInteger(def.row) ? def.row : index,
      frames: Number.isFinite(def.frames) ? def.frames : (def.count || 6),
      fps: Number.isFinite(def.fps) ? def.fps : 8,
      loop: def.loop !== false
    }));
    if (list.length) return list;
  }

  // 官方 Codex Pet：固定 9 行
  return DEFAULT_STATES;
}

/**
 * 读取一个宠物，返回给渲染进程可直接使用的数据。
 * 精灵图以 data URL 形式内嵌 —— 免去自定义协议，渲染层一个 <img> 即可。
 */
function loadPet(idOrDirName) {
  const pets = listPets();
  if (!pets.length) throw new Error('未找到任何宠物资源，请检查 pets/ 目录');

  const pet = idOrDirName
    ? pets.find((p) => p.dirName === idOrDirName || p.id === idOrDirName)
    : pets[0];

  if (!pet) throw new Error(`未找到宠物：${idOrDirName}`);

  const cacheKey = pet.id || pet.dirName;
  if (petResourceCache.has(cacheKey)) return petResourceCache.get(cacheKey);

  const buf = fs.readFileSync(pet.spritesheetPath);
  const ext = path.extname(pet.spritesheetPath).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;

  let previewDataUrl = null;
  const previewPath = path.join(pet.dir, 'index.png');
  if (fs.existsSync(previewPath)) {
    previewDataUrl = `data:image/png;base64,${fs.readFileSync(previewPath).toString('base64')}`;
  }

  const loaded = {
    id: pet.id,
    dirName: pet.dirName,
    displayName: pet.displayName,
    description: pet.description,
    accent: pet.accent,
    spec: SPRITE_SPEC,
    states: resolveStates(pet.manifest),
    spritesheetDataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    previewDataUrl,
    sourceDir: pet.dir
  };
  petResourceCache.set(cacheKey, loaded);
  return loaded;
}

module.exports = { listPets, loadPet, SPRITE_SPEC, DEFAULT_STATES };
