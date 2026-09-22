'use strict';

/**
 * 托盘状态指示点（从 main.js 拆出的纯图形工具）：
 * 用 zlib + CRC32 手工编码 16×16 抗锯齿圆点 PNG，作为原生菜单项图标。
 */
const zlib = require('node:zlib');
const { nativeImage } = require('electron');

function createMicroDotNativeImage(r, g, b, a = 255) {
  const w = 16, h = 16;
  const raw = Buffer.alloc(h * (1 + w * 4));
  const cx = 7.5, cy = 7.5;
  const innerR = 1.6;
  const outerR = 2.4;
  for (let y = 0; y < h; y++) {
    const rowOffset = y * (1 + w * 4);
    raw[rowOffset] = 0;
    for (let x = 0; x < w; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      const dist = Math.hypot(x - cx, y - cy);
      if (dist <= innerR) {
        raw[pxOffset] = r;
        raw[pxOffset + 1] = g;
        raw[pxOffset + 2] = b;
        raw[pxOffset + 3] = a;
      } else if (dist < outerR) {
        const factor = (outerR - dist) / (outerR - innerR);
        raw[pxOffset] = r;
        raw[pxOffset + 1] = g;
        raw[pxOffset + 2] = b;
        raw[pxOffset + 3] = Math.round(a * factor);
      }
    }
  }
  const idat = zlib.deflateSync(raw);
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1));
    crcTable[n] = c;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeAndData = Buffer.concat([Buffer.from(type), data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([len, typeAndData, crcBuf]);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
  return nativeImage.createFromBuffer(png);
}

let trayDotIcons = null;

/** 状态 → 圆点图标（ok 绿 / error 红 / unconfigured 黄 / 其余灰） */
function getTrayDotIcon(status) {
  if (!trayDotIcons) {
    trayDotIcons = {
      ok: createMicroDotNativeImage(34, 197, 94),          // 绿 #22c55e
      error: createMicroDotNativeImage(239, 68, 68),       // 红 #ef4444
      unconfigured: createMicroDotNativeImage(234, 179, 8),// 黄 #eab308
      gray: createMicroDotNativeImage(156, 163, 175)       // 灰 #9ca3af (测试中或未连接)
    };
  }
  if (status === 'ok') return trayDotIcons.ok;
  if (status === 'error') return trayDotIcons.error;
  if (status === 'unconfigured') return trayDotIcons.unconfigured;
  return trayDotIcons.gray;
}

module.exports = { createMicroDotNativeImage, getTrayDotIcon };
