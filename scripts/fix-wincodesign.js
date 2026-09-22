"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const VERSION = "winCodeSign-2.6.0";
const CACHE_ROOT = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "electron-builder",
  "Cache",
  "winCodeSign",
);
const TARGET_DIR = path.join(CACHE_ROOT, VERSION);

const MIRRORS = [
  `https://npmmirror.com/mirrors/electron-builder-binaries/${VERSION}/${VERSION}.7z`,
  `https://github.com/electron-userland/electron-builder-binaries/releases/download/${VERSION}/${VERSION}.7z`,
];

function find7za() {
  const candidates = [
    path.join(
      __dirname,
      "..",
      "node_modules",
      "7zip-bin",
      "win",
      "x64",
      "7za.exe",
    ),
    path.join(
      __dirname,
      "..",
      "node_modules",
      "7zip-bin",
      "win",
      "ia32",
      "7za.exe",
    ),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100000)
    throw new Error(`文件过小（${buf.length} 字节），可能不是有效包`);
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function main() {
  console.log("检查 electron-builder 的 winCodeSign 缓存…");

  if (fs.existsSync(path.join(TARGET_DIR, "windows-10"))) {
    console.log(`✓ 缓存已就绪，无需修复：\n  ${TARGET_DIR}`);
    return;
  }

  const sevenZip = find7za();
  if (!sevenZip) {
    console.error("✗ 找不到 7za.exe，请先执行 npm install");
    process.exit(1);
  }

  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const archive = path.join(CACHE_ROOT, `${VERSION}.7z`);

  let downloaded = false;
  for (const url of MIRRORS) {
    try {
      process.stdout.write(`下载 ${VERSION}.7z … `);
      const size = await download(url, archive);
      console.log(`OK（${(size / 1048576).toFixed(1)} MB）`);
      downloaded = true;
      break;
    } catch (err) {
      console.log(`失败：${err.message}`);
    }
  }

  if (!downloaded) {
    console.error("✗ 所有镜像都下载失败，请检查网络后重试");
    process.exit(1);
  }

  // 关键：排除 darwin 目录，绕开符号链接
  process.stdout.write("解压（排除 darwin，绕开符号链接）… ");
  try {
    execFileSync(
      sevenZip,
      ["x", archive, `-o${TARGET_DIR}`, "-x!darwin", "-y", "-bso0", "-bsp0"],
      {
        stdio: "ignore",
      },
    );
    console.log("OK");
  } catch (err) {
    console.error(`失败：${err.message}`);
    process.exit(1);
  }

  try {
    fs.unlinkSync(archive);
  } catch {}

  const ok = fs.existsSync(path.join(TARGET_DIR, "windows-10"));
  console.log(
    ok
      ? `\n✓ 修复完成：\n  ${TARGET_DIR}\n  现在可以正常执行 npm run dist`
      : "\n✗ 解压结果不完整，请改用管理员权限运行打包",
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("修复失败：", err.message);
  process.exit(1);
});
