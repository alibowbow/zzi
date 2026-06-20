// stats.js — small, dependency-free numeric helpers.
// Kept pure (no DOM) so they can be unit tested under Node.

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothStep(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function mean(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i];
  return sum / values.length;
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Median Absolute Deviation, scaled by 1.4826 so it estimates the standard
// deviation for normally distributed data. Robust to outliers (occasional
// reflections / tracking jumps) which is why we prefer it over std for
// calibration baselines.
export function mad(values, center = median(values)) {
  if (!values.length) return 0;
  const deviations = values.map((value) => Math.abs(value - center));
  return median(deviations) * 1.4826;
}

export function std(values, center = mean(values)) {
  if (values.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const d = values[i] - center;
    sum += d * d;
  }
  return Math.sqrt(sum / values.length);
}

// Exponential moving average update.
export function ema(previous, sample, alpha) {
  return previous == null ? sample : previous + (sample - previous) * alpha;
}

// Gaussian falloff in [0,1]; distance and sigma share units.
export function gaussian(distance, sigma) {
  if (sigma <= 0) return distance === 0 ? 1 : 0;
  return Math.exp(-(distance * distance) / (2 * sigma * sigma));
}
