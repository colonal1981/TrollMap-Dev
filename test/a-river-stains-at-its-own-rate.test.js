// Personal use only, not for distribution or resale; not for navigation.
//
// A RIVER STAINS AT ITS OWN RATE.
//
// Register item `clarity-rivers-use-the-lake-model`: every river got the generic 1.2/0.75 rain
// rates, because a river piece has no pool for a flush ratio to be measured against. Ryan,
// 2026-09-25: "I think the clarity model was fixed for rivers please confirm but if it is still
// open go ahead with it". It was half done -- the card said what today's flow has meant for the
// river's clarity, but the model under it still gave every river the same two numbers.
//
// Each river's own readings now set its level: the median turbidity when its gauge runs above
// normal, over the median at normal, ranked across every river and placed on the same range the
// lakes use. The fixture is the live registry/river_clarity_by_flow.json of 2026-09-24, frozen,
// with the chain and index frozen for the clarity-on-every-water test, because CI has no registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { highFlowBand, riverFlowRanks, riverFlowSensitivity, watershedSensitivity,
         sensitivityRange } from '../Worker/clarity-sensitivity.js';

const T = JSON.parse(readFileSync(new URL('./fixtures/a-river-stains-at-its-own-rate.2026-09-24.json',
  import.meta.url), 'utf8'));
const FX = JSON.parse(readFileSync(new URL('./fixtures/clarity-is-on-every-water.2026-09-24.json',
  import.meta.url), 'utf8'));
const chain = FX.water_chain;
const index = Object.fromEntries(Object.entries(FX.feature_type)
  .map(([s, ft]) => [s, { slug: s, feature_type: ft, ...(FX.lake_index[s] || {}) }]));

const value = (s) => riverFlowSensitivity(T, s).value;

test('the high-flow band is read off the table\'s own normal bands', () => {
  assert.equal(highFlowBand(T), 'above the 75th percentile');
  assert.equal(highFlowBand({ normal_bands: ['between the 25th and 50th percentile',
    'between the 50th and 90th percentile'] }), 'above the 90th percentile');
  assert.equal(highFlowBand({}), null);
});

test('every river the table can place gets its own number, across the model\'s whole range', () => {
  const ranks = riverFlowRanks(T);
  // 45 rivers in the table and all 45 have a gauge with readings both above and at normal flow.
  assert.equal(ranks.size, Object.keys(T.waters).length);
  assert.equal(ranks.size, 45);
  const [lo, hi] = sensitivityRange();
  const vs = [...ranks.keys()].map(value);
  assert.equal(Math.min(...vs), lo);
  assert.equal(Math.max(...vs), hi);
  assert.ok(new Set(vs).size >= 40, 'the numbers are the rivers\' own, not a handful of bins');
  for (const s of ranks.keys()) assert.equal(index[s]?.feature_type, 'river', `${s} is not a river`);
});

test('the ranking has the order the 2026-09-24 correlation found', () => {
  // Weak or none: a regulated tailwater, tidal water, blackwater. Strongest: the piedmont.
  const weak = ['tuckasegee_river', 'waccamaw_river', 'cooper_river', 'lumber_river', 'black_river'];
  const strong = ['broad_river', 'broad_river_2', 'first_broad_river', 'south_yadkin_river', 'dan_river'];
  const topWeak = Math.max(...weak.map(value));
  const lowStrong = Math.min(...strong.map(value));
  assert.ok(topWeak < lowStrong, `weak up to ${topWeak}, strong from ${lowStrong}`);
  assert.equal(value('tuckasegee_river'), 0.75, 'the Tuckasegee runs clearer at high flow');
  assert.ok(value('congaree_river') > value('cooper_river'));
});

test('the gauge with the most readings at high flow speaks for the river', () => {
  const lt = riverFlowSensitivity(T, 'little_tennessee_river');
  assert.equal(lt.usgsSite, '03500000', 'not 03501500, which placed one reading at high flow');
  assert.equal(lt.high.n, 33);
  assert.equal(lt.stainRatio, 2.73);
  const b = riverFlowSensitivity(T, 'broad_river');
  assert.equal(b.source, 'river-flow');
  assert.equal(b.measure, 'turbidity');
  assert.match(b.why, /^when USGS 02153551 runs above the 75th percentile, its readings have run 17 NTU turbidity \(330 readings\) against 8\.8 at normal flow \(459\), 1\.93 times: \d+ of 45 rivers/);
});

test('ties share one position, and file order cannot decide a gauge or a river', () => {
  const band = (hi, no, n = 10) => ({ bands: { 'above the 75th percentile': { turbidity: { median_ntu: hi, n } } },
                                      normal: { turbidity: { median_ntu: no, n } } });
  const t = { normal_bands: ['between the 50th and 75th percentile'],
              waters: { a: { sites: { '1': band(20, 10) } }, b: { sites: { '2': band(10, 5) } },
                        c: { sites: { '3': band(5, 5) } }, d: { sites: { '4': band(40, 10) } },
                        e: { sites: { '9': band(30, 10, 5), '8': band(20, 10, 5) } } } };
  const r = riverFlowRanks(t);
  assert.equal(r.get('a').pos, r.get('b').pos);
  assert.equal(r.get('c').pos, 0);
  assert.equal(r.get('d').pos, 1);
  // Two gauges with equal counts: the lower site number, whatever order the file lists them in.
  assert.equal(riverFlowSensitivity(t, 'e').usgsSite, '8');
});

test('Secchi counts where a gauge has no turbidity, the right way up', () => {
  const t = { normal_bands: ['between the 50th and 75th percentile'],
              waters: { s: { sites: { '1': { bands: { 'above the 75th percentile': { secchi: { median_ft: 2, n: 9 } } },
                                               normal: { secchi: { median_ft: 4, n: 20 } } } } },
                        u: { sites: { '2': { bands: { 'above the 75th percentile': { turbidity: { median_ntu: 11, n: 9 } } },
                                               normal: { turbidity: { median_ntu: 10, n: 20 } } } } } } };
  const s = riverFlowSensitivity(t, 's');
  assert.equal(s.measure, 'secchi');
  assert.equal(s.stainRatio, 2, 'half the visibility at high flow is twice as murky');
  assert.ok(s.value > riverFlowSensitivity(t, 'u').value);
});

test('a river with no readings, and a river with no table, keep the generic rates and say why', () => {
  const a = riverFlowSensitivity(T, 'ashley_river');
  assert.equal(a.source, 'generic');
  assert.equal(a.value, null);
  assert.match(a.why, /no bound gauge with daily statistics/);
  const none = riverFlowSensitivity(null, 'congaree_river');
  assert.equal(none.source, 'generic');
  assert.match(none.why, /not in the bucket/);
});

test('the watershed still does not rank a river, and says where its number comes from', () => {
  const r = watershedSensitivity(chain, 'congaree_river', { index });
  assert.equal(r.value, null);
  assert.match(r.why, /ranked on its own clarity at high flow/);
});

// ── THROUGH THE REAL MODEL ──────────────────────────────────────────────────────────────────────
function bucket(withTable = true) {
  const store = new Map([
    ['_registry/lake_index.json', JSON.stringify(index)],
    ['_registry/water_chain.json', JSON.stringify({ waters: chain })],
    ['_registry/water_ends.json', JSON.stringify({ waters: FX.water_ends })],
  ]);
  if (withTable) store.set('_registry/river_clarity_by_flow.json', JSON.stringify(T));
  return {
    async get(k) { return store.has(k) ? { httpMetadata: {}, text: async () => store.get(k) } : null; },
    async put(k, v) { store.set(k, String(v)); },
  };
}
globalThis.fetch = async () => new Response('no', { status: 503 });
const { getLakeClarity } = await import('../Worker/worker-data.js');
const { _resetIndexCache } = await import('../Worker/registry.js');
const at = { lat: 34.0, lon: -81.0 };

test('a river answers with its own rate, on its upper and lower reaches', async () => {
  _resetIndexCache();
  const env = { R2_TROLLMAP_CHARTPACKS: bucket() };
  const d = await getLakeClarity('Congaree River', '2026-09-25', env, at, { slug: 'congaree_river' });
  assert.equal(d.water, 'congaree_river');
  assert.equal(d.sensitivity.source, 'river-flow');
  assert.ok(Math.abs(d.sensitivity.value - value('congaree_river')) < 0.001);
  assert.deepEqual(d.zones.map((z) => z.name), ['Upper reach', 'Lower reach']);
  const zs = d.zones.map((z) => z.sensitivity);
  assert.ok(Math.abs((zs[0] + zs[1]) / 2 - value('congaree_river')) < 0.001);
  assert.ok(zs[0] > zs[1]);
  assert.match(d.note, /Its rain response is its own: when USGS/);

  const c = await getLakeClarity('Cooper River', '2026-09-25', env, at, { slug: 'cooper_river' });
  assert.ok(c.sensitivity.value < d.sensitivity.value, 'the tidal Cooper moves less than the Congaree');

  const a = await getLakeClarity('Ashley River', '2026-09-25', env, at, { slug: 'ashley_river' });
  assert.equal(a.sensitivity.source, 'generic');
  assert.deepEqual(a.zones.map((z) => z.sensitivity), [1.2, 0.75]);
  assert.match(a.note, /keeps the generic rain rates: river_clarity_by_flow\.json has no readings/);

  const lake = await getLakeClarity('Norris Lake', '2026-09-25', env, at, { slug: 'norris_lake' });
  assert.equal(lake.sensitivity.source, 'watershed', 'a lake is still ranked on its watershed');
});

test('with no table in the bucket, a river keeps the generic rates and says the table is missing', async () => {
  _resetIndexCache();
  const env = { R2_TROLLMAP_CHARTPACKS: bucket(false) };
  const d = await getLakeClarity('Congaree River', '2026-09-25', env, at, { slug: 'congaree_river' });
  assert.equal(d.sensitivity.source, 'generic');
  assert.deepEqual(d.zones.map((z) => z.sensitivity), [1.2, 0.75]);
  assert.match(d.sensitivity.why, /not in the bucket/);
});
