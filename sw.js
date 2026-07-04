/* TrollMap service worker — v16 (modular build, 2026-07-04) */
// Bump CACHE_NAME whenever CORE_ASSETS changes — old caches get pruned on activate.
const CACHE_NAME = 'trollmap-v16-2026-07-04';

// Keep this list tight — only assets that MUST be available offline for the
// app shell to load. Everything else (modules, data, worker API calls) is
// served network-first and cached opportunistically.
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  './js/core/state.js',
  './js/core/tabs.js',
  './js/core/map-init.js',
  './js/main.js',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  // Only intercept GET requests for same-origin assets — let API/worker calls
  // and cross-origin tile requests pass through untouched.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Network-first for JS modules — always get fresh code on reload.
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.json')) {
    event.respondWith(
      fetch(req).then(resp => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return resp;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for everything else (HTML shell, icons, manifest).
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(resp => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return resp;
      });
    })
  );
});
