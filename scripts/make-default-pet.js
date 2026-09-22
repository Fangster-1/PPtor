'use strict';

/**
 * 生成默认桌宠资源（符合 Codex Pet 格式规范）
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/* ================================================================== *
 * Codex Pet 精灵图契约
 * ================================================================== */
const CELL_W = 192;
const CELL_H = 208;
const COLS = 8;
const ROWS = 9;
const W = CELL_W * COLS; // 1536
const H = CELL_H * ROWS; // 1872

const ROW_SPEC = [
  { id: 'idle', frames: 6 }, //          0 静止呼吸、偶尔眨眼
  { id: 'running-right', frames: 8 }, // 1 向右移动
  { id: 'running-left', frames: 8 }, //  2 向左移动
  { id: 'waving', frames: 4 }, //        3 打招呼 
  { id: 'jumping', frames: 5 }, //       4 起跳 → 顶点 → 落地
  { id: 'failed', frames: 8 }, //        5 出错、泄气
  { id: 'waiting', frames: 6 }, //       6 等待用户操作
  { id: 'running', frames: 6 }, //       7 正在干活
  { id: 'review', frames: 6 } //         8 专注审视 / 思考
];

const BODY = [139, 123, 240];
const BODY_DARK = [111, 95, 216];
const BODY_GRAY = [150, 148, 158];
const INK = [46, 38, 69];
const INK_GRAY = [92, 90, 100];
const WHITE = [255, 255, 255];
const BLUSH = [255, 158, 196];
const PAPER = [255, 249, 235];
const PAPER_EDGE = [111, 95, 216];
const SKY = [96, 153, 232];
const GOLD = [255, 196, 78];
const ALERT = [239, 85, 108];



let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; 
  ihdr[9] = 6; 
  ihdr[10] = 0; 
  ihdr[11] = 0; 
  ihdr[12] = 0; 

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}


function blendPixel(buf, x, y, rgb, alpha) {
  if (alpha <= 0 || x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const sa = Math.min(1, alpha);
  const da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;

  for (let c = 0; c < 3; c++) {
    buf[i + c] = Math.round((rgb[c] * sa + buf[i + c] * da * (1 - sa)) / oa);
  }
  buf[i + 3] = Math.round(oa * 255);
}


function fillEllipse(buf, cx, cy, rx, ry, rgb, alpha = 1) {
  const x0 = Math.floor(cx - rx - 1);
  const x1 = Math.ceil(cx + rx + 1);
  const y0 = Math.floor(cy - ry - 1);
  const y1 = Math.ceil(cy + ry + 1);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const px = x + (sx + 0.5) / 3 - 0.5;
          const py = y + (sy + 0.5) / 3 - 0.5;
          const dx = (px - cx) / rx;
          const dy = (py - cy) / ry;
          if (dx * dx + dy * dy <= 1) hits++;
        }
      }
      if (hits) blendPixel(buf, x, y, rgb, (hits / 9) * alpha);
    }
  }
}

function fillRect(buf, x, y, width, height, rgb, alpha = 1) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.ceil(x + width);
  const y1 = Math.ceil(y + height);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) blendPixel(buf, xx, yy, rgb, alpha);
  }
}

function drawLine(buf, x1, y1, x2, y2, rgb, width = 2, alpha = 1) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillEllipse(buf, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width, width, rgb, alpha);
  }
}

function strokeEllipse(buf, cx, cy, rx, ry, rgb, width = 2, alpha = 1) {
  const x0 = Math.floor(cx - rx - width);
  const x1 = Math.ceil(cx + rx + width);
  const y0 = Math.floor(cy - ry - width);
  const y1 = Math.ceil(cy + ry + width);
  const band = Math.max(0.035, width / Math.max(rx, ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const d = dx * dx + dy * dy;
      if (Math.abs(d - 1) <= band) blendPixel(buf, x, y, rgb, alpha);
    }
  }
}

function drawArc(buf, cx, cy, rx, ry, start, end, rgb, width = 2, alpha = 1) {
  const steps = Math.max(6, Math.ceil(Math.abs(end - start) * Math.max(rx, ry) / 2));
  let px = cx + Math.cos(start) * rx;
  let py = cy + Math.sin(start) * ry;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = cx + Math.cos(start + (end - start) * t) * rx;
    const y = cy + Math.sin(start + (end - start) * t) * ry;
    drawLine(buf, px, py, x, y, rgb, width, alpha);
    px = x;
    py = y;
  }
}

function drawStar(buf, cx, cy, radius, rgb, alpha = 1) {
  const points = [];
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + i * Math.PI / 5;
    const r = i % 2 ? radius * 0.42 : radius;
    points.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    drawLine(buf, a[0], a[1], b[0], b[1], rgb, 2.2, alpha);
  }
}

function drawHeart(buf, cx, cy, size, rgb, alpha = 1) {
  fillEllipse(buf, cx - size * 0.38, cy - size * 0.18, size * 0.34, size * 0.32, rgb, alpha);
  fillEllipse(buf, cx + size * 0.38, cy - size * 0.18, size * 0.34, size * 0.32, rgb, alpha);
  drawLine(buf, cx - size * 0.64, cy - size * 0.05, cx, cy + size * 0.72, rgb, size * 0.17, alpha);
  drawLine(buf, cx + size * 0.64, cy - size * 0.05, cx, cy + size * 0.72, rgb, size * 0.17, alpha);
}

function drawDocument(buf, cx, cy, width, height, checked = false) {
  fillRect(buf, cx - width / 2, cy - height / 2, width, height, PAPER, 0.98);
  fillRect(buf, cx - width / 2, cy - height / 2, 3, height, PAPER_EDGE, 0.85);
  fillRect(buf, cx - width / 2 + 6, cy - height / 2 + 8, width * 0.58, 3, PAPER_EDGE, 0.45);
  fillRect(buf, cx - width / 2 + 6, cy - height / 2 + 16, width * 0.72, 2, PAPER_EDGE, 0.35);
  fillRect(buf, cx - width / 2 + 6, cy - height / 2 + 23, width * 0.48, 2, PAPER_EDGE, 0.35);
  if (checked) {
    drawLine(buf, cx + width * 0.13, cy + height * 0.19, cx + width * 0.28, cy + height * 0.34, SKY, 2.8);
    drawLine(buf, cx + width * 0.28, cy + height * 0.34, cx + width * 0.55, cy - height * 0.06, SKY, 2.8);
  }
}


function drawAccessory(buf, ox, oy, cx, cy, pose) {
  const kind = pose.accessory;
  if (!kind) return;

  if (kind === 'glasses') {
    strokeEllipse(buf, cx - 24, cy - 8, 15, 14, PAPER, 2.4, 0.95);
    strokeEllipse(buf, cx + 24, cy - 8, 15, 14, PAPER, 2.4, 0.95);
    drawLine(buf, cx - 9, cy - 8, cx + 9, cy - 8, PAPER, 2.4, 0.95);
    drawLine(buf, cx - 39, cy - 9, cx - 48, cy - 13, PAPER, 2, 0.9);
    drawLine(buf, cx + 39, cy - 9, cx + 48, cy - 13, PAPER, 2, 0.9);
  }

  if (kind === 'magnifier') {
    strokeEllipse(buf, cx + 57, cy - 42, 14, 14, GOLD, 3, 1);
    drawLine(buf, cx + 67, cy - 32, cx + 78, cy - 21, GOLD, 4, 1);
  }

  if (kind === 'book') {
    fillRect(buf, cx - 50, cy + 35, 46, 20, PAPER, 0.98);
    fillRect(buf, cx + 4, cy + 35, 46, 20, PAPER, 0.98);
    drawLine(buf, cx, cy + 35, cx, cy + 56, PAPER_EDGE, 2, 0.9);
    for (let i = 0; i < 3; i++) {
      fillRect(buf, cx - 43, cy + 41 + i * 4, 25, 1.5, PAPER_EDGE, 0.55);
      fillRect(buf, cx + 18, cy + 41 + i * 4, 25, 1.5, PAPER_EDGE, 0.55);
    }
  }

  if (kind === 'document') drawDocument(buf, cx + 57, cy + 27, 28, 38, true);

  if (kind === 'question') {
    drawArc(buf, cx + 52, cy - 49, 10, 11, Math.PI * 1.08, Math.PI * 2.8, PAPER, 3, 1);
    drawLine(buf, cx + 52, cy - 38, cx + 49, cy - 31, PAPER, 3, 1);
    fillEllipse(buf, cx + 49, cy - 25, 2.8, 2.8, PAPER, 1);
  }

  if (kind === 'stars') {
    drawStar(buf, cx - 57, cy - 42, 11, GOLD, 1);
    drawStar(buf, cx + 58, cy - 36, 8, GOLD, 1);
  }

  if (kind === 'alert') {
    fillRect(buf, cx + 54, cy - 57, 7, 25, ALERT, 1);
    fillEllipse(buf, cx + 57.5, cy - 24, 4, 4, ALERT, 1);
    drawLine(buf, cx - 39, cy - 27, cx - 19, cy - 32, INK, 3, 0.85);
    drawLine(buf, cx + 19, cy - 32, cx + 39, cy - 27, INK, 3, 0.85);
  }

  if (kind === 'heart') drawHeart(buf, cx + 55, cy - 48, 18, BLUSH, 1);

  if (kind === 'motion') {
    drawLine(buf, cx - 76, cy - 12, cx - 61, cy - 12, SKY, 3, 0.85);
    drawLine(buf, cx - 78, cy + 5, cx - 64, cy + 5, SKY, 2.5, 0.7);
  }
}


function mirrorCell(buf, srcRow, dstRow) {
  for (let y = 0; y < CELL_H; y++) {
    for (let x = 0; x < CELL_W; x++) {
      const si = ((srcRow * CELL_H + y) * W + x) * 4;
      const di = ((dstRow * CELL_H + y) * W + (CELL_W - 1 - x)) * 4;
      buf[di] = buf[si];
      buf[di + 1] = buf[si + 1];
      buf[di + 2] = buf[si + 2];
      buf[di + 3] = buf[si + 3];
    }
  }
}
/**
 * 在指定格子里画一帧
 * @param {Buffer} buf  整张图
 * @param {number} col  0-7
 * @param {number} row  0-8
 * @param {object} pose 姿态参数
 */
function drawFrame(buf, col, row, pose) {
  const ox = col * CELL_W;
  const oy = row * CELL_H;

  const {
    bobY = 0,
    offsetX = 0,
    eyeOpen = 1,
    eyeShift = 0,
    scaleX = 1,
    scaleY = 1,
    gray = 0,
    blush = 1,
    mouth = 'smile'
  } = pose;

  const cx = ox + CELL_W / 2 + offsetX;
  const cy = oy + 104 + bobY;

  const mix = (c1, c2, t) => [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t)
  ];

  const bodyColor = mix(BODY, BODY_GRAY, gray);
  const darkColor = mix(BODY_DARK, BODY_GRAY, gray);
  const inkColor = mix(INK, INK_GRAY, gray);

  const sx = scaleX;
  const sy = scaleY;

  // 1) 深色底座 
  fillEllipse(buf, cx, cy + 28 * sy, 64 * sx, 46 * sy, darkColor);
  // 2) 浅色底座
  fillEllipse(buf, cx, cy + 22 * sy, 64 * sx, 46 * sy, bodyColor);
  // 3) 主体
  fillEllipse(buf, cx, cy - 2 * sy, 68 * sx, 56 * sy, bodyColor);

  // 4) 顶部高光
  fillEllipse(buf, cx - 20 * sx, cy - 28 * sy, 24 * sx, 17 * sy, WHITE, 0.15);

  // 5) 眼睛
  const eyeDx = 24 * sx;
  const eyeY = cy - 8 + (eyeOpen < 0.5 ? 3 : 0) + eyeShift;
  const eyeRy = Math.max(1.5, 12 * eyeOpen);
  fillEllipse(buf, cx - eyeDx, eyeY, 11.5 * sx, eyeRy, inkColor);
  fillEllipse(buf, cx + eyeDx, eyeY, 11.5 * sx, eyeRy, inkColor);

  // 6) 眼神光：统一放在各自左上方，两只眼睛朝向才一致
  if (eyeOpen > 0.5) {
    fillEllipse(buf, cx - eyeDx - 3.5, eyeY - 4, 4.2 * sx, 4.2 * eyeOpen, WHITE, 0.95);
    fillEllipse(buf, cx + eyeDx - 3.5, eyeY - 4, 4.2 * sx, 4.2 * eyeOpen, WHITE, 0.95);
  }

  // 7) 小嘴：不同工作状态使用不同表情，缩略图和桌面动画都能辨认。
  if (mouth === 'open') {
    fillEllipse(buf, cx, cy + 16 * sy, 7 * sx, 6 * sy, inkColor, 0.58);
    fillEllipse(buf, cx, cy + 14 * sy, 3.4 * sx, 2 * sy, WHITE, 0.35);
  } else if (mouth === 'surprise') {
    fillEllipse(buf, cx, cy + 16 * sy, 5.5 * sx, 7 * sy, inkColor, 0.62);
  } else if (mouth === 'flat' || eyeOpen <= 0.5) {
    fillEllipse(buf, cx, cy + 16 * sy, 8 * sx, 1.6 * sy, inkColor, 0.48);
  } else {
    fillEllipse(buf, cx, cy + 16 * sy, 6.5 * sx, 4.5 * sy, inkColor, 0.5);
  }

  // 8) 腮红
  if (blush > 0) {
    fillEllipse(buf, cx - 46 * sx, cy + 10 * sy, 13 * sx, 8 * sy, BLUSH, 0.38 * blush);
    fillEllipse(buf, cx + 46 * sx, cy + 10 * sy, 13 * sx, 8 * sy, BLUSH, 0.38 * blush);
  }

  drawAccessory(buf, ox, oy, cx, cy, pose);
}

/** 按状态与帧序算出姿态 */
function poseFor(state, i, n) {
  const t = i / n;
  const wave = Math.sin(t * Math.PI * 2);

  switch (state) {
    case 'idle':
      return { bobY: Math.round(wave * 3), eyeOpen: i === 3 ? 0.1 : 1, mouth: 'smile' };

    case 'running-right':
      return {
        // 复用这一行作为导出
        bobY: -Math.round(Math.abs(Math.sin(t * Math.PI * 2)) * 5),
        eyeOpen: 1,
        mouth: 'open',
        accessory: 'document'
      };

    case 'running-left':
      return {
        // 拖动
        bobY: -Math.round(Math.abs(Math.sin(t * Math.PI * 2)) * 9),
        offsetX: -3,
        eyeOpen: 1,
        mouth: 'open',
        accessory: 'motion'
      };

    case 'waving':
      return {
        bobY: -Math.round(Math.abs(wave) * 5),
        eyeOpen: i === 1 ? 0.16 : 1.15,
        scaleX: 1 + wave * 0.05,
        mouth: 'smile',
        accessory: 'heart'
      };

    case 'jumping': {
      const arc = [-4, -16, -26, -16, -4];
      const dy = arc[i] ?? 0;
      return {
        bobY: dy,
        scaleY: 1 + dy / 140,
        eyeOpen: i === 2 ? 0.25 : 1.1,
        mouth: 'surprise',
        accessory: 'stars'
      };
    }

    case 'failed':
      return {
        bobY: 7 + Math.round(wave * 1.5),
        eyeOpen: 0.32,
        gray: 1,
        blush: 0,
        mouth: 'flat',
        accessory: 'alert'
      };

    case 'waiting':
      return {
        bobY: Math.round(wave * 2),
        eyeOpen: i === 0 ? 0.18 : 0.85,
        eyeShift: i % 2 ? -1 : 1,
        mouth: 'surprise',
        accessory: 'question'
      };

    case 'running':
      // 正在干活：小幅高频抖动 + 眯眼专注
      return {
        bobY: i % 2 === 0 ? -3 : 0,
        offsetX: i % 2 === 0 ? 1 : -1,
        eyeOpen: 0.82,
        mouth: 'open',
        accessory: 'book'
      };

    case 'review':
      // 审视 / 思考：轻微点头 + 半眯眼
      return {
        bobY: Math.round(Math.sin(t * Math.PI * 2) * 3),
        eyeOpen: 0.7,
        eyeShift: i % 2 ? -2 : 0,
        mouth: 'flat',
        accessory: 'glasses'
      };

    default:
      return {};
  }
}
function makePreview(spriteBuf) {
  const SIZE = 512;
  const SCALE = 2;
  const pw = CELL_W * SCALE; // 384
  const ph = CELL_H * SCALE; // 416
  const out = Buffer.alloc(SIZE * SIZE * 4);
  const ox = Math.round((SIZE - pw) / 2);
  const oy = Math.round((SIZE - ph) / 2);

  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const sx = Math.floor(x / SCALE);
      const sy = Math.floor(y / SCALE);
      const si = (sy * W + sx) * 4;
      const di = ((oy + y) * SIZE + (ox + x)) * 4;
      out[di] = spriteBuf[si];
      out[di + 1] = spriteBuf[si + 1];
      out[di + 2] = spriteBuf[si + 2];
      out[di + 3] = spriteBuf[si + 3];
    }
  }
  return { buffer: out, size: SIZE };
}

function extractCell(sprite, col, row) {
  const out = Buffer.alloc(CELL_W * CELL_H * 4);
  for (let y = 0; y < CELL_H; y++) {
    const si = ((row * CELL_H + y) * W + col * CELL_W) * 4;
    sprite.copy(out, y * CELL_W * 4, si, si + CELL_W * 4);
  }
  return out;
}


function downsample(src, srcW, srcH, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 4);
  const rx = srcW / dstW;
  const ry = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;

      const x0 = Math.floor(x * rx);
      const x1 = Math.min(srcW, Math.ceil((x + 1) * rx));
      const y0 = Math.floor(y * ry);
      const y1 = Math.min(srcH, Math.ceil((y + 1) * ry));

      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * srcW + xx) * 4;
          const al = src[i + 3] / 255;
          r += src[i] * al;
          g += src[i + 1] * al;
          b += src[i + 2] * al;
          a += al;
          n += 1;
        }
      }

      const di = (y * dstW + x) * 4;
      if (n > 0 && a > 0) {
        out[di] = Math.round(r / a);
        out[di + 1] = Math.round(g / a);
        out[di + 2] = Math.round(b / a);
        out[di + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return out;
}

/** 缩放到指定正方形画布并居中*/
function fitSquare(src, srcW, srcH, size) {
  const scale = Math.min(size / srcW, size / srcH);
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const scaled = downsample(src, srcW, srcH, w, h);

  const out = Buffer.alloc(size * size * 4);
  const ox = Math.round((size - w) / 2);
  const oy = Math.round((size - h) / 2);

  for (let y = 0; y < h; y++) {
    scaled.copy(out, ((oy + y) * size + ox) * 4, y * w * 4, (y + 1) * w * 4);
  }
  return out;
}

/** ICO 容器：直接内嵌 PNG */
function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);

  const dirs = [];
  let offset = 6 + 16 * entries.length;

  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size;
    d[1] = e.size >= 256 ? 0 : e.size;
    d.writeUInt16LE(1, 4); // color planes
    d.writeUInt16LE(32, 6); // bits per pixel
    d.writeUInt32LE(e.buffer.length, 8);
    d.writeUInt32LE(offset, 12);
    dirs.push(d);
    offset += e.buffer.length;
  }

  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.buffer)]);
}
function main() {
  const root = path.resolve(__dirname, '..');
  const petDir = path.join(root, 'pets', 'paper-pet');
  fs.mkdirSync(petDir, { recursive: true });

  console.log(`生成精灵图 ${W} × ${H}（${COLS} 列 × ${ROWS} 行，每格 ${CELL_W} × ${CELL_H}）…`);

  const sprite = Buffer.alloc(W * H * 4); // 全透明

  ROW_SPEC.forEach((spec, row) => {
    for (let col = 0; col < spec.frames; col++) {
      drawFrame(sprite, col, row, poseFor(spec.id, col, spec.frames));
    }

    console.log(`  row ${row}  ${spec.id.padEnd(14)} ${spec.frames} 帧`);
  });

  const spritePath = path.join(petDir, 'spritesheet.png');
  fs.writeFileSync(spritePath, encodePNG(W, H, sprite));
  console.log(`\n✓ ${path.relative(root, spritePath)}  ${(fs.statSync(spritePath).size / 1024).toFixed(1)} KB`);

  const preview = makePreview(sprite);
  const previewPath = path.join(petDir, 'index.png');
  fs.writeFileSync(previewPath, encodePNG(preview.size, preview.size, preview.buffer));
  console.log(`✓ ${path.relative(root, previewPath)}  ${(fs.statSync(previewPath).size / 1024).toFixed(1)} KB`);

  const manifest = {
    id: 'paper-pet',
    displayName: 'PPtor',
    description: 'A gentle violet slime that eats PDFs and translates them into your language.',
    spritesheetPath: 'spritesheet.png',
    previewPath: 'index.png',
    version: '1.0.0',
    license: 'MIT',
    accent: '#8b7bf0'
  };
  const manifestPath = path.join(petDir, 'pet.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`✓ ${path.relative(root, manifestPath)}`);


  const qaDir = path.join(petDir, 'qa');
  fs.mkdirSync(qaDir, { recursive: true });

  const CS_W = CELL_W * 3;
  const CS_H = CELL_H * 3;
  const contact = Buffer.alloc(CS_W * CS_H * 4);

  for (let row = 0; row < ROWS; row++) {
    const cell = extractCell(sprite, 0, row);
    const dx = (row % 3) * CELL_W;
    const dy = Math.floor(row / 3) * CELL_H;
    for (let y = 0; y < CELL_H; y++) {
      cell.copy(contact, ((dy + y) * CS_W + dx) * 4, y * CELL_W * 4, (y + 1) * CELL_W * 4);
    }
  }

  const contactPath = path.join(qaDir, 'states.png');
  fs.writeFileSync(contactPath, encodePNG(CS_W, CS_H, contact));
  console.log(`✓ ${path.relative(root, contactPath)}`);

  /* ---- 带语义标签的 QA 页面 */
  const qaLabels = [
    ['idle', '待机', 'Idle'],
    ['running-right', '导出文档', 'Export'],
    ['running-left', '拖动', 'Dragging'],
    ['waving', '抚摸 / 欢迎', 'Petting / Welcome'],
    ['jumping', '完成', 'Complete'],
    ['failed', '失败', 'Failed'],
    ['waiting', '等待确认', 'Waiting'],
    ['running', '翻译打字', 'Translating'],
    ['review', '解析阅读', 'Parsing']
  ];
  const qaCards = qaLabels.map(([id, zh, en], row) => {
    const spec = ROW_SPEC[row];
    return `<article class="card"><div class="cell" style="background-position:0 -${row * 208}px"></div>` +
      `<div class="label"><b>${zh}</b><span>${en}</span><small>${id} · ${spec.frames} frames</small></div></article>`;
  }).join('\n');
  const qaHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>PPtor Pet States QA</title>
<style>
body{margin:0;padding:24px;background:#f4f1ff;color:#242037;font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}
h1{margin:0 0 4px}p{margin:0 0 18px;color:#6b6678}.grid{display:grid;grid-template-columns:repeat(3,192px);gap:16px}
.card{background:#fff;border:1px solid #e2ddf5;border-radius:16px;padding:10px;box-shadow:0 4px 14px #443b7020}
.cell{width:192px;height:208px;background-image:url('../spritesheet.png');background-size:1536px 1872px;background-repeat:no-repeat}
.label b,.label span,.label small{display:block}.label b{font-size:15px}.label span{color:#6b6678}.label small{color:#9690a5;font-size:11px;margin-top:3px}
</style></head><body><h1>PPtor 桌宠状态预览</h1><p>每格使用实际 192×208 精灵单元完整展示；运行时 CSS 动画与进度气泡另行验证。</p><div class="grid">${qaCards}</div></body></html>`;
  const qaHtmlPath = path.join(qaDir, 'states.html');
  fs.writeFileSync(qaHtmlPath, qaHtml, 'utf8');
  console.log(`✓ ${path.relative(root, qaHtmlPath)}`);

  /* ---- 托盘图标与应用图标 ---- */
  const idleCell = extractCell(sprite, 0, 0);

  const assetsDir = path.join(root, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const trayPath = path.join(assetsDir, 'tray.png');
  fs.writeFileSync(trayPath, encodePNG(32, 32, fitSquare(idleCell, CELL_W, CELL_H, 32)));
  console.log(`✓ ${path.relative(root, trayPath)}`);

  const buildDir = path.join(root, 'build');
  fs.mkdirSync(buildDir, { recursive: true });

  const iconSizes = [16, 32, 48, 64, 128, 256];
  const icoEntries = iconSizes.map((size) => ({
    size,
    buffer: encodePNG(size, size, fitSquare(idleCell, CELL_W, CELL_H, size))
  }));
  const icoPath = path.join(buildDir, 'icon.ico');
  fs.writeFileSync(icoPath, encodeICO(icoEntries));
  console.log(`✓ ${path.relative(root, icoPath)}  ${(fs.statSync(icoPath).size / 1024).toFixed(1)} KB`);

  const iconPngPath = path.join(buildDir, 'icon.png');
  fs.writeFileSync(iconPngPath, encodePNG(256, 256, fitSquare(idleCell, CELL_W, CELL_H, 256)));
  console.log(`✓ ${path.relative(root, iconPngPath)}`);

  console.log('\n完成。这只宠物同时兼容 Codex Pet 格式，可直接复制到 ~/.codex/pets/ 下使用。');
}

main();
