// motionScenarios.js — deterministic recorded sensor traces for the demo / test
// mode. Each returns samples shaped exactly like MotionSensor output
// ({ t, amag, jerk, gmag, tilt }) so the demo runs the REAL detector — there is
// no hardcoded demo alarm path.

import { MOTION } from './motionConfig.js';

// A reasonable resting baseline so the demo can arm without a live sensor.
export const DEMO_BASELINE = Object.freeze({
  accelMedian: 0.05, accelMad: 0.03, jerkMedian: 0.2, jerkMad: 0.15,
  gyroMedian: 1.0, gyroMad: 0.8, vibrationRms: 0.04, maxAmp: 0.12,
  baseTilt: 10, sampleHz: 40, dropRatio: 0, count: 240
});

export const MOTION_SCENARIOS = [
  { id: 'stable', label: '완전 안정', loop: true },
  { id: 'breeze', label: '약한 바람', loop: true },
  { id: 'wind', label: '강한 바람', loop: true },
  { id: 'pull', label: '강한 당김', loop: true },
  { id: 'tap2', label: '두 번 토독', loop: true },
  { id: 'repeated', label: '반복 입질', loop: true },
  { id: 'touch', label: '폰 만짐', loop: true },
  { id: 'fall', label: '거치대 넘어짐', loop: true },
  { id: 'selfvibe', label: '알람 진동 재입력', loop: true },
  { id: 'dropout', label: '센서 끊김', loop: false }
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bump = (t, center, width) => Math.exp(-(((t - center) / width) ** 2));

// Generate a scenario trace. Returns { samples, loop }.
export function generateScenario(id, opts = {}) {
  const hz = opts.hz ?? MOTION.TARGET_HZ;
  const dt = 1000 / hz;
  const durationMs = id === 'dropout' ? 2200 : (opts.durationMs ?? 5200);
  const n = Math.round(durationMs / dt);
  const base = 0.05;
  const baseTilt = 10;
  const rnd = mulberry32(1000 + id.length * 7);
  const samples = [];
  let prev = base;

  for (let i = 0; i < n; i += 1) {
    const t = i * dt;
    let amag = base + (rnd() - 0.5) * 0.03;
    let gmag = 1 + (rnd() - 0.5) * 0.6;
    let tilt = baseTilt + (rnd() - 0.5) * 0.4;

    switch (id) {
      case 'breeze':
        amag += 0.06 * Math.sin(t * 0.005) + 0.03 * Math.sin(t * 0.013);
        gmag += 1.5 * Math.sin(t * 0.005);
        break;
      case 'wind':
        // Normal wind jitter relative to the (calm) calibration: oscillatory and
        // non-transient, so the detector keeps it below the alarm threshold.
        amag += 0.16 * Math.sin(t * 0.006) + 0.06 * Math.sin(t * 0.013);
        gmag += 3 * Math.sin(t * 0.006);
        break;
      case 'pull':
        amag += 6 * bump(t, 2050, 55) + (t > 2100 && t < 2700 ? 0.6 : 0);
        gmag += 26 * bump(t, 2050, 60);
        break;
      case 'tap2':
        amag += 1.6 * bump(t, 2000, 30) + 1.5 * bump(t, 2240, 30);
        gmag += 8 * bump(t, 2000, 30) + 7 * bump(t, 2240, 30);
        break;
      case 'repeated':
        for (let k = 0; k < 7; k += 1) amag += 1.2 * bump(t, 2000 + k * 200, 35);
        gmag += 6 * Math.sin(t * 0.03);
        break;
      case 'touch':
        amag += 12 * bump(t, 2000, 40);
        tilt += t >= 2000 ? 20 : 0;
        gmag += 40 * bump(t, 2000, 45);
        break;
      case 'fall':
        amag += 10 * bump(t, 2000, 45);
        tilt += t >= 2000 ? Math.min(40, (t - 2000) * 0.06) : 0;
        gmag += 60 * bump(t, 2000, 60);
        break;
      case 'selfvibe': {
        // A real strong pull, then our alarm's buzz pattern (≈280ms on /120 off)
        // immediately after — must NOT re-trigger a second alarm.
        amag += 5 * bump(t, 1500, 55) + (t > 1550 && t < 2000 ? 0.6 : 0);
        gmag += 24 * bump(t, 1500, 60);
        if (t >= 1900 && t < 3200) {
          const phase = (t - 1900) % 400;
          if (phase < 280) amag += 2.2 + 0.4 * Math.sin(t * 0.4);
        }
        break;
      }
      case 'dropout':
      case 'stable':
      default:
        break;
    }

    const jerk = Math.abs(amag - prev) / (dt / 1000);
    prev = amag;
    samples.push({ t, amag: Math.max(0, amag), jerk, gmag: Math.max(0, gmag), tilt });
  }
  const meta = MOTION_SCENARIOS.find((s) => s.id === id);
  return { samples, loop: meta ? meta.loop : true };
}
