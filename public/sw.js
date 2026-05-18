// Minimal service worker: cache the static shell so the app boots offline.
// The WebSocket itself obviously still needs the network — but the landing
// page and bundle will render instantly and show a connection-error state
// instead of a blank "no internet" page.
const CACHE_NAME = 'dab-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/theme-init.js',
  '/dist/landing.js',
  '/dist/client.js',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never cache the WebSocket party or any partykit traffic
  if (url.hostname.endsWith('.partykit.dev')) return;
  // Only handle same-origin GETs
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  // Network-first for HTML so updates land immediately when online
  if (event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request) || caches.match('/'))
    );
    return;
  }

  // Cache-first for static assets (JS, CSS, manifest)
  event.respondWith(
    caches.match(event.request).then((cached) =>
      cached ||
      fetch(event.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
        }
        return res;
      })
    )
  );
});
