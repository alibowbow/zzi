import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FloatUnit } from '../src/floatTracker.js';
import { representativeColor } from '../src/color.js';

const AW = 320, AH = 180;
const settings = { colorTolerance: 28, nightMode: false };

// Teal water with N red float blobs at given centres.
function frameWith(centres) {
  const data = new Uint8ClampedArray(AW * AH * 4);
  const set = (x, y, r, g, b) => {
    if (x < 0 || x >= AW || y < 0 || y >= AH) return;
    const i = (y * AW + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  };
  for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) set(x, y, 13, 70, 86);
  for (const c of centres) {
    for (let y = c.y - 8; y <= c.y + 8; y++) for (let x = c.x - 3; x <= c.x + 3; x++) set(x, y, 255, 84, 61);
  }
  return { data };
}

function sampleAt(frame, cx, cy, r = 5) {
  const x0 = Math.max(0, cx - r), y0 = Math.max(0, cy - r), x1 = Math.min(AW, cx + r), y1 = Math.min(AH, cy + r);
  const w = x1 - x0, h = y1 - y0; const patch = new Uint8ClampedArray(w * h * 4); let k = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * AW + x) * 4; patch[k++] = frame.data[i]; patch[k++] = frame.data[i + 1]; patch[k++] = frame.data[i + 2]; patch[k++] = 255;
  }
  return representativeColor(patch, w * h);
}

test('a FloatUnit locks onto the tapped float (demo selection works)', () => {
  const frame = frameWith([{ x: 160, y: 90 }]);
  const sample = sampleAt(frame, 160, 85);
  const unit = new FloatUnit({ x: 160, y: 85, rgb: sample.rgb, hsv: sample.hsv });
  const result = unit.track(frame, AW, AH, settings);
  assert.equal(result.found, true);
  assert.ok(Math.abs(unit.x - 160) < 4, `x should track the float, got ${unit.x}`);
  assert.ok(unit.height >= 7, `float height should be usable, got ${unit.height}`);
});

test('two FloatUnits track two separate floats independently (multi-select)', () => {
  const centres = [{ x: 90, y: 80 }, { x: 240, y: 95 }];
  const frame = frameWith(centres);
  const units = centres.map((c) => {
    const s = sampleAt(frame, c.x, c.y);
    return new FloatUnit({ x: c.x, y: c.y, rgb: s.rgb, hsv: s.hsv });
  });
  units.forEach((u) => u.track(frame, AW, AH, settings));
  assert.ok(Math.abs(units[0].x - 90) < 5, `float 1 stays left, got ${units[0].x}`);
  assert.ok(Math.abs(units[1].x - 240) < 5, `float 2 stays right, got ${units[1].x}`);
  // They must not collapse onto the same position.
  assert.ok(Math.abs(units[0].x - units[1].x) > 100, 'the two floats remain distinct');
  assert.notEqual(units[0].id, units[1].id);
});

test('calibration over several frames marks the float calibrated', () => {
  const unit = (() => {
    const f = frameWith([{ x: 160, y: 90 }]);
    const s = sampleAt(f, 160, 85);
    return new FloatUnit({ x: 160, y: 85, rgb: s.rgb, hsv: s.hsv });
  })();
  unit.beginCalibration();
  for (let i = 0; i < 36; i++) {
    const frame = frameWith([{ x: 160, y: 90 + (i % 2) }]); // tiny ripple
    const result = unit.track(frame, AW, AH, settings);
    unit.calibrateStep(result, 0);
  }
  const outcome = unit.finishCalibration();
  assert.equal(outcome.ok, true, `calibration should pass: ${outcome.reason || ''}`);
  assert.ok(unit.floatHeight >= 7);
  assert.equal(unit.calibrated, true);
});
