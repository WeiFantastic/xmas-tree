/* =========================================================
 * hand-controller.js —— 基于 MediaPipe HandLandmarker 的手势识别
 * 只负责“看懂手”，不改颜色；颜色状态完全由 app.js 的点击事件管理。
 *
 * 输出手势量：
 *   x        掌心横坐标（已镜像，0 左 → 1 右）
 *   y        掌心纵坐标（0 上 → 1 下）
 *   openness 手指张开程度 0(握拳) → 1(张手)
 *   handSize 手掌视觉大小，反映离摄像头的远近
 *   pinching 是否捏合（用于绽放特效）
 * ========================================================= */

import { FilesetResolver, HandLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]
];

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = v => Math.min(1, Math.max(0, v));

export class HandController {
  constructor({ video, overlay, onUpdate, onPinch }) {
    this.video = video;
    this.overlay = overlay;
    this.octx = overlay.getContext('2d');
    this.onUpdate = onUpdate || (() => {});
    this.onPinch = onPinch || (() => {});

    this.landmarker = null;
    this.running = false;
    this._lastVideoTime = -1;
    this._pinch = false;

    // 平滑状态
    this.sm = { x: 0.5, y: 0.5, openness: 1, handSize: 0.13 };
    this.smInit = false;
  }

  /* 初始化模型：优先 GPU，失败自动回退 CPU */
  async init() {
    const wasmUrl = new URL('../vendor/mediapipe/wasm/', import.meta.url).href;
    const modelUrl = new URL('../models/hand_landmarker.task', import.meta.url).href;

    const vision = await FilesetResolver.forVisionTasks(wasmUrl);

    const options = (delegate) => ({
      baseOptions: { modelAssetPath: modelUrl, delegate },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55
    });

    try {
      this.landmarker = await HandLandmarker.createFromOptions(vision, options('GPU'));
      this.delegate = 'GPU';
    } catch (e) {
      this.landmarker = await HandLandmarker.createFromOptions(vision, options('CPU'));
      this.delegate = 'CPU';
    }
    return this.delegate;
  }

  /* 绑定摄像头流并开始逐帧检测 */
  async start(stream) {
    if (!this.landmarker) throw new Error('手势模型尚未初始化');
    this.video.srcObject = stream;
    await this.video.play();
    this.running = true;
    this._resizeOverlay();
    this._loop();
  }

  stop() {
    this.running = false;
    try { this.video.pause(); } catch (_) {}
    this.video.srcObject = null;
    this.octx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.smInit = false;
    this._pinch = false;
    this.onUpdate(null);
  }

  _resizeOverlay() {
    const r = this.video.getBoundingClientRect();
    this.overlay.width = Math.max(1, Math.round(r.width));
    this.overlay.height = Math.max(1, Math.round(r.height));
  }

  _loop() {
    if (!this.running) return;

    if (this.video.readyState >= 2 && this.video.currentTime !== this._lastVideoTime) {
      this._lastVideoTime = this.video.currentTime;
      try {
        const result = this.landmarker.detectForVideo(this.video, performance.now());
        this._handle(result);
      } catch (_) {
        // 单帧检测异常不影响整体循环
      }
    }
    requestAnimationFrame(() => this._loop());
  }

  _handle(result) {
    const lm = result && result.landmarks && result.landmarks[0];
    if (!lm) {
      this._drawSkeleton(null);
      this.onUpdate(null);
      return;
    }

    // 掌心：腕(0) + 食指根(5) + 中指根(9) + 无名指根(13) + 小指根(17) 均值
    const palmPts = [0, 5, 9, 13, 17];
    let mx = 0, my = 0;
    for (const i of palmPts) { mx += lm[i].x; my += lm[i].y; }
    mx /= palmPts.length; my /= palmPts.length;

    // 手掌参考长度：腕 → 中指根
    const palm = Math.max(dist2(lm[0], lm[9]), 0.001);

    // 张开度：四指尖到腕的距离（相对掌长）取连续值
    const tips = [8, 12, 16, 20];
    let openness = 0;
    for (const t of tips) {
      const ratio = dist2(lm[t], lm[0]) / palm;
      openness += clamp01((ratio - 1.25) / 1.00);
    }
    openness /= 4;

    // 捏合：拇指尖 ↔ 食指尖 距离 / 掌长；带滞回防抖
    const pinchRatio = dist2(lm[4], lm[8]) / palm;
    const wasPinch = this._pinch;
    this._pinch = wasPinch ? (pinchRatio < 0.70) : (pinchRatio < 0.55);
    if (this._pinch && !wasPinch) this.onPinch();

    // 镜像 x：与预览画面（CSS scaleX(-1)）保持一致的方向感
    const raw = {
      x: 1 - mx,
      y: my,
      openness,
      handSize: palm
    };

    if (!this.smInit) {
      Object.assign(this.sm, raw);
      this.smInit = true;
    } else {
      const k = 0.32;
      this.sm.x += (raw.x - this.sm.x) * k;
      this.sm.y += (raw.y - this.sm.y) * k;
      this.sm.openness += (raw.openness - this.sm.openness) * k;
      this.sm.handSize += (raw.handSize - this.sm.handSize) * k;
    }

    this._drawSkeleton(lm);
    this.onUpdate({
      x: this.sm.x,
      y: this.sm.y,
      openness: this.sm.openness,
      handSize: this.sm.handSize,
      pinching: this._pinch
    });
  }

  /* 在摄像头预览上绘制手部骨架（叠加层已做水平镜像） */
  _drawSkeleton(lm) {
    const c = this.octx;
    const w = this.overlay.width, h = this.overlay.height;
    c.clearRect(0, 0, w, h);
    if (!lm) return;

    const px = i => ({ x: (1 - lm[i].x) * w, y: lm[i].y * h });

    c.lineWidth = 2;
    c.strokeStyle = 'rgba(92,230,165,0.85)';
    c.shadowBlur = 8;
    c.shadowColor = 'rgba(92,230,165,0.7)';
    c.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      const pa = px(a), pb = px(b);
      c.moveTo(pa.x, pa.y);
      c.lineTo(pb.x, pb.y);
    }
    c.stroke();

    c.shadowBlur = 0;
    c.fillStyle = '#fff4cf';
    for (let i = 0; i < lm.length; i++) {
      const p = px(i);
      c.beginPath();
      c.arc(p.x, p.y, i === 4 || i === 8 ? 3.4 : 2.2, 0, Math.PI * 2);
      c.fill();
    }
  }
}
