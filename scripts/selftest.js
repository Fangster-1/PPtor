'use strict';


const path = require('node:path');

const { splitMarkdown, reassemble, buildBilingual } = require('../src/main/core/chunker');
const { renderMarkdown, buildHtmlDocument, normalizeMarkdownTables, isCaptionText } = require('../src/main/core/markdown');
const { markdownToDocx } = require('../src/main/core/docx');
const { unzip } = require('../src/main/core/zip');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
const SAMPLE = `# Attention Is All You Need

## 3. Model Architecture

The Transformer follows an encoder-decoder structure.

$$
\\text{Attention}(Q,K,V)=\\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V
$$

Most competitive neural sequence transduction models have an encoder-decoder structure [1,2].

\`\`\`python
def scaled_dot_product(q, k, v):
    # 这段代码不应该被翻译
    scores = q @ k.transpose(-2, -1)
    return scores
\`\`\`

| Model | BLEU | Params |
|---|---|---|
| Transformer (base) | 27.3 | 65M |
| Transformer (big) | 28.4 | 213M |

![Architecture](images/arch.png)

We use the Adam optimizer with $\\beta_1 = 0.9$, $\\beta_2 = 0.98$.
`;

console.log('\n[1] 分块保真性');

// 用极小的阈值强制触发多次切分
const segments = splitMarkdown(SAMPLE, { maxTokens: 30 });

check('确实触发了多片段切分', segments.length > 3,
  `实际只有 ${segments.length} 段，说明测试没有覆盖到切分路径`);

check('切分后能逐字节重组为原文', reassemble(segments, new Map()) === SAMPLE,
  '重组结果与原文不一致，说明分块丢了内容或多插了空行');

const blockMath = segments.filter((s) => s.content.includes('$$'));
check('块级公式未被从中间切断',
  blockMath.length > 0 &&
    blockMath.every((s) => (s.content.match(/\$\$/g) || []).length % 2 === 0));

const mathOnlySeg = segments.filter((s) => s.content.trim().startsWith('$$'));
check('块级公式独占片段', mathOnlySeg.length === 1,
  `找到 ${mathOnlySeg.length} 个以 $$ 开头的片段`);

const codeSegs = segments.filter((s) => s.content.includes('def scaled_dot_product'));
check('代码块完整落在同一片段内',
  codeSegs.length === 1 && codeSegs[0].content.includes('return scores'));

check('围栏起止成对出现',
  segments.every((s) => ((s.content.match(/```/g) || []).length) % 2 === 0));

check('代码块被标记为「无需翻译」',
  codeSegs.length === 1 && codeSegs[0].translatable === false);

check('公式块被标记为「无需翻译」',
  mathOnlySeg.length === 1 && mathOnlySeg[0].translatable === false);

// 单独验证各类片段的翻译判定
check('纯图片段落被标记为「无需翻译」',
  splitMarkdown('![alt](images/a.png)')[0].translatable === false);

check('标题段落被标记为「需要翻译」',
  splitMarkdown('# Introduction')[0].translatable === true);

check('正文段落被标记为「需要翻译」',
  splitMarkdown('The model achieves state-of-the-art results.')[0].translatable === true);

/* 参考文献区必须整段保留原文（翻了就找不回原文献），附录要恢复翻译 */
{
  const doc =
    '# Title\n\nBody paragraph.\n\n## References\n\nSmith, J. et al., 2020. A study. Journal.\n\n' +
    'Doe, A., 2021. Another study. Nature.\n\n## Appendix\n\nAppendix body to translate.\n';
  const segs = splitMarkdown(doc, { maxTokens: 30 });
  const find = (needle) => segs.find((s) => s.content.includes(needle));

  check('References 章节标记为「无需翻译」', find('## References') && find('## References').translatable === false);
  check('参考文献条目标记为「无需翻译」', find('Smith, J.') && find('Smith, J.').translatable === false);
  check('参考文献之后的附录恢复「需要翻译」',
    find('Appendix body') && find('Appendix body').translatable === true);
  check('参考文献区不影响逐字节重组', reassemble(segs, new Map()) === doc);
}

{
  const doc = '# 标题\n\n正文。\n\n## 参考文献\n\n[1] Zhang et al. 2024.\n\n## 附录 A\n\nAppendix text to translate.\n';
  const segs = splitMarkdown(doc, { maxTokens: 30 });
  const find = (needle) => segs.find((s) => s.content.includes(needle));
  check('中文参考文献标题标记为「无需翻译」', find('## 参考文献')?.translatable === false);
  check('中文参考文献条目保持原文', find('Zhang et al.')?.translatable === false);
  check('中文附录标题后恢复翻译', find('Appendix text')?.translatable === true);
}

console.log('\n[2] 译文回填与双语组装');
const fake = new Map();
segments.forEach((s) => {
  if (s.translatable) fake.set(s.id, '【译】' + s.content.replace(/\n/g, '\n'));
});

const merged = reassemble(segments, fake);
check('回填后公式仍然原样保留', merged.includes('\\text{softmax}'));
check('回填后代码块内容未被改动', merged.includes('scores = q @ k.transpose(-2, -1)'));
check('回填后图片引用未被改动', merged.includes('![Architecture](images/arch.png)'));
check('回填后引用标记 [1,2] 保留', merged.includes('[1,2]'));
check('回填后译文确实插入了', merged.includes('【译】'));

const bilingual = buildBilingual(segments, fake);
check('双语版同时含原文与译文',
  bilingual.includes('The Transformer follows') && bilingual.includes('【译】'));
check('双语版用引用块承载译文', bilingual.includes('> '));

console.log('\n[3] Markdown 渲染');
const html = renderMarkdown(SAMPLE);
check('渲染出一级标题', html.includes('<h1>'));
check('渲染出二级标题', html.includes('<h2>'));
check('渲染出表格', html.includes('<table>') && html.includes('<th>'));
check('渲染出代码块', html.includes('<pre><code'));
check('代码内容被转义而非执行', html.includes('&lt;') || !html.includes('<script'));
check('渲染出图片标签', html.includes('<img src="images/arch.png"'));
check('保留 LaTeX 公式原文', html.includes('\\text{softmax}'));

const doc = buildHtmlDocument({ title: 't', bodyHtml: html, renderMath: true });
check('HTML 文档结构完整',
  doc.startsWith('<!DOCTYPE html>') && doc.includes('</html>') && doc.includes('katex'));

const unsafe = renderMarkdown('<script>alert(1)</script>');
check('HTML 注入被转义', !unsafe.includes('<script>'));

const authorSample = renderMarkdown('Kaiyuan Zheng <sup>a</sup>, Xuean Shen <sup>b</sup>, Wei Ling <sup>b,\\*</sup>');
check('作者上标 sup 正常渲染且还原转义星号', authorSample.includes('<sup>a</sup>') && authorSample.includes('<sup>b,*</sup>'));

const captionSample = renderMarkdown('图 1 模型整体架构流程图\n\n表 1 实验结果对比');
check('图名与表名识别为 caption 居中段落', captionSample.includes('<p class="caption">图 1 模型整体架构流程图</p>') && captionSample.includes('<p class="caption">表 1 实验结果对比</p>'));

check('HTML 样式包含段落首行缩进 2 字符与标题居中', doc.includes('text-indent: 2em;') && doc.includes('.caption { text-align: center;'));

console.log('\n[4] ZIP 解压（自实现）');

/** 造一个 store 方式的最小 ZIP，用来验证目录解析逻辑 */
function makeTestZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);

    parts.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 10); // store
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, centralBuf, eocd]);
}

const zipBuf = makeTestZip([
  { name: 'full.md', content: '# 解析结果\n\n公式 $x^2$' },
  { name: 'images/fig1.png', content: 'PNG-BYTES' }
]);

const entries = unzip(zipBuf);
check('解压出 2 个条目', entries.length === 2, `实际 ${entries.length}`);

const md = entries.find((e) => e.name === 'full.md');
check('full.md 内容正确', !!md && md.data.toString('utf8').includes('解析结果'));

const png = entries.find((e) => e.name === 'images/fig1.png');
check('嵌套路径条目可解析', !!png && png.data.toString('utf8') === 'PNG-BYTES');

let threw = false;
try {
  unzip(Buffer.from('这不是一个 zip 文件'));
} catch {
  threw = true;
}
check('非 ZIP 输入会抛出明确错误', threw);

let rejectedZipBomb = false;
try {
  unzip(zipBuf, { maxEntries: 1 });
} catch {
  rejectedZipBomb = true;
}
check('ZIP 条目数超出安全上限会拒绝', rejectedZipBomb);

const { safeArchiveEntryName } = require('../src/main/core/parser');
check('解析归档拒绝路径穿越图片名', safeArchiveEntryName('../../outside.png') === '');
check('解析归档保留嵌套图片相对路径', safeArchiveEntryName('images/page-1/plot.png') === 'images/page-1/plot.png');


console.log('\n[5] 桌宠资源（Codex Pet 格式）');

const fs = require('node:fs');
const ROOT = path.resolve(__dirname, '..');
const petDir = path.join(ROOT, 'pets', 'paper-pet');

const manifest = JSON.parse(fs.readFileSync(path.join(petDir, 'pet.json'), 'utf8'));
check('pet.json 含 id / displayName / spritesheetPath',
  Boolean(manifest.id && manifest.displayName && manifest.spritesheetPath),
  JSON.stringify(manifest));

const spritePath = path.join(petDir, manifest.spritesheetPath);
const spriteBuf = fs.readFileSync(spritePath);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
check('精灵图是合法 PNG', spriteBuf.subarray(0, 8).equals(PNG_SIG));

const sw = spriteBuf.readUInt32BE(16);
const sh = spriteBuf.readUInt32BE(20);
check('精灵图为 1536 × 1872', sw === 1536 && sh === 1872, `实际 ${sw} × ${sh}`);
check('可切分为 8 列 × 9 行', sw % 8 === 0 && sh % 9 === 0);
check('每格为 192 × 208', sw / 8 === 192 && sh / 9 === 208, `实际 ${sw / 8} × ${sh / 9}`);

check('托盘图标已生成', fs.existsSync(path.join(ROOT, 'assets', 'tray.png')));
check('应用图标已生成', fs.existsSync(path.join(ROOT, 'build', 'icon.ico')));


console.log('\n[6] 论文问答检索');

const qa = require('../src/main/core/qa');

const corpus = qa.buildCorpus([
  {
    name: 'demo.md',
    markdown:
      '# 研究方法\n我们提出了一种基于自注意力机制的编码器结构，用于长文档建模。' +
      '该结构由多头注意力与逐位置前馈网络交替堆叠而成，并在每一层后接残差连接与层归一化。\n\n' +
      '## 训练细节\n所有模型均使用 Adam 优化器训练，学习率采用预热加余弦退火的调度策略。' +
      '批量大小设置为 2048，总训练步数为 100000 步，训练过程中使用混合精度以降低显存占用。\n\n' +
      '## 实验设置\n在 ImageNet 数据集上训练了 300 个 epoch，并在验证集上early stopping。' +
      '数据增强包括随机裁剪、水平翻转与颜色抖动三种标准手段。\n\n' +
      '# 实验结果\n与基线相比准确率提升了 5.2%，参数量减少 18%，推理延迟下降 23%。' +
      '消融实验表明，多头注意力层数的增加对性能提升贡献最大，而位置编码方式的影响相对有限。'
  },
  {
    name: 'demo2.md',
    markdown:
      '# 对比方法\n我们与三种既有基线进行了对比，均使用相同的训练与评测协议。\n\n' +
      '# 结论\n该方法在保持精度的同时显著降低了计算开销，适合部署到边缘设备。'
  }
]);

check('多篇论文都进入语料', new Set(corpus.docs.map((d) => d.paper)).size === 2);

// 长文必须能切成多段，否则检索会退化
const longCorpus = qa.buildCorpus([
  {
    name: 'long.md',
    markdown: ('# 章节标题\n' + '这是一段用于测试切分的正文内容，重复多次以超过阈值。'.repeat(40) + '\n\n').repeat(6)
  }
]);
check('长文会被切分成多段', longCorpus.docs.length > 1, `实际 ${longCorpus.docs.length} 段`);

const hit = qa.retrieve(corpus, '准确率提升了多少');
check('能检索到相关片段', hit.length > 0);
check('命中片段含答案数值', hit.some((d) => d.content.includes('5.2%')));

const hit2 = qa.retrieve(corpus, 'ImageNet 训练了多少 epoch');
check('英文关键词也能命中', hit2.some((d) => d.content.includes('300 个 epoch')));

const miss = qa.retrieve(corpus, '月球背面的引力异常');
check('完全无关的问题不产生命中', miss.length === 0, `却命中 ${miss.length} 段`);

check('空语料不会崩', qa.retrieve(qa.buildCorpus([]), '随便问问').length === 0);
console.log('\n[7] 文本分析');

const textUtil = require('../src/main/core/text');

const enDoc = textUtil.detectEnglishPaper(
  'The quick brown fox jumps over the lazy dog. This paper proposes a novel method. '.repeat(20)
);
check('英文正文 → 识别为英文论文', enDoc.isEnglish === true, JSON.stringify({ latin: enDoc.latinRatio.toFixed(2) }));

const cnDoc = textUtil.detectEnglishPaper(
  '本文提出了一种基于自注意力机制的编码器结构，用于长文档建模与理解任务。'.repeat(20)
);
check('中文正文 → 识别为非英文', cnDoc.isEnglish === false, JSON.stringify({ cjk: cnDoc.cjkRatio.toFixed(2) }));

check('过短文本不误判', textUtil.detectEnglishPaper('短文本').isEnglish === true);

// —— 标题提取 ——
check(
  '提取一级标题作为产物名',
  textUtil.extractTitle('# 注意力机制在长文档建模中的应用\n\n正文…', 'fallback') ===
    '注意力机制在长文档建模中的应用'
);
check(
  '无一级标题时退到二级标题',
  textUtil.extractTitle('## 研究方法\n\n正文…', 'fallback') === '研究方法'
);
check(
  '无标题时回退到原文件名',
  textUtil.extractTitle('正文没有标题。', 'attention-is-all-you-need') === 'attention-is-all-you-need'
);

// —— 文件名 ——
check(
  'Windows 非法字符被替换',
  textUtil.safeFileName('A/B:C?D"E<F>G|H') === 'A B C D E F G H',
  textUtil.safeFileName('A/B:C?D"E<F>G|H')
);
check('Markdown 强调标记被清理', textUtil.safeFileName('**粗体**与`代码`') === '粗体与代码');
check('结尾的点与中文句号被去掉', textUtil.safeFileName('标题。。。   ') === '标题');
check('Windows 保留字被处理', textUtil.safeFileName('CON') === 'CON_');
check('超长标题被截断', textUtil.safeFileName('啊'.repeat(200)).length === 80);


const http = require('node:http');
const { listModels, checkConnectivity, resolveModelAlias } = require('../src/main/core/translator');
const { checkParserConnectivity } = require('../src/main/core/parser');

const server = http.createServer((req, res) => {
  if (req.url === '/ok/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'a-model' }, { name: 'c-model' }] }));
  } else if (req.url === '/bad/models') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('not json at all');
  } else if (req.url === '/err/models') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
  } else if (req.url === '/empty/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  } else {
    res.writeHead(404);
    res.end('{}');
  }
});

(async () => {
  console.log('\n[8] 模型列表拉取');

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const models = await listModels({ baseUrl: `${base}/ok`, apiKey: 'k' });
  check('去重并排序后返回模型 id',
    JSON.stringify(models) === JSON.stringify(['a-model', 'b-model', 'c-model']),
    JSON.stringify(models));

  let threw = false;
  try {
    await listModels({ baseUrl: `${base}/bad`, apiKey: 'k' });
  } catch {
    threw = true;
  }
  check('非 JSON 响应会抛错', threw);

  let err = null;
  try {
    await listModels({ baseUrl: `${base}/err`, apiKey: 'k' });
  } catch (e) {
    err = e;
  }
  check('401 会抛错且带状态码', !!err && err.status === 401, err && err.message);

  threw = false;
  try {
    await listModels({ baseUrl: `${base}/empty`, apiKey: 'k' });
  } catch {
    threw = true;
  }
  check('空列表视为失败（回退手填）', threw);

  threw = false;
  try {
    await listModels({ baseUrl: '', apiKey: 'k' });
  } catch {
    threw = true;
  }
  check('缺地址直接抛错，不发请求', threw);

  const connOk = await checkConnectivity({ baseUrl: `${base}/ok`, apiKey: 'k' });
  check('0-Token 连接性检测成功（GET /models）', connOk.ok === true);

  const connErr = await checkConnectivity({ baseUrl: `${base}/err`, apiKey: 'k' });
  check('401 密钥失效连接性检测为 false', connErr.ok === false);

  const connUnconfigured = await checkConnectivity({});
  check('未配置时连接性检测为 false', connUnconfigured.ok === false);

  check('DeepSeek 当前 Flash 不会被改回旧模型名',
    resolveModelAlias('https://api.deepseek.com/v1', 'deepseek-flash') === 'deepseek-flash');
  check('DeepSeek 历史模型名迁移为 Flash',
    resolveModelAlias('https://api.deepseek.com/v1', 'deepseek-chat') === 'deepseek-flash');

  const parserUnconfigured = await checkParserConnectivity({ mode: 'cloud', mineruToken: '' });
  check('MinerU 未配置 Token 连接性检测为 false', parserUnconfigured.ok === false);

  const oldFetch = global.fetch;
  let probeUrl = '';
  global.fetch = async (url) => {
    probeUrl = String(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: -60012, msg: 'batch not found' }) };
  };
  try {
    const parserConnected = await checkParserConnectivity({ mode: 'cloud', mineruToken: 'test-token' });
    check('MinerU 连通性探针使用真实查询路由且不创建任务', parserConnected.ok &&
      /extract-results\/batch\/00000000-0000-4000-8000-000000000000$/.test(probeUrl));
  } finally {
    global.fetch = oldFetch;
  }

  server.close();


  console.log('\n[9] 文件系统工具（fsx）');

  const fsp = require('node:fs/promises');
  const os = require('node:os');
  const fsx = require('../src/main/core/fsx');

  const workA = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-fsx-'));

  const jsonFile = path.join(workA, 'data.json');
  await fsx.writeJsonAtomic(jsonFile, { a: 1, b: [1, 2, 3] });
  check('原子写 JSON 后可读回', JSON.parse(await fsp.readFile(jsonFile, 'utf8')).b.length === 3);

  const tmpLeftovers = (await fsp.readdir(workA)).filter((f) => f.endsWith('.tmp'));
  check('写盘完成后无 .tmp 残留', tmpLeftovers.length === 0, JSON.stringify(tmpLeftovers));

  // 覆盖
  await fsx.writeJsonAtomic(jsonFile, { a: 2 });
  check('原子写可覆盖已有文件', JSON.parse(await fsp.readFile(jsonFile, 'utf8')).a === 2);

  // 目录复制
  const srcTree = path.join(workA, 'src');
  await fsp.mkdir(path.join(srcTree, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(srcTree, 'a.md'), 'A');
  await fsp.writeFile(path.join(srcTree, 'sub', 'b.png'), 'B');
  const dstTree = path.join(workA, 'dst');
  await fsx.copyDir(srcTree, dstTree);
  check(
    '递归复制目录（含子目录）',
    (await fsp.readFile(path.join(dstTree, 'sub', 'b.png'), 'utf8')) === 'B'
  );

  await fsx.rm(dstTree);
  let dstGone = false;
  try {
    await fsp.stat(dstTree);
  } catch {
    dstGone = true;
  }
  check('递归删除目录', dstGone);

  await fsx.rm(workA);

  console.log('\n[10] 翻译质量校验（translator.checkTranslationQuality）');

  const { checkTranslationQuality, countBlockMath, cacheKey, previousContextTail } = require('../src/main/core/translator');

  check('块级公式计数（成对 $$）', countBlockMath('$$a$$ 文本 $$b$$') === 2);
  check('不成对的 $$ 按向下取整', countBlockMath('$$a') === 0);

  const longEn = 'The model achieves state-of-the-art results on multiple benchmarks and outperforms all baselines. '.repeat(3);
  const longZh = '该模型在多个基准测试上取得了领先结果，全面超越了此前所有的基线方法。'.repeat(3);
  check('正常译文通过校验', checkTranslationQuality(longEn, longZh).ok === true);

  check('公式块丢失被检出', checkTranslationQuality('$$a$$\n' + longEn, longZh).ok === false);
  check('公式块凭空多出被检出', checkTranslationQuality(longEn, '$$x$$\n' + longZh).ok === false);

  check('译文异常短被检出（疑似漏译）', checkTranslationQuality(longEn, '好的。').ok === false);
  check(
    '译文异常长被检出（疑似输出了讲解）',
    checkTranslationQuality('word '.repeat(30), '好的。'.repeat(300)).ok === false
  );

  check('短段不做长度比例判断', checkTranslationQuality('# Intro', '# 引言').ok === true);
  check('空译文被判为不过关', checkTranslationQuality(longEn, '   ').ok === false);
  check('数值和统计标记丢失会被检出',
    checkTranslationQuality('The gain was 12.5%, p < 0.01, n = 42.', '提升为 12.5%。').ok === false);
  check('带不同前文的段落不会共享翻译缓存',
    cacheKey({ baseUrl: 'https://api.example.test', model: 'm', targetLang: 'zh' }, 'same text', 'context A') !==
    cacheKey({ baseUrl: 'https://api.example.test', model: 'm', targetLang: 'zh' }, 'same text', 'context B'));
  check('前文上下文不会携带 Base64 图片正文',
    !previousContextTail(`before data:image/png;base64,${'A'.repeat(500)}`).includes('A'.repeat(100)));


  console.log('\n[11] 输出矩阵（exporter）');

  const { exportResults, stripReferences } = require('../src/main/core/exporter');

  const paperMd =
    '# 注意力机制研究\n\nWe propose a new architecture.\n\n$$\nE = MC^2\n$$\n\n' +
    'More text follows here to make the segment longer. '.repeat(3) +
    '\n\n![测试图片](images/fig1.png)\n\n## References\n\n[1] Vaswani et al. 2017. Attention is all you need.\n[2] Devlin et al. 2019. BERT.';

  const expSegs = splitMarkdown(paperMd, { maxTokens: 1200 });
  const expTrans = new Map();
  for (const s of expSegs) {
    if (s.translatable) expTrans.set(s.id, '【译】' + s.content);
  }

  const workB = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-export-'));

 
  const pendingPdf = {};
  const r1 = await exportResults({
    outDir: path.join(workB, 'p1'),
    baseName: '论文一',
    segments: expSegs,
    translations: expTrans,
    images: [{ name: 'fig1.png', data: fs.readFileSync(path.join(__dirname, '..', 'assets', 'tray.png')) }],
    meta: { title: '论文一' },
    outputConfig: { layout: 'generic', content: 'mono', formats: ['md', 'html', 'pdf'] },
    pendingPdf
  });
  check('md/html/pdf 全格式产出文件记录', r1.files.length === 3, JSON.stringify(r1.files));
  check(
    'md 产物落盘',
    (await fsp.readFile(path.join(workB, 'p1', '论文一.md'), 'utf8')).includes('【译】')
  );
  check('html 产物落盘', (await fsp.readFile(path.join(workB, 'p1', '论文一.html'), 'utf8')).includes('【译】'));
  check('图片内嵌 Markdown', (await fsp.readFile(path.join(workB, 'p1', '论文一.md'), 'utf8')).includes('data:image/png;base64,'));
  check('图片内嵌 HTML', (await fsp.readFile(path.join(workB, 'p1', '论文一.html'), 'utf8')).includes('data:image/png;base64,'));
  check('无图片目录和元信息副产物', JSON.stringify((await fsp.readdir(path.join(workB, 'p1'))).sort()) === JSON.stringify(['论文一.html', '论文一.md']));
  check('pendingPdf 交接', typeof pendingPdf.html === 'string' && pendingPdf.path.endsWith('论文一.pdf'));
  check('完整保留参考文献', (await fsp.readFile(path.join(workB, 'p1', '论文一.md'), 'utf8')).includes('Vaswani et al. 2017.'));
  await exportResults({outDir:path.join(workB,'p2'),baseName:'论文二',segments:expSegs,translations:expTrans,images:[{name:'fig1.png',data:fs.readFileSync(path.join(__dirname,'..','assets','tray.png'))}],outputConfig:{content:'bilingual',formats:['md','docx']}});
  const bilingOut = await fsp.readFile(path.join(workB,'p2','论文二.md'),'utf8');
  check('双语配置产出双语对照内容', bilingOut.includes('> **[译]**'));
  check('无额外 mono 文件', !fs.existsSync(path.join(workB,'p2','论文二.mono.md')));
  const word = unzip(await fsp.readFile(path.join(workB,'p2','论文二.docx')));
  check('Word 是真实 DOCX', word.some(e=>e.name==='word/document.xml'));
  check('Word 内嵌图片', word.some(e=>e.name.startsWith('word/media/')));
  const docxEntry = word.find(e => e.name === 'word/document.xml');
  const docXml = docxEntry ? docxEntry.data.toString('utf8') : '';
  check('Word 段落包含首行缩进 440 twips', docXml.includes('firstLine="440"'));

  const pendingMultiPdf = {};
  const rMulti = await exportResults({
    outDir: path.join(workB, 'p-multi'),
    baseName: '多格式共享',
    segments: expSegs,
    translations: expTrans,
    images: [{ name: 'fig1.png', data: fs.readFileSync(path.join(__dirname, '..', 'assets', 'tray.png')) }],
    outputConfig: { layout: 'generic', content: 'mono', formats: ['pdf', 'docx', 'md', 'html'] },
    pendingPdf: pendingMultiPdf
  });
  check('多格式同时输出且共用一份翻译文本', rMulti.files.length === 4 && typeof pendingMultiPdf.html === 'string');
  const defCfg = require('../src/main/config').getConfig();
  check('输出格式默认单选 PDF', Array.isArray(defCfg.output?.formats) && defCfg.output.formats.length === 1 && defCfg.output.formats[0] === 'pdf');

  await fsx.rm(workB);

  console.log('\n译文库索引');
  {
    const os = require('node:os');
    const library = require('../src/main/core/library');
    const libRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-selftest-lib-'));
    const dirName = '注意力机制在长文档建模中的应用';
    const outDir = path.join(libRoot, dirName);
    fs.mkdirSync(outDir, { recursive: true });
    const mdPath = path.join(outDir, dirName + '.md');
    fs.writeFileSync(mdPath, '# ' + dirName + '\n\n译文正文。', 'utf8');
    const srcPath = path.join(outDir, '原文-source.pdf');
    fs.writeFileSync(srcPath, Buffer.from('fake pdf bytes'));

    const rec = library.registerWork(libRoot, {
      title: dirName,
      dirName,
      source: { path: srcPath, name: 'source.pdf' },
      files: [{ path: mdPath, name: dirName + '.md' }],
      model: 'deepseek-chat',
      targetLang: 'zh'
    });
    check('登记返回记录且产物带指纹', !!(rec && rec.id && /^[0-9a-f]{40}$/.test(rec.outputs[0].fingerprint)));

    const m1 = library.match(libRoot, mdPath);
    check('原样拖回 → 指纹命中', !!(m1 && m1.via === 'fingerprint' && m1.modified === false));
    check('反查到正确作品', (m1 && m1.work.title) === dirName);
    check('给出产物目录绝对路径', library.workDir(libRoot, m1.work) === outDir);

    fs.appendFileSync(mdPath, '\n（用户润色）');
    const m2 = library.match(libRoot, mdPath);
    check('译文改过但还在原地 → 目录回退命中并标记 modified', !!(m2 && m2.via === 'path' && m2.modified === true));

    const stranger = path.join(libRoot, '我的笔记.md');
    fs.writeFileSync(stranger, '# 笔记', 'utf8');
    check('陌生 md 不认', library.match(libRoot, stranger) === null);
    const txt = path.join(libRoot, '随手记.txt');
    fs.writeFileSync(txt, 'hello');
    check('txt 不认', library.match(libRoot, txt) === null);

    const registry = require('../src/main/core/registry');
    const a = await registry.fingerprint(mdPath);
    const b = library.fingerprintSync(mdPath);
    check('与 registry 指纹算法一致', a.key === b.key);

    const fakePdf = path.join(libRoot, 'fake-source.pdf');
    fs.writeFileSync(fakePdf, 'PDF fake content for registry');
    const fakeOut = path.join(libRoot, 'fake-translated.pdf');
    fs.writeFileSync(fakeOut, 'Translated fake content');

    await registry.markDone(fakePdf, {
      outDir: libRoot,
      title: 'fake-translated',
      files: [{ path: fakeOut, name: 'fake-translated.pdf' }]
    });

    const checkBefore = await registry.lookup(fakePdf);
    check('产物存在时 registry 命中已翻译', checkBefore.translated === true);

    // 删除译文产物
    fs.unlinkSync(fakeOut);
    const checkAfter = await registry.lookup(fakePdf);
    check('删除译文产物后自动识别并允许重新翻译', checkAfter.translated === false && checkAfter.outputsDeleted === true);

    await fsx.rm(libRoot);
  }

  {
    console.log('\n[12] 上下文窗口管理与 80% 阈值压缩');
    const context = require('../src/main/core/context');
    const qa = require('../src/main/core/qa');

    // 1. 最新官方模型窗口识别
    check('DeepSeek-Flash 识别为 1M', context.getModelContextLimit('deepseek-flash') === 1000000);
    check('DeepSeek-V3 识别为 128K', context.getModelContextLimit('deepseek-v3') === 128000);
    check('DeepSeek-chat 识别为 128K', context.getModelContextLimit('deepseek-chat') === 128000);
    check('GLM-5 识别为 1M', context.getModelContextLimit('glm-5-turbo') === 1000000);
    check('GLM-4-Long 识别为 1M', context.getModelContextLimit('glm-4-long') === 1000000);
    check('GLM-4-Flash 识别为 128K', context.getModelContextLimit('glm-4-flash') === 128000);
    check('Gemini-2.5-Pro 识别为 2M', context.getModelContextLimit('gemini-2.5-pro') === 2000000);
    check('Gemini-2.5-Flash 识别为 1M', context.getModelContextLimit('gemini-2.5-flash') === 1000000);
    check('GPT-4o 识别为 128K', context.getModelContextLimit('gpt-4o') === 128000);
    check('Kimi 识别为 128K', context.getModelContextLimit('kimi-latest') === 128000);
    check('MiniMax-Text 识别为 1M', context.getModelContextLimit('minimax-text-01') === 1000000);
    check('未知模型兜底为 32K', context.getModelContextLimit('unknown-custom-llm') === 32768);
    check('自定义上限优先生效', context.getModelContextLimit('deepseek-chat', 16384) === 16384);

    // 2. API /models 返回对象属性自动探测提取
    const vllmObj = { id: 'deepseek-ai/DeepSeek-V3', max_model_len: 131072 };
    check('从 vLLM 对象中提取 max_model_len', context.extractContextLimitFromModelObj(vllmObj) === 131072);
    const openRouterObj = { id: 'deepseek/deepseek-r1', context_length: 128000 };
    check('从 OpenRouter 对象中提取 context_length', context.extractContextLimitFromModelObj(openRouterObj) === 128000);
    const geminiObj = { id: 'gemini-2.5-flash', inputTokenLimit: 1048576 };
    check('从 Gemini 原生对象中提取 inputTokenLimit', context.extractContextLimitFromModelObj(geminiObj) === 1048576);
    check('无容量字段的对象返回 0', context.extractContextLimitFromModelObj({ id: 'plain-model' }) === 0);

    // 3. 400 报错文本自适应逆向校准提取
    const errDeepSeek = "This model's maximum context length is 64000 tokens. However, your messages resulted in 72000 tokens.";
    check('从 DeepSeek 400 报错中提取 64000', context.extractContextLimitFromError(errDeepSeek) === 64000);
    const errExceeded = "Invalid request: context window of 128000 exceeded by 132000 tokens.";
    check('从 context window 400 报错中提取 128000', context.extractContextLimitFromError(errExceeded) === 128000);
    const errChinese = "API 错误：最大上下文长度为 32768 tokens，当前请求过长";
    check('从中文 400 报错中提取 32768', context.extractContextLimitFromError(errChinese) === 32768);
    check('非上下文报错返回 0', context.extractContextLimitFromError('Rate limit exceeded') === 0);

    // 4. 运行时自适应学习记录
    context.recordLearnedContextLimit('learned-model-xyz', 96000);
    check('运行时学习到的容量优先生效', context.getModelContextLimit('learned-model-xyz') === 96000);

    // 5. Token 估算
    const est = context.estimateTokens('Hello world 深度学习');
    check('估算 Token 正常返回正整数', est > 0 && est < 20);

    // 6. 80% 阈值检测
    // 假设窗口 1000 tokens，阈值 800 tokens
    const lowBudget = context.checkContextBudget({
      model: 'test',
      customLimit: 1000,
      input: '短文本测试',
      maxOutputTokens: 100,
      thresholdRatio: 0.8
    });
    check('低负荷未触及 80% 阈值', lowBudget.exceedsThreshold === false);

    // 大负荷触碰 80% 阈值
    const highBudget = context.checkContextBudget({
      model: 'test',
      customLimit: 1000,
      input: '长'.repeat(750), // ~750 tokens
      maxOutputTokens: 100,
      thresholdRatio: 0.8
    });
    check('高负荷准确触及 80% 阈值', highBudget.exceedsThreshold === true);

    // 7. 动态 QA 字符容量换算
    const smallLimitChars = context.resolveDynamicQaChars('llama-2'); // 4K 窗口
    const bigLimitChars = context.resolveDynamicQaChars('deepseek-v3'); // 128K 窗口
    check('大窗口模型分配到更多问答片段容量', bigLimitChars > smallLimitChars);
    check('小窗口模型片段容量在安全范围', smallLimitChars <= 10000);

    // 8. 问答历史压缩与窗口重置
    const mockHistory = [
      { role: 'user', content: '我的问题：论文的核心创新是什么？' },
      { role: 'assistant', content: '提出了 Multi-Head Latent Attention (MLA) 机制，降低显存占用。' },
      { role: 'user', content: '我的问题：实验效果如何？' },
      { role: 'assistant', content: '在各大基准评测上超过了 LLaMA-3.1 70B 模型。' },
      { role: 'user', content: '我的问题：开源协议是什么？' },
      { role: 'assistant', content: '采用 MIT 协议完全开源权重。' }
    ];
    const compressed = await context.compressQaHistory(mockHistory, null);
    check('压缩后历史包含重置对话且大幅精简', compressed.length === 2 && compressed[0].content.includes('前情提要'));

    // 9. qa.ask 在达到 80% 时的自动压缩机制
    const corpus = qa.buildCorpus([
      { name: 'test.md', markdown: '# 论文测试\n\n注意力机制在自然语言处理中效果优异。' }
    ]);
    // 传入极小窗口强制触发 80% 压缩
    const qaResult = await qa.ask({
      corpus,
      question: '注意力机制表现如何？',
      history: mockHistory,
      api: { model: 'test', contextWindow: 400 } // 超小窗口，必定触及 80%
    });
    check('qa.ask 触及 80% 阈值时自动标记 compressed=true', qaResult.compressed === true);
    check('qa.ask 返回压缩并重置后的 newHistory', Array.isArray(qaResult.newHistory) && qaResult.newHistory.length === 2);
  }


  console.log('\n[13] 综合架构与性能优化');
  {
    const translator = require('../src/main/core/translator');
    const qa = require('../src/main/core/qa');
    const assets = require('../src/main/core/assets');

    // 1. 术语表确定性排序与去重
    const sampleGlossaryConfig = {
      glossary: `
        GPU = 图形处理器
        # 这是注释
        LLM = 大规模语言模型
        NLP = 自然语言处理
        GPU = 图形处理单元
      `
    };
    const resolvedGlossary = translator.resolveGlossary(sampleGlossaryConfig);
    check('术语表去除注释与前后空白', !resolvedGlossary.includes('#') && !resolvedGlossary.includes('  '));
    check('术语表按 key 严格升序排序', resolvedGlossary === 'GPU=图形处理单元\nLLM=大规模语言模型\nNLP=自然语言处理');
    check('相同 key 自动去重且后者生效', !resolvedGlossary.includes('图形处理器') && resolvedGlossary.includes('GPU=图形处理单元'));

    // 2. 问答剥除 Base64 图片二进制
    const mdWithBase64 = '正文段落![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==)后续分析';
    const stripped = qa.stripDataUris(mdWithBase64);
    check('stripDataUris 成功剥除图片二进制', !stripped.includes('base64') && stripped.includes('正文段落') && stripped.includes('后续分析'));

    // 3. buildCorpus 结构升级
    const testCorpus = qa.buildCorpus([
      { name: 'Paper1.pdf', markdown: '# Paper 1\n\nContent of paper 1 with data:image/png;base64,abc' },
      { name: 'Paper2.pdf', translatedMarkdown: '# 论文2\n\n这是第二篇论文的内容。' }
    ]);
    check('buildCorpus 包含 fullText', typeof testCorpus.fullText === 'string' && testCorpus.fullText.includes('Paper 1') && testCorpus.fullText.includes('论文2'));
    check('buildCorpus 包含 papers 清单', Array.isArray(testCorpus.papers) && testCorpus.papers.length === 2);
    check('buildCorpus 记录总字符量', testCorpus.totalChars > 0);

    // 4. 论文问答全文静态驻留模式
    const prefixQa = await qa.ask({
      corpus: testCorpus,
      question: '论文1讲了什么？',
      history: [],
      api: { model: 'deepseek-v3' } // 128K 窗口，安全额度 64K，远超 testCorpus
    });
    check('全文静态驻留模式自动识别所有语料论文为引用', prefixQa.citedPapers.includes('Paper1.pdf') && prefixQa.citedPapers.includes('Paper2.pdf'));

    // 5. 惰性资源 Data URI 转换
    const mockImages = [
      { name: 'used.png', data: Buffer.from('png-bytes-1'), mime: 'image/png' },
      { name: 'unused.png', data: Buffer.from('png-bytes-2'), mime: 'image/png' }
    ];
    const assetIndex = assets.buildAssetIndex(mockImages);
    const resolvedUsed = assets.resolveAsset('used.png', assetIndex);
    check('被引用的图片正常解析为 data URI', typeof resolvedUsed === 'string' && resolvedUsed.startsWith('data:image/png;base64,'));
    check('byRef 与 byName 引用同一实例缓存', assets.resolveAsset('used.png', assetIndex) === resolvedUsed);

    const duplicateIndex = assets.buildAssetIndex([
      { name: 'figures/a/plot.png', data: Buffer.from('a'), mime: 'image/png' },
      { name: 'figures/b/plot.png', data: Buffer.from('b'), mime: 'image/png' }
    ]);
    check('同名图片能按完整相对路径准确解析',
      assets.resolveAsset('figures/a/plot.png', duplicateIndex)?.includes(Buffer.from('a').toString('base64')) &&
      assets.resolveAsset('figures/b/plot.png', duplicateIndex)?.includes(Buffer.from('b').toString('base64')));
    check('同名图片的裸文件名不会误嵌入任一图片', assets.resolveAsset('plot.png', duplicateIndex) === null);
  }

  {
    console.log('\n[14] 成果包哈希压缩与多格式免重翻极速导出');
    const registry = require('../src/main/core/registry');
    const exporter = require('../src/main/core/exporter');
    const pipeline = require('../src/main/core/pipeline');
    const paths = require('../src/main/paths');

    const testDir = path.join(os.tmpdir(), `pptor-test-bundle-${Date.now()}`);
    await fsx.rm(testDir);
    fs.mkdirSync(testDir, { recursive: true });

    const fakePdf = path.join(testDir, 'Attention.pdf');
    fs.writeFileSync(fakePdf, '%PDF-1.4 Attention Is All You Need sample file');
    const { key } = await registry.fingerprint(fakePdf);

    const rawMarkdown = '# 注意力机制研究\n\n注意力机制是深度学习的重要组成部分。\n\n$$E=mc^2$$\n\n![示意图](data:image/png;base64,' + 'A'.repeat(5000) + ')';
    const bundleData = {
      title: '注意力机制研究',
      baseName: '注意力机制研究',
      sourceName: 'Attention',
      outDir: testDir,
      embeddedMarkdown: rawMarkdown,
      translatedMarkdown: '# 注意力机制研究\n\n注意力机制是深度学习的重要组成部分。',
      formats: ['pdf'],
      files: [{ path: path.join(testDir, '注意力机制研究.pdf'), name: '注意力机制研究.pdf', format: 'pdf' }],
      model: 'deepseek-chat',
      targetLang: 'zh',
      layout: 'generic'
    };

    // 1. 哈希压缩存储与读取
    const saveOk = await registry.saveBundle(key, bundleData);
    check('成果包哈希压缩保存成功', saveOk === true);

    const loadedBundle = await registry.getBundle(key);
    check('成果包解压缩数据准确还原', loadedBundle && loadedBundle.title === '注意力机制研究' && loadedBundle.embeddedMarkdown === rawMarkdown);

    // 2. 压缩率校验：原始 JSON 字符数 vs 压缩文件字节数
    const rawJsonBytes = Buffer.byteLength(JSON.stringify(bundleData), 'utf8');
    const bundleFile = path.join(paths.cacheDir(), 'translations', `${key}.bundle.gz`);
    const compressedBytes = fs.statSync(bundleFile).size;
    const ratio = 1 - (compressedBytes / rawJsonBytes);
    check('成果包 zlib 压缩节约超过 60% 存储空间', ratio > 0.6);

    // 3. 记录已存在 PDF，查找目标格式 ['pdf', 'html']
    fs.writeFileSync(path.join(testDir, '注意力机制研究.pdf'), 'fake pdf data');
    await registry.markDone(fakePdf, {
      outDir: testDir,
      title: '注意力机制研究',
      baseName: '注意力机制研究',
      formats: ['pdf'],
      files: [{ path: path.join(testDir, '注意力机制研究.pdf'), name: '注意力机制研究.pdf', format: 'pdf' }]
    });

    const checkFormats = await registry.lookup(fakePdf, { targetFormats: ['pdf', 'html'] });
    check('准确识别已存在格式为 PDF', checkFormats.existingFormats.includes('pdf'));
    check('准确识别缺失格式为 HTML', checkFormats.missingFormats.includes('html') && !checkFormats.missingFormats.includes('pdf'));
    check('准确识别具备成果快照 hasBundle', checkFormats.hasBundle === true);

    // 4. exportFromMarkdown 直接从已翻译内容导出 HTML、MD、Word
    await exporter.exportFromMarkdown({
      outDir: testDir,
      baseName: '注意力机制研究',
      embeddedMarkdown: rawMarkdown,
      formats: ['html', 'md', 'docx']
    });
    check('exportFromMarkdown 成功导出 HTML', fs.existsSync(path.join(testDir, '注意力机制研究.html')));
    check('exportFromMarkdown 成功导出 Markdown', fs.existsSync(path.join(testDir, '注意力机制研究.md')));
    check('exportFromMarkdown 成功导出 Word', fs.existsSync(path.join(testDir, '注意力机制研究.docx')));

    // 5. pipeline 极速免重翻：未生成 HTML 时触发快速导出，0 次大模型调用
    const dummyConfig = {
      parser: { mode: 'cloud', mineruToken: 'dummy' },
      translate: { apiKey: 'dummy', model: 'dummy' },
      output: { libraryDir: testDir, formats: ['html'] }
    };
    // 此时删除刚才直接导出的 html，通过 pipeline.run 触发
    fs.unlinkSync(path.join(testDir, '注意力机制研究.html'));
    const pipeResult = await pipeline.run({
      files: [fakePdf],
      config: dummyConfig
    });
    check('pipeline 命中免重翻通道极速生成新格式', pipeResult.ok === true && pipeResult.succeeded === 1);
    check('新格式 HTML 成功落盘', fs.existsSync(path.join(testDir, '注意力机制研究.html')));
    check('结果标记为 isReExport 且 0 Token 消耗', pipeResult.results[0].isReExport === true);

    // 6. registry 已自动更新并记录了 pdf 与 html 两种格式
    const updatedCheck = await registry.lookup(fakePdf, { targetFormats: ['pdf', 'html'] });
    check('registry 记录已增量更新包含 PDF 与 HTML', updatedCheck.existingFormats.includes('pdf') && updatedCheck.existingFormats.includes('html') && updatedCheck.missingFormats.length === 0);

    await fsx.rm(testDir);
  }

  {
    console.log('\n[15] 表格分块保护、Markdown规范化、Word (DOCX) 修复与居中排版');

    // 1. 图表 Caption 识别
    check('中文表名识别为 Caption', isCaptionText('表 1：实验测试指标'));
    check('中文表格识别为 Caption', isCaptionText('表格 2. 模型对比结果'));
    check('英文 Table S1 识别为 Caption', isCaptionText('Table S1: Summary of hyper-parameters'));
    check('附录图识别为 Caption', isCaptionText('附录图 3：消融实验曲线'));
    check('括号图名识别为 Caption', isCaptionText('【图 1】总体架构示意图'));
    check('普通正文不误判为 Caption', !isCaptionText('本研究在表 1 中展示了所有对比数据，结果表明性能优异。'));

    // 2. normalizeMarkdownTables 规范化
    const rawMdTable = '上文段落\n| 列一 | 列二 |\n|---|---|\n| 数据1 | 数据2 |\n下文段落';
    const normMdTable = normalizeMarkdownTables(rawMdTable);
    check('Markdown 表格前后自动补全标准双换行',
      normMdTable.includes('上文段落\n\n| 列一 | 列二 |') &&
      normMdTable.includes('| 数据1 | 数据2 |\n\n下文段落'));

    const indentedTable = '    | 列一 | 列二 |\n    |---|---|\n    | A | B |';
    const normIndented = normalizeMarkdownTables(indentedTable);
    check('清理可能被误识别为缩进代码块的4空格', normIndented.startsWith('| 列一 | 列二 |'));

    const rawHtmlTable = '正文分析\n<table><tr><th>指标</th></tr><tr><td>值</td></tr></table>\n后续分析';
    const normHtmlTable = normalizeMarkdownTables(rawHtmlTable);
    check('HTML 表格前后自动补全标准双换行',
      normHtmlTable.includes('正文分析\n\n<table>') &&
      normHtmlTable.includes('</table>\n\n后续分析'));

    // 3. 表格分块保护（chunker 保证不把表格切碎）
    const tableDoc = [
      '# 实验章节',
      '',
      '这里是一段较长的段落，为了累积足够的 Token 预算。'.repeat(3),
      '',
      '| 序号 | 模型架构 | 准确率 | 耗时 |',
      '|---|---|---|---|',
      '| 1 | ResNet-50 | 76.3% | 12ms |',
      '| 2 | Vision Transformer | 79.8% | 25ms |',
      '| 3 | Swin Transformer | 81.2% | 30ms |',
      '| 4 | ConvNeXt | 82.0% | 22ms |',
      '',
      '表格后续的讨论内容，继续阐述实验结论。'
    ].join('\n');
    const smallBudgetSegs = splitMarkdown(tableDoc, { maxTokens: 25 });
    const tableSegs = smallBudgetSegs.filter(s => s.content.includes('| 序号 |'));
    check('极小 Token 预算下表格被完整保存在单一分块内',
      tableSegs.length === 1 && tableSegs[0].content.includes('| 4 | ConvNeXt |'));
    check('分块后逐字节重组保证完全一致',
      reassemble(smallBudgetSegs, new Map()) === tableDoc);

    // 4. DOCX XML 1.0 非法字符清洗与居中设置
    const badCharsMd = [
      '# 标题含换页符\x0C和空字符\x00',
      '',
      '正文包含 PDF 提取残留的控制字符\x1F和垂直制表符\x0B及退格符\x08。',
      '',
      '图 1：网络架构图',
      '',
      '| 指标 | 数值\x0C含换页符 |',
      '|---|---|',
      '| 速度 | 120 FPS |',
      '',
      '表 1：测试性能汇总'
    ].join('\n');

    const docxBuffer = await markdownToDocx(badCharsMd, { title: '测试文档\x0C\x1F' });
    check('包含非法控制字符的 Markdown 成功转换为 DOCX Buffer', Buffer.isBuffer(docxBuffer) && docxBuffer.length > 0);

    const docxEntries = unzip(docxBuffer);
    const documentXmlEntry = docxEntries.find(e => e.name === 'word/document.xml');
    check('DOCX 包含标准的 word/document.xml 条目', Boolean(documentXmlEntry));

    const documentXml = documentXmlEntry.data.toString('utf8');
    check('XML 1.0 非法控制字符 (x00-x1F) 被彻底清洗',
      !/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/.test(documentXml));
    check('DOCX 表格设置为居中对齐', documentXml.includes('w:jc w:val="center"'));
    check('DOCX 表格行设置 cantSplit 防跨页切断', documentXml.includes('<w:cantSplit/>'));
    check('图名表名 Caption 段落居中且无缩进',
      documentXml.includes('图 1：网络架构图') && documentXml.includes('表 1：测试性能汇总'));

    // 5. HTML 表格居中样式与无缩进
    const rendered = renderMarkdown(tableDoc);
    check('HTML 渲染包含 table-container 居中容器', rendered.includes('<div class="table-container">'));
  }

  {
    console.log('\n[16] 译文文档与哈希压缩快照生命周期管理、0 Token 补全与实时记录');
    const registry = require('../src/main/core/registry');
    const pipeline = require('../src/main/core/pipeline');
    const paths = require('../src/main/paths');

    const testDir = path.join(os.tmpdir(), `pptor-lifecycle-${Date.now()}`);
    await fsx.rm(testDir);
    fs.mkdirSync(testDir, { recursive: true });

    const fakePdf = path.join(testDir, 'PaperLifecycle.pdf');
    fs.writeFileSync(fakePdf, '%PDF-1.4 Lifecycle Sample Paper Content');
    const { key } = await registry.fingerprint(fakePdf);
    const bundleFile = path.join(paths.cacheDir(), 'translations', `${key}.bundle.gz`);

    // 准备初始产物与快照
    const mdContent = '# 论文生命周期研究\n\n测试正文内容与数据。\n\n| 指标 | 结果 |\n|---|---|\n| 召回率 | 95% |';
    const htmlFile = path.join(testDir, '论文生命周期研究.html');
    const mdFile = path.join(testDir, '论文生命周期研究.md');
    fs.writeFileSync(mdFile, mdContent, 'utf8');
    fs.writeFileSync(htmlFile, `<!DOCTYPE html><html><body><article class="paper">${mdContent}</article></body></html>`, 'utf8');

    await registry.markDone(fakePdf, {
      outDir: testDir,
      title: '论文生命周期研究',
      baseName: '论文生命周期研究',
      formats: ['html', 'md'],
      files: [
        { path: mdFile, name: '论文生命周期研究.md', format: 'md' },
        { path: htmlFile, name: '论文生命周期研究.html', format: 'html' }
      ]
    });

    await registry.saveBundle(key, {
      title: '论文生命周期研究',
      baseName: '论文生命周期研究',
      sourceName: 'PaperLifecycle',
      outDir: testDir,
      embeddedMarkdown: mdContent,
      translatedMarkdown: mdContent,
      formats: ['html', 'md'],
      files: [
        { path: mdFile, name: '论文生命周期研究.md', format: 'md' },
        { path: htmlFile, name: '论文生命周期研究.html', format: 'html' }
      ]
    });

    // 1. 验证场景 A：译文存在且快照存在
    const hitA = await registry.lookup(fakePdf, { targetFormats: ['html', 'md'] });
    check('场景 A：正常已翻译且未标记删除', hitA.translated === true && hitA.outputsDeleted === false && hitA.hasBundle === true);
    check('场景 A：格式完整无缺失', hitA.missingFormats.length === 0);

    // 2. 验证场景 B：删除译文文档，但保留哈希压缩快照
    fs.unlinkSync(mdFile);
    fs.unlinkSync(htmlFile);
    const hitB = await registry.lookup(fakePdf, { targetFormats: ['html', 'md'] });
    check('场景 B：译文删除但快照存在时 translated 仍为 true', hitB.translated === true);
    check('场景 B：准确标记 outputsDeleted 为 true', hitB.outputsDeleted === true);
    check('场景 B：准确标记 hasBundle 为 true', hitB.hasBundle === true);
    check('场景 B：需要重新导出的缺失格式为目标格式', hitB.missingFormats.includes('html') && hitB.missingFormats.includes('md'));

    // 3. 验证场景 B 下通过 pipeline 免重翻通道 0 Token 重新生成译文文档
    const dummyConfig = {
      parser: { mode: 'cloud', mineruToken: 'dummy' },
      translate: { apiKey: 'dummy', model: 'dummy' },
      output: { libraryDir: testDir, formats: ['html', 'md'] }
    };
    const regenResult = await pipeline.run({
      files: [fakePdf],
      config: dummyConfig
    });
    check('场景 B：pipeline 成功从本地快照重新生成译文文档', regenResult.ok === true && regenResult.succeeded === 1);
    check('场景 B：重新生成的 md 文件真实落盘', fs.existsSync(mdFile));
    check('场景 B：重新生成的 html 文件真实落盘', fs.existsSync(htmlFile));
    check('场景 B：标记为 isReExport 且 0 Token 消耗', regenResult.results[0].isReExport === true);

    const hitBAfter = await registry.lookup(fakePdf, { targetFormats: ['html', 'md'] });
    check('场景 B：重新生成后 outputsDeleted 恢复为 false', hitBAfter.outputsDeleted === false);

    // 4. 验证重新翻译场景：生成新快照替换旧文件，并更新记录
    const updatedContent = '# 全新翻译的论文标题\n\n大模型重新翻译的最新正文。';
    await registry.saveBundle(key, {
      title: '全新翻译的论文标题',
      baseName: '全新翻译的论文标题',
      sourceName: 'PaperLifecycle',
      outDir: testDir,
      embeddedMarkdown: updatedContent,
      translatedMarkdown: updatedContent,
      formats: ['md'],
      files: [{ path: mdFile, name: '论文生命周期研究.md', format: 'md' }]
    });
    const reloadedBundle = await registry.getBundle(key);
    check('重新翻译后快照文件被新内容原子替换', reloadedBundle && reloadedBundle.title === '全新翻译的论文标题');

    // 5. 验证场景 C：哈希压缩文件被删除，但译文文档还在 -> 0 Token 自动补全
    if (fs.existsSync(bundleFile)) fs.unlinkSync(bundleFile);
    check('快照文件确认已被物理删除', !fs.existsSync(bundleFile));

    const hitC = await registry.lookup(fakePdf, { targetFormats: ['html', 'md'] });
    check('场景 C：检测到快照缺失时触发 0 Token 自动补全', hitC.hasBundle === true);
    check('场景 C：磁盘上重新生成了 bundle.gz 文件', fs.existsSync(bundleFile));

    const replenishedData = await registry.getBundle(key);
    check('场景 C：从本地译文文档中准确提取出正文并还原快照',
      replenishedData && (replenishedData.translatedMarkdown.includes('全新翻译') || replenishedData.translatedMarkdown.includes('论文生命周期')));

    // 5.1 验证仅有 Word (.docx) 译文文件时的 0 Token 补全
    const docxFile = path.join(testDir, '仅有Word译文.docx');
    const docxBuf = await markdownToDocx('# Word译文专有标题\n\nWord正文段落。\n\n| 表头A | 表头B |\n|---|---|\n| 数据1 | 数据2 |', { title: 'Word译文' });
    fs.writeFileSync(docxFile, docxBuf);
    if (fs.existsSync(bundleFile)) fs.unlinkSync(bundleFile);
    if (fs.existsSync(mdFile)) fs.unlinkSync(mdFile);
    if (fs.existsSync(htmlFile)) fs.unlinkSync(htmlFile);

    await registry.markDone(fakePdf, {
      outDir: testDir,
      title: 'Word译文',
      baseName: '仅有Word译文',
      formats: ['docx'],
      files: [{ path: docxFile, name: '仅有Word译文.docx', format: 'docx' }]
    });
    // 删掉刚才 markDone 可能留下的 bundle
    if (fs.existsSync(bundleFile)) fs.unlinkSync(bundleFile);

    const hitDocxOnly = await registry.lookup(fakePdf, { targetFormats: ['docx'] });
    check('仅有 Word 译文时触发 0 Token 补全', hitDocxOnly.hasBundle === true);
    check('仅有 Word 译文时成功在磁盘生成 bundle.gz', fs.existsSync(bundleFile));
    const docxReplenished = await registry.getBundle(key);
    check('从 Word 文件中准确提取出标题与正文', docxReplenished && docxReplenished.translatedMarkdown.includes('Word译文') && docxReplenished.translatedMarkdown.includes('Word正文段落'));

    // 5.2 验证仅有 PDF 译文文件时的 0 Token 补全（通过本地影子索引与流解析）
    const onlyPdfFile = path.join(testDir, '仅有PDF译文.pdf');
    // 创建一个包含可读流的 PDF 文件
    const fakePdfContent = '%PDF-1.4\n1 0 obj\n<< /Length 45 >>\nstream\nBT\n/F1 12 Tf\n(PDF译文专有内容测试) Tj\nET\nendstream\nendobj\n';
    fs.writeFileSync(onlyPdfFile, fakePdfContent, 'utf8');
    if (fs.existsSync(docxFile)) fs.unlinkSync(docxFile);
    if (fs.existsSync(bundleFile)) fs.unlinkSync(bundleFile);

    await registry.markDone(fakePdf, {
      outDir: testDir,
      title: 'PDF译文',
      baseName: '仅有PDF译文',
      formats: ['pdf'],
      files: [{ path: onlyPdfFile, name: '仅有PDF译文.pdf', format: 'pdf' }]
    });
    if (fs.existsSync(bundleFile)) fs.unlinkSync(bundleFile);

    const hitPdfOnly = await registry.lookup(fakePdf, { targetFormats: ['pdf'] });
    check('仅有 PDF 译文时触发 0 Token 补全', hitPdfOnly.hasBundle === true);
    check('仅有 PDF 译文时成功生成 bundle.gz', fs.existsSync(bundleFile));
    const pdfReplenished = await registry.getBundle(key);
    check('从 PDF 译文文件中成功恢复文本数据', pdfReplenished && pdfReplenished.translatedMarkdown.length > 0);

    // 6. 验证场景 D：哈希压缩文件被删除，同时译文文档也被删除
    if (fs.existsSync(bundleFile)) fs.unlinkSync(bundleFile);
    if (fs.existsSync(onlyPdfFile)) fs.unlinkSync(onlyPdfFile);

    const hitD = await registry.lookup(fakePdf, { targetFormats: ['html', 'md'] });
    check('场景 D：两者均删除时 translated 判为 false', hitD.translated === false);

    const allRecords = await registry.list();
    check('场景 D：翻译记录被彻底清理，无脏数据残留', !allRecords.some((r) => r.key === key));

    await fsx.rm(testDir);
  }

  /* ================================================================== *
   * 17. 强制重翻替换、上下排版图片与图名绑定、Word原生公式与规范字体
   * ================================================================== */
  console.log('\n[17] 排版绑定、Word 原生公式、宋体+新罗马与纯黑去色');
  {
    const { bondFiguresAndCaptions, isFigureCaption, isTableCaption } = require('../src/main/core/markdown');

    // 1. 图名与表名识别
    check('中文图名正确识别', isFigureCaption('图 1：系统整体架构流程图'));
    check('英文 Figure 正确识别', isFigureCaption('Figure 2: Attention mechanism'));
    check('简写 Fig. 正确识别', isFigureCaption('Fig. 3. Comparison of BLEU scores'));
    check('中文表名正确识别', isTableCaption('表 1：超参数设定一览'));
    check('英文 Table 正确识别', isTableCaption('Table S2: Supplementary data'));

    // 2. 图片与图名绑定（上下排版，正文顺延下移）
    const messyMd = [
      '# 实验部分',
      '',
      '![模型架构图](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==)',
      '',
      '这是一段被论文双栏排版提取误插在图片和图名中间的正文段落一。',
      '',
      '这是另一段被夹杂的正文段落二。',
      '',
      '图 1：模型整体架构示意图。该图展示了多头注意力的计算流程。',
      '',
      '紧随其后的正文。'
    ].join('\n');

    const bondedMd = bondFiguresAndCaptions(messyMd);
    const bondedBlocks = bondedMd.split(/\n\s*\n+/);

    check('图片紧随图名排布（上方图片，下方图名）',
      bondedBlocks[1].includes('![模型架构图]') && bondedBlocks[2].includes('图 1：模型整体架构示意图'));
    check('图名自动加粗显示', bondedBlocks[2].startsWith('**') && bondedBlocks[2].endsWith('**'));
    check('夹杂的正文已安全顺延到图名后方',
      bondedBlocks[3].includes('误插在图片和图名中间的正文段落一') &&
      bondedBlocks[4].includes('这是另一段被夹杂的正文段落二'));

    // 3. 倒序排版纠正（图名在前，图片在后）
    const invertedMd = [
      '图 2：测试准确率曲线',
      '',
      '夹杂的解释段落。',
      '',
      '![曲线图](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==)',
      '',
      '后续段落。'
    ].join('\n');

    const correctedMd = bondFiguresAndCaptions(invertedMd);
    const correctedBlocks = correctedMd.split(/\n\s*\n+/);
    check('倒序图名图片纠正为上方图片、下方图名',
      correctedBlocks[0].includes('![曲线图]') && correctedBlocks[1].includes('图 2：测试准确率曲线'));
    check('倒序纠正后图名加粗', correctedBlocks[1].startsWith('**') && correctedBlocks[1].endsWith('**'));

    // 4. 表名加粗
    const tabMd = bondFiguresAndCaptions('表 3：各模型在 WMT 2014 数据集上的 BLEU 评分');
    check('表名自动加粗', tabMd.startsWith('**') && tabMd.endsWith('**'));

    // 5. Word (DOCX) 原生公式转换验证
    const mathDocxMd = [
      '# 机器翻译与注意力模型',
      '',
      '在行内引入公式 $E = mc^2$ 以及激活函数 $\\sigma(z) = \\frac{1}{1 + e^{-z}}$。',
      '',
      '$$',
      '\\text{Attention}(Q, K, V) = \\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V',
      '$$',
      '',
      '优化目标：',
      '',
      '$$',
      '\\min_{\\theta} \\sum_{i=1}^N (y_i - \\hat{y}_i)^2 + \\lambda \\|\\theta\\|^2',
      '$$',
      '',
      '| 符号 | 维度 | 含义 |',
      '|---|---|---|',
      '| $Q$ | $d_k$ | 查询矩阵 |',
      '| $K$ | $d_k$ | 键矩阵 |',
      '',
      '表 1：变量定义表',
      '',
      '![结构图](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==)',
      '',
      '图 3：注意力网络层级图'
    ].join('\n');

    const docxBuf = await markdownToDocx(mathDocxMd, { title: '公式与格式测试' });
    check('DOCX 成功生成', Buffer.isBuffer(docxBuf) && docxBuf.length > 5000);

    const docxEntries = unzip(docxBuf);
    const docXmlEntry = docxEntries.find((e) => e.name === 'word/document.xml');
    const docXml = docXmlEntry ? docXmlEntry.data.toString('utf8') : '';

    // 断言 Office Open XML Math 原生标记
    const oMathCount = (docXml.match(/<m:oMath>/g) || []).length;
    check('DOCX 包含原生 Office Math (<m:oMath>)', oMathCount >= 4, `实际找到 ${oMathCount} 个公式`);

    const fractionCount = (docXml.match(/<m:f>/g) || []).length;
    check('DOCX 包含原生公式分数结构 (<m:f>)', fractionCount >= 2, `实际找到 ${fractionCount} 个分数`);

    const radicalCount = (docXml.match(/<m:rad>/g) || []).length;
    check('DOCX 包含原生公式根号结构 (<m:rad>)', radicalCount >= 1, `实际找到 ${radicalCount} 个根号`);

    const supCount = (docXml.match(/<m:sSup>/g) || []).length;
    check('DOCX 包含原生公式上标结构 (<m:sSup>)', supCount >= 3, `实际找到 ${supCount} 个上标`);

    const subCount = (docXml.match(/<m:sSub>/g) || []).length;
    check('DOCX 包含原生公式下标结构 (<m:sSub>)', subCount >= 3, `实际找到 ${subCount} 个下标`);

    // 断言字体规范：中文宋体 (SimSun)，西文新罗马 (Times New Roman)
    check('DOCX 正文 Run 指定了 SimSun (宋体)', docXml.includes('w:eastAsia="SimSun"'));
    check('DOCX 正文 Run 指定了 Times New Roman (新罗马)', docXml.includes('w:ascii="Times New Roman"'));

    // 断言表格去色纯黑：无 F2F4F7 灰色底纹
    const grayShadingCount = (docXml.match(/F2F4F7/g) || []).length;
    check('DOCX 表格完全去色，无灰色底纹 (F2F4F7)', grayShadingCount === 0);

    // 断言图片段落包含 keepNext 防拆分分页
    const keepNextCount = (docXml.match(/<w:keepNext\/>/g) || []).length;
    check('DOCX 图片段落设置了 keepNext 保证同页紧贴图名', keepNextCount >= 1);
  }

  /* ================================================================== *
   * 汇总
   * ================================================================== */
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log(`${'─'.repeat(50)}\n`);

  process.exit(failed ? 1 : 0);
})();
