import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideMotionTransition, MotionState, MotionMachine } from '../src/motionState.js';
import { MOTION } from '../src/motionConfig.js';

function sig(extra = {}) {
  return Object.assign({
    score: 0, contact: false, alarmEmitted: false, hidden: false,
    sensorStalled: false, stableMs: 9999, cooldownActive: false
  }, extra);
}

test('ARMED transitions', () => {
  assert.equal(decideMotionTransition(MotionState.ARMED, sig({ sensorStalled: true })), MotionState.ERROR);
  assert.equal(decideMotionTransition(MotionState.ARMED, sig({ hidden: true })), MotionState.PAUSED);
  assert.equal(decideMotionTransition(MotionState.ARMED, sig({ contact: true })), MotionState.STABILIZING);
  assert.equal(decideMotionTransition(MotionState.ARMED, sig({ alarmEmitted: true })), MotionState.ALARM);
  assert.equal(decideMotionTransition(MotionState.ARMED, sig({ score: MOTION.POSSIBLE_SCORE })), MotionState.POSSIBLE_BITE);
  assert.equal(decideMotionTransition(MotionState.ARMED, sig({ score: 10 })), MotionState.ARMED);
});

test('a phone knock goes to STABILIZING, not ALARM', () => {
  // contact is true and (because the gate vetoes contact) alarmEmitted is false
  const next = decideMotionTransition(MotionState.ARMED, sig({ contact: true, alarmEmitted: false, score: 30 }));
  assert.equal(next, MotionState.STABILIZING);
});

test('STABILIZING returns to ARMED only after it settles', () => {
  assert.equal(decideMotionTransition(MotionState.STABILIZING, sig({ contact: false, stableMs: 100 })), MotionState.STABILIZING);
  assert.equal(decideMotionTransition(MotionState.STABILIZING, sig({ contact: false, stableMs: MOTION.STABILIZE_MS + 1 })), MotionState.ARMED);
});

test('POSSIBLE_BITE falls back to ARMED when the score drops', () => {
  assert.equal(decideMotionTransition(MotionState.POSSIBLE_BITE, sig({ score: 10 })), MotionState.ARMED);
  assert.equal(decideMotionTransition(MotionState.POSSIBLE_BITE, sig({ score: 70 })), MotionState.POSSIBLE_BITE);
});

test('COOLDOWN / PAUSED / ERROR recover correctly', () => {
  assert.equal(decideMotionTransition(MotionState.COOLDOWN, sig({ cooldownActive: false })), MotionState.ARMED);
  assert.equal(decideMotionTransition(MotionState.COOLDOWN, sig({ cooldownActive: true })), MotionState.COOLDOWN);
  assert.equal(decideMotionTransition(MotionState.PAUSED, sig({ hidden: false })), MotionState.ARMED);
  assert.equal(decideMotionTransition(MotionState.PAUSED, sig({ hidden: true })), MotionState.PAUSED);
  assert.equal(decideMotionTransition(MotionState.ERROR, sig({ sensorStalled: false })), MotionState.ARMED);
});

test('a sensor stall during monitoring becomes ERROR', () => {
  const m = new MotionMachine();
  m.set(MotionState.ARMED, 0);
  m.update(sig({ sensorStalled: true }), 100);
  assert.equal(m.state, MotionState.ERROR);
});

test('MotionMachine.update only runs in running states', () => {
  const m = new MotionMachine();
  m.set(MotionState.IDLE, 0);
  const r = m.update(sig({ score: 99, alarmEmitted: true }), 100);
  assert.equal(r.changed, false);
  assert.equal(m.state, MotionState.IDLE);
});

test('dismissAlarm moves ALARM -> COOLDOWN', () => {
  const m = new MotionMachine();
  m.set(MotionState.ALARM, 0);
  m.dismissAlarm(100);
  assert.equal(m.state, MotionState.COOLDOWN);
});
