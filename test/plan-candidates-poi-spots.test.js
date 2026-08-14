// pois.geojson -> spot features. The layer that carries 17% of Wateree's near[] marks and that
// no planner fetched until 2026-08-13.
//
// The table under test is a COPY of build_trolling_runs.py's POI_KINDS. Every assertion here is
// really an assertion that the two have not drifted — resolving a mark against a different table
// than the one that made it is how a hit snaps onto something the pipeline never saw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poiSpotFeatures, POI_KINDS, structureIndex, resolveStructure } from '../js/modules/plan-candidates.js';

const poi = (props, lon = -80.70, lat = 34.40) => ({
  type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] },
});
const fc = (...features) => ({ type: 'FeatureCollection', features });

test('the table matches build_trolling_runs.py POI_KINDS exactly', () => {
  // If this fails, one of the two tables moved. Fix BOTH, do not loosen the test.
  assert.deepEqual(POI_KINDS, {
    'Flooded Timber': 'timber',
    'Shallow Area': 'shallow',
    'Hazard, Spar/Spindle Buoy': 'hazard',
    'Hazard Area': 'hazard',
    'Pile': 'pile',
    'Piles': 'pile',
    'Fish Attractor Buoy, Spar/Spindle Buoy': 'attractor',
    'Fish Attractor Buoy': 'attractor',
    'Bridge': 'bridge',
  });
});

test('every charted name maps to the kind near[] uses', () => {
  const out = poiSpotFeatures(fc(
    poi({ name: 'Flooded Timber' }), poi({ name: 'Shallow Area' }),
    poi({ name: 'Fish Attractor Buoy' }), poi({ name: 'Piles' }),
    poi({ name: 'Bridge' }), poi({ name: 'Hazard Area' })));
  assert.deepEqual(out.map(f => f.properties.kind),
    ['timber', 'shallow', 'attractor', 'pile', 'bridge', 'hazard']);
});

test('class is read when name is absent, same as the producer', () => {
  const out = poiSpotFeatures(fc(poi({ class: 'Fish Attractor Buoy, Spar/Spindle Buoy' })));
  assert.equal(out.length, 1);
  assert.equal(out[0].properties.kind, 'attractor');
});

test("the producer's poi_type fallback for timber is carried over", () => {
  const out = poiSpotFeatures(fc(poi({ poi_type: 'flooded_timber' })));
  assert.equal(out[0].properties.kind, 'timber');
});

test('a POI the pipeline never made a mark from is not a spot', () => {
  // place_name, boat_ramp, parking, obstruction and the rest are real POIs and are NOT in
  // POI_KINDS, so no near[] mark exists for them. Emitting them would add resolution candidates
  // for marks that do not exist.
  const out = poiSpotFeatures(fc(
    poi({ name: 'Lake Wateree', poi_type: 'place_name' }),
    poi({ poi_type: 'boat_ramp' }), poi({ poi_type: 'obstruction' }),
    poi({ poi_type: 'parking' })));
  assert.deepEqual(out, []);
});

test('a non-point POI is skipped rather than centroided into the lake', () => {
  const out = poiSpotFeatures({ features: [
    { type: 'Feature', properties: { name: 'Flooded Timber' },
      geometry: { type: 'LineString', coordinates: [[-80.7, 34.4], [-80.6, 34.4]] } },
  ] });
  assert.deepEqual(out, []);
});

test('no data, no crash', () => {
  for (const v of [null, undefined, {}, { features: [] }]) {
    assert.deepEqual(poiSpotFeatures(v), []);
  }
});

test('a timber mark now resolves to a real position, and to a null depth', () => {
  const idx = structureIndex(poiSpotFeatures(fc(poi({ name: 'Flooded Timber' }, -80.70, 34.40))));
  assert.equal(idx.n, 1);
  const hit = resolveStructure([-80.7001, 34.4001], 'timber', 100, idx);
  assert.ok(hit, 'timber should resolve');
  // NO INVENTED SOUNDING. A Garmin POI carries a label and a position, never a depth.
  assert.equal(hit.depthFt, null);
  assert.equal(hit.what, 'Flooded Timber');   // the charted label, not the slug
});

test('the charted label survives into the description', () => {
  const idx = structureIndex(poiSpotFeatures(fc(poi({ name: 'Fish Attractor Buoy' }))));
  const hit = resolveStructure([-80.70, 34.40], 'attractor', 50, idx);
  assert.equal(hit.what, 'Fish Attractor Buoy');
});

// ── the state attractor feed, 2026-08-13 ────────────────────────────────────────────────
//
// Garmin charts a Fish Attractor Buoy where it sees one; the state publishes where it dropped the
// pile. Same object, two describers, both worth stopping on. Only Garmin's is in near[], because
// only Garmin's was in the pack when the pipeline ran — so the state rows join per-run in the app
// exactly as docks do.
import { attractorSpotFeatures, kindHits } from '../js/modules/plan-candidates.js';
import { cumulative } from '../js/modules/plan-candidates.js';

const dnr = (lat, lon, name = 'SCDNR pile') => ({ lat, lon, name, source: 'SCDNR' });

test('state rows become attractor features with their provenance intact', () => {
  const out = attractorSpotFeatures([dnr(34.40, -80.70), dnr(34.41, -80.71)]);
  assert.equal(out.length, 2);
  assert.equal(out[0].properties.kind, 'attractor');
  assert.equal(out[0].properties.source, 'SCDNR');
  assert.deepEqual(out[0].geometry.coordinates, [-80.70, 34.40]);
});

test('a state row on top of a charted buoy is not a second attractor', () => {
  const chartedBuoy = poiSpotFeatures(fc(poi({ name: 'Fish Attractor Buoy' }, -80.70, 34.40)));
  // ~11 m apart — the same pile, surveyed twice
  const out = attractorSpotFeatures([dnr(34.4001, -80.70)], chartedBuoy);
  assert.deepEqual(out, []);
});

test('a state row well clear of any charted buoy survives', () => {
  const chartedBuoy = poiSpotFeatures(fc(poi({ name: 'Fish Attractor Buoy' }, -80.70, 34.40)));
  const out = attractorSpotFeatures([dnr(34.41, -80.71)], chartedBuoy);
  assert.equal(out.length, 1);
});

test('a junk row is not an attractor at null island', () => {
  assert.deepEqual(attractorSpotFeatures([{ lat: 'n/a', lon: null, name: 'bad' }]), []);
  assert.deepEqual(attractorSpotFeatures(null), []);
});

test('state attractors join a run as near-shaped hits, and only when they are near it', () => {
  // A lane running east along 34.40. One pile sits on it, one sits 2 km north.
  const coords = [[-80.72, 34.40], [-80.70, 34.40], [-80.68, 34.40]];
  const idx = structureIndex(attractorSpotFeatures([dnr(34.4002, -80.70), dnr(34.42, -80.70)]));
  const hits = kindHits(coords, cumulative(coords), idx, 100, 'attractor');
  assert.equal(hits.length, 1, 'only the pile beside the lane joins');
  assert.equal(hits[0].t, 'attractor');       // the type near[] and DEFAULT_WEIGHTS already use
  assert.ok(hits[0].d <= 100);
  assert.ok(Number.isFinite(hits[0].s));      // metres along the run, same shape as a pipeline mark
});

test('no index, no hits, no crash', () => {
  const coords = [[-80.72, 34.40], [-80.70, 34.40]];
  assert.deepEqual(kindHits(coords, cumulative(coords), null, 100, 'attractor'), []);
});
