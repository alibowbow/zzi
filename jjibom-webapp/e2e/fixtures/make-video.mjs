// make-video.mjs — render synthetic fishing-float scenes as .y4m files that
// Chromium can play as a fake webcam (--use-file-for-fake-video-capture).
// This lets the E2E suite drive the REAL getUserMedia -> tracking -> alarm
// path (not the canvas demo). No dependencies.
//
// Usage: node e2e/fixtures/make-video.mjs <outDir>   (writes one file per scenario)
import { openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const VIDEO = Object.freeze({ W: 480, H: 270, FPS: 15 });

// Scene timeline per scenario (seconds). Every scenario starts calm so the app
// can be pointed at the float, calibrated and armed before anything happens.
export const SCENARIOS = Object.freeze({
  // Calm water; a real bite drags the float under at 14 s.
  'calm-sink': { duration: 24, sinkAt: 14 },
  // Whole-frame camera shake at 9–13 s (must NOT alarm), then a bite at 17 s.
  shake: { duration: 26, shakeFrom: 9, shakeTo: 13, sinkAt: 17 },
  // A weed hides the float at 9–13 s (tracking loss, must NOT alarm); it
  // reappears and a bite happens at 18 s.
  occlude: { duration: 26, occludeFrom: 9, occludeTo: 13, sinkAt: 18 },
  // Calm for the whole clip — used to count false alarms over time.
  calm: { duration: 30 }
});

const smooth = (x) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };

function sinkOffset(t, t0) {
  if (t0 == null || t < t0) return 0;
  const d = t - t0;
  if (d < 0.4) return smooth(d / 0.4) * 34;
  if (d < 1.6) return 34;
  if (d < 2.5) return (1 - smooth((d - 1.6) / 0.9)) * 34;
  return 0;
}

function envelope(t, from, to) {
  if (from == null || t < from || t > to) return 0;
  return Math.min(smooth((t - from) / 0.3), smooth((to - t) / 0.3));
}

// Deterministic per-pixel noise so frames look like a (slightly noisy) sensor.
function noise(x, y, f) {
  let h = (x * 374761393 + y * 668265263 + f * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h & 255) / 255 - 0.5) * 6;
}

function sceneRGB(x, y, t, s, out) {
  const { W, H } = VIDEO;
  const waterY = Math.round(H * 0.56);
  const hillTop = waterY - 28 + 10 * Math.sin(x * 0.021) + 5 * Math.sin(x * 0.057);
  let r; let g; let b;
  if (y < hillTop - 12) {
    r = 18 + y * 0.05; g = 52 + y * 0.06; b = 66 + y * 0.05; // sky gradient
  } else if (y < waterY) {
    const tree = y < hillTop && ((x % 37) < 6 - (hillTop - y) * 0.45);
    if (tree || y >= hillTop) { r = 9; g = 33; b = 42; } else { r = 18 + y * 0.05; g = 52 + y * 0.06; b = 66 + y * 0.05; }
  } else {
    const depth = (y - waterY) / (H - waterY);
    r = 12 - depth * 6; g = 66 - depth * 18; b = 84 - depth * 20;
    if (Math.sin(x * 0.09 + t * 1.7 + y * 0.35) > 0.75) { r += 20; g += 26; b += 26; }
  }

  // Float
  const xf = W / 2;
  const top = waterY - 46 + s.bob + s.sink;
  let fr = -1; let fg = 0; let fb = 0;
  if (x >= xf - 3 && x <= xf + 3 && y >= top && y < top + 28) { fr = 235; fg = 55; fb = 40; }
  else if (x >= xf - 7 && x <= xf + 7 && y >= top + 26 && y < top + 46) { fr = 240; fg = 92; fb = 58; }
  if (fr >= 0 && s.visible) {
    if (y >= waterY) { // submerged part: mostly water colour
      r = r * 0.8 + fr * 0.2; g = g * 0.8 + fg * 0.2; b = b * 0.8 + fb * 0.2;
    } else { r = fr; g = fg; b = fb; }
  }

  // Occluder (weed) in front of the float
  if (s.occluded && x >= xf - 16 && x <= xf + 16 && y < waterY + 12) { r = 14; g = 30; b = 26; }

  out[0] = r; out[1] = g; out[2] = b;
}

export function renderScenario(name, filePath) {
  const cfg = SCENARIOS[name];
  if (!cfg) throw new Error(`unknown scenario ${name}`);
  const { W, H, FPS } = VIDEO;
  const frames = Math.round(cfg.duration * FPS);
  const fd = openSync(filePath, 'w');
  writeSync(fd, `YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`);
  const Y = Buffer.alloc(W * H);
  const U = Buffer.alloc((W / 2) * (H / 2));
  const V = Buffer.alloc((W / 2) * (H / 2));
  const Uacc = new Float32Array((W / 2) * (H / 2));
  const Vacc = new Float32Array((W / 2) * (H / 2));
  const rgb = [0, 0, 0];

  for (let f = 0; f < frames; f += 1) {
    const t = f / FPS;
    const shakeAmt = envelope(t, cfg.shakeFrom, cfg.shakeTo);
    const sx = shakeAmt * (7 * Math.sin(t * 9.1) + 3 * Math.sin(t * 23.7));
    const sy = shakeAmt * (5 * Math.cos(t * 8.3) + 2 * Math.sin(t * 19.1));
    const state = {
      bob: 1.6 * Math.sin(t * 2.1) + 0.6 * Math.sin(t * 5.3),
      sink: sinkOffset(t, cfg.sinkAt),
      visible: true,
      occluded: cfg.occludeFrom != null && t >= cfg.occludeFrom && t <= cfg.occludeTo
    };
    Uacc.fill(0); Vacc.fill(0);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        sceneRGB(Math.round(x - sx), Math.round(y - sy), t, state, rgb);
        const n = noise(x, y, f);
        const R = Math.min(255, Math.max(0, rgb[0] + n));
        const G = Math.min(255, Math.max(0, rgb[1] + n));
        const B = Math.min(255, Math.max(0, rgb[2] + n));
        Y[y * W + x] = Math.round(16 + 0.257 * R + 0.504 * G + 0.098 * B);
        const ci = (y >> 1) * (W / 2) + (x >> 1);
        Uacc[ci] += 128 - 0.148 * R - 0.291 * G + 0.439 * B;
        Vacc[ci] += 128 + 0.439 * R - 0.368 * G - 0.071 * B;
      }
    }
    for (let i = 0; i < U.length; i += 1) {
      U[i] = Math.round(Math.min(255, Math.max(0, Uacc[i] / 4)));
      V[i] = Math.round(Math.min(255, Math.max(0, Vacc[i] / 4)));
    }
    writeSync(fd, 'FRAME\n');
    writeSync(fd, Y); writeSync(fd, U); writeSync(fd, V);
  }
  closeSync(fd);
  return { frames, duration: cfg.duration };
}

if (process.argv[1] && process.argv[1].endsWith('make-video.mjs')) {
  const outDir = process.argv[2] || '.';
  mkdirSync(outDir, { recursive: true });
  for (const name of Object.keys(SCENARIOS)) {
    const file = join(outDir, `${name}.y4m`);
    const t0 = Date.now();
    const { frames } = renderScenario(name, file);
    console.log(`${name}: ${frames} frames -> ${file} (${Date.now() - t0} ms)`);
  }
}
