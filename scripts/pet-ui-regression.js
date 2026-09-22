'use strict';

/**
 * 桌宠 UI 交互检查。
 */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`✓ ${label}`);
  } else {
    failed += 1;
    console.error(`✗ ${label}${detail ? `：${detail}` : ''}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 宠物窗已拆分为多个经典脚本，拼接后做全文检查（与旧单文件行为一致） */
const PET_FILES = [
  'src/renderer/pet/state.js',
  'src/renderer/pet/anim.js',
  'src/renderer/pet/bubble.js',
  'src/renderer/pet/drag.js',
  'src/renderer/pet/menu-panel.js',
  'src/renderer/pet/task.js',
  'src/renderer/pet/drop.js',
  'src/renderer/pet/wizards.js',
  'src/renderer/pet/main.js'
];
const app = PET_FILES.map((rel) => read(rel)).join('\n');
const css = read('src/renderer/style.css');
const html = read('src/renderer/index.html');
const config = read('src/main/config.js');
const main = read('src/main/main.js');
const tray = read('src/main/tray.js');
const petWindow = read('src/main/pet/window.js');
const drag = read('src/renderer/pet/drag.js');
const petWindowGeometry = require(path.join(ROOT, 'src/main/pet/window.js'));

console.log('[桌宠 UI] 右键连接状态');
const presetSource = app.slice(app.indexOf('const PRESETS = {'), app.indexOf('/** MinerU Token 申请页 */'));
check('硅基流动不再出现在内置模型预设', !presetSource.includes('siliconflow'));
check('默认配置不再保留硅基流动槽位', !config.includes("siliconflow: ''"));
check('首次配置 Key 会启动主进程连通性检测', app.includes('void api.checkModelConnectivity().catch(() => {})'));
check('菜单测试状态从主进程事件实时更新', app.includes("case 'connectivity:start'") && app.includes("case 'connectivity:done'"));
const showMenuSource = app.slice(app.indexOf('async function showMenuPanel()'), app.indexOf('function hideMenuPanel()'));
const menuCss = css.slice(css.indexOf('.menu-panel {'), css.indexOf('.menu-header {'));
check('打开菜单只读取状态而不发起模型或 MinerU 测试',
  !showMenuSource.includes('checkModelConnectivity') && !showMenuSource.includes('checkParserConnectivity') &&
  showMenuSource.includes('updateMenuConnectivityUI'));
check('连接快照不会覆盖较新的连接完成事件',
  app.includes('const revision = ++connectivityUiRevision;') &&
  app.includes('revision !== connectivityUiRevision'));
check('主进程连接请求带序号，旧结果不能覆盖新状态',
  app.includes('function acceptsConnectivityEvent') && app.includes('modelConnectivityRequestId') &&
  app.includes('parserConnectivityRequestId'));
check('菜单固定在宠物头顶并完整显示，不用滚动条裁切选项',
  menuCss.includes('top: auto;') && menuCss.includes('bottom: calc(var(--pad-b) + var(--pet-h) + 10px);') &&
  menuCss.includes('overflow: visible;') && !menuCss.includes('overflow-y: auto;') &&
  !css.includes('html.dlg-below') && !css.includes('html.menu-below') &&
  app.includes("classList.remove('dlg-below', 'menu-below', 'dlg-left', 'dlg-right')"));
check('隐藏后托盘点击会恢复窗口、取消穿透并回到右下角',
  tray.includes("tray.on('click', () => ctx.onShowPet())") &&
  main.includes('if (!win || win.isDestroyed())') && main.includes('if (win.isMinimized()) win.restore();') &&
  main.includes('petWin.setIgnoreMouse(false);') && main.includes('petWin.moveToBottomRight();'));
check('穿透期间主进程持续命中宠物，避免鼠标事件锁死',
  app.includes('function onPetPointer') && app.includes('api.onPetPointer?.(onPetPointer)') &&
  read('src/main/pet/window.js').includes('startCursorWatch') &&
  read('src/main/preload.js').includes("onPetPointer: (cb) => subscribe('pet:pointer', cb)"));
check('每次启动默认右下角，拖动不再被屏幕边缘钳制',
  petWindow.includes('function bottomRightPosition(size, displayWorkArea)') &&
  petWindow.includes('const pos = bottomRightPosition(size);') &&
  petWindow.includes('petWindow.setPosition(nx, ny);') &&
  !petWindow.includes('clampPetRect'));

console.log('\n[桌宠几何] 右下角锚定宠物本体');
for (const testCase of [
  { name: '正常工作区', area: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 1 },
  { name: '负坐标工作区', area: { x: -1920, y: -120, width: 1920, height: 1080 }, scale: 1 },
  { name: '仅略大于宠物的工作区', area: { x: 80, y: 40, width: 200, height: 220 }, scale: 1 },
  { name: '工作区矮于宿主窗口', area: { x: 120, y: -80, width: 900, height: 600 }, scale: 2 },
  { name: 'scale=2', area: { x: -2560, y: 0, width: 2560, height: 1440 }, scale: 2 }
]) {
  const size = petWindowGeometry.computeSize(testCase.scale);
  const pos = petWindowGeometry.bottomRightPosition(size, testCase.area);
  const pet = petWindowGeometry.petRectAt(pos.x, pos.y, size.width, size.height);
  const right = pet.x + pet.width;
  const bottom = pet.y + pet.height;
  const contained = pet.x >= testCase.area.x && pet.y >= testCase.area.y &&
    right <= testCase.area.x + testCase.area.width &&
    bottom <= testCase.area.y + testCase.area.height;
  check(`${testCase.name} 宠物本体完整位于工作区`, contained, { size, pos, pet, area: testCase.area });
  const expectedPetX = Math.max(testCase.area.x,
    testCase.area.x + testCase.area.width - 24 - pet.width);
  const expectedPetY = Math.max(testCase.area.y,
    testCase.area.y + testCase.area.height - 10 - pet.height);
  check(`${testCase.name} 右下角锚定数值正确`,
    pet.x === expectedPetX && pet.y === expectedPetY,
    { right, bottom, area: testCase.area });
  if (testCase.name === '工作区矮于宿主窗口') {
    check('工作区矮于宿主窗口时只让透明宿主越界',
      pos.y < testCase.area.y && pet.y >= testCase.area.y,
      { size, pos, pet, area: testCase.area });
  }
}

check('拖动使用 Pointer Capture 并统一处理结束事件',
  drag.includes('setPointerCapture') &&
  drag.includes('pointerId') &&
  drag.includes('function onPetPointerUp') &&
  drag.includes('function onPetPointerCancel') &&
  drag.includes('function onPetLostPointerCapture'));
const shownActionSource = app.slice(app.indexOf("case 'pet:shown'"), app.indexOf("case 'wizard:translate'"));
check('重新显示后主进程与渲染层会重新同步鼠标穿透状态',
  shownActionSource.includes('forceInteractive(true)') &&
  shownActionSource.includes('api.petPointer') &&
  shownActionSource.includes('onPetPointer'));
check('主进程 moveBy 直接按增量移动，不做边界钳制',
  petWindow.includes('const nx = Math.round(x + dx);') &&
  petWindow.includes('const ny = Math.round(y + dy);') &&
  petWindow.includes('petWindow.setPosition(nx, ny);') &&
  !/function moveBy[\s\S]*?(?:Math\.max|Math\.min|clamp|workArea)/.test(petWindow));
const onboardingSource = app.slice(app.indexOf('async function finishOnboarding()'), app.indexOf('async function pickFilesToTranslate()'));
check('首次配置完成只显示可关闭提示，保留拖入论文即翻译',
  onboardingSource.includes('配置完成，可以开始翻译') &&
  onboardingSource.includes('function dismissOnboardingNotice') &&
  onboardingSource.includes('handleFiles(pending)') &&
  !onboardingSource.includes('译文输出路径') &&
  !onboardingSource.includes('actions:'));
check('完成结果取代进度卡，避免完成后多窗口叠加和处理中残留',
  app.includes('finishTask();') && !app.includes('finishTask({ keepVisible: true })') &&
  app.includes('taskDialog: true') && !app.includes('hideProgress: false'));
check('任务进度与完成结果使用半宽卡片，并固定在宠物头上',
  css.includes('.bubble.task-dialog') && css.includes('width: 50%;') &&
  css.includes('.progress {') && app.includes('function updateDialogPlacement()') &&
  app.includes("classList.remove('dlg-below', 'menu-below', 'dlg-left', 'dlg-right')"));
check('菜单输出区在分隔线前显式闭合',
  /id="menuPickLib"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<div class="menu-divider">/.test(html));

console.log('[桌宠 UI] 语义状态与互斥动画');
for (const name of [
  'parsing',
  'translating',
  'exporting',
  'waiting',
  'jumping',
  'failed',
  'cancelled',
  'dragging',
  'petting'
]) {
  check(`${name} 状态入口存在`, app.includes(`'${name}'`) || app.includes(`"${name}"`));
}
check('任务动画有来源锁', app.includes("state.animSource === 'task'") && app.includes("opts.source !== 'task'"));
check('进度事件只在任务存活时生效', app.includes('if (!e || !state.busy) return;'));
check('异步 jumping 回调有 token 守卫', app.includes('state.animToken === token'));
check('隐藏窗口暂停 CSS 动画', app.includes("window-hidden") && css.includes('animation-play-state: paused'));
check('宠物动画由 data-anim 状态驱动（矢量幽灵）', app.includes("dataset.anim") && html.includes('id="petSvg"'));
check('环形进度 HUD 已移除（进度走进度条与状态动画）',
  !html.includes('id="petRing"') && !css.includes('#petRing') && html.includes('id="phaseBar"') && html.includes('id="barFill"'));

console.log('\n[桌宠 UI] 取消与交互反馈');
check('进度条有取消按钮', html.includes('id="cancelJob"'));
check('取消请求走 preload 接口', app.includes('api.cancelJob()'));
check('取消后显示独立状态', app.includes("title: '已取消'") && app.includes("setTaskAnimation('cancelled'"));
check('拖入忙状态不会覆盖任务动画', app.includes("if (!state.busy) setAnim('waving'") && app.includes("is-busy"));
check('抚摸有短暂反馈', app.includes('playPetting') && css.includes('.pet.pet-petted::after'));
check('译文拖回先索引识别', app.includes('LIBRARY_DROP_EXTS') && app.includes('api.matchLibrary(file)'));
check('未登记 PDF 仍保持批量翻译', app.includes('sourcePdfs.length') && app.includes('handleFiles(sourcePdfs)'));

console.log('\n[桌宠 UI] 回归探针');
for (const name of ['setAnim', 'onProgress', 'showStatus', 'finish', 'cancel']) {
  check(`window.__ptTest.${name}`, app.includes(`  ${name}:`) || app.includes(`  ${name},`) || app.includes(`${name}:`));
}

console.log('\n[桌宠资源] 精灵图与 QA 预览');
const petJson = JSON.parse(read('pets/paper-pet/pet.json'));
const spritePath = path.join(ROOT, 'pets', 'paper-pet', petJson.spritesheetPath);
const sprite = fs.readFileSync(spritePath);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
check('pet.json 完整', !!(petJson.id && petJson.displayName && petJson.spritesheetPath));
check('精灵图 PNG 合法', sprite.subarray(0, 8).equals(png));
check('精灵图规格 1536×1872', sprite.readUInt32BE(16) === 1536 && sprite.readUInt32BE(20) === 1872);
check('QA 状态预览存在', fs.existsSync(path.join(ROOT, 'pets', 'paper-pet', 'qa', 'states.png')));
const qaHtmlPath = path.join(ROOT, 'pets', 'paper-pet', 'qa', 'states.html');
check('QA 页面带中英文状态标签', fs.existsSync(qaHtmlPath) &&
  /解析阅读/.test(fs.readFileSync(qaHtmlPath, 'utf8')) && /Export/.test(fs.readFileSync(qaHtmlPath, 'utf8')));
check('取消与失败使用不同动画表现', app.includes("state.anim === 'jumping'") &&
  css.includes('[data-anim="failed"]') && css.includes('[data-anim="cancelled"]'));

console.log('\n[桌宠代码] JavaScript 语法');
for (const rel of [...PET_FILES, 'src/renderer/chat.js', 'src/main/pet/loader.js', 'scripts/make-default-pet.js']) {
  const r = cp.spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
  check(`${rel} 可解析`, r.status === 0, r.stderr && r.stderr.trim());
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
process.exitCode = failed ? 1 : 0;
