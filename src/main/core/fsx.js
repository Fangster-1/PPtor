'use strict';

/**
 * 文件系统辅助工具（零 Electron 依赖，selftest 可直接测）
 *
 * 解决两个工程问题：
 *  1. JSON 数据文件「写一半崩溃 → 文件损坏 → 下次启动被静默重置」
 *     → 原子写：先写临时文件再 rename（Windows 上 Node 的 rename 会替换目标）
 *  2. 主进程同步大 IO 会阻塞事件循环，桌宠动画掉帧
 *     → 目录复制 / 递归删除全部异步化，由各业务模块替换原同步实现
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

let tmpSeq = 0;

/** 生成同目录下的临时文件名（点前缀 + 进程号 + 序号，避免并发冲突） */
function tmpName(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${++tmpSeq}.tmp`);
}

/**
 * 原子写 JSON（异步）：写入期间崩溃时磁盘上要么是完整旧文件要么是完整新文件
 * @param {string} file 目标路径
 * @param {*} data 会被 JSON.stringify 的对象
 */
async function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = tmpName(file);
  try {
    await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    try {
      await fsp.unlink(tmp);
    } catch {
      /* 清理失败无妨 */
    }
    throw err;
  }
}

/** 原子写 JSON（同步）：给必须保持同步语义的小文件（settings.json）用 */
function writeJsonAtomicSync(file, data) {
  writeTextAtomicSync(file, JSON.stringify(data));
}

/** 原子写文本（同步）：全仓唯一的同步文本原子写实现 */
function writeTextAtomicSync(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = tmpName(file);
  try {
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, file);
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* 忽略清理失败，保留主错误 */
    }
    throw err;
  }
}

/** 原子写任意内容（异步）：文本/二进制通用，全仓唯一实现 */
async function writeFileAtomic(filePath, data, encoding) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = tmpName(filePath);
  try {
    await fsp.writeFile(tmp, data, encoding);
    await fsp.rename(tmp, filePath);
  } catch (err) {
    try {
      await fsp.unlink(tmp);
    } catch {
      /* 临时文件清理失败不覆盖原始错误 */
    }
    throw err;
  }
}

/** 异步递归复制目录内容 */
async function copyDir(fromDir, toDir) {
  await fsp.mkdir(toDir, { recursive: true });
  for (const entry of await fsp.readdir(fromDir, { withFileTypes: true })) {
    const src = path.join(fromDir, entry.name);
    const dst = path.join(toDir, entry.name);
    if (entry.isDirectory()) await copyDir(src, dst);
    else await fsp.copyFile(src, dst);
  }
}

/** 异步递归删除（临时目录可能含大量图片，同步 rm 会卡住主进程） */
async function rm(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

module.exports = { writeJsonAtomic, writeJsonAtomicSync, writeTextAtomicSync, writeFileAtomic, copyDir, rm, tmpName };
