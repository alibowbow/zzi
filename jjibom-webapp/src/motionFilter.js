// motionFilter.js — small, pure signal helpers for the motion sensor.
// No DOM; unit-tested. Heavy DSP libraries are intentionally avoided.

import { clamp } from './stats.js';

export function magnitude3(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

// Tilt of the device from vertical, derived from a gravity vector, in degrees.
// 0° = screen up / flat-ish; grows as it tips. Axis-independent enough for our
// "did the mounting angle change" check.
export function tiltFromGravity(gx, gy, gz) {
  const horizontal = Math.sqrt(gx * gx + gy * gy);
  return Math.atan2(horizontal, Math.abs(gz)) * 180 / Math.PI;
}

// Smallest signed difference between two tilt angles (degrees).
export function tiltDelta(a, b) {
  return Math.abs(a - b);
}

// Exponential moving average as a tiny stateful object.
export class Ema {
  constructor(alpha) {
    this.alpha = alpha;
    this.value = null;
  }
  update(sample) {
    this.value = this.value == null ? sample : this.value + (sample - this.value) * this.alpha;
    return this.value;
  }
  reset() { this.value = null; }
}

// Estimates the gravity vector with a per-axis low pass and returns the linear
// (gravity-removed) acceleration. Used when a device only exposes
// accelerationIncludingGravity, so a still phone's 9.8 m/s² is not a "bite".
export class GravityFilter {
  constructor(alpha) {
    this.alpha = alpha;
    this.gx = null; this.gy = null; this.gz = null;
  }
  update(x, y, z) {
    if (this.gx == null) { this.gx = x; this.gy = y; this.gz = z; }
    else {
      this.gx += (x - this.gx) * this.alpha;
      this.gy += (y - this.gy) * this.alpha;
      this.gz += (z - this.gz) * this.alpha;
    }
    return {
      lx: x - this.gx, ly: y - this.gy, lz: z - this.gz, // linear accel
      gx: this.gx, gy: this.gy, gz: this.gz              // gravity estimate
    };
  }
  reset() { this.gx = this.gy = this.gz = null; }
}

// Count peaks in a series of {t, value} where value exceeds `threshold`, with a
// refractory gap so one bump is not counted many times. Returns
// { count, peaks:[{t,value}], maxValue }.
export function countPeaks(series, threshold, refractoryMs) {
  let count = 0;
  let maxValue = 0;
  let lastPeakT = -Infinity;
  const peaks = [];
  for (let i = 1; i < series.length - 1; i += 1) {
    const v = series[i].value;
    if (v > maxValue) maxValue = v;
    const isLocalMax = v >= series[i - 1].value && v > series[i + 1].value;
    if (isLocalMax && v >= threshold && series[i].t - lastPeakT >= refractoryMs) {
      count += 1;
      lastPeakT = series[i].t;
      peaks.push({ t: series[i].t, value: v });
    }
  }
  return { count, peaks, maxValue };
}

// Count distinct "bursts": below->above threshold crossings (rising edges),
// with a refractory gap. Unlike countPeaks this does NOT count noise wiggles on
// a sustained plateau, so a single long pull is one burst while several taps are
// several bursts. Returns { count, times }.
export function countRisingEdges(series, threshold, refractoryMs) {
  let count = 0;
  let last = -Infinity;
  const times = [];
  let prevAbove = series.length ? series[0].value >= threshold : false;
  for (let i = 1; i < series.length; i += 1) {
    const above = series[i].value >= threshold;
    if (above && !prevAbove && series[i].t - last >= refractoryMs) {
      count += 1;
      times.push(series[i].t);
      last = series[i].t;
    }
    prevAbove = above;
  }
  return { count, times };
}

// Count sign reversals in a zero-centred series, ignoring jitter below `band`.
export function countReversals(values, band) {
  let reversals = 0;
  let lastDir = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (Math.abs(v) < band) continue;
    const dir = Math.sign(v);
    if (lastDir !== 0 && dir !== lastDir) reversals += 1;
    lastDir = dir;
  }
  return reversals;
}

// Root mean square of a numeric array.
export function rms(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i] * values[i];
  return Math.sqrt(sum / values.length);
}

// Map sensitivity (1..10) to a MAD multiplier (high sensitivity => low mult).
export function sensitivityToMad(sensitivity, minMult, maxMult) {
  const t = clamp((sensitivity - 1) / 9, 0, 1);
  return maxMult + (minMult - maxMult) * t;
}
