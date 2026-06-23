/* TrollMap service worker — v15 (modular build, 2026-06-23) */
// Bump this whenever CORE_ASSETS changes; old caches get pruned on activate.
const CACHE_NAME = 'trollmap-v15-modular-2026-06-23';

// Core assets to pre-cache on install. All paths are relative to the SW scope.
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  './js/main.js',
  './js/lazy-data.js',
  './js/utils/escape.js',
  './js/utils/dedupe.js',
  './js/utils/rod-row.js',
  './js/utils/db.js',
  './js/utils/geo.js',
  './js/utils/parsers.js',
  './js/data/ramps.js',
  './js/data/lakes.js',
  './js/data/spread-defaults.js',
  './js/core/state.js',
  './js/core/tabs.js',
  './js/core/map-init.js',
  './js/modules/gps.js',
  './js/modules/ramps.js',
  './js/modules/chart-overlay.js',
  './js/modules/chart-mosaic.js',
  './js/modules/chart-import.js',
  './js/modules/custom-vectors.js',
  './js/modules/spread-builder.js',
  './js/modules/saved-spreads.js',
  './js/modules/catch-journal.js',
  './js/modules/garmin-parser.js',
  './js/modules/garmin-export.js',
  './js/modules/file-io.js',
  './js/modules/topbar.js',
  './js/modules/noaa-tides.js',
  './js/modules/duke-energy.js',
  './js/modules/utility-sync.js',
  './js/modules/lake-intel.js',
  './js/modules/plan-builder.js',
  './js/modules/troll-generator.js',
  './js/modules/edit.js',
  './js/modules/track-reverse.js',
  './js/modules/cloud-chartpacks.js',
  './js/modules/contour-job-export.js',
  './js/modules/fishing-index.js',
  './js/modules/measure-tool.js',
  './js/modules/catch-plot.js',
  './js/modules/waypoint-to-generator.js',
  './js/modules/spot-repositioning.js',
  './js/modules/safety-checklist.js',
  './js/modules/gis-toggles.js',
  './js/modules/ble-motor.js',
  './js/modules/wet-hands-remote.js',
  './js/modules/gear-autopilot.js',
  './js/modules/auto-crop.js',
  './js/modules/casting-rings.js',
  './js/modules/catch-photo.js',
  './js/modules/osm-structure.js',
  './js/modules/quickdraw-key.js',
  './js/modules/sw-register.js',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(CORE_ASSETS.map(url => new Request(url, { cache: 'reload' }))).catch(err => {
        console.warn('[TrollMap SW] install cache warning:', err);
      })
    )
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isNavigationRequest(request) {
  return request.mode === 'navigate' || (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'));
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache live APIs; river/lake data must stay live.
  if (url.hostname.includes('workers.dev')
   || url.hostname.includes('waterservices.usgs.gov')
   || url.hostname.includes('api.hydro-derived.duke-energy.app')
   || url.hostname.includes('api.tidesandcurrents.noaa.gov')
   || url.hostname.includes('overpass-api.de')) {
    event.respondWith(fetch(req));
    return;
  }

  // App shell: network-first, fallback to cached index.
  if (isNavigationRequest(req)) {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Local assets/data: cache-first, then network and save.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // External libraries/tiles: network with cache fallback.
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
