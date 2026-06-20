// trackingState.js — the tracking state machine.
//
// Its whole reason for existing is to keep "the float dipped" (a bite) separate
// from "we briefly lost the float" (a tracking failure). A short detection gap
// never becomes an alarm; only motion that we actually observed does.
//
// decideTransition() and alarmGateOpen() are pure so the rules can be tested.

import { TRACK, CONFIDENCE, BITE } from './config.js';

export const TrackState = Object.freeze({
  IDLE: 'idle',
  SELECTED: 'selected',
  CALIBRATING: 'calibrating',
  TRACKING: 'tracking',
  POSSIBLE_BITE: 'possible_bite',
  LOST: 'lost',
  ALARM: 'alarm',
  RECOVERING: 'recovering'
});

export const TrackMessage = Object.freeze({
  lost: '찌를 놓쳤어요. 화면과 조명을 확인해 주세요.',
  recovering: '찌를 다시 찾고 있어요…',
  tracking: '찌를 다시 추적하고 있어요.',
  possible: '큰 움직임을 살펴보는 중…',
  bite: '입질이 감지됐어요!'
});

const ACTIVE = new Set([TrackState.TRACKING, TrackState.POSSIBLE_BITE, TrackState.RECOVERING]);

// Whether an alarm is allowed to fire this frame. This is the core guard:
//  - never while shaking (camera/mount moved)
//  - never while LOST/RECOVERING/IDLE
//  - while the float is visible: require a minimum confidence
//  - while briefly missing: only if a sink trajectory preceded the gap, so a
//    plain disappearance cannot ring the alarm
export function alarmGateOpen(state, s) {
  if (state !== TrackState.TRACKING && state !== TrackState.POSSIBLE_BITE) return false;
  if (s.shaking) return false;
  if (s.found) return s.confidence >= CONFIDENCE.LOW;
  return Boolean(s.sinkTrajectory);
}

// Pure transition. `s` is the per-frame signal bundle (see app for producers).
export function decideTransition(state, s) {
  const triggerLow = BITE.TRIGGER_SCORE * 0.7;

  if (s.alarmEmitted && ACTIVE.has(state)) {
    return { state: TrackState.ALARM, message: TrackMessage.bite };
  }

  switch (state) {
    case TrackState.TRACKING:
      if (!s.found) {
        if (s.lostMs >= TRACK.LOST_GRACE_MS) return { state: TrackState.LOST, message: TrackMessage.lost };
        return { state: TrackState.TRACKING };
      }
      if (s.lowConfMs >= CONFIDENCE.UNSTABLE_MS) return { state: TrackState.LOST, message: TrackMessage.lost };
      if (s.biteScore >= BITE.TRIGGER_SCORE && !s.shaking && s.confidence >= CONFIDENCE.LOW) {
        return { state: TrackState.POSSIBLE_BITE, message: TrackMessage.possible };
      }
      return { state: TrackState.TRACKING };

    case TrackState.POSSIBLE_BITE:
      if (!s.found) {
        // A sink that is dragging the float under: keep waiting for the gate to
        // confirm, but only for a little while.
        if (s.sinkTrajectory && s.lostMs < TRACK.LOST_GRACE_MS * 1.8) return { state: TrackState.POSSIBLE_BITE };
        if (s.lostMs >= TRACK.LOST_GRACE_MS) return { state: TrackState.LOST, message: TrackMessage.lost };
        return { state: TrackState.POSSIBLE_BITE };
      }
      if (s.biteScore < triggerLow) return { state: TrackState.TRACKING };
      return { state: TrackState.POSSIBLE_BITE };

    case TrackState.LOST:
      if (s.found && s.reacquireOk) return { state: TrackState.RECOVERING, message: TrackMessage.recovering };
      return { state: TrackState.LOST };

    case TrackState.RECOVERING:
      if (!s.found) return { state: TrackState.LOST, message: TrackMessage.lost };
      if (s.stableFrames >= TRACK.RECOVER_FRAMES) return { state: TrackState.TRACKING, message: TrackMessage.tracking };
      return { state: TrackState.RECOVERING };

    case TrackState.ALARM:
      return { state: TrackState.ALARM }; // left only via resume()

    default:
      return { state };
  }
}

// Thin stateful wrapper: tracks the current state and time-in-state, and exposes
// explicit setters for the app-driven phases (calibration / alarm lifecycle).
export class TrackingMachine {
  constructor() {
    this.state = TrackState.IDLE;
    this.enteredAt = 0;
    this.lastMessage = null;
  }

  set(state, now) {
    if (state !== this.state) {
      this.state = state;
      this.enteredAt = now;
    }
  }

  timeInState(now) {
    return now - this.enteredAt;
  }

  // Run one per-frame transition. Returns { state, message, changed }.
  update(signals, now) {
    const prev = this.state;
    const result = decideTransition(prev, signals);
    const changed = result.state !== prev;
    if (changed) {
      this.state = result.state;
      this.enteredAt = now;
    }
    this.lastMessage = result.message ?? null;
    return { state: this.state, message: result.message ?? null, changed };
  }

  // Called when the user (or timeout) dismisses an alarm.
  resume(found, now) {
    this.set(found ? TrackState.TRACKING : TrackState.LOST, now);
  }
}
