'use strict';

/**
 * 原生右键菜单（已废弃：现用渲染层 HTML menuPanel 常驻面板）。
 * 保留仅供 pet:contextMenu 兼容与自动化调用，新功能请改 menuPanel。
 * @deprecated
 */
const { Menu } = require('electron');

const { getConfig, saveConfig } = require('./config');

const FORMATS = [
  ['pdf', 'PDF'],
  ['docx', 'Word'],
  ['md', 'Markdown'],
  ['html', '网页 HTML']
];

const LAYOUTS = [
  ['faithful', '按原论文格式排版'],
  ['generic', '通用排版']
];

const CONTENTS = [
  ['bilingual', '双语对照'],
  ['mono', '只留译文']
];

const PARSER_MODES = [
  ['cloud', '云端 API'],
  ['local', '本地 MinerU']
];

const TWO_ARROWS = '🗘';
const SPIN_FRAMES = ['🗘', '⭮', '⮔', '⭯'];

function getModelMenuLabel(cfg, status, frame = 0) {
  if (!cfg.translate?.apiKey) {
    return '  当前模型：未配置';
  }
  const model = cfg.translate.model || '未命名';
  let dot = '🟢';
  if (status === 'error') dot = '🔴';
  else if (status === 'unconfigured') dot = '🟡';
  const icon = status === 'testing' ? SPIN_FRAMES[frame % SPIN_FRAMES.length] : TWO_ARROWS;
  return `  当前模型：${model}  ${dot}${icon}`;
}

function getParserMenuLabel(cfg, status, frame = 0) {
  const isLocal = cfg.parser?.mode === 'local';
  const modeName = isLocal ? '本地 MinerU' : '云端 API';
  if (!isLocal && !cfg.parser?.mineruToken) {
    return `  解析方式：${modeName}（未配置）`;
  }
  let dot = '🟢';
  if (status === 'error') dot = '🔴';
  else if (status === 'unconfigured') dot = '🟡';
  const icon = status === 'testing' ? SPIN_FRAMES[frame % SPIN_FRAMES.length] : TWO_ARROWS;
  return `  解析方式：${modeName}  ${dot}${icon}`;
}

function buildPetMenu(ctx) {
  const cfg = getConfig();
  const formats = new Set(cfg.output.formats || ['pdf']);
  const modelStatus = typeof ctx.getModelStatus === 'function' ? ctx.getModelStatus() : 'unconfigured';
  const parserStatus = typeof ctx.getParserStatus === 'function' ? ctx.getParserStatus() : 'unconfigured';
  const spinFrame = typeof ctx.getSpinFrame === 'function' ? ctx.getSpinFrame() : 0;

  const toggleFormat = (key) => (item) => {
    const next = new Set(getConfig().output.formats || ['pdf']);
    if (item.checked) next.add(key);
    else next.delete(key);
    if (!next.size) next.add('pdf'); // 至少保留一种
    saveConfig({ output: { formats: [...next] } });
    ctx.onAction('refresh');
  };

  return Menu.buildFromTemplate([
    { label: '翻译论文…', click: () => ctx.onAction('pickAndTranslate') },
    { type: 'separator' },

    { label: '就译文提问…', click: () => ctx.onAction('qa:open') },
    { type: 'separator' },

    /* ---------------- 配置 ---------------- */
    { label: '配置翻译模型…', click: () => ctx.onAction('wizard:translate') },
    {
      label: getModelMenuLabel(cfg, modelStatus, spinFrame),
      enabled: !!cfg.translate?.apiKey,
      click: () => ctx.onAction('testModelConnection')
    },
    {
      label: '配置 MinerU 解析…',
      click: () => ctx.onAction('wizard:parser')
    },
    {
      label: getParserMenuLabel(cfg, parserStatus, spinFrame),
      enabled: cfg.parser?.mode === 'local' || !!cfg.parser?.mineruToken,
      click: () => ctx.onAction('testParserConnection')
    },
    { type: 'separator' },

    /* ---------------- 输出 ---------------- */
    {
      label: '输出排版',
      submenu: LAYOUTS.map(([value, label]) => ({
        label,
        type: 'radio',
        checked: (cfg.output.layout || 'generic') === value,
        click: () => {
          saveConfig({ output: { layout: value } });
          ctx.onAction('refresh');
          ctx.onAction('toast', `排版已设为：${label}`);
        }
      }))
    },
    {
      label: '输出内容',
      submenu: CONTENTS.map(([value, label]) => ({
        label,
        type: 'radio',
        checked: (cfg.output.content || 'mono') === value,
        click: () => {
          saveConfig({ output: { content: value } });
          ctx.onAction('refresh');
          ctx.onAction('toast', `输出内容已设为：${label}`);
        }
      }))
    },
    {
      label: '输出格式（可多选）',
      submenu: FORMATS.map(([key, label]) => ({
        label,
        type: 'checkbox',
        checked: formats.has(key),
        click: toggleFormat(key)
      }))
    },
    {
      label: '翻译文档库',
      submenu: [
        {
          label: '打开文档库文件夹',
          click: () => ctx.onAction('open:libraryDir')
        },
        {
          label: '更改存储路径…',
          click: () => ctx.onAction('pick:libraryDir')
        }
      ]
    },
    { type: 'separator' },

    { label: '隐藏宠物', click: () => ctx.onAction('pet:hide') },
    { label: '使用说明', click: () => ctx.onAction('help') },
    { label: '退出', click: () => ctx.onQuit() }
  ]);
}

module.exports = { buildPetMenu, FORMATS, LAYOUTS, CONTENTS };
