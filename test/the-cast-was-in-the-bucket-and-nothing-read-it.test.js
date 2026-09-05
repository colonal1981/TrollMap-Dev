/**
 * test/the-cast-was-in-the-bucket-and-nothing-read-it.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * `registry/nla_limnology.json` was written on 2026-09-04 and uploaded to R2 the same day, and
 * the only file that ever opened it was the audit COUNTING what it would fix. Measured by that
 * audit on 2026-09-05: thirteen waters carry a measured thermocline or anoxic depth in a
 * document while their stored profile carries null.
 *
 * Three of them -- Lake Brandt, Quaker Creek Reservoir, Kings Mountain Number One Lake -- have
 * one NLA 2007 cast and NO state monitoring at depth at all. They are the reason the sweep's
 * `if (!pull?.ok || !(pull.recordCount > 0)) continue;` had to move: a water WQP cannot answer
 * is exactly the water the documents are for, and that guard skipped every one of them.
 *
 *   node --test test/the-cast-was-in-the-bucket-and-nothing-read-it.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWqpToLimnology, applyDocumentsToLimnology, buildDocumentEvidence,
         documentFieldsApplied, limnologyGaps } from '../js/utils/wqp-limnology.js';

const SKELETON = () => ({
  waterClarity: { typical: null, secchiFt: null, note: null },
  surfaceWater: {},
  thermocline: { summerDepthFt: null, method: null, note: null },
  oxygen: { depletionDepthFt: null, anoxicBelowFt: null, note: null },
  trophicStatus: null,
  seasonalDrawdownFt: 2.5,
});

/** Lake Cooley (Spartanburg Co, SC) as build_document_limnology.py writes it. */
const COOLEY = {
  slug: 'lake_cooley', offered: true, castCount: 1,
  sources: ['EPA National Lakes Assessment'],
  thermoclineFt: 14.8,
  thermoclineNote: 'measured vertical profile, EPA National Lakes Assessment 8/15/2022',
  anoxicBelowFt: 13.1,
  anoxicNote: 'measured vertical profile, EPA National Lakes Assessment 8/15/2022',
  depletionDepthFt: 13.1,
  depletionNote: 'measured vertical profile, EPA National Lakes Assessment 8/15/2022',
};

test('a cast fills the two fields the plan calls "where the fish can physically be"', () => {
  const before = SKELETON();
  const after = applyDocumentsToLimnology(before, COOLEY);
  assert.equal(after.thermocline.summerDepthFt, 14.8);
  assert.equal(after.thermocline.method, 'document_vertical_profile');
  assert.equal(after.oxygen.anoxicBelowFt, 13.1);
  assert.equal(after.oxygen.depletionDepthFt, 13.1);
  assert.equal(after.seasonalDrawdownFt, 2.5, 'the deterministic field is not disturbed');
  assert.deepEqual(limnologyGaps(after),
    ['limnology.waterClarity.secchiFt', 'limnology.trophicStatus'],
    'the two depths leave the gap list; clarity and trophic status still need a source');
});

test('the base is not mutated', () => {
  const base = SKELETON();
  applyDocumentsToLimnology(base, COOLEY);
  assert.equal(base.thermocline.summerDepthFt, null);
});

// THE MEASUREMENT OF RECORD STANDS. WQP is this water sampled by the agency that monitors it,
// usually within a few years. An NLA cast is one visit to a statistically selected site and the
// 1973 survey is fifty-three years old. A document that overwrote a live derivation would be the
// retired limnology agent's defect back in a new coat.
test('a document never overwrites a value WQP supplied', () => {
  const wqp = applyWqpToLimnology(SKELETON(), {
    ok: true, recordCount: 333,
    thermocline: { depthFt: 32, method: 'derived_from_do_profile', evidenceCount: 88 },
    oxygen: { anoxicBelowFt: 38, note: 'Median dissolved oxygen drops below 2 mg/L near 38 ft' },
  });
  const after = applyDocumentsToLimnology(wqp, COOLEY);
  assert.equal(after.thermocline.summerDepthFt, 32);
  assert.equal(after.thermocline.method, 'derived_from_do_profile');
  assert.equal(after.oxygen.anoxicBelowFt, 38);
  assert.equal(after.oxygen.depletionDepthFt, 13.1, 'but it still fills the one WQP left null');
});

// A NOTE EXPLAINING WHY WE HAVE NO ANSWER MUST NOT SURVIVE NEXT TO AN ANSWER.
// applyWqpToLimnology writes "surface/grab samples only -- no vertical depth profiles" into the
// note when it cannot derive a depth. Lake Wateree's profile carries exactly that sentence while
// nla_limnology.json holds an anoxic depth of 19.7 ft from an actual cast.
test('the refusal note is replaced by the note of the cast that answered it', () => {
  const refused = applyWqpToLimnology(SKELETON(), {
    ok: true, recordCount: 5227, thermocline: null, oxygen: null,
    surfaceOnlyNote: 'Monitoring data were found, but available records are surface/grab samples '
                   + 'only -- no vertical depth profiles.',
  });
  assert.match(refused.oxygen.note, /surface\/grab samples only/);
  const after = applyDocumentsToLimnology(refused, {
    slug: 'wateree_lake', offered: true, castCount: 1, sources: ['EPA National Lakes Assessment'],
    thermoclineFt: null, thermoclineNote: null,
    anoxicBelowFt: 19.7, anoxicNote: 'measured vertical profile, EPA National Lakes Assessment 2012',
    depletionDepthFt: 16.4, depletionNote: 'measured vertical profile, EPA National Lakes Assessment 2012',
  });
  assert.equal(after.oxygen.anoxicBelowFt, 19.7);
  assert.match(after.oxygen.note, /National Lakes Assessment 2012/);
  assert.equal(after.thermocline.summerDepthFt, null,
    'the cast had no thermocline, so the refusal for THAT field is untouched');
  assert.match(after.thermocline.note, /surface\/grab samples only/);
});

// THE HELD STATEMENTS. The 2021 and 2022 Lake Murray reports state a boundary below 3-4 m at
// S-326, in the Clouds Creek arm, whose average total depth those same reports print as 5.1 m,
// in a lake our chart takes to 192 ft. Whether an arm may speak for a lake is a fishing
// judgment, not a threshold, and until somebody makes it that number is not a profile field.
test('an entry marked not offered writes nothing at all', () => {
  const base = SKELETON();
  const after = applyDocumentsToLimnology(base, {
    slug: 'lake_murray', offered: false,
    depletionDepthFt: 9.8, depletionNote: 'S-326, Clouds Creek arm',
  });
  assert.equal(after.oxygen.depletionDepthFt, null);
  assert.deepEqual(buildDocumentEvidence({ offered: false }, { oxygen: true }), {});
});

test('a missing row is not an error', () => {
  assert.equal(applyDocumentsToLimnology(SKELETON(), null).thermocline.summerDepthFt, null);
  assert.equal(applyDocumentsToLimnology(SKELETON(), undefined).oxygen.anoxicBelowFt, null);
});

// The evidence row is a claim about where a STORED value came from, so it is written for the
// fields this pass actually wrote and no others -- the same rule buildWqpEvidence() follows, and
// the only defence against a number acquiring a citation that did not produce it.
test('evidence is written for the fields this pass wrote, and only those', () => {
  const wqp = applyWqpToLimnology(SKELETON(), {
    ok: true, recordCount: 333,
    thermocline: { depthFt: 32, method: 'derived_from_do_profile', evidenceCount: 88 },
  });
  const after = applyDocumentsToLimnology(wqp, COOLEY);
  const applied = documentFieldsApplied(wqp, after);
  assert.equal(applied.thermocline, false, 'WQP already had the thermocline');
  assert.equal(applied.oxygen, true);
  const ev = buildDocumentEvidence(COOLEY, applied);
  assert.deepEqual(Object.keys(ev.limnology), ['oxygen']);
  assert.equal(ev.limnology.oxygen[0].sourceLabel, 'EPA National Lakes Assessment');
  assert.equal(ev.limnology.oxygen[0].method, 'document_vertical_profile');
  assert.match(ev.limnology.oxygen[0].quote, /8\/15\/2022/,
    'the citation names the cast and its date, so 1973 is never mistaken for last summer');
});

test('a pass that wrote nothing claims no citation', () => {
  const base = SKELETON();
  const applied = documentFieldsApplied(base, applyDocumentsToLimnology(base, null));
  assert.deepEqual(applied, { thermocline: false, oxygen: false });
  assert.deepEqual(buildDocumentEvidence(COOLEY, applied), {});
});
