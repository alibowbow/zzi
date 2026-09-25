// render-icons.mjs — rasterise icons/icon.svg into every PNG the web app and
// the Android app need (launcher, adaptive foreground, maskable, favicon).
// Uses a local Chromium through playwright-core; set CHROMIUM_PATH if it is
// not where Playwright expects it.
//
// Usage: node scripts/render-icons.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(join(root, 'icons/icon.svg'), 'utf8');
const res = join(root, 'android/app/src/main/res');

// kind: 'full' (square, background), 'round' (circle), 'rounded' (legacy
// launcher), 'fg' (adaptive-icon foreground: art only, inside the safe zone).
const jobs = [
  ['icons/icon-192.png', 192, 'full'],
  ['icons/icon-512.png', 512, 'full'],
  ['icons/apple-touch-icon.png', 180, 'full'],
  ['icons/favicon-32.png', 32, 'full']
];
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(densities)) {
  jobs.push([`${res}/mipmap-${d}/ic_launcher.png`, 48 * k, 'rounded']);
  jobs.push([`${res}/mipmap-${d}/ic_launcher_round.png`, 48 * k, 'round']);
  jobs.push([`${res}/mipmap-${d}/ic_launcher_foreground.png`, 108 * k, 'fg']);
}

function page(size, kind) {
  let body = svg;
  if (kind === 'fg') {
    // Adaptive icons mask a 108dp layer down to ~66dp: keep the art (radius
    // ~340 units around its centre) inside that safe zone, no background.
    body = body.replace('viewBox="0 0 1024 1024"', 'viewBox="12 -21 1000 1000"').replace(/<rect class="bg"[^>]*\/>/, '');
  }
  const radius = kind === 'round' ? '50%' : kind === 'rounded' ? '22%' : '0';
  return `<!doctype html><html><head><style>
    html,body{margin:0;background:transparent}
    .i{width:${size}px;height:${size}px;border-radius:${radius};overflow:hidden}
    .i svg{width:100%;height:100%;display:block}
  </style></head><body><div class="i">${body}</div></body></html>`;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ deviceScaleFactor: 1 });
const tab = await ctx.newPage();
for (const [out, size, kind] of jobs) {
  const file = out.startsWith('/') ? out : join(root, out);
  await tab.setViewportSize({ width: size, height: size });
  await tab.setContent(page(size, kind));
  const png = await tab.locator('.i').screenshot({ omitBackground: true });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, png);
}
await browser.close();
console.log(`rendered ${jobs.length} icons`);
