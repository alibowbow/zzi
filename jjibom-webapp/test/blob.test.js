import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMask, connectedComponents, scoreBlob, pickBestBlob, computeConfidence } from '../src/blobTracker.js';
import { rgbToHsv } from '../src/color.js';

const W = 14;
const H = 8;

// A grey frame with two separate red 2x2 squares.
function twoRedSquaresFrame() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 100; data[i + 1] = 100; data[i + 2] = 100; data[i + 3] = 255;
  }
  const paint = (x, y) => {
    const i = (y * W + x) * 4;
    data[i] = 240; data[i + 1] = 30; data[i + 2] = 30; data[i + 3] = 255;
  };
  // square A near top-left
  paint(2, 2); paint(3, 2); paint(2, 3); paint(3, 3);
  // square B near bottom-right
  paint(10, 5); paint(11, 5); paint(10, 6); paint(11, 6);
  return data;
}

const redTarget = { rgb: { r: 240, g: 30, b: 30 }, hsv: rgbToHsv(240, 30, 30) };

test('buildMask only marks the matching pixels', () => {
  const { mask, matchCount } = buildMask(twoRedSquaresFrame(), W, { x: 0, y: 0, w: W, h: H }, redTarget, { tolerance: 28 });
  assert.equal(matchCount, 8);
  assert.equal(mask[2 * W + 2], 1);
  assert.equal(mask[0], 0);
});

test('two separated same-colour objects stay TWO blobs (not merged)', () => {
  const { mask, quality } = buildMask(twoRedSquaresFrame(), W, { x: 0, y: 0, w: W, h: H }, redTarget, { tolerance: 28 });
  const blobs = connectedComponents(mask, W, H, { minArea: 4, quality });
  assert.equal(blobs.length, 2);
  assert.equal(blobs[0].area, 4);
  assert.equal(blobs[1].area, 4);
});

test('connectedComponents computes a centroid and bounding box', () => {
  const { mask, quality } = buildMask(twoRedSquaresFrame(), W, { x: 0, y: 0, w: W, h: H }, redTarget, { tolerance: 28 });
  const blobs = connectedComponents(mask, W, H, { minArea: 4, quality });
  const a = blobs.find((b) => b.cx < 5);
  assert.ok(Math.abs(a.cx - 2.5) < 1e-6 && Math.abs(a.cy - 2.5) < 1e-6);
  assert.equal(a.width, 2);
  assert.equal(a.height, 2);
});

test('pickBestBlob prefers the blob near the prediction', () => {
  const { mask, quality } = buildMask(twoRedSquaresFrame(), W, { x: 0, y: 0, w: W, h: H }, redTarget, { tolerance: 28 });
  const blobs = connectedComponents(mask, W, H, { minArea: 4, quality });
  const ctx = { hasPrediction: true, predictX: 2.5, predictY: 2.5, initialX: 2.5, initialY: 2.5, floatHeight: 3, floatArea: 4 };
  const ranked = pickBestBlob(blobs, ctx);
  assert.ok(ranked.best.cx < 5, 'best blob is the one near the prediction');
  assert.ok(ranked.margin > 0, 'there is a clear winner');
});

test('scoreBlob: a blob at the prediction beats a far one', () => {
  const here = { area: 4, cx: 2.5, cy: 2.5, width: 2, height: 4, qualityMean: 0.9 };
  const far = { area: 4, cx: 12, cy: 7, width: 2, height: 4, qualityMean: 0.9 };
  const ctx = { hasPrediction: true, predictX: 2.5, predictY: 2.5, initialX: 2.5, initialY: 2.5, floatHeight: 3, floatArea: 4 };
  assert.ok(scoreBlob(here, ctx) > scoreBlob(far, ctx));
});

test('computeConfidence drops when the float jumps far between frames', () => {
  const base = { colorMean: 0.9, floatHeight: 12, areaRatio: 1, aspect: 1.8, margin: 0.5 };
  const steady = computeConfidence({ ...base, jumpPx: 1 });
  const jumpy = computeConfidence({ ...base, jumpPx: 40 });
  assert.ok(steady > jumpy);
  assert.ok(steady > 0.6);
});
