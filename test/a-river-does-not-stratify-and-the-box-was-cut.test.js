// A RIVER DOES NOT STRATIFY, AND FOUR CRANKBAITS WERE DELETED BECAUSE THE APP THOUGHT ONE DID.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Found by Ryan reading the Congaree's own prompt, 2026-09-17: "looking at the run from congaree
// earlier... i see a couple of issues in here". The researched-profile block opened with
//
//     - Lake type: river
//     - Thermocline in summer: 8 ft — the depth the water column stops mixing...
//     - Anoxic below: 8 ft — nothing holds under this in late summer
//     - Trophic status: eutrophic
//     - Other predators here: Largemouth Bass; ...; Channel Catfish; Blue Catfish; Flathead
//       Catfish; Striped Bass; White Bass / Hybrid; Catfish; ...
//
// on water that was moving 2,840 ft3/s that morning, planned FOR largemouth bass. And the anoxic
// number is not decoration — it is the one measured number the bait gate stands on, so the prompt
// that went to the model also said:
//
//     WHAT EACH OF THESE COVERS, SHALLOWEST FIRST — AND THE FLOOR IS 8 FT
//     NOT AVAILABLE BEHIND THE BOAT, and why:
//     - DD1 Crankbait (14-18ft): ... there is no oxygen below 8 ft — every pass would be in dead water
//     - DD2 (16-20ft), DD3 (20-25ft), DD4 (25ft+): the same
//
// Verified in the saved bench JSON, not inferred from the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { researchIntel, oxygenFloorFt } from '../js/modules/plan-inputs.js';
import { dropFieldsThisWaterCannotHave, limnologyFieldsFor } from '../js/utils/wqp-limnology.js';

// The Congaree's real stored limnology, verbatim off registry/_research_profiles.
const RIVER_LIMNOLOGY = {
  waterClarity: { typical: 'stained', secchiFt: 4.5, note: 'Recent WQP/SCDES surface turbidity around 9.6 NTU.' },
  thermocline: { summerDepthFt: 8, method: 'derived_from_do_profile', note: null },
  oxygen: {
    depletionDepthFt: null, anoxicBelowFt: 8,
    note: 'Median dissolved oxygen drops below 2 mg/L near 8 ft in available depth-profile samples.',
  },
  trophicStatus: 'eutrophic',
};
const river = (over = {}) => ({
  identity: { bodyType: 'river' },
  limnology: JSON.parse(JSON.stringify(RIVER_LIMNOLOGY)),
  biology: { predatorSpecies: ['Largemouth Bass', 'Bluegill'] },
  summary: { text: 'Confirmed sport fish include Largemouth Bass, Bluegill. Available limnology '
                 + 'data indicate Secchi clarity around 4.5 ft; summer thermocline near 8 ft.' },
  ...over,
});
const lake = (over = {}) => ({
  identity: { bodyType: 'lake' },
  limnology: JSON.parse(JSON.stringify(RIVER_LIMNOLOGY)),
  biology: { predatorSpecies: ['Largemouth Bass', 'Bluegill'] },
  ...over,
});

// ── THE ONE WITH TEETH ────────────────────────────────────────────────────────────────────────

test('a river has no oxygen floor, so nothing is cut from the box for being deep', () => {
  assert.equal(oxygenFloorFt(river(), null), null);
  // The same numbers on a lake still gate, because on a lake they mean something.
  assert.equal(oxygenFloorFt(lake(), null), 8);
});

test('and the water type beats the profile, whichever carrier names it', () => {
  assert.equal(oxygenFloorFt({ ...river(), identity: { archetype: 'river' } }, null), null);
  // A pack fact naming the type wins the same way, because it is merged over the profile.
  assert.equal(oxygenFloorFt(lake(), { identity: { bodyType: 'river' } }), null);
});

test('an unknown water type is not a river, because absence is not a claim', () => {
  assert.equal(oxygenFloorFt({ limnology: RIVER_LIMNOLOGY }, null), 8);
});

// ── WHAT THE PROMPT SAYS INSTEAD ──────────────────────────────────────────────────────────────

test('the three lake numbers do not reach the prompt on a river, and the reason does', () => {
  const s = researchIntel(river(), 'Largemouth Bass', 'summer');
  assert.ok(!/Thermocline in summer/.test(s));
  assert.ok(!/Anoxic below/.test(s));
  // `Trophic status: ` with the colon -- the river line itself says the words "Trophic status",
  // which is the assertion catching my own sentence rather than the field.
  assert.ok(!/Trophic status: /.test(s));
  // SAID, NOT SILENTLY DROPPED. A missing line reads the same as "nobody measured", and why a
  // river has no thermocline is a fact a plan can use.
  assert.ok(/NOT APPLICABLE — this is moving water/.test(s));
  assert.ok(/mixes top to bottom/.test(s));
  // Secchi is measured on rivers and means the same thing, so it stays.
  assert.ok(/Secchi: 4.5 ft/.test(s));
});

test('and a lake still gets all three', () => {
  const s = researchIntel(lake(), 'Largemouth Bass', 'summer');
  assert.ok(/Thermocline in summer: 8 ft/.test(s));
  assert.ok(/Anoxic below: 8 ft/.test(s));
  assert.ok(/Trophic status: eutrophic/.test(s));
  assert.ok(!/NOT APPLICABLE/.test(s));
});

test('a stored summary does not get to contradict the line four above it', () => {
  // The producer no longer derives a thermocline on moving water, but 78 stored summaries keep
  // theirs until each water is next researched. A prompt that says NOT APPLICABLE and then quotes
  // a depth three lines later has told the model nothing.
  const s = researchIntel(river(), 'Largemouth Bass', 'summer');
  assert.ok(!/thermocline near 8 ft/i.test(s));
  assert.ok(/Confirmed sport fish include Largemouth Bass/.test(s), 'and the rest of it survives');
  // On a lake the sentence is true and stays.
  const l = researchIntel(lake({ summary: river().summary }), 'Largemouth Bass', 'summer');
  assert.ok(/thermocline near 8 ft/i.test(l));
});

// ── THE PRODUCER, SO IT STOPS BEING WRITTEN AT ALL ────────────────────────────────────────────

test('the table that decided what to look for now also decides what to keep', () => {
  // `WQP_FIELDS_BY_WATER_TYPE` already said a river has only Secchi. It was spent on the gap list
  // — what the document extractor goes hunting for — while the WQP pull in the same request went
  // on deriving a thermocline from the depth-profile samples and storing it.
  assert.deepEqual(limnologyFieldsFor('river'), ['limnology.waterClarity.secchiFt']);
  const lim = JSON.parse(JSON.stringify(RIVER_LIMNOLOGY));
  dropFieldsThisWaterCannotHave(lim, 'river');
  assert.equal(lim.thermocline.summerDepthFt, undefined);
  assert.equal(lim.oxygen.anoxicBelowFt, undefined);
  assert.equal(lim.oxygen.depletionDepthFt, undefined);
  assert.equal(lim.trophicStatus, undefined);
  assert.equal(lim.waterClarity.secchiFt, 4.5, 'Secchi is measured on rivers and means the same');
  // A null with no reason beside it is the hole a model fills from its own recall.
  assert.match(lim.thermocline.note, /mixes top to bottom/);
  assert.match(lim.oxygen.note, /mixes top to bottom/);
});

test('and it leaves a lake alone', () => {
  const lim = JSON.parse(JSON.stringify(RIVER_LIMNOLOGY));
  dropFieldsThisWaterCannotHave(lim, 'lake');
  assert.equal(lim.thermocline.summerDepthFt, 8);
  assert.equal(lim.oxygen.anoxicBelowFt, 8);
  assert.equal(lim.trophicStatus, 'eutrophic');
});

// ── AND THE ROSTER ────────────────────────────────────────────────────────────────────────────

test('"other predators" means other, and it was leading with the target', () => {
  const p = river({ biology: { predatorSpecies: ['Largemouth Bass', 'Bluegill', 'Bowfin'] } });
  const s = researchIntel(p, 'Largemouth Bass', 'summer');
  assert.match(s, /Other predators here: Bluegill; Bowfin/);
});

test('a group term off the regulations digest is not a fish', () => {
  // "Catfish (all species)" is a RULE. Counted across all 78 profiles: 28 entries like this, and
  // `Catfish` x14 and `Crappie` x10 are most of it.
  const p = river({ biology: { predatorSpecies: ['Channel Catfish', 'Blue Catfish', 'Catfish',
                                                 'Black Crappie', 'Crappie', 'Bowfin'] } });
  const s = researchIntel(p, 'Largemouth Bass', 'summer');
  assert.match(s, /Other predators here: Channel Catfish; Blue Catfish; Black Crappie; Bowfin/);
});

test('and the one-word clause is what keeps the striper, which a bare suffix test would have eaten', () => {
  // "Striped Bass" is a suffix of "Hybrid Striped Bass" on four waters and they are DIFFERENT
  // FISH. Measured: the one-word rule catches 28 group terms and keeps all four stripers.
  const p = river({ biology: { predatorSpecies: ['Hybrid Striped Bass', 'Striped Bass', 'Bass'] } });
  const s = researchIntel(p, 'Largemouth Bass', 'summer');
  assert.match(s, /Other predators here: Hybrid Striped Bass; Striped Bass$/m);
});

test('the forage lists get the same rule', () => {
  const p = river({ biology: { primaryForage: ['Threadfin Shad', 'Gizzard Shad', 'Shad'],
                               secondaryForage: ['Blue Crabs', 'crabs', 'snails'] } });
  const s = researchIntel(p, 'Largemouth Bass', 'summer');
  assert.match(s, /Primary forage: Threadfin Shad; Gizzard Shad$/m);
  assert.match(s, /Secondary forage: Blue Crabs; snails$/m);
});

test('a bare string where a list belongs is a list of one, not a crash', () => {
  // watauga_tn.json stores `secondaryForage` as "gizzard shad, bluegill, and assorted minnows".
  const p = river({ biology: { secondaryForage: 'gizzard shad, bluegill, and assorted minnows' } });
  const s = researchIntel(p, 'Largemouth Bass', 'summer');
  assert.match(s, /Secondary forage: gizzard shad, bluegill, and assorted minnows/);
});

test('it is Water type, not Lake type, and the field has three values', () => {
  assert.match(researchIntel(river(), 'Largemouth Bass', 'summer'), /Water type: river/);
  assert.ok(!/Lake type/.test(researchIntel(river(), 'Largemouth Bass', 'summer')));
});
