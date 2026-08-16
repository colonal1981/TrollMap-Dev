/* TrollMap service worker — v18 (the shell was frozen at v17, 2026-08-16) */
//
// WHAT WENT WRONG, AND WHY THE OLD RULE COULD NOT CATCH IT
//
// The rule below used to read: "Bump CACHE_NAME whenever CORE_ASSETS changes." That guards the
// LIST. The thing that actually goes stale is the CONTENTS of the files in it, and index.html
// was served cache-first out of a cache minted 2026-07-12.
//
// Measured 2026-08-16: 19 commits and 268 inserted lines had landed in index.html since that
// date and NONE of them had ever reached the browser. Ryan picked a lake, saw no conditions
// strip, and said so — the markup was on the server and his shell was five weeks old. Every
// tide panel, Pick Water tab and plan-builder change in that window was in the same boat.
//
// So index.html is NETWORK-FIRST now, exactly like the JS modules, with the cache as the
// OFFLINE fallback rather than the default answer. A shell that can only be refreshed by
// remembering to bump a constant will eventually not be refreshed.
const CACHE_NAME = 'trollmap-v18-2026-08-16';

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

  // Network-first for the app shell and for code — always fresh on reload, falling back to the
  // cache only when the network is actually unavailable.
  //
  // `req.mode === 'navigate'` catches "/" and "/index.html" and any deep link served the same
  // shell; the extension tests catch a direct asset request for the same files.
  const isShell = req.mode === 'navigate'
               || url.pathname.endsWith('.html')
               || url.pathname.endsWith('/');
  if (isShell || url.pathname.endsWith('.js') || url.pathname.endsWith('.json')) {
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

  // Cache-first for everything else — icons and the manifest. Those are safe cache-first
  // because they change roughly never. The shell is not, and that is the distinction the old
  // split got wrong.
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
