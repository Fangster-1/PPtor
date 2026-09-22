'use strict';

/**
 * 将 Markdown 文档转换为 DOCX 格式
 */

const {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Math: DocxMath,
  MathRun,
  MathFraction,
  MathRadical,
  MathSuperScript,
  MathSubScript,
  MathSubSuperScript,
  MathRoundBrackets,
  MathSquareBrackets,
  MathCurlyBrackets,
  MathAngledBrackets,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} = require('docx');
const { imageSize } = require('image-size');

const { dataUriToBuffer } = require('./assets');
const { isCaptionText } = require('./markdown');
const { CancelledError, isCancelled } = require('./errors');

const UNSUPPORTED_DATA_URI_RE = /(data:image\/(?:webp|svg\+xml);base64,[A-Za-z0-9+/=]+)/gi;
const IMAGE_CONVERSION_TIMEOUT_MS = 10000;

function sanitizeXmlText(value) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

function imageType(mime) {
  const type = String(mime || '').toLowerCase();
  if (type === 'image/jpeg' || type === 'image/jpg' || type === 'image/pjpeg' || type === 'image/jfif') return 'jpg';
  if (type === 'image/gif') return 'gif';
  if (type === 'image/bmp') return 'bmp';
  if (type === 'image/png' || type === 'image/x-png') return 'png';
  return null;
}

function convertWithNativeImage(data, mime) {
  try {
    const { nativeImage } = require('electron');
    const image = nativeImage.createFromBuffer(data);
    if (!image || image.isEmpty()) return null;
    const png = image.toPNG();
    return png && png.length ? { data: png, mime: 'image/png' } : null;
  } catch {
    return null;
  }
}

function conversionCancelled(signal) {
  return !!(signal && signal.cancelled);
}

function conversionError(message) {
  return new Error(`DOCX 图片转换失败：${message}`);
}

function withConversionTimeout(operation, timeoutMs, label, signal, onAbort) {
  if (conversionCancelled(signal)) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let poll;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      fn(value);
    };
    const abort = (err) => {
      try {
        if (typeof onAbort === 'function') onAbort();
      } catch {
        /* 保留原始超时/取消错误 */
      }
      finish(reject, err);
    };
    timer = setTimeout(() => abort(conversionError(`${label}超时（${timeoutMs} 毫秒）`)), timeoutMs);
    poll = setInterval(() => {
      if (conversionCancelled(signal)) abort(new CancelledError());
    }, 100);
    Promise.resolve()
      .then(operation)
      .then((value) => finish(resolve, value), (err) => finish(reject, err));
  });
}

async function convertWithBrowserWindow(dataUri, mime, signal) {
  let BrowserWindow;
  try {
    ({ BrowserWindow } = require('electron'));
  } catch (err) {
    throw conversionError(`${mime} 需要 Electron 图片解码能力：${err.message}`);
  }
  if (!BrowserWindow) throw conversionError(`${mime} 需要 Electron 图片解码能力`);

  const win = new BrowserWindow({
    show: false,
    width: 2,
    height: 2,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      offscreen: true
    }
  });
  const destroy = () => {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* best effort */
    }
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; font-src data:"></head><body><img id="source" src="${dataUri}"><script>window.__pptorReady = false; window.__pptorError = ''; const image = document.getElementById('source'); const markReady = () => { window.__pptorReady = true; }; image.addEventListener('load', markReady, { once: true }); image.addEventListener('error', () => { window.__pptorError = '图片解码失败'; }, { once: true }); if (image.complete && image.naturalWidth) markReady();</script></body></html>`;
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  try {
    await withConversionTimeout(
      () => win.loadURL(url),
      5000,
      '图片页面加载',
      signal,
      destroy
    );
    const pngUri = await withConversionTimeout(
      () =>
        win.webContents.executeJavaScript(
          `new Promise(async (resolve, reject) => {
            const image = document.getElementById('source');
            try {
              if (!image.complete) await new Promise((ok, bad) => { image.onload = ok; image.onerror = () => bad(new Error('图片解码失败')); });
              if (!image.naturalWidth || !image.naturalHeight) throw new Error(window.__pptorError || '图片解码失败');
              const canvas = document.createElement('canvas');
              canvas.width = image.naturalWidth;
              canvas.height = image.naturalHeight;
              canvas.getContext('2d').drawImage(image, 0, 0);
              resolve(canvas.toDataURL('image/png'));
            } catch (error) { reject(error); }
          })`,
          false
        ),
      5000,
      '图片 Canvas 转换',
      signal,
      destroy
    );
    if (typeof pngUri !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/i.test(pngUri)) {
      throw conversionError(`${mime} Canvas 未返回有效 PNG`);
    }
    const parsed = dataUriToBuffer(pngUri);
    if (!parsed || !parsed.data.length) throw conversionError(`${mime} Canvas 返回空 PNG`);
    return parsed;
  } catch (err) {
    if (err && (isCancelled(err) || /DOCX 图片转换失败/.test(err.message))) throw err;
    throw conversionError(`${mime} 无法通过隔离窗口转换：${err.message}`);
  } finally {
    destroy();
  }
}

async function convertUnsupportedImage(data, mime, signal) {
  const type = String(mime || '').toLowerCase();
  if (type !== 'image/webp' && type !== 'image/svg+xml') {
    throw new Error(`DOCX 不支持的图片格式：${mime || '未知'}`);
  }
  const native = convertWithNativeImage(data, type);
  if (native) return native;
  const uri = `data:${type};base64,${Buffer.from(data).toString('base64')}`;
  return convertWithBrowserWindow(uri, type, signal);
}

function prepareImage(parsed) {
  if (!parsed || !parsed.data || !parsed.data.length) throw new Error('DOCX 图片数据为空');
  if (imageType(parsed.mime)) return parsed;
  // 嗅探常见图片格式文件头（魔数）
  const buf = parsed.data;
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      parsed.mime = 'image/png';
      return parsed;
    }
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
      parsed.mime = 'image/jpeg';
      return parsed;
    }
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      parsed.mime = 'image/gif';
      return parsed;
    }
    if (buf[0] === 0x42 && buf[1] === 0x4D) {
      parsed.mime = 'image/bmp';
      return parsed;
    }
  }
  throw new Error(`DOCX 图片尚未转换：${parsed.mime || '未知'}（请通过 markdownToDocx 导出）`);
}

function clampImageSize(data, mime) {
  // Word 的 ImageRun 需要尺寸，但 data URI 本身不一定带尺寸。统一使用
  // 论文友好的默认宽度；图片仍可在 Word 中自由缩放/替换。
  let width = 600;
  let height = 360;
  try {
    const size = imageSize(data);
    if (Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0) {
      const maxWidth = 560;
      const maxHeight = 760;
      const scale = Math.min(1, maxWidth / size.width, maxHeight / size.height);
      width = Math.max(1, Math.round(size.width * scale));
      height = Math.max(1, Math.round(size.height * scale));
    }
  } catch {
    // 无法识别尺寸时使用小的保守尺寸，文档仍然可编辑且不会拉伸已知图片。
  }
  return { width, height };
}

const DEFAULT_FONT = {
  ascii: 'Times New Roman',
  eastAsia: 'SimSun',
  hAnsi: 'Times New Roman',
  cs: 'Times New Roman'
};

const CELL_BORDERS = {
  top: { style: 'single', size: 4, color: '000000' },
  bottom: { style: 'single', size: 4, color: '000000' },
  left: { style: 'single', size: 4, color: '000000' },
  right: { style: 'single', size: 4, color: '000000' }
};

const SYMBOL_MAP = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', vartheta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ',
  nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ',
  upsilon: 'υ', phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '·', pm: '±', mp: '∓', div: '÷',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠',
  approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', propto: '∝',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  cap: '∩', cup: '∪', setminus: '∖',
  forall: '∀', exists: '∃', nexists: '∄', emptyset: '∅', varnothing: '∅',
  nabla: '∇', partial: '∂', infty: '∞',
  to: '→', rightarrow: '→', leftarrow: '←', Leftarrow: '⇐', Rightarrow: '⇒',
  leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦',
  cdots: '…', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱',
  sum: '∑', prod: '∏', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  angle: '∠', perp: '⊥', parallel: '∥',
  prime: '′', dag: '†', ddag: '‡',
  mid: '|', vert: '|', Vert: '‖', langle: '⟨', rangle: '⟩'
};

const FUNCTION_NAMES = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'coth',
  'exp', 'log', 'ln', 'lg',
  'lim', 'max', 'min', 'sup', 'inf', 'argmax', 'argmin',
  'det', 'dim', 'ker', 'hom', 'deg', 'gcd', 'Pr'
]);

const TEXT_COMMANDS = new Set([
  'text', 'mathrm', 'mathbf', 'mathit', 'textbf', 'bm',
  'operatorname', 'boldsymbol', 'mathbb', 'mathcal',
  'rm', 'bf', 'it', 'sf', 'tt'
]);

function extractBraced(str, startIdx) {
  if (startIdx >= str.length || str[startIdx] !== '{') return null;
  let depth = 0;
  for (let i = startIdx; i < str.length; i++) {
    if (str[i] === '{' && (i === 0 || str[i - 1] !== '\\')) depth++;
    else if (str[i] === '}' && (i === 0 || str[i - 1] !== '\\')) {
      depth--;
      if (depth === 0) {
        return { content: str.slice(startIdx + 1, i), nextIdx: i + 1 };
      }
    }
  }
  return { content: str.slice(startIdx + 1), nextIdx: str.length };
}

function extractScriptArgument(str, startIdx) {
  let idx = startIdx;
  while (idx < str.length && /\s/.test(str[idx])) idx++;
  if (idx >= str.length) return null;
  if (str[idx] === '{') {
    const b = extractBraced(str, idx);
    return b ? { content: b.content, nextIdx: b.nextIdx } : null;
  }
  if (str[idx] === '\\') {
    // 检查是否为 \mathrm h, \mathrm{h}, \mathbf x 等
    const textCmdMatch = str.slice(idx).match(/^\\(mathrm|mathbf|mathit|textbf|bm|operatorname|boldsymbol|mathbb|mathcal|rm|bf|it|sf|tt)\b/i);
    if (textCmdMatch) {
      let afterCmd = idx + textCmdMatch[0].length;
      while (afterCmd < str.length && /\s/.test(str[afterCmd])) afterCmd++;
      if (afterCmd < str.length && str[afterCmd] === '{') {
        const b = extractBraced(str, afterCmd);
        if (b) return { content: b.content, nextIdx: b.nextIdx };
      }
      const singleCharMatch = str.slice(afterCmd).match(/^([a-zA-Z0-9])/);
      if (singleCharMatch) {
        return { content: singleCharMatch[1], nextIdx: afterCmd + 1 };
      }
      const subCmdMatch = str.slice(afterCmd).match(/^(\\[a-zA-Z]+)/);
      if (subCmdMatch) {
        return { content: subCmdMatch[1], nextIdx: afterCmd + subCmdMatch[0].length };
      }
    }
    const m = str.slice(idx).match(/^\\[a-zA-Z]+/);
    if (m) {
      return { content: m[0], nextIdx: idx + m[0].length };
    }
  }
  return { content: str[idx], nextIdx: idx + 1 };
}

/**
 * docx 的 MathRun / TextRun 构造后不暴露文本（读 .text 得到 undefined），
 * 而「合并相邻 Run」与「文本是否空白」判断都要读回文本。统一经工厂创建，
 * 把文本记在不可枚举属性上：不参与落盘 XML 序列化，只供内部逻辑读取。
 */
function rememberText(run, text) {
  Object.defineProperty(run, 'text', {
    value: String(text),
    writable: true,
    enumerable: false,
    configurable: true
  });
  return run;
}

function mathRun(text) {
  return rememberText(new MathRun(text), text);
}

function parseMathNodes(latex) {
  if (!latex) return [];
  const nodes = [];
  let i = 0;
  const s = String(latex).trim();

  function appendRun(text) {
    if (!text) return;
    if (nodes.length > 0 && nodes[nodes.length - 1] instanceof MathRun) {
      nodes[nodes.length - 1] = mathRun(String(nodes[nodes.length - 1].text || '') + text);
    } else {
      nodes.push(mathRun(text));
    }
  }

  while (i < s.length) {
    if (/\s/.test(s[i])) {
      appendRun(' ');
      i++;
      continue;
    }

    // 1. 转义命令
    if (s[i] === '\\') {
      const rest = s.slice(i);

      if (/^\\[,;! ]/.test(rest)) {
        appendRun(' ');
        i += 2;
        continue;
      }
      if (/^\\quad\b/.test(rest)) {
        appendRun('   ');
        i += 5;
        continue;
      }
      if (/^\\qquad\b/.test(rest)) {
        appendRun('      ');
        i += 6;
        continue;
      }

      // 分数 \frac{num}{den}
      if (/^\\frac\b/.test(rest)) {
        let cur = i + 5;
        while (cur < s.length && /\s/.test(s[cur])) cur++;
        const num = extractBraced(s, cur);
        if (num) {
          cur = num.nextIdx;
          while (cur < s.length && /\s/.test(s[cur])) cur++;
          const den = extractBraced(s, cur);
          if (den) {
            const numNodes = parseMathNodes(num.content);
            const denNodes = parseMathNodes(den.content);
            nodes.push(
              new MathFraction({
                numerator: numNodes.length ? numNodes : [mathRun('')],
                denominator: denNodes.length ? denNodes : [mathRun('')]
              })
            );
            i = den.nextIdx;
            continue;
          }
        }
      }

      // 开方 \sqrt[n]{...}：degree 保留为前置上标，避免静默丢弃三次根等信息
      if (/^\\sqrt\b/.test(rest)) {
        let cur = i + 5;
        while (cur < s.length && /\s/.test(s[cur])) cur++;
        let degree = null;
        if (s[cur] === '[') {
          const closeBracket = s.indexOf(']', cur);
          if (closeBracket > cur) {
            degree = s.slice(cur + 1, closeBracket);
            cur = closeBracket + 1;
            while (cur < s.length && /\s/.test(s[cur])) cur++;
          }
        }
        const inner = extractBraced(s, cur);
        if (inner) {
          const innerNodes = parseMathNodes(inner.content);
          const children = innerNodes.length ? innerNodes : [mathRun('')];
          if (degree && String(degree).trim()) {
            // docx 的 MathRadical 不暴露 degree 槽位：前置保留原文，避免信息丢失
            appendRun(`[${String(degree).trim()}]`);
          }
          nodes.push(
            new MathRadical({
              children
            })
          );
          i = inner.nextIdx;
          continue;
        }
      }

      // 文本与字体样式 \text{...}, \mathrm{...}, \mathbf{...}
      // 支持命令与花括号之间允许空格，如 \mathrm { V I F }
      const textCmdMatch = rest.match(/^\\[a-zA-Z]+\s*\{/);
      if (textCmdMatch) {
        const cmd = textCmdMatch[0].slice(1).replace(/\s*\{$/, '');
        if (TEXT_COMMANDS.has(cmd)) {
          const braceStart = i + textCmdMatch[0].length - 1;
          const braced = extractBraced(s, braceStart);
          if (braced) {
            let content = braced.content;
            if (cmd === 'text' || cmd === 'textbf') {
              appendRun(content);
            } else {
              // 针对 \mathrm, \operatorname 等，压缩 MinerU OCR 产生的字符间空隙：V I F -> VIF
              content = content.replace(/([a-zA-Z0-9])\s+(?=[a-zA-Z0-9])/g, '$1').trim();
              if (content.includes('\\')) {
                nodes.push(...parseMathNodes(content));
              } else {
                appendRun(content);
              }
            }
            i = braced.nextIdx;
            continue;
          }
        }
      }

      // 无花括号单字符/单命令样式：如 \mathrm h, \mathbf x, \mathrm \alpha
      const unbracedCmdMatch = rest.match(/^\\(mathrm|mathbf|mathit|textbf|bm|operatorname|boldsymbol|mathbb|mathcal|rm|bf|it|sf|tt)\b/i);
      if (unbracedCmdMatch) {
        let afterCmd = i + unbracedCmdMatch[0].length;
        while (afterCmd < s.length && /\s/.test(s[afterCmd])) afterCmd++;
        if (afterCmd < s.length) {
          if (s[afterCmd] === '{') {
            // 将由上面的有花括号逻辑处理，这里不拦截
          } else {
            const nextChar = s[afterCmd];
            if (/[a-zA-Z0-9]/.test(nextChar)) {
              appendRun(nextChar);
              i = afterCmd + 1;
              continue;
            } else if (nextChar === '\\') {
              // 跳过此修饰命令，下一轮迭代处理随后的命令
              i = afterCmd;
              continue;
            }
          }
        }
      }

      // 左右括号成对处理 \left ... \right (支持任意空白及多种括号类型、支持嵌套)
      const leftMatch = rest.match(/^\\left\b\s*(\(|\[|\\\{|\\\}|\||\\\||\\langle|\.)/);
      if (leftMatch) {
        const leftDelim = leftMatch[1];
        let depth = 1;
        let pos = i + leftMatch[0].length;
        let rightMatch = null;

        while (pos < s.length) {
          const sub = s.slice(pos);
          const subLeft = sub.match(/^\\left\b\s*(\(|\[|\\\{|\\\}|\||\\\||\\langle|\.)/);
          if (subLeft) {
            depth++;
            pos += subLeft[0].length;
            continue;
          }
          const subRight = sub.match(/^\\right\b\s*(\)|\]|\\\}|\\\{|\||\\\||\\rangle|\.)/);
          if (subRight) {
            depth--;
            if (depth === 0) {
              rightMatch = {
                start: pos,
                end: pos + subRight[0].length,
                delim: subRight[1]
              };
              break;
            }
            pos += subRight[0].length;
            continue;
          }
          pos++;
        }

        if (rightMatch) {
          const innerContent = s.slice(i + leftMatch[0].length, rightMatch.start);
          const innerNodes = parseMathNodes(innerContent);
          const rightDelim = rightMatch.delim;

          if (leftDelim === '(' && rightDelim === ')') {
            nodes.push(new MathRoundBrackets({ children: innerNodes }));
          } else if (leftDelim === '[' && rightDelim === ']') {
            nodes.push(new MathSquareBrackets({ children: innerNodes }));
          } else if ((leftDelim === '\\{' || leftDelim === '{') && (rightDelim === '\\}' || rightDelim === '}')) {
            nodes.push(new MathCurlyBrackets({ children: innerNodes }));
          } else if (leftDelim === '\\langle' && rightDelim === '\\rangle') {
            nodes.push(new MathAngledBrackets({ children: innerNodes }));
          } else {
            if (leftDelim !== '.') {
              const lChar = leftDelim === '\\{' ? '{' : leftDelim === '\\}' ? '}' : leftDelim === '\\|' ? '‖' : leftDelim === '\\langle' ? '⟨' : leftDelim;
              appendRun(lChar);
            }
            nodes.push(...innerNodes);
            if (rightDelim !== '.') {
              const rChar = rightDelim === '\\}' ? '}' : rightDelim === '\\{' ? '{' : rightDelim === '\\|' ? '‖' : rightDelim === '\\rangle' ? '⟩' : rightDelim;
              appendRun(rChar);
            }
          }
          i = rightMatch.end;
          continue;
        } else {
          // 未匹配到 \right，平滑降级，输出左定界符，不输出字面 \left
          if (leftDelim !== '.') {
            appendRun(leftDelim === '\\{' ? '{' : leftDelim === '\\}' ? '}' : leftDelim);
          }
          i += leftMatch[0].length;
          continue;
        }
      }

      // 孤立 \right 降级处理
      const rightOrphanMatch = rest.match(/^\\right\b\s*(\)|\]|\\\}|\\\{|\||\\\||\\rangle|\.)/);
      if (rightOrphanMatch) {
        const rDelim = rightOrphanMatch[1];
        if (rDelim !== '.') {
          appendRun(rDelim === '\\}' ? '}' : rDelim === '\\{' ? '{' : rDelim);
        }
        i += rightOrphanMatch[0].length;
        continue;
      }

      // \bigl, \bigr, \Bigl, \Bigr 等尺寸修饰
      const bigMatch = rest.match(/^\\(?:big|Big|bigg|Bigg)[lr]?\s*([(\[\])/|]|\\[{}|])/i);
      if (bigMatch) {
        const bDelim = bigMatch[1];
        appendRun(bDelim === '\\{' ? '{' : bDelim === '\\}' ? '}' : bDelim === '\\|' ? '‖' : bDelim);
        i += bigMatch[0].length;
        continue;
      }

      // 转义 \{ 或 \}
      if (/^\\[{}]/.test(rest)) {
        appendRun(rest[1]);
        i += 2;
        continue;
      }

      // 符号和函数名命令：未知命令保留原文 \cmd，避免剥反斜杠留裸名误导
      const cmdMatch = rest.match(/^\\[a-zA-Z]+/);
      if (cmdMatch) {
        const cmd = cmdMatch[0].slice(1);
        if (SYMBOL_MAP[cmd]) {
          appendRun(SYMBOL_MAP[cmd]);
          i += cmdMatch[0].length;
          continue;
        }
        if (FUNCTION_NAMES.has(cmd)) {
          appendRun(cmd + ' ');
          i += cmdMatch[0].length;
          continue;
        }
        appendRun(`\\${cmd}`);
        i += cmdMatch[0].length;
        continue;
      }

      appendRun(s[i]);
      i++;
      continue;
    }

    // 2. 上标 ^ 与 下标 _
    if (s[i] === '^' || s[i] === '_') {
      const firstIsSuper = s[i] === '^';
      const firstArg = extractScriptArgument(s, i + 1);
      if (firstArg) {
        let nextIdx = firstArg.nextIdx;
        let secondArg = null;

        let checkIdx = nextIdx;
        while (checkIdx < s.length && /\s/.test(s[checkIdx])) checkIdx++;
        if (checkIdx < s.length && (s[checkIdx] === (firstIsSuper ? '_' : '^'))) {
          secondArg = extractScriptArgument(s, checkIdx + 1);
          if (secondArg) {
            nextIdx = secondArg.nextIdx;
          }
        }

        const supContent = firstIsSuper ? firstArg.content : (secondArg ? secondArg.content : null);
        const subContent = !firstIsSuper ? firstArg.content : (secondArg ? secondArg.content : null);

        let base = nodes.length ? nodes.pop() : mathRun('');

        if (supContent !== null && subContent !== null) {
          nodes.push(
            new MathSubSuperScript({
              children: [base],
              subScript: parseMathNodes(subContent),
              superScript: parseMathNodes(supContent)
            })
          );
        } else if (supContent !== null) {
          nodes.push(
            new MathSuperScript({
              children: [base],
              superScript: parseMathNodes(supContent)
            })
          );
        } else if (subContent !== null) {
          nodes.push(
            new MathSubScript({
              children: [base],
              subScript: parseMathNodes(subContent)
            })
          );
        }
        i = nextIdx;
        continue;
      }
    }

    // 3. 大括号块 { ... }
    if (s[i] === '{') {
      const b = extractBraced(s, i);
      if (b) {
        const innerNodes = parseMathNodes(b.content);
        nodes.push(...innerNodes);
        i = b.nextIdx;
        continue;
      }
    }

    // 4. 普通字符
    appendRun(s[i]);
    i++;
  }

  return nodes;
}

function latexToDocxMath(latex) {
  let clean = String(latex || '').trim();
  if (clean.startsWith('$$') && clean.endsWith('$$') && clean.length >= 4) {
    clean = clean.slice(2, -2).trim();
  } else if (clean.startsWith('$') && clean.endsWith('$') && clean.length >= 2) {
    clean = clean.slice(1, -1).trim();
  }
  // 环境兼容：equation/align/gather/multline/cases/matrix/aligned/bmatrix/pmatrix 均剥离外壳保留内容
  clean = clean
    .replace(/^\\begin\{(?:equation|align|gather|multline|cases|matrix|aligned|bmatrix|pmatrix|vmatrix)\*?\}/, '')
    .replace(/\\end\{(?:equation|align|gather|multline|cases|matrix|aligned|bmatrix|pmatrix|vmatrix)\*?\}$/, '')
    .replace(/\\begin\{[^}]+\}/g, '')
    .replace(/\\end\{[^}]+\}/g, '')
    .replace(/\\\\/g, ' ; ')
    .replace(/&/g, ' ')
    .trim();

  // 提取并规范化公式编号 \tag{...} 或 \tag...，避免字面 \tag 残留在 Word 公式中
  let eqTag = null;
  clean = clean
    .replace(/\\tag\*?\s*\{([^}]+)\}/g, (_m, t) => {
      eqTag = t.trim();
      return '';
    })
    .replace(/\\tag\*?\s*(\d+)/g, (_m, t) => {
      eqTag = t.trim();
      return '';
    })
    .trim();

  if (eqTag) {
    const formattedTag = eqTag.startsWith('(') && eqTag.endsWith(')') ? eqTag : `(${eqTag})`;
    clean = `${clean} \\qquad ${formattedTag}`;
  }

  // 压缩数字间 OCR 伪空白：如 1 0 -> 10, 0 . 0 5 -> 0.05
  clean = clean.replace(/(\d)\s+(?=\d)/g, '$1');
  clean = clean.replace(/(\d)\s*\.\s*(\d)/g, '$1.$2');

  try {
    const nodes = parseMathNodes(clean);
    return new DocxMath({
      children: nodes.length ? nodes : [mathRun(clean)]
    });
  } catch {
    return new DocxMath({
      children: [mathRun(clean)]
    });
  }
}

function plainText(value) {
  return sanitizeXmlText(
    String(value || '')
      .replace(/\\([\\`*_{}\[\]()#+.!<>-])/g, '$1')
      .replace(/<(sup|sub)\b[^>]*>([\s\S]*?)<\/\1>/gi, '$2')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\^([^^]+)\^/g, '$1')
  );
}

function textRun(value, options = {}) {
  const runOptions = {
    text: plainText(value),
    font: DEFAULT_FONT,
    color: '000000',
    ...options
  };
  if (options.font && typeof options.font === 'string') {
    runOptions.font = options.font;
  } else if (options.font && typeof options.font === 'object') {
    runOptions.font = { ...DEFAULT_FONT, ...options.font };
  }
  return rememberText(new TextRun(runOptions), runOptions.text);
}

const inlineBufferCache = new Map();
function decodeDataUriCached(uri) {
  let hit = inlineBufferCache.get(uri);
  if (!hit) {
    hit = dataUriToBuffer(uri);
    if (hit) {
      inlineBufferCache.set(uri, hit);
      if (inlineBufferCache.size > 300) {
        const firstKey = inlineBufferCache.keys().next().value;
        inlineBufferCache.delete(firstKey);
      }
    }
  }
  return hit;
}

function parseInlineRuns(text, defaultOptions = {}) {
  const source = String(text || '');
  const runs = [];
  let cursor = 0;
  // 图片正则放宽到任意 src：data: 走嵌入，http(s) 降级为链接文本，不再静默变字面或抛错。
  const tokenRe = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)|!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|(<img\b[^>]*>)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gi;
  let match;

  while ((match = tokenRe.exec(source))) {
    if (match.index > cursor) runs.push(...formatTextRuns(source.slice(cursor, match.index), defaultOptions));
    if (match[1]) {
      runs.push(latexToDocxMath(match[1]));
    } else if (match[3]) {
      const src = match[3];
      if (/^https?:/i.test(src)) {
        runs.push(...formatTextRuns(`[外部图片：${match[2] || '图'}](${src})`, defaultOptions));
      } else if (/^data:/i.test(src)) {
        const parsed = decodeDataUriCached(src);
        if (!parsed) {
          runs.push(...formatTextRuns(`[图片数据无效：${match[2] || '未命名图片'}]`, defaultOptions));
        } else {
          const image = prepareImage(parsed);
          runs.push(new ImageRun({ type: imageType(image.mime), data: image.data, transformation: clampImageSize(image.data, image.mime) }));
        }
      } else {
        runs.push(...formatTextRuns(`[缺图占位：${match[2] || src}]`, defaultOptions));
      }
    } else if (match[4]) {
      const tag = match[4];
      const srcMatch = tag.match(/\bsrc\s*=\s*(["'])([^"']+)\1/i);
      const src = srcMatch && srcMatch[2];
      if (!src) {
        runs.push(...formatTextRuns('[图片]', defaultOptions));
      } else if (/^https?:/i.test(src)) {
        runs.push(...formatTextRuns(`[外部图片](${src})`, defaultOptions));
      } else if (/^data:/i.test(src)) {
        const parsed = decodeDataUriCached(src);
        if (!parsed) {
          runs.push(...formatTextRuns('[图片数据无效]', defaultOptions));
        } else {
          const image = prepareImage(parsed);
          runs.push(new ImageRun({ type: imageType(image.mime), data: image.data, transformation: clampImageSize(image.data, image.mime) }));
        }
      } else {
        runs.push(...formatTextRuns('[缺图占位]', defaultOptions));
      }
    } else if (match[5]) {
      runs.push(...formatTextRuns(match[5], defaultOptions));
    } else {
      runs.push(...formatTextRuns(match[0], defaultOptions));
    }
    cursor = tokenRe.lastIndex;
  }
  if (cursor < source.length) runs.push(...formatTextRuns(source.slice(cursor), defaultOptions));
  return runs.length ? runs : [textRun('', defaultOptions)];
}

/**
 * DOCX 只接受 PNG/JPEG/GIF/BMP。先把已经内嵌到 Markdown/HTML 的 WebP/SVG
 * 统一转换成 PNG，再走同步 Markdown AST，避免 ImageRun 静默丢图或接收伪格式。
 */
async function prepareMarkdownImages(markdown, { signal, conversionCache = new Map() } = {}) {
  const source = String(markdown || '');
  const uris = [...source.matchAll(UNSUPPORTED_DATA_URI_RE)].map((match) => match[1]);
  for (const uri of new Set(uris)) {
    if (conversionCancelled(signal)) throw new CancelledError();
    if (!conversionCache.has(uri)) {
      const parsed = dataUriToBuffer(uri);
      if (!parsed) throw conversionError('内嵌 WebP/SVG 数据无效');
      conversionCache.set(uri, convertUnsupportedImage(parsed.data, parsed.mime, signal));
    }
    const converted = await conversionCache.get(uri);
    if (!converted || !converted.data || !converted.data.length) {
      throw conversionError('内嵌 WebP/SVG 转换结果为空');
    }
    conversionCache.set(uri, `data:image/png;base64,${converted.data.toString('base64')}`);
  }
  return source.replace(UNSUPPORTED_DATA_URI_RE, (_full, uri) => {
    const converted = conversionCache.get(uri);
    if (typeof converted !== 'string') throw conversionError('图片转换缓存损坏');
    return converted;
  });
}

function formatTextRuns(value, defaultOptions = {}) {
  const text = String(value || '');
  if (!text) return [];
  const runs = [];
  const re = /(<sup\b[^>]*>[\s\S]*?<\/sup>|<sub\b[^>]*>[\s\S]*?<\/sub>|\^[^^]+\^|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_)/gi;
  let cursor = 0;
  let match;
  while ((match = re.exec(text))) {
    if (match.index > cursor) runs.push(textRun(text.slice(cursor, match.index), defaultOptions));
    const token = match[0];
    const lower = token.toLowerCase();
    if (lower.startsWith('<sup')) {
      const inner = token.replace(/<\/?sup\b[^>]*>/gi, '');
      runs.push(textRun(inner, { ...defaultOptions, superScript: true }));
    } else if (lower.startsWith('<sub')) {
      const inner = token.replace(/<\/?sub\b[^>]*>/gi, '');
      runs.push(textRun(inner, { ...defaultOptions, subScript: true }));
    } else if (token.startsWith('^') && token.endsWith('^')) {
      runs.push(textRun(token.slice(1, -1), { ...defaultOptions, superScript: true }));
    } else if (token.startsWith('**') || token.startsWith('__')) {
      runs.push(textRun(token.slice(2, -2), { ...defaultOptions, bold: true }));
    } else if (token.startsWith('~~')) {
      runs.push(textRun(token.slice(2, -2), { ...defaultOptions, strike: true }));
    } else if ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_'))) {
      runs.push(textRun(token.slice(1, -1), { ...defaultOptions, italics: true }));
    } else {
      runs.push(textRun(token.slice(1, -1), { ...defaultOptions, font: 'Consolas' }));
    }
    cursor = re.lastIndex;
  }
  if (cursor < text.length) runs.push(textRun(text.slice(cursor), defaultOptions));
  return runs;
}

function tableFromRows(rows) {
  const validRows = (rows || []).filter((r) => Array.isArray(r) && r.some((c) => String(c || '').trim().length > 0));
  if (!validRows.length) return null;
  const width = validRows.reduce((n, row) => Math.max(n, row.length), 1);
  return new Table({
    alignment: AlignmentType.CENTER,
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: validRows.map((row, rowIndex) =>
      new TableRow({
        // 大表允许跨页拆分（cantSplit 会顶出页），表头行跨页重复
        cantSplit: validRows.length <= 8,
        tableHeader: rowIndex === 0,
        children: Array.from({ length: width }, (_, col) =>
          new TableCell({
            borders: CELL_BORDERS,
            children: [
              new Paragraph({
                children: parseInlineRuns(row[col] || '', rowIndex === 0 ? { bold: true } : {})
              })
            ]
          })
        )
      })
    )
  });
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlCellToMarkdown(value) {
  let text = String(value || '')
    .replace(/<img\b[^>]*\bsrc\s*=\s*(["'])(data:[^"']+)\1[^>]*>/gi, (_m, _q, src) => `![图](${src})`)
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return sanitizeXmlText(decodeHtml(text).trim());
}

function tableFromHtml(html) {
  try {
    const rawRows = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
    let rowMatch;
    while ((rowMatch = rowRe.exec(String(html || '')))) {
      const cells = [];
      const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
      let cellMatch;
      while ((cellMatch = cellRe.exec(rowMatch[1]))) {
        const attrs = cellMatch[2] || '';
        const span = (name) => {
          const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, 'i'));
          return m ? Math.max(1, Number(m[1])) : undefined;
        };
        cells.push({
          text: htmlCellToMarkdown(cellMatch[3]),
          rowSpan: span('rowspan'),
          columnSpan: span('colspan'),
          header: cellMatch[1].toLowerCase() === 'th'
        });
      }
      if (cells.length) rawRows.push(cells);
    }
    if (!rawRows.length) return null;

    // 校验与修剪 rowspan，防止孤立的 restart 造成 Word 损坏
    return new Table({
      alignment: AlignmentType.CENTER,
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: rawRows.map((row, rowIndex) => {
        const remainingRows = rawRows.length - rowIndex;
        return new TableRow({
          cantSplit: rawRows.length <= 8,
          tableHeader: rowIndex === 0,
          children: row.map((cell) => {
            const rawSpan = cell.rowSpan && cell.rowSpan > 1 ? Math.min(cell.rowSpan, remainingRows) : undefined;
            const safeRowSpan = rawSpan && rawSpan > 1 ? rawSpan : undefined;
            return new TableCell({
              borders: CELL_BORDERS,
              children: [
                new Paragraph({
                  children: parseInlineRuns(cell.text, rowIndex === 0 || cell.header ? { bold: true } : {})
                })
              ],
              rowSpan: safeRowSpan,
              columnSpan: cell.columnSpan
            });
          })
        });
      })
    });
  } catch (err) {
    console.warn('[docx] HTML 表格转换异常，已跳过：', err.message);
    return null;
  }
}

function splitRow(row) {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function markdownChildren(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const children = [];
  const inRefsDocx = { value: false };
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) {
      i++;
      continue;
    }

    if (/^<table\b/i.test(t)) {
      const table = [raw];
      i++;
      if (!/<\/table\s*>/i.test(raw)) {
        while (i < lines.length && !/<\/table\s*>/i.test(lines[i])) table.push(lines[i++]);
        if (i < lines.length) table.push(lines[i++]);
      }
      const parsed = tableFromHtml(table.join('\n'));
      if (parsed) children.push(parsed);
      continue;
    }

    if (/^(```|~~~)/.test(t)) {
      const marker = t.slice(0, 3);
      const lang = t.slice(3).trim();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) code.push(lines[i++]);
      if (i < lines.length) i++;
      if (lang) {
        const langText = sanitizeXmlText(lang);
        children.push(
          new Paragraph({
            children: [rememberText(new TextRun({ text: langText, font: 'Consolas', size: 16, color: '555555' }), langText)],
            spacing: { before: 80, after: 20 }
          })
        );
      }
      const codeText = sanitizeXmlText(code.join('\n'));
      children.push(
        new Paragraph({
          children: [rememberText(new TextRun({ text: codeText, font: 'Consolas', size: 19, color: '000000' }), codeText)],
          border: {
            top: { color: '000000', size: 4, style: 'single' },
            bottom: { color: '000000', size: 4, style: 'single' },
            left: { color: '000000', size: 4, style: 'single' },
            right: { color: '000000', size: 4, style: 'single' }
          },
          spacing: { before: lang ? 20 : 80, after: 80 }
        })
      );
      continue;
    }

    /* --- 独立块级公式 $$ ... $$ --- */
    if (t.startsWith('$$')) {
      if (t.length > 4 && t.endsWith('$$')) {
        children.push(
          new Paragraph({
            children: [latexToDocxMath(t.slice(2, -2))],
            alignment: AlignmentType.CENTER,
            spacing: { before: 120, after: 120 }
          })
        );
        i++;
        continue;
      }
      const tex = [t];
      i++;
      while (i < lines.length && !lines[i].trim().endsWith('$$')) {
        tex.push(lines[i++]);
      }
      if (i < lines.length) {
        tex.push(lines[i++]);
      }
      const formula = tex.join('\n').replace(/^\$\$/, '').replace(/\$\$$/, '');
      children.push(
        new Paragraph({
          children: [latexToDocxMath(formula)],
          alignment: AlignmentType.CENTER,
          spacing: { before: 120, after: 120 }
        })
      );
      continue;
    }

    const heading = t.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const inner = heading[2];
      const level = heading[1].length;
      if (/^(?:\d+[.\s]*)?(references|bibliography|literature cited|参考文献|引用文献)\b/i.test(inner.trim())) {
        inRefsDocx.value = true;
      } else if (/^(?:\d+[.\s]*)?(appendix|appendices|附录|补充材料|supplementary)\b/i.test(inner.trim())) {
        inRefsDocx.value = false;
      }
      const strictCaption = /^\s*(?:图|表|表格|Figure|Fig\.|Table|Tab\.)\s*[\d一二三四五六七八九十IVXLCDMivxlcdm]+/i.test(inner.trim());
      if (isCaptionText(inner) && strictCaption) {
        // 保留标题语义，不断 Word 导航窗格：用对应 HeadingLevel + 居中
        const map = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
        const capLevel = Math.min(6, Math.max(3, level));
        children.push(
          new Paragraph({
            heading: map[capLevel - 1],
            children: parseInlineRuns(inner, { bold: true }),
            alignment: AlignmentType.CENTER,
            spacing: { before: 120, after: 180 }
          })
        );
      } else {
        const map = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
        children.push(new Paragraph({ heading: map[level - 1], children: parseInlineRuns(inner, { bold: true }) }));
      }
      i++;
      continue;
    }

    if (/^\|/.test(t) && i + 1 < lines.length && /^\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1].trim())) {
      const rows = [splitRow(lines[i])];
      i += 2;
      while (i < lines.length && /^\|/.test(lines[i].trim())) rows.push(splitRow(lines[i++]));
      const tbl = tableFromRows(rows);
      if (tbl) children.push(tbl);
      continue;
    }

    if (t.startsWith('>')) {
      const quote = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quote.push(lines[i++].trim().replace(/^>\s?/, ''));
      }
      // 引用内递归解析，保留嵌套列表/表格/公式结构，不再压成单段
      const innerChildren = markdownChildren(quote.join('\n'));
      for (const child of innerChildren) {
        if (child instanceof Paragraph) {
          child.indent = { ...(child.indent || {}), left: 360 };
          child.border = { ...(child.border || {}), left: { color: '000000', size: 12, style: 'single', space: 8 } };
        }
        children.push(child);
      }
      if (!innerChildren.length) {
        children.push(new Paragraph({
          children: parseInlineRuns(quote.join('\n')),
          indent: { left: 360 },
          border: { left: { color: '000000', size: 12, style: 'single', space: 8 } }
        }));
      }
      continue;
    }

    if (/^([-*+]|\d+\.)\s+/.test(t)) {
      const ordered = /^\d+\./.test(t);
      while (i < lines.length && /^([-*+]|\d+\.)\s+/.test(lines[i].trim())) {
        const item = lines[i++].trim().replace(/^([-*+]|\d+\.)\s+/, '');
        children.push(new Paragraph({ children: parseInlineRuns(item), bullet: ordered ? undefined : { level: 0 }, numbering: ordered ? { reference: 'pptor-numbering', level: 0 } : undefined }));
      }
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      children.push(new Paragraph({ border: { bottom: { color: '000000', size: 6, style: 'single', space: 1 } } }));
      i++;
      continue;
    }

    const paragraph = [raw];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s|^(```|~~~)|^\||^>|^([-*+]|\d+\.)\s+|^\$\$/.test(lines[i].trim())) paragraph.push(lines[i++]);
    const rawPara = paragraph.join('\n');
    if (/^(references|bibliography|literature cited|参考文献|引用文献)\s*$/i.test(rawPara.trim())) {
      inRefsDocx.value = true;
    } else if (/^(appendix|appendices|附录|补充材料|supplementary)/i.test(rawPara.trim())) {
      inRefsDocx.value = false;
    }
    // 段落内若混入块级公式则拆段，保证公式独立成段不嵌套在正文段内
    if (/\$\$[\s\S]+?\$\$/.test(rawPara) && rawPara.replace(/\$\$[\s\S]+?\$\$/g, '').trim().length > 0) {
      const parts = rawPara.split(/(\$\$[\s\S]+?\$\$)/g).map((s) => s.trim()).filter(Boolean);
      for (const part of parts) {
        if (/^\$\$[\s\S]+\$\$$/.test(part)) {
          children.push(new Paragraph({ children: [latexToDocxMath(part.slice(2, -2))], alignment: AlignmentType.CENTER, spacing: { before: 120, after: 120 } }));
        } else if (part) {
          const pr = parseInlineRuns(part, {});
          children.push(new Paragraph({ children: pr, indent: inRefsDocx.value ? { left: 360, hanging: 360 } : { firstLine: 440 }, spacing: { after: 120 } }));
        }
      }
      continue;
    }
    const isCaption = isCaptionText(rawPara);
    const runs = parseInlineRuns(rawPara, isCaption ? { bold: true } : {});
    const nonWhitespaceRuns = runs.filter((r) => {
      if (r instanceof ImageRun || r instanceof DocxMath) return true;
      const text = r.text || '';
      return text.trim().length > 0;
    });
    const hasImage = runs.some((r) => r instanceof ImageRun);
    const hasMath = runs.some((r) => r instanceof DocxMath);
    const isImageOnly = hasImage && nonWhitespaceRuns.every((r) => r instanceof ImageRun);
    const isMixedImageText = hasImage && !isImageOnly;
    const isMixedMathText = hasMath && nonWhitespaceRuns.some((r) => !(r instanceof DocxMath) && !(r instanceof ImageRun));

    if (isCaption) {
      children.push(
        new Paragraph({
          children: runs,
          alignment: AlignmentType.CENTER,
          spacing: { before: 80, after: 180 }
        })
      );
    } else if (isImageOnly) {
      children.push(
        new Paragraph({
          children: runs,
          alignment: AlignmentType.CENTER,
          keepNext: true, // 保证图片与下方图名同页显示，绝不被分页拆开
          spacing: { before: 140, after: 60 }
        })
      );
    } else if (isMixedImageText || isMixedMathText) {
      // 图文/公式与正文混排：拆成独立段落，各自隔离
      const imageRuns = runs.filter((r) => r instanceof ImageRun);
      const mathRuns = runs.filter((r) => r instanceof DocxMath);
      const textRuns = runs.filter((r) => !(r instanceof ImageRun) && !(r instanceof DocxMath));
      if (imageRuns.length) {
        children.push(new Paragraph({ children: imageRuns, alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 140, after: 60 } }));
      }
      if (mathRuns.length) {
        for (const m of mathRuns) {
          children.push(new Paragraph({ children: [m], alignment: AlignmentType.CENTER, spacing: { before: 120, after: 120 } }));
        }
      }
      const textOnly = textRuns.filter((r) => String(r.text || '').trim().length > 0);
      if (textOnly.length) {
        children.push(new Paragraph({ children: textOnly, indent: inRefsDocx.value ? { left: 360, hanging: 360 } : { firstLine: 440 }, spacing: { after: 120 } }));
      }
    } else if (inRefsDocx.value) {
      // 参考文献：悬挂缩进，不用首行缩进 2em
      children.push(
        new Paragraph({
          children: runs,
          indent: { left: 360, hanging: 360 },
          spacing: { after: 60 }
        })
      );
    } else {
      children.push(
        new Paragraph({
          children: runs,
          indent: { firstLine: 440 }, // 首行缩进 2 字符
          spacing: { after: 120 }
        })
      );
    }
  }
  return children;
}

async function markdownToDocx(markdown, options = {}) {
  const cleanMarkdown = sanitizeXmlText(markdown);
  const preparedMarkdown = await prepareMarkdownImages(cleanMarkdown, {
    signal: options.signal,
    conversionCache: options.imageConversionCache
  });
  const children = markdownChildren(preparedMarkdown);
  const doc = new Document({
    creator: 'PPtor',
    title: sanitizeXmlText(String(options.title || '')),
    styles: {
      default: {
        document: {
          run: {
            font: DEFAULT_FONT,
            color: '000000'
          }
        }
      }
    },
    numbering: {
      config: [
        {
          reference: 'pptor-numbering',
          levels: [
            {
              level: 0,
              format: 'decimal',
              text: '%1.',
              alignment: 'left',
              style: { paragraph: { indent: { left: 720, hanging: 360 } } }
            }
          ]
        }
      ]
    },
    sections: [{
      properties: { page: { margin: { top: 900, right: 1000, bottom: 900, left: 1000 } } },
      children
    }]
  });
  return Packer.toBuffer(doc);
}

module.exports = { markdownChildren, markdownToDocx, latexToDocxMath };
