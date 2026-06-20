// build-web.mjs — copy the static web assets into ./www so Capacitor can bundle
// them into the Android app. This project has no bundler; the "build" is a copy.
import { cp, rm, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const www = join(root, 'www');

const ASSETS = [
  'index.html', 'styles.css', 'app.js', 'sw.js', 'manifest.webmanifest', 'src', 'icons'
];

await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });
for (const asset of ASSETS) {
  await cp(join(root, asset), join(www, asset), { recursive: true }).catch((e) => {
    console.warn(`skip ${asset}: ${e.message}`);
  });
}
console.log(`Copied web assets to ${www}`);
