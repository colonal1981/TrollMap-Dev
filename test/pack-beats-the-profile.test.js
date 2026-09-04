// A derivation stored in a profile is a photograph of a chart that has since been replaced.
//
// Ryan, 2026-09-04: "contours can change each time Garmin updates them so anything derived from
// the packs should be ran when a plan is ran... the research refactor docs should cover this".
// They do -- THE_PROFILE_BECAME_A_CACHE_AND_NOBODY_MOVED_THE_READS_2026-09-01.md, item 1. This
// pins the half of that move that is in place: researchIntel() takes the pack-derived block and
// prefers it, field by field, and reads the profile exactly as before when no caller passes one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { researchIntel, registryIdentity } from '../js/modules/plan-inputs.js';

const PROFILE = {
  identity: { maxDepthFt: 83, averageDepthFt: 19, bodyType: 'lake' },
  biology: { predatorSpecies: ['Largemouth Bass'] },
  habitat: { structuralElements: { creekMouths: ['Dutchmans', 'Cedar'], points: 12 } },
  limnology: {},
};
const SPECIES = 'Largemouth Bass';
// researchIntel() prefixes every line with '- '.
const line = (out, label) => String(out || '').split('\n').find((l) => l.startsWith(`- ${label}:`)) || '';

test('with no pack, it reads the profile exactly as it always has', () => {
  const out = researchIntel(PROFILE, SPECIES, 'summer');
  assert.match(line(out, 'Max depth'), /83/);
  assert.match(line(out, 'Charted points'), /12/);
});

test('a pack max depth beats the one frozen in the profile', () => {
  // The 83 ft ceiling was a decoder bug for months; every profile written under it says 83.
  const out = researchIntel(PROFILE, SPECIES, 'summer', Date.now(),
    { identity: { maxDepthFt: 110.9 } });
  assert.match(line(out, 'Max depth'), /110\.9/);
  assert.doesNotMatch(line(out, 'Max depth'), /83/);
});

test('a pack that answers one identity field does not delete the others', () => {
  // Field by field, not block by block.
  const out = researchIntel(PROFILE, SPECIES, 'summer', Date.now(),
    { identity: { maxDepthFt: 110.9 } });
  assert.match(line(out, 'Average depth'), /19/);
});

test('pack structure beats stored structure, and stored survives where the pack is silent', () => {
  const out = researchIntel(PROFILE, SPECIES, 'summer', Date.now(),
    { habitat: { structuralElements: { points: 31 } } });
  assert.match(line(out, 'Charted points'), /31/);
  assert.match(line(out, 'Named creek mouths'), /Dutchmans/);
});

test('a pack with no habitat at all does not blank a profile that has one', () => {
  const out = researchIntel(PROFILE, SPECIES, 'summer', Date.now(), { identity: {} });
  assert.match(line(out, 'Charted points'), /12/);
});

test('the species list still comes from the profile, which is not a pack fact', () => {
  const out = researchIntel(PROFILE, SPECIES, 'summer', Date.now(),
    { identity: { maxDepthFt: 110.9 } });
  assert.match(out, /Other predators here/);
});

// ── THE ASSUMPTION PICK WATER'S CALL RESTS ON ────────────────────────────────────────────────
//
// A plan run fetches depth_areas, structure, water_features and pois. It does NOT fetch the
// boundary or the contours, and neither is worth a request: deriveDepthStatistics falls back to a
// three-band bar when there is no boundary ring, and contours are only consulted for packs that
// carry no depth areas at all. If that fallback did not hold, Pick Water would be passing a block
// with no depth in it and quietly losing the field it was wired to supply.
import { packDerivedFacts } from '../js/utils/pack-facts.js';

const band = (min, max, acres) => ({
  type: 'Feature',
  properties: { depth_min_ft: min, depth_max_ft: max },
  // A square whose area is not what matters here -- polygonRingsAcres measures it, and the test
  // asserts on the depths, not the acreage.
  geometry: { type: 'Polygon', coordinates: [[[-80.0, 34.0], [-80.0 + acres, 34.0],
    [-80.0 + acres, 34.0 + acres], [-80.0, 34.0 + acres], [-80.0, 34.0]]] },
});

test('with no boundary and no contours, depth still comes off the depth areas', () => {
  const out = packDerivedFacts({
    lakeName: 'Test Lake, SC',
    structGeo: null, featGeo: null, poiGeo: null, boundaryGeo: null, contourGeo: null,
    depthGeo: { features: [band(0, 10, 0.01), band(10, 30, 0.008), band(30, 60, 0.004)] },
  });
  assert.ok(out, 'a pack with only depth areas must still produce a block');
  assert.equal(out.identity.maxDepthFt, 60);
  assert.ok(out.identity.averageDepthFt > 0,
    'three bands is the no-boundary bar, so the average must land');
});

test('an empty pack produces nothing rather than a block of zeroes', () => {
  // Zero depth is a claim. Absence is not.
  assert.equal(packDerivedFacts({
    lakeName: 'Test Lake, SC', structGeo: null, featGeo: null, depthGeo: null,
    poiGeo: null, boundaryGeo: null, contourGeo: null,
  }), null);
});

// ── THE CALLBACK, WHICH IS THE ONLY WAY BOTH HALVES MEET ─────────────────────────────────────
//
// smart-plan-v2-wiring.js holds the profile, the species and the season; buildSmartPlanV2 holds
// the pack, because it is the thing that downloads it. Neither can build the intel line alone, so
// the wiring passes a closure and the planner calls it with what it fetched. A caller that passes
// a plain `intel` string still works -- every existing test does exactly that, which is why the
// old field had to keep working rather than be replaced.
test('the intelFor closure is what carries the pack into the prompt', () => {
  const seen = [];
  const intelFor = (packFacts) => {
    seen.push(packFacts);
    return researchIntel(PROFILE, SPECIES, 'summer', Date.now(), packFacts);
  };
  const out = intelFor({ habitat: { structuralElements: { points: 31 } } });
  assert.equal(seen.length, 1);
  assert.match(line(out, 'Charted points'), /31/);
});

test('and with no closure the stored profile still answers, unchanged', () => {
  const o = { intel: researchIntel(PROFILE, SPECIES, 'summer') };
  const intel = typeof o.intelFor === 'function' ? o.intelFor({}) : o.intel;
  assert.match(line(intel, 'Charted points'), /12/);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AND THE SPECIES ROSTER ARRIVES THE SAME WAY, BUT UNIONS INSTEAD OF REPLACING
//
// Ryan, 2026-09-04: "now wire up the fish species to the other states for the refactor".
//
// Item 2. `identity` and `habitat` are MEASUREMENTS -- the chart is newer than the profile, so
// the pack's answer wins outright. A species roster is a CLAIM ABOUT PRESENCE, and two agencies
// naming different fish in one water is two facts, not a contradiction. That is the same rule
// registrySpeciesFor() applies between its own four sources, applied one layer up.
//
// So a profile that carries a fish the registry has never heard of keeps it, and a water with no
// profile at all still tells the plan what swims in it.
// ─────────────────────────────────────────────────────────────────────────────────────────────
test('the registry roster unions with the profile rather than replacing it', () => {
  const out = researchIntel(PROFILE, SPECIES, 'summer', Date.now(),
    { biology: { predatorSpecies: ['Striped Bass', 'Blue Catfish'] } });
  const row = line(out, 'Other predators here');
  // Both halves survive. Largemouth is the profile's and is the fish the plan is FOR.
  assert.ok(row.includes('Largemouth Bass'), row);
  assert.ok(row.includes('Striped Bass'), row);
  assert.ok(row.includes('Blue Catfish'), row);
});

test('a fish in both is named once', () => {
  const out = researchIntel(PROFILE, SPECIES, 'summer', Date.now(),
    { biology: { predatorSpecies: ['largemouth bass', 'Striped Bass'] } });
  const row = line(out, 'Other predators here');
  assert.equal(row.toLowerCase().split('largemouth bass').length - 1, 1, row);
});

test('a water with no profile at all still gets a roster', () => {
  // The case item 2 exists for: 242 waters under 1,000 acres are outside research scope and will
  // never have a profile, and the registry knows their fish anyway.
  const out = researchIntel({}, SPECIES, 'summer', Date.now(),
    { biology: { predatorSpecies: ['Redbreast Sunfish', 'Chain Pickerel'] } });
  assert.ok(line(out, 'Other predators here').includes('Chain Pickerel'), out);
});

test('and no registry answer leaves the profile exactly as it read before', () => {
  const withNothing = researchIntel(PROFILE, SPECIES, 'summer', Date.now(), null);
  const withEmpty = researchIntel(PROFILE, SPECIES, 'summer', Date.now(), { biology: {} });
  assert.equal(line(withEmpty, 'Other predators here'), line(withNothing, 'Other predators here'));
  assert.ok(line(withNothing, 'Other predators here').includes('Largemouth Bass'));
});

test('stockings union the same way, on the species name inside the object', () => {
  const profile = { ...PROFILE, biology: { ...PROFILE.biology,
    knownStockings: [{ species: 'Striped Bass', source: 'the profile' }] } };
  const out = researchIntel(profile, SPECIES, 'summer', Date.now(),
    { biology: { knownStockings: [{ species: 'Striped Bass', source: 'NC WRC' },
                                  { species: 'Walleye', source: 'NC WRC' }] } });
  const row = line(out, 'Stockings');
  assert.ok(row.includes('Walleye'), row);
  assert.equal(row.split('Striped Bass').length - 1, 1, row);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `Lake type` IS A PROPERTY READ, AND IT WAS COMING OUT OF A STORED PROFILE
//
// It is `feature_type` on the registry row -- lake, river or coastal -- which the browser has
// held since access-index.js loaded. researchIntel() was printing it from the profile instead,
// so 14 of the 80 mirrored profiles printed no lake type at all and the waters with no profile
// printed none ever. The cheapest field on item 2's list.
//
// The precedence is the same three-way rule as every other field: the pack measured it > the
// pipeline stamped it > the profile remembered it. Depth is in this helper for the day the
// pipeline stamps it; until then registryIdentity() returns only the type, and absent is not a
// claim.
// ─────────────────────────────────────────────────────────────────────────────────────────────
test('the registry row answers Lake type without any fetch', () => {
  const out = researchIntel({}, SPECIES, 'summer', Date.now(),
    { identity: registryIdentity({ feature_type: 'river' }) });
  assert.ok(line(out, 'Lake type').includes('river'), out);
});

test('a pack measurement still beats the registry stamp', () => {
  // Pick Water holds the depth areas, so where it measured a depth that number is newer than
  // anything the pipeline wrote down. This is the merge order the wiring builds.
  const reg = registryIdentity({ feature_type: 'lake', max_depth_ft: 60 });
  const pack = { maxDepthFt: 66 };
  const out = researchIntel({}, SPECIES, 'summer', Date.now(),
    { identity: { ...reg, ...pack } });
  assert.ok(line(out, 'Max depth').includes('66'), out);
});

test('registryIdentity answers nothing rather than an empty object', () => {
  assert.equal(registryIdentity(null), null);
  assert.equal(registryIdentity({}), null);
  // A zero or a missing depth is not a depth.
  assert.equal(registryIdentity({ max_depth_ft: 0 }), null);
  assert.deepEqual(registryIdentity({ feature_type: 'coastal' }), { bodyType: 'coastal' });
});
