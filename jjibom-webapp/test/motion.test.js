import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estimateBackgroundMotion, correctMotion, planSamplePositions } from '../src/motionCompensation.js';

const W = 48;
const H = 36;

// A deterministic, well-textured luma field defined for any integer coordinate,
// so a shifted copy is exact (no edge clamping needed).
function fieldValue(x, y) {
  const noise = (((x * 13 + y * 7) % 23) + 23) % 23;
  return 128 + 50 * Math.sin(x * 0.7) + 35 * Math.sin(y * 0.9) + noise;
}

function makeField(shiftX, shiftY) {
  const buffer = new Float32Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      buffer[y * W + x] = fieldValue(x - shiftX, y - shiftY);
    }
  }
  return buffer;
}

test('planSamplePositions keeps patches inside the searchable area and away from the ROI', () => {
  const exclude = { x: 0, y: 0, width: 20, height: 20 };
  const positions = planSamplePositions(W, H, 12, 4, exclude, 8);
  assert.ok(positions.length > 0);
  for (const p of positions) {
    assert.ok(p.x >= 5 && p.x + 12 + 4 <= W);
    assert.ok(p.y >= 5 && p.y + 12 + 4 <= H);
    const overlaps = p.x < 20 && p.x + 12 > exclude.x && p.y < 20 && p.y + 12 > exclude.y;
    assert.equal(overlaps, false);
  }
});

test('estimateBackgroundMotion recovers a known translation', () => {
  const prev = makeField(0, 0);
  const curr = makeField(2, -1); // scene shifted +2x, -1y
  const motion = estimateBackgroundMotion(prev, curr, W, H, null, { patch: 12, search: 4, samples: 8 });
  assert.equal(motion.dx, 2);
  assert.equal(motion.dy, -1);
  assert.ok(motion.confidence > 0.3);
});

test('no motion yields zero translation', () => {
  const prev = makeField(0, 0);
  const motion = estimateBackgroundMotion(prev, prev, W, H, null, { patch: 12, search: 4, samples: 8 });
  assert.equal(motion.dx, 0);
  assert.equal(motion.dy, 0);
});

test('a flat (textureless) frame produces no confident estimate', () => {
  const flat = new Float32Array(W * H).fill(128);
  const motion = estimateBackgroundMotion(flat, flat, W, H, null, { patch: 12, search: 4, samples: 8 });
  assert.equal(motion.confidence, 0);
});

test('correctMotion cancels a float that moved WITH the background (camera shake)', () => {
  const background = { dx: 2, dy: -1, confidence: 0.9 };
  const corrected = correctMotion(2, -1, background); // float observed same shift
  assert.equal(corrected.applied, true);
  assert.equal(corrected.dx, 0);
  assert.equal(corrected.dy, 0);
});

test('correctMotion does not subtract an untrusted background estimate', () => {
  const background = { dx: 5, dy: 5, confidence: 0.1 };
  const corrected = correctMotion(2, -1, background);
  assert.equal(corrected.applied, false);
  assert.equal(corrected.dx, 2);
  assert.equal(corrected.dy, -1);
});
