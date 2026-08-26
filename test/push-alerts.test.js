// WEB PUSH: THE ONLY PATH THAT REACHES RYAN ON THE WATER.
//
// Ryan, 2026-08-26: "i do not use trollmap on the water" and "i dont plan from my phone". Those
// two sentences kill every design where the receiving device and the planning device are the
// same, and every design that needs a page open. What survives: a DEVICE registered once from
// the phone, a TRIP WATCH created at the desk, and a cron that joins them.
//
// Every failure mode here is silent — a JWT signed for the wrong audience, a key assembled
// wrong, a watch that never expires, the same warning pushed ninety-six times, a watch armed
// with nothing registered to receive it.
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { applicationServerKey, vapidAuth, deviceKey, handleAlerts, runAlertSweep, forEchomap }
  from '../Worker/alerts.js';

const require = createRequire(import.meta.url);
const { generateKeyPairSync } = require('node:crypto');

const TOKEN = 'trollmap2026';

/** A real P-256 keypair in the shape `npx web-push generate-vapid-keys` prints. */
function vapidEnv() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const b = (s) => Buffer.from(s, 'base64url');
  return {
    VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), b(jwk.x), b(jwk.y)]).toString('base64url'),
    VAPID_PRIVATE_KEY: jwk.d,
    SYNC_TOKEN: TOKEN,
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

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/PIXEL10PRO';

function stubUpstreams({ hazards = [], pushStatus = 201 } = {}) {
  const pushed = [];
  globalThis.fetch = async (input, init) => {
    const u = String(input && input.url ? input.url : input);
    if (u.includes('fcm.googleapis.com')) {
      pushed.push({ u, headers: init && init.headers });
      return { ok: pushStatus < 300, status: pushStatus, json: async () => ({}) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ features: hazards.map((h) => ({ attributes: {
        prod_type: h.type, sig: h.sig || 'W', phenom: 'SV', msg_type: 'NEW',
        onset: null, ends: Date.parse(h.ends), issuance: null, expiration: null,
        wfo: 'CAE', cap_id: h.id, event: 1, url: 'https://x/1' } })) }),
      text: async () => '',
    };
  };
  return pushed;
}

const req = (path, { method = 'GET', body = null, token = TOKEN } = {}) => {
  const url = new URL(`https://w.example${path}`);
  const headers = { 'content-type': 'application/json' };
  if (token) headers['X-Sync-Token'] = token;
  return [new Request(url.toString(), {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  }), url];
};

async function registerDevice(env) {
  const [r, u] = req('/alerts/device', {
    method: 'POST', body: { subscription: { endpoint: ENDPOINT }, label: 'Pixel 10 Pro' },
  });
  return (await handleAlerts(r, env, u)).json();
}

// ── the crypto, which fails silently when it fails ──────────────────────────────────────────

test('the application server key round-trips to the key the generator produced', () => {
  const env = vapidEnv();
  const pub = Buffer.from(env.VAPID_PUBLIC_KEY, 'base64url');
  const key = applicationServerKey({
    kty: 'EC', crv: 'P-256',
    x: pub.subarray(1, 33).toString('base64url'),
    y: pub.subarray(33, 65).toString('base64url'),
    d: env.VAPID_PRIVATE_KEY,
  });
  // If this drifts, the browser subscribes against one identity while the Worker signs with
  // another and every push 403s — with nothing on the phone to say so.
  assert.equal(key, env.VAPID_PUBLIC_KEY);
  assert.equal(Buffer.from(key, 'base64url')[0], 4);
});

test('a VAPID header signs for the push service ORIGIN and carries no email', async () => {
  const h = await vapidAuth('https://fcm.googleapis.com/fcm/send/abc?x=1', vapidEnv(),
                            Date.parse('2026-08-26T00:00:00Z'));
  const jwt = h.Authorization.slice('vapid t='.length).split(',')[0];
  const [, payload, sig] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');   // not the full endpoint
  assert.equal(Buffer.from(sig, 'base64url').length, 64);   // raw r‖s, not DER
  assert.ok(!/@/.test(claims.sub), 'this header goes to Google on every alert');
});

test('the private half alone cannot sign, and says so rather than throwing', async () => {
  assert.equal(await vapidAuth('https://fcm.googleapis.com/x', { VAPID_PRIVATE_KEY: 'x' }, 1), null);
  const [r, u] = req('/alerts/vapid-public');
  const res = await handleAlerts(r, { KV: kvStub(), VAPID_PRIVATE_KEY: 'x' }, u);
  assert.equal(res.status, 503);
  const j = await res.json();
  assert.match(j.error, /VAPID_PUBLIC_KEY is not/);
});

// ── the device / trip split, which is the correction that mattered ──────────────────────────

test('a device registers once and is not tied to any trip', async () => {
  const env = { KV: kvStub(), ...vapidEnv() };
  const first = await registerDevice(env);
  assert.equal(first.ok, true);
  assert.equal(first.label, 'Pixel 10 Pro');
  // Re-registering the same endpoint must not create a second device or lose the queue.
  await registerDevice(env);
  const [r, u] = req('/alerts/devices');
  const list = await (await handleAlerts(r, env, u)).json();
  assert.equal(list.count, 1);
  // THE ENDPOINT NEVER LEAVES. It is the address of Ryan's phone.
  assert.ok(!JSON.stringify(list).includes('PIXEL10PRO'));
});

test('writing routes require the sync token', async () => {
  const env = { KV: kvStub(), ...vapidEnv() };
  const [r, u] = req('/alerts/device', {
    method: 'POST', token: null, body: { subscription: { endpoint: ENDPOINT } },
  });
  assert.equal((await handleAlerts(r, env, u)).status, 401);
});

test('a watch armed with no registered device SAYS so', async () => {
  const env = { KV: kvStub(), ...vapidEnv() };
  const [r, u] = req('/alerts/watch', {
    method: 'POST', body: { lat: 34.05, lon: -81.22, until: new Date(Date.now() + 3600e3).toISOString() },
  });
  const j = await (await handleAlerts(r, env, u)).json();
  assert.equal(j.devices, 0);
  // A safety feature that quietly protects nobody is worse than one that is off.
  assert.match(j.warning, /no device is registered/);
});

// ── the sweep ───────────────────────────────────────────────────────────────────────────────

async function armed(env, { cues = [], hours = 4 } = {}) {
  await registerDevice(env);
  const [r, u] = req('/alerts/watch', {
    method: 'POST',
    body: { lat: 34.05, lon: -81.22, until: new Date(Date.now() + hours * 3600e3).toISOString(), cues },
  });
  return (await handleAlerts(r, env, u)).json();
}

test('a new hazard reaches the registered device, once', async () => {
  const env = { KV: kvStub(), ...vapidEnv() };
  const pushed = stubUpstreams({ hazards: [
    { id: 'W-1', type: 'Severe Thunderstorm Warning', ends: '2026-08-26T18:00:00Z' }] });
  const j = await armed(env);
  assert.equal(j.devices, 1);

  const first = await runAlertSweep(env);
  assert.equal(first.new_alerts, 1);
  assert.equal(first.pushed, 1);

  const dev = JSON.parse(env.KV.store.get(await deviceKey(ENDPOINT)));
  assert.equal(dev.pending.length, 1);
  assert.match(dev.pending[0].title, /WARNING/);

  // An eight-hour warning must buzz once, not every five minutes for eight hours.
  const second = await runAlertSweep(env);
  assert.equal(second.new_alerts, 0);
  assert.equal(second.pushed, 0);
  assert.equal(pushed.length, 1);
});

test('the plan\'s own cues fire — bait changes, not just weather', async () => {
  // Ryan: "i want bait changes, and everything else sent as notifications to the echomap."
  // These fire today from a 30-second timer in a page that is never open on the water.
  const env = { KV: kvStub(), ...vapidEnv() };
  stubUpstreams();
  const due = new Date(Date.now() - 60e3).toISOString();
  const later = new Date(Date.now() + 3 * 3600e3).toISOString();
  await armed(env, { cues: [
    { at: due, title: '🎣 Band Change', body: 'Switch to 15–20 ft', tag: 'band-2' },
    { at: later, title: '⏱ Head Back', body: 'Return time', tag: 'return' },
  ] });

  const r1 = await runAlertSweep(env);
  assert.equal(r1.cues, 1, 'only the due one');
  const dev = JSON.parse(env.KV.store.get(await deviceKey(ENDPOINT)));
  // THE EMOJI IS GONE BY THE TIME IT REACHES THE QUEUE. Ryan photographed a live notification
  // on the Echomap on 2026-08-26 -- a marine chartplotter with a limited glyph set, where a
  // leading emoji costs the first and most-read position on the line to render an empty box.
  assert.equal(dev.pending[0].title, 'Band Change');

  // And it does not fire again on the next sweep.
  const r2 = await runAlertSweep(env);
  assert.equal(r2.cues, 0);
});

test('a cue fires EARLY rather than late, by one cron period', async () => {
  const env = { KV: kvStub(), ...vapidEnv() };
  stubUpstreams();
  // Four minutes out: inside the five-minute lead, so it is due now. A cue delivered three
  // minutes AFTER the band change is noise; fifteen minutes before it is useful.
  await armed(env, { cues: [
    { at: new Date(Date.now() + 4 * 60e3).toISOString(), title: '🎣 Band Change', body: 'x', tag: 'b' }] });
  assert.equal((await runAlertSweep(env)).cues, 1);

  const env2 = { KV: kvStub(), ...vapidEnv() };
  stubUpstreams();
  await armed(env2, { cues: [
    { at: new Date(Date.now() + 30 * 60e3).toISOString(), title: '🎣 Band Change', body: 'x', tag: 'b' }] });
  assert.equal((await runAlertSweep(env2)).cues, 0, 'half an hour out is not due yet');
});

test('an expired watch is deleted; the device survives it', async () => {
  const env = { KV: kvStub(), ...vapidEnv() };
  stubUpstreams();
  await armed(env, { hours: -1 });
  const r = await runAlertSweep(env);
  assert.equal(r.expired, 1);
  assert.equal(r.pushed, 0);
  assert.equal((await env.KV.list({ prefix: 'watch:' })).keys.length, 0);
  // A device is not a trip. It outlives every one of them.
  assert.equal((await env.KV.list({ prefix: 'device:' })).keys.length, 1);
});

test('a 410 retires the device; a 500 does not', async () => {
  const gone = { KV: kvStub(), ...vapidEnv() };
  stubUpstreams({ hazards: [{ id: 'W-9', type: 'Tornado Warning', ends: '2026-08-26T18:00:00Z' }],
                  pushStatus: 410 });
  await armed(gone);
  assert.equal((await runAlertSweep(gone)).gone, 1);
  assert.equal((await gone.KV.list({ prefix: 'device:' })).keys.length, 0);

  const flaky = { KV: kvStub(), ...vapidEnv() };
  stubUpstreams({ hazards: [{ id: 'W-9', type: 'Tornado Warning', ends: '2026-08-26T18:00:00Z' }],
                  pushStatus: 500 });
  await armed(flaky);
  assert.equal((await runAlertSweep(flaky)).failed, 1);
  // Deleting on a transient failure loses the trip.
  assert.equal((await flaky.KV.list({ prefix: 'device:' })).keys.length, 1);
});

test('the service worker drains its queue on read, so nothing repeats', async () => {
  const env = { KV: kvStub(), ...vapidEnv() };
  stubUpstreams({ hazards: [{ id: 'W-2', type: 'Special Marine Warning', ends: '2026-08-26T18:00:00Z' }] });
  await armed(env);
  await runAlertSweep(env);

  const [r1, u1] = req('/alerts/pending', { method: 'POST', token: null, body: { endpoint: ENDPOINT } });
  const first = await (await handleAlerts(r1, env, u1)).json();
  assert.equal(first.alerts.length, 1);
  const [r2, u2] = req('/alerts/pending', { method: 'POST', token: null, body: { endpoint: ENDPOINT } });
  const second = await (await handleAlerts(r2, env, u2)).json();
  // A queue that is not cleared re-shows the same warning on every push, which teaches him to
  // ignore the one that matters.
  assert.equal(second.alerts.length, 0);
});

test('nothing above Latin-1 reaches a marine display', () => {
  assert.equal(forEchomap('🎣 Band Change'), 'Band Change');
  assert.equal(forEchomap('⚠️ NWS WARNING'), 'NWS WARNING');
  assert.equal(forEchomap('⏱ Head Back Soon'), 'Head Back Soon');
  // Degrees and the rest of Latin-1 SURVIVE -- 72°F is the point of the message.
  assert.equal(forEchomap('Water 72°F, wind 8 mph'), 'Water 72°F, wind 8 mph');
  assert.equal(forEchomap(null), '');
});

test('no KV binding is an empty summary, not a crash in a cron nobody watches', async () => {
  const r = await runAlertSweep({});
  assert.equal(r.checked, 0);
  assert.equal(r.pushed, 0);
});
