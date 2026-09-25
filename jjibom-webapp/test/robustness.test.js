// Regression tests for problems found by driving the real camera / sensor paths
// in a browser: camera shake, slow sensors, sensor dropouts and 토독 taps.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { alphaForDt, Ema } from '../src/motionFilter.js';
import { summarizeCalibration } from '../src/motionCalibration.js';
import { analyzeMotion, MotionAlarmGate } from '../src/vibrationDetector.js';
import { MotionMachine, MotionState } from '../src/motionState.js';
import { MOTION } from '../src/motionConfig.js';
import { estimateBackgroundMotion, frameDifference, isFrameUnstable } from '../src/motionCompensation.js';
import { analyzeBite } from '../src/biteDetector.js';
import { SHAKE } from '../src/config.js';

// --- sample-rate independence ---------------------------------------------
test('alphaForDt gives the same decay per second at 20 Hz and 60 Hz', () => {
  const decay = (hz) => {
    const e = new Ema(0);
    e.update(1);
    for (let i = 0; i < hz * 0.2; i += 1) e.update(0, alphaForDt(1000 / hz, 100));
    return e.value;
  };
  assert.ok(Math.abs(decay(20) - decay(60)) < 1e-9);
  assert.ok(Math.abs(decay(60) - Math.exp(-2)) < 1e-9, 'two time constants later ≈ e^-2');
});

function calm(hz, ms, { gapFrom = Infinity, gapTo = Infinity } = {}) {
  const out = [];
  for (let t = 0; t < ms; t += 1000 / hz) {
    if (t >= gapFrom && t < gapTo) continue;
    out.push({ t, amag: 0.05 + 0.01 * Math.sin(t / 37), jerk: 0.2, gmag: 0.5, tilt: 10 });
  }
  return out;
}

test('calibration accepts a steady 20 Hz sensor', () => {
  const out = summarizeCalibration(calm(20, 6000), { durationMs: 6000 });
  assert.equal(out.ok, true, out.reason || '');
  assert.ok(Math.abs(out.stats.sampleHz - 20) < 0.5);
  assert.ok(out.stats.dropRatio < 0.05);
});

test('calibration rejects a sensor slower than CALIB_MIN_HZ', () => {
  const out = summarizeCalibration(calm(12, 6000), { durationMs: 6000 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /느려요/);
});

test('calibration rejects a stream with a long dropout', () => {
  const out = summarizeCalibration(calm(60, 6000, { gapFrom: 1500, gapTo: 4400 }), { durationMs: 6000 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /끊겨요/);
});

test('calibration notices a stream that stopped early', () => {
  const out = summarizeCalibration(calm(60, 3000), { durationMs: 6000 });
  assert.equal(out.ok, false);
});

// --- 토독 (two quick taps) ------------------------------------------------
const BASE = { accelMedian: 0.05, accelMad: 0.01, gyroMedian: 0.5, gyroMad: 0.2, baseTilt: 10 };

function motionStream(hz, ms, burstAt = []) {
  const out = [];
  for (let t = 0; t <= ms; t += 1000 / hz) {
    let amag = 0.05 + 0.005 * Math.sin(t / 13);
    for (const b of burstAt) if (t >= b && t < b + 60) amag = 1.6;
    out.push({ t, amag, araw: amag, jerk: 0, gmag: 0.5, tilt: 10 });
  }
  return out;
}

function firstAlarm(samples) {
  const gate = new MotionAlarmGate();
  for (let i = 0; i < samples.length; i += 1) {
    const now = samples[i].t;
    const r = analyzeMotion(samples.slice(0, i + 1), BASE, { now, sensitivity: 5 });
    const ev = gate.update(r.score, r.pattern, r.contact, now);
    if (ev) return ev;
  }
  return null;
}

test('two taps 250 ms apart alarm as a tap, at 20 Hz and at 60 Hz', () => {
  for (const hz of [20, 60]) {
    const ev = firstAlarm(motionStream(hz, 3200, [2000, 2250]));
    assert.ok(ev, `alarm at ${hz} Hz`);
    assert.equal(ev.pattern, 'tap', `pattern at ${hz} Hz`);
  }
});

test('two bursts far apart are not grouped as one tap', () => {
  const samples = motionStream(40, 3400, [1700, 1700 + MOTION.TAP_MAX_GAP_MS + 200]);
  const r = analyzeMotion(samples, BASE, { now: 1700 + MOTION.TAP_MAX_GAP_MS + 260, sensitivity: 5 });
  assert.ok(r.features.tapCount < MOTION.TAP_MIN_PEAKS);
});

test('a knock is contact even when smoothing shaved its peak (raw magnitude)', () => {
  const samples = motionStream(20, 2000, []);
  const last = samples[samples.length - 1];
  last.araw = 9;   // what the sensor delivered
  last.amag = 3.5; // what the smoothed magnitude shows
  const r = analyzeMotion(samples, BASE, { now: last.t, sensitivity: 5 });
  assert.equal(r.contact, true);
});

// --- dead-end states --------------------------------------------------------
test('ERROR and PAUSED keep being evaluated so monitoring can resume', () => {
  const m = new MotionMachine();
  m.set(MotionState.ERROR, 0);
  assert.equal(m.isMonitoring(), true);
  m.update({ score: 0, contact: false, alarmEmitted: false, hidden: false, sensorStalled: false, stableMs: 9999, cooldownActive: false }, 100);
  assert.equal(m.state, MotionState.ARMED);
  m.set(MotionState.PAUSED, 200);
  assert.equal(m.isMonitoring(), true);
  m.set(MotionState.IDLE, 300);
  assert.equal(m.isMonitoring(), false);
});

// --- camera shake ------------------------------------------------------------
const W = 96;
const H = 72;
function field(x, y) {
  const noise = (((x * 13 + y * 7) % 23) + 23) % 23;
  return 128 + 50 * Math.sin(x * 0.7) + 35 * Math.sin(y * 0.9) + noise;
}
function frame(sx, sy) {
  const b = new Float32Array(W * H);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) b[y * W + x] = field(x - sx, y - sy);
  return b;
}

test('background motion is recovered beyond the old ±4 px search', () => {
  const m = estimateBackgroundMotion(frame(0, 0), frame(7, -6), W, H, null);
  assert.equal(m.dx, 7);
  assert.equal(m.dy, -6);
  assert.ok(m.confidence >= SHAKE.MIN_CONFIDENCE);
});

test('frameDifference ignores the float region and flags a jolt', () => {
  const a = frame(0, 0);
  const b = frame(0, 0);
  for (let y = 20; y < 40; y += 1) for (let x = 40; x < 60; x += 1) b[y * W + x] += 90; // "float" moved
  const excluded = frameDifference(a, b, W, H, [{ x: 40, y: 20, width: 20, height: 20 }], 2);
  assert.equal(excluded, 0);
  const jolt = frameDifference(a, frame(3, 2), W, H, [], 2);
  assert.ok(isFrameUnstable(jolt, 1.2), `jolt diff ${jolt}`);
  assert.equal(isFrameUnstable(1.5, 1.2), false);
});

// --- bite analysis window ----------------------------------------------------
test('analyzeBite ignores samples before `since` and samples taken while shaking', () => {
  const samples = [];
  for (let i = 0; i < 40; i += 1) {
    const t = i * 66;
    // A big fake "sink" early on (before re-anchoring) and while shaking.
    const early = t < 1200;
    samples.push({ t, found: true, yN: early ? 1.2 : 0, vN: 0, areaRatio: early ? 0.5 : 1, heightRatio: early ? 0.5 : 1, confidence: 0.9, shaking: false });
  }
  const now = samples[samples.length - 1].t;
  const all = analyzeBite(samples, { now, windowMs: 2600, waveMadN: 0.03, detectMode: 'balanced', sensitivity: 0.5 });
  const since = analyzeBite(samples, { now, windowMs: 2600, since: 1200, waveMadN: 0.03, detectMode: 'balanced', sensitivity: 0.5 });
  assert.ok(since.score < all.score, `since ${since.score} vs all ${all.score}`);
  const shaken = samples.map((s) => (s.t < 1200 ? { ...s, shaking: true } : s));
  const noShake = analyzeBite(shaken, { now, windowMs: 2600, waveMadN: 0.03, detectMode: 'balanced', sensitivity: 0.5 });
  assert.ok(noShake.score < all.score);
});

test('the motion alarm gate stays shut outside listening states', () => {
  const gate = new MotionAlarmGate();
  let fired = null;
  for (let t = 0; t <= 600; t += 60) fired = fired || gate.update(95, 'strong_pull', false, t, false);
  assert.equal(fired, null, 'no alarm while STABILIZING / PAUSED / ERROR');
  for (let t = 660; t <= 1200; t += 60) fired = fired || gate.update(95, 'strong_pull', false, t, true);
  assert.ok(fired, 'fires once listening again');
  const m = new MotionMachine();
  m.set(MotionState.STABILIZING, 0);
  assert.equal(m.isListening(), false);
  m.set(MotionState.POSSIBLE_BITE, 0);
  assert.equal(m.isListening(), true);
});

test('stopping the alarm ends the long self-vibration mute early', () => {
  const gate = new MotionAlarmGate();
  gate.muteForSelfVibration(0, 21300); // whole alarm duration
  assert.equal(gate.isMuted(10000), true);
  gate.endSelfVibration(2000, 400); // user stopped it at 2 s
  assert.equal(gate.isMuted(2300), true, 'trailing buzz still ignored');
  assert.equal(gate.isMuted(2500), false, 'listening again');
});
