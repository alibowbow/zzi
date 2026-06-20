// color.js — color space helpers and pixel matching.
// Pure functions only (operate on plain numbers / typed arrays) so the matching
// logic can be unit tested without a canvas.

import { clamp, median } from './stats.js';

export function rgbToHsv(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
    else h = 60 * ((rn - gn) / delta + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255)
  };
}

// Shortest distance on the hue circle (degrees, 0..180).
export function hueDistance(a, b) {
  const diff = Math.abs(a - b);
  return Math.min(diff, 360 - diff);
}

// Perceptual luma (Rec. 601). Used by motion compensation block matching.
export function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Decide whether a pixel matches the target colour and how well (0..1).
// We work mostly in HSV so brightness changes (ripples, glare) hurt less than
// they would in raw RGB. Very low-saturation targets (white / LED) fall back to
// an RGB distance because hue is meaningless there.
//
// Returns { matched: boolean, quality: number }.
export function matchPixel(r, g, b, target, options = {}) {
  const tolerance = options.tolerance ?? 28;
  const nightMode = options.nightMode ?? false;
  const hsv = rgbToHsv(r, g, b);

  if (target.hsv.s < 0.16) {
    const dr = r - target.rgb.r;
    const dg = g - target.rgb.g;
    const db = b - target.rgb.b;
    const distance = Math.sqrt(dr * dr + dg * dg + db * db);
    const maxDistance = tolerance * 4.2;
    const quality = clamp(1 - distance / maxDistance, 0, 1);
    return { matched: distance <= maxDistance, quality };
  }

  const hd = hueDistance(hsv.h, target.hsv.h);
  const sd = Math.abs(hsv.s - target.hsv.s);
  const vd = Math.abs(hsv.v - target.hsv.v);
  const hueLimit = nightMode ? tolerance * 1.35 : tolerance;
  const satLimit = nightMode ? 0.68 : 0.52;
  const valueLimit = nightMode ? 0.58 : 0.62;
  // In night/LED mode we only trust reasonably bright pixels.
  const brightEnough = !nightMode || hsv.v >= Math.max(0.4, target.hsv.v - 0.42);
  const matched = brightEnough && hd <= hueLimit && sd <= satLimit && vd <= valueLimit;
  const quality = clamp(1 - (hd / hueLimit * 0.58 + sd / satLimit * 0.22 + vd / valueLimit * 0.2), 0, 1);
  return { matched, quality };
}

// Estimate a representative colour from a small patch the user tapped.
// `data` is RGBA (Uint8ClampedArray-like). We bias toward the most saturated /
// bright pixels (the float tip) and take per-channel medians for robustness.
export function representativeColor(data, pixelCount) {
  const candidates = [];
  for (let i = 0; i < pixelCount * 4; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const hsv = rgbToHsv(r, g, b);
    candidates.push({ r, g, b, score: hsv.s * 0.7 + hsv.v * 0.3 });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const keep = candidates.slice(0, Math.max(9, Math.floor(candidates.length * 0.42)));
  const rgb = {
    r: Math.round(median(keep.map((p) => p.r))),
    g: Math.round(median(keep.map((p) => p.g))),
    b: Math.round(median(keep.map((p) => p.b)))
  };
  return { rgb, hsv: rgbToHsv(rgb.r, rgb.g, rgb.b) };
}

export function colorName(hsv) {
  if (hsv.v < 0.18) return '어두운색';
  if (hsv.s < 0.15) return hsv.v > 0.78 ? '흰색 계열' : '회색 계열';
  const h = hsv.h;
  if (h < 16 || h >= 345) return '빨강 계열';
  if (h < 46) return '주황 계열';
  if (h < 72) return '노랑 계열';
  if (h < 165) return '초록 계열';
  if (h < 205) return '청록 계열';
  if (h < 255) return '파랑 계열';
  if (h < 300) return '보라 계열';
  return '분홍 계열';
}

export function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
