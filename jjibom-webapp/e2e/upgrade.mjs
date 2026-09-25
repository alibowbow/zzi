// E2E of what a returning visitor sees after a deploy. The server plays three
// releases in turn, like Vercel would (max-age=0, production headers), while
// one browser keeps its service worker and caches between them:
//
//   previous — the worker that shipped before release v8 (e2e/fixtures/legacy-sw.js)
//              with a stylesheet from before the release marker
//   current  — this checkout
//   next     — this checkout with the release bumped (a stand-in for the next deploy)
//
// previous -> current: the first visit must end on a clean page (boot.js drops
// the stale caches and loads once more). current -> next: the page stays on its
// own release until the user accepts the "새 버전" prompt, then runs the next.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { ROOT, launch, createReporter, productionHeaders, SKIP_ONBOARDING } from './lib.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'
};
const RELEASE = (await readFile(join(ROOT, 'sw.js'), 'utf8')).match(/const CACHE_VERSION = '([^']+)'/)[1];
const NEXT = `${RELEASE}-next`;
let phase = 'previous';

async function body(path) {
  if (phase === 'previous') {
    if (path === '/sw.js') return readFile(join(ROOT, 'e2e/fixtures/legacy-sw.js'));
    if (path === '/index.html') {
      return (await readFile(join(ROOT, 'index.html'), 'utf8'))
        .replace(` data-release="${RELEASE}"`, '').replace('  <script src="boot.js"></script>\n', '');
    }
    if (path === '/styles.css') return (await readFile(join(ROOT, 'styles.css'), 'utf8')).replace(/^\s*--release:.*$/m, '');
  }
  if (phase === 'next' && ['/sw.js', '/index.html', '/styles.css'].includes(path)) {
    const text = await readFile(join(ROOT, path), 'utf8');
    return text
      .replace(`const CACHE_VERSION = '${RELEASE}'`, `const CACHE_VERSION = '${NEXT}'`)
      .replace(`data-release="${RELEASE}"`, `data-release="${NEXT}"`)
      .replace(`--release: "${RELEASE}"`, `--release: "${NEXT}"`);
  }
  return readFile(join(ROOT, path));
}

const server = createServer(async (req, res) => {
  const path = (() => { const p = decodeURIComponent(req.url.split('?')[0]); return p === '/' ? '/index.html' : p; })();
  try {
    const data = await body(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path)] || 'application/octet-stream',
      'cache-control': 'public, max-age=0, must-revalidate',
      ...(phase === 'previous' ? {} : await productionHeaders(path))
    });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

const r = createReporter('Upgrade E2E');
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await ctx.addInitScript(SKIP_ONBOARDING);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(err.message));
let navigations = 0;
page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });

const settle = (ms) => page.waitForTimeout(ms);
async function until(fn, ms, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await settle(150);
  }
  return false;
}
const state = () => page.evaluate(async () => ({
  release: document.documentElement.dataset.release || '',
  css: getComputedStyle(document.documentElement).getPropertyValue('--release').replace(/["'\s]/g, ''),
  deck: getComputedStyle(document.getElementById('cameraDeck')).position,
  caches: await caches.keys()
}));
async function demoRuns() {
  await page.click('#startDemoBtn', { timeout: 4000 });
  const ok = await until(() => document.querySelector('#statusPill').dataset.status === 'camera', 8000);
  if (ok) await page.click('#stopCameraBtn');
  return ok;
}

try {
  // ---- a visitor of the previous release -------------------------------
  await page.goto(base, { waitUntil: 'networkidle' });
  await until(() => Boolean(navigator.serviceWorker.controller), 8000);
  await page.reload({ waitUntil: 'networkidle' });
  const before = await state();
  r.step(before.caches.includes('jjibom-v5') && before.release === '', 'previous release: its worker and caches are in place', JSON.stringify(before.caches));

  // ---- deploy the current release; the visitor comes back ----------------
  phase = 'current';
  errors.length = 0;
  navigations = 0;
  await page.reload({ waitUntil: 'networkidle' });
  await until(() => document.readyState === 'complete', 5000);
  let s = await state();
  r.step(s.release === RELEASE && s.css === RELEASE && s.deck === 'fixed', 'first visit after deploy: page, styles and code all from the new release', JSON.stringify({ ...s, navigations }));
  r.step(errors.length === 0, 'first visit after deploy: no script errors', errors.slice(0, 2).join(' | '));
  r.step(navigations <= 2, 'stale files cost at most one automatic reload', `navigations=${navigations}`);
  r.step(await demoRuns(), 'the app works right away (demo starts)');
  const onlyCurrent = await until((name) => caches.keys().then((k) => k.length === 1 && k[0] === name), 10000, `jjibom-${RELEASE}`);
  r.step(onlyCurrent, 'the old caches are gone; the release is cached for offline use', JSON.stringify((await state()).caches));

  // ---- the next deploy ---------------------------------------------------
  phase = 'next';
  errors.length = 0;
  await page.reload({ waitUntil: 'networkidle' });
  s = await state();
  r.step(s.release === RELEASE && s.css === RELEASE && errors.length === 0, 'after the next deploy the page stays whole on its own release', JSON.stringify({ release: s.release, css: s.css }));
  const offered = await until(() => !document.getElementById('updateBanner').hidden, 12000);
  r.step(offered, 'the new release is offered ("새 버전이 준비됐어요")');
  if (offered) {
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('#reloadBtn')]);
    s = await state();
    r.step(s.release === NEXT && s.css === NEXT && errors.length === 0, 'after "새로고침" the page runs the next release', JSON.stringify({ release: s.release, css: s.css, caches: s.caches }));
    r.step(await demoRuns(), 'the next release works');
  }
} catch (err) {
  r.step(false, 'E2E aborted', err.message.split('\n')[0]);
}
await browser.close();
server.close();
process.exit(r.finish() ? 0 : 1);
