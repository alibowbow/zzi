// vibrationDetector.js — classify a short window of motion-sensor samples as a
// bite pattern. Uses TWO time windows (short for impacts/taps, long for
// sustained/repeated motion) and works in "excess over the calibrated baseline"
// so sensitivity is mounting-independent. Pure (no DOM, no timers).
//
// Sample: { t, amag, jerk, gmag, tilt }  (amag = linear-accel magnitude m/s²)

import { clamp } from './stats.js';
import { rms, countRisingEdges, countReversals, sensitivityToMad } from './motionFilter.js';
import { MOTION } from './motionConfig.js';

export function scoreToBand(score) {
  if (score >= MOTION.TRIGGER_SCORE) return 'bite';
  if (score >= MOTION.POSSIBLE_SCORE) return 'possible';
  if (score >= MOTION.WOBBLE_SCORE) return 'wobble';
  return 'stable';
}

// analyzeMotion(samples, baseline, opts) -> { score(0-100), pattern, contact, features }
export function analyzeMotion(samples, baseline, opts = {}) {
  const now = opts.now ?? (samples.length ? samples[samples.length - 1].t : 0);
  const sensitivity = clamp(opts.sensitivity ?? 5, 1, 10);
  const detectMode = opts.detectMode ?? 'all';
  const shortMs = opts.shortWindowMs ?? MOTION.SHORT_WINDOW_MS;
  const longMs = opts.longWindowMs ?? MOTION.LONG_WINDOW_MS;

  const accelMad = Math.max(baseline.accelMad ?? MOTION.CALIB_MIN_ACCEL_MAD, MOTION.CALIB_MIN_ACCEL_MAD);
  const accelMedian = baseline.accelMedian ?? 0;
  const gyroMad = Math.max(baseline.gyroMad ?? 0, 1e-3);
  const gyroMedian = baseline.gyroMedian ?? 0;
  const baseTilt = baseline.baseTilt ?? 0;

  const threshMad = sensitivityToMad(sensitivity, MOTION.SENS_MULT_MIN, MOTION.SENS_MULT_MAX);
  const peakThr = Math.max(MOTION.MIN_ABS_ACCEL, threshMad * accelMad);

  const longSamples = samples.filter((s) => s.t >= now - longMs && s.t <= now);
  const shortSamples = longSamples.filter((s) => s.t >= now - shortMs);
  const empty = { score: 0, pattern: 'none', contact: false, features: { reason: 'insufficient' } };
  if (shortSamples.length < 4) return empty;
  // Warm-up guard: until the long window is mostly full, statistics are
  // unreliable, so do not score (prevents a burst of false highs right after
  // monitoring starts).
  const longSpan = longSamples.length > 1 ? longSamples[longSamples.length - 1].t - longSamples[0].t : 0;
  if (longSpan < longMs * 0.95) return { score: 0, pattern: 'none', contact: false, features: { reason: 'warming' } };

  const shortExcess = shortSamples.map((s) => Math.max(0, s.amag - accelMedian));
  const longExcess = longSamples.map((s) => Math.max(0, s.amag - accelMedian));
  const shortSeries = shortSamples.map((s, i) => ({ t: s.t, value: shortExcess[i] }));
  const longSeries = longSamples.map((s, i) => ({ t: s.t, value: longExcess[i] }));

  // Distinct bursts (rising edges) discriminate a single pull (one burst) from
  // taps / repeated motion (several bursts); plateau noise is not over-counted.
  const shortEdges = countRisingEdges(shortSeries, peakThr, MOTION.PEAK_REFRACTORY_MS);
  const longEdges = countRisingEdges(longSeries, peakThr, MOTION.PEAK_REFRACTORY_MS);
  const maxExcessShort = shortExcess.length ? Math.max(...shortExcess) : 0;
  const absPeak = maxExcessShort + accelMedian;

  // Signed slope of accel magnitude -> direction reversals over the long window.
  const slopes = [];
  for (let i = 1; i < longSamples.length; i += 1) slopes.push(longSamples[i].amag - longSamples[i - 1].amag);
  // Band wide enough to ignore sensor noise but catch real back-and-forth.
  const reversals = countReversals(slopes, 2 * accelMad);

  const gyroPeakExcess = longSamples.reduce((m, s) => Math.max(m, (s.gmag ?? 0) - gyroMedian), 0);
  const gyroPeakMad = gyroPeakExcess / gyroMad;
  const tiltChange = shortSamples.reduce((m, s) => Math.max(m, Math.abs((s.tilt ?? 0) - baseTilt)), 0);

  // Duration above threshold (ms).
  let aboveCount = 0;
  for (let i = 0; i < longExcess.length; i += 1) if (longExcess[i] >= peakThr) aboveCount += 1;
  const spanMs = longSamples.length > 1 ? (longSamples[longSamples.length - 1].t - longSamples[0].t) : 0;
  const dt = longSamples.length > 1 ? spanMs / (longSamples.length - 1) : 25;
  const durationMs = aboveCount * dt;

  // Phone contact (a knock / re-seat) — NOT a bite.
  const contact = absPeak > MOTION.CONTACT_ACCEL || tiltChange > MOTION.CONTACT_TILT_DEG;

  // Transient (impulsive bite) vs steady (wind) energy.
  const shortRmsE = rms(shortExcess);
  const longRmsE = rms(longExcess);
  const transientRatio = shortRmsE / (longRmsE + 1e-3);
  const peakMad = maxExcessShort / accelMad;
  const ampFactor = clamp(maxExcessShort / peakThr, 0, 1.5);

  // A. Strong pull: a big peak that LEAVES a lasting change (not a lone spike).
  const strongThr = Math.max(peakThr, MOTION.STRONG_PULL_MAD * accelMad);
  const strongMag = clamp(maxExcessShort / strongThr, 0, 1.3);
  const gyroBoost = clamp(gyroPeakMad / MOTION.STRONG_PULL_GYRO_MAD, 0, 1);
  const sustain = clamp(durationMs / 400, 0, 1);
  const sustained = maxExcessShort >= peakThr && durationMs >= 150;
  const strongScore = sustained
    ? clamp(0.5 * strongMag + 0.2 * gyroBoost + 0.3 * sustain, 0, 1)
    : clamp(0.3 * strongMag, 0, 0.5); // a lone spike cannot alarm by itself

  // B. Tap (토독): ≥2 distinct bursts in the short window.
  const tapCount = shortEdges.count;
  const tapScore = tapCount >= MOTION.TAP_MIN_PEAKS
    ? clamp((tapCount / MOTION.TAP_MIN_PEAKS) * 0.6 + ampFactor * 0.4, 0, 1)
    : 0;

  // C. Repeated vibration: several distinct bursts over 1–2 s.
  const repeatedScore = longEdges.count >= MOTION.REPEATED_MIN_PEAKS
    ? clamp(0.5 * (longEdges.count / (MOTION.REPEATED_MIN_PEAKS + 1)) + 0.3 * (reversals / 5) + 0.2 * ampFactor, 0, 1)
    : 0;

  // E. Wind / steady jitter suppression: oscillatory, non-transient, modest.
  const oscillation = clamp(reversals / 6, 0, 1);
  const steady = clamp(1 - Math.max(0, transientRatio - 1), 0, 1);
  const modest = clamp(1 - (peakMad - threshMad) / (5 * threshMad), 0, 1);
  const windiness = clamp(oscillation * steady * modest, 0, 1);

  let base;
  if (detectMode === 'strong') base = Math.max(strongScore, 0.5 * tapScore, 0.4 * repeatedScore);
  else if (detectMode === 'tap') base = Math.max(tapScore, 0.5 * strongScore, 0.4 * repeatedScore);
  else if (detectMode === 'repeated') base = Math.max(repeatedScore, 0.5 * strongScore, 0.4 * tapScore);
  else base = Math.max(strongScore, tapScore, repeatedScore);
  base = clamp(base * (1 - 0.85 * windiness), 0, 1);

  // Rule-based label: many peaks over 1–2 s => repeated; a quick pair => tap;
  // otherwise a single sizeable event => strong pull.
  let pattern;
  if (contact) pattern = 'contact';
  else if (longEdges.count >= MOTION.REPEATED_MIN_PEAKS) pattern = 'repeated';
  else if (tapCount >= MOTION.TAP_MIN_PEAKS) pattern = 'tap';
  else if (base > 0.2) pattern = 'strong_pull';
  else pattern = 'none';

  // Contact never alarms; keep the gauge from flashing on a knock.
  const score = contact ? Math.round(clamp(base, 0, 0.4) * 100) : Math.round(base * 100);

  return {
    score, pattern, contact,
    features: {
      peakThr, absPeak, maxExcessShort, peakMad, transientRatio,
      shortBursts: shortEdges.count, longBursts: longEdges.count, reversals,
      gyroPeakMad, tiltChange, durationMs, windiness, strongScore, tapScore, repeatedScore
    }
  };
}

// Stateful gate: turns the per-frame score into discrete alarm events with
// confirmation, cooldown, a self-vibration mute and a contact veto. This is the
// SINGLE owner of web alarm decisions.
export class MotionAlarmGate {
  constructor() { this.reset(); }
  reset() {
    this._confirmSince = 0;
    this._cooldownUntil = 0;
    this._muteUntil = 0;
    this._lastAlarmAt = -Infinity;
  }
  muteForSelfVibration(now, ms = MOTION.SELF_VIBE_GUARD_MS) {
    this._muteUntil = Math.max(this._muteUntil, now + ms);
    this._confirmSince = 0;
  }
  isMuted(now) { return now < this._muteUntil || now < this._cooldownUntil; }
  update(score, pattern, contact, now) {
    if (contact || this.isMuted(now)) { this._confirmSince = 0; return null; }
    if (score >= MOTION.TRIGGER_SCORE) {
      if (!this._confirmSince) this._confirmSince = now;
      if (now - this._confirmSince >= MOTION.CONFIRM_MS) {
        this._confirmSince = 0;
        this._cooldownUntil = now + MOTION.COOLDOWN_MS;
        this._lastAlarmAt = now;
        return { pattern, score, at: now };
      }
    } else {
      this._confirmSince = 0;
    }
    return null;
  }
}
