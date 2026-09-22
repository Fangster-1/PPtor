'use strict';

/**
 * 论文问答引擎
 *
 * 基于已翻译论文内容，支持全文静态驻留模式与分段关键词检索回答问题。
 */
const { splitMarkdown } = require('./chunker');
const { chatCompletion } = require('./llm-client');
const {
  resolveDynamicQaChars,
  checkContextBudget,
  compressQaHistory,
  getModelContextLimit,
  estimateTokens
} = require('./context');

const QA_TOP_K = 6;
const DEFAULT_MAX_CONTEXT_CHARS = 14000; // 默认论文片段总量上限
const MAX_HISTORY = 6; // 保留最近几轮对话

const SYSTEM_PROMPT = `你是一个论文阅读助手。用户正在阅读已经翻译好的论文，会就论文内容向你提问。

严格遵守以下规则：
1. **只能依据提供的论文内容或片段回答**。论文里没有的信息，直接说「论文中没有提到这一点」，不得用你自己的知识补充。
2. 回答中使用论文里的原始数据、公式、结论时必须与原文完全一致：数值、单位、公式、变量名一律原样引用。
3. 涉及公式时用 LaTeX 输出（行内 $...$，独立 $$...$$），保持与论文一致。
4. 如果内容不足以完整回答，就回答你能确定的部分，并明确说明其余内容不在提供的论文材料中。
5. 用中文回答，简洁、直接、有条理；可以在回答末尾用一句话指出相关内容出现在论文的哪个章节（如果有标题信息）。
6. 不要编造论文不存在的实验、数据、结论或文献引用。`;

/* ================================================================== *
 * 语料（一次任务的论文集合）
 * ================================================================== */

function stripDataUris(text) {
  return String(text || '').replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '');
}

/**
 * @param {Array<{name:string, markdown:string, translatedMarkdown:string}>} papers
 */
function buildCorpus(papers) {
  const docs = [];
  const cleanTexts = [];
  const paperNames = [];

  for (const paper of (Array.isArray(papers) ? papers : [])) {
    // 优先译文；没译文（导入原文场景）就用原文
    const raw = paper.translatedMarkdown || paper.markdown || '';
    if (!raw.trim()) continue;
    const clean = stripDataUris(raw).trim();
    if (!clean) continue;

    cleanTexts.push(`## ${paper.name || '论文'}\n\n${clean}`);
    paperNames.push(paper.name || '论文');

    // 检索粒度：600 token 左右一段。检索语料同样 strip data URI，避免二进制进索引。
    const segments = splitMarkdown(clean, { maxTokens: 600 });
    for (const seg of segments) {
      if (!seg.content.trim()) continue;
      docs.push({
        paper: paper.name,
        content: seg.content,
        // 预先算好词频，提问时只做打分
        terms: tokenize(seg.content)
      });
    }
  }

  const fullText = cleanTexts.join('\n\n---\n\n');

  return {
    docs,
    fullText,
    papers: paperNames,
    totalChars: fullText.length
  };
}

/* ================================================================== *
 * 关键词检索
 * ================================================================== */

const STOPWORDS = new Set(
  '的 了 是 在 和 与 有 对 从 被 把 这 那 你 我 他 她 它 们 什么 怎么 为什么 哪 如何 是否 请 说说 讲讲 一下 上述 该 其 中 及 或 等 图 表 式 第 章 节 段'.split(
    /\s+/
  )
);

const EN_STOPWORDS = new Set(
  'a an the of in on at to for and or is are was were be been this that these those what how why which does do did can could should would about into from with as by it its'.split(
    /\s+/
  )
);

/** 中英混合分词：英文按词（含单字母变量）、中文 unigram+bigram */
function tokenize(text) {
  const freq = new Map();
  const bump = (t) => freq.set(t, (freq.get(t) || 0) + 1);

  // 英文/数字词（含单字母变量如 x、y，适配“图1/Fig.1”保留数字）
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9-]*|[0-9]+\.?[0-9]*/g) || []) {
    if (!EN_STOPWORDS.has(w)) bump(w);
  }
  // 图/表编号整体保留
  for (const w of text.toLowerCase().match(/(?:fig\.?|table|tab\.?|图|表)\s*s?-?\d+[a-z]?/g) || []) {
    bump(w.replace(/\s+/g, ''));
  }

  // 中文：unigram + bigram（单字变量与“图1”类查询更稳）
  const cjkRuns = text.match(/[\u4e00-\u9fff]{1,}/g) || [];
  for (const run of cjkRuns) {
    if (STOPWORDS.has(run)) continue;
    for (const ch of run) {
      if (!STOPWORDS.has(ch)) bump(ch);
    }
    if (run.length <= 2) {
      bump(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      const g = run.slice(i, i + 2);
      if (!STOPWORDS.has(g)) bump(g);
    }
  }

  return freq;
}

/** IDF + 长度归一：高频词降权，长片段惩罚，标题命中加权；单字 unigram 降权避免偶然命中 */
function score(queryTerms, doc, idf = null) {
  let s = 0;
  const lenNorm = 1 + Math.log(1 + String(doc.content || '').length / 600);
  for (const [term, qf] of queryTerms) {
    const df = doc.terms.get(term);
    if (!df) continue;
    const w = idf && idf.has(term) ? idf.get(term) : 1;
    const isSingleCjk = /^[\u4e00-\u9fff]$/.test(term);
    const uw = isSingleCjk ? 0.25 : 1;
    s += (Math.min(qf, 3) * Math.min(df, 4) * w * uw) / lenNorm;
    // 标题加权仅针对双字以上词：单字标题命中（如“力”）不加分，避免偶然命中
    if (term.length > 1 && /^#{1,4}\s/.test(doc.content) && doc.content.toLowerCase().includes(term)) s += 2 * w * uw;
  }
  return s;
}

function buildIdf(docs) {
  const df = new Map();
  for (const doc of docs) {
    for (const term of doc.terms.keys()) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }
  const N = Math.max(1, docs.length);
  const idf = new Map();
  for (const [term, count] of df) {
    idf.set(term, Math.log(1 + N / (1 + count)) + 1);
  }
  return idf;
}

function retrieve(corpus, question, topK = QA_TOP_K) {
  const qTerms = tokenize(question);
  if (!qTerms.size) return [];

  const idf = buildIdf(corpus.docs || []);
  // 阈值过滤单字偶然命中：unigram 权重低，单个常见字命中得分 <1 会被滤掉；
  // 真实相关片段多词命中，得分远高于阈值。
  const SCORE_THRESHOLD = 1.0;
  return (corpus.docs || [])
    .map((doc, idx) => ({ doc, idx, s: score(qTerms, doc, idf) }))
    .filter((x) => x.s > SCORE_THRESHOLD)
    .sort((a, b) => b.s - a.s)
    .slice(0, topK)
    .map((x) => ({ ...x.doc, rank: x.idx }));
}

/* ================================================================== *
 * 问答
 * ================================================================== */

/**
 * @param {object} p
 * @param {object} p.corpus       buildCorpus 的产物
 * @param {string} p.question
 * @param {Array<{role:string,content:string}>} p.history  已有对话（不含本轮）
 * @param {object} p.api          translate 同款 LLM 配置（baseUrl/apiKey/model）
 * @returns {Promise<{answer:string, citedPapers:string[]}>}
 */
async function ask({ corpus, question, history = [], api, signal }) {
  if (!corpus || !corpus.docs.length) {
    return { answer: '我这次还没有读过任何论文。先翻译一篇，或把译文拖给我，然后再来问我～', citedPapers: [] };
  }

  const contextLimit = getModelContextLimit(api?.model, api?.contextWindow);
  const corpusTokens = corpus.fullText ? estimateTokens(corpus.fullText) : 0;
  // 当论文总容量在模型安全上限的 50% 以内且不超过 45000 Token 时，启用「全文静态驻留模式」
  // 这使得 System Prompt + 论文前缀在多轮问答中绝对静态，100% 命中服务端 Prefix Cache
  const canUsePrefixMode =
    Boolean(corpus.fullText) &&
    corpusTokens > 0 &&
    corpusTokens <= Math.floor(contextLimit * 0.5) &&
    corpusTokens <= 45000;

  const cited = new Set();
  let anchorMessages = [];
  let buildUserContent;

  if (canUsePrefixMode) {
    for (const p of corpus.papers || []) cited.add(p);
    anchorMessages = [
      {
        role: 'user',
        content: `【论文参考全文】\n\n${corpus.fullText}\n\n请通读并理解上述论文全部内容，保持严谨客观的学术标准，准备就论文细节作答。`
      },
      {
        role: 'assistant',
        content: '已完整通读并掌握上述论文的全部内容（包含研究背景、方法、公式、图表数据与结论）。请随时提问，我将严格基于论文原文作答。'
      }
    ];
    buildUserContent = () => `我的问题：${question}`;
  } else {
    const hits = retrieve(corpus, question);
    const maxContextChars = resolveDynamicQaChars(api?.model, api?.contextWindow) || DEFAULT_MAX_CONTEXT_CHARS;
    let used = 0;
    const snippets = [];
    const citedFragments = [];
    for (const doc of hits) {
      if (used + doc.content.length > maxContextChars) break;
      const fragId = `片段${(doc.rank ?? 0) + 1}`;
      const titleLine = String(doc.content || '').split(/\r?\n/).find((l) => /^#{1,4}\s/.test(l.trim())) || '';
      snippets.push(`【${doc.paper} · ${fragId}${titleLine ? ` · ${titleLine.trim().slice(0, 40)}` : ''}】\n${doc.content}`);
      cited.add(doc.paper);
      citedFragments.push(`${doc.paper}#${fragId}`);
      used += doc.content.length;
    }
    if (!snippets.length) {
      return {
        answer: `我在这次读过的论文里没有找到与「${question.slice(0, 40)}」相关的内容。换个说法试试，或者问论文里确实出现的主题。`,
        citedPapers: []
      };
    }
    buildUserContent = () =>
      `<论文片段>\n${snippets.join('\n\n---\n\n')}\n</论文片段>\n\n` +
      `我的问题：${question}`;
  }

  let currentHistory = history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: m.content }));
  const assembleMessages = (hist) => [
    { role: 'system', content: SYSTEM_PROMPT },
    ...anchorMessages,
    ...hist,
    { role: 'user', content: buildUserContent() }
  ];

  let messages = assembleMessages(currentHistory);
  let compressed = false;
  let newHistory = currentHistory;

  // 检查上下文是否触及 80% 安全警戒线（预留 1500 输出 token）
  const budget = checkContextBudget({
    model: api?.model,
    customLimit: api?.contextWindow,
    input: messages,
    maxOutputTokens: 1500,
    thresholdRatio: 0.8
  });

  if (budget.exceedsThreshold && currentHistory.length > 0) {
    // 达到 80% 警戒线：自动提炼压缩历史对话并开启全新窗口
    newHistory = await compressQaHistory(currentHistory, api, signal);
    compressed = true;
    messages = assembleMessages(newHistory);
  }

  const baseUrl = String(api?.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !api?.apiKey) {
    return {
      answer: '未配置大模型 API 地址或 Key，无法回答。',
      citedPapers: [...cited],
      compressed,
      newHistory
    };
  }

  const reqBody = () => ({
    model: api.model,
    messages,
    temperature: 0.3, // 问答要稳，不要发散
    max_tokens: 1500,
    stream: false
  });

  let json;
  try {
    json = await chatCompletion({ api, body: reqBody(), timeoutMs: 180000, signal });
  } catch (err) {
    // 400 上下文超限且尚未压缩过历史：学习新上限后压缩重开窗口，重试一次
    if (err.isContextOverflow && !compressed && currentHistory.length > 0) {
      console.warn(`[qa] 从 400 响应解析到模型「${api?.model}」上下文限制：${err.learnedLimit} Tokens`);
      newHistory = await compressQaHistory(currentHistory, api, signal);
      compressed = true;
      messages = assembleMessages(newHistory);
      const retryJson = await chatCompletion({ api, body: reqBody(), timeoutMs: 180000, signal }).catch(() => null);
      const retryAns = retryJson?.choices?.[0]?.message?.content;
      if (typeof retryAns === 'string' && retryAns.trim()) {
        return {
          answer: retryAns.trim(),
          citedPapers: [...cited],
          compressed: true,
          newHistory,
          learnedLimit: err.learnedLimit
        };
      }
    }
    throw err;
  }

  const answer = json?.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('模型返回内容为空');

  return { answer: answer.trim(), citedPapers: [...cited], citedFragments: typeof citedFragments !== 'undefined' ? citedFragments : [], compressed, newHistory, learnedLimit: 0 };
}

module.exports = { buildCorpus, ask, retrieve, stripDataUris };
