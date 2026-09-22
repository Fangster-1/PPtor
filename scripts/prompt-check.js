"use strict";

/**
 * 提示词快速验证（Electron 环境，可解密配置里的 Key）
 * 不解析 PDF，直接用一段「专门埋坑」的学术英文段落跑翻译，
 * 逐项断言术语、引用、公式、图片是否按要求处理。改提示词后几秒就能看结果。
 */
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// 与打包版同一个 userData，才能解密配置里的 Key；缺失时回退系统临时目录
try {
  app.setPath(
    "userData",
    path.join(process.env.APPDATA || os.tmpdir(), "paper-translator"),
  );
} catch {
  /* 保持默认 */
}

const SAMPLE = `In modern deep learning architectures, multi-head attention mechanisms play a critical role. The CNN and RNN baselines showed noticeable bottlenecks, while Transformer and MLP layers captured most of the feature variance [12,13]. Previous studies (Smith et al., 2021) reported similar phenomena across benchmark tasks.

The goodness of fit is defined as:

$$
R^2 = 1 - \\frac{SS_{res}}{SS_{tot}}
$$

Our results showed that accuracy increased by 5.2% (p<0.01), and the GPU acceleration effect was strongest in the final evaluation stage.

![Model architecture](images/fig1.png)
`;

function check(name, pass, detail) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : "  → " + detail}`);
  return pass;
}

app.whenReady().then(async () => {
  try {
    const { splitMarkdown, reassemble } = require(
      path.join(ROOT, "src/main/core/chunker"),
    );
    const translator = require(path.join(ROOT, "src/main/core/translator"));

    const cfgFile = path.join(ROOT, "dist", "config", "settings.json");
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));

    const dec = (enc) => {
      if (!enc) return "";
      try {
        return safeStorage.decryptString(Buffer.from(enc, "base64"));
      } catch {
        return "";
      }
    };

    const api = { ...(cfg.translate || {}) };
    if (!api.apiKey && cfg.translate.apiKeyEnc)
      api.apiKey = dec(cfg.translate.apiKeyEnc);
    if (!api.apiKey) {
      console.log("拿不到 API Key，无法验证");
      app.exit(1);
      return;
    }

    const glossaryPath = path.join(path.dirname(cfgFile), "glossary.txt");
    translator.initGlossary(glossaryPath);

    console.log("─".repeat(60));
    console.log("模型: " + api.model);
    console.log(
      "术语表: " + (fs.existsSync(glossaryPath) ? glossaryPath : "（无）"),
    );
    console.log("─".repeat(60));

    const segments = splitMarkdown(SAMPLE, {
      maxTokens: api.chunkTokens || 1200,
    });
    const cache = new Map();
    const translations = await translator.translateSegments(segments, api, {
      signal: { cancelled: false },
      onProgress: () => {},
    });

    const out = reassemble(segments, translations);
    console.log("\n译文:\n" + out + "\n");

    console.log("逐项检查:");
    const bad = [];
    let ok = true;

    const denden = (out.match(/等人/g) || []).length;
    ok =
      check("未把 et al. 译成「等人」", denden === 0, `出现 ${denden} 处`) &&
      ok;
    ok = check("保留了 et al.", out.includes("et al."), "et al. 不见了") && ok;
    ok =
      check(
        "保留了引用标记 [12,13]",
        out.includes("[12,13]"),
        "引用标记丢失",
      ) && ok;
    ok =
      check(
        "保留了数值与显著性 5.2% (p<0.01)",
        out.includes("5.2%") && /p\s*<\s*0\.01/.test(out),
        "数值/显著性被改",
      ) && ok;
    ok =
      check(
        "保留了图片路径",
        out.includes("](images/fig1.png)"),
        "图片路径被改（alt 文本译为中文是可接受的）",
      ) && ok;
    ok =
      check(
        "保留了公式",
        out.includes("SS_{res}") && out.includes("\\frac"),
        "公式被破坏",
      ) && ok;

    const terms = ["CNN", "RNN", "Transformer", "MLP", "GPU"];
    const missing = terms.filter((t) => !out.includes(t));
    ok =
      check(
        `缩写保留英文原样（${terms.join("/")}）`,
        missing.length === 0,
        "缺失: " + missing.join(","),
      ) && ok;

    // 半汉化检查
    const half = out.match(/[\u4e00-\u9fa5]{2,}\s+[A-Z][A-Za-z]{2,}/g) || [];
    ok =
      check("无中英半汉化", half.length === 0, half.slice(0, 3).join(" / ")) &&
      ok;

    console.log("\n结论: " + (ok ? "全部通过 ✓" : "仍有问题 ✗"));
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.log("失败: " + (err && err.message ? err.message : err));
    app.exit(1);
  }
});
