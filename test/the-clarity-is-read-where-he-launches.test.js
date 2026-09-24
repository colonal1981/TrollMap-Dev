// Personal use only, not for distribution or resale; not for navigation.
//
// THE CLARITY IS READ WHERE HE LAUNCHES.
//
// The Worker's WQP pull (the resultPhysChem profile) carries each Secchi reading's station id and
// threw it away, so the only baseline the app could offer was the lake's average. Murray's
// stations average 1.7 ft at the top of the river arm and 9.0 ft near the dam, Hartwell's 5.3 to
// 16.3 ft (full-profile pulls on the drive). The average is water nobody launches into.
//
// Now the pull keeps a summary per station, joins each station's position from WQP's Station
// endpoint -- resultPhysChem has none, test/wqp-columns.test.js holds its real header -- and when
// the caller says the point IS the launch the payload carries `atLaunch`, read at the nearest
// station. These tests run the real pull and the real model against a stubbed bucket and a
// stubbed WQP, so what is asserted is what ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const NAME = 'Test Reservoir (Nowhere Co, SC)';

// Result rows in resultPhysChem's own column names -- no position, no station name. Two stations
// 27 km apart: A reads 2 ft (an upper arm), B reads 3 m = 9.8 ft (near a dam).
const CSV = [
  ['OrganizationFormalName', 'ProjectIdentifier', 'MonitoringLocationIdentifier',
   'ActivityStartDate', 'ActivityDepthHeightMeasure/MeasureValue',
   'ActivityDepthHeightMeasure/MeasureUnitCode', 'CharacteristicName', 'ResultMeasureValue',
   'ResultMeasure/MeasureUnitCode', 'ResultDepthHeightMeasure/MeasureValue',
   'ResultDepthHeightMeasure/MeasureUnitCode'].join(','),
  ...['2021-06-01', '2022-06-01', '2023-06-01'].map((d) =>
    `SCDES,P1,ST-A,${d},,,"Depth, Secchi disk depth",2,ft,,`),
  ...['2021-06-02', '2022-06-02', '2023-06-02'].map((d) =>
    `SCDES,P1,ST-B,${d},,,"Depth, Secchi disk depth",3,m,,`),
  // A station the Station endpoint does not list still counts toward the lake, and is never
  // anybody's nearest station.
  `SCDES,P1,ST-C,2023-06-03,,,"Depth, Secchi disk depth",2,ft,,`,
].join('\n');

// The Station endpoint, in the column names Scripts/wqp_clarity_coverage.py reads from it.
const STATIONS = [
  'OrganizationIdentifier,MonitoringLocationIdentifier,MonitoringLocationName,MonitoringLocationTypeName,LatitudeMeasure,LongitudeMeasure',
  '21SC60WQ,ST-A,UPPER ARM,Lake,34.1000,-81.4000',
  '21SC60WQ,ST-B,DAM FOREBAY,Lake,34.1000,-81.1000',
  '21SC60WQ,ST-Z,NEVER SAMPLED FOR SECCHI HERE,Lake,34.1500,-81.3900',
].join('\n');

function bucket(extra = {}) {
  const store = new Map(Object.entries({
    // BOTH waters, in the one index: the Worker caches lake_index per isolate for an hour, so a
    // second index handed to a later request is never read.
    '_registry/lake_index.json': JSON.stringify({
      test_reservoir: { slug: 'test_reservoir', name: 'Test Reservoir', display_name: NAME,
        state: 'SC', feature_type: 'lake', bounds_wsen: [-81.5, 34.0, -81.0, 34.2] },
      other: { slug: 'other', name: 'Other Reservoir', display_name: 'Other Reservoir (Nowhere Co, SC)',
        state: 'SC', feature_type: 'lake', bounds_wsen: [-81.5, 34.0, -81.0, 34.2] } }),
    ...extra,
  }));
  return {
    store,
    async get(k) { return store.has(k) ? { httpMetadata: {}, text: async () => store.get(k) } : null; },
    async put(k, v) { store.set(k, typeof v === 'string' ? v : String(v)); },
  };
}

const calls = [];
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  calls.push(url);
  if (url.includes('waterqualitydata.us/data/Station/')) return new Response(STATIONS, { status: 200 });
  if (url.includes('waterqualitydata.us/data/Result/')) return new Response(CSV, { status: 200 });
  return new Response('no', { status: 503 });          // rainfall: none, so no rain term
};

const { getLakeClarity } = await import('../Worker/worker-data.js');
const env = { R2_TROLLMAP_CHARTPACKS: bucket() };

test('the pull keeps one summary per station, with its own position and readings', async () => {
  const d = await getLakeClarity(NAME, '2026-09-24', env, { lat: 34.1, lon: -81.39, isLaunch: true });
  const st = d.measured.stations;
  // Stations come from the READINGS; the Station endpoint only places them. ST-Z has a position
  // and no Secchi reading here, so it is not a station of this water's clarity.
  assert.deepEqual(st.map((s) => s.id).sort(), ['ST-A', 'ST-B', 'ST-C']);
  const a = st.find((s) => s.id === 'ST-A');
  const b = st.find((s) => s.id === 'ST-B');
  const c = st.find((s) => s.id === 'ST-C');
  assert.equal(a.avgSecchiDepthFt, 2);
  assert.equal(b.avgSecchiDepthFt, 9.8);
  assert.equal(a.sampleCount, 3);
  assert.deepEqual([a.lat, a.lon], [34.1, -81.4]);
  assert.equal(a.name, 'UPPER ARM');
  assert.equal(c.lat, undefined, 'an unlisted station gets no invented position');
  // The lake-wide figure is unchanged by any of this: all seven readings.
  assert.equal(d.measured.sampleCount, 7);
});

test('the Station lookup failing leaves the lake-wide answer, not an error', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/data/Station/')) { calls.push(url); return new Response('down', { status: 503 }); }
    return saved(input);
  };
  try {
    const d = await getLakeClarity('Other Reservoir (Nowhere Co, SC)', '2026-09-24',
      { R2_TROLLMAP_CHARTPACKS: bucket() },
      { lat: 34.1, lon: -81.39, isLaunch: true });
    assert.equal(d.atLaunch, null);
    assert.equal(d.measured.sampleCount, 7);
  } finally {
    globalThis.fetch = saved;
  }
});

test('at a launch, the baseline is the nearest station, named with its distance', async () => {
  const d = await getLakeClarity(NAME, '2026-09-24', env, { lat: 34.1, lon: -81.39, isLaunch: true });
  assert.ok(d.atLaunch, 'atLaunch is present');
  assert.equal(d.atLaunch.station.id, 'ST-A');
  assert.ok(d.atLaunch.station.km > 0.5 && d.atLaunch.station.km < 1.5, `km ${d.atLaunch.station.km}`);
  assert.match(d.atLaunch.why, /UPPER ARM, 0\.9 km away: 3 Secchi readings 2021.2023 averaging 2 ft/);
  assert.match(d.atLaunch.why, /the whole lake averages/);
  // 2 ft is dirtier water than the lake's ~5 ft average, and the answer says so.
  assert.ok(d.atLaunch.normalScore > d.normally.score,
    `station ${d.atLaunch.normalScore} vs lake ${d.normally.score}`);
});

test('the other end of the lake reads the other station', async () => {
  const d = await getLakeClarity(NAME, '2026-09-24', env, { lat: 34.1, lon: -81.11, isLaunch: true });
  assert.equal(d.atLaunch.station.id, 'ST-B');
  assert.ok(d.atLaunch.normalScore < d.normally.score);
});

test('a point that is not a launch gets no atLaunch, and the zones do not move', async () => {
  const launch = await getLakeClarity(NAME, '2026-09-24', env, { lat: 34.1, lon: -81.39, isLaunch: true });
  const centroid = await getLakeClarity(NAME, '2026-09-24', env, { lat: 34.1, lon: -81.39 });
  assert.equal(centroid.atLaunch, null);
  assert.deepEqual(centroid.zones.map((z) => z.score), launch.zones.map((z) => z.score));
  assert.equal(centroid.overall.clarity, launch.overall.clarity);
});

test('WQP is asked once per water; after that the per-station summary comes from the cache', async () => {
  // Two waters were asked about above (the second in the failing-Station test), each once: one
  // Result pull and one Station lookup apiece, and every later request for the first came from
  // the cache.
  assert.equal(calls.filter((u) => u.includes('/data/Station/')).length, 2);
  assert.equal(calls.filter((u) => u.includes('/data/Result/')).length, 2);
});

test('a cache written before stations were kept is refetched, not trusted for thirty days', async () => {
  calls.length = 0;
  const key = [...env.R2_TROLLMAP_CHARTPACKS.store.keys()].find((k) => k.startsWith('clarity-cache/'));
  const old = JSON.parse(env.R2_TROLLMAP_CHARTPACKS.store.get(key));
  delete old.stations;
  const env2 = { R2_TROLLMAP_CHARTPACKS: bucket({ [key]: JSON.stringify(old) }) };
  const d = await getLakeClarity(NAME, '2026-09-24', env2, { lat: 34.1, lon: -81.39, isLaunch: true });
  assert.equal(calls.filter((u) => u.includes('/data/Result/')).length, 1);
  assert.equal(d.atLaunch.station.id, 'ST-A');
});

test('the plan takes the station over a zone and over the lake, and says which', async () => {
  const { clarityForPlan, versusNormalAt } = await import('../js/utils/clarity-at-ramp.js');
  const d = await getLakeClarity(NAME, '2026-09-24', env, { lat: 34.1, lon: -81.39, isLaunch: true });
  const got = clarityForPlan(d, 'Some Ramp');
  assert.equal(got.source, 'station');
  assert.equal(got.select, d.atLaunch.select);
  assert.equal(got.station.id, 'ST-A');
  assert.equal(versusNormalAt(d, 'Some Ramp').scope, 'station');
  // No atLaunch: exactly the old behaviour.
  const c = await getLakeClarity(NAME, '2026-09-24', env, { lat: 34.1, lon: -81.39 });
  assert.equal(clarityForPlan(c, 'Some Ramp').source, 'lake');
});

test('the planners send the launch, marked as the launch', () => {
  const pre = readFileSync(new URL('../js/modules/plan-preflight.js', import.meta.url), 'utf8');
  assert.match(pre, /\(isLaunch \? '&at=launch' : ''\)/);
  for (const f of ['../js/modules/smart-plan-v2-wiring.js', '../js/modules/plan-water-ui.js']) {
    const s = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(s, /fetchClarityAtRamp\(inp\.lakeName, inp\.dateStr,\s*\{[^}]*point: ramp \? \{ lat: ramp\[1\], lon: ramp\[0\] \}/,
      `${f} passes the launch`);
  }
  const w = readFileSync(new URL('../Worker/trollmap-worker.js', import.meta.url), 'utf8');
  assert.match(w, /searchParams\.get\("at"\) === "launch"\) clPoint\.isLaunch = true/);
});

test('a missing lat/lon is not the point 0,0', async () => {
  const { handleConditions, handleHazards } = await import('../Worker/conditions.js');
  const u1 = new URL('https://w.example/conditions/lake_murray');
  const r1 = await handleConditions(new Request(u1), {}, u1);
  assert.equal(r1.status, 400);
  const u2 = new URL('https://w.example/hazards');
  const r2 = await handleHazards(new Request(u2), {}, u2);
  assert.equal(r2.status, 400);
  const w = readFileSync(new URL('../Worker/trollmap-worker.js', import.meta.url), 'utf8');
  assert.match(w, /const clLat = clNum\("lat"\);/);
});
