/**
 * test/the-thermocline-was-saved-over.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WATEREE CAME BACK WITH A NULL THERMOCLINE ON 2026-09-02, off the live Worker:
 *
 *     thermocline.summerDepthFt  null      oxygen.anoxicBelowFt  null
 *     waterClarity.secchiFt      null      trophicStatus         null
 *     seasonalDrawdownFt         2.5   <- the one field the deterministic pass writes
 *
 * The WQP rule lived in js/modules/lake-research-engine.js, which only the browser loads, so the
 * batch that replaced that tab could not reach it -- and /research/save replaces rather than
 * merges, so running the batch deleted those numbers on all 64 researched waters.
 *
 *   node --test test/the-thermocline-was-saved-over.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWqpToLimnology, applyDocumentsToLimnology, documentFieldsApplied,
         buildWqpEvidence, limnologyGaps, WQP_LIMNOLOGY_FIELDS }
  from '../js/utils/wqp-limnology.js';

/** What the deterministic pass hands over: one real value and the rest holes. */
const SKELETON = () => ({
  waterClarity: { typical: null, secchiFt: null, note: null },
  surfaceWater: {},
  thermocline: { summerDepthFt: null, method: null, note: null },
  oxygen: { depletionDepthFt: null, anoxicBelowFt: null, note: null },
  trophicStatus: null,
  seasonalDrawdownFt: 2.5,
});

/** Lake Hickory's real pull, as it stood in the profile before the batch overwrote it. */
const HICKORY = {
  ok: true, lastObserved: '2022-09-07', recordCount: 333,
  thermocline: { depthFt: 32, method: 'derived_from_do_profile', evidenceCount: 88 },
  oxygen: { anoxicBelowFt: 38, note: 'Median dissolved oxygen drops below 2 mg/L near 38 ft' },
  secchi: { avgSecchiDepthFt: 5.8, sampleCount: 6, lastObserved: '2017-07-23' },
  surfaceWater: { recentTempF: 81.64, recentDissolvedOxygenMgL: 8.54 },
};

test('the four fields the plan prints come back, and the drawdown is not disturbed', () => {
  const out = applyWqpToLimnology(SKELETON(), HICKORY);
  assert.equal(out.thermocline.summerDepthFt, 32);
  assert.equal(out.thermocline.method, 'derived_from_do_profile');
  assert.equal(out.oxygen.anoxicBelowFt, 38);
  assert.equal(out.waterClarity.secchiFt, 5.8);
  assert.equal(out.trophicStatus, 'eutrophic');   // Carlson: 1.6 <= 5.8 ft < 6.6
  assert.equal(out.waterClarity.typical, 'stained');
  assert.equal(out.seasonalDrawdownFt, 2.5);
  assert.equal(out.surfaceWater.recentTempF, 81.64);
});

test('the base is not mutated -- the caller keeps what it handed over', () => {
  const base = SKELETON();
  applyWqpToLimnology(base, HICKORY);
  assert.equal(base.thermocline.summerDepthFt, null);
});

test('a failed pull changes nothing rather than writing nulls over good values', () => {
  const held = { ...SKELETON(), trophicStatus: 'mesotrophic' };
  held.thermocline.summerDepthFt = 27;
  const out = applyWqpToLimnology(held, { ok: false, error: 'WQP request timed out after 25s' });
  assert.equal(out.thermocline.summerDepthFt, 27);
  assert.equal(out.trophicStatus, 'mesotrophic');
});

test('four samples do not get a trophic label -- Carlson needs five', () => {
  const thin = { ...HICKORY, secchi: { avgSecchiDepthFt: 5.8, sampleCount: 4 } };
  const out = applyWqpToLimnology(SKELETON(), thin);
  assert.equal(out.waterClarity.secchiFt, 5.8, 'the measurement is still a measurement');
  assert.equal(out.trophicStatus, null);
  assert.equal(out.waterClarity.typical, null);
});

test('the gaps are what a document is then the only source for', () => {
  assert.equal(limnologyGaps(SKELETON()).length, WQP_LIMNOLOGY_FIELDS.length);
  // Hickory's pull answers everything except where oxygen depletion begins.
  assert.deepEqual(limnologyGaps(applyWqpToLimnology(SKELETON(), HICKORY)),
                   ['limnology.oxygen.depletionDepthFt']);
});

test('evidence is written for what WQP supplied and for nothing else', () => {
  const ev = buildWqpEvidence(HICKORY).limnology;
  assert.equal(ev.thermocline[0].method, 'derived_from_do_profile');
  assert.equal(ev.thermocline[0].sourceLabel, 'Water Quality Portal / SCDES monitoring');
  assert.equal(ev.oxygen[0].method, 'do_depth_profile_thresholds');
  assert.equal(ev.waterClarity[0].method, 'secchi_samples');
  assert.equal(ev.trophicStatus[0].method, 'carlson_tsi_from_secchi');

  // Four samples set no trophic label, so nothing may cite one. A wrong number is a wrong
  // number; a wrong number wearing a state-monitoring citation is how it never gets caught.
  const thin = buildWqpEvidence({ ...HICKORY, secchi: { avgSecchiDepthFt: 5.8, sampleCount: 4 } });
  assert.equal(thin.limnology.trophicStatus, undefined);
  assert.deepEqual(buildWqpEvidence({ ok: false }), {});
});

// ── A REFUSAL IS AN ANSWER AND IT HAS TO REACH THE FIELD IT REFUSED ────────────────────────────
//
// 2026-09-05, Lake Moultrie (Berkeley Co, SC). `limnology-cache/lake_moultrie_sc.json` holds
// 5,227 records, `depthProfileCount: 0`, and this sentence: "Monitoring data were found, but
// available records are surface/grab samples only -- no vertical depth profiles. Thermocline
// cannot be derived from this source." The profile it belongs to held
// `thermocline: { summerDepthFt: null, method: null, note: null }` -- three nulls and no reason,
// because both merge branches were gated on a value existing.
//
// Checked at record level against WQP the same day: every published visit at Moultrie, from both
// organisations that monitor it, is one activity carrying one dissolved-oxygen value and a
// companion `Depth = 0.3 m` row, and no row in the bucket carries ActivityDepthHeightMeasure.
// There is nothing to parse. "We asked and the data cannot answer" is a different state from
// "nobody has asked", and one of the readers who has to tell them apart is a language model
// filling a silent null from its own recall -- which is how Wateree carried 27 ft for months.
test('a WQP pull that refuses writes its reason onto the fields it could not fill', async () => {
  const refusal = 'Monitoring data were found, but available records are surface/grab samples only'
    + ' — no vertical depth profiles. Thermocline cannot be derived from this source.';
  const out = applyWqpToLimnology({}, {
    ok: true, recordCount: 5227, depthProfileCount: 0,
    thermocline: null, oxygen: null,
    surfaceOnlyNote: refusal, note: refusal,
  });
  assert.equal(out.thermocline.summerDepthFt, undefined, 'the depth stays unanswered');
  assert.equal(out.thermocline.note, refusal, 'the reason must reach the thermocline');
  assert.equal(out.oxygen.note, refusal, 'and the oxygen depths it also refused');
  // The water still needs research -- a reason is not a value.
  assert.ok(limnologyGaps(out).includes('limnology.thermocline.summerDepthFt'));
  assert.ok(limnologyGaps(out).includes('limnology.oxygen.anoxicBelowFt'));
});

test('a refusal never annotates a depth that came from somewhere else', async () => {
  // A document supplied 27 ft. WQP has nothing to say about it, and must not attach a sentence
  // about a source that did not produce that number -- the citation-drift failure this file
  // exists for.
  const out = applyWqpToLimnology(
    { thermocline: { summerDepthFt: 27, method: 'document', note: 'From the 2019 study.' },
      oxygen: { anoxicBelowFt: 30, depletionDepthFt: null, note: 'From the 2019 study.' } },
    { ok: true, recordCount: 12, thermocline: null, oxygen: null,
      surfaceOnlyNote: 'surface/grab samples only' });
  assert.equal(out.thermocline.summerDepthFt, 27);
  assert.equal(out.thermocline.note, 'From the 2019 study.');
  assert.equal(out.oxygen.note, 'From the 2019 study.');
});

// ── A NOTE THAT CAME WITHOUT A DEPTH IS STILL AN ANSWER ────────────────────────────────────────
//
// 2026-09-14/15, Lake Wateree, across three files:
//
//   nla_limnology.json        thermoclineFt: null, thermoclineNote: "no layer reaches 1.0 C/m...
//                             steepest was 0.50 C/m at 18.0 ft over a 7.6 m cast"
//   document_limnology.json   thermoclineNote: null        <- build_document_limnology dropped it
//   the app                   thermocline.note = the WQP surface-grab refusal
//
// So the prompt told the model "these are surface grabs with a depth stamp, not a vertical
// profile" about a lake the pipeline holds a real vertical cast for — one whose steepest layer sat
// at 18 ft, between the 16 and 20 ft two Wateree guides put the summer thermocline at.
//
// Three layers, and the reason evaporated at the middle one. This is the app-side half: a document
// that measured the column and could not NAME a depth must still reach the note field, and it must
// outrank a refusal from a source that never went below the surface.
test('a document note reaches the field even with no depth to go with it', () => {
  const out = applyDocumentsToLimnology(
    { thermocline: { summerDepthFt: null, note: null }, oxygen: {} },
    { offered: true, thermoclineFt: null,
      thermoclineNote: 'NLA 7/21/2022: steepest 0.50 C/m at 18.0 ft', anoxicBelowFt: 19.7 });
  assert.match(out.thermocline.note, /18\.0 ft/);
  assert.equal(out.thermocline.summerDepthFt, null, 'and it still invents no depth');
});

test('a MEASURED refusal outranks an unmeasured one', () => {
  const out = applyDocumentsToLimnology(
    { thermocline: { summerDepthFt: null, note: 'surface grabs with a depth stamp' }, oxygen: {} },
    { offered: true, thermoclineFt: null,
      thermoclineNote: 'NLA 7/21/2022: steepest 0.50 C/m at 18.0 ft', anoxicBelowFt: 19.7 });
  assert.match(out.thermocline.note, /18\.0 ft/, 'the cast that went down the column wins');
});

test('and a document with nothing to say leaves the WQP note alone', () => {
  const out = applyDocumentsToLimnology(
    { thermocline: { summerDepthFt: null, note: 'surface grabs with a depth stamp' }, oxygen: {} },
    { offered: true, thermoclineFt: null, anoxicBelowFt: 19.7 });
  assert.match(out.thermocline.note, /surface grabs/);
});

// ── AND THE ACCEPTANCE TEST AT THE VERY LAST GATE ──────────────────────────────────────────────
//
// `handleResearchLimnologyData` keeps the document merge only when `documentFieldsApplied` says
// something landed:
//
//     const after = applyDocumentsToLimnology(merged, doc);
//     if (applied.thermocline || applied.oxygen) merged = after;
//
// It tested for a DEPTH appearing and nothing else. So on 2026-09-15 Ryan reran four waters, all
// four reported `ok`, and all four came back still carrying the WQP surface-grab refusal — because
// the only thing the cast had to offer was a NOTE, and a note did not count as applied. The fetcher
// wrote it, the builder carried it, applyDocumentsToLimnology applied it, R2 served it, and this
// gate dropped it on the floor.
//
// Fourth place in one pipeline where the same sentence had to be written down: a refusal is an
// answer. Here it wore the shape of an acceptance test that only counted values.
const WQP_ONLY = () => ({
  thermocline: { summerDepthFt: null, method: null,
                 note: 'These are surface grabs with a depth stamp, not a vertical profile.' },
  oxygen: { depletionDepthFt: 16.4, anoxicBelowFt: 19.7, note: 'measured vertical profile' },
});
const CAST_NOTE = 'EPA National Lakes Assessment 7/21/2022: no layer reaches 1.0 C/m, the '
                + 'classical cutoff -- steepest was 0.50 C/m at 18.0 ft over a 7.6 m cast.';

test('a note-only document merge counts as applied, so the caller keeps it', () => {
  const before = WQP_ONLY();
  const after = applyDocumentsToLimnology(before, {
    offered: true, thermoclineFt: null, thermoclineNote: CAST_NOTE,
    anoxicBelowFt: 19.7, depletionDepthFt: 16.4 });
  const applied = documentFieldsApplied(before, after);
  assert.equal(applied.thermocline, true, 'this is the flag that decides whether `after` survives');
  assert.match(after.thermocline.note, /18\.0 ft/);
});

test('and a document that changes nothing is NOT reported as applied', () => {
  // The opposite failure: document evidence written for a merge that did nothing.
  const before = WQP_ONLY();
  const after = applyDocumentsToLimnology(before, {
    offered: true, thermoclineFt: null, anoxicBelowFt: 19.7, depletionDepthFt: 16.4 });
  assert.deepEqual(documentFieldsApplied(before, after), { thermocline: false, oxygen: false });
});

test('a depth still counts, exactly as it did before', () => {
  const before = { thermocline: { summerDepthFt: null }, oxygen: {} };
  const after = { thermocline: { summerDepthFt: 22.0 }, oxygen: {} };
  assert.equal(documentFieldsApplied(before, after).thermocline, true);
});

test('an oxygen note landing counts too, for the same reason', () => {
  const before = { thermocline: {}, oxygen: { anoxicBelowFt: null, note: null } };
  const after = { thermocline: {}, oxygen: { anoxicBelowFt: null, note: 'oxygen never fell under 2 mg/L' } };
  assert.equal(documentFieldsApplied(before, after).oxygen, true);
});
