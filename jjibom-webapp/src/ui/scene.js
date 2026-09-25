// scene.js — the living backdrop: a still lake at night with a luminous float
// bobbing on it and rings spreading out. Purely decorative; it idles at 30 fps,
// pauses when hidden and draws a single still frame for reduced motion.

const TAU = Math.PI * 2;

function mulberry(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class LakeScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.running = false;
    this.raf = 0;
    this.last = 0;
    this.dim = 0;           // 0 = full scene, 1 = almost black
    this.night = false;
    this.lift = 0;          // 0 = default composition, 1 = lake raised (onboarding)
    this.liftTarget = 0;
    this.centerX = null;    // float position (px); null = middle of the canvas
    this.w = 0;
    this.h = 0;
    this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const rnd = mulberry(20260925);
    this.stars = Array.from({ length: 70 }, () => ({ x: rnd(), y: rnd() * 0.46, r: 0.3 + rnd() * 0.9, p: rnd() * TAU, s: 0.4 + rnd() * 1.2 }));
    this.glints = Array.from({ length: 90 }, () => ({ d: rnd(), x: rnd() - 0.5, l: 0.3 + rnd(), p: rnd() * TAU, v: 0.2 + rnd() * 0.6 }));
    this.hillA = Array.from({ length: 9 }, () => rnd());
    this.hillB = Array.from({ length: 13 }, () => rnd());
    this.resize();
    this._onResize = () => { this.resize(); if (!this.running) this.draw(performance.now()); };
    window.addEventListener('resize', this._onResize);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setDim(value) { this.dim = value; if (!this.running) this.draw(performance.now()); }
  // Put the float under the middle of the visible stage (desktop layouts have
  // a rail on the left and a control column on the right).
  setCenter(x) { this.centerX = x; if (!this.running) this.draw(performance.now()); }

  // Raise the horizon so text laid over the lower half never covers the float.
  setLift(on) { this.liftTarget = on ? 1 : 0; if (this.reduced) this.lift = this.liftTarget; }
  setNight(on) { this.night = on; if (!this.running) this.draw(performance.now()); }

  start() {
    if (this.running) return;
    if (this.reduced) { this.draw(performance.now()); return; }
    this.running = true;
    const loop = (t) => {
      if (!this.running) return;
      if (t - this.last >= 33) { this.last = t; this.draw(t); }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  draw(now) {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    const t = now / 1000;
    this.lift += (this.liftTarget - this.lift) * 0.08;
    const base = w > h ? 0.56 : 0.5;
    const horizon = Math.round(h * (base - this.lift * (base - 0.34)));
    const s = Math.max(0.75, Math.min(1.7, Math.min(w, h) / 440));
    const ember = this.night ? [255, 110, 84] : [255, 106, 61];
    const lume = this.night ? [255, 120, 96] : [141, 245, 200];

    // sky
    let g = ctx.createLinearGradient(0, 0, 0, horizon);
    g.addColorStop(0, '#030507');
    g.addColorStop(0.62, this.night ? '#0b0605' : '#07121a');
    g.addColorStop(1, this.night ? '#1a0d0a' : '#0f2229');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, horizon);

    // horizon glow
    g = ctx.createRadialGradient(w * 0.5, horizon, 0, w * 0.5, horizon, Math.max(w, h) * 0.62);
    g.addColorStop(0, this.night ? 'rgba(255,110,84,0.10)' : 'rgba(58,167,185,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // stars
    for (const st of this.stars) {
      const a = 0.08 + 0.22 * (0.5 + 0.5 * Math.sin(t * st.s + st.p));
      ctx.fillStyle = `rgba(243,239,231,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(st.x * w, st.y * h, st.r, 0, TAU);
      ctx.fill();
    }

    // hills (far, near)
    this._hills(this.hillA, horizon, h * 0.085, this.night ? '#0d0706' : '#0a151b');
    this._hills(this.hillB, horizon, h * 0.045, this.night ? '#080403' : '#060d12');

    // water
    g = ctx.createLinearGradient(0, horizon, 0, h);
    g.addColorStop(0, this.night ? '#120806' : '#0b181e');
    g.addColorStop(0.45, this.night ? '#070302' : '#060d11');
    g.addColorStop(1, '#020304');
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon, w, h - horizon);
    ctx.fillStyle = `rgba(${lume.join(',')},0.07)`;
    ctx.fillRect(0, horizon, w, 1);

    // glints (reflected sky light), denser near the horizon
    for (const gl of this.glints) {
      const depth = gl.d * gl.d;
      const y = horizon + 3 + depth * (h - horizon) * 0.9;
      const spread = 0.12 + depth * 0.9;
      const x = (this.centerX ?? w * 0.5) + gl.x * w * spread + Math.sin(t * gl.v + gl.p) * 6;
      const len = (8 + gl.l * 42) * (0.4 + depth);
      const a = (0.04 + 0.1 * (0.5 + 0.5 * Math.sin(t * 1.3 * gl.v + gl.p))) * (1 - depth * 0.7);
      ctx.fillStyle = `rgba(${this.night ? '255,150,130' : '150,215,225'},${a.toFixed(3)})`;
      ctx.fillRect(x - len / 2, y, len, 1);
    }

    // float
    const fx = this.centerX ?? w * 0.5;
    const waterY = horizon + (h - horizon) * 0.3;
    const bob = this.reduced ? 0 : Math.sin(t * 1.25) * 2.2 * s + Math.sin(t * 0.62 + 1) * 1.2 * s;
    this._ripples(fx, waterY, t, s, lume);
    this._float(fx, waterY + bob, s, ember, t);

    // mist
    g = ctx.createLinearGradient(0, horizon - h * 0.08, 0, horizon + h * 0.1);
    g.addColorStop(0, 'rgba(160,200,210,0)');
    g.addColorStop(0.5, this.night ? 'rgba(120,60,50,0.05)' : 'rgba(160,200,210,0.05)');
    g.addColorStop(1, 'rgba(160,200,210,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon - h * 0.08, w, h * 0.18);

    // vignette + dim
    g = ctx.createRadialGradient(w / 2, h * 0.46, Math.min(w, h) * 0.25, w / 2, h * 0.5, Math.max(w, h) * 0.8);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.62)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    if (this.dim > 0) {
      ctx.fillStyle = `rgba(3,5,7,${Math.min(0.94, this.dim).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  _hills(seed, horizon, amp, color) {
    const { ctx, w } = this;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    const n = seed.length;
    for (let i = 0; i <= 48; i += 1) {
      const u = i / 48;
      const k = u * (n - 1);
      const i0 = Math.floor(k);
      const f = k - i0;
      const a = seed[i0];
      const b = seed[Math.min(n - 1, i0 + 1)];
      const v = a + (b - a) * (0.5 - 0.5 * Math.cos(f * Math.PI));
      ctx.lineTo(u * w, horizon - v * amp);
    }
    ctx.lineTo(w, horizon);
    ctx.closePath();
    ctx.fill();
  }

  _ripples(x, y, t, s, lume) {
    const { ctx } = this;
    const period = 3.6;
    for (let k = 0; k < 3; k += 1) {
      const age = ((t + k * (period / 3)) % period) / period;
      const r = (14 + age * 190) * s;
      const a = Math.pow(1 - age, 1.6) * 0.55;
      ctx.lineWidth = 1.2;
      // back half (behind the float) is fainter
      ctx.strokeStyle = `rgba(${lume.join(',')},${(a * 0.45).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.16, 0, Math.PI, TAU);
      ctx.stroke();
      ctx.strokeStyle = `rgba(${lume.join(',')},${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.16, 0, 0, Math.PI);
      ctx.stroke();
    }
  }

  _float(x, waterY, s, ember, t) {
    const { ctx } = this;
    const tipTop = waterY - 132 * s;
    const collarY = waterY - 46 * s;
    const pulse = 0.85 + 0.15 * Math.sin(t * 2.1);

    // glow around the lit tip
    let g = ctx.createRadialGradient(x, tipTop + 40 * s, 0, x, tipTop + 40 * s, 70 * s);
    g.addColorStop(0, `rgba(${ember.join(',')},${(0.34 * pulse).toFixed(3)})`);
    g.addColorStop(1, `rgba(${ember.join(',')},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - 80 * s, tipTop - 40 * s, 160 * s, 170 * s);

    // tip segments
    const seg = [[0, 30], [36, 60], [66, 86]];
    seg.forEach(([a, b], i) => {
      g = ctx.createLinearGradient(0, tipTop + a * s, 0, tipTop + b * s);
      g.addColorStop(0, i === 0 ? '#ffb08a' : '#ff8a5b');
      g.addColorStop(1, `rgb(${ember.join(',')})`);
      ctx.fillStyle = g;
      this._round(x - 3.6 * s, tipTop + a * s, 7.2 * s, (b - a) * s, i === 0 ? 3.6 * s : 1.4 * s);
    });
    // collar
    ctx.fillStyle = '#e9e3d8';
    this._round(x - 6.4 * s, collarY - 1.5 * s, 12.8 * s, 5 * s, 2 * s);

    // body: above-water sliver, the rest fades into the water
    g = ctx.createLinearGradient(x - 12 * s, 0, x + 12 * s, 0);
    g.addColorStop(0, '#22303a');
    g.addColorStop(0.4, '#3d5261');
    g.addColorStop(1, '#141d24');
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - 20 * s, collarY, 40 * s, waterY - collarY + 1);
    ctx.clip();
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, waterY + 26 * s, 12 * s, 74 * s, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    // reflection: broken, squashed copy of the tip
    ctx.save();
    ctx.globalAlpha = 0.22;
    for (let i = 0; i < 7; i += 1) {
      const ry = waterY + 6 * s + i * 7 * s;
      const wob = Math.sin(t * 2.4 + i) * 2.2 * s;
      ctx.fillStyle = i < 5 ? `rgb(${ember.join(',')})` : '#e9e3d8';
      ctx.fillRect(x - 3.4 * s + wob, ry, 6.8 * s, 3.2 * s);
    }
    ctx.restore();
  }

  _round(x, y, w, h, r) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  }
}
