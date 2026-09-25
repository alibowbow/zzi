// A deploy must never mix files of two releases: the service worker caches one
// release as a whole, and boot.js compares the page's release with the
// stylesheet's. These tests keep the pieces in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = (file) => readFileSync(join(root, file), 'utf8');

const sw = read('sw.js');
const shell = [...sw.match(/const APP_SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]);

test('one release number in sw.js, index.html and styles.css', () => {
  const worker = sw.match(/const CACHE_VERSION = '([^']+)'/)[1];
  const page = read('index.html').match(/<html[^>]*data-release="([^"]+)"/)[1];
  const css = read('styles.css').match(/--release:\s*"([^"]+)"/)[1];
  assert.equal(page, worker, 'data-release in index.html');
  assert.equal(css, worker, '--release in styles.css');
});

test('the boot guard runs after the stylesheet and before the app', () => {
  const html = read('index.html');
  const css = html.indexOf('href="styles.css"');
  const boot = html.indexOf('<script src="boot.js"></script>');
  const app = html.indexOf('src="app.js"');
  assert.ok(css > 0 && boot > css && app > boot, 'styles.css -> boot.js -> app.js');
});

test('the release cache lists every file the app loads, and only real files', () => {
  for (const file of shell) assert.ok(existsSync(join(root, file)), `listed but missing: ${file}`);
  const walk = (dir) => readdirSync(join(root, dir)).flatMap((name) => {
    const rel = join(dir, name);
    return statSync(join(root, rel)).isDirectory() ? walk(rel) : [relative(root, join(root, rel))];
  });
  const needed = [
    'index.html', 'styles.css', 'boot.js', 'app.js', 'manifest.webmanifest',
    ...walk('src').filter((f) => f.endsWith('.js')),
    ...walk('icons'),
    ...walk('fonts').filter((f) => f.endsWith('.woff2'))
  ];
  for (const file of needed) assert.ok(shell.includes(file), `not in APP_SHELL: ${file}`);
});

test('the web build ships the boot guard', () => {
  assert.match(read('scripts/build-web.mjs'), /'boot\.js'/);
});
