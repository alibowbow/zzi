import { test } from 'node:test';
import assert from 'node:assert/strict';

import { magnitude3, GravityFilter, Ema, sensitivityToMad, countReversals } from '../src/motionFilter.js';
import { summarizeCalibration } from '../src/motionCalibration.js';
import { analyzeMotion, MotionAlarmGate, scoreToBand } from '../src/vibrationDetector.js';
import { generateScenario, DEMO_BASELINE } from '../src/motionScenarios.js';
import { MOTION } from '../src/motionConfig.js';

const samplesOf = (id) => generateScenario(id).samples;

// --- filters --------------------------------------------------------------
test('magnitude3 computes the vector length', () => {
  assert.equal(magnitude3(3, 4, 0), 5);
  assert.ok(Math.abs(magnitude3(1, 2, 2) - 3) < 1e-9);
});

test('GravityFilter removes a constant gravity but keeps a sudden change', () => {
  const g = new GravityFilter(0.1);
  for (let i = 0; i < 200; i += 1) g.update(0, 0, 9.81); // settle on gravity
  const still = g.update(0, 0, 9.81);
  assert.ok(Math.abs(still.lz) < 0.2, 'a still phone has ~0 linear accel');
  const moved = g.update(3, 0, 9.81); // sudden lateral motion
  assert.ok(moved.lx > 2.5, 'a sudden push shows up as linear accel');
});

test('Ema smooths toward the input', () => {
  const e = new Ema(0.5);
  assert.equal(e.update(10), 10);
  assert.equal(e.update(0), 5);
  assert.equal(e.update(0), 2.5);
});

test('sensitivity maps to a decreasing MAD multiplier', () => {
  const dull = sensitivityToMad(1, MOTION.SENS_MULT_MIN, MOTION.SENS_MULT_MAX);
  const mid = sensitivityToMad(5, MOTION.SENS_MULT_MIN, MOTION.SENS_MULT_MAX);
  const sharp = sensitivityToMad(10, MOTION.SENS_MULT_MIN, MOTION.SENS_MULT_MAX);
  assert.ok(dull > mid && mid > sharp, 'higher sensitivity => lower threshold');
  assert.ok(Math.abs(sharp - MOTION.SENS_MULT_MIN) < 1e-9);
});

test('countReversals ignores jitter below the band', () => {
  assert.equal(countReversals([1, -1, 1, -1], 0.5), 3);
  assert.equal(countReversals([0.1, -0.1, 0.1], 0.5), 0);
});

// --- calibration ----------------------------------------------------------
test('calibration succeeds on a still rod', () => {
  const out = summarizeCalibration(samplesOf('stable'), { durationMs: 5200, targetHz: MOTION.TARGET_HZ });
  assert.equal(out.ok, true, out.reason || '');
  assert.ok(out.stats.accelMad >= MOTION.CALIB_MIN_ACCEL_MAD);
});

test('calibration fails when the phone is being moved', () => {
  const noisy = [];
  for (let i = 0; i < 240; i += 1) noisy.push({ t: i * 25, amag: (i % 2 ? 0 : 3), jerk: 0, gmag: 1, tilt: 10 });
  const out = summarizeCalibration(noisy, { durationMs: 6000, targetHz: 40 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /움직이|고정/);
});

test('calibration fails when the rod is touched (spike)', () => {
  const out = summarizeCalibration(samplesOf('touch'), { durationMs: 5200, targetHz: MOTION.TARGET_HZ });
  assert.equal(out.ok, false);
  assert.match(out.reason, /건드리|고정/);
});

test('calibration fails with too little sensor data', () => {
  const out = summarizeCalibration([{ t: 0, amag: 0.05, jerk: 0, gmag: 1, tilt: 10 }], {});
  assert.equal(out.ok, false);
  assert.match(out.reason, /센서/);
});

// --- detection ------------------------------------------------------------
const analyzeAt = (id, now, extra = {}) =>
  analyzeMotion(samplesOf(id), DEMO_BASELINE, Object.assign({ now, sensitivity: 5 }, extra));

test('a still rod scores in the stable band', () => {
  const r = analyzeAt('stable', 3000);
  assert.ok(r.score < MOTION.WOBBLE_SCORE, `stable should be quiet, got ${r.score}`);
  assert.equal(scoreToBand(r.score), 'stable');
});

test('a single small shake is NOT an alarm', () => {
  const samples = [];
  for (let i = 0; i < 80; i += 1) {
    const t = i * 25;
    let amag = 0.05;
    if (i === 60) amag = 0.55; // one isolated bump
    samples.push({ t, amag, jerk: 0, gmag: 1, tilt: 10 });
  }
  const r = analyzeMotion(samples, DEMO_BASELINE, { now: 79 * 25, sensitivity: 5 });
  assert.ok(r.score < MOTION.TRIGGER_SCORE, `a lone bump must not trigger, got ${r.score}`);
});

test('a strong pull is detected as "strong_pull"', () => {
  const r = analyzeAt('pull', 2300);
  assert.equal(r.pattern, 'strong_pull');
  assert.ok(r.score >= MOTION.TRIGGER_SCORE, `expected an alarm-level score, got ${r.score}`);
});

test('two taps are detected and can be labelled "tap"', () => {
  // Triggers across the burst...
  assert.ok(analyzeAt('tap2', 2300).score >= MOTION.TRIGGER_SCORE, 'tap2 should trigger');
  // ...and is labelled a tap when both peaks are in the short window.
  assert.equal(analyzeAt('tap2', 2250).pattern, 'tap');
});

test('repeated vibration triggers an alarm and is labelled "repeated"', () => {
  const r = analyzeAt('repeated', 3000);
  assert.ok(r.score >= MOTION.TRIGGER_SCORE, `expected repeated to trigger, got ${r.score}`);
  assert.equal(r.pattern, 'repeated');
});

test('wind is suppressed below the trigger', () => {
  const r = analyzeAt('wind', 3000);
  assert.ok(r.score < MOTION.TRIGGER_SCORE, `wind must not alarm, got ${r.score}`);
});

test('touching the phone is flagged as contact (not a bite)', () => {
  const r = analyzeAt('touch', 2100);
  assert.equal(r.contact, true);
  assert.ok(r.score < MOTION.POSSIBLE_SCORE, `contact should not look like a bite, got ${r.score}`);
});

// --- alarm gate -----------------------------------------------------------
test('AlarmGate confirms then cools down (no duplicate alarms)', () => {
  const gate = new MotionAlarmGate();
  let t = 1000;
  let fired = 0;
  let first = null;
  for (let i = 0; i < 12; i += 1) { // hold a high score
    const e = gate.update(90, 'strong_pull', false, t);
    if (e) { fired += 1; first = first || e; }
    t += 60;
  }
  assert.equal(fired, 1, 'exactly one alarm for a sustained bite');
  // still in cooldown right after
  assert.equal(gate.update(95, 'strong_pull', false, t), null);
});

test('our own alarm vibration is muted (not re-detected)', () => {
  const gate = new MotionAlarmGate();
  gate.muteForSelfVibration(1000);
  let any = null;
  for (let i = 0; i < 15; i += 1) any = any || gate.update(99, 'strong_pull', false, 1000 + i * 60);
  assert.equal(any, null, 'no alarm while muted by our own vibration');
});

test('contact vetoes the alarm gate', () => {
  const gate = new MotionAlarmGate();
  let any = null;
  for (let i = 0; i < 10; i += 1) any = any || gate.update(99, 'contact', true, 5000 + i * 60);
  assert.equal(any, null);
});
