// swCache.js — pure helpers describing the service-worker caching policy.
// Imported by the Node tests. sw.js (a classic worker that cannot use ES module
// imports) mirrors this exact logic; keep the two in sync.

export const CACHE_PREFIX = 'jjibom-';

// Old caches to delete on activate: anything with our prefix that is not the
// current release. This is what lets a new deploy drop the previous release.
export function obsoleteCaches(keys, currentName) {
  return keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== currentName);
}

// A navigation to the app itself is answered with the release's index.html;
// every other request is answered with the release's copy of that file, or
// passed to the network when the file is not part of the release.
export function isAppPage(pathname, isNavigation) {
  return Boolean(isNavigation) && /(?:^|\/)(?:index\.html)?$/.test(pathname);
}
