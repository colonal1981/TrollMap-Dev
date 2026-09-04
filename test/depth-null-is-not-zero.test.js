// A DEPTH NOBODY MEASURED IS NOT A DEPTH OF ZERO.
//
// `applyShallowLakeApplicability` read `Number(profile.identity?.maxDepthFt)`. `Number(null)` is
// `0` and `Number.isFinite(0)` is `true`, so a lake with no recorded maximum depth passed the
// "ten feet or less" test and had four limnology fields stamped `not_applicable` and stripped
// from the target list BEFORE any query was issued. Self-sealing, because `gateOverallConfidence`
// exempts `not_applicable` from the null-field penalties, so the confidence score never noticed.
//
// MEASURED IN R2, 2026-08-21, cache-busted: 25 of 61 stored profiles carry `maxDepthFt: null`,
// and five carry the stamp --
//
//   high_rock_lake_nc          v4.0   four fields   "Maximum depth 0 ft and average depth 0 ft"
//   lake_blalock_sc            v10.0  four fields   same
//   melton_hill_reservoir_tn   v4.0   four fields   same
//   lake_hickory_nc            v4.0   two fields    same
//   parr_reservoir_sc          v16.0  four fields   "Maximum depth 15 ft and average depth 0 ft"
//
// parr_reservoir_sc is the second operand: a REAL 15 ft maximum with no recorded average, where
// `Number(null) <= 8` closed the shallow-and-flat clause on a number nobody ever took.
//
// Ryan's objection is the right frame and it is why this is a guard rather than a mechanism:
// *"with pulling max depth from bathymetry that should never be an issue... every lake with
// bathymetry will have a max depth."* `deriveDepthStatistics` takes max depth from the contour
// lines even when polygon coverage is too low to trust an average, so any water with a chartpack
// gets one -- Lake Norman's rerun produced 83 ft at coverage 0.969 and cleared its own stamp.
// The guard exists because the stamp is written from the SAVED profile, which only has to store
// null once: a pack that failed to fetch, or a profile written before the override existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// THE DEPTH PIPELINE NOW SPANS TWO FILES. deriveDepthStatistics moved to js/utils/pack-facts.js
// on 2026-09-04 so the planners can run it without importing the research engine; the shallow-lake
// applicability rules it feeds stayed behind in the engine. Both are read, because every
// assertion below is about the pipeline and not about which file a line sits in.
const SRC = [
  readFileSync(path.join(ROOT, 'js/utils/pack-facts.js'), 'utf8'),
  readFileSync(path.join(ROOT, 'js/modules/lake-research-engine.js'), 'utf8'),
].join('\n');

// The module imports browser-only siblings, so the function under test is lifted from source.
// A failed lift fails the test rather than silently testing nothing.
const start = SRC.indexOf('function applyShallowLakeApplicability(');
assert.ok(start >= 0, 'applyShallowLakeApplicability must exist');
const end = SRC.indexOf('\n}', start);
assert.ok(end > start, 'it must be a top-level function');
const applyShallowLakeApplicability = new Function(
  `${SRC.slice(start, end + 2)}\nreturn applyShallowLakeApplicability;`)();

// `limnology.thermocline.strength` was a fourth entry here until 2026-09-01. It is gone with the
// limnology agent: one parenthetical adjective in the prompt, derivable only on the weaker of the
// two thermocline branches.
const FIELDS = ['limnology.thermocline.summerDepthFt',
                'limnology.oxygen.depletionDepthFt', 'limnology.oxygen.anoxicBelowFt'];
const withDepth = (maxDepthFt, averageDepthFt) => ({ identity: { maxDepthFt, averageDepthFt }, fieldStatus: {} });

test('a lake with no recorded maximum depth is not a ten-foot pond', () => {
  const profile = withDepth(null, null);
  assert.deepEqual(applyShallowLakeApplicability(profile, [...FIELDS]), FIELDS,
    'nothing may be stripped from a lake whose depth was never measured');
  assert.deepEqual(profile.fieldStatus, {},
    'five profiles in R2 read "Maximum depth 0 ft" because Number(null) is 0');
});

test('undefined and empty string are also not zero', () => {
  for (const v of [undefined, '']) {
    const profile = withDepth(v, v);
    assert.deepEqual(applyShallowLakeApplicability(profile, [...FIELDS]), FIELDS);
    assert.deepEqual(profile.fieldStatus, {});
  }
});

test('a real 15 ft maximum with no recorded average is not stamped either', () => {
  const profile = withDepth(15, null);           // parr_reservoir_sc
  assert.deepEqual(applyShallowLakeApplicability(profile, [...FIELDS]), FIELDS);
  assert.deepEqual(profile.fieldStatus, {});
});

test('a genuinely shallow lake is still exempted, which is the point of the function', () => {
  const profile = withDepth(8, 4);
  assert.deepEqual(applyShallowLakeApplicability(profile, [...FIELDS]), []);
  assert.equal(profile.fieldStatus['limnology.thermocline.summerDepthFt'].status, 'not_applicable');
  assert.match(profile.fieldStatus['limnology.oxygen.anoxicBelowFt'].reason, /Maximum depth 8 ft/);
});

// THE STAMP IS WHAT gateOverallConfidence READS, AND IT MUST NOT DEPEND ON THE CALLER'S LIST.
//
// This function used to iterate `fields` and stamp only the exempt paths it found there. That
// was indistinguishable from stamping the exempt set itself, right up until the limnology agent
// retired on 2026-09-01 and took its paths out of the recovery list this is called with. The
// stamp would then never be written, and a farm pond would go back to being docked for having no
// thermocline -- the exact penalty this function exists to prevent, undone by an edit in another
// file with no test between them.
test('a shallow lake is stamped even when the caller asks about nothing', () => {
  const profile = withDepth(8, 4);
  assert.deepEqual(applyShallowLakeApplicability(profile, []), []);
  for (const path of FIELDS) {
    assert.equal(profile.fieldStatus[path].status, 'not_applicable', `${path} must be stamped`);
  }
});

test('the shallow-and-flat second clause still fires when both depths are real', () => {
  assert.deepEqual(applyShallowLakeApplicability(withDepth(14, 7), [...FIELDS]), []);
});

test('a deep lake keeps every field', () => {
  const profile = withDepth(83, 29.4);           // Lake Norman, from the bathymetry override
  assert.deepEqual(applyShallowLakeApplicability(profile, [...FIELDS]), FIELDS);
  assert.deepEqual(profile.fieldStatus, {});
});

test('non-exempt fields are never touched', () => {
  const profile = withDepth(8, 4);
  assert.deepEqual(applyShallowLakeApplicability(profile, [...FIELDS, 'biology.primaryForage']),
    ['biology.primaryForage']);
  assert.ok(!('biology.primaryForage' in profile.fieldStatus));
});
