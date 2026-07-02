// E2E verification of jjibom-webapp in real Chromium (playwright-core).
//
// Drives the app exactly like a user: camera demo (tap float -> calibrate ->
// monitor -> sink bite -> alarm -> feedback), motion demo (pull -> alarm,
// wind -> silent, touch -> stabilizing), mode switch, help manual, and a set
// of adversarial probes. Fails on any step failure or any console error.
//
// Run:  npm run test:e2e
// Chromium: uses $CHROMIUM_PATH if set, else a known Playwright cache path,
// else playwright-core's own resolution (npx playwright install chromium).
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'shots');
mkdirSync(SHOTS, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml'
};

// Tiny static server so the test is self-contained.
const server = createServer(async (req, res) => {
  try {
    const path = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}/`;

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const known = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  if (existsSync(known)) return known;
  return undefined; // let playwright-core resolve its own installation
}

const results = [];
const consoleErrors = [];
let page;

const step = (icon, name, detail = '') => {
  results.push({ icon, name, detail });
  console.log(`${icon} ${name}${detail ? ' — ' + detail : ''}`);
};
const shot = (name) => page.screenshot({ path: join(SHOTS, name + '.png') });
const waitHidden = (sel, timeout = 5000) =>
  page.waitForFunction((s) => document.querySelector(s)?.classList.contains('hidden'), sel, { timeout });
const waitText = (sel, inc, timeout = 8000) =>
  page.waitForFunction(([s, i]) => document.querySelector(s)?.textContent?.includes(i), [sel, inc], { timeout });

// Click a point given in demo-video media coords (960x540) mapped onto the
// on-screen stage (object-fit: contain).
async function tapMedia(mx, my) {
  const box = await page.locator('#cameraStage').boundingBox();
  const scale = Math.min(box.width / 960, box.height / 540);
  const ox = (box.width - 960 * scale) / 2;
  const oy = (box.height - 540 * scale) / 2;
  await page.mouse.click(box.x + ox + mx * scale, box.y + oy + my * scale);
}

const browser = await chromium.launch({
  executablePath: chromiumPath(),
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required']
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
page = await ctx.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push('PAGEERROR: ' + err.message));

try {
  // ---------- load ----------
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const title = await page.title();
  step(title.includes('찌봄') ? '✅' : '❌', 'load page', `title="${title}"`);
  await shot('01-home');

  // ---------- help manual ----------
  await page.click('#helpBtn');
  await page.waitForSelector('#helpModal:not(.hidden)');
  const helpText = await page.textContent('#helpModal');
  step(helpText.includes('카메라 감지') && helpText.includes('진동 감지') ? '✅' : '❌', 'help manual covers both modes');
  await shot('02-help');
  await page.click('#helpOkayBtn');
  await waitHidden('#helpModal');

  // ---------- camera demo flow ----------
  await page.click('#startDemoBtn');
  await waitText('#statusLabel', '찌 선택', 6000);
  step('✅', 'demo started', 'status=찌 선택');
  await page.waitForTimeout(700);

  await tapMedia(509, 245); // red float tip
  await waitText('#statusLabel', '보정', 4000);
  step('✅', 'float tapped -> calibrating');

  await waitText('#statusLabel', '준비 완료', 9000);
  step('✅', 'calibration done -> READY', `confidence=${await page.textContent('#confidenceText')}`);
  await shot('03-ready');

  await page.click('#monitorBtn');
  await waitText('#statusLabel', '감시 중', 3000);
  step('✅', 'monitoring started');

  // 🔍 tapping during monitoring must be rejected
  await tapMedia(509, 245);
  await page.waitForTimeout(300);
  const toast1 = await page.textContent('#toast');
  step(toast1.includes('멈춘 뒤') ? '🔍' : '❌', 'probe: tap during monitoring rejected', `toast="${toast1}"`);

  await page.click('[data-demo-scene="sink"]');
  await page.waitForSelector('#alarmLayer:not(.hidden)', { timeout: 8000 });
  step('✅', 'sink bite -> ALARM fired',
    `title="${await page.textContent('#alarmTitle')}", score=${await page.textContent('#alarmScore')}`);
  await shot('04-camera-alarm');

  await page.click('#stopAlarmBtn');
  await page.waitForSelector('#feedbackModal:not(.hidden)', { timeout: 3000 });
  step('✅', 'alarm dismissed -> feedback modal shown');
  await page.click('#feedbackTrueBtn');
  await waitHidden('#feedbackModal');
  const histText = await page.textContent('#historyList');
  step(histText.includes('잠겼') || histText.includes('입질') ? '✅' : '❌', 'history recorded');

  // 🔍 cooldown: immediate second sink must not instantly re-alarm
  await page.click('[data-demo-scene="sink"]');
  await page.waitForTimeout(2500);
  const alarmHidden = await page.locator('#alarmLayer').evaluate((el) => el.classList.contains('hidden'));
  step(alarmHidden ? '🔍' : '❌', 'probe: cooldown suppresses immediate re-alarm');

  await page.click('#monitorBtn');
  await page.click('#stopCameraBtn');
  await waitText('#statusLabel', '대기', 3000);
  step('✅', 'camera demo stopped cleanly');

  // ---------- multi-select ----------
  await page.evaluate(() => { const el = document.getElementById('multiSelect'); el.checked = true; el.dispatchEvent(new Event('change')); });
  await page.click('#startDemoBtn');
  await waitText('#statusLabel', '찌 선택', 6000);
  await page.waitForTimeout(600);
  await tapMedia(509, 245);
  await waitText('#statusLabel', '준비 완료', 9000);
  step('✅', 'multi-select mode calibrates', `selection="${await page.textContent('#targetColorText')}"`);
  await page.click('#stopCameraBtn');
  await page.evaluate(() => { const el = document.getElementById('multiSelect'); el.checked = false; el.dispatchEvent(new Event('change')); });

  // ---------- motion mode ----------
  await page.click('#modeMotionBtn');
  await page.waitForSelector('#motionMode:not(.hidden)');
  const camHidden = await page.locator('#cameraMode').evaluate((el) => el.classList.contains('hidden'));
  step(camHidden ? '✅' : '❌', 'mode switch -> motion visible, camera hidden');
  await shot('05-motion-home');

  await page.click('#motionDemoControls [data-scene="pull"]');
  await waitText('#motionStatusLabel', '감시 중', 4000);
  await page.waitForSelector('#motionAlarmModal:not(.hidden)', { timeout: 12000 });
  step('✅', 'pull scenario -> motion ALARM',
    `title="${await page.textContent('#motionAlarmTitle')}", score=${await page.textContent('#motionAlarmScore')}`);
  await shot('06-motion-alarm');
  await page.click('[data-mlabel="true_positive"]');
  await waitHidden('#motionAlarmModal');
  step('✅', 'motion alarm labeled + dismissed');

  // 🔍 wind stays silent
  await page.click('#motionDemoControls [data-scene="wind"]');
  await page.waitForTimeout(500);
  let maxScore = 0;
  const t0 = Date.now();
  let windAlarm = false;
  while (Date.now() - t0 < 7000 && !windAlarm) {
    maxScore = Math.max(maxScore, Number(await page.textContent('#motionScoreBig')));
    windAlarm = await page.locator('#motionAlarmModal').evaluate((el) => !el.classList.contains('hidden'));
  }
  step(!windAlarm ? '🔍' : '❌', 'probe: wind scenario stays silent', `maxScore=${maxScore}`);

  // 🔍 phone touch -> stabilizing, no alarm
  await page.click('#motionDemoControls [data-scene="touch"]');
  await page.waitForTimeout(4500);
  const touchAlarm = await page.locator('#motionAlarmModal').evaluate((el) => !el.classList.contains('hidden'));
  step(!touchAlarm ? '🔍' : '❌', 'probe: phone-touch -> no alarm', `state=${await page.textContent('#motionStatusLabel')}`);

  await page.click('#motionTestAlarmBtn');
  await page.waitForTimeout(400);
  step('🔍', 'probe: test alarm button', `toast="${await page.textContent('#toast')}"`);

  await page.click('#motionStopBtn');
  await waitText('#motionStatusLabel', '대기', 3000);
  step('✅', 'motion monitoring stopped');

  await page.click('#modeCameraBtn');
  await page.waitForSelector('#cameraMode:not(.hidden)');
  step('✅', 'mode switch back to camera');
} catch (err) {
  step('❌', 'E2E aborted', err.message.split('\n')[0]);
  await shot('99-failure').catch(() => {});
}

console.log(`\n=== console errors (${consoleErrors.length}) ===`);
consoleErrors.slice(0, 20).forEach((e) => console.log('  ', e.slice(0, 200)));
await browser.close();
server.close();
const fails = results.filter((r) => r.icon === '❌').length;
console.log(`\nRESULT: ${fails === 0 && consoleErrors.length === 0 ? 'ALL PASS' : 'FAIL'} (${results.length} steps, ${fails} failures, ${consoleErrors.length} console errors)`);
process.exit(fails === 0 && consoleErrors.length === 0 ? 0 : 1);
