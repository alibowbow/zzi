import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeBite, AlarmGate, countReversals } from '../src/biteDetector.js';
import { BITE } from '../src/config.js';

const DT = 66;

function build(n, fn) {
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    samples.push(Object.assign({
      t: i * DT, found: true, yN: 0, vN: 0, areaRatio: 1, heightRatio: 1, confidence: 0.9, shaking: false
    }, fn(i, n)));
  }
  return samples;
}

function opts(extra = {}) {
  return Object.assign({ now: undefined, waveMadN: 0.03, detectMode: 'balanced', sensitivity: 0.5 }, extra);
}

test('countReversals ignores sub-threshold jitter', () => {
  assert.equal(countReversals([1, -1, 1, -1], 0.5), 3);
  assert.equal(countReversals([0.1, -0.1, 0.1], 0.5), 0);
});

test('a sustained sink (down + shrink) scores as a bite of type "sink"', () => {
  const n = 24;
  const samples = build(n, (i) => {
    if (i < 6) return {};
    const p = Math.min(1, (i - 6) / 12);
    return { yN: 0.85 * p, vN: i < 18 ? 0.7 : 0.1, areaRatio: 1 - 0.35 * p, heightRatio: 1 - 0.3 * p };
  });
  const result = analyzeBite(samples, opts({ now: (n - 1) * DT }));
  assert.equal(result.type, 'sink');
  assert.ok(result.score > 0.6, `expected high sink score, got ${result.score}`);
});

test('a brief detection gap is NOT a bite', () => {
  const n = 24;
  const samples = build(n, (i) => {
    if (i >= 20) return { found: false }; // last few frames missing
    return { yN: 0.01 * Math.sin(i), vN: 0.03 };
  });
  const result = analyzeBite(samples, opts({ now: (n - 1) * DT }));
  assert.ok(result.score < 0.45, `lost tracking must not score as a bite, got ${result.score}`);
});

test('gentle waves stay below the trigger', () => {
  const n = 24;
  const samples = build(n, (i) => ({ yN: 0.05 * Math.sin(i * 0.8), vN: 0.2 * Math.cos(i * 0.8) }));
  const result = analyzeBite(samples, opts({ now: (n - 1) * DT }));
  assert.ok(result.score < 0.45, `waves must stay calm, got ${result.score}`);
});

test('repeated twitches are classified as "twitch"', () => {
  const n = 24;
  const samples = build(n, (i) => ({ yN: (i % 2 ? 0.3 : -0.3), vN: (i % 2 ? 1.0 : -1.0) }));
  const result = analyzeBite(samples, opts({ now: (n - 1) * DT }));
  assert.equal(result.type, 'twitch');
  assert.ok(result.score > 0.5, `expected a clear twitch, got ${result.score}`);
});

test('AlarmGate fires once after confirmation, then stays silent during cooldown', () => {
  const gate = new AlarmGate();
  const fired = [];
  for (let i = 0; i < BITE.CONFIRM_FRAMES; i += 1) {
    fired.push(gate.update(0.9, 'sink', 1000 + i * DT, true));
  }
  // exactly one of the confirmation frames returns the event
  const events = fired.filter(Boolean);
  assert.equal(events.length, 1);
  // immediately after, cooldown suppresses repeats for the same bite
  assert.equal(gate.update(0.95, 'sink', 1000 + BITE.CONFIRM_FRAMES * DT, true), null);
});

test('AlarmGate never fires while the gate is closed (shaking / lost)', () => {
  const gate = new AlarmGate();
  let any = null;
  for (let i = 0; i < 10; i += 1) any = any || gate.update(0.99, 'sink', 2000 + i * DT, false);
  assert.equal(any, null);
});
