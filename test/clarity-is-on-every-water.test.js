// Personal use only, not for distribution or resale; not for navigation.
//
// CLARITY IS ON EVERY WATER, NOT SIX.
//
// Ryan, 2026-09-24: "what i said for clarity that was not right was that it was only on 6
// waters... i have nothing to say about the method... i just thought it was already on all
// waters since i had already asked for everything for one water to be on all of them".
//
// Six lakes had a hand-written rain sensitivity per zone. Every other water got 1.2 and 0.75.
// Now each lake's level comes from its own watershed -- drainage over surface, from the
// water_chain.json the Worker already reads -- ranked and placed on those same two numbers'
// range. The fixture is the real chain and index of 2026-09-24, frozen, because CI has no
// registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GENERIC_LAKE_ZONES, sensitivityRange, meanSensitivity, watershedRanks,
         watershedSensitivity, zonesForSensitivity } from '../Worker/clarity-sensitivity.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/clarity-is-on-every-water.2026-09-24.json',
  import.meta.url), 'utf8'));
const chain = FX.water_chain;
const index = Object.fromEntries(Object.entries(FX.feature_type)
  .map(([s, ft]) => [s, { slug: s, feature_type: ft, ...(FX.lake_index[s] || {}) }]));

// The six hand profiles' mean zone sensitivity, as written in LAKE_CLARITY_PROFILES.
const HAND = { wateree_lake: 1.142, lake_marion: 1.125, lake_murray: 1.025, hartwell_lake: 1.017,
               lake_moultrie: 0.95, lake_keowee: 0.8 };

function spearman(xs, ys) {
  const rk = (v) => { const o = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = []; o.forEach(([, i], p) => { r[i] = p; }); return r; };
  const a = rk(xs), b = rk(ys), n = xs.length;
  return 1 - 6 * a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0) / (n * (n * n - 1));
}

test('the range is read off the generic zones, not typed twice', () => {
  assert.deepEqual(sensitivityRange(), [0.75, 1.2]);
  assert.equal(meanSensitivity(), 0.975);
  assert.deepEqual(GENERIC_LAKE_ZONES.map((z) => z.sensitivity), [1.2, 0.75]);
});

test('every lake the chain placed gets its own number; rivers are not ranked', () => {
  const ranks = watershedRanks(chain, index);
  const lakes = Object.keys(chain).filter((s) => index[s]?.feature_type === 'lake');
  const placed = lakes.filter((s) => ranks.has(s));
  assert.equal(placed.length, lakes.length, 'a registry lake in the chain fell out of the ranking');
  assert.ok(placed.length >= 270, `only ${placed.length} registry lakes ranked`);
  for (const s of Object.keys(chain).filter((x) => index[x]?.feature_type === 'river')) {
    assert.equal(ranks.has(s), false, `${s} is a river and was ranked`);
  }
  const values = placed.map((s) => watershedSensitivity(chain, s, { index }).value);
  // The ends of the range belong to whichever chain waters have the extreme ratios, which need not
  // be registry lakes; the registry lakes land inside it and reach close to both ends.
  assert.ok(Math.min(...values) >= 0.75 && Math.min(...values) < 0.76, `min ${Math.min(...values)}`);
  assert.ok(Math.max(...values) <= 1.2 && Math.max(...values) > 1.19, `max ${Math.max(...values)}`);
  assert.ok(new Set(values).size > 200, 'the numbers are the waters\' own, not a handful of bins');
});

test('the watershed orders the six hand-written lakes the way their authors did', () => {
  const slugs = Object.keys(HAND);
  const derived = slugs.map((s) => watershedSensitivity(chain, s, { index }));
  for (const d of derived) assert.equal(d.source, 'watershed');
  const rho = spearman(slugs.map((s) => HAND[s]), derived.map((d) => d.value));
  // 0.886 on 2026-09-24: two neighbouring swaps, Murray/Hartwell (0.008 apart by hand) and
  // Moultrie/Keowee (Moultrie's river arrives through the Diversion Canal, already settled).
  assert.ok(rho >= 0.85, `Spearman ${rho.toFixed(3)} against the hand profiles`);
  const w = watershedSensitivity(chain, 'wateree_lake', { index });
  const k = watershedSensitivity(chain, 'lake_keowee', { index });
  assert.ok(w.value > k.value, 'Wateree stains faster than Keowee');
});

test('a river, and a water the chain never placed, say why they keep the generic rates', () => {
  const r = watershedSensitivity(chain, 'congaree_river', { index });
  assert.equal(r.source, 'generic');
  assert.equal(r.value, null);
  assert.match(r.why, /river piece/);
  const none = watershedSensitivity(chain, 'no_such_water', { index });
  assert.equal(none.source, 'generic');
  assert.match(none.why, /not in water_chain/);
});

test('each zone keeps its share of the spread, and the zones average to the water\'s number', () => {
  for (const v of [0.75, 0.9, 1.2]) {
    const z = zonesForSensitivity(v);
    assert.equal(z[0].name, 'Creeks/upper arms');
    assert.ok(z[0].sensitivity > z[1].sensitivity);
    const mean = (z[0].sensitivity + z[1].sensitivity) / 2;
    assert.ok(Math.abs(mean - v) < 0.001, `mean ${mean} for ${v}`);
    assert.ok(Math.abs(z[0].sensitivity / z[1].sensitivity - 1.2 / 0.75) < 0.01);
  }
});

test('ties share one position, so file order cannot decide a water\'s number', () => {
  const c = { a: { drainage_km2: 10, nhd_area_km2: 1 }, b: { drainage_km2: 20, nhd_area_km2: 2 },
              c: { drainage_km2: 5, nhd_area_km2: 1 }, d: { drainage_km2: 50, nhd_area_km2: 1 } };
  const r = watershedRanks(c);
  assert.equal(r.get('a').pos, r.get('b').pos);
  assert.equal(r.get('c').pos, 0);
  assert.equal(r.get('d').pos, 1);
});

// ── THROUGH THE REAL MODEL ──────────────────────────────────────────────────────────────────────
// A stub bucket carrying the frozen chain and index, and no rain or WQP: the payload is the model's
// own answer with nothing live in it.
function bucket() {
  const lakeIndex = Object.fromEntries(Object.keys(index).map((s) => [s, index[s]]));
  const store = new Map([
    ['_registry/lake_index.json', JSON.stringify(lakeIndex)],
    ['_registry/water_chain.json', JSON.stringify({ waters: chain })],
    ['_registry/water_ends.json', JSON.stringify({ waters: FX.water_ends })],
  ]);
  return {
    store,
    async get(k) { return store.has(k) ? { httpMetadata: {}, text: async () => store.get(k) } : null; },
    async put(k, v) { store.set(k, String(v)); },
  };
}
globalThis.fetch = async () => new Response('no', { status: 503 });
const { getLakeClarity } = await import('../Worker/worker-data.js');
const env = { R2_TROLLMAP_CHARTPACKS: bucket() };
const at = { lat: 34.0, lon: -81.0 };

test('a lake with no hand profile answers with its own watershed, and says so', async () => {
  const d = await getLakeClarity('Norris Lake', '2026-09-24', env, at, { slug: 'norris_lake' });
  assert.equal(d.water, 'norris_lake');
  assert.equal(d.sensitivity.source, 'watershed');
  const own = watershedSensitivity(chain, 'norris_lake', { index }).value;
  assert.ok(Math.abs(d.sensitivity.value - own) < 0.001);
  const zs = d.zones.map((z) => z.sensitivity);
  assert.ok(Math.abs((zs[0] + zs[1]) / 2 - own) < 0.001);
  assert.match(d.note, /rain response is its own/);
});

test('two lakes with different watersheds no longer get the same numbers', async () => {
  const a = await getLakeClarity('Norris Lake', '2026-09-24', env, at, { slug: 'norris_lake' });
  const b = await getLakeClarity('Belews Lake', '2026-09-24', env, at, { slug: 'belews_lake' });
  assert.notEqual(a.sensitivity.value, b.sensitivity.value);
});

test('the name is resolved to the registry water when no slug is sent', async () => {
  const name = FX.lake_index.lake_glenville.display_name;
  const d = await getLakeClarity(name, '2026-09-24', env, at);
  assert.equal(d.water, 'lake_glenville');
  assert.equal(d.sensitivity.source, 'watershed');
});

test('a hand profile is its own lake\'s, not every name containing its word', async () => {
  // The Wateree RIVER used to get Lake Wateree's six zones, ramps and rain point.
  const river = await getLakeClarity(FX.lake_index.wateree_river.display_name, '2026-09-24', env, at);
  assert.equal(river.water, 'wateree_river');
  assert.notEqual(river.sensitivity.source, 'hand-authored');
  assert.equal(river.zones.length, 2);
  assert.ok(!river.zones.some((z) => /dam basin|Dutchmans/.test(z.name)));
  // Two lakes in Marion COUNTY used to get Lake Marion's.
  for (const s of ['graves_lake', 'russ_lake']) {
    const d = await getLakeClarity(FX.lake_index[s].display_name, '2026-09-24', env, at);
    assert.equal(d.water, s);
    assert.notEqual(d.sensitivity.source, 'hand-authored', `${s} got Lake Marion's zones`);
  }
  // Thurmond's legacy "Murray Creek - Clarks Hill Lake" used to get Lake Murray's.
  const t = await getLakeClarity('Murray Creek - Clarks Hill Lake', '2026-09-24', env, at);
  assert.equal(t.water, 'j_strom_thurmond_reservoir');
  assert.notEqual(t.sensitivity.source, 'hand-authored');
});

test('the six keep their hand-written zones, with the watershed beside them as a cross-check', async () => {
  const d = await getLakeClarity(FX.lake_index.wateree_lake.display_name, '2026-09-24', env, at);
  assert.equal(d.water, 'wateree_lake');
  assert.equal(d.sensitivity.source, 'hand-authored');
  assert.equal(d.zones.length, 6);
  assert.equal(d.sensitivity.watershed.source, 'watershed');
  assert.equal(d.rainPoint.basis, "the lake's own hand-authored point");
});

test('with no registry to read, the model behaves exactly as it did', async () => {
  const bare = { R2_TROLLMAP_CHARTPACKS: { async get() { return null; }, async put() {} } };
  const w = await getLakeClarity('Lake Wateree', '2026-09-24', bare, at);
  assert.equal(w.sensitivity.source, 'hand-authored');
  const g = await getLakeClarity('Some Pond', '2026-09-24', bare, at);
  assert.equal(g.sensitivity.source, 'generic');
  assert.deepEqual(g.zones.map((z) => z.sensitivity), [1.2, 0.75]);
});

// ── AND THE LAUNCH GETS ITS OWN ZONE ────────────────────────────────────────────────────────────
// Norris: outlet at Norris Dam (36.224, -84.093), far end up the Clinch/Powell (36.383, -83.428).
const NEAR_DAM = { lat: 36.235, lon: -84.07, isLaunch: true };
const UP_ARM = { lat: 36.37, lon: -83.47, isLaunch: true };

test('a launch near the outlet is in the lower zone, one up the arm is in the upper', async () => {
  const lo = await getLakeClarity('Norris Lake', '2026-09-24', env, NEAR_DAM, { slug: 'norris_lake' });
  const hi = await getLakeClarity('Norris Lake', '2026-09-24', env, UP_ARM, { slug: 'norris_lake' });
  assert.equal(lo.launchZone.name, 'Main lake/lower basin');
  assert.equal(hi.launchZone.name, 'Creeks/upper arms');
  assert.ok(lo.launchZone.outletKm < lo.launchZone.farKm);
  assert.ok(hi.launchZone.farKm < hi.launchZone.outletKm);
  assert.match(hi.launchZone.why, /km from where the lake lets out and .* km from its far end/);
});

test('the plan is built on that zone, and says how it was chosen', async () => {
  const { clarityForPlan, versusNormalAt } = await import('../js/utils/clarity-at-ramp.js');
  const hi = await getLakeClarity('Norris Lake', '2026-09-24', env, UP_ARM, { slug: 'norris_lake' });
  const got = clarityForPlan(hi, 'Some Ramp');
  assert.equal(got.source, 'ramp');
  assert.equal(got.by, 'position');
  assert.equal(got.zone.name, 'Creeks/upper arms');
  assert.equal(got.select, hi.zones.find((z) => z.name === 'Creeks/upper arms').select);
  assert.match(got.why, /Some Ramp is in Creeks\/upper arms: the launch is/);
  assert.equal(versusNormalAt(hi, 'Some Ramp').scope, 'ramp');
});

test('no zone by position for a hand lake, a centroid, or a water with no ends', async () => {
  const w = await getLakeClarity(FX.lake_index.wateree_lake.display_name, '2026-09-24', env,
    { lat: 34.34, lon: -80.71, isLaunch: true });
  assert.equal(w.launchZone, null, 'the hand profile names its own ramps');
  const c = await getLakeClarity('Norris Lake', '2026-09-24', env, { lat: 36.37, lon: -83.47 },
    { slug: 'norris_lake' });
  assert.equal(c.launchZone, null, 'a centroid is not where he launches');
  const r = await getLakeClarity(FX.lake_index.congaree_river.display_name, '2026-09-24', env,
    { lat: 33.9, lon: -80.9, isLaunch: true });
  assert.equal(r.launchZone, null, 'a river has no outlet and far end');
});

test('the app sends the registry water with its clarity request', () => {
  for (const f of ['../js/modules/plan-preflight.js', '../js/modules/lake-intel.js']) {
    const s = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(s, /&slug=\$\{encodeURIComponent\(/, `${f} sends the slug`);
  }
});
