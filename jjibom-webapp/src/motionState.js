// motionState.js — the vibration-mode state machine. Keeps a real bite separate
// from a phone knock (STABILIZING), an honest pause when the page is hidden
// (PAUSED), and a sensor dropout (ERROR). decideMotionTransition is pure.

import { MOTION } from './motionConfig.js';

export const MotionState = Object.freeze({
  IDLE: 'idle',
  REQUESTING_PERMISSION: 'requesting_permission',
  CALIBRATING: 'calibrating',
  ARMED: 'armed',
  POSSIBLE_BITE: 'possible_bite',
  ALARM: 'alarm',
  COOLDOWN: 'cooldown',
  STABILIZING: 'stabilizing',
  PAUSED: 'paused',
  ERROR: 'error'
});

export const MotionStateLabel = Object.freeze({
  [MotionState.IDLE]: '대기',
  [MotionState.REQUESTING_PERMISSION]: '권한 요청',
  [MotionState.CALIBRATING]: '보정 중',
  [MotionState.ARMED]: '감시 중',
  [MotionState.POSSIBLE_BITE]: '입질 가능성',
  [MotionState.ALARM]: '입질!',
  [MotionState.COOLDOWN]: '잠시 대기',
  [MotionState.STABILIZING]: '재안정화',
  [MotionState.PAUSED]: '일시 중지',
  [MotionState.ERROR]: '센서 오류'
});

const RUN = new Set([
  MotionState.ARMED, MotionState.POSSIBLE_BITE, MotionState.COOLDOWN, MotionState.STABILIZING
]);

// Pure per-frame transition for the running states. `s` is the signal bundle.
export function decideMotionTransition(state, s) {
  switch (state) {
    case MotionState.ARMED:
      if (s.sensorStalled) return MotionState.ERROR;
      if (s.hidden) return MotionState.PAUSED;
      if (s.alarmEmitted) return MotionState.ALARM;
      if (s.contact) return MotionState.STABILIZING;
      if (s.score >= MOTION.POSSIBLE_SCORE) return MotionState.POSSIBLE_BITE;
      return MotionState.ARMED;

    case MotionState.POSSIBLE_BITE:
      if (s.sensorStalled) return MotionState.ERROR;
      if (s.hidden) return MotionState.PAUSED;
      if (s.alarmEmitted) return MotionState.ALARM;
      if (s.contact) return MotionState.STABILIZING;
      if (s.score < MOTION.WOBBLE_SCORE) return MotionState.ARMED;
      return MotionState.POSSIBLE_BITE;

    case MotionState.COOLDOWN:
      if (s.hidden) return MotionState.PAUSED;
      if (s.contact) return MotionState.STABILIZING;
      if (!s.cooldownActive) return MotionState.ARMED;
      return MotionState.COOLDOWN;

    case MotionState.STABILIZING:
      if (s.sensorStalled) return MotionState.ERROR;
      if (s.hidden) return MotionState.PAUSED;
      if (!s.contact && s.stableMs >= MOTION.STABILIZE_MS) return MotionState.ARMED;
      return MotionState.STABILIZING;

    case MotionState.PAUSED:
      if (!s.hidden) return MotionState.ARMED;
      return MotionState.PAUSED;

    case MotionState.ERROR:
      if (!s.sensorStalled) return MotionState.ARMED;
      return MotionState.ERROR;

    case MotionState.ALARM:
      return MotionState.ALARM; // left via dismissAlarm() -> COOLDOWN

    default:
      return state;
  }
}

export class MotionMachine {
  constructor() {
    this.state = MotionState.IDLE;
    this.enteredAt = 0;
  }
  set(state, now) {
    if (state !== this.state) { this.state = state; this.enteredAt = now; }
  }
  timeInState(now) { return now - this.enteredAt; }
  isRunning() { return RUN.has(this.state); }

  update(signals, now) {
    if (!RUN.has(this.state)) return { state: this.state, changed: false };
    const next = decideMotionTransition(this.state, signals);
    const changed = next !== this.state;
    if (changed) { this.state = next; this.enteredAt = now; }
    return { state: this.state, changed };
  }

  // Called when the app/user dismisses an alarm.
  dismissAlarm(now) { this.set(MotionState.COOLDOWN, now); }
}
