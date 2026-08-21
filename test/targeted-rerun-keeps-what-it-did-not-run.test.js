// WHAT A PARTIAL RERUN THREW AWAY.
//
// Ryan, 2026-08-21, after Lake Norman's rerun did not land: *"why don't you look at how a partial
// rerun saves... i bet there is an issue with merging it in if i was a betting man."*
//
// He was right, and the tell was that assembleAndSaveProfile already fixes this for one of three
// things. `sources` is seeded from the saved profile with a comment saying why -- "so resume runs
// don't lose confidence scoring from prior full runs". `_extractedFacts` and `evidence` were left
// on the replace path:
//
//   allFacts = agentResults.flatMap(r => r.data._extractedFacts || [])     <- only what ran
//   evidence = mergeEvidenceMaps(det.evidence, buildWqpEvidence(wqp))      <- existing never read
//
// and the Worker stores both by replacement (`_extractedFacts: incomingProfile._extractedFacts
// || []`). Measured on the stored Lake Norman profile the same day: 54 facts across seventeen
// categories -- hazard, ramp, stocking, speciesAbundance, primaryForage, seasonalPattern,
// hydraulicRetentionDays and sixteen summary facts alongside the identity and limnology ones --
// and an evidence map with eleven habitat sub-keys plus one each for navigation and summary.
// Rerunning identity and limnology alone would have kept the second group and dropped the first.
//
// The ledger is an INPUT, not a record: validateExistingFacts throws "This saved profile has no
// extracted facts to validate" without it, recoverSmartPlanFacts scores cached documents against
// it, and the fact-backed identity override is gated on its length.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(ROOT, 'js/modules/lake-research-engine.js'), 'utf8');

// The module imports browser-only siblings, so the functions under test are lifted out of the
// source rather than imported. `cloneJson` is reproduced from the same file, three lines above
// them. If a lift fails the test fails -- it cannot silently test nothing.
function lift(...names) {
  const bodies = names.map((name) => {
    const start = SRC.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} must exist in lake-research-engine.js`);
    const end = SRC.indexOf('\n}', start);
    assert.ok(end > start, `${name} must be a top-level function`);
    return SRC.slice(start, end + 2);
  });
  const prelude = 'function cloneJson(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }';
  return new Function(`${prelude}\n${bodies.join('\n')}\nreturn {${names.join(',')}};`)();
}

const { mergeFactLedger } = lift('mergeFactLedger');
const { mergeEvidenceMaps } = lift('evidenceEntryKey', 'mergeEvidenceMaps');
const { applyShallowLakeApplicability } = lift('applyShallowLakeApplicability');

const fact = (category, text, agent) => ({
  category, fact: text, quote: `"${text}"`, source: 'https://example.gov/report.pdf',
  ...(agent ? { _agent: agent } : {}),
});
const ran = (agent, facts) => ({ agent, data: { _extractedFacts: facts, section: {} } });

// ── the fact ledger ────────────────────────────────────────────────────────

test('a rerun of two agents keeps the facts of the five it did not run', () => {
  const saved = [
    fact('hazard', 'Submerged roadbed at the old NC 150 crossing', 'navigation'),
    fact('stocking', '1.2 million striped bass fingerlings stocked in 2019', 'biology'),
    fact('oxygen', 'Hypolimnetic DO below 2 mg/L by late July', 'limnology'),
  ];
  const { facts, carried } = mergeFactLedger(saved, [
    ran('identity', [fact('surfaceArea', '32,510 surface acres')]),
    ran('limnology', [fact('oxygen', 'Anoxia from 25 ft down in August')]),
  ]);
  assert.equal(carried, 2, 'the navigation and biology facts must survive');
  const categories = facts.map((f) => f.category).sort();
  assert.deepEqual(categories, ['hazard', 'oxygen', 'stocking', 'surfaceArea']);
  assert.ok(facts.some((f) => f.category === 'hazard'), 'the hazard fact is the whole point');
  // Two oxygen facts went in and one came out: the saved one is limnology's, limnology reran,
  // and its new extraction is the current answer. Superseding is not the same as wiping.
  assert.equal(facts.filter((f) => f.category === 'oxygen').length, 1);
  assert.equal(facts.find((f) => f.category === 'oxygen').fact, 'Anoxia from 25 ft down in August');
});

test('an agent that reran replaces its own facts and only its own', () => {
  const saved = [
    fact('oxygen', 'Hypolimnetic DO below 2 mg/L by late July', 'limnology'),
    fact('stocking', '1.2 million striped bass fingerlings stocked in 2019', 'biology'),
  ];
  const { facts } = mergeFactLedger(saved, [ran('limnology', [fact('secchi', '6.2 ft mean Secchi')])]);
  assert.ok(!facts.some((f) => f.fact.includes('Hypolimnetic')), 'limnology spoke again');
  assert.ok(facts.some((f) => f.fact.includes('striped bass')), 'biology did not');
});

test('an agent that ran and returned nothing has not replaced anything', () => {
  const saved = [fact('oxygen', 'Hypolimnetic DO below 2 mg/L by late July', 'limnology')];
  const { facts, carried } = mergeFactLedger(saved, [
    { agent: 'limnology', data: { _extractedFacts: [], section: {} } },
  ]);
  assert.equal(carried, 1);
  assert.equal(facts.length, 1, 'an empty extraction must not wipe a populated ledger');
});

test('facts saved before the agent stamp existed are kept unless restated', () => {
  const saved = [
    fact('hazard', 'Submerged roadbed at the old NC 150 crossing'),
    fact('surfaceArea', '32,510 surface acres'),
  ];
  const { facts, carried } = mergeFactLedger(saved, [
    ran('identity', [fact('surfaceArea', '32,510   Surface Acres')]),
  ]);
  assert.equal(carried, 1, 'the restated one is dropped, the unattributable other is not');
  assert.equal(facts.filter((f) => f.category === 'surfaceArea').length, 1,
    'case and whitespace must not make the same fact look like two');
  assert.ok(facts.some((f) => f.category === 'hazard'));
});

test('fresh facts come first so the identity override reads the new one', () => {
  const saved = [fact('surfaceArea', '30,000 surface acres', 'biology')];
  const { facts } = mergeFactLedger(saved, [ran('identity', [fact('surfaceArea', '32,510 surface acres')])]);
  assert.equal(facts.find((f) => f.category === 'surfaceArea').fact, '32,510 surface acres');
});

test('every fresh fact is stamped with the agent that produced it', () => {
  const { facts } = mergeFactLedger([], [ran('habitat', [fact('structuralElement', 'Standing timber in Reeds Creek')])]);
  assert.equal(facts[0]._agent, 'habitat');
});

test('an empty saved ledger and an empty run are both handled', () => {
  assert.deepEqual(mergeFactLedger(null, null), { facts: [], carried: 0 });
  assert.deepEqual(mergeFactLedger(undefined, []), { facts: [], carried: 0 });
});

// ── the evidence map ───────────────────────────────────────────────────────

const ev = (url, method, extra = {}) => ({
  sourceType: 'internal_geospatial_layer', sourceLabel: 'TrollMap bathymetry',
  sourceUrl: url, quote: null, method, ...extra,
});

test('merging an evidence map into itself does not grow it', () => {
  const saved = { identity: { maxDepthFt: [ev('internal:bathymetry', 'geometry_derived_hypsometry', { coverage: 0.969 })] } };
  const once = mergeEvidenceMaps(saved, saved);
  assert.equal(once.identity.maxDepthFt.length, 1);
  const twice = mergeEvidenceMaps(once, saved);
  assert.equal(twice.identity.maxDepthFt.length, 1,
    'the seeded map is re-merged on every save -- a blind concat grew forever');
});

test('the same claim measured again replaces the older measurement in place', () => {
  const saved = { identity: { maxDepthFt: [ev('internal:bathymetry', 'geometry_derived_hypsometry', { coverage: 0.900 })] } };
  const fresh = { identity: { maxDepthFt: [ev('internal:bathymetry', 'geometry_derived_hypsometry', { coverage: 0.969 })] } };
  const out = mergeEvidenceMaps(saved, fresh);
  assert.equal(out.identity.maxDepthFt.length, 1);
  assert.equal(out.identity.maxDepthFt[0].coverage, 0.969, 'the newer measurement wins');
});

test('a different source or method is a different entry', () => {
  const saved = { identity: { maxDepthFt: [ev('internal:bathymetry', 'geometry_derived_hypsometry')] } };
  const fresh = { identity: { maxDepthFt: [ev('internal:contours', 'geometry_derived_max_depth_only')] } };
  assert.equal(mergeEvidenceMaps(saved, fresh).identity.maxDepthFt.length, 2);
});

test('a section only the saved map holds survives the merge', () => {
  const saved = { navigation: { hazards: [ev('https://ncwildlife.gov/x', 'document_extraction')] },
                  habitat: { cover: [ev('https://ncwildlife.gov/y', 'document_extraction')] } };
  const fresh = { identity: { maxDepthFt: [ev('internal:bathymetry', 'geometry_derived_hypsometry')] } };
  const out = mergeEvidenceMaps(saved, fresh);
  assert.ok(out.navigation?.hazards?.length, 'navigation evidence is not regenerated by anything');
  assert.ok(out.habitat?.cover?.length);
  assert.ok(out.identity?.maxDepthFt?.length);
});

test('assembleAndSaveProfile seeds the evidence map from the saved profile', () => {
  assert.ok(/mergeEvidenceMaps\(\s*mergeEvidenceMaps\(existingSavedProfile\.evidence \|\| \{\}, det\.evidence \|\| \{\}\),/.test(SRC),
    'the saved evidence map must be the seed, with the fresh entries landing on top of it');
});

// ── the depth guard ────────────────────────────────────────────────────────

const SHALLOW_FIELDS = ['limnology.thermocline.summerDepthFt', 'limnology.thermocline.strength',
                        'limnology.oxygen.depletionDepthFt', 'limnology.oxygen.anoxicBelowFt'];
const withDepth = (maxDepthFt, averageDepthFt) => ({ identity: { maxDepthFt, averageDepthFt }, fieldStatus: {} });

test('a lake with no recorded maximum depth is not a ten-foot pond', () => {
  const profile = withDepth(null, null);
  const kept = applyShallowLakeApplicability(profile, [...SHALLOW_FIELDS]);
  assert.deepEqual(kept, SHALLOW_FIELDS, 'nothing may be stripped on an unmeasured lake');
  assert.deepEqual(profile.fieldStatus, {},
    'six profiles in R2 already read "Maximum depth 0 ft" because Number(null) is 0');
});

test('undefined and empty string are also not zero', () => {
  for (const v of [undefined, '']) {
    const profile = withDepth(v, v);
    assert.deepEqual(applyShallowLakeApplicability(profile, [...SHALLOW_FIELDS]), SHALLOW_FIELDS);
    assert.deepEqual(profile.fieldStatus, {});
  }
});

test('a real 15 ft maximum with no recorded average is not stamped either', () => {
  // parr_reservoir_sc, measured 2026-08-21: maxDepthFt 15, averageDepthFt null, all four fields
  // stamped "Maximum depth 15 ft and average depth 0 ft".
  const profile = withDepth(15, null);
  assert.deepEqual(applyShallowLakeApplicability(profile, [...SHALLOW_FIELDS]), SHALLOW_FIELDS);
  assert.deepEqual(profile.fieldStatus, {});
});

test('a genuinely shallow lake is still exempted, which is the point of the function', () => {
  const profile = withDepth(8, 4);
  assert.deepEqual(applyShallowLakeApplicability(profile, [...SHALLOW_FIELDS]), []);
  assert.equal(profile.fieldStatus['limnology.thermocline.summerDepthFt'].status, 'not_applicable');
  assert.match(profile.fieldStatus['limnology.oxygen.anoxicBelowFt'].reason, /Maximum depth 8 ft/);
});

test('the shallow-and-flat second clause still fires when both depths are real', () => {
  const profile = withDepth(14, 7);
  assert.deepEqual(applyShallowLakeApplicability(profile, [...SHALLOW_FIELDS]), []);
});

test('a deep lake keeps every field', () => {
  const profile = withDepth(83, 29.4);   // Lake Norman, from the bathymetry override
  assert.deepEqual(applyShallowLakeApplicability(profile, [...SHALLOW_FIELDS]), SHALLOW_FIELDS);
  assert.deepEqual(profile.fieldStatus, {});
});

test('non-exempt fields are never touched', () => {
  const profile = withDepth(8, 4);
  const kept = applyShallowLakeApplicability(profile, [...SHALLOW_FIELDS, 'biology.primaryForage']);
  assert.deepEqual(kept, ['biology.primaryForage']);
  assert.ok(!('biology.primaryForage' in profile.fieldStatus));
});
