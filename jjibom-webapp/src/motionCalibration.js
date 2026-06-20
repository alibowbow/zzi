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
  const targetHz = opts.targetHz ?? MOTION.TARGET_HZ;
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

  const elapsedS = durationMs / 1000;
  const sampleHz = elapsedS > 0 ? count / elapsedS : 0;
  const expected = elapsedS * targetHz;
  const dropRatio = expected > 0 ? Math.max(0, Math.min(1, 1 - count / expected)) : 1;

  const stats = {
    accelMedian, accelMad, jerkMedian, jerkMad, gyroMedian, gyroMad,
    vibrationRms, maxAmp, baseTilt, sampleHz, dropRatio, count
  };

  if (count < MOTION.CALIB_MIN_SAMPLES) {
    return { ok: false, reason: '센서 데이터를 받을 수 없어요.', stats };
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
