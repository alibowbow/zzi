import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideTransition, alarmGateOpen, TrackState, TrackingMachine } from '../src/trackingState.js';
import { TRACK, CONFIDENCE } from '../src/config.js';

function sig(extra = {}) {
  return Object.assign({
    found: true, confidence: 0.8, shaking: false, lostMs: 0, lowConfMs: 0,
    biteScore: 0, sinkTrajectory: false, reacquireOk: false, stableFrames: 0, alarmEmitted: false
  }, extra);
}

test('a brief detection gap keeps TRACKING (never alarms)', () => {
  const next = decideTransition(TrackState.TRACKING, sig({ found: false, lostMs: 120 }));
  assert.equal(next.state, TrackState.TRACKING);
});

test('a long gap becomes LOST with a helpful message', () => {
  const next = decideTransition(TrackState.TRACKING, sig({ found: false, lostMs: TRACK.LOST_GRACE_MS + 50 }));
  assert.equal(next.state, TrackState.LOST);
  assert.match(next.message, /놓쳤/);
});

test('a confident bite score moves TRACKING -> POSSIBLE_BITE', () => {
  const next = decideTransition(TrackState.TRACKING, sig({ biteScore: 0.9 }));
  assert.equal(next.state, TrackState.POSSIBLE_BITE);
});

test('camera shake does NOT advance toward a bite', () => {
  const next = decideTransition(TrackState.TRACKING, sig({ biteScore: 0.9, shaking: true }));
  assert.equal(next.state, TrackState.TRACKING);
  assert.equal(alarmGateOpen(TrackState.TRACKING, sig({ biteScore: 0.9, shaking: true })), false);
});

test('sustained low confidence eventually becomes LOST', () => {
  const next = decideTransition(TrackState.TRACKING, sig({ confidence: 0.2, lowConfMs: CONFIDENCE.UNSTABLE_MS + 100 }));
  assert.equal(next.state, TrackState.LOST);
});

test('only an emitted alarm reaches the ALARM state', () => {
  const withFlag = decideTransition(TrackState.TRACKING, sig({ alarmEmitted: true }));
  assert.equal(withFlag.state, TrackState.ALARM);
  // high score + loss but no emitted alarm must not jump to ALARM
  const noFlag = decideTransition(TrackState.POSSIBLE_BITE, sig({ found: false, lostMs: 100, biteScore: 0.95 }));
  assert.notEqual(noFlag.state, TrackState.ALARM);
});

test('LOST recovers to RECOVERING then back to TRACKING when stable', () => {
  const recovering = decideTransition(TrackState.LOST, sig({ reacquireOk: true }));
  assert.equal(recovering.state, TrackState.RECOVERING);
  const tracking = decideTransition(TrackState.RECOVERING, sig({ stableFrames: TRACK.RECOVER_FRAMES }));
  assert.equal(tracking.state, TrackState.TRACKING);
  const relost = decideTransition(TrackState.RECOVERING, sig({ found: false, lostMs: 50 }));
  assert.equal(relost.state, TrackState.LOST);
});

test('alarmGateOpen rules', () => {
  assert.equal(alarmGateOpen(TrackState.TRACKING, sig({ found: true, confidence: 0.8 })), true);
  assert.equal(alarmGateOpen(TrackState.TRACKING, sig({ found: true, confidence: 0.1 })), false);
  assert.equal(alarmGateOpen(TrackState.TRACKING, sig({ found: false, sinkTrajectory: true })), true);
  assert.equal(alarmGateOpen(TrackState.TRACKING, sig({ found: false, sinkTrajectory: false })), false);
  assert.equal(alarmGateOpen(TrackState.LOST, sig({ found: true, confidence: 0.9 })), false);
});

test('TrackingMachine integrates transitions and resume()', () => {
  const machine = new TrackingMachine();
  machine.set(TrackState.TRACKING, 0);
  machine.update(sig({ found: false, lostMs: 100 }), 100);
  assert.equal(machine.state, TrackState.TRACKING);
  machine.update(sig({ alarmEmitted: true }), 200);
  assert.equal(machine.state, TrackState.ALARM);
  machine.resume(true, 300);
  assert.equal(machine.state, TrackState.TRACKING);
});
