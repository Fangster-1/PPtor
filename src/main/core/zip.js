'use strict';

/**
 * 轻量 ZIP 解压模块，支持 store(0) 与 deflate(8) 格式
 */
const zlib = require('node:zlib');

const SIG_EOCD = 0x06054b50; // End of Central Directory
const SIG_CENTRAL = 0x02014b50; // Central Directory File Header
const SIG_LOCAL = 0x04034b50; // Local File Header

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 10000,
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalBytes: 768 * 1024 * 1024
});

/** 从尾部反向查找 EOCD 记录（注释最长 65535 字节） */
function findEOCD(buf) {
  const lowerBound = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= lowerBound; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 解压 ZIP Buffer
 * @param {Buffer} buffer
 * @returns {Array<{name: string, data: Buffer, size: number}>}
 */
function assertRange(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`ZIP 结构越界：${label}`);
  }
}

function unzip(buffer, limits = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error('ZIP 输入必须是 Buffer');
  const options = { ...DEFAULT_LIMITS, ...limits };
  const eocd = findEOCD(buffer);
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到 EOCD 记录）');
  assertRange(buffer, eocd, 22, 'EOCD');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (entryCount > options.maxEntries) throw new Error(`ZIP 条目过多（${entryCount}，上限 ${options.maxEntries}）`);
  const entries = [];
  let totalBytes = 0;

  for (let i = 0; i < entryCount; i++) {
    assertRange(buffer, offset, 46, `中央目录第 ${i + 1} 项`);
    if (buffer.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new Error(`ZIP 中央目录损坏（第 ${i + 1} 项）`);
    }

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    assertRange(buffer, offset + 46, nameLen + extraLen + commentLen, `中央目录第 ${i + 1} 项内容`);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    if (uncompressedSize > options.maxEntryBytes || totalBytes + uncompressedSize > options.maxTotalBytes) {
      throw new Error(`ZIP 解压内容超过安全上限：${name || `第 ${i + 1} 项`}`);
    }

    // 用「本地头」重新计算数据起始位置：本地头的 name/extra 长度可能和中央目录不同
    assertRange(buffer, localOffset, 30, `本地头 ${name}`);
    if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`ZIP 本地头损坏：${name}`);
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    assertRange(buffer, dataStart, compressedSize, `压缩数据 ${name}`);
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === METHOD_STORE) {
      data = Buffer.from(raw);
    } else if (method === METHOD_DEFLATE) {
      data = zlib.inflateRawSync(raw, { maxOutputLength: options.maxEntryBytes });
    } else {
      // 罕见压缩方式（bzip2 / lzma 等）直接跳过，不影响主流程
      offset += 46 + nameLen + extraLen + commentLen;
      continue;
    }

    if (uncompressedSize && data.length !== uncompressedSize) {
      console.warn(`[zip] ${name} 解压后长度不符（期望 ${uncompressedSize}，实际 ${data.length}）`);
    }
    if (data.length > options.maxEntryBytes || totalBytes + data.length > options.maxTotalBytes) {
      throw new Error(`ZIP 解压内容超过安全上限：${name || `第 ${i + 1} 项`}`);
    }

    entries.push({ name, data, size: data.length });
    totalBytes += data.length;
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/** 从条目里按文件名后缀取内容（忽略目录层级） */
function findBySuffix(entries, suffix) {
  const hit = entries.find((e) => e.name.toLowerCase().endsWith(suffix.toLowerCase()));
  return hit || null;
}

module.exports = { unzip, findBySuffix, DEFAULT_LIMITS };
