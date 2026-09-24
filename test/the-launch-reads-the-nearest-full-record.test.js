// Personal use only, not for distribution or resale; not for navigation.
//
// THE LAUNCH READS THE NEAREST STATION WITH A FULL RECORD.
//
// Ryan, 2026-09-24, asked whether a launch should read the nearest Secchi station even when it has
// only a few readings, or a farther one with a long record: "I dont know the answer to your
// question... which is more accurate?". Measured leave-one-out over the stations on 53 waters: where the nearest
// station's record is shorter than its water's median, the nearest long-record station (a median
// 1.1 km farther) misses the launch's own long-run average by 0.55 ft where the nearest misses by
// 1.00 ft, and lands in the right clarity band 84.9% of the time against 79.1%. See
// nearestClarityStation in Worker/worker-data.js.
//
// These run the real pull and the real model against a stubbed bucket and a stubbed WQP.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const NAME = 'Record Test Reservoir (Nowhere Co, SC)';
const HEAD = ['OrganizationFormalName', 'ProjectIdentifier', 'MonitoringLocationIdentifier',
  'ActivityStartDate', 'ActivityDepthHeightMeasure/MeasureValue',
  'ActivityDepthHeightMeasure/MeasureUnitCode', 'CharacteristicName', 'ResultMeasureValue',
  'ResultMeasure/MeasureUnitCode', 'ResultDepthHeightMeasure/MeasureValue',
  'ResultDepthHeightMeasure/MeasureUnitCode'].join(',');
const rows = (id, n, ft) => Array.from({ length: n }, (_, i) =>
  `SCDES,P1,${id},${2010 + i}-06-01,,,"Depth, Secchi disk depth",${ft},ft,,`);

// SHORT: two readings, one summer survey, 0.5 km from the launch.
// LONG: ten readings, 3 km away. OTHER: ten readings, 20 km away.
const CSV = [HEAD, ...rows('ST-SHORT', 2, 2), ...rows('ST-LONG', 10, 6), ...rows('ST-OTHER', 10, 9)].join('\n');
const STATIONS = [
  'OrganizationIdentifier,MonitoringLocationIdentifier,MonitoringLocationName,MonitoringLocationTypeName,LatitudeMeasure,LongitudeMeasure',
  '21SC60WQ,ST-SHORT,ONE SUMMER SURVEY,Lake,34.1000,-81.3945',
  '21SC60WQ,ST-LONG,LONG RECORD COVE,Lake,34.1000,-81.3673',
  '21SC60WQ,ST-OTHER,DAM FOREBAY,Lake,34.1000,-81.1800',
].join('\n');

// Every water in one index: the Worker caches lake_index per isolate for an hour.
function bucket() {
  const store = new Map([['_registry/lake_index.json', JSON.stringify({
    record_test: { slug: 'record_test', name: 'Record Test Reservoir', display_name: NAME, state: 'SC',
      feature_type: 'lake', bounds_wsen: [-81.5, 34.0, -81.0, 34.2] },
    even_test: { slug: 'even_test', name: 'Even Test Reservoir', display_name: 'Even Test Reservoir (Nowhere Co, SC)',
      state: 'SC', feature_type: 'lake', bounds_wsen: [-82.5, 35.0, -82.0, 35.2] },
  })]]);
  return {
    store,
    async get(k) { return store.has(k) ? { httpMetadata: {}, text: async () => store.get(k) } : null; },
    async put(k, v) { store.set(k, String(v)); },
  };
}

// The second water: every station has the same short record, so there is nothing longer to prefer.
const EVEN_CSV = [HEAD, ...rows('EV-A', 2, 3), ...rows('EV-B', 2, 7), ...rows('EV-C', 2, 8)].join('\n');
const EVEN_STATIONS = [
  'OrganizationIdentifier,MonitoringLocationIdentifier,MonitoringLocationName,MonitoringLocationTypeName,LatitudeMeasure,LongitudeMeasure',
  '21SC60WQ,EV-A,NEAR,Lake,35.1000,-82.4000',
  '21SC60WQ,EV-B,MIDDLE,Lake,35.1000,-82.3000',
  '21SC60WQ,EV-C,FAR,Lake,35.1000,-82.1000',
].join('\n');

globalThis.fetch = async (input) => {
  const url = decodeURIComponent(typeof input === 'string' ? input : input.url);
  const even = url.includes('-82.5');
  if (url.includes('waterqualitydata.us/data/Station/')) return new Response(even ? EVEN_STATIONS : STATIONS, { status: 200 });
  if (url.includes('waterqualitydata.us/data/Result/')) return new Response(even ? EVEN_CSV : CSV, { status: 200 });
  return new Response('no', { status: 503 });
};

const { getLakeClarity } = await import('../Worker/worker-data.js');
const env = { R2_TROLLMAP_CHARTPACKS: bucket() };
const LAUNCH = { lat: 34.1, lon: -81.4, isLaunch: true };

test('a nearer station with a short record is passed over for the nearest full record', async () => {
  const d = await getLakeClarity(NAME, '2026-09-24', env, LAUNCH);
  assert.equal(d.atLaunch.station.id, 'ST-LONG');
  assert.equal(d.atLaunch.station.sampleCount, 10);
  // Not the biggest-record station on the water, which is as long but 20 km off.
  assert.notEqual(d.atLaunch.station.id, 'ST-OTHER');
});

test('the passed-over station is named, with its distance and its record', async () => {
  const d = await getLakeClarity(NAME, '2026-09-24', env, LAUNCH);
  assert.equal(d.atLaunch.passedOver.id, 'ST-SHORT');
  assert.equal(d.atLaunch.passedOver.sampleCount, 2);
  assert.ok(d.atLaunch.passedOver.km < d.atLaunch.station.km);
  assert.match(d.atLaunch.why, /nearest station with a full record is LONG RECORD COVE/);
  assert.match(d.atLaunch.why, /ONE SUMMER SURVEY, 0\.5 km away, was passed over -- 2 readings, fewer than this water's median station's 10/);
});

test('when every station has the same short record, the nearest is read and nothing is passed over', async () => {
  const d = await getLakeClarity('Even Test Reservoir (Nowhere Co, SC)', '2026-09-24', env,
    { lat: 35.1, lon: -82.39, isLaunch: true });
  assert.equal(d.atLaunch.station.id, 'EV-A');
  assert.equal(d.atLaunch.passedOver, null);
  assert.match(d.atLaunch.why, /^the nearest measured water to the launch is NEAR/);
});
