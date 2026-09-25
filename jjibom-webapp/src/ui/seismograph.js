// seismograph.js — the live trace of the vibration mode: the bite score as a
// luminous line scrolling right-to-left over the last few seconds, the raw
// vibration as a faint trace underneath (so a calm rod still looks alive), and
// the alarm threshold as a dashed ember line.

const WINDOW_MS = 9000;

export class Seismograph {
  constructor(canvas, { trigger = 80, possible = 65 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.trigger = trigger;
    this.possible = possible;
    this.samples = [];
    this.running = false;
    this.raf = 0;
    this.last = 0;
    this.colors = { lume: '#8df5c8', amber: '#ffc46b', ember: '#ff6a3d', paper: '243,239,231' };
    this.w = 0;
    this.h = 0;
    this.resize();
  }

  setColors(colors) { Object.assign(this.colors, colors); }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  push(score, magnitude) {
    const t = performance.now();
    this.samples.push({ t, score: Math.max(0, Math.min(100, score || 0)), mag: Math.max(0, magnitude || 0) });
    const cutoff = t - WINDOW_MS - 1000;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
  }

  clear() { this.samples = []; this.draw(performance.now()); }

  start() {
    if (this.running) return;
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
    if (!this.w) this.resize();
    const { ctx, w, h, colors } = this;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    const top = h * 0.08;
    const bottom = h * 0.92;
    const yOf = (score) => bottom - (score / 100) * (bottom - top);
    const xOf = (t) => w - ((now - t) / WINDOW_MS) * w;

    // time grid: one hairline per second, drifting left with time
    ctx.strokeStyle = `rgba(${colors.paper},0.045)`;
    ctx.lineWidth = 1;
    const offset = (now % 1000) / 1000;
    for (let i = 0; i <= WINDOW_MS / 1000 + 1; i += 1) {
      const x = w - ((i + offset) * 1000 / WINDOW_MS) * w;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    }
    [0, 40].forEach((v) => {
      ctx.beginPath(); ctx.moveTo(0, yOf(v)); ctx.lineTo(w, yOf(v)); ctx.stroke();
    });

    // alarm threshold
    const ty = yOf(this.trigger);
    ctx.setLineDash([2, 6]);
    ctx.strokeStyle = colors.ember;
    ctx.globalAlpha = 0.55;
    ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(w, ty); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    const pts = this.samples.filter((s) => s.t >= now - WINDOW_MS - 400);
    if (pts.length < 2) return;

    // raw vibration, auto-scaled, faint — proof of life
    const maxMag = Math.max(0.25, ...pts.map((p) => p.mag));
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xOf(p.t);
      const y = bottom - (p.mag / maxMag) * (bottom - top) * 0.22;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = `rgba(${colors.paper},0.22)`;
    ctx.lineWidth = 1;
    ctx.stroke();

    // score line with soft fill
    const path = new Path2D();
    pts.forEach((p, i) => {
      const x = xOf(p.t);
      const y = yOf(p.score);
      if (i === 0) path.moveTo(x, y);
      else {
        const prev = pts[i - 1];
        const mx = (xOf(prev.t) + x) / 2;
        path.quadraticCurveTo(xOf(prev.t), yOf(prev.score), mx, (yOf(prev.score) + y) / 2);
      }
    });
    const lastP = pts[pts.length - 1];
    path.lineTo(xOf(lastP.t), yOf(lastP.score));

    const fill = new Path2D(path);
    fill.lineTo(xOf(lastP.t), bottom);
    fill.lineTo(xOf(pts[0].t), bottom);
    fill.closePath();
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, `${colors.lume}33`);
    g.addColorStop(1, `${colors.lume}00`);
    ctx.fillStyle = g;
    ctx.fill(fill);

    const band = (fromScore, toScore, color, glow) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, yOf(toScore), w, yOf(fromScore) - yOf(toScore));
      ctx.clip();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2;
      ctx.lineJoin = 'round';
      ctx.shadowColor = color;
      ctx.shadowBlur = glow;
      ctx.stroke(path);
      ctx.restore();
    };
    band(-5, this.possible, colors.lume, 10);
    band(this.possible, this.trigger, colors.amber, 12);
    band(this.trigger, 105, colors.ember, 16);

    // leading point
    const lx = xOf(lastP.t);
    const ly = yOf(lastP.score);
    const hot = lastP.score >= this.trigger ? colors.ember : lastP.score >= this.possible ? colors.amber : colors.lume;
    const pulse = 3 + 1.5 * (0.5 + 0.5 * Math.sin(now / 260));
    ctx.fillStyle = hot;
    ctx.shadowColor = hot;
    ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(lx, ly, pulse, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }
}
