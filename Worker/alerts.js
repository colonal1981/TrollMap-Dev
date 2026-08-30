/**
 * Web Push, because the phone is asleep in a PFD pocket.
 *
 * WHAT THIS REPLACES, AND WHY THE THING IT REPLACES COULD NEVER HAVE WORKED.
 *
 * `js/modules/notifications.js` polls `/hazards` on a five-minute `setInterval` IN THE PAGE.
 * That requires the page to be open. Ryan, 2026-08-26: "i do not use trollmap on the water."
 * His phone rides in a PFD pocket, tethered, screen off, and comes out for photographs; the
 * Echomap is the thing he actually looks at. So the in-page poll was not merely throttled on the
 * water — it was never running at all, because nothing had it open.
 *
 * This is not the other half of that feature. It is the only half that can exist. A push wakes
 * a service worker with no page, no tab and a locked screen, and the notification it raises is
 * an ordinary OS notification — which is what Garmin Connect mirrors to the Echomap, the chain
 * Ryan described on 2026-08-25: "the notifications.js that sends alerts from my phone to the
 * garmin echomap".
 *
 * THE PHONE MUST HAVE OPENED THE APP ONCE, EVER, to register a service worker and a
 * subscription. Once. On the couch. Never on the water.
 *
 * A DEVICE AND A TRIP ARE TWO DIFFERENT THINGS, AND CONFLATING THEM PUT THE ALERTS ON THE WRONG
 * MACHINE. The first version of this file subscribed whichever browser loaded the plan. Ryan,
 * 2026-08-26: "but i dont plan from my phone." He plans at a desk and fishes with a phone in a
 * PFD pocket, so that design would have delivered every warning to a computer at home while he
 * was on the water. Caught before deployment, and only because he said so.
 *
 * So:
 *
 *   A DEVICE registers ONCE and stays registered. The phone opens the app, grants permission,
 *   and says "send alerts here". `device:<id>` outlives every trip.
 *
 *   A TRIP WATCH is created by whatever machine does the planning and names a place and a time,
 *   never a browser. `watch:<id>` expires at the return time.
 *
 * The cron joins them: for each active watch it asks `handleHazards` — THE SAME FUNCTION THE
 * CLIENT CALLS, not a second copy — diffs against what that watch has already reported, and
 * pushes anything new to EVERY registered device. The service worker wakes, asks
 * `/alerts/pending` what happened, and shows it.
 *
 * A WATCH WITH NO DEVICES IS REPORTED, NOT SILENT. `/alerts/watch` returns the device count, so
 * the desk that created it can say "nothing will receive this" instead of looking like it armed
 * something. A safety feature that quietly protects nobody is worse than one that is off.
 *
 * BOTH ROUTES THAT WRITE ARE BEHIND `X-Sync-Token`, the same guard the sync routes already use.
 * Without it anyone who learned the URL could point Ryan's phone at a lake he is not on.
 *
 * WHY THE PUSH CARRIES NO PAYLOAD. Encrypting one means implementing aes128gcm — ECDH, HKDF,
 * AES-GCM — by hand, and getting it subtly wrong produces a push that silently never displays.
 * A data-less push needs only the VAPID signature below. It also means the words shown are
 * fetched when the phone wakes rather than when the alert was sent, so a warning that was
 * upgraded or cancelled in between says what is true now.
 *
 * CREDENTIALS ARE NOT HANDLED HERE AND WERE NEVER SEEN BY THE SESSION THAT WROTE THIS. Ryan
 * generates the keypair and sets the secrets himself; `readJwk` accepts either form these keys
 * come in, so whichever tool produced them works:
 *
 *     npx web-push generate-vapid-keys        ->  VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY
 *     a Node P-256 JWK export                 ->  VAPID_PRIVATE_JWK
 *
 * BOTH HALVES ARE NEEDED IN THE FIRST FORM. The private half is the raw scalar and WebCrypto
 * cannot import an EC private key without the public point; see `readJwk`. The public half is
 * public by design — it is handed to every browser that subscribes.
 *
 * The browser's `applicationServerKey` is DERIVED from whatever is configured and served from
 * `/alerts/vapid-public`, so nothing has to be copied into the client and nothing can drift.
 */

import { encryptPush, payloadHeaders } from './webpush.js';

import { CORS, JSON_HEADERS, isAuthorized } from './worker-core.js';
import { handleHazards } from './conditions.js';

const TTL_SECONDS = 900;          // how long the push service should hold an undelivered push
const MAX_WATCH_HOURS = 18;       // a trip is a day; a watch that outlives one is a bug
const SWEEP_CONCURRENCY = 6;

// ── base64url, which is the only encoding anything in Web Push speaks ───────────────────────
const b64urlFromBytes = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const bytesFromB64url = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const utf8 = (s) => new TextEncoder().encode(s);

/**
 * The signing key, in EITHER of the two forms these keys come in. The value is never logged,
 * never returned, and never leaves this function except as a signature.
 *
 * FORM 1 — `VAPID_PRIVATE_JWK`: a full JWK, which is what a Node keypair exports.
 *
 * FORM 2 — `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY`: what `npx web-push generate-vapid-keys`
 * prints, and the pair most people already have. BOTH ARE REQUIRED IN THIS FORM, and the reason
 * is not arbitrary: the private half is the raw 32-byte scalar `d`, and WebCrypto cannot import
 * an EC private key without `x` and `y`. Deriving those from `d` is point multiplication, which
 * WebCrypto does not expose. The public half IS `x` and `y` concatenated after an 0x04 tag — so
 * the pair assembles a JWK and the private scalar alone cannot.
 */
function readJwk(env) {
  const raw = env && env.VAPID_PRIVATE_JWK;
  if (raw) {
    try {
      const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
      // Rebuilt field by field rather than passed through: Node's JWK export carries no `ext`
      // and some runtimes refuse an import without it, which fails as "invalid key" a long way
      // from the cause.
      if (j && j.x && j.y && j.d) return { kty: 'EC', crv: 'P-256', x: j.x, y: j.y, d: j.d, ext: true };
    } catch (_) { /* fall through to form 2 */ }
  }
  const pub = env && env.VAPID_PUBLIC_KEY;
  const priv = env && env.VAPID_PRIVATE_KEY;
  if (pub && priv) {
    try {
      const p = bytesFromB64url(pub);
      if (p.length === 65 && p[0] === 4) {
        return {
          kty: 'EC', crv: 'P-256',
          x: b64urlFromBytes(p.slice(1, 33)),
          y: b64urlFromBytes(p.slice(33, 65)),
          d: String(priv).trim(),
          ext: true,
        };
      }
    } catch (_) { return null; }
  }
  return null;
}

/**
 * WHICH PIECE IS MISSING, in words, for `/alerts/vapid-public` to return.
 *
 * Ryan sets these secrets himself and this session never sees their values, so the only way he
 * can tell a typo from a missing variable is if the Worker says which. "Not configured" and
 * "configured wrong" are different jobs.
 */
function vapidProblem(env) {
  if (!env) return 'no environment';
  if (env.VAPID_PRIVATE_JWK) return 'VAPID_PRIVATE_JWK is set but is not a P-256 private JWK (needs x, y and d)';
  const pub = env.VAPID_PUBLIC_KEY;
  const priv = env.VAPID_PRIVATE_KEY;
  if (priv && !pub) {
    return 'VAPID_PRIVATE_KEY is set but VAPID_PUBLIC_KEY is not. The private key alone cannot be'
         + ' used: WebCrypto needs the public point to import it. Add the public key from the same'
         + ' `npx web-push generate-vapid-keys` output — it is public by design and ships to every'
         + ' browser anyway.';
  }
  if (pub && !priv) return 'VAPID_PUBLIC_KEY is set but VAPID_PRIVATE_KEY is not.';
  if (pub && priv) return 'both keys are set but VAPID_PUBLIC_KEY is not a 65-byte uncompressed P-256 point';
  return 'neither VAPID_PRIVATE_JWK nor VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY is set';
}

/**
 * The application server key the BROWSER needs, derived from the private key so there is only
 * ever one secret to manage. It is the uncompressed P-256 point: 0x04 ‖ x ‖ y.
 */
export function applicationServerKey(jwk) {
  if (!jwk) return null;
  const x = bytesFromB64url(jwk.x);
  const y = bytesFromB64url(jwk.y);
  if (x.length !== 32 || y.length !== 32) return null;
  const out = new Uint8Array(65);
  out[0] = 4;
  out.set(x, 1);
  out.set(y, 33);
  return b64urlFromBytes(out);
}

/**
 * A VAPID Authorization header for one push endpoint (RFC 8292).
 *
 * `aud` is the push service's ORIGIN, not the endpoint, and a JWT minted for the wrong audience
 * is rejected with a 401 that says nothing useful.
 */
export async function vapidAuth(endpoint, env, nowMs) {
  const jwk = readJwk(env);
  if (!jwk) return null;
  const aud = new URL(endpoint).origin;
  const now = Math.floor((nowMs || Date.now()) / 1000);
  const header = b64urlFromBytes(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  // `sub` must be a contact URI. THE APP'S OWN URL, NEVER RYAN'S EMAIL -- this header is sent to
  // Google's push service on every alert, and his address has no business travelling with it.
  const payload = b64urlFromBytes(utf8(JSON.stringify({
    aud, exp: now + 12 * 3600, sub: env.VAPID_SUBJECT || 'https://trollmap.pages.dev',
  })));
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto returns ECDSA signatures as raw r‖s, which is exactly what ES256 wants. A DER
  // signature here is the classic silent 401.
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, utf8(`${header}.${payload}`));
  const jwt = `${header}.${payload}.${b64urlFromBytes(new Uint8Array(sig))}`;
  return { Authorization: `vapid t=${jwt}, k=${applicationServerKey(jwk)}` };
}

// NO-STORE ON EVERY ONE OF THESE, AND IT IS NOT A MICRO-OPTIMISATION.
//
// A status endpoint that can be cached lies for as long as the cache lives. On 2026-08-26 both
// Ryan and this session read `devices: 0` from a cached /alerts/status while the Worker had
// already stored the device -- he re-toggled the bell, I re-checked my own wiring, and the
// answer had been correct the whole time. Twice, independently, from the same stale body.
//
// Every route in this file reports LIVE STATE or drains a queue. None of it is cacheable, and
// the cost of a stale answer here is somebody debugging a system that is already working.
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { ...JSON_HEADERS, ...CORS, 'Cache-Control': 'no-store, max-age=0' },
  });

/**
 * Ask the SAME hazard code the client asks. Not a copy of it.
 *
 * Two paths to one fact is how two answers to one question start disagreeing, and this codebase
 * has been bitten by it repeatedly. `handleHazards` returns a Response; parsing it back is a
 * trivially small price for there being exactly one implementation of "what is over this point".
 */
async function hazardsAt(lat, lon, env) {
  const u = new URL(`https://internal/hazards?lat=${lat}&lon=${lon}`);
  const res = await handleHazards(new Request(u.toString()), env, u);
  if (!res || !res.ok) return null;
  const j = await res.json();
  return (j && Array.isArray(j.items)) ? j : null;
}

/**
 * THE TARGET DISPLAY IS A CHARTPLOTTER, NOT A PHONE SCREEN.
 *
 * Ryan photographed a live notification on the Echomap on 2026-08-26: a title line and two
 * smaller body lines, in plain marine type, with Review and Dismiss. That is where these words
 * land — the phone is only the courier, and he does not look at it.
 *
 * So the emoji come off. Every title in this app carries one (a warning sign, a fish, a stopwatch)
 * and they are decoration for a notification tray. A Garmin marine unit renders a limited glyph
 * set, and a leading character that lands as an empty box costs the first and most-read position
 * on the line. Not measured on his unit, and that is exactly why it is not risked: a box tells him
 * nothing and a word tells him everything.
 *
 * Anything above Latin-1 goes, then the whitespace it left behind.
 */
export function forEchomap(text) {
  return String(text == null ? '' : text)
    .replace(/[^\x20-\xFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The words that reach the Echomap. Severity decides the verb, not the app's own guess. */
function alertFor(h) {
  const stop = h.severity === 'Warning' || (h.severity === 'Statement' && h.storm === true);
  return {
    title: forEchomap(stop ? 'NWS WARNING' : `NWS ${h.severity || 'alert'}`),
    body: forEchomap([h.type, h.ends ? `until ${String(h.ends).replace('T', ' ').slice(0, 16)}` : null]
      .filter(Boolean).join(' - ')),
    tag: `nws-${h.id || h.type}`,
    severity: stop ? 'stop' : 'note',
    url: h.url || './',
  };
}

/**
 * Send ONE alert to ONE device, with the words inside it.
 *
 * THIS USED TO SEND NOTHING AT ALL. It was a "tickle" -- VAPID headers and an empty body -- and
 * the service worker fetched `/alerts/pending` on wake to find out what had happened. Ryan,
 * 2026-08-30, holding the result: "the alert that i got said that there is a weather alert and
 * to open trollmap for more information... but opening trollmap did not show any popup or
 * anything else... that notification needs to carry all of the pertinent info, i should not
 * have to open the app to get it."
 *
 * He read sw.js's fallback verbatim, and the reason it fired is Workers KV. The queue is written
 * before the push and a comment below still says so, but ordering a write ahead of a push does
 * not buy read-after-write consistency across colos and KV never offered it: "Changes may take
 * up to 60 seconds or more to be visible in other global network locations", and longer still
 * "in locations that have recently accessed an older version of the key" -- which is every
 * location his phone has ever woken in, because the service worker reads that key on every push.
 * The wake beats the write, the queue reads empty, and the phone is told to go and look somewhere
 * that has nothing to show it.
 *
 * A DEVICE WITH NO KEYS STILL GETS THE OLD PATH. `subscription.keys` has always been sent by the
 * client and was simply dropped on the floor here, so every device registered before today has a
 * record without them and cannot be encrypted for until it re-registers -- which the app does on
 * its own the next time notifications are switched on. Until then it gets the tickle, and the
 * service worker's fallback now says that plainly instead of promising details the app does not
 * have.
 *
 * Returns 'ok' | 'gone' | 'fail'.
 */
async function pushTo(device, alert, env, nowMs) {
  const endpoint = typeof device === 'string' ? device : device.endpoint;
  const keys = typeof device === 'string' ? null : device.keys;
  const auth = await vapidAuth(endpoint, env, nowMs);
  if (!auth) return 'fail';
  let extra = {};
  let payload;
  if (alert && keys && keys.p256dh && keys.auth) {
    try {
      payload = await encryptPush(JSON.stringify(alert), keys.p256dh, keys.auth);
      extra = payloadHeaders(payload.length);
    } catch (_) {
      // AN UNENCRYPTABLE SUBSCRIPTION IS NOT A REASON TO SEND NOTHING. Fall back to the tickle:
      // a phone that wakes and reads a queue is worse than one that reads a payload, and far
      // better than a warning that never leaves Cloudflare.
      payload = undefined;
    }
  }
  let r;
  try {
    r = await fetch(endpoint, {
      method: 'POST',
      headers: { ...auth, ...extra, TTL: String(TTL_SECONDS), Urgency: 'high' },
      ...(payload ? { body: payload } : {}),
    });
  } catch (_) { return 'fail'; }
  // 404 and 410 are the push service saying this subscription is dead. Anything else that fails
  // is transient and the watch stays, because deleting a watch on a 500 loses the trip.
  if (r.status === 404 || r.status === 410) return 'gone';
  return r.ok ? 'ok' : 'fail';
}

const CUE_LEAD_MS = 5 * 60 * 1000;   // one cron period: cues fire early, never late

const nowIso = () => new Date().toISOString();

async function shortHash(s) {
  const h = await crypto.subtle.digest('SHA-256', utf8(String(s)));
  return b64urlFromBytes(new Uint8Array(h)).slice(0, 24);
}

/** KV key for a DEVICE. The endpoint is long and contains '/', so it is hashed. */
export async function deviceKey(endpoint) {
  return `device:${await shortHash(endpoint)}`;
}

// ── routes ──────────────────────────────────────────────────────────────────────────────────

export async function handleAlerts(request, env, url) {
  const p = url.pathname.replace(/\/+$/, '');
  if (!p.startsWith('/alerts')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (!env || !env.KV) return json({ error: 'KV not bound' }, 500);

  const body = request.method === 'POST'
    ? await request.json().catch(() => null) : null;

  if (p === '/alerts/vapid-public') {
    const key = applicationServerKey(readJwk(env));
    // AN ABSENT KEY IS A CONFIGURATION FACT, NOT A CRASH. Say which piece is missing, because
    // Ryan sets these secrets himself and "not configured" and "configured wrong" are different
    // jobs with different fixes.
    return key ? json({ key }) : json({ key: null, error: vapidProblem(env) }, 503);
  }

  // ── A DEVICE. Registered ONCE, from the phone, and never again ────────────────────────────
  //
  // This is the correction that mattered most in this whole build. The first version subscribed
  // whichever browser loaded the plan, and Ryan plans at a desk — so every warning would have
  // arrived on a computer at home. A device is a place alerts GO. It has nothing to do with
  // where planning happens and it outlives every trip.
  if (p === '/alerts/device' && request.method === 'POST') {
    if (!await isAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
    const sub = body && body.subscription;
    if (!sub || !sub.endpoint) return json({ error: 'subscription required' }, 400);
    const k = await deviceKey(sub.endpoint);
    const prev = await env.KV.get(k);
    const rec = {
      endpoint: sub.endpoint,
      // THE TWO KEYS THAT LET THE WORDS TRAVEL, and they were being dropped on the floor.
      //
      // The client has always sent `sub.toJSON()`, which carries `keys.p256dh` (the device's
      // public P-256 point) and `keys.auth` (sixteen bytes of shared secret). This record kept
      // the endpoint and the label and discarded them, so there was nothing to encrypt a payload
      // WITH -- which is why every push was empty and every notification had to send him to the
      // app to find out what it was about. See pushTo().
      keys: (sub.keys && sub.keys.p256dh && sub.keys.auth)
        ? { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } : null,
      // A LABEL, NEVER A FINGERPRINT. Enough to tell "the Pixel" from "the desktop" in a list
      // of two, and nothing that identifies a person or follows one anywhere.
      label: String((body && body.label) || 'device').slice(0, 40),
      created: prev ? (JSON.parse(prev).created || nowIso()) : nowIso(),
      seen_at: nowIso(),
      pending: prev ? (JSON.parse(prev).pending || []) : [],
    };
    await env.KV.put(k, JSON.stringify(rec));
    return json({ ok: true, label: rec.label, registered: rec.created });
  }

  if (p === '/alerts/device' && request.method === 'DELETE') {
    if (!await isAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
    const ep = url.searchParams.get('endpoint');
    if (ep) await env.KV.delete(await deviceKey(ep));
    return json({ ok: true });
  }

  if (p === '/alerts/devices') {
    const list = await env.KV.list({ prefix: 'device:' });
    const out = [];
    for (const e of list.keys) {
      const raw = await env.KV.get(e.name);
      if (!raw) continue;
      try {
        const d = JSON.parse(raw);
        // THE ENDPOINT NEVER LEAVES. It is the address of Ryan's phone; a list that shows it
        // hands anyone who can read this route the ability to push to it.
        // `carries_words` is the one thing worth knowing about a device now: without keys it
        // can only be tickled, and its alerts arrive as a prompt to open the app.
        out.push({ label: d.label, registered: d.created, pending: (d.pending || []).length,
                   carries_words: !!(d.keys && d.keys.p256dh && d.keys.auth) });
      } catch (_) { /* skip a corrupt record rather than failing the list */ }
    }
    return json({ devices: out, count: out.length });
  }

  // ── A TRIP WATCH. Created by whatever machine plans, targets every device ─────────────────
  if (p === '/alerts/watch' && request.method === 'POST') {
    if (!await isAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
    const lat = Number(body && body.lat);
    const lon = Number(body && body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: 'lat/lon required' }, 400);

    const now = Date.now();
    const asked = Date.parse((body && body.until) || '');
    const until = Math.min(Number.isFinite(asked) ? asked : now + MAX_WATCH_HOURS * 3600e3,
                           now + MAX_WATCH_HOURS * 3600e3);

    // THE PLAN'S OWN SCHEDULE, CARRIED SERVER-SIDE. Ryan, 2026-08-26: "i want bait changes, and
    // everything else sent as notifications to the echomap." Those cues fire today from a
    // 30-second interval in the page, and the page is not open on the water — so band changes,
    // solunar windows and the return-time warning have never been deliverable either. They are
    // not weather, so no poll can rediscover them; they have to travel with the watch.
    const cues = Array.isArray(body && body.cues) ? body.cues.slice(0, 60).map((c) => ({
      at: c && c.at ? String(c.at) : null,
      // Stripped HERE, at the one place every cue enters, rather than trusting each producer.
      title: forEchomap((c && c.title) || 'TrollMap').slice(0, 80),
      body: forEchomap((c && c.body) || '').slice(0, 240),
      tag: String((c && c.tag) || 'cue').slice(0, 40),
      severity: c && c.severity === 'stop' ? 'stop' : 'note',
      fired: false,
    })).filter((c) => c.at && Number.isFinite(Date.parse(c.at))) : [];

    const rec = {
      lat, lon, until: new Date(until).toISOString(),
      water: (body && body.water) || null, slug: (body && body.slug) || null,
      seen: [], cues, created: nowIso(),
    };
    const k = `watch:${await shortHash(`${lat},${lon},${rec.until}`)}`;
    await env.KV.put(k, JSON.stringify(rec),
                     { expirationTtl: Math.max(120, Math.ceil((until - now) / 1000) + 900) });

    // A WATCH WITH NO DEVICES PROTECTS NOBODY, and the desk that created it must be told so
    // rather than shown a tick. This return value is the only place that can say it.
    const devices = (await env.KV.list({ prefix: 'device:' })).keys.length;
    return json({ ok: true, watch: k, until: rec.until, cues: cues.length, devices,
                  warning: devices ? null : 'no device is registered to receive these alerts' });
  }

  if (p === '/alerts/pending' && request.method === 'POST') {
    // NOT TOKEN-GUARDED, ON PURPOSE. The service worker calls this on wake and has no way to
    // hold a secret that a page can. Knowing an endpoint is already the capability to push to
    // it, so this grants nothing that endpoint did not already have — and it returns only that
    // one device's queue.
    const ep = body && body.endpoint;
    if (!ep) return json({ error: 'endpoint required' }, 400);
    const k = await deviceKey(ep);
    const raw = await env.KV.get(k);
    if (!raw) return json({ alerts: [] });
    let rec;
    try { rec = JSON.parse(raw); } catch (_) { return json({ alerts: [] }); }
    const alerts = rec.pending || [];
    if (alerts.length) {
      // DRAINED ON READ. A queue that is not cleared re-shows the same warning on every
      // subsequent push, which teaches him to ignore the one that matters.
      rec.pending = [];
      rec.seen_at = nowIso();
      await env.KV.put(k, JSON.stringify(rec));
    }
    return json({ alerts });
  }

  // ── THE LAST MILE, ON DEMAND ──────────────────────────────────────────────────────────────
  //
  // Everything else can be verified from a desk: the keys resolve, the token is accepted, the
  // subscription is in KV, `devices` counts 2. NONE OF THAT PROVES A PUSH ARRIVES. The only
  // untested link is Cloudflare -> Google's push service -> a phone with the app closed and the
  // screen off, and that is the entire reason this feature exists.
  //
  // The cron cannot prove it on demand: it fires only when a cue comes due or NWS issues
  // something, so waiting for it means waiting for weather. This queues one real alert to every
  // registered device and pushes it through the real path, and RETURNS WHAT EACH DEVICE SAID --
  // 'ok', 'gone' for a retired subscription, or 'fail' for anything else. A silent 403 from a
  // mis-signed JWT looks identical to calm weather until somebody asks.
  if (p === '/alerts/test' && request.method === 'POST') {
    if (!await isAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
    const alert = {
      title: forEchomap((body && body.title) || 'TrollMap push test'),
      body: forEchomap((body && body.body)
        || 'If this reached the Echomap with the app closed, the alert path works.'),
      tag: 'push-test', severity: 'note', url: './',
    };
    const list = (await env.KV.list({ prefix: 'device:' })).keys;
    const results = [];
    for (const e of list) {
      const raw = await env.KV.get(e.name);
      if (!raw) continue;
      let d;
      try { d = JSON.parse(raw); } catch (_) { continue; }
      // Queued BEFORE the push, same as the sweep: a phone that wakes and is told nothing reads
      // as a false alarm, which is the fastest way to teach him to ignore this channel.
      const carries = !!(d.keys && d.keys.p256dh && d.keys.auth);
      // Queued for every device, same rule as the sweep and for the same reason: the service
      // worker that receives this may be older than the Worker that sent it.
      d.pending = [...(d.pending || []), alert].slice(-20);
      await env.KV.put(e.name, JSON.stringify(d));
      const res = await pushTo(d, carries ? alert : null, env, Date.now());
      if (res === 'gone') await env.KV.delete(e.name);
      results.push({ label: d.label, result: res, carries_words: carries });
    }
    return json({ sent: results.length, results });
  }

  if (p === '/alerts/status') {
    const [devices, watches] = await Promise.all([
      env.KV.list({ prefix: 'device:' }), env.KV.list({ prefix: 'watch:' }),
    ]);
    const key = applicationServerKey(readJwk(env));
    // THE REASON TRAVELS ON THE 200, NOT ONLY ON THE 503.
    //
    // `/alerts/vapid-public` answers 503 when it cannot build a key, which is the correct status
    // and makes the body unreadable to most tooling -- a diagnostic nobody can read is not a
    // diagnostic. Found 2026-08-26 trying to tell Ryan why his configured secrets were not
    // taking, and being unable to see my own error message.
    //
    // `seen` reports PRESENCE ONLY -- never a value, never a prefix, never a length that could
    // narrow one. Whether a variable is set is a configuration fact; what it contains is a secret.
    return json({
      configured: !!key,
      problem: key ? null : vapidProblem(env),
      seen: {
        VAPID_PUBLIC_KEY: !!(env && env.VAPID_PUBLIC_KEY),
        VAPID_PRIVATE_KEY: !!(env && env.VAPID_PRIVATE_KEY),
        VAPID_PRIVATE_JWK: !!(env && env.VAPID_PRIVATE_JWK),
      },
      devices: devices.keys.length,
      active_watches: watches.keys.length,
    });
  }

  return json({ error: 'unknown alerts route' }, 404);
}

// ── the cron ────────────────────────────────────────────────────────────────────────────────

/**
 * Every active watch, once per firing: due cues first, then new weather.
 *
 * CUES FIRE EARLY, NEVER LATE. The cron granularity is five minutes, so a cue timed for 09:07
 * would be delivered at 09:10 — three minutes after the band he was told to change into. The
 * window below is the CRON PERIOD itself, not a number anybody picked: a cue becomes due one
 * period before its time, which turns worst-case-late into worst-case-early. "Switch to the
 * 15-20 ft band in ten minutes" arriving fifteen minutes out is useful; arriving three minutes
 * after the change is noise.
 *
 * NOTHING IS SENT TWICE. `fired` is per cue and `seen` is per hazard, both stored with the
 * watch, so an eight-hour Severe Thunderstorm Watch buzzes once when it is issued rather than
 * ninety-six times, and a band change fires once rather than on every sweep until the trip ends.
 */
export async function runAlertSweep(env, nowMs) {
  const now = nowMs || Date.now();
  const out = { checked: 0, expired: 0, cues: 0, new_alerts: 0, pushed: 0, gone: 0, failed: 0, devices: 0 };
  if (!env || !env.KV) return out;

  const devKeys = (await env.KV.list({ prefix: 'device:' })).keys;
  out.devices = devKeys.length;
  const watchKeys = (await env.KV.list({ prefix: 'watch:' })).keys;

  // Collected per sweep rather than per watch: two watches on one day should not each pay for
  // the device list, and a device that dies mid-sweep should be retired once.
  const devices = [];
  for (const e of devKeys) {
    const raw = await env.KV.get(e.name);
    if (!raw) continue;
    try { devices.push({ key: e.name, rec: JSON.parse(raw) }); } catch (_) { /* skip */ }
  }

  const queued = [];                                  // [{ alert }] for THIS firing
  for (const e of watchKeys) {
    const raw = await env.KV.get(e.name);
    if (!raw) continue;
    let w;
    try { w = JSON.parse(raw); } catch (_) { await env.KV.delete(e.name); continue; }
    out.checked += 1;

    if (Date.parse(w.until) <= now) { await env.KV.delete(e.name); out.expired += 1; continue; }

    let dirty = false;
    for (const c of (w.cues || [])) {
      if (c.fired) continue;
      if (Date.parse(c.at) - CUE_LEAD_MS > now) continue;
      c.fired = true; dirty = true; out.cues += 1;
      queued.push({ title: c.title, body: c.body, tag: c.tag, severity: c.severity, url: './' });
    }

    const j = await hazardsAt(w.lat, w.lon, env);
    if (j) {
      const seen = new Set(w.seen || []);
      const fresh = (j.items || []).filter((h) => h && h.id && !seen.has(h.id));
      if (fresh.length) {
        for (const h of fresh) seen.add(h.id);
        w.seen = [...seen].slice(-200);
        dirty = true;
        out.new_alerts += fresh.length;
        for (const h of fresh) queued.push(alertFor(h));
      }
    }

    if (dirty) {
      const left = Math.max(60, Math.ceil((Date.parse(w.until) - now) / 1000));
      await env.KV.put(e.name, JSON.stringify(w), { expirationTtl: left });
    }
  }

  if (!queued.length || !devices.length) return out;

  // ONE PUSH PER ALERT, WITH THE ALERT IN IT.
  //
  // This used to write every alert into every device's KV queue and then send one empty push per
  // device, on the reasoning that writing first meant the phone would never wake to an empty
  // queue. That reasoning was wrong about KV, not about ordering: a write is not visible to
  // another colo for up to a minute, and the wake takes a second. See pushTo() for the whole
  // account and for Ryan's report of what it produced.
  //
  // THE QUEUE IS STILL WRITTEN FOR EVERY DEVICE, AND THE FIRST CUT OF THIS ONLY WROTE IT FOR THE
  // ONES THAT COULD NOT BE ENCRYPTED FOR. That was tidy and it was wrong, and Ryan's phone found
  // it inside the hour:
  //
  //   "and I literally just got this notification" -- 'A weather alert fired. Open TrollMap for
  //   the details.'
  //
  // That string exists only in the OLD sw.js. A service worker updates when the browser next
  // fetches it, which happens on a visit; a PUSH does not trigger an update check. So a phone
  // that has not opened the app is still running the service worker it installed weeks ago --
  // and that is not a transitional state, it is the normal one, because this whole channel
  // exists for when the app is closed.
  //
  // The two halves ship independently. The Worker deployed the moment he pushed; the service
  // worker on the phone did not. An old service worker ignores the payload entirely and fetches
  // this queue, so not writing it turned "sometimes stale" into "empty, every single time" --
  // strictly worse than what it replaced.
  //
  // One KV write is the whole price. A current service worker reads the payload and returns
  // before it ever asks, so for it the queue is simply never read; an old one finds the words.
  for (const d of devices) {
    d.rec.pending = [...(d.rec.pending || []), ...queued].slice(-20);
    await env.KV.put(d.key, JSON.stringify(d.rec));
  }
  for (const d of devices) {
    const carries = !!(d.rec.keys && d.rec.keys.p256dh && d.rec.keys.auth);
    // A device that cannot carry words is tickled once, however many alerts fired: the service
    // worker will read the whole queue in one wake. A device that can gets one notification per
    // alert, because two warnings are two things to read and act on.
    const sends = carries ? queued : [null];
    let dead = false;
    for (const alert of sends) {
      const res = await pushTo(d.rec, alert, env, now);
      if (res === 'ok') out.pushed += 1;
      else if (res === 'gone') { dead = true; break; }
      else out.failed += 1;
    }
    if (dead) { await env.KV.delete(d.key); out.gone += 1; }
  }
  return out;
}
