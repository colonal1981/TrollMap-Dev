// Personal use only, not for distribution or resale; not for navigation.
//
// A TURBIDITY-ONLY WATER IS NOT "UNDEFINED FT VISIBILITY".
//
// getSecchiSummary() answers with turbidity alone when a water has no Secchi reading -- 122 of 512
// inland lakes, every TVA reservoir, and the river pieces. The model's score used it; the words did
// not. Live on 2026-09-24, /conditions/broad_river said "typically undefined ft visibility
// (undefined readings, undefined–undefined ft)", and versusNormal -- which reaches the plan prompt
// as clarityVsNormal -- said "undefined measured secchi readings averaging undefined ft".
//
// These run the real pull and the real model against a stubbed bucket and a stubbed WQP.
//
//   node --test test/a-turbidity-only-water-is-not-undefined-feet.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const NAME = 'Turbid Test River (Nowhere Co, SC)';
const HEAD = ['OrganizationFormalName', 'ProjectIdentifier', 'MonitoringLocationIdentifier',
  'ActivityStartDate', 'ActivityDepthHeightMeasure/MeasureValue',
  'ActivityDepthHeightMeasure/MeasureUnitCode', 'CharacteristicName', 'ResultMeasureValue',
  'ResultMeasure/MeasureUnitCode', 'ResultDepthHeightMeasure/MeasureValue',
  'ResultDepthHeightMeasure/MeasureUnitCode'].join(',');
// Turbidity only, two dates; the later one is "its latest reading".
const CSV = [HEAD,
  'SCDES,P1,TB-1,2024-06-01,,,Turbidity,9.1,NTU,,',
  'SCDES,P1,TB-1,2025-07-28,,,Turbidity,14.65,NTU,,',
  'SCDES,P1,TB-1,2025-08-02,,,"Temperature, water",27,deg C,,',
].join('\n');
const STATIONS = [
  'OrganizationIdentifier,MonitoringLocationIdentifier,MonitoringLocationName,MonitoringLocationTypeName,LatitudeMeasure,LongitudeMeasure',
  '21SC60WQ,TB-1,RIVER AT BRIDGE,River/Stream,34.1000,-81.3000',
].join('\n');

const store = new Map([['_registry/lake_index.json', JSON.stringify({
  turbid_test: { slug: 'turbid_test', name: 'Turbid Test River', display_name: NAME, state: 'SC',
    feature_type: 'river', bounds_wsen: [-81.5, 34.0, -81.0, 34.2] },
})]]);
const env = { R2_TROLLMAP_CHARTPACKS: {
  async get(k) { return store.has(k) ? { httpMetadata: {}, text: async () => store.get(k) } : null; },
  async put(k, v) { store.set(k, String(v)); },
} };

globalThis.fetch = async (input) => {
  const url = decodeURIComponent(typeof input === 'string' ? input : input.url);
  if (url.includes('waterqualitydata.us/data/Station/')) return new Response(STATIONS, { status: 200 });
  if (url.includes('waterqualitydata.us/data/Result/')) return new Response(CSV, { status: 200 });
  return new Response('no', { status: 503 });    // no rainfall feed: the "medium" branch
};

const { getLakeClarity, measuredEvidence } = await import('../Worker/worker-data.js');

test('a Secchi water reads exactly as it always has', () => {
  const m = { avgSecchiDepthFt: 4.2, minSecchiDepthFt: 1.7, maxSecchiDepthFt: 9, sampleCount: 39 };
  assert.equal(measuredEvidence(m, true), 'typically 4.2 ft visibility (39 readings, 1.7–9 ft)');
  assert.equal(measuredEvidence(m), '39 measured secchi readings averaging 4.2 ft (1.7–9 ft)');
});

test('turbidity alone is named as turbidity, dated when the date is known', () => {
  assert.equal(measuredEvidence({ recentTurbidityNTU: 14.65, recentTurbidityLastObserved: '2025-07-28' }, true),
    '14.65 NTU turbidity at its latest reading on 2025-07-28, no Secchi readings');
  assert.equal(measuredEvidence({ recentTurbidityNTU: 14.65 }, true),
    '14.65 NTU turbidity at its latest reading, no Secchi readings',
    'a summary cached before the date was kept still reads');
  assert.equal(measuredEvidence({}), null);
  assert.equal(measuredEvidence(null), null);
});

test('the clarity payload for a turbidity-only water has no undefined in it', async () => {
  const c = await getLakeClarity(NAME, '2026-09-24', env, { lat: 34.1, lon: -81.3 }, { slug: 'turbid_test' });
  assert.ok(c.measured, 'turbidity is a measured baseline');
  assert.equal(c.measured.avgSecchiDepthFt, undefined);
  const words = [c.summary, c.normally.basis, c.versusNormal.sentence, c.confidence].join(' | ');
  assert.doesNotMatch(words, /undefined|NaN/);
  assert.match(c.summary, /14\.65 NTU turbidity at its latest reading on 2025-07-28/);
  assert.match(c.normally.basis, /turbidity of 14\.65 NTU/);
  assert.match(c.confidence, /measured turbidity baseline/);
  assert.equal(c.measured.recentTurbidityLastObserved, '2025-07-28', 'its own date, not the temperature\'s');
});
