// WEB PUSH: THE HALF THAT WORKS WITH THE PHONE ASLEEP.
//
// Ryan's phone "stays in my PFD pocket with a tether except for pics". A backgrounded phone
// browser freezes setInterval, so the in-page hazard poll covers the drive to the ramp and
// nothing after it. This is the path that does not need the app open — and every failure mode
// in it is silent: a JWT signed for the wrong audience, a key assembled wrong, a watch that
// never expires, the same warning pushed ninety-six times.
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { applicationServerKey, vapidAuth, watchKey, runAlertSweep } from '../Worker/alerts.js';

const require = createRequire(import.meta.url);
const { generateKeyPairSync } = require('node:crypto');

/** A real P-256 keypair in the shape `npx web-push generate-vapid-keys` prints. */
function vapidEnv() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const b = (s) => Buffer.from(s, 'base64url');
  const point = Buffer.concat([Buffer.from([4]), b(jwk.x), b(jwk.y)]);
  return {
    VAPID_PUBLIC_KEY: point.toString('base64url'),
    VAPID_PRIVATE_KEY: jwk.d,
  };
}

function kvStub(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

test('the application server key is the uncompressed P-256 point the browser expects', () => {
  const env = vapidEnv();
  const key = applicationServerKey({
    kty: 'EC', crv: 'P-256',
    x: Buffer.from(env.VAPID_PUBLIC_KEY, 'base64url').subarray(1, 33).toString('base64url'),
    y: Buffer.from(env.VAPID_PUBLIC_KEY, 'base64url').subarray(33, 65).toString('base64url'),
    d: env.VAPID_PRIVATE_KEY,
  });
  const bytes = Buffer.from(key, 'base64url');
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 4, 'must be the 0x04 uncompressed tag');
  // And it must round-trip to the public key the generator produced, or the browser subscribes
  // against one identity while the Worker signs with another and every push 403s.
  assert.equal(key, env.VAPID_PUBLIC_KEY);
});

test('a VAPID header signs for the PUSH SERVICE ORIGIN, not the endpoint', async () => {
  const env = vapidEnv();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123?x=1';
  const h = await vapidAuth(endpoint, env, Date.parse('2026-08-26T00:00:00Z'));
  assert.ok(h && h.Authorization.startsWith('vapid t='));
  const jwt = h.Authorization.slice('vapid t='.length).split(',')[0];
  const [, payload, sig] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  // A JWT minted for the full endpoint is rejected with a 401 that explains nothing.
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.exp, Math.floor(Date.parse('2026-08-26T00:00:00Z') / 1000) + 12 * 3600);
  // ES256 signatures are raw r‖s. A DER-encoded one is the classic silent rejection.
  assert.equal(Buffer.from(sig, 'base64url').length, 64);
});

test('the subject is the app, never Ryan\'s email', async () => {
  const h = await vapidAuth('https://fcm.googleapis.com/x', vapidEnv(), Date.now());
  const claims = JSON.parse(Buffer.from(h.Authorization.split('.')[1], 'base64url').toString());
  // This header goes to Google on every alert. His address has no business travelling with it.
  assert.ok(/^https:\/\//.test(claims.sub), claims.sub);
  assert.ok(!/@/.test(claims.sub));
});

test('no keys configured is a null header, not a thrown request', async () => {
  assert.equal(await vapidAuth('https://fcm.googleapis.com/x', {}, Date.now()), null);
  // The private half alone cannot be imported — WebCrypto needs the public point.
  assert.equal(await vapidAuth('https://fcm.googleapis.com/x',
    { VAPID_PRIVATE_KEY: 'abc' }, Date.now()), null);
});

// ── the sweep ───────────────────────────────────────────────────────────────────────────────

const HAZARD = {
  items: [{ id: 'W-1', type: 'Severe Thunderstorm Warning', severity: 'Warning',
            ends: '2026-08-26T18:00:00Z', url: 'https://x/1' }],
  all_clear: false,
};

function stubUpstreams({ hazards = HAZARD, pushStatus = 201 } = {}) {
  const pushed = [];
  globalThis.fetch = async (input, init) => {
    const u = String(input && input.url ? input.url : input);
    if (u.includes('fcm.googleapis.com')) {
      pushed.push({ u, headers: init && init.headers });
      return { ok: pushStatus < 300, status: pushStatus, json: async () => ({}) };
    }
    // Everything the hazards query touches. One shape answers it; anything else fails closed.
    return {
      ok: true, status: 200,
      json: async () => ({ features: hazards.items.map((h) => ({ attributes: {
        prod_type: h.type, sig: 'W', phenom: 'SV', msg_type: 'NEW',
        onset: null, ends: Date.parse(h.ends), issuance: null, expiration: null,
        wfo: 'CAE', cap_id: h.id, event: 1, url: h.url } })) }),
      text: async () => '',
    };
  };
  return pushed;
}

async function watchRec(kv, over = {}) {
  const endpoint = 'https://fcm.googleapis.com/fcm/send/DEVICE1';
  const rec = {
    endpoint, lat: 34.05, lon: -81.22,
    until: new Date(Date.now() + 4 * 3600e3).toISOString(),
    seen: [], pending: [], ...over,
  };
  await kv.put(await watchKey(endpoint), JSON.stringify(rec));
  return { endpoint, key: await watchKey(endpoint) };
}

test('a new hazard is written BEFORE it is pushed, and pushed once', async () => {
  const kv = kvStub();
  const { key } = await watchRec(kv);
  const pushed = stubUpstreams();
  const env = { KV: kv, ...vapidEnv() };

  const first = await runAlertSweep(env);
  assert.equal(first.new_alerts, 1);
  assert.equal(first.pushed, 1);
  const rec = JSON.parse(kv.store.get(key));
  // The phone wakes and asks what happened; if the write had not landed it would be told
  // nothing, which reads as a false alarm — the worst outcome available.
  assert.equal(rec.pending.length, 1);
  assert.match(rec.pending[0].title, /WARNING/);
  assert.equal(rec.pending[0].severity, 'stop');

  // SAME HAZARD, NEXT FIRING. An eight-hour warning must buzz once, not every five minutes.
  const second = await runAlertSweep(env);
  assert.equal(second.new_alerts, 0);
  assert.equal(second.pushed, 0);
  assert.equal(pushed.length, 1);
});

test('an expired watch is deleted and never polled', async () => {
  const kv = kvStub();
  const { key } = await watchRec(kv, { until: new Date(Date.now() - 60e3).toISOString() });
  stubUpstreams();
  const r = await runAlertSweep({ KV: kv, ...vapidEnv() });
  assert.equal(r.expired, 1);
  assert.equal(r.pushed, 0);
  assert.equal(kv.store.has(key), false, 'a watch that outlives the trip is a bug that buzzes');
});

test('a 410 from the push service retires the subscription', async () => {
  const kv = kvStub();
  const { key } = await watchRec(kv);
  stubUpstreams({ pushStatus: 410 });
  const r = await runAlertSweep({ KV: kv, ...vapidEnv() });
  assert.equal(r.gone, 1);
  assert.equal(kv.store.has(key), false);
});

test('a transient push failure KEEPS the watch', async () => {
  const kv = kvStub();
  const { key } = await watchRec(kv);
  stubUpstreams({ pushStatus: 500 });
  const r = await runAlertSweep({ KV: kv, ...vapidEnv() });
  assert.equal(r.failed, 1);
  // Deleting on a 500 loses the trip. Only 404/410 mean the subscription is actually dead.
  assert.equal(kv.store.has(key), true);
});

test('no KV binding is an empty summary, not a crash in a cron nobody is watching', async () => {
  const r = await runAlertSweep({});
  assert.equal(r.checked, 0);
  assert.equal(r.pushed, 0);
});
