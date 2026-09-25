// E2E of the REAL camera path: Chromium plays generated scenes as its webcam
// (--use-file-for-fake-video-capture), so getUserMedia, the frame loop, blob
// tracking, shake handling and the alarm all run exactly as on a phone.
//
//   calm     — 30 s of calm water: no alarm, never lost
//   shake    — camera shaken at 9–13 s: alarms held; the bite at 17 s alarms
//   occlude  — float hidden at 9–13 s: "lost", then found; the bite at 18 s alarms
//
// Videos are rendered once into the OS temp dir (e2e/fixtures/make-video.mjs).
import { existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, startServer, createReporter, SKIP_ONBOARDING, statusOf, isOpen, tapMedia } from './lib.mjs';
import { SCENARIOS, VIDEO, renderScenario } from './fixtures/make-video.mjs';

const dir = join(tmpdir(), 'jjibom-e2e-videos');
mkdirSync(dir, { recursive: true });
const { server, base } = await startServer();
const r = createReporter('Real-camera E2E');

function videoFor(name) {
  const file = join(dir, `${name}.y4m`);
  const frames = Math.round(SCENARIOS[name].duration * VIDEO.FPS);
  const bytes = frames * (6 + VIDEO.W * VIDEO.H * 1.5);
  if (!existsSync(file) || statSync(file).size < bytes) {
    const t0 = Date.now();
    renderScenario(name, file);
    console.log(`   rendered ${name}.y4m in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  return file;
}

async function run(name) {
  const cfg = SCENARIOS[name];
  const browser = await launch([
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${videoFor(name)}`
  ]);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(SKIP_ONBOARDING);
  const page = await ctx.newPage();
  r.watch(page);
  await page.goto(base, { waitUntil: 'networkidle' });

  const clickAt = Date.now();
  await page.click('#startCameraBtn');
  await page.waitForFunction(() => document.querySelector('#statusPill').dataset.status === 'camera', null, { timeout: 10000 });
  const t0 = clickAt + 250; // the fake camera starts playing its file when opened
  const T = () => (Date.now() - t0) / 1000;
  await page.waitForTimeout(700);
  await tapMedia(page, 240, 118); // the float tip in the 480x270 scene
  await page.waitForFunction(() => document.querySelector('#statusPill').dataset.status === 'ready', null, { timeout: 12000 });
  await page.click('#monitorBtn');

  const seen = [];
  const alarms = [];
  let last = '';
  while (T() < cfg.duration - 0.8) {
    const status = await statusOf(page);
    if (status !== last) { seen.push({ t: T(), status }); last = status; }
    if (await isOpen(page, '#alarmScreen')) {
      alarms.push({ t: T(), what: await page.textContent('#alarmReason') });
      await page.click('#stopAlarmBtn');
      await page.click('#stopAlarmBtn');
    }
    await page.waitForTimeout(100);
  }
  const trail = seen.map((s) => `${s.t.toFixed(1)}s ${s.status}`).join(' → ');
  const at = (status, from, to) => seen.some((s) => s.status === status && s.t >= from && s.t <= to);

  if (name === 'calm') {
    r.step(alarms.length === 0, 'calm water for 30 s: no alarm', `${alarms.length} alarms`);
    r.step(!seen.some((s) => s.status === 'lost'), 'calm water: never loses the float', trail);
  }
  if (name === 'shake') {
    r.step(at('shake', 8.5, 14.5), 'camera shake is recognised and alarms are held', trail);
    const early = alarms.filter((a) => a.t < cfg.sinkAt);
    const bite = alarms.filter((a) => a.t >= cfg.sinkAt && a.t <= cfg.sinkAt + 2.5);
    r.step(early.length === 0, 'no false alarm from the shake');
    r.step(bite.length === 1, 'the bite after the shake still alarms', bite.map((a) => `${a.t.toFixed(1)}s ${a.what}`).join(', ') || 'none');
  }
  if (name === 'occlude') {
    r.step(at('lost', 9, 14.5), 'hidden float is reported as lost', trail);
    const early = alarms.filter((a) => a.t < cfg.sinkAt);
    const bite = alarms.filter((a) => a.t >= cfg.sinkAt && a.t <= cfg.sinkAt + 2.5);
    r.step(early.length === 0, 'no false alarm while hidden or when found again');
    r.step(bite.length === 1, 'the bite after re-finding the float alarms', bite.map((a) => `${a.t.toFixed(1)}s ${a.what}`).join(', ') || 'none');
  }
  await browser.close();
}

try {
  for (const name of ['calm', 'shake', 'occlude']) await run(name);
} catch (err) {
  r.step(false, 'E2E aborted', err.message.split('\n')[0]);
}
server.close();
process.exit(r.finish() ? 0 : 1);
