// boot.js — runs before the app, right after the stylesheet has loaded.
//
// A page must never run on files from two releases. Service workers up to v7
// answered scripts and styles from their cache while the HTML came fresh from
// the network, so the first visit after a deploy could start new HTML with the
// previous release's code and styles, and fail. The stylesheet carries the
// release it belongs to; when it does not match this page, the old caches are
// dropped and the page loads once more, now entirely from the new release.
(function () {
  var root = document.documentElement;
  var page = root.getAttribute('data-release');
  var css = getComputedStyle(root).getPropertyValue('--release').replace(/["'\s]/g, '');
  if (!page || css === page) return;

  // One attempt per release and tab, so a failing network can never loop.
  var key = 'jjibom-boot-reload';
  try {
    if (sessionStorage.getItem(key) === page) return;
    sessionStorage.setItem(key, page);
  } catch (e) {
    return;
  }

  root.style.visibility = 'hidden';
  var reload = function () { location.reload(); };
  if (!window.caches) { reload(); return; }
  caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (name) {
      return name.indexOf('jjibom-') === 0 && name !== 'jjibom-' + page;
    }).map(function (name) { return caches.delete(name); }));
  }).then(reload, reload);
})();
