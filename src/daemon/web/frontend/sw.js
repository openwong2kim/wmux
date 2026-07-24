/* wmux web service worker — app-shell cache.
 *
 * Only registers in a secure context (see app.js). Caches the static shell so
 * the installed PWA opens instantly; API traffic (/api/*) is ALWAYS network —
 * a terminal must never be served stale bytes.
 *
 * The shell HTML is network-first, NOT cache-first. terminal.html is rebuilt on
 * every release (the whole app is inlined into it), so a cache-first shell would
 * pin an installed PWA to whatever version it first saw and no update could ever
 * reach it. Online we take the fresh page and refresh the cache; offline we fall
 * back to the last good copy, which is what the cache is actually for. The cache
 * name carries a build stamp so a new worker evicts the previous build outright.
 */
var BUILD = '__BUILD_ID__';
var CACHE = 'wmux-web-' + BUILD;
var SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  // Never cache or intercept the API — always hit the network.
  if (url.pathname.indexOf('/api/') === 0) return;
  if (e.request.method !== 'GET') return;

  var isShell = e.request.mode === 'navigate'
    || url.pathname === '/'
    || url.pathname === '/index.html'
    || url.pathname === '/pair';

  if (isShell) {
    // Network-first: fresh app when online, last good copy when not.
    e.respondWith(
      fetch(e.request)
        .then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put('/', copy); }).catch(function () { /* quota */ });
          return res;
        })
        .catch(function () {
          return caches.match('/').then(function (hit) {
            return hit || Response.error();
          });
        })
    );
    return;
  }

  // Icons and the manifest are immutable enough to serve cache-first.
  e.respondWith(
    caches.match(e.request).then(function (hit) { return hit || fetch(e.request); })
  );
});
