// Shared helpers for the E2E scripts: a tiny static server for the app, the
// Chromium launcher, step logging and the pass/fail summary.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'shots');
mkdirSync(SHOTS, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'
};

// The production headers from vercel.json (CSP included), so every E2E run
// also proves the policy does not block anything the app needs.
export async function productionHeaders(path) {
  try {
    const config = JSON.parse(await readFile(join(ROOT, '..', 'vercel.json'), 'utf8'));
    const out = {};
    for (const rule of config.headers || []) {
      const re = new RegExp(`^${rule.source.replace(/\(\.\*\)/g, '.*')}$`);
      if (re.test(path)) rule.headers.forEach((h) => { out[h.key] = h.value; });
    }
    return out;
  } catch {
    return {};
  }
}

export async function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const path = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
      const file = join(ROOT, path);
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', ...(await productionHeaders(path)) });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}/` };
}

export function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const known = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  if (existsSync(known)) return known;
  return undefined; // let playwright-core resolve its own installation
}

export function launch(args = []) {
  return chromium.launch({
    executablePath: chromiumPath(),
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', ...args]
  });
}

// Skip the first-run sheet in tests that are not about onboarding.
export const SKIP_ONBOARDING = () => {
  try { localStorage.setItem('jjibom-ui-v1', JSON.stringify({ onboarded: true })); } catch { /* ignore */ }
};

export function createReporter(label) {
  const results = [];
  const consoleErrors = [];
  const t0 = Date.now();
  return {
    consoleErrors,
    watch(page) {
      page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
      page.on('pageerror', (err) => consoleErrors.push(`PAGEERROR: ${err.message}`));
    },
    step(ok, name, detail = '') {
      const icon = ok === 'probe' ? '🔍' : ok ? '✅' : '❌';
      results.push({ ok: ok !== false, name });
      console.log(`${icon} ${name}${detail ? ` — ${detail}` : ''}`);
    },
    elapsed: () => ((Date.now() - t0) / 1000).toFixed(1),
    finish() {
      if (consoleErrors.length) {
        console.log(`\n=== console errors (${consoleErrors.length}) ===`);
        consoleErrors.slice(0, 20).forEach((e) => console.log('  ', e.slice(0, 200)));
      }
      const fails = results.filter((r) => !r.ok).length;
      const pass = fails === 0 && consoleErrors.length === 0;
      console.log(`\n${label}: ${pass ? 'ALL PASS' : 'FAIL'} (${results.length} steps, ${fails} failures, ${consoleErrors.length} console errors)`);
      return pass;
    }
  };
}

// Tap a point given in video (media) coordinates on the object-fit:contain stage.
export async function tapMedia(page, mx, my, { touch = false } = {}) {
  const box = await page.locator('#cameraStage').boundingBox();
  const { w, h } = await page.evaluate(() => ({ w: document.getElementById('camera').videoWidth, h: document.getElementById('camera').videoHeight }));
  const scale = Math.min(box.width / w, box.height / h);
  const x = box.x + (box.width - w * scale) / 2 + mx * scale;
  const y = box.y + (box.height - h * scale) / 2 + my * scale;
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

export const statusOf = (page, sel = '#statusPill') => page.$eval(sel, (el) => el.dataset.status);
export const isOpen = (page, sel) => page.$eval(sel, (el) => !el.hidden);
