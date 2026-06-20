// demo.js — the "virtual fishing spot". It renders to a canvas whose
// captureStream() feeds the *same* tracking/detection pipeline as a real
// camera, so the demo exercises the real code (no fake alarm path).
//
// It can reproduce each field situation the detector must handle: calm ripple,
// heavy waves, whole-frame camera shake, sink / lift / twitch bites, occlusion,
// a similar-coloured decoy object, total loss, and re-acquisition.

const WATER_Y = 322;

const ENVIRONMENTS = {
  calm: { waveAmp: 1.0, waveRough: 1.0, shake: 0, decoy: false, occlude: false, hide: false },
  waves: { waveAmp: 3.6, waveRough: 1.9, shake: 0, decoy: false, occlude: false, hide: false },
  shake: { waveAmp: 1.4, waveRough: 1.0, shake: 9, decoy: false, occlude: false, hide: false },
  decoy: { waveAmp: 1.2, waveRough: 1.0, shake: 0, decoy: true, occlude: false, hide: false },
  occlude: { waveAmp: 1.2, waveRough: 1.0, shake: 0, decoy: false, occlude: true, hide: false },
  hide: { waveAmp: 1.2, waveRough: 1.0, shake: 0, decoy: false, occlude: false, hide: true }
};

const BITE_DURATIONS = { sink: 2100, lift: 1900, twitch: 1800 };

export class DemoScene {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.token = 0;
    this.startTime = 0;
    this.env = 'calm';
    this.bite = null;
    this.reacquire = null; // { start, hideMs }
    this.onCaption = null;
  }

  start(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.startTime = performance.now();
    this._loop();
  }

  stop() {
    this.token += 1;
    this.bite = null;
    this.reacquire = null;
  }

  // name: environment (calm/waves/shake/decoy/occlude/hide), bite
  // (sink/lift/twitch), or 'reacquire'.
  setScenario(name) {
    if (ENVIRONMENTS[name]) {
      this.env = name;
      this.bite = null;
      this.reacquire = null;
      return;
    }
    if (name === 'reacquire') {
      this.reacquire = { start: performance.now(), hideMs: 1700 };
      return;
    }
    if (BITE_DURATIONS[name]) this.triggerBite(name);
  }

  triggerBite(type) {
    this.bite = { type, start: performance.now(), duration: BITE_DURATIONS[type] || 1900 };
  }

  _biteOffset(now) {
    if (!this.bite) return 0;
    const t = (now - this.bite.start) / this.bite.duration;
    if (t >= 1) { this.bite = null; return 0; }
    if (this.bite.type === 'sink') {
      if (t < 0.22) return smoothStep(t / 0.22) * 64;
      if (t < 0.56) return 64 + Math.sin(t * 52) * 2;
      return (1 - smoothStep((t - 0.56) / 0.44)) * 64;
    }
    if (this.bite.type === 'lift') {
      if (t < 0.28) return -smoothStep(t / 0.28) * 38;
      if (t < 0.58) return -38;
      return -(1 - smoothStep((t - 0.58) / 0.42)) * 38;
    }
    // twitch
    return Math.sin(t * Math.PI * 16) * 13 * Math.sin(Math.PI * t);
  }

  _loop() {
    const token = ++this.token;
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;

    const draw = (now) => {
      if (token !== this.token) return;
      const elapsed = now - this.startTime;
      const env = ENVIRONMENTS[this.env] || ENVIRONMENTS.calm;

      // Whole-frame camera shake — translate the entire scene (float included)
      // so the float moves *with* the background and motion compensation can
      // cancel it.
      let shakeX = 0;
      let shakeY = 0;
      if (env.shake) {
        shakeX = env.shake * (Math.sin(elapsed * 0.017) + 0.5 * Math.sin(elapsed * 0.043));
        shakeY = env.shake * (Math.cos(elapsed * 0.021) + 0.5 * Math.sin(elapsed * 0.037));
      }

      ctx.save();
      ctx.translate(shakeX, shakeY);
      // Overscan a little so the shake never reveals empty edges.
      ctx.fillStyle = '#0b2531';
      ctx.fillRect(-20, -20, width + 40, height + 40);

      this._drawBackground(elapsed, width, height);
      this._drawWater(elapsed, width, height, env);

      // Float visibility logic for hide / re-acquire scenarios.
      let floatVisible = !env.hide;
      if (this.reacquire) {
        const dt = now - this.reacquire.start;
        if (dt < this.reacquire.hideMs) floatVisible = false;
        else if (dt > this.reacquire.hideMs + 4000) this.reacquire = null;
      }

      const floatX = width * 0.53 + Math.sin(elapsed * 0.00035) * 1.7;
      const idle = Math.sin(elapsed * 0.0042) * 2.1 + Math.sin(elapsed * 0.009) * 0.7;
      const floatY = WATER_Y - 27 + idle + this._biteOffset(now);

      if (env.decoy) this._drawDecoy(elapsed, width);
      if (floatVisible) this._drawFloat(floatX, floatY, elapsed);

      // Water sheen over the submerged part (dims the float as it sinks).
      this._drawSurface(elapsed, width, height);

      if (env.occlude) this._drawOccluder(elapsed, width, floatX);

      ctx.restore();
      this._drawCaption(width);

      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  _drawBackground(elapsed, width, height) {
    const ctx = this.ctx;
    const sky = ctx.createLinearGradient(0, 0, 0, WATER_Y);
    sky.addColorStop(0, '#0b2531');
    sky.addColorStop(1, '#183d49');
    ctx.fillStyle = sky;
    ctx.fillRect(-20, -20, width + 40, WATER_Y + 20);

    const glow = ctx.createRadialGradient(710, 90, 5, 710, 90, 240);
    glow.addColorStop(0, 'rgba(112,211,225,.23)');
    glow.addColorStop(1, 'rgba(112,211,225,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, WATER_Y);

    ctx.fillStyle = 'rgba(5,19,27,.58)';
    ctx.beginPath();
    ctx.moveTo(0, 260);
    for (let x = 0; x <= width; x += 70) {
      const hill = 248 + Math.sin(x * 0.013) * 20 + Math.sin(x * 0.027) * 9;
      ctx.lineTo(x, hill);
    }
    ctx.lineTo(width, WATER_Y);
    ctx.lineTo(0, WATER_Y);
    ctx.fill();
  }

  _drawWater(elapsed, width, height, env) {
    const ctx = this.ctx;
    const water = ctx.createLinearGradient(0, WATER_Y, 0, height);
    water.addColorStop(0, '#0d4656');
    water.addColorStop(1, '#072a38');
    ctx.fillStyle = water;
    ctx.fillRect(-20, WATER_Y, width + 40, height - WATER_Y + 20);

    for (let row = 0; row < 13; row += 1) {
      const y = WATER_Y + 8 + row * 18;
      ctx.strokeStyle = `rgba(127, 220, 225, ${0.12 - row * 0.005})`;
      ctx.lineWidth = row % 3 === 0 ? 2 : 1;
      ctx.beginPath();
      for (let x = -20; x <= width + 20; x += 8) {
        const wave = Math.sin(x * 0.024 * env.waveRough + elapsed * 0.0016 + row * 0.85)
          * (2.2 + row * 0.08) * env.waveAmp;
        if (x === -20) ctx.moveTo(x, y + wave);
        else ctx.lineTo(x, y + wave);
      }
      ctx.stroke();
    }
  }

  _drawFloat(floatX, floatY, elapsed) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(floatX, floatY);
    ctx.rotate(Math.sin(elapsed * 0.0026) * 0.012);
    ctx.shadowColor = 'rgba(255,76,55,.72)';
    ctx.shadowBlur = 15;
    ctx.fillStyle = '#ff543d';
    ctx.fillRect(-4, -76, 8, 39);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ff6a45';
    roundRectFill(ctx, -11, -41, 22, 30, 9);
    ctx.fillStyle = '#edf9f6';
    ctx.fillRect(-11, -24, 22, 22);
    ctx.fillStyle = '#203b45';
    roundRectFill(ctx, -11, -4, 22, 33, 9);
    ctx.fillStyle = '#152e38';
    ctx.fillRect(-2, 28, 4, 24);
    ctx.restore();
  }

  // A second, similarly-coloured floating object well away from the real float.
  _drawDecoy(elapsed, width) {
    const ctx = this.ctx;
    const x = width * 0.2 + Math.sin(elapsed * 0.0006) * 4;
    const y = WATER_Y - 18 + Math.sin(elapsed * 0.005) * 2.4;
    ctx.save();
    ctx.translate(x, y);
    ctx.shadowColor = 'rgba(255,76,55,.5)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#ff543d';
    roundRectFill(ctx, -9, -22, 18, 26, 8);
    ctx.restore();
  }

  _drawSurface(elapsed, width, height) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(10,66,80,.44)';
    ctx.fillRect(-20, WATER_Y, width + 40, height - WATER_Y + 20);
    ctx.strokeStyle = 'rgba(179,238,238,.38)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= width; x += 7) {
      const wave = Math.sin(x * 0.032 + elapsed * 0.0022) * 3;
      if (x === 0) ctx.moveTo(x, WATER_Y + wave);
      else ctx.lineTo(x, WATER_Y + wave);
    }
    ctx.stroke();
  }

  // A weed/line that sweeps across and briefly hides the float.
  _drawOccluder(elapsed, width, floatX) {
    const ctx = this.ctx;
    const sweep = ((elapsed * 0.06) % (width + 240)) - 120;
    ctx.fillStyle = 'rgba(9, 26, 33, 0.96)';
    ctx.fillRect(sweep, -20, 46, WATER_Y + 30);
  }

  _drawCaption(width) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(236,250,250,.78)';
    ctx.font = '600 18px system-ui, sans-serif';
    ctx.fillText('빨간 찌 끝을 터치해보세요', 34, 45);
    ctx.fillStyle = 'rgba(236,250,250,.46)';
    ctx.font = '500 13px system-ui, sans-serif';
    ctx.fillText('아래 시나리오 버튼으로 다양한 상황을 시험할 수 있어요.', 34, 70);
  }
}

function smoothStep(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

function roundRectFill(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
  ctx.fill();
}
