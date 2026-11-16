/* =========================================================
 * app.js —— 主程序
 * 职责：授权开摄像头 / 点击换色 / 手势映射 / 状态提示
 *
 * 关键约束：
 *  1) 颜色只有两态，只有指针点击会改颜色；
 *  2) 手势只改 旋转/缩放/聚散/绽放，永不触碰 colorMode；
 *  3) 摄像头不可用/拒绝授权时给出明确提示，且换色照常可用。
 * ========================================================= */

import { ChristmasTree } from './tree.js';
import { HandController } from './hand-controller.js';
import { LiteHandController } from './lite-hand-controller.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const canvas = $('treeCanvas');
const tree = new ChristmasTree(canvas);

const camBtn = $('camBtn');
const camBtnText = $('camBtnText');
const camPanel = $('camPanel');
const camVideo = $('camVideo');
const camOverlay = $('camOverlay');
const camClose = $('camClose');
const cameraPill = $('cameraPill');
const colorPill = $('colorPill');
const gestureLive = $('gestureLive');
const alertBox = $('alertBox');
const alertTitle = $('alertTitle');
const alertDesc = $('alertDesc');
const alertClose = $('alertClose');
const toast = $('toast');

let stream = null;
let handController = null;
let busy = false;

/* ---------- 通用 UI ---------- */
function setPill(el, cls, text) {
  el.className = `pill ${cls}`;
  el.querySelector('span').textContent = text;
}

function setCamButton(on, text) {
  camBtn.classList.toggle('on', on);
  camBtnText.textContent = text;
}

function setGestureLive(text, active) {
  gestureLive.textContent = text;
  gestureLive.classList.toggle('active', !!active);
}

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function showAlert(title, desc) {
  alertTitle.textContent = title;
  alertDesc.textContent = desc;
  alertBox.classList.remove('hidden');
}
function hideAlert() { alertBox.classList.add('hidden'); }

/* ---------- 点击 / 点按换色（唯一改颜色的入口） ---------- */
let downPt = null;
canvas.addEventListener('pointerdown', (e) => {
  downPt = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', (e) => {
  if (!downPt) return;
  const moved = Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y);
  downPt = null;
  if (moved > 14) return; // 手指滑动/拖拽不算点击

  const mode = tree.toggleColor();
  document.body.dataset.color = mode;
  setPill(colorPill, `pill-${mode}`, tree.colorLabel);
  showToast(`已切换为${tree.colorLabel}`);
});
canvas.addEventListener('pointercancel', () => { downPt = null; });

/* ---------- 摄像头错误分类 ---------- */
function cameraError(err) {
  const name = err && err.name;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return ['摄像头权限被拒绝',
        '请在浏览器地址栏或系统设置中允许本页面使用摄像头，然后重试。\n不开摄像头也可以点击圣诞树换色。'];
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return ['未检测到摄像头',
        '请确认设备已连接摄像头。手机可用前置摄像头，电脑请接入摄像头后重试。\n不开摄像头也可以点击圣诞树换色。'];
    case 'NotReadableError':
    case 'TrackStartError':
      return ['摄像头被占用',
        '摄像头可能正被其他程序使用，请关闭其他程序后重试。\n不开摄像头也可以点击圣诞树换色。'];
    case 'OverconstrainedError':
      return ['摄像头参数不受支持',
        '当前摄像头不支持请求的分辨率，请更换设备后重试。\n不开摄像头也可以点击圣诞树换色。'];
    case 'SecurityError':
      return ['摄像头访问环境不安全',
        '请通过 HTTPS 或本机 localhost 访问本页面。\n不开摄像头也可以点击圣诞树换色。'];
    default:
      return ['无法开启摄像头',
        `${(err && err.message) || '未知错误'}。\n请刷新页面重试；不开摄像头也可以点击圣诞树换色。`];
  }
}

/* ---------- 手势控制器（复用同一实例，供预加载与授权共用） ---------- */
const handCallbacks = {
  video: camVideo,
  overlay: camOverlay,
  onUpdate: (g) => {
    if (!g) {
      tree.clearGesture();
      setGestureLive('手势状态：未检测到手', false);
      return;
    }
    const rotation = (0.5 - g.x) * Math.PI * 2.2;
    const yScale = clamp(1 + (0.5 - g.y) * 0.9, 0.70, 1.45);
    const zScale = clamp(0.78 + g.handSize * 1.8, 0.82, 1.25);
    const scale = clamp(yScale * zScale, 0.65, 1.55);
    const spread = 0.12 + g.openness * 0.88;

    // 手势只改旋转/缩放/聚散，从不触碰颜色
    tree.setGestureTargets({ rotation, spread, scale });

    const shape = g.openness > 0.7 ? '张开手掌' : (g.openness < 0.3 ? '握拳' : '半张手');
    setGestureLive(
      `手势：${shape} · 旋转 ${Math.round(rotation * 57)}°` + (g.pinching ? ' · 捏合' : ''),
      true
    );
  },
  onPinch: () => {
    tree.triggerBloom();
    showToast('绽放特效已触发');
  }
};

/* 移动端用零依赖的 LiteHandController（避开 wasm/WebGL 兼容性问题）；
 * 桌面端用精确的 HandController。 */
function isMobileDevice() {
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|MicroMessenger|QQ\//i.test(ua)) return true;
  return (navigator.maxTouchPoints || 0) > 0 && Math.min(window.innerWidth, window.innerHeight) < 820;
}

function makeController(lite) {
  const Ctor = lite ? LiteHandController : HandController;
  return new Ctor(handCallbacks);
}

function getController() {
  if (!handController) {
    handController = makeController(isMobileDevice());
  }
  return handController;
}

/* 仅桌面端在后台预加载 MediaPipe 模型，把 17MB 下载提前；
 * 移动端用零依赖引擎，无需预加载。失败静默，不打扰 UI。 */
function preloadModel() {
  if (isMobileDevice()) {
    console.info('[手势] 移动端使用轻量引擎，无需预加载模型');
    return;
  }
  try {
    getController().init()
      .then((d) => console.info('[手势] 后台预加载完成：' + d))
      .catch((e) => console.warn('[手势] 后台预加载未完成：' + ((e && e.message) || e)));
  } catch (e) {
    console.warn('[手势] 预加载跳过：' + ((e && e.message) || e));
  }
}

/* ---------- 开启摄像头 + 手势 ---------- */
async function enableCamera() {
  if (busy) return;
  busy = true;

  if (!window.isSecureContext) {
    showAlert('需要安全访问环境',
      '摄像头仅在 HTTPS 或 localhost 下可用。\n请在电脑上用 http://localhost 访问本项目；手机端请通过 HTTPS 地址访问。\n不开摄像头也可以点击圣诞树换色。');
    busy = false;
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showAlert('浏览器不支持摄像头',
      '请使用较新版本的 Chrome、Edge 或 Safari 浏览器。\n不开摄像头也可以点击圣诞树换色。');
    busy = false;
    return;
  }

  setCamButton(true, '正在请求摄像头权限…');
  let media;
  try {
    media = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 }
      },
      audio: false
    });
  } catch (err) {
    setCamButton(false, '开启摄像头手势控制');
    setPill(cameraPill, 'pill-error', '摄像头不可用');
    const [t, d] = cameraError(err);
    showAlert(t, d);
    busy = false;
    return;
  }

  stream = media;
  camPanel.classList.remove('hidden');
  setPill(cameraPill, 'pill-on', '摄像头已开启');
  setCamButton(true, '正在加载手势模型…');

  try {
    let ctrl = getController();
    let delegate;
    try {
      delegate = await ctrl.init((msg) => setCamButton(true, msg));
    } catch (err) {
      // 精确引擎失败（含超时）：自动降级到零依赖的轻量引擎
      console.warn('[手势] 精确引擎失败，降级到轻量引擎：' + ((err && err.message) || err));
      try { ctrl.stop(); } catch (_) {}
      handController = makeController(true);
      ctrl = handController;
      setCamButton(true, '正在启用轻量手势引擎…');
      delegate = await ctrl.init();
      showToast('已自动切换到轻量手势引擎');
    }
    console.info('[手势] 手势引擎就绪：' + delegate);
    await ctrl.start(stream);
    setCamButton(true, '关闭摄像头');
    showToast('手势控制已开启，在摄像头前张开手掌试试');
  } catch (err) {
    // 摄像头已开但手势引擎失败：保留预览，明确提示，换色仍可用
    setCamButton(true, '关闭摄像头');
    const reason = (err && err.message) || '未知错误';
    showAlert('手势功能不可用',
      `${reason}。\n摄像头预览与点击换色不受影响，你仍可点按圣诞树换色。`);
  } finally {
    busy = false;
  }
}

/* ---------- 关闭摄像头 ---------- */
function closeCamera() {
  if (busy) return;
  if (handController) handController.stop();
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  camPanel.classList.add('hidden');
  setPill(cameraPill, 'pill-off', '摄像头未开启');
  setCamButton(false, '开启摄像头手势控制');
  setGestureLive('手势状态：未检测', false);
  showToast('摄像头已关闭，点击换色仍可用');
}

/* ---------- 绑定 ---------- */
camBtn.addEventListener('click', () => { stream ? closeCamera() : enableCamera(); });
camClose.addEventListener('click', closeCamera);
alertClose.addEventListener('click', hideAlert);

// 流星 / 烟花开关
const fxBtn = $('fxBtn');
const fxBtnText = $('fxBtnText');
let fxOn = false;
fxBtn.addEventListener('click', () => {
  fxOn = !fxOn;
  tree.setFxEnabled(fxOn);
  fxBtn.classList.toggle('on', fxOn);
  fxBtnText.textContent = fxOn ? '关闭流星烟花' : '开启流星烟花';
  showToast(fxOn ? '流星烟花已开启' : '流星烟花已关闭');
});

// 一键隐藏界面：只保留圣诞树，换色与自转继续可用
const uiToggle = $('uiToggle');
uiToggle.addEventListener('click', () => {
  const hidden = document.body.classList.toggle('ui-hidden');
  uiToggle.setAttribute('aria-label', hidden ? '显示界面' : '隐藏界面');
  showToast(hidden ? '已隐藏界面，点右侧按钮恢复' : '界面已显示');
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('ui-hidden')) {
    document.body.classList.remove('ui-hidden');
    showToast('界面已显示');
  }
});

window.addEventListener('beforeunload', () => {
  if (stream) stream.getTracks().forEach(t => t.stop());
});

/* ---------- 初始状态 ---------- */
document.body.dataset.color = 'default';
setPill(colorPill, 'pill-default', '默认配色');
setPill(cameraPill, 'pill-off', '摄像头未开启');

// 页面一打开就在后台预加载模型，等用户点授权时通常已就绪
window.addEventListener('load', () => {
  setTimeout(preloadModel, 300);
});
