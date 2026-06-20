// motionCompensation.js — estimate whole-frame (camera/mount) motion so it is
// not mistaken for a bite. We block-match a handful of background patches
// (outside the float ROI) between the previous and current luma frames and take
// the agreed translation. The float's observed motion then has this background
// motion subtracted.
//
// Pure: operates on Float32Array/Uint8 luma buffers, no canvas.

import { clamp, median } from './stats.js';
import { SHAKE } from './config.js';

// Choose patch top-left positions spread over the frame, skipping any that
// overlap the exclude rect (the float ROI) or fall outside the searchable area.
export function planSamplePositions(width, height, patch, search, exclude, count) {
  const margin = search + 1;
  const usableW = width - patch - margin * 2;
  const usableH = height - patch - margin * 2;
  if (usableW <= 0 || usableH <= 0) return [];
  const cols = 4;
  const rows = 3;
  const positions = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const px = Math.round(margin + (usableW * c) / (cols - 1));
      const py = Math.round(margin + (usableH * r) / (rows - 1));
      if (exclude && px + patch > exclude.x && px < exclude.x + exclude.width
        && py + patch > exclude.y && py < exclude.y + exclude.height) {
        continue; // overlaps the float — skip
      }
      positions.push({ x: px, y: py });
    }
  }
  // Keep an evenly spread subset up to `count`.
  if (positions.length <= count) return positions;
  const stride = positions.length / count;
  const picked = [];
  for (let i = 0; i < count; i += 1) picked.push(positions[Math.floor(i * stride)]);
  return picked;
}

// Local texture (mean absolute deviation of luma) — flat water gives unreliable
// matches, so we down-weight low-texture patches.
function patchTexture(luma, width, px, py, patch) {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < patch; y += 1) {
    for (let x = 0; x < patch; x += 1) {
      sum += luma[(py + y) * width + (px + x)];
      count += 1;
    }
  }
  const avg = sum / count;
  let dev = 0;
  for (let y = 0; y < patch; y += 1) {
    for (let x = 0; x < patch; x += 1) {
      dev += Math.abs(luma[(py + y) * width + (px + x)] - avg);
    }
  }
  return dev / count;
}

function sad(prev, curr, width, px, py, patch, dx, dy) {
  let total = 0;
  for (let y = 0; y < patch; y += 1) {
    const prevRow = (py + y) * width + px;
    const currRow = (py + y + dy) * width + (px + dx);
    for (let x = 0; x < patch; x += 1) {
      total += Math.abs(curr[currRow + x] - prev[prevRow + x]);
    }
  }
  return total;
}

// Best integer translation for a single patch plus a distinctiveness measure.
function matchPatch(prev, curr, width, px, py, patch, search) {
  let bestSad = Infinity;
  let secondSad = Infinity;
  let bestDx = 0;
  let bestDy = 0;
  for (let dy = -search; dy <= search; dy += 1) {
    for (let dx = -search; dx <= search; dx += 1) {
      const value = sad(prev, curr, width, px, py, patch, dx, dy);
      if (value < bestSad) {
        secondSad = bestSad;
        bestSad = value;
        bestDx = dx;
        bestDy = dy;
      } else if (value < secondSad) {
        secondSad = value;
      }
    }
  }
  // Distinctiveness: a deep, unique minimum is trustworthy.
  const distinct = secondSad > 0 ? clamp((secondSad - bestSad) / secondSad, 0, 1) : 0;
  return { dx: bestDx, dy: bestDy, distinct };
}

// Estimate background translation (px) between two luma frames.
// Returns { dx, dy, confidence } in image-pixel units.
export function estimateBackgroundMotion(prev, curr, width, height, exclude, options = {}) {
  if (!prev || !curr) return { dx: 0, dy: 0, confidence: 0 };
  const patch = options.patch ?? SHAKE.PATCH_PX;
  const search = options.search ?? SHAKE.SEARCH_PX;
  const count = options.samples ?? SHAKE.SAMPLES;
  const positions = planSamplePositions(width, height, patch, search, exclude, count);
  if (!positions.length) return { dx: 0, dy: 0, confidence: 0 };

  const dxs = [];
  const dys = [];
  const weights = [];
  // Texture above this (luma MAD) is "enough" to fully trust a patch.
  const textureFloor = 6;
  for (const pos of positions) {
    const texture = patchTexture(prev, width, pos.x, pos.y, patch);
    if (texture < 2) continue; // essentially flat — skip
    const match = matchPatch(prev, curr, width, pos.x, pos.y, patch, search);
    dxs.push(match.dx);
    dys.push(match.dy);
    weights.push(clamp(texture / textureFloor, 0, 1) * match.distinct);
  }
  if (dxs.length < 2) return { dx: 0, dy: 0, confidence: 0 };

  const dx = median(dxs);
  const dy = median(dys);
  // Agreement: fraction of patches within 1px of the median translation.
  let agree = 0;
  for (let i = 0; i < dxs.length; i += 1) {
    if (Math.abs(dxs[i] - dx) <= 1 && Math.abs(dys[i] - dy) <= 1) agree += 1;
  }
  const agreement = agree / dxs.length;
  const meanWeight = weights.reduce((a, b) => a + b, 0) / weights.length;
  const confidence = clamp(agreement * meanWeight * 1.4, 0, 1);
  return { dx, dy, confidence };
}

// Subtract background motion from the observed float motion, but only when the
// background estimate is trustworthy. Returns the corrected delta.
export function correctMotion(observedDx, observedDy, background) {
  if (!background || background.confidence < SHAKE.MIN_CONFIDENCE) {
    return { dx: observedDx, dy: observedDy, applied: false };
  }
  return {
    dx: observedDx - background.dx,
    dy: observedDy - background.dy,
    applied: true
  };
}
