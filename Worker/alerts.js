/**
 * Web Push, because the phone is asleep in a PFD pocket.
 *
 * WHAT THIS REPLACES. `js/modules/notifications.js` polls `/hazards` on a five-minute
 * `setInterval` in the page. Ryan, 2026-08-25: his phone "stays in my PFD pocket with a tether
 * except for pics". A backgrounded phone browser throttles that interval and then freezes it, so
 * the in-page poll runs on the drive to the ramp and stops the moment the phone goes away —
 * which is the entire window the feature exists for. The page poll is kept: it is instant while
 * the app IS open. This is what covers the other twelve hours.
 *
 * THE SHAPE. On trip start the client subscribes and posts a watch: the push subscription, the
 * launch point, and the time he said he would be back. A Cloudflare cron wakes this Worker every
 * five minutes, asks `handleHazards` — THE SAME FUNCTION THE CLIENT CALLS, not a second copy —
 * for each active watch's point, diffs against what that watch has already been told, and sends
 * an empty push for anything new. The service worker wakes, asks `/alerts/pending` what
 * happened, and shows it. The watch expires itself at the return time.
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

import { CORS, JSON_HEADERS } from './worker-core.js';
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

/** KV key for a subscription. The endpoint is long and contains '/', so it is hashed. */
export async function watchKey(endpoint) {
  const h = await crypto.subtle.digest('SHA-256', utf8(String(endpoint)));
  return `watch:${b64urlFromBytes(new Uint8Array(h)).slice(0, 32)}`;
}

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...JSON_HEADERS, ...CORS } });

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

/** The words that reach the phone. Severity decides the verb, not the app's own guess. */
function alertFor(h) {
  const stop = h.severity === 'Warning' || (h.severity === 'Statement' && h.storm === true);
  return {
    title: stop ? '⚠️ NWS WARNING' : `⚠️ NWS ${h.severity || 'alert'}`,
    body: [h.type, h.ends ? `until ${String(h.ends).replace('T', ' ').slice(0, 16)}` : null]
      .filter(Boolean).join(' — '),
    tag: `nws-${h.id || h.type}`,
    severity: stop ? 'stop' : 'note',
    url: h.url || './',
  };
}

/** Send one data-less push. Returns 'ok' | 'gone' | 'fail'. */
async function pushTo(endpoint, env, nowMs) {
  const auth = await vapidAuth(endpoint, env, nowMs);
  if (!auth) return 'fail';
  let r;
  try {
    r = await fetch(endpoint, {
      method: 'POST',
      headers: { ...auth, TTL: String(TTL_SECONDS), Urgency: 'high' },
    });
  } catch (_) { return 'fail'; }
  // 404 and 410 are the push service saying this subscription is dead. Anything else that fails
  // is transient and the watch stays, because deleting a watch on a 500 loses the trip.
  if (r.status === 404 || r.status === 410) return 'gone';
  return r.ok ? 'ok' : 'fail';
}

// ── routes ──────────────────────────────────────────────────────────────────────────────────

export async function handleAlerts(request, env, url) {
  const p = url.pathname.replace(/\/+$/, '');
  if (!p.startsWith('/alerts')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (!env || !env.KV) return json({ error: 'KV not bound' }, 500);

  if (p === '/alerts/vapid-public') {
    const key = applicationServerKey(readJwk(env));
    // AN ABSENT KEY IS A CONFIGURATION FACT, NOT A CRASH. Say so plainly, because the client
    // will show this to Ryan and "not configured" is a different job from "broken".
    return key ? json({ key })
               : json({ key: null, error: vapidProblem(env) }, 503);
  }

  if (p === '/alerts/subscribe' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
    const sub = body && body.subscription;
    const lat = Number(body && body.lat);
    const lon = Number(body && body.lon);
    if (!sub || !sub.endpoint) return json({ error: 'subscription required' }, 400);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: 'lat/lon required' }, 400);

    const now = Date.now();
    // A WATCH THAT OUTLIVES A TRIP IS A BUG THAT BUZZES. Honour the plan's return time, cap it,
    // and let KV expire the record itself so nothing has to remember to clean up.
    const askedUntil = Date.parse(body.until || '');
    const until = Math.min(
      Number.isFinite(askedUntil) ? askedUntil : now + MAX_WATCH_HOURS * 3600e3,
      now + MAX_WATCH_HOURS * 3600e3);
    const rec = {
      endpoint: sub.endpoint, lat, lon,
      water: (body.water || null), slug: (body.slug || null),
      until: new Date(until).toISOString(),
      seen: [], pending: [], created: new Date(now).toISOString(),
    };
    const k = await watchKey(sub.endpoint);
    await env.KV.put(k, JSON.stringify(rec),
                     { expirationTtl: Math.max(120, Math.ceil((until - now) / 1000) + 900) });
    return json({ ok: true, until: rec.until, watching: rec.water || `${lat},${lon}` });
  }

  if ((p === '/alerts/unsubscribe' || p === '/alerts/resubscribe') && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
    const oldEp = body && (body.endpoint || body.old);
    if (oldEp) await env.KV.delete(await watchKey(oldEp));
    if (p === '/alerts/resubscribe' && body && body.subscription && body.subscription.endpoint) {
      // The browser rotated the subscription mid-trip. Carry the watch across rather than
      // dropping it: the trip did not end, the endpoint did.
      const prev = oldEp ? null : null;
      const rec = {
        endpoint: body.subscription.endpoint,
        lat: Number(body.lat), lon: Number(body.lon),
        until: body.until || new Date(Date.now() + 3600e3).toISOString(),
        seen: [], pending: [], created: new Date().toISOString(), rotated: true, prev,
      };
      if (Number.isFinite(rec.lat) && Number.isFinite(rec.lon)) {
        await env.KV.put(await watchKey(rec.endpoint), JSON.stringify(rec), { expirationTtl: 3600 });
      }
    }
    return json({ ok: true });
  }

  if (p === '/alerts/pending' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
    const ep = body && body.endpoint;
    if (!ep) return json({ error: 'endpoint required' }, 400);
    const k = await watchKey(ep);
    const raw = await env.KV.get(k);
    if (!raw) return json({ alerts: [] });
    let rec;
    try { rec = JSON.parse(raw); } catch (_) { return json({ alerts: [] }); }
    const alerts = rec.pending || [];
    if (alerts.length) {
      // DRAINED ON READ. A pending list that is not cleared re-shows the same warning on every
      // subsequent push, which trains him to ignore it.
      rec.pending = [];
      const left = Math.max(60, Math.ceil((Date.parse(rec.until) - Date.now()) / 1000));
      await env.KV.put(k, JSON.stringify(rec), { expirationTtl: left });
    }
    return json({ alerts });
  }

  if (p === '/alerts/status') {
    const list = await env.KV.list({ prefix: 'watch:' });
    return json({
      configured: !!applicationServerKey(readJwk(env)),
      active_watches: list.keys.length,
    });
  }

  return json({ error: 'unknown alerts route' }, 404);
}

// ── the cron ────────────────────────────────────────────────────────────────────────────────

/**
 * Every active watch, once per firing. Returns a summary so a manual run says what it did.
 *
 * NOTHING IS SENT FOR A HAZARD ALREADY REPORTED. `seen` is per watch and grows for the life of
 * the trip, so an eight-hour Severe Thunderstorm Watch buzzes once when it is issued rather than
 * ninety-six times.
 */
export async function runAlertSweep(env, nowMs) {
  const now = nowMs || Date.now();
  const out = { checked: 0, expired: 0, pushed: 0, gone: 0, failed: 0, new_alerts: 0 };
  if (!env || !env.KV) return out;
  const list = await env.KV.list({ prefix: 'watch:' });

  const work = list.keys.map((entry) => async () => {
    const raw = await env.KV.get(entry.name);
    if (!raw) return;
    let rec;
    try { rec = JSON.parse(raw); } catch (_) { await env.KV.delete(entry.name); return; }
    out.checked += 1;

    if (Date.parse(rec.until) <= now) { await env.KV.delete(entry.name); out.expired += 1; return; }

    const j = await hazardsAt(rec.lat, rec.lon, env);
    if (!j) return;                                  // upstream had a bad minute; try next firing
    const seen = new Set(rec.seen || []);
    const fresh = (j.items || []).filter((h) => h && h.id && !seen.has(h.id));
    if (!fresh.length) return;

    for (const h of fresh) seen.add(h.id);
    rec.seen = [...seen].slice(-200);
    rec.pending = [...(rec.pending || []), ...fresh.map(alertFor)].slice(-20);
    out.new_alerts += fresh.length;

    // WRITE BEFORE PUSHING. If the push succeeds and the write has not landed, the phone wakes,
    // asks what happened and is told nothing — the worst outcome available, because it looks
    // like a false alarm.
    const left = Math.max(60, Math.ceil((Date.parse(rec.until) - now) / 1000));
    await env.KV.put(entry.name, JSON.stringify(rec), { expirationTtl: left });

    const res = await pushTo(rec.endpoint, env, now);
    if (res === 'ok') out.pushed += 1;
    else if (res === 'gone') { await env.KV.delete(entry.name); out.gone += 1; }
    else out.failed += 1;
  });

  for (let i = 0; i < work.length; i += SWEEP_CONCURRENCY) {
    await Promise.all(work.slice(i, i + SWEEP_CONCURRENCY).map((f) => f()));
  }
  return out;
}
