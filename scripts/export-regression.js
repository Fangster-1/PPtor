"use strict";

/**
 * 导出回归：验证自包含 MD/HTML、真实 DOCX 图片关系和不产生辅助文件。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const { splitMarkdown } = require("../src/main/core/chunker");
const { exportResults } = require("../src/main/core/exporter");
const { unzip } = require("../src/main/core/zip");
const { inlineMarkdownImages } = require("../src/main/core/assets");
const { markdownToDocx } = require("../src/main/core/docx");

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width, height, rgba = [60, 120, 220, 255]) {
  const row = Buffer.from([
    0,
    ...Array.from({ length: width }, () => rgba).flat(),
  ]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    t.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main() {
  const fixture = path.join(__dirname, "..", "test-out", "export-fixture");
  await fsp.rm(fixture, { recursive: true, force: true });
  await fsp.mkdir(fixture, { recursive: true });

  const md = [
    "# 自包含导出测试",
    "",
    "中文正文与公式 $E=mc^2$。",
    "",
    "![横图](images/wide.png)",
    "",
    "![外链图](https://tracker.example.test/pixel.png)",
    "",
    '<img alt="原生图" src="images/tall.png">',
    "",
    "![引用图][figure-tall]",
    "[figure-tall]: images/tall.png",
    "",
    "| 列一 | 列二 |",
    "| --- | --- |",
    "| A | B |",
    "",
    '<table><tr><th rowspan="2">合并</th><td>一</td></tr><tr><td>二</td></tr></table>',
    "",
    "## 参考文献",
    "",
    "[1] 完整参考文献条目。",
  ].join("\n");
  const segments = splitMarkdown(md, { maxTokens: 1200 });
  const translations = new Map(
    segments.filter((s) => s.translatable).map((s) => [s.id, s.content]),
  );
  const pendingPdf = {};
  const wide = png(8, 2);
  const tall = png(2, 8);
  const result = await exportResults({
    outDir: fixture,
    baseName: "自包含导出测试",
    segments,
    translations,
    images: [
      { name: "wide.png", data: wide },
      { name: "tall.png", data: tall },
    ],
    outputConfig: {
      formats: ["md", "html", "docx", "pdf"],
      content: "bilingual",
      renderMath: true,
    },
    pendingPdf,
  });

  const names = result.files.map((f) => path.basename(f.path));
  assert.deepEqual(
    new Set(names),
    new Set([
      "自包含导出测试.md",
      "自包含导出测试.html",
      "自包含导出测试.docx",
      "自包含导出测试.pdf",
    ]),
  );
  assert.equal(fs.existsSync(path.join(fixture, "meta.json")), false);
  assert.equal(fs.existsSync(path.join(fixture, "images")), false);

  const outMd = await fsp.readFile(
    path.join(fixture, "自包含导出测试.md"),
    "utf8",
  );
  const outHtml = await fsp.readFile(
    path.join(fixture, "自包含导出测试.html"),
    "utf8",
  );
  assert.match(outMd, /data:image\/png;base64,/);
  assert.match(outHtml, /data:image\/png;base64,/);
  assert.match(outHtml, /class="katex/);
  assert.match(outHtml, /rowspan="2"/);
  assert.equal((outHtml.match(/<img\b/g) || []).length, 4);
  assert.match(outMd, /完整参考文献条目/);
  assert.doesNotMatch(outHtml, /cdn\.jsdelivr|<script\b|<link\b/i);
  assert.doesNotMatch(outMd, /tracker\.example\.test/i);
  assert.doesNotMatch(outHtml, /tracker\.example\.test/i);

  const docx = await fsp.readFile(path.join(fixture, "自包含导出测试.docx"));
  const entries = unzip(docx);
  assert.ok(entries.some((e) => /^word\/document\.xml$/.test(e.name)));
  assert.ok(
    entries.some((e) => /^word\/media\//.test(e.name)),
    "DOCX must contain embedded media",
  );
  const documentXml = entries
    .find((e) => e.name === "word/document.xml")
    .data.toString("utf8");
  assert.equal((documentXml.match(/<a:blip /g) || []).length, 4);
  assert.match(documentXml, /参考文献/);
  assert.match(documentXml, /rowSpan|gridSpan|合并|一/);

  // 公式回归：MathRun 合并不得产生 undefined（docx 的 Run 不暴露 .text）
  const mathBlocks = documentXml.match(/<m:oMath>[\s\S]*?<\/m:oMath>/g) || [];
  assert.ok(mathBlocks.length >= 1, 'DOCX must contain math');
  assert.ok(
    mathBlocks.every((m) => !/undefined/.test(m)),
    'math runs must not contain undefined',
  );
  assert.match(documentXml, /<m:t>E=mc<\/m:t>/);

  // 缺图降级：不再抛错，用占位图 + 缺图清单保证其它格式仍可产出
  const missingRes = inlineMarkdownImages("![缺图](images/not-found.png)", []);
  assert.match(String(missingRes), /data:image\/png;base64/);
  assert.ok(Array.isArray(missingRes.missing) && missingRes.missing.includes('images/not-found.png'));

  await assert.rejects(
    markdownToDocx(
      "![WebP](data:image/webp;base64,UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoEAAIAAUAmJaACdLoB+AADsAD+8Bvf/1wH5wH5wH8WP/zYFc1z7mgA)",
    ),
    /Electron 图片解码能力|DOCX 图片转换失败/,
  );

  console.log(`export-regression passed: ${fixture}`);
}

main().catch((err) => {
  console.error(`export-regression failed: ${err.stack || err}`);
  process.exitCode = 1;
});
