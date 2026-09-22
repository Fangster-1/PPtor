'use strict';

/**
 * 统一路径管理
 *
 * 设计原则：所有用户数据都在「软件根目录」，符合绿色部署习惯 ——
 *   便携版  → exe 所在目录
 *   开发时  → 项目根目录
 * 这样把整个文件夹拷到 U 盘，配置、缓存、产物全部跟着走。
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

let cacheRoot = null;
const IS_SMOKE = process.argv.includes('--smoke');

/**
 * 自检必须和用户数据完全隔离。PPTOR_DATA_DIR 只在 --smoke 下生效，
 * 避免打包后的自检误写真实 config/cache/translated。
 */
function configuredDataRoot() {
  if (!IS_SMOKE) return '';
  const value = String(process.env.PPTOR_DATA_DIR || '').trim();
  return value ? path.resolve(value) : path.join(require('node:os').tmpdir(), 'pptor-smoke', String(process.pid));
}

function root() {
  if (cacheRoot) return cacheRoot;

  const isolated = configuredDataRoot();
  if (isolated) {
    cacheRoot = isolated;
    return cacheRoot;
  }

  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    // electron-builder 的 portable 目标注入，指向 exe 所在目录
    cacheRoot = process.env.PORTABLE_EXECUTABLE_DIR;
  } else if (app && app.isPackaged) {
    const exeDir = path.dirname(app.getPath('exe'));
    const parentDir = path.dirname(exeDir);
    if (path.basename(exeDir).toLowerCase() === 'win-unpacked' && fs.existsSync(path.join(parentDir, 'config', 'settings.json'))) {
      cacheRoot = parentDir;
    } else {
      cacheRoot = exeDir;
    }
  } else {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const rootConfig = path.join(projectRoot, 'config', 'settings.json');
    const distConfig = path.join(projectRoot, 'dist', 'config', 'settings.json');
    if (!fs.existsSync(rootConfig) && fs.existsSync(distConfig)) {
      cacheRoot = path.join(projectRoot, 'dist');
    } else {
      cacheRoot = projectRoot;
    }
  }
  return cacheRoot;
}

function ensure(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 只读目录时忽略，后续写入会各自报错 */
  }
  return dir;
}

module.exports = {
  root,
  isSmoke: () => IS_SMOKE,

  configFile: () => path.join(ensure(path.join(root(), 'config')), 'settings.json'),

  /** config 目录下的任意数据文件（翻译记录等），与 settings.json 同级 */
  dataFile: (name) => path.join(ensure(path.join(root(), 'config')), name),

  /** 随应用分发的内置宠物（打包后在 asar 内，只读） */
  builtinPetsDir: () => path.join(app.getAppPath(), 'pets'),

  cacheDir: () => ensure(path.join(root(), 'cache')),

  /** 宠物资源（托盘图标等）随包分发 */
  assetPath: (...parts) => path.join(app.getAppPath(), 'assets', ...parts)
};
