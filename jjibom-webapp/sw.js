// sw.js — classic service worker (no ES module imports here on purpose; a
// classic worker is the most broadly supported). The caching policy mirrors the
// tested helpers in src/swCache.js — keep the two in sync.

// Bump CACHE_VERSION on every deploy so the old app shell is dropped on
// activate. The "v" number is the single source of truth for cache busting.
const CACHE_VERSION = 'v3';
const CACHE_PREFIX = 'jjibom-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

// Files that make up the offline app shell.
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
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
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  // Pre-cache the shell, but do not fail the whole install if one optional file
  // is missing.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.allSettled(
      APP_SHELL.map((url) => cache.add(url))
    ))
  );
  // Do NOT skipWaiting automatically — the page asks the user first.
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

// Let the page trigger activation of a freshly installed worker.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function pickStrategy(pathname, isNavigation) {
  if (isNavigation) return 'network-first';
  if (/\.html?$/.test(pathname)) return 'network-first';
  if (/\.(?:js|mjs|css|webmanifest|json)$/.test(pathname)) return 'swr';
  return 'cache-first';
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // don't touch cross-origin

  const isNavigation = request.mode === 'navigate';
  const strategy = pickStrategy(url.pathname, isNavigation);

  if (strategy === 'network-first') {
    event.respondWith(networkFirst(request));
  } else if (strategy === 'swr') {
    event.respondWith(staleWhileRevalidate(request));
  } else {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    // Fall back to cached page, then to the app shell for navigations.
    return cached || (request.mode === 'navigate' ? cache.match('./index.html') : Response.error());
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || network || fetch(request);
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}
