// swCache.js — pure helpers describing the service-worker caching policy.
// Imported by the Node tests. sw.js (a classic worker that cannot use ES module
// imports) mirrors this exact logic; keep the two in sync.

export const CACHE_PREFIX = 'jjibom-';

// Old caches to delete on activate: anything with our prefix that is not the
// current version. This is what lets a new deploy drop a stale app shell.
export function obsoleteCaches(keys, currentName) {
  return keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== currentName);
}

// Choose a fetch strategy for a request.
//  - navigations + HTML  -> 'network-first'  (always try to load the newest app)
//  - JS / CSS / manifest -> 'swr'            (instant, but refresh in background)
//  - icons / images / …  -> 'cache-first'    (rarely change)
export function pickStrategy(pathname, isNavigation = false) {
  if (isNavigation) return 'network-first';
  if (/\.html?$/.test(pathname)) return 'network-first';
  if (/\.(?:js|mjs|css|webmanifest|json)$/.test(pathname)) return 'swr';
  return 'cache-first';
}
