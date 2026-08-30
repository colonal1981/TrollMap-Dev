// THE PUSH CARRIES THE WORDS, AND THE RFC SAYS WHETHER IT IS DOING IT RIGHT.
//
// Ryan, 2026-08-30, on an alert that reached his phone for a plan he had run that day:
//
//   > the alert that i got said that there is a weather alert and to open trollmap for more
//   > information... but opening trollmap did not show any popup or anything else... that
//   > notification needs to carry all of the pertinent info, i should not have to open the app
//   > to get it
//
// The push was empty on purpose and the service worker fetched the text on wake, out of Workers
// KV. KV is eventually consistent -- "up to 60 seconds or more", and longer still "in locations
// that have recently accessed an older version of the key", which is every location his phone
// has ever woken in. The wake beat the write and the fallback string fired.
//
// So the words go in the push. This is the only cryptography in the project, and the one kind of
// code that is easiest to get confidently wrong, because a wrong implementation still produces
// convincing-looking bytes and only the phone ever disagrees -- silently, on the water.
//
// SO IT IS NOT TESTED AGAINST ITS OWN OUTPUT. RFC 8291 section 5 prints a complete worked
// example: a receiver keypair, a sender keypair, a salt, a plaintext and the exact ciphertext
// they must produce. That vector is the test. `encryptPush` takes the ephemeral key and salt as
// optional arguments for this reason and no other; in production both are generated per message.
//
//   https://www.rfc-editor.org/rfc/rfc8291#section-5
import { describe, it, expect } from './expect-shim.mjs';
import { encryptPush, payloadHeaders } from '../Worker/webpush.js';
import { readFileSync } from 'node:fs';

// RFC 8291 section 5, verbatim.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const b64url = (bytes) => Buffer.from(bytes).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The sender's private scalar as a JWK, paired with the public point the RFC gives. The point
// has to be DECODED to split it -- base64 does not align on the byte boundary between 0x04, x
// and y, so slicing the string gives two halves of nothing.
const bytes = (b64) => new Uint8Array(Buffer.from(
  b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
const asPoint = bytes(RFC.asPublic);
const asPrivateJwk = {
  kty: 'EC', crv: 'P-256', d: RFC.asPrivate,
  x: b64url(asPoint.slice(1, 33)), y: b64url(asPoint.slice(33, 65)),
  ext: true,
};

describe('the encryption agrees with RFC 8291, not with itself', () => {
  it('reproduces the ciphertext the RFC prints', async () => {
    const out = await encryptPush(RFC.plaintext, RFC.uaPublic, RFC.authSecret,
      { asPrivateJwk, asPublic: RFC.asPublic, salt: RFC.salt });
    expect(b64url(out)).toBe(RFC.body);
  });

  it('lays the record out the way RFC 8188 says: salt, record size, key id', async () => {
    const out = await encryptPush(RFC.plaintext, RFC.uaPublic, RFC.authSecret,
      { asPrivateJwk, asPublic: RFC.asPublic, salt: RFC.salt });
    expect(b64url(out.slice(0, 16))).toBe(RFC.salt);
    // 4,096 big-endian, then a 65-byte key id
    expect(new DataView(out.buffer, out.byteOffset + 16, 4).getUint32(0)).toBe(4096);
    expect(out[20]).toBe(65);
    expect(b64url(out.slice(21, 86))).toBe(RFC.asPublic);
  });

  it('makes a fresh ephemeral key and salt when none is handed in', async () => {
    // The production path. Two messages must never share a key or a salt: the nonce is derived
    // from both, and AES-GCM under a repeated key and nonce hands over the plaintext.
    const a = await encryptPush('same words', RFC.uaPublic, RFC.authSecret);
    const b = await encryptPush('same words', RFC.uaPublic, RFC.authSecret);
    expect(b64url(a.slice(0, 16)) === b64url(b.slice(0, 16))).toBe(false);   // salt
    expect(b64url(a.slice(21, 86)) === b64url(b.slice(21, 86))).toBe(false); // ephemeral key
    expect(b64url(a) === b64url(b)).toBe(false);
  });

  it('refuses a subscription it cannot encrypt for, rather than sending something unreadable', async () => {
    let threw = null;
    try { await encryptPush('x', 'not-a-point', RFC.authSecret); } catch (e) { threw = e.message; }
    expect(/65-byte/.test(String(threw))).toBe(true);
    threw = null;
    try { await encryptPush('x', RFC.uaPublic, 'c2hvcnQ'); } catch (e) { threw = e.message; }
    expect(/16 bytes/.test(String(threw))).toBe(true);
  });

  it('carries a real alert with room to spare', async () => {
    // What actually travels: the words alerts.js already builds for the Echomap.
    const msg = JSON.stringify({ title: 'NWS WARNING',
      body: 'Severe Thunderstorm Warning - until 2026-08-30 19:15', tag: 'nws-1', severity: 'stop' });
    const out = await encryptPush(msg, RFC.uaPublic, RFC.authSecret);
    expect(out.length < 4096).toBe(true);
    expect(payloadHeaders(out.length)['Content-Encoding']).toBe('aes128gcm');
  });
});


// ── AND THE WHOLE WAY THROUGH ───────────────────────────────────────────────────────────────
//
// The vector above proves the derivation matches the RFC. It does not prove a PHONE can read
// what this Worker sends, and that is the thing that failed. So this half generates a
// subscription the way a browser does, runs a real alert through the real sweep, and then does
// the receiver's own derivation in reverse on the bytes that were actually POSTed to the push
// service. If the words come back out, the phone gets the words.
import { runAlertSweep, handleAlerts, deviceKey } from '../Worker/alerts.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { generateKeyPairSync, webcrypto } = require('node:crypto');

const TOKEN = 'trollmap2026';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/PIXEL10PRO';

function vapidEnv() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const b = (s) => Buffer.from(s, 'base64url');
  return {
    VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), b(jwk.x), b(jwk.y)]).toString('base64url'),
    VAPID_PRIVATE_KEY: jwk.d, SYNC_TOKEN: TOKEN,
  };
}
function kvStub(seed = {}) {
  const store = new Map(Object.entries(seed));
  return { store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    } };
}

/** A subscription the way a browser makes one: a P-256 keypair plus 16 bytes of auth secret. */
async function browserSubscription() {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  const authSecret = webcrypto.getRandomValues(new Uint8Array(16));
  return { privateKey: pair.privateKey, uaPublic: raw,
           keys: { p256dh: b64url(raw), auth: b64url(authSecret) },
           authSecret };
}

/** The receiver half of RFC 8291 — what the phone's browser does before the SW ever sees it. */
async function decryptAsPhone(record, sub) {
  const salt = record.slice(0, 16);
  const idlen = record[20];
  const asPublic = record.slice(21, 21 + idlen);
  const sealed = record.slice(21 + idlen);
  const shared = new Uint8Array(await webcrypto.subtle.deriveBits(
    { name: 'ECDH', public: await webcrypto.subtle.importKey(
        'raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, true, []) },
    sub.privateKey, 256));
  const cat = (...p) => { let n = 0; for (const x of p) n += x.length;
    const o = new Uint8Array(n); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
  const utf8 = (s) => new TextEncoder().encode(s);
  const hkdf = async (slt, ikm, info, len) => {
    const k = await webcrypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await webcrypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: slt, info }, k, len * 8));
  };
  const prk = await hkdf(sub.authSecret, shared,
    cat(utf8('WebPush: info\0'), sub.uaPublic, asPublic), 32);
  const cek = await hkdf(salt, prk, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, utf8('Content-Encoding: nonce\0'), 12);
  const key = await webcrypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const clear = new Uint8Array(await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, sealed));
  return new TextDecoder().decode(clear.slice(0, clear.length - 1));  // drop the 0x02 delimiter
}

describe('a real alert reaches a real subscription with its words intact', () => {
  it('the sweep POSTs an aes128gcm body the phone can read', async () => {
    const sub = await browserSubscription();
    const env = { ...vapidEnv(), KV: kvStub() };
    const posted = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const u = String(input && input.url ? input.url : input);
      if (u.includes('fcm.googleapis.com')) {
        posted.push({ headers: init.headers, body: init.body });
        return { ok: true, status: 201, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ features: [] }), text: async () => '' };
    };
    try {
      // register the device the way the app does, with the keys it has always sent
      const dev = new Request('https://w.example/alerts/device', { method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Sync-Token': TOKEN },
        body: JSON.stringify({ subscription: { endpoint: ENDPOINT, keys: sub.keys }, label: 'phone' }) });
      const r1 = await handleAlerts(dev, env, new URL(dev.url));
      expect(r1.status).toBe(200);
      expect(JSON.parse(await env.KV.get(await deviceKey(ENDPOINT))).keys.p256dh).toBe(sub.keys.p256dh);

      // a watch carrying one cue that is due now
      await env.KV.put('watch:x', JSON.stringify({
        lat: 34.38, lon: -80.73, until: new Date(Date.now() + 3600e3).toISOString(),
        seen: [], created: new Date().toISOString(),
        cues: [{ at: new Date().toISOString(), title: 'CHANGE BAIT',
                 body: 'Leg 2 - go to the 15-20 ft band', tag: 'cue-2', severity: 'note', fired: false }],
      }));

      const out = await runAlertSweep(env, Date.now());
      expect(out.cues).toBe(1);
      expect(out.pushed).toBe(1);
      expect(posted.length).toBe(1);
      expect(posted[0].headers['Content-Encoding']).toBe('aes128gcm');

      const said = JSON.parse(await decryptAsPhone(posted[0].body, sub));
      expect(said.title).toBe('CHANGE BAIT');
      expect(said.body).toBe('Leg 2 - go to the 15-20 ft band');
      expect(said.severity).toBe('note');
    } finally { globalThis.fetch = realFetch; }
  });

  it('and the queue is written anyway, because the service worker may be older than us', async () => {
    const sub = await browserSubscription();
    const env = { ...vapidEnv(), KV: kvStub() };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const u = String(input && input.url ? input.url : input);
      if (u.includes('fcm.googleapis.com')) return { ok: true, status: 201, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ features: [] }), text: async () => '' };
    };
    try {
      const dev = new Request('https://w.example/alerts/device', { method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Sync-Token': TOKEN },
        body: JSON.stringify({ subscription: { endpoint: ENDPOINT, keys: sub.keys }, label: 'phone' }) });
      await handleAlerts(dev, env, new URL(dev.url));
      await env.KV.put('watch:x', JSON.stringify({
        lat: 34.38, lon: -80.73, until: new Date(Date.now() + 3600e3).toISOString(),
        seen: [], created: new Date().toISOString(),
        cues: [{ at: new Date().toISOString(), title: 'A', body: 'B', tag: 't', severity: 'note', fired: false }],
      }));
      await runAlertSweep(env, Date.now());
      // THE FIRST CUT OF THIS ASSERTED ZERO -- no queue, no stale-queue race -- and Ryan's phone
      // disproved it inside the hour: 'A weather alert fired. Open TrollMap for the details.',
      // a string that exists only in the OLD sw.js. A service worker updates when the browser
      // next fetches it, and a push does not trigger that check, so a phone that has not opened
      // the app is running the worker it installed weeks ago. That is the NORMAL state for this
      // channel, which exists for when the app is closed.
      //
      // The Worker deploys on push and the service worker does not, so skipping the write turned
      // "sometimes stale" into "empty, every time". A current service worker returns on the
      // payload and never reads this; an old one finds the words.
      const rec = JSON.parse(await env.KV.get(await deviceKey(ENDPOINT)));
      expect(rec.pending.length).toBe(1);
      expect(rec.pending[0].title).toBe('A');
    } finally { globalThis.fetch = realFetch; }
  });

  it('a device with no keys still gets tickled, and still gets a queue to read', async () => {
    // Every device registered before today. It keeps working; it just cannot be told the words
    // in the push, and the service worker now says so honestly instead of sending him to the app.
    const env = { ...vapidEnv(), KV: kvStub() };
    const posted = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const u = String(input && input.url ? input.url : input);
      if (u.includes('fcm.googleapis.com')) { posted.push(init); return { ok: true, status: 201, json: async () => ({}) }; }
      return { ok: true, status: 200, json: async () => ({ features: [] }), text: async () => '' };
    };
    try {
      await env.KV.put(await deviceKey(ENDPOINT), JSON.stringify({
        endpoint: ENDPOINT, label: 'old phone', created: new Date().toISOString(), pending: [] }));
      await env.KV.put('watch:x', JSON.stringify({
        lat: 34.38, lon: -80.73, until: new Date(Date.now() + 3600e3).toISOString(),
        seen: [], created: new Date().toISOString(),
        cues: [{ at: new Date().toISOString(), title: 'A', body: 'B', tag: 't', severity: 'note', fired: false }],
      }));
      await runAlertSweep(env, Date.now());
      expect(posted.length).toBe(1);
      expect(posted[0].body === undefined).toBe(true);
      expect(JSON.parse(await env.KV.get(await deviceKey(ENDPOINT))).pending.length).toBe(1);
    } finally { globalThis.fetch = realFetch; }
  });
});

describe('the service worker draws what arrived', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  it('reads the payload before it considers fetching anything', () => {
    expect(sw).toMatch(/event\.data \? event\.data\.json\(\) : null/);
    // Comments mention the old route at length, so compare the CODE, not the prose.
    const code = sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code.indexOf('event.data.json()') < code.indexOf('/alerts/pending')).toBe(true);
  });
  it('no longer tells him to open the app for details it does not have', () => {
    expect(sw.includes('Open TrollMap for the details.')).toBe(false);
    expect(sw.includes('could not read the details. Open TrollMap.')).toBe(false);
    expect(sw).toMatch(/Switch notifications off and on again in TrollMap/);
  });
});
