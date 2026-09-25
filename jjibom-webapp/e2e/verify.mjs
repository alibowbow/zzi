// UI-flow E2E in real Chromium: onboarding, the camera demo end to end
// (tap float -> calibrate -> watch -> bite -> alarm screen -> feedback),
// history + session stats, settings persistence, night/focus modes, the motion
// demo (pull alarms, wind and knocks stay silent) and a phone-size pass.
// Fails on any failed step or any console error.
//
// Run: npm run test:e2e   (or node e2e/verify.mjs)
import { join } from 'node:path';
import { startServer, launch, createReporter, SHOTS, statusOf, isOpen, SKIP_ONBOARDING } from './lib.mjs';

const { server, base } = await startServer();
const browser = await launch();
const r = createReporter('UI E2E');
let page;
const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const waitStatus = (status, timeout = 9000, sel = '#statusPill') =>
  page.waitForFunction(([s, v]) => document.querySelector(s)?.dataset.status === v, [sel, status], { timeout });
const waitOpen = (sel, timeout = 12000) => page.waitForFunction((s) => !document.querySelector(s).hidden, sel, { timeout });
const waitClosed = (sel, timeout = 5000) => page.waitForFunction((s) => document.querySelector(s).hidden, sel, { timeout });

// Centre of the red float tip in the demo video (media coordinates).
async function demoTip() {
  return page.evaluate(() => {
    const c = document.getElementById('demoCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let sx = 0; let sy = 0; let n = 0;
    for (let y = 0; y < c.height; y += 1) {
      for (let x = 0; x < c.width; x += 1) {
        const i = (y * c.width + x) * 4;
        if (d[i] > 190 && d[i + 1] < 110 && d[i + 2] < 110) { sx += x; sy += y; n += 1; }
      }
    }
    return { x: sx / n, y: sy / n, n };
  });
}

async function tapDemoFloat(touch = false) {
  const tip = await demoTip();
  const box = await page.locator('#cameraStage').boundingBox();
  const scale = Math.min(box.width / 960, box.height / 540);
  const x = box.x + (box.width - 960 * scale) / 2 + tip.x * scale;
  const y = box.y + (box.height - 540 * scale) / 2 + tip.y * scale;
  if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
}

async function startDemoToReady(touch = false) {
  await page.click('#startDemoBtn');
  await waitStatus('camera', 8000);
  await page.waitForTimeout(700);
  await tapDemoFloat(touch);
  await waitStatus('calibrating', 4000);
  await waitStatus('ready', 12000);
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await ctx.newPage();
  r.watch(page);

  // ---------- first run ----------
  let loads = 0;
  page.on('load', () => { loads += 1; });
  await page.goto(base, { waitUntil: 'networkidle' });
  r.step((await page.title()).includes('찌봄'), 'page loads');
  r.step(await isOpen(page, '#onboarding'), 'first run shows onboarding');
  // Installing the offline worker must not reload the page under the user.
  const controlled = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i += 1) await new Promise((res) => setTimeout(res, 100));
    return Boolean(navigator.serviceWorker.controller);
  }).catch(() => false);
  await page.waitForTimeout(800);
  r.step(controlled && loads === 1, 'first visit: offline worker takes over without a reload', `controlled=${controlled} loads=${loads}`);
  await shot('01-onboarding');
  await page.click('#onboardNext');
  await page.click('#onboardNext');
  r.step((await page.textContent('#onboardNext')).includes('시작'), 'onboarding reaches last slide');
  await page.click('#onboardNext');
  await waitClosed('#onboarding');
  await page.reload({ waitUntil: 'networkidle' });
  r.step(!(await isOpen(page, '#onboarding')), 'onboarding not shown again');

  // ---------- camera demo ----------
  await startDemoToReady();
  r.step(true, 'demo: tap float -> calibrated -> ready', `target=${await page.textContent('#targetColorText')}`);
  const deckState = await page.evaluate(() => ({ phase: document.getElementById('app').dataset.phase, start: !document.getElementById('monitorBtn').disabled }));
  r.step(deckState.phase === 'ready' && deckState.start, 'deck offers “감시 시작” when ready', JSON.stringify(deckState));
  await shot('02-ready');

  await page.click('#monitorBtn');
  await waitStatus('monitoring', 3000);
  r.step(await isOpen(page, '#liveChip'), 'monitoring: live chip visible', await page.textContent('#liveChipText'));

  await tapDemoFloat();
  await page.waitForTimeout(250);
  r.step((await page.textContent('#toast')).includes('멈춘 뒤') ? 'probe' : false, 'probe: re-selecting while watching is refused');

  // The mode switch steps aside for the live timer while watching.
  const modesHidden = await page.$eval('.modes', (el) => getComputedStyle(el).display === 'none');
  r.step(modesHidden ? 'probe' : false, 'probe: mode switch is out of reach while watching');

  await page.evaluate(() => { document.querySelector('#demoControls').open = true; });
  await page.click('[data-demo-scene="sink"]');
  await waitOpen('#alarmScreen');
  const alarmState = await page.$eval('#alarmScreen', (el) => el.dataset.state);
  r.step(alarmState === 'ringing' && (await page.textContent('#alarmReason')).includes('잠겼'), 'sink bite -> full-screen alarm', `${await page.textContent('#alarmReason')} · 강도 ${await page.textContent('#alarmScore')}`);
  await shot('03-alarm');
  await page.click('#stopAlarmBtn');
  const stopped = await page.$eval('#alarmScreen', (el) => el.dataset.state);
  r.step(stopped === 'stopped' && await statusOf(page) !== 'alarm', 'alarm silenced, watching continues', `status=${await statusOf(page)}`);
  await page.click('#alarmFeedback [data-label="true_positive"]');
  await waitClosed('#alarmScreen');
  r.step(await isOpen(page, '#historyBadge'), 'labelled; history badge shown');

  await page.click('[data-demo-scene="sink"]');
  await page.waitForTimeout(2500);
  r.step(!(await isOpen(page, '#alarmScreen')) ? 'probe' : false, 'probe: cooldown suppresses an immediate re-alarm');

  // ---------- history ----------
  await page.click('.dock [data-tab="history"]');
  await waitOpen('#view-history', 2000);
  const hist = await page.textContent('#historyList');
  r.step(hist.includes('잠겼') && hist.includes('입질 맞음'), 'history lists the labelled bite');
  const sessionAlarms = await page.textContent('#sessionAlarms');
  const sessionTrue = await page.textContent('#sessionTrue');
  r.step(sessionAlarms === '1' && sessionTrue === '1', 'session stats count alarm + label', `alarms=${sessionAlarms} true=${sessionTrue}`);
  r.step(!(await isOpen(page, '#historyBadge')), 'badge cleared on visit');
  await page.click('.filter [data-filter="motion"]');
  r.step((await page.textContent('#historyList')).includes('아직 기록이 없어요'), 'filter: motion shows none yet');
  await page.click('.filter [data-filter="all"]');
  await shot('04-history');

  // ---------- settings ----------
  await page.click('.dock [data-tab="settings"]');
  await waitOpen('#view-settings', 2000);
  await page.click('#alarmToneGroup [data-tone="siren"]');
  await page.$eval('#alarmVolume', (el) => { el.value = '60'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
  r.step((await page.textContent('#alarmVolumeOut')) === '60%', 'alarm volume setting updates');
  await page.click('#testAlarmBtn');
  await page.waitForTimeout(200);
  r.step((await page.textContent('#toast')).includes('시험'), 'alarm test runs');
  await shot('05-settings');
  await page.click('.dock [data-tab="guide"]');
  r.step((await page.textContent('#view-guide')).includes('진동 감지'), 'guide covers both modes');
  await page.click('.dock [data-tab="watch"]');

  // Watching kept running underneath the panels.
  r.step(await statusOf(page) === 'monitoring', 'camera kept watching while panels were open');
  await page.click('#monitorBtn');
  await waitStatus('ready', 3000);
  await page.click('#stopCameraBtn');
  await waitStatus('idle', 3000);
  r.step(true, 'camera stopped cleanly');

  // ---------- multi-select ----------
  await page.$eval('#multiSelect', (el) => { el.checked = true; el.dispatchEvent(new Event('change')); });
  await startDemoToReady();
  r.step(true, 'multi-select mode calibrates');
  await page.click('#stopCameraBtn');
  await page.$eval('#multiSelect', (el) => { el.checked = false; el.dispatchEvent(new Event('change')); });

  // ---------- motion demo ----------
  await page.click('#modeMotionBtn');
  r.step(await isOpen(page, '#motionMode') && !(await isOpen(page, '#cameraMode')), 'switch to vibration mode');
  await page.evaluate(() => { document.querySelector('#motionDemoControls').open = true; });
  await page.click('#motionDemoChips [data-scene="pull"]');
  await waitOpen('#alarmScreen', 12000);
  r.step((await page.textContent('#alarmReason')).includes('강한 당김'), 'pull -> vibration alarm', `강도 ${await page.textContent('#alarmScore')}`);
  await shot('06-motion-alarm');
  await page.click('#alarmFeedback [data-label="false_positive"]');
  await waitClosed('#alarmScreen');
  r.step(true, 'vibration alarm labelled as false positive');

  await page.click('#motionDemoChips [data-scene="wind"]');
  await page.waitForTimeout(400);
  let windAlarm = false;
  let windMax = 0;
  for (const until = Date.now() + 7000; Date.now() < until && !windAlarm;) {
    windMax = Math.max(windMax, Number(await page.textContent('#motionScoreBig')));
    windAlarm = await isOpen(page, '#alarmScreen');
    await page.waitForTimeout(120);
  }
  r.step(!windAlarm ? 'probe' : false, 'probe: strong wind stays silent', `max score ${windMax}`);

  await page.click('#motionDemoChips [data-scene="touch"]');
  let sawStabilizing = false;
  for (const until = Date.now() + 4500; Date.now() < until;) {
    if (await statusOf(page, '#motionStatusPill') === 'stabilizing') sawStabilizing = true;
    await page.waitForTimeout(120);
  }
  r.step(sawStabilizing && !(await isOpen(page, '#alarmScreen')) ? 'probe' : false, 'probe: phone knock -> stabilizing, no alarm');
  await page.click('#motionStopBtn');
  await waitStatus('idle', 3000, '#motionStatusPill');
  r.step(true, 'vibration watching stopped');

  // ---------- night + focus + persistence ----------
  await page.click('#nightBtn');
  r.step(await page.evaluate(() => document.body.classList.contains('night')), 'night screen on');
  await page.click('#focusBtn');
  r.step(await page.evaluate(() => document.getElementById('app').classList.contains('focus')), 'focus mode on');
  await page.click('#focusBtn');
  await page.reload({ waitUntil: 'networkidle' });
  const persisted = await page.evaluate(() => ({
    night: document.body.classList.contains('night'),
    tone: document.querySelector('#alarmToneGroup [aria-checked="true"]')?.dataset.tone,
    volume: document.getElementById('alarmVolume').value,
    mode: document.getElementById('app').dataset.mode,
    records: document.querySelectorAll('#historyList .event').length
  }));
  r.step(persisted.night && persisted.tone === 'siren' && persisted.volume === '60' && persisted.records === 2,
    'settings, mode and history survive a reload', JSON.stringify(persisted));
  await ctx.close();

  // ---------- phone ----------
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await phone.addInitScript(SKIP_ONBOARDING);
  page = await phone.newPage();
  r.watch(page);
  await page.goto(base, { waitUntil: 'networkidle' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  r.step(overflow <= 0, 'phone: no horizontal overflow', `${overflow}px`);
  await startDemoToReady(true);
  await page.tap('#monitorBtn');
  await waitStatus('monitoring', 3000);
  await page.evaluate(() => { document.querySelector('#demoControls').open = true; });
  await page.tap('[data-demo-scene="sink"]');
  await waitOpen('#alarmScreen');
  const btn = await page.locator('#stopAlarmBtn').boundingBox();
  r.step(btn.height >= 60 && btn.width >= 300, 'phone: alarm stop button is thumb-sized', `${Math.round(btn.width)}x${Math.round(btn.height)}`);
  await shot('07-phone-alarm');
  await page.tap('#stopAlarmBtn');
  await page.tap('#stopAlarmBtn');
  await waitClosed('#alarmScreen');
  r.step(true, 'phone: alarm closed without a label');
  await phone.close();
} catch (err) {
  r.step(false, 'E2E aborted', err.message.split('\n')[0]);
  await shot('99-failure').catch(() => {});
}

await browser.close();
server.close();
process.exit(r.finish() ? 0 : 1);
