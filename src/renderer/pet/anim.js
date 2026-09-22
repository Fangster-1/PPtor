'use strict';

/* 动画引擎：状态写入 #sprite 的 data-anim，全部表现由 style.css 驱动 */

/** 阶段 → 宠物动画。任务阶段统一从这里驱动，交互动画不能覆盖它。 */
const STAGE_ANIM = {
  parse: 'parsing',
  lang: 'parsing',
  chunk: 'parsing',
  translate: 'translating',
  export: 'exporting',
  print: 'exporting',
  archive: 'exporting',
  skip: 'waiting',
  'paper-error': 'failed'
};

/** 任务态动画名集合：这些状态的来源默认视为 task（工作反馈） */
const TASK_ANIMS = new Set([
  'parsing',
  'translating',
  'exporting',
  'waiting',
  'failed',
  'cancelled',
  'jumping'
]);

/**
 * 极简幽灵（SVG）动画：无精灵帧、无帧循环；一次性动画（跳跃/完成）600ms 后自动回待机。
 */
function setAnim(name, opts = {}) {
  // 任务状态是唯一可信的反馈源。配置表单、延迟回调或普通点击都不能
  // 在翻译进行中把它改成 idle/waving，从而避免“卡在导出”时界面失真。
  if (state.busy && state.animSource === 'task' && opts.source !== 'task') return false;
  if (state.anim === name && !opts.restart) return true;

  state.anim = name;
  state.animSource = opts.source || (TASK_ANIMS.has(name) ? 'task' : 'ambient');
  state.animToken += 1;
  $('sprite').dataset.anim = name;

  if (name === 'jumping' || name === 'complete') {
    const token = state.animToken;
    setTimeout(() => {
      if ((state.anim === 'jumping' || state.anim === 'complete') && state.animToken === token && !state.busy) {
        setAnim('idle', { source: 'ambient' });
      }
    }, 600);
  }
  return true;
}

function onVisibilityChange() {
  // CSS 动画由 .window-hidden 类暂停（见 style.css），无需手动帧循环
  document.documentElement.classList.toggle('window-hidden', document.visibilityState === 'hidden');
}

function restoreAmbientAnimation() {
  if (state.busy) return;
  setAnim('idle', { source: 'ambient' });
}

function playPetting() {
  $('pet').classList.add('pet-petted');
  setTimeout(() => $('pet').classList.remove('pet-petted'), 360);

  if (state.busy) return;
  setAnim('petting', { source: 'interaction', restart: true });
  const token = state.animToken;
  setTimeout(() => {
    if (!state.busy && state.animToken === token) restoreAmbientAnimation();
  }, 720);
}
