// E2E of the REAL web vibration path (not the replay demo): synthetic
// DeviceMotionEvents at a chosen rate drive calibration -> armed -> bites ->
// cooldown -> wind -> knock -> sensor dropout -> background pause, through the
// same page code a phone runs. Runs at 60 Hz and 20 Hz (a slow sensor), plus a
// gravity-only device (no linear acceleration).
import { launch, startServer, createReporter, SKIP_ONBOARDING, statusOf, isOpen } from './lib.mjs';

const { server, base } = await startServer();
const browser = await launch();
const r = createReporter('Real-sensor E2E');

async function run(hz, gravityOnly) {
  const tag = `${hz} Hz${gravityOnly ? ' gravity-only' : ''}`;
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.addInitScript(SKIP_ONBOARDING);
  const page = await ctx.newPage();
  r.watch(page);
  await page.goto(base, { waitUntil: 'networkidle' });

  await page.evaluate(({ hz, gravityOnly }) => {
    const st = { mode: 'calm', at: performance.now(), tilt: 0, running: true };
    window.__motion = st;
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    const bump = (t, c, w) => Math.exp(-(((t - c) / w) ** 2));
    setInterval(() => {
      if (!st.running) return;
      const tm = performance.now() - st.at;
      let ax = rnd() * 0.03; const ay = rnd() * 0.03; const az = rnd() * 0.03; let rot = rnd();
      if (st.mode === 'pull') { ax += 5 * bump(tm, 150, 60) + (tm > 200 && tm < 700 ? 0.6 : 0); rot += 25 * bump(tm, 150, 70); }
      if (st.mode === 'tap2') { ax += 1.6 * bump(tm, 150, 30) + 1.5 * bump(tm, 390, 30); rot += 8 * bump(tm, 150, 30); }
      if (st.mode === 'wind') { ax += 0.15 * Math.sin(tm * 0.0057); rot += 3 * Math.sin(tm * 0.0057); }
      if (st.mode === 'touch') { ax += 12 * bump(tm, 150, 40); if (tm > 150) st.tilt = 20; rot += 40 * bump(tm, 150, 45); }
      const tr = st.tilt * Math.PI / 180;
      const g = { x: 9.81 * Math.sin(tr), y: 0, z: 9.81 * Math.cos(tr) };
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
        acceleration: gravityOnly ? null : { x: ax, y: ay, z: az },
        accelerationIncludingGravity: { x: ax + g.x, y: ay + g.y, z: az + g.z },
        rotationRate: { alpha: rot, beta: rot * 0.5, gamma: rot * 0.3 },
        interval: 1000 / hz
      }));
    }, 1000 / hz);
  }, { hz, gravityOnly });

  const setMode = (mode) => page.evaluate((m) => { window.__motion.mode = m; window.__motion.at = performance.now(); }, mode);
  // Watch for `ms`; close alarms as they come. Returns alarms, the states seen
  // and their order (printed when a step fails, so a flaky run explains itself).
  async function watch(ms) {
    const out = { alarms: [], states: new Set(), trail: [] };
    const t0 = Date.now();
    for (const until = Date.now() + ms; Date.now() < until;) {
      const state = await statusOf(page, '#motionStatusPill');
      if (out.trail.at(-1)?.state !== state) out.trail.push({ state, ms: Date.now() - t0 });
      out.states.add(state);
      if (await isOpen(page, '#alarmScreen')) {
        out.alarms.push(await page.textContent('#alarmReason'));
        await page.click('#stopAlarmBtn');
        await page.click('#stopAlarmBtn');
      }
      await page.waitForTimeout(120);
    }
    return out;
  }

  await page.click('#modeMotionBtn');
  await page.click('#motionCalibrateBtn');
  let w = await watch(7500);
  r.step(w.states.has('armed'), `${tag}: calibration -> armed`, [...w.states].join('>'));
  w = await watch(4000);
  r.step(w.alarms.length === 0, `${tag}: calm -> no alarm`);
  await setMode('pull');
  w = await watch(2500);
  r.step(w.alarms.length === 1 && w.alarms[0].includes('강한 당김'), `${tag}: strong pull -> one alarm`, w.alarms.join(','));
  await setMode('calm');
  await watch(9500);
  await setMode('tap2');
  w = await watch(2500);
  r.step(w.alarms.length === 1 && w.alarms[0].includes('토독'), `${tag}: two quick taps -> 토독 alarm`, w.alarms.join(','));
  await setMode('calm');
  await watch(9500);
  await setMode('wind');
  w = await watch(7000);
  r.step(w.alarms.length === 0, `${tag}: wind -> no alarm`);
  await setMode('touch');
  w = await watch(3500);
  r.step(w.alarms.length === 0 && w.states.has('stabilizing'), `${tag}: knock -> stabilizing, no alarm`, [...w.states].join('>'));
  await page.evaluate(() => { window.__motion.tilt = 0; });
  await setMode('calm');
  await watch(3500);
  const trail = (x) => x.trail.map((e) => `${e.ms}ms ${e.state}`).join(' > ');
  await page.evaluate(() => { window.__motion.running = false; });
  const dropout = await watch(2600);
  await page.evaluate(() => { window.__motion.running = true; });
  w = await watch(2200);
  r.step(dropout.states.has('error') && w.states.has('armed') && !dropout.alarms.length && !w.alarms.length,
    `${tag}: sensor dropout -> error -> recovers, no alarm`, `${trail(dropout)} | ${trail(w)}`);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  const hidden = await watch(1200);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  w = await watch(1500);
  const ok = hidden.states.has('paused') && w.states.has('armed');
  r.step(ok, `${tag}: hidden page pauses honestly, resumes when visible`, ok ? '' : `hidden: ${trail(hidden)} | visible: ${trail(w)}`);
  await page.click('#motionStopBtn');
  await ctx.close();
}

try {
  await run(60, false);
  await run(20, false);
  await run(60, true);
} catch (err) {
  r.step(false, 'E2E aborted', err.message.split('\n')[0]);
}
await browser.close();
server.close();
process.exit(r.finish() ? 0 : 1);
