import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rgbToHsv, matchPixel, representativeColor, hueDistance } from '../src/color.js';
import { mediaDisplayRect, displayToMedia, mediaToDisplay } from '../src/geometry.js';
import { obsoleteCaches, pickStrategy } from '../src/swCache.js';
import { median, mad, clamp } from '../src/stats.js';

// --- color ----------------------------------------------------------------
test('rgbToHsv maps primary colours', () => {
  const red = rgbToHsv(255, 0, 0);
  assert.equal(Math.round(red.h), 0);
  assert.ok(red.s > 0.99 && red.v > 0.99);
  const green = rgbToHsv(0, 255, 0);
  assert.equal(Math.round(green.h), 120);
});

test('hueDistance wraps around the circle', () => {
  assert.equal(hueDistance(10, 350), 20);
  assert.equal(hueDistance(0, 180), 180);
});

test('matchPixel accepts near colours and rejects far ones', () => {
  const target = { rgb: { r: 230, g: 40, b: 40 }, hsv: rgbToHsv(230, 40, 40) };
  const near = matchPixel(220, 50, 45, target, { tolerance: 28 });
  const far = matchPixel(40, 60, 220, target, { tolerance: 28 });
  assert.equal(near.matched, true);
  assert.ok(near.quality > 0.5);
  assert.equal(far.matched, false);
});

test('representativeColor biases toward the saturated tip', () => {
  // 4 pixels: three vivid red, one grey. Median should land on red.
  const data = [
    240, 30, 30, 255,
    235, 35, 28, 255,
    245, 25, 32, 255,
    120, 120, 120, 255
  ];
  const rep = representativeColor(data, 4);
  assert.ok(rep.rgb.r > 200 && rep.rgb.g < 80);
});

// --- geometry (object-fit) ------------------------------------------------
test('mediaDisplayRect: contain letterboxes, cover crops', () => {
  const contain = mediaDisplayRect(200, 100, 100, 100, 'contain');
  assert.equal(contain.scale, 1);
  assert.equal(contain.x, 50);
  assert.equal(contain.y, 0);

  const cover = mediaDisplayRect(200, 100, 100, 100, 'cover');
  assert.equal(cover.scale, 2);
  assert.equal(cover.y, -50); // top/bottom cropped
});

test('displayToMedia respects letterbox (taps outside the image are not inside)', () => {
  const rect = mediaDisplayRect(200, 100, 100, 100, 'contain');
  const center = displayToMedia(100, 50, rect, 100, 100);
  assert.equal(center.inside, true);
  assert.ok(Math.abs(center.x - 50) < 1e-6 && Math.abs(center.y - 50) < 1e-6);

  const letterbox = displayToMedia(10, 50, rect, 100, 100); // left black bar
  assert.equal(letterbox.inside, false);
});

test('displayToMedia round-trips with mediaToDisplay (cover)', () => {
  const rect = mediaDisplayRect(200, 100, 160, 90, 'cover');
  const back = mediaToDisplay(80, 45, rect);
  const fwd = displayToMedia(back.x, back.y, rect, 160, 90);
  assert.ok(Math.abs(fwd.x - 80) < 1e-6 && Math.abs(fwd.y - 45) < 1e-6);
});

// --- service worker cache policy -----------------------------------------
test('obsoleteCaches keeps the current version and drops old prefixed ones', () => {
  const result = obsoleteCaches(['jjibom-v1', 'jjibom-v2', 'unrelated-cache'], 'jjibom-v2');
  assert.deepEqual(result, ['jjibom-v1']);
});

test('pickStrategy picks fresh strategies for code and cache-first for assets', () => {
  assert.equal(pickStrategy('/index.html'), 'network-first');
  assert.equal(pickStrategy('/app.js'), 'swr');
  assert.equal(pickStrategy('/src/blobTracker.js'), 'swr');
  assert.equal(pickStrategy('/icons/icon-192.png'), 'cache-first');
  assert.equal(pickStrategy('/whatever', true), 'network-first');
});

// --- robust stats used by calibration ------------------------------------
test('median and MAD ignore an outlier', () => {
  const values = [10, 10.2, 9.8, 10.1, 40]; // 40 = reflection spike
  assert.ok(Math.abs(median(values) - 10.1) < 0.2);
  assert.ok(mad(values) < 1); // not dragged up by the outlier
});

test('clamp bounds values', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});
