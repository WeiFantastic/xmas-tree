/* =========================================================
 * tree.js —— 初版粒子发光圣诞树 + 流星/烟花特效
 *
 * 视觉：密集暖色发光粒子组成的锥形树、星空、礼物盒、
 *      树顶四角星、底部光晕与 MERRY CHRISTMAS 小标题。
 * 配色四态：default / blue / green / pink，点击依次循环。
 * 自转：无手势时匀速缓慢旋转；手势接管后跟随手。
 * 特效：流星（细长拖尾）+ 烟花（蓝白粒子爆散），可开关。
 * 手势只改 旋转/缩放/聚散/绽放，永不改变颜色。
 * ========================================================= */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const COLOR_ORDER = ['default', 'blue', 'green', 'pink'];

const PALETTES = {
  default: [
    '#FFD86B', '#FFB03A', '#FF7A45', '#FF4E6B',
    '#3FA46A', '#FFF3C4', '#FFC1A6', '#FFE9A8'
  ],
  blue: [
    '#5AB8FF', '#2E86FF', '#1B5FD9', '#8FD4FF',
    '#3D9BF0', '#B3E4FF', '#2563C7', '#7CC6FF'
  ],
  green: [
    '#237A45', '#145C33', '#2E8B57', '#0E4A29',
    '#3A9E63', '#185F38', '#45A870', '#1D6B3E'
  ],
  pink: [
    '#FFB6D9', '#FF9CCB', '#FFD1E6', '#F5A8CD',
    '#FFE0EF', '#EC93C1', '#FFC2DC', '#FBD4E6'
  ]
};

const GIFT_COLORS = {
  default: ['#e8524f', '#f0a93c', '#4fae7a'],
  blue: ['#2e86ff', '#5ab8ff', '#1b5fd9'],
  green: ['#237a45', '#3a9e63', '#145c33'],
  pink: ['#ff9ccb', '#ffb6d9', '#f5a8cd']
};

const LABELS = { default: '默认配色', blue: '蓝色', green: '深绿', pink: '淡粉' };

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* 预渲染发光粒子贴图（白心 + 颜色光晕），避免逐帧 shadowBlur */
function makeSprite(color, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const grd = g.createRadialGradient(r, r, 0, r, r, r);
  grd.addColorStop(0.00, 'rgba(255,255,255,0.98)');
  grd.addColorStop(0.14, color);
  grd.addColorStop(0.38, hexToRgba(color, 0.55));
  grd.addColorStop(0.72, hexToRgba(color, 0.12));
  grd.addColorStop(1.00, hexToRgba(color, 0));
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}

export class ChristmasTree {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 760;

    this.colorMode = 'default';
    this.autoRotateSpeed = 0.0032;
    this.hasGesture = false;

    this.targetRotation = 0;
    this.targetSpread = 1;
    this.targetScale = 1;
    this.rotation = 0;
    this.spread = 1;
    this.scale = 1;
    this.bloom = 0;

    // 礼物聚焦展示（捏合触发：礼物放大到中央并打开露出祝福语）
    this.giftFocus = 0;          // 当前动画进度 0→1
    this.giftFocusActive = false;
    this.giftFocusTimer = 0;     // 自动收起倒计时（按帧）

    // 特效
    this.fxEnabled = false;
    this.meteors = [];
    this.fireworks = [];
    this._meteorTimer = 40;
    this._fwTimer = 90;

    this.time = 0;
    this.particles = [];
    this.gifts = [];
    this.stars = [];
    this.sprites = [];
    this.fxSprites = [];

    this.resize();
    this.build();
    this._bindResize();
    this._loop();
  }

  _bindResize() {
    let t;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const wasMobile = this.isMobile;
        this.isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 760;
        this.resize();
        if (wasMobile !== this.isMobile) this.build();
      }, 120);
    });
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.treeH = Math.min(this.H * (this.isMobile ? 0.58 : 0.68), this.W * 1.05);
    this.treeW = this.treeH * 0.60;
    this.cx = this.W / 2;
    this.baseY = this.H * (this.isMobile ? 0.70 : 0.84);
  }

  build() {
    const n = this.isMobile ? 1500 : 2600;
    this.particles.length = 0;
    for (let i = 0; i < n; i++) {
      const h = Math.pow(Math.random(), 0.86);
      const layerR = Math.pow(1 - h, 0.92);
      let r = layerR * Math.sqrt(Math.random());
      if (Math.random() < 0.10) r *= 1.12;
      const a = Math.random() * TAU;

      const q = Math.random();
      let ci;
      if (q < 0.36) ci = 0;
      else if (q < 0.56) ci = 1;
      else if (q < 0.70) ci = 2;
      else if (q < 0.80) ci = 5;
      else if (q < 0.88) ci = 6;
      else if (q < 0.94) ci = 3;
      else ci = 4;

      this.particles.push({
        h, r, a, ci,
        size: 0.55 + Math.pow(Math.random(), 2) * 1.9,
        phase: Math.random() * TAU,
        twinkle: 0.5 + Math.random() * 1.9,
        bo: Math.random() * 0.7 + 0.3
      });
    }

    this.gifts.length = 0;
    const giftCount = this.isMobile ? 5 : 7;
    for (let i = 0; i < giftCount; i++) {
      const h = 0.10 + Math.random() * 0.40;
      const a = Math.random() * TAU;
      const r = Math.pow(1 - h, 0.92) * (0.55 + Math.random() * 0.40);
      this.gifts.push({
        h, r, a,
        s: 0.85 + Math.random() * 0.7,
        kind: i % 3,
        phase: Math.random() * TAU
      });
    }

    this.stars.length = 0;
    const sn = this.isMobile ? 90 : 150;
    for (let i = 0; i < sn; i++) {
      this.stars.push({
        x: Math.random(), y: Math.random(),
        r: 0.3 + Math.random() * 1.0,
        phase: Math.random() * TAU,
        speed: 0.3 + Math.random() * 1.2
      });
    }

    this.buildSprites();
  }

  buildSprites() {
    const pal = PALETTES[this.colorMode];
    this.sprites = pal.map(c => makeSprite(c));
    // 流星/烟花专用冰蓝白发光点
    this.fxSprites = ['#ffffff', '#bfe9ff', '#5ab8ff'].map(c => makeSprite(c));
  }

  setColorMode(mode) {
    if (!COLOR_ORDER.includes(mode) || this.colorMode === mode) return;
    this.colorMode = mode;
    this.buildSprites();
  }

  toggleColor() {
    const i = COLOR_ORDER.indexOf(this.colorMode);
    this.setColorMode(COLOR_ORDER[(i + 1) % COLOR_ORDER.length]);
    return this.colorMode;
  }

  get colorLabel() { return LABELS[this.colorMode]; }

  triggerBloom() { this.bloom = 1; }

  /* 捏合触发：切换"礼物放大展示"。返回 true=打开, false=收起 */
  toggleGiftFocus() {
    this.giftFocusActive = !this.giftFocusActive;
    this.giftFocusTimer = this.giftFocusActive ? 60 * 8 : 0; // 展示约 8 秒后自动收起
    if (this.giftFocusActive) this.triggerBloom();
    return this.giftFocusActive;
  }

  setGestureTargets({ rotation, spread, scale } = {}) {
    this.hasGesture = true;
    if (typeof rotation === 'number') this.targetRotation = rotation;
    if (typeof spread === 'number') this.targetSpread = clamp(spread, 0, 1);
    if (typeof scale === 'number') this.targetScale = clamp(scale, 0.6, 1.6);
  }

  clearGesture() {
    this.hasGesture = false;
    this.targetSpread = 1;
    this.targetScale = 1;
  }

  isPointOnTree(x, y) {
    const top = this.baseY - this.treeH * this.scale - 60;
    const bottom = this.baseY + 20;
    const halfW = this.treeW * this.scale * 0.62;
    return y >= top && y <= bottom && Math.abs(x - this.cx) <= halfW;
  }

  /* ---------- 流星 / 烟花 ---------- */
  setFxEnabled(on) {
    this.fxEnabled = !!on;
    if (!on) {
      this.meteors.length = 0;
      this.fireworks.length = 0;
    } else {
      this._meteorTimer = 12;
      this._fwTimer = 45;
    }
  }

  spawnMeteor() {
    const fromLeft = Math.random() < 0.5;
    const slope = (fromLeft ? 1 : -1) * (0.45 + Math.random() * 0.30);
    const speed = 9 + Math.random() * 7;
    this.meteors.push({
      x: Math.random() * this.W,
      y: -40,
      vx: Math.sin(slope) * speed,
      vy: Math.cos(slope) * speed,
      life: 1
    });
  }

  spawnFirework() {
    const x = this.cx + (Math.random() - 0.5) * this.W * 0.78;
    const y = Math.max(24, this.baseY - this.treeH * (0.55 + Math.random() * 0.78));
    const n = 55 + Math.floor(Math.random() * 40);
    const parts = [];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = 1.8 + Math.random() * 5.5;
      parts.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 1,
        size: 1.0 + Math.random() * 2.2,
        ci: Math.random() < 0.5 ? 0 : (Math.random() < 0.6 ? 1 : 2)
      });
    }
    this.fireworks.push({ parts });
  }

  _updateFx(dt) {
    if (!this.fxEnabled) return;
    this._meteorTimer -= dt;
    if (this._meteorTimer <= 0) {
      this.spawnMeteor();
      this._meteorTimer = 35 + Math.random() * 80;
    }
    this._fwTimer -= dt;
    if (this._fwTimer <= 0) {
      this.spawnFirework();
      this._fwTimer = 70 + Math.random() * 130;
    }

    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.life -= 0.009 * dt;
      if (m.life <= 0 || m.y > this.H + 80 || m.x < -100 || m.x > this.W + 100) {
        this.meteors.splice(i, 1);
      }
    }

    for (let i = this.fireworks.length - 1; i >= 0; i--) {
      const fw = this.fireworks[i];
      let alive = false;
      for (const p of fw.parts) {
        if (p.life <= 0) continue;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= Math.pow(0.985, dt);
        p.vy = p.vy * Math.pow(0.985, dt) + 0.020 * dt;
        p.life -= 0.009 * dt;
        if (p.life > 0) alive = true;
      }
      if (!alive) this.fireworks.splice(i, 1);
    }
  }

  _drawFx() {
    const ctx = this.ctx;
    // 流星：细长渐变拖尾 + 头部亮点
    for (const m of this.meteors) {
      const tx = m.x - m.vx * 9;
      const ty = m.y - m.vy * 9;
      const grd = ctx.createLinearGradient(m.x, m.y, tx, ty);
      grd.addColorStop(0, `rgba(240,252,255,${0.95 * m.life})`);
      grd.addColorStop(0.25, `rgba(150,215,255,${0.5 * m.life})`);
      grd.addColorStop(1, 'rgba(120,190,255,0)');
      ctx.strokeStyle = grd;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(m.x, m.y);
      ctx.stroke();
      ctx.globalAlpha = m.life;
      ctx.drawImage(this.fxSprites[0], m.x - 7, m.y - 7, 14, 14);
      ctx.globalAlpha = 1;
    }
    // 烟花：冰蓝白粒子向外爆散并淡出
    for (const fw of this.fireworks) {
      for (const p of fw.parts) {
        if (p.life <= 0) continue;
        ctx.globalAlpha = Math.max(0, p.life);
        const sz = p.size * 11;
        ctx.drawImage(this.fxSprites[p.ci], p.x - sz / 2, p.y - sz / 2, sz, sz);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* 礼物聚焦展示：放大到屏幕中央、开盖、露出「圣诞节快乐」 */
  _drawGiftFocus() {
    const f = this.giftFocus;
    if (f <= 0.002) return;
    const { ctx, W, H, cx } = this;
    const pal = PALETTES[this.colorMode];
    const gcol = GIFT_COLORS[this.colorMode][0];

    // 缓动
    const e = 1 - Math.pow(1 - f, 3);
    const gx = cx;
    const gy = H * 0.50;
    const base = Math.min(W, H);
    const box = base * 0.24 * e;          // 盒身边长
    const open = clamp((f - 0.35) / 0.65, 0, 1); // 开盖进度

    ctx.save();

    // 半透明暗色遮罩：压暗背景树与原标题，突出礼物
    ctx.fillStyle = `rgba(3,5,12,${0.62 * e})`;
    ctx.fillRect(0, 0, W, H);

    // 中心柔光
    const halo = ctx.createRadialGradient(gx, gy, 0, gx, gy, box * 1.9);
    halo.addColorStop(0, hexToRgba(pal[0], 0.28 * e));
    halo.addColorStop(0.5, hexToRgba(pal[0], 0.10 * e));
    halo.addColorStop(1, hexToRgba(pal[0], 0));
    ctx.fillStyle = halo;
    ctx.fillRect(gx - box * 2, gy - box * 2, box * 4, box * 4);

    // 环粒子（绽放感）
    if (f > 0.05) {
      const n = 26;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + this.time * 0.6;
        const rr = box * (1.05 + 0.35 * Math.sin(this.time * 2 + i));
        const px = gx + Math.cos(a) * rr;
        const py = gy + Math.sin(a) * rr * 0.92;
        const tw = 0.5 + 0.5 * Math.sin(this.time * 3.5 + i * 1.7);
        ctx.globalAlpha = e * tw;
        const sz = base * 0.028 * (0.7 + 0.6 * tw);
        ctx.drawImage(this.fxSprites[i % 3], px - sz / 2, py - sz / 2, sz, sz);
      }
      ctx.globalAlpha = 1;
    }

    // 盒盖（随开盖进度上飞、淡出）
    const lidY = gy - box * 0.55 - open * box * 0.34;
    ctx.save();
    ctx.globalAlpha = e * (1 - open * 0.35);
    ctx.translate(gx, lidY);
    ctx.rotate(-open * 0.32);
    ctx.shadowBlur = 22;
    ctx.shadowColor = hexToRgba(gcol, 0.9);
    ctx.fillStyle = gcol;
    ctx.fillRect(-box * 0.60, -box * 0.14, box * 1.20, box * 0.28);
    ctx.shadowBlur = 0;
    ctx.fillStyle = pal[5];
    ctx.fillRect(-box * 0.07, -box * 0.14, box * 0.14, box * 0.28);
    ctx.beginPath();
    // 蝴蝶结
    ctx.ellipse(-box * 0.20, -box * 0.14, box * 0.16, box * 0.10, -0.4, 0, TAU);
    ctx.ellipse(box * 0.20, -box * 0.14, box * 0.16, box * 0.10, 0.4, 0, TAU);
    ctx.fill();
    ctx.restore();

    // 盒内金光（开盖后从盒口射出）
    if (open > 0) {
      const beam = ctx.createLinearGradient(0, gy - box * 0.9, 0, gy - box * 0.1);
      beam.addColorStop(0, hexToRgba(pal[5], 0));
      beam.addColorStop(1, hexToRgba(pal[5], 0.55 * open));
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(gx - box * 0.1, gy - box * 0.1);
      ctx.lineTo(gx - box * 0.5, gy - box * 0.95);
      ctx.lineTo(gx + box * 0.5, gy - box * 0.95);
      ctx.lineTo(gx + box * 0.1, gy - box * 0.1);
      ctx.closePath();
      ctx.fill();
    }

    // 盒身
    ctx.globalAlpha = e;
    ctx.shadowBlur = 26;
    ctx.shadowColor = hexToRgba(gcol, 0.85);
    ctx.fillStyle = gcol;
    ctx.fillRect(gx - box * 0.55, gy - box * 0.30, box * 1.10, box * 0.86);
    ctx.shadowBlur = 0;
    ctx.fillStyle = hexToRgba('#000000', 0.16);
    ctx.fillRect(gx - box * 0.55, gy + box * 0.28, box * 1.10, box * 0.28);
    // 丝带十字
    ctx.fillStyle = pal[5];
    ctx.fillRect(gx - box * 0.09, gy - box * 0.30, box * 0.18, box * 0.86);
    ctx.fillRect(gx - box * 0.55, gy - box * 0.02, box * 1.10, box * 0.16);

    // 祝福语
    if (open > 0.02) {
      const fontSize = clamp(base * 0.082, 22, 66);
      ctx.globalAlpha = e * open;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const ty = gy - box * 1.18 - Math.sin(this.time * 1.6) * box * 0.03;
      ctx.font = `700 ${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${fontSize * 0.12}px`;
      ctx.shadowBlur = 30;
      ctx.shadowColor = hexToRgba(pal[0], 0.95);
      ctx.fillStyle = pal[5];
      ctx.fillText('圣诞节快乐', gx, ty);
      // 描边增强
      ctx.shadowBlur = 0;
      ctx.lineWidth = Math.max(1, fontSize * 0.028);
      ctx.strokeStyle = hexToRgba(pal[0], 0.75);
      ctx.strokeText('圣诞节快乐', gx, ty);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  _loop() {
    const tick = (now) => {
      const dt = this._last ? Math.min((now - this._last) / 16.67, 3) : 1;
      this._last = now;
      this.time += 0.016 * dt;

      if (!this.hasGesture) {
        this.targetRotation = (this.targetRotation + this.autoRotateSpeed * dt) % TAU;
      }
      this.rotation += (this.targetRotation - this.rotation) * (this.hasGesture ? 0.10 : 0.06) * dt;
      this.spread += (this.targetSpread - this.spread) * 0.10 * dt;
      this.scale += (this.targetScale - this.scale) * 0.10 * dt;
      this.bloom *= Math.pow(0.93, dt);
      if (this.bloom < 0.002) this.bloom = 0;

      // 礼物聚焦动画 + 自动收起
      if (this.giftFocusActive) {
        this.giftFocusTimer -= dt;
        if (this.giftFocusTimer <= 0) this.giftFocusActive = false;
      }
      const gfTarget = this.giftFocusActive ? 1 : 0;
      this.giftFocus += (gfTarget - this.giftFocus) * 0.12 * dt;
      if (Math.abs(gfTarget - this.giftFocus) < 0.002) this.giftFocus = gfTarget;

      this._updateFx(dt);
      this._draw();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _draw() {
    const { ctx, W, H, cx, baseY, treeH, treeW } = this;
    const pal = PALETTES[this.colorMode];

    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, W, H);
    const bg = ctx.createRadialGradient(cx, baseY - treeH * 0.42, 10, cx, baseY - treeH * 0.32, Math.max(W, H) * 0.72);
    bg.addColorStop(0, hexToRgba(pal[0], 0.13));
    bg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 星空
    for (const s of this.stars) {
      const a = 0.18 + 0.55 * (0.5 + 0.5 * Math.sin(this.time * s.speed + s.phase));
      ctx.globalAlpha = a;
      ctx.fillStyle = pal[5];
      ctx.beginPath();
      ctx.arc(s.x * W, s.y * H, s.r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 底部光晕
    ctx.save();
    ctx.translate(cx, baseY + 4);
    ctx.scale(1, 0.20);
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, treeW * 0.85);
    halo.addColorStop(0, hexToRgba(pal[0], 0.28));
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, treeW * 0.85, 0, TAU);
    ctx.fill();
    ctx.restore();

    // 粒子树
    const s = this.spread;
    const sc = this.scale;
    const rot = this.rotation;
    const sprites = this.sprites;

    for (const p of this.particles) {
      const eh = 0.42 + (p.h - 0.42) * s;
      const er = p.r * s;
      const ang = p.a + rot;
      const xr = er * Math.cos(ang);
      const zr = er * Math.sin(ang);
      const persp = 1 + zr * 0.30;

      const bo = this.bloom * p.bo;
      const bx = Math.cos(p.a) * bo * treeW * 0.42;
      const by = Math.sin(p.a) * bo * treeH * 0.26;

      const px = cx + xr * treeW * 0.5 * persp * sc + bx;
      const py = baseY - eh * treeH * sc + zr * treeH * 0.045 + by;

      const tw = 0.5 + 0.5 * Math.sin(this.time * p.twinkle + p.phase);
      ctx.globalAlpha = 0.32 + 0.68 * tw;
      const sz = p.size * (0.82 + 0.34 * tw) * (0.86 + 0.28 * persp) * (5.4 + W / 320);
      ctx.drawImage(sprites[p.ci], px - sz / 2, py - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;

    // 礼物盒
    for (const gf of this.gifts) {
      const eh = 0.42 + (gf.h - 0.42) * s;
      const er = gf.r * s;
      const ang = gf.a + rot;
      const xr = er * Math.cos(ang);
      const zr = er * Math.sin(ang);
      const persp = 1 + zr * 0.30;
      const px = cx + xr * treeW * 0.5 * persp * sc;
      const py = baseY - eh * treeH * sc + zr * treeH * 0.045;
      const gs = (10 + gf.s * 5) * sc * (0.9 + 0.2 * persp);
      const flick = 0.85 + 0.15 * Math.sin(this.time * 2 + gf.phase);

      ctx.save();
      ctx.globalAlpha = clamp(0.55 + 0.45 * s, 0, 1) * flick;
      ctx.translate(px, py);
      ctx.rotate(Math.sin(this.time * 0.8 + gf.phase) * 0.08);
      ctx.shadowBlur = 14;
      ctx.shadowColor = hexToRgba(pal[0], 0.9);
      ctx.fillStyle = GIFT_COLORS[this.colorMode][gf.kind];
      ctx.fillRect(-gs / 2, -gs / 2, gs, gs);
      ctx.shadowBlur = 0;
      ctx.fillStyle = pal[5];
      ctx.fillRect(-gs / 2, -gs * 0.09, gs, gs * 0.18);
      ctx.fillRect(-gs * 0.09, -gs / 2, gs * 0.18, gs);
      ctx.fillStyle = pal[5];
      ctx.beginPath();
      ctx.arc(-gs * 0.20, -gs * 0.62, gs * 0.16, 0, TAU);
      ctx.arc(gs * 0.20, -gs * 0.62, gs * 0.16, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // 树顶四角星
    const starY = baseY - treeH * sc - 4;
    const starR = (13 + 3 * Math.sin(this.time * 2.2)) * sc;
    ctx.save();
    ctx.translate(cx, starY);
    ctx.shadowBlur = 26;
    ctx.shadowColor = pal[0];
    ctx.fillStyle = pal[5];
    ctx.beginPath();
    ctx.moveTo(0, -starR * 1.5);
    ctx.quadraticCurveTo(starR * 0.16, -starR * 0.16, starR * 0.92, 0);
    ctx.quadraticCurveTo(starR * 0.16, starR * 0.16, 0, starR * 1.5);
    ctx.quadraticCurveTo(-starR * 0.16, starR * 0.16, -starR * 0.92, 0);
    ctx.quadraticCurveTo(-starR * 0.16, -starR * 0.16, 0, -starR * 1.5);
    ctx.fill();
    ctx.restore();

    // MERRY CHRISTMAS 标题
    const fontSize = clamp(W * 0.026, 13, 30);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${fontSize}px Georgia, "Times New Roman", serif`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${fontSize * 0.22}px`;
    ctx.shadowBlur = 18;
    ctx.shadowColor = hexToRgba(pal[0], 0.75);
    ctx.fillStyle = pal[5];
    ctx.fillText('MERRY CHRISTMAS', cx, starY - starR * 1.5 - fontSize * 1.15);
    ctx.restore();

    // 流星与烟花绘制在最上层
    this._drawFx();

    // 礼物聚焦展示（捏合触发，盖在最上层）
    this._drawGiftFocus();
  }
}
