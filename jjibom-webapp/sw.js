// sw.js — classic service worker (no ES module imports here on purpose; a
// classic worker is the most broadly supported). The caching policy mirrors the
// tested helpers in src/swCache.js — keep the two in sync.
//
// One cache per release, filled all or nothing, and every page load is served
// from a single release: files of two releases never mix. A new release is
// fetched in the background, takes over at once, and the page offers a reload
// (see registerServiceWorker in app.js).

// Bump on every deploy, together with data-release in index.html and --release
// in styles.css (test/release.test.js keeps the three in step).
const CACHE_VERSION = 'v8';
const CACHE_PREFIX = 'jjibom-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

// Everything the app loads (test/release.test.js checks nothing is missing).
const APP_SHELL = [
  './index.html',
  './styles.css',
  './boot.js',
  './app.js',
  './manifest.webmanifest',
  './src/config.js',
  './src/stats.js',
  './src/color.js',
  './src/geometry.js',
  './src/blobTracker.js',
  './src/motionCompensation.js',
  './src/biteDetector.js',
  './src/trackingState.js',
  './src/floatTracker.js',
  './src/diagnostics.js',
  './src/swCache.js',
  './src/camera.js',
  './src/alarm.js',
  './src/storage.js',
  './src/demo.js',
  './src/motionConfig.js',
  './src/motionFilter.js',
  './src/motionCalibration.js',
  './src/vibrationDetector.js',
  './src/motionState.js',
  './src/motionSensor.js',
  './src/nativeBridge.js',
  './src/motionController.js',
  './src/motionScenarios.js',
  './src/version.js',
  './src/ui/scene.js',
  './src/ui/seismograph.js',
  './fonts/PretendardVariable-subset.woff2',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', (event) => {
  // The whole release or nothing: if one file fails, this worker is discarded
  // and the current one keeps serving a complete release. `reload` bypasses the
  // HTTP cache (file names are not content-hashed).
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Kept for pages from older releases that still send it.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // don't touch cross-origin
  if (url.pathname.endsWith('/sw.js')) return;
  const isPage = request.mode === 'navigate' && /(?:^|\/)(?:index\.html)?$/.test(url.pathname);
  event.respondWith(fromRelease(request, isPage));
});

// The app page and its files come from this release's cache; anything outside
// the release goes to the network untouched.
async function fromRelease(request, isPage) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(isPage ? './index.html' : request);
  if (cached) return cached;
  return fetch(request);
}
