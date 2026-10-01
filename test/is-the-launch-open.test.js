// Is the launch open: Google's listing, read on the day of the plan.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-01: "I think we talked about having smartplan use my google maps api key to check
// for ramp closures... did that get done?" It had not -- designed 2026-09-20, never built -- and
// the only closure the app carried was typed by hand into the Cooper's ramp list, which he had
// already ruled out: "hand writing in that it is closed will go stale with no way of updating it
// without changing code".
//
// What these hold:
//   1. the status call bills at the tier the naming call already does (Pro), and no higher;
//   2. which result IS the launch is the naming script's own rule, read out of the Python;
//   3. a closed launch is found by its name, not by being nearest;
//   4. one ask per launch per day, budgeted with the naming route, token-guarded;
//   5. the plan says it: closed is a warning, anything else is a settled line, and a failure is a
//      sentence, never a refusal;
//   6. both planners ask, and the hand-written closure is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePlaces, LAUNCH_RE, NOT_A_LAUNCH_RE, pickLaunch, dayEastern } from '../Worker/places.js';
import { askLaunchStatus, launchStatusNote } from '../js/modules/launch-status.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, '..', f), 'utf8');
const strip = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const SRC = read('Worker/places.js');
const PY = read('Scripts/name_launches_from_places.py');
const TOKEN = 'trollmap2026';

function kvStub(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
  };
}
const env = (extra = {}) => ({ KV: kvStub(), SYNC_TOKEN: TOKEN, PLACES_API_KEY: 'not-a-real-key', ...extra });

/** Every outbound call is money, so every one is counted. */
function stubGoogle(places, status = 200) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: init.headers, body: JSON.parse(init.body) });
    return { ok: status === 200, status, json: async () => ({ places }), text: async () => 'denied' };
  };
  return calls;
}

function req(p, { method = 'POST', body = null, token = TOKEN } = {}) {
  const url = new URL(`https://w.example${p}`);
  const headers = { 'content-type': 'application/json' };
  if (token) headers['X-Sync-Token'] = token;
  return [new Request(url.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined }), url];
}

// The tailrace, 2026-09-20: Google's "William Dennis Boat Landing -- Temporarily closed". The grill
// is nearer, closed for good, and is not the launch.
const PINOPOLIS = { lat: 33.21311, lon: -79.97347 };
const AT_PINOPOLIS = [
  { id: 'g', displayName: { text: 'Moncks Corner Grill' }, types: ['restaurant'],
    location: { latitude: 33.21320, longitude: -79.97340 }, businessStatus: 'CLOSED_PERMANENTLY' },
  { id: 'wd', displayName: { text: 'William Dennis Boat Landing' }, types: ['point_of_interest'],
    location: { latitude: 33.21360, longitude: -79.97310 }, businessStatus: 'CLOSED_TEMPORARILY' },
];

test('the status call bills at Pro, the tier the name call already does, and no higher', () => {
  const m = SRC.match(/const STATUS_FIELD_MASK = '([^']+)'\s*\+\s*'([^']+)'/);
  assert.ok(m, 'STATUS_FIELD_MASK is still a literal that can be read');
  const fields = (m[1] + m[2]).split(',').map((f) => f.replace(/^places\./, ''));
  const ENTERPRISE = ['rating', 'userRatingCount', 'regularOpeningHours', 'currentOpeningHours',
                      'priceLevel', 'priceRange', 'websiteUri', 'nationalPhoneNumber',
                      'internationalPhoneNumber', 'reviews'];
  for (const f of fields) assert.ok(!ENTERPRISE.includes(f), `${f} would reprice every call`);
  assert.ok(fields.includes('businessStatus'), 'the status is the whole point of the call');
  assert.ok(fields.includes('displayName'), 'and the name is how the launch is picked');
});

test('which result is the launch is the naming script\'s rule, read out of the Python', () => {
  const py = (name) => {
    const blk = PY.match(new RegExp(`${name} = re\\.compile\\(\\s*((?:r'[^']*'\\s*)+),\\s*re\\.I\\)`));
    assert.ok(blk, `${name} is still a compiled literal in name_launches_from_places.py`);
    return [...blk[1].matchAll(/r'([^']*)'/g)].map((x) => x[1]).join('');
  };
  assert.equal(LAUNCH_RE.source, py('LAUNCH_RE'));
  assert.equal(NOT_A_LAUNCH_RE.source, py('NOT_A_LAUNCH_RE'));
  assert.ok(LAUNCH_RE.ignoreCase && NOT_A_LAUNCH_RE.ignoreCase);
  assert.equal(Number(PY.match(/^ACCEPT_M = (\d+)/m)[1]), 150);
  assert.match(SRC, /const RADIUS_M = 150;/);
  assert.match(SRC, /const ACCEPT_M = RADIUS_M;/);
});

test('the launch is the nearest thing whose name reads like one, not the nearest thing', () => {
  const r = pickLaunch([{ name: 'Moncks Corner Grill', m: 9 },
                        { name: 'William Dennis Boat Landing', m: 62, status: 'CLOSED_TEMPORARILY' }]);
  assert.equal(r.launch.name, 'William Dennis Boat Landing');
  assert.equal(pickLaunch([{ name: "Weed's Marine & Outdoor", m: 92 }]).launch, null);
  assert.match(pickLaunch([]).why, /nothing within 150 m/);
});

test('his day, not UTC\'s: 10:30 PM Eastern is still that day', () => {
  assert.equal(dayEastern(new Date('2026-10-02T02:30:00Z')), '2026-10-01');
  assert.equal(dayEastern(new Date('2026-10-01T14:00:00Z')), '2026-10-01');
});

test('POST /places/status finds William Dennis closed, by its name, and says what it read', async () => {
  const calls = stubGoogle(AT_PINOPOLIS);
  const e = env();
  const [r, u] = req('/places/status', { body: PINOPOLIS });
  const res = await handlePlaces(r, e, u);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.launch.name, 'William Dennis Boat Landing');
  assert.equal(j.launch.status, 'CLOSED_TEMPORARILY');
  assert.equal(j.day, dayEastern());
  assert.equal(j.results.length, 2, 'what else Google had there travels too');
  assert.equal(calls.length, 1);
  assert.match(calls[0].headers['X-Goog-FieldMask'], /places\.businessStatus/);
  assert.equal(calls[0].body.locationRestriction.circle.radius, 150);
  assert.equal(calls[0].body.rankPreference, 'DISTANCE');
  assert.equal(j.budget.this_call, 1);
});

test('one ask per launch per day, on the same budget as the names', async () => {
  const calls = stubGoogle(AT_PINOPOLIS);
  const e = env();
  for (let i = 0; i < 3; i++) {
    const [r, u] = req('/places/status', { body: PINOPOLIS });
    await handlePlaces(r, e, u);
  }
  assert.equal(calls.length, 1, 'the second and third plan that day spent nothing');
  const keys = [...e.KV.store.keys()];
  assert.ok(keys.some((k) => k === `places:status:33.21311,-79.97347:${dayEastern()}`), keys.join(' '));
  assert.equal(JSON.parse(e.KV.store.get('places:spent')).spent, 1);
});

test('the budget stops an uncached ask, and still serves today\'s answer it already has', async () => {
  const month = new Date().toISOString().slice(0, 7);
  const spentOut = JSON.stringify({ month, spent: 1000 });
  let calls = stubGoogle(AT_PINOPOLIS);
  let e = env({ KV: kvStub({ 'places:spent': spentOut }) });
  let [r, u] = req('/places/status', { body: PINOPOLIS });
  let res = await handlePlaces(r, e, u);
  assert.equal(res.status, 429);
  assert.equal(calls.length, 0);

  const today = { day: dayEastern(), launch: { name: 'William Dennis Boat Landing', m: 47,
                  status: 'CLOSED_TEMPORARILY' }, why: '', results: [] };
  calls = stubGoogle(AT_PINOPOLIS);
  e = env({ KV: kvStub({ 'places:spent': spentOut,
                         [`places:status:33.21311,-79.97347:${dayEastern()}`]: JSON.stringify(today) }) });
  [r, u] = req('/places/status', { body: PINOPOLIS });
  res = await handlePlaces(r, e, u);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).launch.status, 'CLOSED_TEMPORARILY');
  assert.equal(calls.length, 0);
});

test('it spends nothing for a caller without the token, a Worker without the key, or no position', async () => {
  const calls = stubGoogle(AT_PINOPOLIS);
  let [r, u] = req('/places/status', { body: PINOPOLIS, token: null });
  assert.equal((await handlePlaces(r, env(), u)).status, 401);
  [r, u] = req('/places/status', { body: PINOPOLIS });
  const noKey = await handlePlaces(r, env({ PLACES_API_KEY: '' }), u);
  assert.equal(noKey.status, 503);
  assert.match((await noKey.json()).error, /PLACES_API_KEY/);
  [r, u] = req('/places/status', { body: { lat: 'x' } });
  assert.equal((await handlePlaces(r, env(), u)).status, 400);
  assert.equal(calls.length, 0);
});

test('a refusal from Google carries its status, and is not cached as an answer', async () => {
  const calls = stubGoogle([], 403);
  const e = env();
  const [r, u] = req('/places/status', { body: PINOPOLIS });
  const res = await handlePlaces(r, e, u);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'places 403');
  assert.equal(calls.length, 1);
  assert.ok(![...e.KV.store.keys()].some((k) => k.startsWith('places:status:')));
});

test('the plan says it: closed is a warning with the name, the distance and the day', () => {
  const res = { day: '2026-10-01', launch: { name: 'William Dennis Boat Landing', m: 62,
                status: 'CLOSED_TEMPORARILY' } };
  const n = launchStatusNote(res, 'William Dennis (Pinopolis tailrace)');
  assert.equal(n.warning, 'Google lists William Dennis Boat Landing (62 m from the ramp) as '
    + 'temporarily closed (checked 2026-10-01).');
  assert.equal(n.decision, null);
  const gone = launchStatusNote({ ...res, launch: { ...res.launch, status: 'CLOSED_PERMANENTLY' } }, 'x');
  assert.match(gone.warning, /permanently closed/);
});

test('and everything else is a settled line, so a plan always says whether the check ran', () => {
  const open = launchStatusNote({ day: '2026-10-01', launch: { name: 'Clearwater Cove Landing',
                                  m: 18, status: 'OPERATIONAL' } }, 'Clearwater Cove');
  assert.equal(open.warning, null);
  assert.equal(open.decision, 'Google lists Clearwater Cove Landing (18 m from the ramp) as '
    + 'operating, with no closure listed (checked 2026-10-01).');
  const none = launchStatusNote({ day: '2026-10-01', launch: null,
                                  why: 'the nearest thing Google has is 412 m away' }, 'Unnamed slipway');
  assert.equal(none.warning, null);
  assert.match(none.decision, /^Google has no listing for "Unnamed slipway", so whether it is open could not be checked \(checked 2026-10-01\) -- the nearest thing Google has is 412 m away\.$/);
  const failed = launchStatusNote({ error: 'monthly budget reached' }, 'Hilton');
  assert.equal(failed.decision, 'The closure check for "Hilton" did not run: monthly budget reached.');
  assert.deepEqual(launchStatusNote(null, 'x'), { warning: null, decision: null });
});

test('the app asks with the Worker token, from the ramp\'s own [lon, lat], and never throws', async () => {
  const seen = [];
  const ok = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ day: 'd', launch: null }) }; };
  const got = await askLaunchStatus({ worker: 'https://w.example', lonLat: [-79.97347, 33.21311], fetchImpl: ok });
  assert.deepEqual(got, { day: 'd', launch: null });
  assert.equal(seen[0].url, 'https://w.example/places/status');
  assert.ok('X-Sync-Token' in seen[0].init.headers, 'the token header rides, as on every paid route');
  assert.deepEqual(JSON.parse(seen[0].init.body), { lat: 33.21311, lon: -79.97347 });
  const no = async () => ({ ok: false, status: 429, json: async () => ({ error: 'monthly budget reached' }) });
  assert.deepEqual(await askLaunchStatus({ worker: 'w', lonLat: [-80, 34], fetchImpl: no }),
    { error: 'monthly budget reached' });
  const boom = async () => { throw new Error('offline'); };
  assert.deepEqual(await askLaunchStatus({ worker: 'w', lonLat: [-80, 34], fetchImpl: boom }), { error: 'offline' });
  // Number(null) is 0: a launch with no position must not be asked about at 0, 0.
  const before = seen.length;
  assert.equal(await askLaunchStatus({ worker: 'w', lonLat: null, fetchImpl: ok }), null);
  assert.equal(await askLaunchStatus({ worker: 'w', lonLat: [null, null], fetchImpl: ok }), null);
  assert.equal(seen.length, before);
});

test('both planners ask, and Smart Plan does not spend on a dry run', () => {
  const sp = strip(read('js/modules/smart-plan-v2-wiring.js'));
  assert.match(sp, /const launchStatus = opts\.dryRun \? null : askLaunchStatus\(\{ worker: CF_WORKER_URL, lonLat: ramp \}\);/);
  assert.match(sp, /launchStatusNote\(await launchStatus, inp\.rampName\)/);
  const pw = strip(read('js/modules/plan-water-ui.js'));
  assert.match(pw, /const launchStatus = askLaunchStatus\(\{ worker: CF_WORKER_URL, lonLat: T\.ramp \}\);/);
  assert.match(pw, /launchStatusNote\(await launchStatus, T\.rampName\)/);
  for (const code of [sp, pw]) {
    assert.match(code, /if \(ls\.warning\) r\.problems = \[\.\.\.\(r\.problems \|\| \[\]\), ls\.warning\];/);
    assert.match(code, /if \(ls\.decision && r\.plan\) r\.plan\.decisions = \[\.\.\.\(r\.plan\.decisions \|\| \[\]\), ls\.decision\];/);
  }
});

test('the hand-written closure is gone from both places that carried it', () => {
  assert.doesNotMatch(strip(read('js/modules/plan-builder.js')), /temporarily closed/i);
  assert.doesNotMatch(strip(read('js/modules/fishing-index.js')), /Temporarily closed/i);
});
