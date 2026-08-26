// The minimum service worker that makes this page INSTALLABLE, and nothing more.
//
// Chrome will not offer to install a page that has no service worker with a fetch handler, and
// "installed to the home screen" is the one variable the first run of this test could not
// isolate -- Ryan, 2026-08-26: "your test doesn't have an install pwa capability so I can only
// run it in chrome as it is written."
//
// SCOPE IS WHY THIS LIVES IN ITS OWN FOLDER. Registered from /gpstest/, this worker's scope is
// /gpstest/ -- narrower than the app's own root-scoped sw.js, so the more specific one controls
// these pages and NEITHER registration disturbs the other. A second worker at the root scope
// would have replaced TrollMap's.
//
// It caches nothing on purpose. A cache would let the page load while offline and then be
// argued about when a fix goes missing; this measurement needs the page and the network to be
// exactly as ordinary as they are in the app.
self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => { e.respondWith(fetch(e.request)); });
