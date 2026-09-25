// Every character the UI can show must be in the bundled Pretendard subset,
// otherwise it silently falls back to another font. Rebuild the subset with
// scripts/subset-font.py after changing UI text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
});

test('the Pretendard subset covers every character in the UI sources', () => {
  const charset = new Set(readFileSync(join(root, 'fonts/charset.txt'), 'utf8'));
  const files = ['index.html', 'app.js', 'manifest.webmanifest', ...walk(join(root, 'src')).map((p) => p.slice(root.length + 1))];
  const missing = new Set();
  for (const f of files) {
    for (const ch of readFileSync(join(root, f), 'utf8')) {
      if (/[ᄀ-ᇿ㄰-㆏가-힣]/.test(ch) && !charset.has(ch)) missing.add(ch);
    }
  }
  assert.equal([...missing].join(''), '', 'run: python3 scripts/subset-font.py PretendardVariable.woff2');
});
