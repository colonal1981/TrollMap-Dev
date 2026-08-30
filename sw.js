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
const CACHE_NAME = 'trollmap-v19-2026-08-26';

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

// ── PUSH: THE ONLY PATH THAT WORKS WITH THE PHONE ASLEEP ────────────────────────────────────
//
// Ryan's phone rides in a PFD pocket, tethered, screen off, and comes out for photographs. That
// is the exact state in which a page's `setInterval` is throttled and then frozen, so the
// in-page hazard poll — the thing carrying NWS warnings — stops the moment the phone goes away.
// Measured, not assumed: the feature worked on the drive there and nowhere else.
//
// A service worker woken by a push runs with the app closed and the screen off. That is the
// whole reason this block exists.
//
// THE PAYLOAD CARRIES THE WORDS, AND IT DID NOT USE TO.
//
// This sent an empty push -- "a tickle" -- and the service worker asked `/alerts/pending` what
// had happened. The stated reasons were that there was no payload crypto to get wrong, and that
// text fetched at wake is current rather than five minutes old. Both were true and neither
// survived contact with the water. Ryan, 2026-08-30:
//
//   > the alert that i got said that there is a weather alert and to open trollmap for more
//   > information... but opening trollmap did not show any popup or anything else... that
//   > notification needs to carry all of the pertinent info, i should not have to open the app
//   > to get it
//
// He is quoting the fallback below. It fires when the fetch returns an empty queue, and it did
// because that queue is in Workers KV, which is eventually consistent -- "up to 60 seconds or
// more", and longer "in locations that have recently accessed an older version of the key". This
// worker reads that key on every single push, so his nearest edge always has a stale copy of it.
// The Worker wrote the queue before pushing and could not have helped: the push takes a second
// and the write takes up to a minute to be visible.
//
// So Worker/webpush.js encrypts the alert into the push (RFC 8291 over RFC 8188, checked against
// the RFC's own worked example). Nothing is fetched, nothing can be stale, and the notification
// is drawn from bytes that are already on the phone.
//
// AND THE SECOND HALF OF WHAT HE FOUND. "Open TrollMap for the details" was not just unhelpful,
// it was untrue: nothing in the app reads that queue. The in-page path polls NWS live and only
// while a trip is running, so a phone told to open the app for details is told to do something
// that cannot work. The fallbacks below now say what is actually wrong and what actually fixes
// it, and they only ever run for a device registered before payloads existed.

const CFG_CACHE = 'trollmap-cfg';
const CFG_KEY = '/__worker_url';

/** The Worker base URL, written here by the client when it subscribes. */
async function workerBase() {
  try {
    const c = await caches.open(CFG_CACHE);
    const r = await c.match(CFG_KEY);
    if (r) return (await r.text()).replace(/\/+$/, '');
  } catch (_) { /* fall through */ }
  return null;
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    // THE ORDINARY PATH, AND IT NEEDS NOTHING ELSE. One alert, already decrypted by the browser.
    let carried = null;
    try { carried = event.data ? event.data.json() : null; } catch (_) { carried = null; }
    if (carried && (carried.title || carried.body)) {
      await show(carried);
      return;
    }

    const base = await workerBase();
    // IDENTIFY BY THE SUBSCRIPTION ITSELF. The endpoint is the only stable name this worker and
    // the server both already know, so nothing extra has to be stored or kept in sync.
    let endpoint = null;
    try {
      const sub = await self.registration.pushManager.getSubscription();
      endpoint = sub && sub.endpoint;
    } catch (_) { /* handled below */ }

    // A PUSH THAT ARRIVES AND SHOWS NOTHING IS WORSE THAN NO PUSH. Chrome will surface its own
    // generic "site updated in the background" notice if a push event ends without one, which
    // tells him something happened and not what. So every failure path below still shows
    // something true.
    if (!base || !endpoint) {
      await self.registration.showNotification('⚠️ TrollMap alert', {
        body: 'An alert fired and this device cannot read the details. '
            + 'Switch notifications off and on again in TrollMap to fix it.',
        icon: './icons/icon-192.svg', tag: 'alert-degraded', requireInteraction: true,
      });
      return;
    }

    let alerts = [];
    try {
      const r = await fetch(`${base}/alerts/pending`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint }),
        cache: 'no-store',
      });
      if (r.ok) {
        const j = await r.json();
        alerts = Array.isArray(j && j.alerts) ? j.alerts : [];
      }
    } catch (_) { /* handled below */ }

    if (!alerts.length) {
      // THIS IS THE ONE HE READ, and it used to say "Open TrollMap for the details" -- which the
      // app cannot supply. It now names the real problem and the one action that ends it.
      await self.registration.showNotification('⚠️ TrollMap alert', {
        body: 'An alert fired but its text did not reach this device. '
            + 'Switch notifications off and on again in TrollMap so alerts arrive in full.',
        icon: './icons/icon-192.svg', tag: 'alert-unread', requireInteraction: true,
      });
      return;
    }

    for (const a of alerts) await show(a);
  })());
});

/** One notification, however it arrived — carried in the push or fetched by a legacy device. */
async function show(a) {
  await self.registration.showNotification(a.title || '⚠️ NWS alert', {
    body: a.body || '',
    icon: './icons/icon-192.svg',
    // `renotify` needs a tag, and both together are what make a SECOND, worse warning buzz
    // again instead of silently replacing the first one in the tray.
    tag: a.tag || 'nws-hazard',
    renotify: true,
    // A weather warning does not dismiss itself while he is deciding whether to run for the
    // ramp. Everything else in this app auto-closes after 8 seconds; this must not.
    requireInteraction: a.severity === 'stop',
    data: { url: a.url || './' },
  });
}

// Tapping the notification should land on the app, not a second copy of it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { await c.focus(); return; } catch (_) { /* open instead */ } }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

// A SUBSCRIPTION CAN BE ROTATED BY THE BROWSER WITHOUT ASKING. When that happens the old
// endpoint stops working and the server keeps pushing into the void, which reads exactly like
// calm weather. Re-register immediately with the same key.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const base = await workerBase();
    if (!base) return;
    try {
      const r = await fetch(`${base}/alerts/vapid-public`, { cache: 'no-store' });
      const { key } = await r.json();
      if (!key) return;
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      await fetch(`${base}/alerts/resubscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          old: event.oldSubscription ? event.oldSubscription.endpoint : null,
          subscription: sub.toJSON(),
        }),
      });
    } catch (_) { /* nothing useful to do here; the client re-subscribes on next trip start */ }
  })());
});
