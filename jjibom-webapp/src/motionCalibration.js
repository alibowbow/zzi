// motionCalibration.js — turn a window of "do not touch the rod" samples into
// robust baselines (median + MAD), and decide if calibration succeeded.
// Pure: operates on plain sample arrays.

import { median, mad } from './stats.js';
import { rms } from './motionFilter.js';
import { MOTION } from './motionConfig.js';

// samples: [{ t, amag, jerk, gmag, tilt }]  (amag = linear-accel magnitude)
// opts:    { durationMs, targetHz }
// returns: { ok, reason, stats }
export function summarizeCalibration(samples, opts = {}) {
  const durationMs = opts.durationMs ?? MOTION.CALIB_MS;
  const count = samples.length;

  const amags = samples.map((s) => s.amag);
  const jerks = samples.map((s) => s.jerk ?? 0);
  const gmags = samples.map((s) => s.gmag ?? 0);
  const tilts = samples.map((s) => s.tilt ?? 0);

  const accelMedian = median(amags);
  const accelMad = Math.max(MOTION.CALIB_MIN_ACCEL_MAD, mad(amags, accelMedian));
  const jerkMedian = median(jerks);
  const jerkMad = mad(jerks, jerkMedian);
  const gyroMedian = median(gmags);
  const gyroMad = mad(gmags, gyroMedian);
  const baseTilt = median(tilts);
  const excess = amags.map((a) => Math.max(0, a - accelMedian));
  const vibrationRms = rms(excess);
  const maxAmp = excess.length ? Math.max(...excess) : 0;

  // Drop ratio from the OBSERVED sample timing: the share of the calibration
  // spent inside unusually long gaps. Independent of the device's native rate
  // (a steady 20 Hz phone is fine; a 60 Hz phone that stutters is not).
  const times = samples.map((s) => s.t).sort((a, b) => a - b);
  const intervals = [];
  for (let i = 1; i < times.length; i += 1) intervals.push(times[i] - times[i - 1]);
  const medianInterval = intervals.length ? median(intervals) : 0;
  const gapLimit = Math.max(3 * medianInterval, MOTION.CALIB_GAP_MS);
  let gapTime = 0;
  for (const iv of intervals) if (iv > gapLimit) gapTime += iv - medianInterval;
  const spanMs = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  const observedMs = Math.max(spanMs, 1);
  const sampleHz = medianInterval > 0 ? 1000 / medianInterval : 0;
  // A stream that stopped early also counts: missing tail time is dropped time.
  const tailMissing = Math.max(0, durationMs - spanMs - 2 * medianInterval);
  const dropRatio = Math.min(1, (gapTime + tailMissing) / Math.max(durationMs, observedMs));

  const stats = {
    accelMedian, accelMad, jerkMedian, jerkMad, gyroMedian, gyroMad,
    vibrationRms, maxAmp, baseTilt, sampleHz, dropRatio, count
  };

  if (count < MOTION.CALIB_MIN_SAMPLES) {
    return { ok: false, reason: '센서 데이터를 받을 수 없어요.', stats };
  }
  if (sampleHz < MOTION.CALIB_MIN_HZ) {
    return { ok: false, reason: '센서 신호가 너무 느려요. 다른 앱을 닫고 다시 시도해 주세요.', stats };
  }
  if (dropRatio > MOTION.CALIB_MAX_DROP_RATIO) {
    return { ok: false, reason: '센서 데이터가 자주 끊겨요. 다시 시도해 주세요.', stats };
  }
  if (maxAmp > MOTION.CONTACT_ACCEL * 0.7) {
    return { ok: false, reason: '낚싯대를 건드리지 말고 다시 보정해 주세요.', stats };
  }
  if (accelMad > MOTION.CALIB_MAX_MOVING_MAD) {
    return { ok: false, reason: '스마트폰이 계속 움직이고 있어요. 거치대를 더 단단히 고정해 주세요.', stats };
  }
  return { ok: true, reason: null, stats };
}
