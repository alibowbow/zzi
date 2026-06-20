// biteDetector.js — classify a short window of motion as a bite pattern.
//
// Consumes *normalized* samples (positions / velocities already divided by the
// calibrated float height, and already camera-shake corrected). Working in
// float-height units keeps sensitivity stable across zoom and resolution.
//
// Sample shape: { t, found, yN, vN, areaRatio, heightRatio, confidence, shaking }
//   yN  > 0  => float is below its baseline (sinking)
//   vN  > 0  => moving downward (float-heights per second)
//
// Pure: no DOM, no timers.

import { clamp, lerp, mean } from './stats.js';
import { BITE } from './config.js';

// Count sign reversals in a velocity series, ignoring jitter below `threshold`.
export function countReversals(values, threshold) {
  let reversals = 0;
  let lastDir = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (Math.abs(v) < threshold) continue;
    const dir = Math.sign(v);
    if (lastDir !== 0 && dir !== lastDir) reversals += 1;
    lastDir = dir;
  }
  return reversals;
}

// Analyze the window ending at `now`. Returns { score, type, features }.
export function analyzeBite(samples, options = {}) {
  const windowMs = options.windowMs ?? BITE.WINDOW_MS;
  const now = options.now ?? (samples.length ? samples[samples.length - 1].t : 0);
  const waveMadN = Math.max(options.waveMadN ?? 0.05, 0.02);
  const detectMode = options.detectMode ?? 'balanced';
  const sensitivity = clamp(options.sensitivity ?? 0.5, 0, 1); // 0 = dull, 1 = sensitive

  const windowed = samples.filter((s) => s.t >= now - windowMs);
  const found = windowed.filter((s) => s.found);
  const empty = { score: 0, type: 'none', features: { reason: 'insufficient' } };
  if (found.length < 3) return empty;

  const ys = found.map((s) => s.yN);
  const vs = found.map((s) => s.vN);
  const recentY = mean(ys.slice(-3));
  const peakDown = Math.max(0, ...ys);
  const peakUp = Math.max(0, ...ys.map((y) => -y));
  const amplitude = Math.max(...ys) - Math.min(...ys);
  const peakSpeedDown = Math.max(0, ...vs);
  const peakSpeedUp = Math.max(0, ...vs.map((v) => -v));
  const areaRatios = found.map((s) => s.areaRatio).filter((r) => r > 0);
  const heightRatios = found.map((s) => s.heightRatio).filter((r) => r > 0);
  const areaDrop = areaRatios.length ? clamp(1 - Math.min(...areaRatios), 0, 1) : 0;
  const heightDrop = heightRatios.length ? clamp(1 - Math.min(...heightRatios), 0, 1) : 0;
  const meanConf = mean(found.map((s) => s.confidence));
  const shakeFrac = windowed.length ? windowed.filter((s) => s.shaking).length / windowed.length : 0;

  // Sensitivity scales how much movement is required: higher sensitivity =>
  // smaller denominators => easier to trigger.
  const demand = lerp(1.6, 0.6, sensitivity);
  const speedDemand = BITE.SPEED_NORM * demand;
  const noiseRef = 3 * waveMadN; // movements within ~3 wave-MADs are normal ripple

  // --- Sink: sustained downward travel, reinforced by area/height shrink -----
  const sinkDenom = Math.max(BITE.SINK_DISP_NORM * demand, noiseRef);
  const sinkTravel = Math.max(peakDown, recentY);
  const sinkDisp = clamp(sinkTravel / sinkDenom, 0, 1.3);
  const sinkSpeed = clamp(peakSpeedDown / speedDemand, 0, 1.3);
  const sinkShrink = clamp(Math.max(areaDrop, heightDrop) / BITE.SINK_AREA_DROP, 0, 1.3);
  let sinkScore = clamp(0.55 * sinkDisp + 0.25 * sinkSpeed + 0.2 * sinkShrink, 0, 1);
  // A speed spike alone (no real displacement and no shrink) is not a sink.
  if (sinkTravel < 0.4 * sinkDenom && sinkShrink < 0.4) sinkScore *= 0.4;

  // --- Lift: sustained upward travel ---------------------------------------
  const liftDenom = Math.max(BITE.LIFT_DISP_NORM * demand, noiseRef);
  const liftDisp = clamp(peakUp / liftDenom, 0, 1.3);
  const liftSpeed = clamp(peakSpeedUp / speedDemand, 0, 1.3);
  let liftScore = clamp(0.6 * liftDisp + 0.4 * liftSpeed, 0, 1);
  if (peakUp < 0.4 * liftDenom) liftScore *= 0.5;

  // --- Twitch: several quick reversals with more-than-ripple amplitude -------
  const ampDenom = Math.max(BITE.TWITCH_AMP_NORM * demand, noiseRef);
  const reversals = countReversals(vs, speedDemand * 0.18);
  const reversalScore = clamp(reversals / BITE.TWITCH_MIN_REVERSALS, 0, 1.3);
  const ampScore = clamp(amplitude / ampDenom, 0, 1.3);

  // --- Wave / wind: regular oscillation around the baseline => suppress ------
  // Steady when it oscillates (reversals) but barely drifts from baseline and
  // the amplitude is only a small multiple of the normal ripple.
  const drift = amplitude > 1e-3 ? clamp(1 - Math.abs(recentY) / amplitude, 0, 1) : 0;
  const rippleSized = clamp(1 - amplitude / (6 * waveMadN), 0, 1);
  const waveSteady = reversals >= 2 ? clamp(0.5 * drift + 0.5 * rippleSized, 0, 1) : rippleSized * 0.5;

  let twitchScore = clamp(0.5 * reversalScore + 0.5 * ampScore, 0, 1);
  twitchScore = clamp(twitchScore * (1 - 0.7 * waveSteady), 0, 1);

  // --- Combine by detection mode -------------------------------------------
  let base;
  if (detectMode === 'sink') base = Math.max(sinkScore, 0.5 * liftScore, 0.4 * twitchScore);
  else if (detectMode === 'lift') base = Math.max(liftScore, 0.5 * sinkScore, 0.4 * twitchScore);
  else if (detectMode === 'twitch') base = Math.max(twitchScore, 0.5 * sinkScore, 0.4 * liftScore);
  else base = Math.max(sinkScore, liftScore, twitchScore);

  // Type is the strongest *raw* pattern, independent of the mode weighting.
  const raw = [['sink', sinkScore], ['lift', liftScore], ['twitch', twitchScore]];
  raw.sort((a, b) => b[1] - a[1]);
  const type = raw[0][1] > 0.15 ? raw[0][0] : 'none';

  // Low tracking confidence and active camera shake both reduce trust.
  const confGate = clamp(0.5 + 0.5 * meanConf, 0, 1);
  const shakeGate = clamp(1 - 0.8 * shakeFrac, 0.2, 1);
  const score = clamp(base * confGate * shakeGate, 0, 1);

  return {
    score,
    type,
    features: {
      sinkScore,
      liftScore,
      twitchScore,
      waveSteady,
      peakDown,
      peakUp,
      amplitude,
      reversals,
      areaDrop,
      heightDrop,
      meanConf,
      shakeFrac
    }
  };
}

// Stateful gate: turns a stream of per-frame bite scores into discrete alarm
// events with confirmation, debounce and cooldown.
export class AlarmGate {
  constructor() {
    this.reset();
  }

  reset() {
    this._confirm = 0;
    this._lastAlarmAt = -Infinity;
    this._cooldownUntil = 0;
  }

  // Returns an event object when an alarm should fire, otherwise null.
  // `gateOpen` lets callers veto (e.g. while LOST or shaking).
  update(score, type, now, gateOpen = true) {
    if (now < this._cooldownUntil || !gateOpen) {
      this._confirm = 0;
      return null;
    }
    if (score >= BITE.TRIGGER_SCORE) {
      this._confirm += 1;
    } else {
      this._confirm = Math.max(0, this._confirm - 1);
    }
    if (this._confirm >= BITE.CONFIRM_FRAMES && now - this._lastAlarmAt >= BITE.DEBOUNCE_MS) {
      this._confirm = 0;
      this._lastAlarmAt = now;
      this._cooldownUntil = now + BITE.COOLDOWN_MS;
      return { type, score, at: now };
    }
    return null;
  }
}
