/* =========================================================
 * lite-hand-controller.js —— 零依赖纯 JS 手势检测（移动端）
 *
 * 背景：部分手机内置浏览器（如 realme UI 浏览器）无法初始化
 * MediaPipe 的 WebAssembly / WebGL 后端，导致模型加载永久挂起。
 * 本引擎不下载模型、不依赖 wasm，用肤色分割定位手掌，
 * 输出与 HandController 完全一致的接口，可直接替换。
 *
 * 输出手势量：
 *   x        掌心横坐标（已镜像，0 左 → 1 右）
 *   y        掌心纵坐标（0 上 → 1 下）
 *   openness 张开程度 0(握拳) → 1(张手)，由轮廓充盈度估计
 *   handSize 手掌相对大小，反映离摄像头远近
 *   pinching 是否捏合（靠近 + 收拢，带冷却防抖）
 * ========================================================= */

const clamp01 = v => Math.min(1, Math.max(0, v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class LiteHandController {
  constructor({ video, overlay, onUpdate, onPinch }) {
    this.video = video;
    this.overlay = overlay;
    this.octx = overlay.getContext('2d');
    this.onUpdate = onUpdate || (() => {});
    this.onPinch = onPinch || (() => {});

    // 低分辨率采样画布，降低逐帧计算量
    this.sw = 160;
    this.sh = 120;
    this.sample = document.createElement('canvas');
    this.sample.width = this.sw;
    this.sample.height = this.sh;
    this.sctx = this.sample.getContext('2d', { willReadFrequently: true });

    this.delegate = 'LITE';
    this.running = false;
    this._pinch = false;
    this._lastPinch = 0;
    this._lastVideoTime = -1;

    this.sm = { x: 0.5, y: 0.5, openness: 0.5, handSize: 0.15 };
    this.smInit = false;
  }

  /* 零依赖，立即就绪 */
  init() {
    return Promise.resolve('LITE');
  }

  /* 绑定摄像头流并启动循环 */
  async start(stream) {
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
      try { this._detect(); } catch (_) {}
    }
    requestAnimationFrame(() => this._loop());
  }

  /* YCrCb 肤色判定：覆盖常见肤色范围，对光照有一定鲁棒性 */
  _isSkin(r, g, b) {
    const Y  =  0.299 * r + 0.587 * g + 0.114 * b;
    const Cb = -0.169 * r - 0.331 * g + 0.500 * b + 128;
    const Cr =  0.500 * r - 0.419 * g - 0.081 * b + 128;
    return Y > 48 && Cr >= 133 && Cr <= 180 && Cb >= 77 && Cb <= 132;
  }

  _detect() {
    const { sctx, sw, sh } = this;
    sctx.drawImage(this.video, 0, 0, sw, sh);
    const data = sctx.getImageData(0, 0, sw, sh).data;

    let sumX = 0, sumY = 0, n = 0;
    let minX = sw, maxX = 0, minY = sh, maxY = 0;

    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const i = (y * sw + x) * 4;
        if (this._isSkin(data[i], data[i + 1], data[i + 2])) {
          sumX += x; sumY += y; n++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const total = sw * sh;
    const ratio = n / total;
    // 面积过小视为噪声/无手；过大视为整屏暖色背景误判
    if (n < total * 0.006 || ratio > 0.62) {
      this._drawBlob(null);
      this.onUpdate(null);
      return;
    }

    const cx = sumX / n / sw;
    const cy = sumY / n / sh;
    const bw = (maxX - minX + 1) / sw;
    const bh = (maxY - minY + 1) / sh;
    const fill = clamp01(n / Math.max(1, (maxX - minX + 1) * (maxY - minY + 1)));

    // 张开度：握拳时轮廓充盈度高，张手时手指缝隙多、充盈度低
    const openness = clamp01((0.82 - fill) / 0.5);
    // 手掌大小：包围盒面积相对整帧，开方后映射到合理区间
    const handSize = clamp(Math.sqrt(bw * bh) * 0.75, 0.05, 0.42);

    // 捏合近似：手离镜头很近（面积大）且收拢，带冷却防抖
    const now = performance.now();
    const wantPinch = ratio > 0.14 && openness < 0.3;
    if (wantPinch && !this._pinch && now - this._lastPinch > 2200) {
      this._pinch = true;
      this._lastPinch = now;
      this.onPinch();
    } else if (!wantPinch && this._pinch && now - this._lastPinch > 500) {
      this._pinch = false;
    }

    const raw = { x: 1 - cx, y: cy, openness, handSize };
    if (!this.smInit) {
      Object.assign(this.sm, raw);
      this.smInit = true;
    } else {
      const k = 0.3;
      this.sm.x += (raw.x - this.sm.x) * k;
      this.sm.y += (raw.y - this.sm.y) * k;
      this.sm.openness += (raw.openness - this.sm.openness) * k;
      this.sm.handSize += (raw.handSize - this.sm.handSize) * k;
    }

    this._drawBlob({ cx, cy, bw, bh });
    this.onUpdate({
      x: this.sm.x,
      y: this.sm.y,
      openness: this.sm.openness,
      handSize: this.sm.handSize,
      pinching: this._pinch
    });
  }

  /* 在预览上画一个跟随手掌的方框与中心点（坐标手动镜像，与视频对齐） */
  _drawBlob(box) {
    const c = this.octx;
    const w = this.overlay.width, h = this.overlay.height;
    c.clearRect(0, 0, w, h);
    if (!box) return;

    const cx = (1 - box.cx) * w;
    const cy = box.cy * h;
    const bw = box.bw * w, bh = box.bh * h;

    c.lineWidth = 2;
    c.strokeStyle = 'rgba(92,230,165,0.9)';
    c.shadowBlur = 8;
    c.shadowColor = 'rgba(92,230,165,0.7)';
    c.strokeRect(cx - bw / 2, cy - bh / 2, bw, bh);
    c.shadowBlur = 0;
    c.fillStyle = '#fff4cf';
    c.beginPath();
    c.arc(cx, cy, 3.5, 0, Math.PI * 2);
    c.fill();
  }
}
