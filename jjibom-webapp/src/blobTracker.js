// blobTracker.js — connected-component ("blob") based float tracking.
//
// The original app averaged the position of *every* pixel near the target
// colour, so scattered reflections or same-coloured objects merged into one
// phantom float. Instead we build a colour mask, split it into connected blobs,
// and pick the blob that best matches the predicted position, colour, size and
// (vertical) shape of the float. All functions are pure and work on plain typed
// arrays so they can be unit tested without a canvas.

import { clamp, gaussian } from './stats.js';
import { matchPixel } from './color.js';
import { BLOB_SCORE, CONFIDENCE } from './config.js';

// Build a binary colour mask (and per-pixel match quality) over a region of
// interest taken from a full-frame RGBA buffer. `frameWidth` is the stride of
// the source image; `roi` ({ x, y, w, h }) selects the sub-rectangle. Producing
// a local w*h mask lets connectedComponents work in simple local coordinates
// while we still call getImageData only once per frame. Optional `scratch`
// buffers are reused frame-to-frame to avoid per-frame allocations.
export function buildMask(data, frameWidth, roi, target, options = {}, scratch = {}) {
  const { x: ox, y: oy, w, h } = roi;
  const n = w * h;
  const mask = scratch.mask && scratch.mask.length >= n ? scratch.mask : new Uint8Array(n);
  const quality = scratch.quality && scratch.quality.length >= n ? scratch.quality : new Float32Array(n);
  let matchCount = 0;
  let p = 0;
  for (let y = 0; y < h; y += 1) {
    let i = ((oy + y) * frameWidth + ox) * 4;
    for (let x = 0; x < w; x += 1, p += 1, i += 4) {
      const result = matchPixel(data[i], data[i + 1], data[i + 2], target, options);
      if (result.matched && result.quality > 0) {
        mask[p] = 1;
        quality[p] = result.quality;
        matchCount += 1;
      } else {
        mask[p] = 0;
        quality[p] = 0;
      }
    }
  }
  return { mask, quality, matchCount };
}

// Label connected components with an iterative flood fill and return their
// features. Coordinates are local to the ROI.
export function connectedComponents(mask, width, height, options = {}, scratch = {}) {
  const minArea = options.minArea ?? 4;
  const connectivity = options.connectivity ?? 8;
  const quality = options.quality ?? null;
  const maxBlobs = options.maxBlobs ?? 64;
  const n = width * height;
  const labels = scratch.labels && scratch.labels.length >= n ? scratch.labels : new Int32Array(n);
  labels.fill(0, 0, n);
  const stack = scratch.stack || [];
  const blobs = [];
  let label = 0;

  for (let start = 0; start < n; start += 1) {
    if (!mask[start] || labels[start]) continue;
    if (blobs.length >= maxBlobs) break;
    label += 1;
    stack.length = 0;
    stack.push(start);
    labels[start] = label;

    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let qSum = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;

    while (stack.length) {
      const idx = stack.pop();
      const x = idx % width;
      const y = (idx - x) / width;
      area += 1;
      sumX += x;
      sumY += y;
      if (quality) qSum += quality[idx];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const left = x > 0;
      const right = x < width - 1;
      const up = y > 0;
      const down = y < height - 1;
      if (left) pushIfMatch(idx - 1, mask, labels, label, stack);
      if (right) pushIfMatch(idx + 1, mask, labels, label, stack);
      if (up) pushIfMatch(idx - width, mask, labels, label, stack);
      if (down) pushIfMatch(idx + width, mask, labels, label, stack);
      if (connectivity === 8) {
        if (left && up) pushIfMatch(idx - width - 1, mask, labels, label, stack);
        if (right && up) pushIfMatch(idx - width + 1, mask, labels, label, stack);
        if (left && down) pushIfMatch(idx + width - 1, mask, labels, label, stack);
        if (right && down) pushIfMatch(idx + width + 1, mask, labels, label, stack);
      }
    }

    if (area >= minArea) {
      blobs.push({
        area,
        cx: sumX / area,
        cy: sumY / area,
        minX,
        maxX,
        minY,
        maxY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        qualityMean: quality ? qSum / area : 0
      });
    }
  }
  return blobs;
}

function pushIfMatch(idx, mask, labels, label, stack) {
  if (mask[idx] && !labels[idx]) {
    labels[idx] = label;
    stack.push(idx);
  }
}

// Score a blob as a float candidate in [0,1]. `ctx` carries the prediction and
// the calibrated reference values. Weights live in config.
export function scoreBlob(blob, ctx) {
  const floatHeight = ctx.floatHeight || 12;
  const w = BLOB_SCORE;

  let prediction = 0.5;
  if (ctx.hasPrediction) {
    const dx = blob.cx - ctx.predictX;
    const dy = blob.cy - ctx.predictY;
    const sigma = w.PREDICT_SIGMA_K * floatHeight;
    prediction = gaussian(Math.hypot(dx, dy), sigma);
  }

  let initial = 0.5;
  if (ctx.initialX != null) {
    const dx = blob.cx - ctx.initialX;
    const dy = blob.cy - ctx.initialY;
    initial = gaussian(Math.hypot(dx, dy), floatHeight * 3);
  }

  const color = clamp(blob.qualityMean, 0, 1);

  let size = 0.6;
  if (ctx.floatArea > 0) {
    const ratio = blob.area / ctx.floatArea;
    size = gaussian(Math.log(Math.max(ratio, 1e-3)), w.SIZE_SIGMA_LOG);
  }

  // Floats stand vertically, so reward blobs taller than they are wide.
  const aspect = blob.height / Math.max(1, blob.width);
  const shape = clamp(1 - Math.abs(aspect - w.TARGET_ASPECT) / (w.TARGET_ASPECT + 1), 0, 1);

  const weighted = prediction * w.W_PREDICTION
    + initial * w.W_INITIAL
    + color * w.W_COLOR
    + size * w.W_SIZE
    + shape * w.W_SHAPE;
  const total = w.W_PREDICTION + w.W_INITIAL + w.W_COLOR + w.W_SIZE + w.W_SHAPE;
  return clamp(weighted / total, 0, 1);
}

// Rank blobs and return the best and runner-up plus the score margin between
// them (used for confidence — a clear winner is more trustworthy).
export function pickBestBlob(blobs, ctx) {
  let best = null;
  let second = null;
  let bestScore = 0;
  let secondScore = 0;
  for (let i = 0; i < blobs.length; i += 1) {
    const score = scoreBlob(blobs[i], ctx);
    if (score > bestScore) {
      second = best;
      secondScore = bestScore;
      best = blobs[i];
      bestScore = score;
    } else if (score > secondScore) {
      second = blobs[i];
      secondScore = score;
    }
  }
  return { best, second, bestScore, secondScore, margin: bestScore - secondScore };
}

// Combine the per-frame cues into a single tracking confidence in [0,1].
export function computeConfidence(signals) {
  const c = CONFIDENCE;
  const floatHeight = signals.floatHeight || 12;

  const color = clamp(signals.colorMean, 0, 1);
  const jump = gaussian(signals.jumpPx ?? 0, c.JUMP_SIGMA_K * floatHeight);
  let size = 0.6;
  if (signals.areaRatio > 0) {
    size = gaussian(Math.log(Math.max(signals.areaRatio, 1e-3)), BLOB_SCORE.SIZE_SIGMA_LOG);
  }
  const aspect = signals.aspect ?? BLOB_SCORE.TARGET_ASPECT;
  const shape = clamp(1 - Math.abs(aspect - BLOB_SCORE.TARGET_ASPECT) / (BLOB_SCORE.TARGET_ASPECT + 1), 0, 1);
  const margin = clamp(signals.margin ?? 0, 0, 1);

  const weighted = color * c.W_COLOR
    + jump * c.W_JUMP
    + size * c.W_SIZE
    + shape * c.W_SHAPE
    + margin * c.W_MARGIN;
  const total = c.W_COLOR + c.W_JUMP + c.W_SIZE + c.W_SHAPE + c.W_MARGIN;
  return clamp(weighted / total, 0, 1);
}

// Stateful wrapper that holds reusable buffers so the per-frame pipeline does
// not allocate large arrays repeatedly. Browser code uses this; tests use the
// pure functions above.
export class BlobTracker {
  constructor() {
    this._scratch = { mask: null, quality: null, labels: null, stack: [] };
  }

  // data: full-frame RGBA, frameWidth: its stride, roi: { x, y, w, h }.
  // Blobs are returned in *local* ROI coordinates; the caller adds roi.x/roi.y.
  analyze(data, frameWidth, roi, target, options, ctx) {
    const { mask, quality, matchCount } = buildMask(data, frameWidth, roi, target, options, this._scratch);
    this._scratch.mask = mask;
    this._scratch.quality = quality;
    const blobs = connectedComponents(mask, roi.w, roi.h, {
      minArea: options.minArea,
      connectivity: options.connectivity,
      maxBlobs: options.maxBlobs,
      quality
    }, this._scratch);
    const ranked = pickBestBlob(blobs, ctx);
    return { ...ranked, blobs, matchCount };
  }
}
