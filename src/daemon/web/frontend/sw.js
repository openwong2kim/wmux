/* wmux web service worker — minimal app-shell cache.
 *
 * Only registers in a secure context (see app.js). Caches the static shell so
 * the installed PWA opens instantly; API traffic (/api/*) is ALWAYS network —
 * a terminal must never be served stale bytes. */
var CACHE = 'wmux-web-v1';
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
  e.respondWith(
    caches.match(e.request).then(function (hit) { return hit || fetch(e.request); })
  );
});
