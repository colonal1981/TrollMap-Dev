// Personal use only, not for distribution or resale; not for navigation.
//
// A STATION COUNTS ONLY ON ITS OWN WATER.
//
// The WQP pull asks for everything inside the water's registry BOX. Measured 2026-09-24: 259 of 279
// Secchi stations on rivers were more than 1 km off the river -- the Great Pee Dee was reading Lake
// Moultrie, 75 km away -- and 34 of 528 lake stations were off their lake (Hiwassee averaging in 71
// readings from Lake Chatuge). Each became that water's measured "normal".
//
// These run the real pull and the real model against a stubbed bucket that carries the water's
// outline, and a stubbed WQP whose box holds the water AND a lake beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polygonsOf, onWater } from '../Worker/research/on-water.js';

const HEAD = ['OrganizationFormalName', 'ProjectIdentifier', 'MonitoringLocationIdentifier',
  'ActivityStartDate', 'ActivityDepthHeightMeasure/MeasureValue',
  'ActivityDepthHeightMeasure/MeasureUnitCode', 'CharacteristicName', 'ResultMeasureValue',
  'ResultMeasure/MeasureUnitCode', 'ResultDepthHeightMeasure/MeasureValue',
  'ResultDepthHeightMeasure/MeasureUnitCode'].join(',');
const rows = (id, n, ft, ch = 'Depth, Secchi disk depth', unit = 'ft') => Array.from({ length: n }, (_, i) =>
  `ORG,P1,${id},${2012 + i}-06-01,,,"${ch}",${ft},${unit},,`);
const SHEAD = 'OrganizationIdentifier,MonitoringLocationIdentifier,MonitoringLocationName,MonitoringLocationTypeName,LatitudeMeasure,LongitudeMeasure';

// THE LAKE: a square from -81.40 to -81.30, 34.00 to 34.10, with an island hole in the middle.
const LAKE = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: {
  type: 'Polygon', coordinates: [
    [[-81.40, 34.00], [-81.30, 34.00], [-81.30, 34.10], [-81.40, 34.10], [-81.40, 34.00]],
    [[-81.36, 34.04], [-81.34, 34.04], [-81.34, 34.06], [-81.36, 34.06], [-81.36, 34.04]],
  ] } }] };
// THE RIVER: a thin strip; its box is much wider than it is.
const RIVER = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [
  [[-82.40, 35.000], [-82.00, 35.000], [-82.00, 35.004], [-82.40, 35.004], [-82.40, 35.000]] ] } };

const LAKE_CSV = [HEAD, ...rows('ON-A', 10, 4), ...rows('OFF-POND', 20, 12)].join('\n');
const LAKE_ST = [SHEAD,
  'O,ON-A,ON THE LAKE,Lake,34.0200,-81.3800',
  'O,OFF-POND,THE POND NEXT DOOR,Lake,34.1500,-81.3500'].join('\n');
// Everything the river's box holds is somebody else's water: a reservoir's Secchi and its turbidity.
const RIVER_CSV = [HEAD, ...rows('RES-1', 30, 11), ...rows('RES-1', 3, 2, 'Turbidity', 'NTU')].join('\n');
const RIVER_ST = [SHEAD, 'O,RES-1,SOME RESERVOIR AT DAM,Lake,35.1500,-82.2000'].join('\n');

const pulls = [];
globalThis.fetch = async (input) => {
  const url = decodeURIComponent(typeof input === 'string' ? input : input.url);
  const river = url.includes('-82.4');
  if (url.includes('waterqualitydata.us/data/Station/')) return new Response(river ? RIVER_ST : LAKE_ST, { status: 200 });
  if (url.includes('waterqualitydata.us/data/Result/')) { pulls.push(url); return new Response(river ? RIVER_CSV : LAKE_CSV, { status: 200 }); }
  return new Response('no', { status: 503 });
};

const store = new Map([
  ['_registry/lake_index.json', JSON.stringify({
    box_lake: { slug: 'box_lake', name: 'Box Lake', display_name: 'Box Lake (Nowhere Co, SC)', state: 'SC',
      feature_type: 'lake', bounds_wsen: [-81.45, 33.95, -81.25, 34.20] },
    strip_river: { slug: 'strip_river', name: 'Strip River', display_name: 'Strip River (Nowhere Co, NC)',
      state: 'NC', feature_type: 'river', bounds_wsen: [-82.4, 34.9, -82.0, 35.2] },
  })],
  ['box_lake/boundary.geojson', JSON.stringify(LAKE)],
  ['strip_river/boundary.geojson', JSON.stringify(RIVER)],
]);
const env = { R2_TROLLMAP_CHARTPACKS: {
  async get(k) { return store.has(k) ? { httpMetadata: {}, text: async () => store.get(k) } : null; },
  async put(k, v) { store.set(k, String(v)); } } };

const { getLakeClarity } = await import('../Worker/worker-data.js');

test('inside the outline is on the water; the island and the pond next door are not', () => {
  const polys = polygonsOf(LAKE);
  assert.equal(onWater(polys, -81.38, 34.02), true);
  assert.equal(onWater(polys, -81.35, 34.05), false, 'a point in the island hole');
  assert.equal(onWater(polys, -81.35, 34.15), false, 'the pond is in the box and off the lake');
});

test('a lake reads only its own stations -- the pond in its box does not move its normal', async () => {
  const d = await getLakeClarity('Box Lake (Nowhere Co, SC)', '2026-09-24', env);
  assert.equal(d.measured.sampleCount, 10, 'only ON-A\'s ten readings');
  assert.equal(d.measured.avgSecchiDepthFt, 4, 'the pond\'s 12 ft is not averaged in');
  assert.deepEqual(d.measured.stations.map((s) => s.id), ['ON-A']);
  assert.equal(d.measured.onWater.checked, true);
  assert.equal(d.measured.onWater.stationsOff, 1);
  assert.equal(d.measured.onWater.off[0].name, 'THE POND NEXT DOOR');
});

test('a river whose box holds only a reservoir has no measurement, and says so', async () => {
  const d = await getLakeClarity('Strip River (Nowhere Co, NC)', '2026-09-24', env);
  assert.equal(d.measured, null, 'the reservoir\'s 11 ft and its turbidity are not the river\'s');
  assert.match(d.measuredNote, /No secchi measurements/);
});

test('that answer is cached, so the next request does not pull WQP again', async () => {
  pulls.length = 0;
  const d = await getLakeClarity('Strip River (Nowhere Co, NC)', '2026-09-24', env);
  assert.equal(d.measured, null);
  assert.equal(pulls.length, 0);
  const cached = JSON.parse(store.get('clarity-cache/strip_river.json'));
  assert.equal(cached.none, true);
  assert.equal(cached.onWater.checked, true);
});

// ── THE WHOLE PULL, NOT ONLY CLARITY ────────────────────────────────────────────────────────────
// The research profile's limnology (thermocline, oxygen, surface water, Secchi) comes from the
// same box through handleResearchLimnologyData -> wqpCached -> wqpPull.
const { handleResearchLimnologyData } = await import('../Worker/research/limnology.js');
const limno = async (name) => (await handleResearchLimnologyData(
  new Request('https://w.example/research/limnology-data', { method: 'POST',
    body: JSON.stringify({ lakeName: name }) }), env)).json();

test('the research pull keeps only the stations on the water, and says which it left out', async () => {
  const d = await limno('Box Lake (Nowhere Co, SC)');
  assert.equal(d.onWater.checked, true);
  assert.equal(d.recordCount, 10, 'ON-A\'s ten readings, not the pond\'s twenty');
  assert.equal(d.secchi.avgSecchiDepthFt, 4);
  assert.equal(d.onWater.readingsDropped, 20);
  assert.match(d.surfaceWater.note, /inside this water's outline/);
});

test('a river whose box holds only a reservoir gets no limnology, and that is cached as the answer', async () => {
  pulls.length = 0;
  const d = await limno('Strip River (Nowhere Co, NC)');
  assert.equal(d.recordCount, 0);
  assert.equal(d.onWater.checked, true);
  assert.match(d.note, /none at a station on the water/);
  assert.equal(pulls.length, 1);
  const again = await limno('Strip River (Nowhere Co, NC)');
  assert.equal(again.recordCount, 0);
  assert.equal(pulls.length, 1, 'the empty answer came from the cache, not a second pull');
});

test('a research cache from before the test is refetched, and never served as a stand-in', async () => {
  const key = [...store.keys()].find((k) => k.startsWith('limnology-cache/') && k.includes('box'));
  assert.ok(key, 'the box lake\'s pull was cached');
  store.set(key, JSON.stringify({ ok: true, recordCount: 30, fetchedAt: new Date().toISOString(),
    secchi: { avgSecchiDepthFt: 9.3, sampleCount: 30 } }));
  pulls.length = 0;
  const d = await limno('Box Lake (Nowhere Co, SC)');
  assert.equal(pulls.length, 1);
  assert.equal(d.secchi.avgSecchiDepthFt, 4);
});

test('a cache written before the test is refetched rather than trusted', async () => {
  store.set('clarity-cache/box_lake.json', JSON.stringify({ lakeName: 'Box Lake (Nowhere Co, SC)',
    fetchedAt: new Date().toISOString(), avgSecchiDepthFt: 9.3, sampleCount: 30, stations: [] }));
  pulls.length = 0;
  const d = await getLakeClarity('Box Lake (Nowhere Co, SC)', '2026-09-24', env);
  assert.equal(pulls.length, 1);
  assert.equal(d.measured.avgSecchiDepthFt, 4);
});
