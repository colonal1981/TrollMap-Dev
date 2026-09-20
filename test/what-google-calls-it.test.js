//
// Ryan, on the ramp dropdown: "planning a trip from 'unnamed launch' doesn't sound right to
// me", and then: "i want to try and figure out how to name them at least on the waters i
// actually care about... unless you have an automated way to do the looking for me".
//
// This is the automated way, and it spends his money, so most of what is asserted here is about
// NOT spending it: the cache, the budget, the token, and the field mask -- because in Places API
// pricing one higher-tier field upgrades the whole response to that tier's price, so the mask is
// the bill.
//
// The numbers these are written against, measured 2026-09-20: Essentials 10,000 free calls a
// month, Pro 5,000, Enterprise 1,000, each an independent pool. `businessStatus` and
// `displayName` are Pro. 152 distinct unnamed launches on the waters Ryan fishes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePlaces } from '../Worker/places.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'Worker', 'places.js'), 'utf8');
const TOKEN = 'trollmap2026';

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

/** Counts every outbound call, because every outbound call is money. */
function stubGoogle(places = []) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: (init && init.headers) || {},
                 body: JSON.parse((init && init.body) || '{}') });
    return { ok: true, status: 200, json: async () => ({ places }) };
  };
  return calls;
}

const env = (extra = {}) => ({ KV: kvStub(), SYNC_TOKEN: TOKEN,
                               PLACES_API_KEY: 'not-a-real-key', ...extra });

function req(path, { method = 'GET', body = null, token = TOKEN } = {}) {
  const url = new URL(`https://w.example${path}`);
  const headers = { 'content-type': 'application/json' };
  if (token) headers['X-Sync-Token'] = token;
  return [new Request(url.toString(), {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  }), url];
}

const RAMP = [{ id: 'ChIJramp', displayName: { text: 'Dreher Island Boat Ramp' },
                types: ['marina', 'point_of_interest'],
                location: { latitude: 34.0900, longitude: -81.3000 } }];

test('the field mask asks for Pro fields and not one Enterprise field', () => {
  // THIS TEST IS THE BILL. In Places API (New) pricing a single higher-tier field upgrades the
  // WHOLE response to that tier: asking for displayName (Pro) plus rating (Enterprise) bills
  // every call at Enterprise, where the free pool is 1,000 a month instead of 5,000.
  const mask = SRC.match(/const FIELD_MASK = '([^']+)'/);
  assert.ok(mask, 'FIELD_MASK is still a literal that can be read');
  const fields = mask[1].split(',').map((f) => f.replace(/^places\./, ''));
  const ENTERPRISE = ['rating', 'userRatingCount', 'regularOpeningHours', 'currentOpeningHours',
                      'priceLevel', 'priceRange', 'websiteUri', 'nationalPhoneNumber',
                      'internationalPhoneNumber', 'reviews', 'photos'];
  for (const f of fields) {
    assert.ok(!ENTERPRISE.includes(f), `${f} is an Enterprise field and would reprice every call`);
  }
  assert.ok(fields.includes('displayName'), 'the name is the whole point of the call');
});

test('a GET reports the budget and spends nothing', async () => {
  const calls = stubGoogle(RAMP);
  const [r, u] = req('/places/name');
  const j = await (await handlePlaces(r, env(), u)).json();
  assert.equal(j.spent, 0);
  assert.equal(j.configured, true);
  assert.equal(calls.length, 0, 'checking the budget must not cost anything');
});

test('a POST without the token is refused before it can spend', async () => {
  const calls = stubGoogle(RAMP);
  const [r, u] = req('/places/name', { method: 'POST', token: null,
                                       body: { points: [{ lat: 34.09, lon: -81.30 }] } });
  const res = await handlePlaces(r, env(), u);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('the same coordinate is only ever paid for once', async () => {
  const e = env();
  const calls = stubGoogle(RAMP);
  const body = { points: [{ lat: 34.09, lon: -81.30 }] };

  const [r1, u1] = req('/places/name', { method: 'POST', body });
  const a = await (await handlePlaces(r1, e, u1)).json();
  assert.equal(a.results[0].results[0].name, 'Dreher Island Boat Ramp');
  assert.equal(a.budget.this_call, 1);
  assert.equal(calls.length, 1);

  const [r2, u2] = req('/places/name', { method: 'POST', body });
  const b = await (await handlePlaces(r2, e, u2)).json();
  assert.equal(b.results[0].cached, true);
  assert.equal(b.budget.this_call, 0, 'a re-run of the whole sweep must cost nothing');
  assert.equal(calls.length, 1, 'and must not reach Google at all');
  assert.equal(b.budget.spent, 1);
});

test('"Google has nothing here" is cached too, because it is an answer', async () => {
  const e = env();
  const calls = stubGoogle([]);                    // an empty result
  const body = { points: [{ lat: 33.5, lon: -80.5 }] };
  await handlePlaces(...(() => { const [r, u] = req('/places/name', { method: 'POST', body }); return [r, e, u]; })());
  const [r2, u2] = req('/places/name', { method: 'POST', body });
  const b = await (await handlePlaces(r2, e, u2)).json();
  assert.equal(calls.length, 1, 'an empty answer is not worth paying for twice');
  assert.deepEqual(b.results[0].results, []);
});

test('the monthly ceiling stops it, per point, and says so', async () => {
  const month = new Date().toISOString().slice(0, 7);
  const e = env({ KV: kvStub({ 'places:spent': JSON.stringify({ month, spent: 1000 }) }) });
  const calls = stubGoogle(RAMP);
  const [r, u] = req('/places/name', { method: 'POST',
                                       body: { points: [{ lat: 34.09, lon: -81.30 }] } });
  const j = await (await handlePlaces(r, e, u)).json();
  assert.match(j.results[0].error, /budget/);
  assert.equal(calls.length, 0, 'the ceiling has to bite BEFORE the request goes out');
});

test('a missing counter is a fresh month, not a blown budget', async () => {
  // The mirror of the trap research/clients.js already fell into: there, a missing key read as
  // ZERO REMAINING and silently disabled Firecrawl. Reading it as "already spent" here would
  // silently disable this instead. A missing counter means the month has not started.
  const e = env();                                  // nothing in KV at all
  const calls = stubGoogle(RAMP);
  const [r, u] = req('/places/name', { method: 'POST',
                                       body: { points: [{ lat: 34.09, lon: -81.30 }] } });
  const j = await (await handlePlaces(r, e, u)).json();
  assert.equal(j.budget.this_call, 1);
  assert.equal(calls.length, 1);
});

test('last month\'s spend does not count against this month', async () => {
  const e = env({ KV: kvStub({ 'places:spent': JSON.stringify({ month: '2020-01', spent: 999999 }) }) });
  stubGoogle(RAMP);
  const [r, u] = req('/places/name', { method: 'POST',
                                       body: { points: [{ lat: 34.09, lon: -81.30 }] } });
  const j = await (await handlePlaces(r, e, u)).json();
  assert.equal(j.budget.spent, 1, 'the pool resets with the calendar month, and so does this');
});

test('one request cannot spend a day of quota', async () => {
  stubGoogle(RAMP);
  const points = Array.from({ length: 40 }, (_, i) => ({ lat: 34 + i / 1000, lon: -81 }));
  const [r, u] = req('/places/name', { method: 'POST', body: { points } });
  const res = await handlePlaces(r, env(), u);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /at most 25/);
});

test('no key on the Worker is a stated fact, not a crash', async () => {
  const [r, u] = req('/places/name', { method: 'POST',
                                       body: { points: [{ lat: 34.09, lon: -81.30 }] } });
  const res = await handlePlaces(r, env({ PLACES_API_KEY: '' }), u);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /PLACES_API_KEY/);
});

test('the radius asked for is the radius documented', () => {
  // A bigger radius returns a bigger neighbourhood, not a better answer, and every extra metre
  // is another chance to name a ramp after the restaurant across the road.
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ places: [] }) };
  };
  const [r, u] = req('/places/name', { method: 'POST',
                                       body: { points: [{ lat: 34.09, lon: -81.30 }] } });
  return handlePlaces(r, env(), u).then(() => {
    assert.equal(calls[0].locationRestriction.circle.radius, 150);
    assert.equal(calls[0].rankPreference, 'DISTANCE');
  });
});

test('the route says nothing when the path is not its own', async () => {
  const [r, u] = req('/alerts/status');
  assert.equal(await handlePlaces(r, env(), u), null);
});
