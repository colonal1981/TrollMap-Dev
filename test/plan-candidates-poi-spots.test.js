// pois.geojson -> spot features. The layer that carries 17% of Wateree's near[] marks and that
// no planner fetched until 2026-08-13.
//
// THE TABLE IS NO LONGER A COPY OF ANYTHING, and that is the whole change of 2026-09-23. It used
// to be a copy of build_trolling_runs.py's POI_KINDS, keyed on the POI's display `name` then its
// `class`, and these tests asserted the two had not drifted. They had never agreed with the third
// copy: fit_trolling_runs.py -- the fitter that actually built every pack in R2 -- keyed on
// `poi_type`, which is the field EVERY_POI_TYPE_ON_THE_CARD_2026-08-27 says to read.
//
// Between them, measured across the 343 app waters: 14,553 charted points in classes Ryan sorted
// as TARGETS became marks nowhere (creek_bed, road_bed, submerged_bridge, river_bed, rock), and
// 2,267 more that DID become marks could not be resolved to a position here because obstruction
// and pile carry no name and no class at all.
//
// The vocabulary now lives in this app, once, keyed on `poi_type`, and the POIs join per run
// through kindHits() as docks and the state attractor feed already do. Both producers' POI joins
// are deleted, so no pack has to be rebuilt to correct this table -- Ryan, 2026-09-23: "i am
// tired of rebuilding." The first test below is what holds that: it reads the two Python files
// and goes red the day either grows a POI join again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { poiSpotFeatures, POI_TYPE_KINDS, POI_JOINED_KINDS, DEFAULT_WEIGHTS, structureIndex,
         resolveStructure } from '../js/modules/plan-candidates.js';

const poi = (props, lon = -80.70, lat = 34.40) => ({
  type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] },
});
const fc = (...features) => ({ type: 'FeatureCollection', features });

test('neither producer joins POIs any more, so there is no second table to drift from', () => {
  // A GREP, DELIBERATELY. plan-pieces.js:212 uses the same arrangement for the relief radius and
  // says why: where the app states something ABOUT the pipeline, the test reads the pipeline.
  for (const f of ['Scripts/build_trolling_runs.py', 'Scripts/fit_trolling_runs.py']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    // The join was `pois.geojson` opened inside the annotation loader. Its absence is the contract.
    const loader = src.slice(src.indexOf('def load_'));
    assert.equal(/os\.path\.join\(pack, 'pois\.geojson'\)/.test(loader), false,
      `${f} reads pois.geojson into a near[] join again — the app owns that vocabulary now`);
    assert.equal(/^POI_(TYPE_)?KINDS\s*=\s*\{/m.test(src), false,
      `${f} has grown a POI vocabulary table again`);
  }
});

test('the vocabulary is keyed on poi_type and covers every type Ryan called a target', () => {
  // His classification, EVERY_POI_TYPE_ON_THE_CARD_2026-08-27. TARGET: submerged_bridge, pile,
  // creek_bed, road_bed, flooded_timber. Plus river_bed and rock, which that document never
  // classified and he called targets on 2026-09-23. obstruction is the measured one.
  for (const t of ['submerged_bridge', 'pile', 'creek_bed', 'road_bed', 'flooded_timber',
                   'river_bed', 'rock', 'obstruction']) {
    assert.ok(POI_TYPE_KINDS[t], `${t} is a charted target and must map to a kind`);
  }
  // And every kind it produces must be scorable, or the mark reaches the ranker worth nothing.
  for (const kind of POI_JOINED_KINDS) {
    if (kind === 'hazard') continue;          // deliberately 0 — things to steer around
    assert.ok((DEFAULT_WEIGHTS[kind] ?? 0) > 0, `${kind} has no weight in DEFAULT_WEIGHTS`);
  }
});

test('every charted poi_type maps to the kind the ranker scores', () => {
  const out = poiSpotFeatures(fc(
    poi({ poi_type: 'flooded_timber', name: 'Flooded Timber' }),
    poi({ poi_type: 'shallow_area', name: 'Shallow Area' }),
    poi({ poi_type: 'fish_attractor_buoy', name: 'Fish Attractor Buoy' }),
    poi({ poi_type: 'submerged_bridge', name: 'Subm Bridge' }),
    poi({ poi_type: 'creek_bed', name: 'Creek Bed' }),
    poi({ poi_type: 'road_bed', name: 'Road Bed' }),
    poi({ poi_type: 'river_bed', name: 'River Bed' }),
    poi({ poi_type: 'rock', name: 'Rock' }),
    poi({ poi_type: 'hazard_area' })));
  assert.deepEqual(out.map((f) => f.properties.kind),
    ['timber', 'shallow', 'attractor', 'bridge', 'creek_bed', 'road_bed', 'river_bed', 'rock',
     'hazard']);
});

test('the two types that carry no name and no class at all still resolve', () => {
  // This is the defect in one line. 3,363 submerged bridges are named 'Subm Bridge', which is not
  // the 'Bridge' key the old table held; 1,873 obstructions and 394 piles carry `name: null,
  // class: null` and could not be looked up by either.
  const out = poiSpotFeatures(fc(poi({ poi_type: 'obstruction' }), poi({ poi_type: 'pile' })));
  assert.deepEqual(out.map((f) => f.properties.kind), ['obstruction', 'pile']);
});

test('`class` is not read, because it is not a category', () => {
  // 2,278 distinct strings of raw Garmin text: typos (`Fish Atrractor Buoy`, `No Wake Bouy`), buoy
  // SHAPES rather than meanings, and in 205 cases an entire source disclaimer.
  const out = poiSpotFeatures(fc(poi({ class: 'Fish Attractor Buoy, Spar/Spindle Buoy' })));
  assert.deepEqual(out, []);
});

test('a POI that is not cover and not a snag is not a spot', () => {
  // place_name, boat_ramp, parking and the rest are real POIs and are not structure. Regulatory
  // zones -- restricted_area, dam, caution_buoy -- are also out: they reach the model through
  // chartedHazards(), and marking a swimming area would say it is a thing to fish past.
  const out = poiSpotFeatures(fc(
    poi({ name: 'Lake Wateree', poi_type: 'place_name' }),
    poi({ poi_type: 'boat_ramp' }), poi({ poi_type: 'parking' }),
    poi({ poi_type: 'restricted_area' }), poi({ poi_type: 'dam' }),
    poi({ poi_type: 'caution_buoy' })));
  assert.deepEqual(out, []);
});

test('a non-point POI is skipped rather than centroided into the lake', () => {
  const out = poiSpotFeatures({ features: [
    { type: 'Feature', properties: { poi_type: 'flooded_timber', name: 'Flooded Timber' },
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
  const idx = structureIndex(poiSpotFeatures(fc(poi({ poi_type: 'flooded_timber', name: 'Flooded Timber' }, -80.70, 34.40))));
  assert.equal(idx.n, 1);
  const hit = resolveStructure([-80.7001, 34.4001], 'timber', 100, idx);
  assert.ok(hit, 'timber should resolve');
  // NO INVENTED SOUNDING. A Garmin POI carries a label and a position, never a depth.
  assert.equal(hit.depthFt, null);
  assert.equal(hit.what, 'Flooded Timber');   // the charted label, not the slug
});

test('the charted label survives into the description', () => {
  const idx = structureIndex(poiSpotFeatures(fc(poi({ poi_type: 'fish_attractor_buoy', name: 'Fish Attractor Buoy' }))));
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
  const chartedBuoy = poiSpotFeatures(fc(poi({ poi_type: 'fish_attractor_buoy', name: 'Fish Attractor Buoy' }, -80.70, 34.40)));
  // ~11 m apart — the same pile, surveyed twice
  const out = attractorSpotFeatures([dnr(34.4001, -80.70)], chartedBuoy);
  assert.deepEqual(out, []);
});

test('a state row well clear of any charted buoy survives', () => {
  const chartedBuoy = poiSpotFeatures(fc(poi({ poi_type: 'fish_attractor_buoy', name: 'Fish Attractor Buoy' }, -80.70, 34.40)));
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

// ── cast spots that are not on a lane, 2026-08-13 ───────────────────────────────────────
//
// Ryan: "the thought behind casting spots is that i could set up a whole day just moving between
// casting spots ignoring the trolling lanes completely." Everything else in the spot list is
// found by walking a lane's near[], which quietly makes "worth stopping on" mean "worth stopping
// on while trolling past". A published brushpile must not need a lane's permission to be listed.
import { castSpots, priceSpots } from '../js/modules/plan-water.js';

const lane = (coords, near = []) => ({
  type: 'Feature',
  properties: { length_m: 1000, near },
  geometry: { type: 'LineString', coordinates: coords },
});

test('a state attractor is listed with no lanes at all', () => {
  const spots = castSpots([], { extraSpots: [
    { type: 'dnr_attractor', at: [-80.70, 34.40], what: 'Colonels Creek pile' },
  ] });
  assert.equal(spots.length, 1);
  assert.equal(spots[0].type, 'dnr_attractor');
  assert.equal(spots[0].what, 'Colonels Creek pile');
  assert.deepEqual(spots[0].at, [-80.70, 34.40]);
  assert.equal(spots[0].depthFt, null);   // a survey point is not a sounding
});

test('a spot with a type the list cannot name is refused, not printed as undefined', () => {
  const spots = castSpots([], { extraSpots: [
    { type: 'not_a_kind', at: [-80.70, 34.40] },
    { type: 'dnr_attractor', at: [-80.71, 34.41] },
    { type: 'dnr_attractor' },                      // no position
  ] });
  assert.equal(spots.length, 1);
});

test('lane-found spots and listed spots coexist', () => {
  const spots = castSpots(
    [lane([[-80.72, 34.40], [-80.70, 34.40]], [{ t: 'timber', s: 500, d: 20 }])],
    { extraSpots: [{ type: 'dnr_attractor', at: [-80.60, 34.50] }] });
  const kinds = spots.map((s) => s.type).sort();
  assert.deepEqual(kinds, ['dnr_attractor', 'timber']);
});

test('two published points on the same pile are one spot', () => {
  const spots = castSpots([], { mergeM: 60, extraSpots: [
    { type: 'dnr_attractor', at: [-80.70000, 34.40000] },
    { type: 'dnr_attractor', at: [-80.70020, 34.40000] },   // ~18 m
  ] });
  assert.equal(spots.length, 1);
});

test('a listed spot off every picked route is priced, not hidden', () => {
  // This is what makes a casting-only day possible: nothing ticked, so every spot prices from
  // the ramp and the list is still the whole list.
  const spots = castSpots([], { extraSpots: [{ type: 'dnr_attractor', at: [-80.70, 34.40] }] });
  const priced = priceSpots(spots, [], { ramp: [-80.72, 34.40] });
  assert.equal(priced.length, 1);
  assert.equal(priced[0].free, false);
  assert.ok(priced[0].detourM > 0, 'a spot with no picked water still has a distance');
});

// ── one hump is one waypoint, 2026-08-14 ─────────────────────────────────────────────────
//
// A structure sits in the near[] of every nested contour that passes it, so the same hump
// resolved once per mark and each landed a metre or two from the last. An exported Wateree day
// carried 29 waypoints at 17 real positions — "hump 10ft" fifteen times across four spots inside
// six metres — and that is what loads onto the Garmin.
import { planWaypoints } from '../js/modules/plan-tracks.js';

const legWith = (marks) => ({
  id: 'L1', type: 'troll', startM: 0, lengthM: 1000, stops: [], marks,
  coordinates: [[-80.7325, 34.3755], [-80.7320, 34.3760]],
});
const mark = (type, lon, lat, depthFt = 9.8) => ({ id: `${type}_x`, type, at: [lon, lat], atM: 10, depthFt });

test('the same hump resolved fifteen times is one waypoint', () => {
  // the four spots from the real export, all inside six metres
  const marks = [
    mark('hump', -80.7325541692401, 34.37556873468945),
    mark('hump', -80.7325541692401, 34.37556873468945),
    mark('hump', -80.73266115563897, 34.37558578173703),
    mark('hump', -80.7327681531759, 34.375602781345705),
    mark('hump', -80.73245789626982, 34.375553329313895),
  ];
  const wp = planWaypoints({ legs: [legWith(marks)] }, null, null, { marks: true });
  const humps = wp.filter((w) => w.structureType === 'hump');
  assert.equal(humps.length, 1, 'five resolutions of one hump are one waypoint');
});

test('two different kinds at one spot are two real things', () => {
  const wp = planWaypoints({ legs: [legWith([
    mark('hump', -80.7325, 34.3755),
    mark('point', -80.7325, 34.3755, 27.8),
  ])] }, null, null, { marks: true });
  assert.equal(wp.filter((w) => w.chartMark).length, 2);
});

test('two humps far enough apart stay two humps', () => {
  const wp = planWaypoints({ legs: [legWith([
    mark('hump', -80.7325, 34.3755),
    mark('hump', -80.7355, 34.3760),   // ~280 m
  ])] }, null, null, { marks: true });
  assert.equal(wp.filter((w) => w.structureType === 'hump').length, 2);
});

test('marks stay opt-in', () => {
  const wp = planWaypoints({ legs: [legWith([mark('hump', -80.7325, 34.3755)])] }, null, null, {});
  assert.equal(wp.filter((w) => w.chartMark).length, 0);
});

// ── THE APP OWNS THE JOIN NOW, AND THE OLD PACKS STILL CARRY THE OLD MARKS ───────────────
//
// Every pack in R2 was built while fit_trolling_runs.py joined POIs into `near[]` -- measured
// 2026-09-23 on wateree_lake's 2,843 runs: timber 653, hazard 687, shallow 518, obstruction 446,
// pile 317, attractor 110. The app now supplies those marks itself, so without a strip the same
// charted point is scored twice on the same leg. That is exactly what Ryan warned about on
// 2026-09-19 when he explained why docks were left out of the pipeline: "doing it in the pipeline
// would mean they got added twice".
//
// The strip is the CONTRACT, not a migration: `near[]` carries pipeline-sourced marks only. It
// costs nothing on a pack rebuilt tomorrow and saves every pack built before today, which is why
// nothing has to be rebuilt.
import { selectCandidates } from '../js/modules/plan-candidates.js';

const LAUNCH_PT = [-80.7300, 34.3800];
const straightRun = (near) => ({
  type: 'Feature',
  geometry: { type: 'LineString',
              coordinates: Array.from({ length: 41 }, (_, i) => [-80.72 + i * 0.001, 34.38]) },
  properties: { depth_ft: 22, length_m: 3690, routable: true, near },
});
const pileAt = (lon, lat) => poi({ poi_type: 'pile' }, lon, lat);

test('a charted pile the pack already marked is not scored twice', () => {
  // One real pile, beside the line. The pack's `near[]` carries it because the old fitter put it
  // there; the app's index carries the same point off pois.geojson.
  const pileLon = -80.700, pileLat = 34.3801;
  const pipelineMark = [{ s: 1800, t: 'pile', d: 20 }];
  const pois = structureIndex(poiSpotFeatures(fc(pileAt(pileLon, pileLat))));
  const opts = { ramp: LAUNCH_PT, slug: 'w', usableAh: 200, windowMin: 600 };

  const [both] = selectCandidates([straightRun(pipelineMark)], { ...opts, pois });
  const piles = both.passes.filter((h) => h.type === 'pile');
  assert.equal(piles.length, 1, 'one pile on the water is one pass, not two');

  // And the surviving one is the APP's, which is the half that has a position to resolve against.
  const [appOnly] = selectCandidates([straightRun([])], { ...opts, pois });
  assert.equal(appOnly.passes.filter((h) => h.type === 'pile').length, 1);
  assert.equal(both.score, appOnly.score, 'the pack having marked it first changes no score');
});

test('a caller that passes no POIs keeps whatever its pack already said', () => {
  // The old behaviour exactly, so a path that has not been given the layer is not silently
  // stripped of marks it depends on.
  const [c] = selectCandidates([straightRun([{ s: 1800, t: 'pile', d: 20 }])],
                               { ramp: LAUNCH_PT, slug: 'w', usableAh: 200, windowMin: 600 });
  assert.equal(c.passes.filter((h) => h.type === 'pile').length, 1);
});

test('the marks the pipeline still owns are untouched by the strip', () => {
  // hump, ledge, hole, point, cove and creek_mouth come from structure.geojson and
  // water_features.geojson. They are measured, they are not POIs, and they must survive.
  const near = [{ s: 800, t: 'hump', d: 20 }, { s: 1200, t: 'ledge', d: 25 },
                { s: 1600, t: 'hole', d: 30 }, { s: 2000, t: 'point', d: 35 },
                { s: 2400, t: 'pile', d: 20 }];
  const pois = structureIndex(poiSpotFeatures(fc(pileAt(-80.60, 34.60))));   // nowhere near the run
  const [c] = selectCandidates([straightRun(near)],
    { ramp: LAUNCH_PT, slug: 'w', usableAh: 200, windowMin: 600, pois });
  const kinds = c.passes.map((h) => h.type).sort();
  assert.deepEqual(kinds, ['hole', 'hump', 'ledge', 'point'],
    'the pipeline kinds stay and only the POI-sourced pile is stripped');
});

test('a creek bed the pipeline never knew about reaches the ranker', () => {
  // 6,819 charted points on 31 waters, and no producer ever made a mark from one.
  const pois = structureIndex(poiSpotFeatures(fc(
    poi({ poi_type: 'creek_bed', name: 'Creek Bed' }, -80.700, 34.3801))));
  const [c] = selectCandidates([straightRun([])],
    { ramp: LAUNCH_PT, slug: 'w', usableAh: 200, windowMin: 600, pois });
  const hit = c.passes.find((h) => h.type === 'creek_bed');
  assert.ok(hit, 'a submerged creek channel beside the line is a pass');
  assert.equal(hit.weight, 11);
});
