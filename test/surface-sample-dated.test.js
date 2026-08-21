// AN AUGUST PLAN WAS BEING TOLD THE SURFACE WAS 43.88 DEGREES.
//
// Lake Norman, profile v12.0, rebuilt 2026-08-21. `limnology.surfaceWater.recentTempF` was
// 43.88 and `lastObserved` was 2025-12-16 -- a WQP grab sample from the previous December, which
// is the newest one that source holds for this lake. Nothing refreshes it.
//
// The live number comes from somewhere else entirely. `waterProbe` in Worker/conditions.js walks
// the water's bound USGS sites nearest-first, asks each one's series catalogue before spending a
// request, and takes the first that publishes 00010. For Lake Norman that is 0214264790, "CATAWBA
// R AT RR BRIDGE AB NC 73 AT COWANS FORD", which returned 29.7 C / 85.5 F at 09:00 EDT on
// 2026-08-21. utility-sync.js and plan-builder.js auto-fill `planWaterTemp` from it, and
// smart-plan-v2-wiring.js puts that into the prompt's conditions block.
//
// Both halves reached the same prompt. The research half arrived through
// `buildFactualSummary` -> `profile.summary.text` -> `researchIntel()` as the words "recent
// surface water about 43.88 F" -- no date, and the word "recent" doing the opposite of its job,
// because the PROFILE was genuinely fresh (rerun that morning) so `ageSentence()` correctly
// reported the research as current and made the number inside it look current too.
//
// The fix is not a staleness threshold. A winter surface reading is a real part of a lake's
// thermal range and arbitrary cutoffs are an AI problem, not a fishing problem. The fix is that
// the number is dated wherever it is spoken, and a reader decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sampleDated, buildFactualSummary } from '../Worker/research/facts-util.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

// The real Lake Norman numbers, so a regression reads like the bug did.
const NORMAN = (surfaceWater) => ({
  lakeName: 'Lake Norman',
  identity: { archetype: 'Reservoir', maxDepthFt: 83, averageDepthFt: 29.4 },
  limnology: { surfaceWater, thermocline: { summerDepthFt: 16 }, waterClarity: {}, oxygen: {} },
  biology: {},
  habitat: {},
});

test('sampleDated prefers the number own sample date', () => {
  assert.equal(sampleDated('2025-12-16', '2026-07-01'), ' when last sampled 2025-12-16');
});

test('sampleDated falls back to the group date and says it is the group', () => {
  const s = sampleDated(null, '2025-12-16');
  assert.match(s, /2025-12-16/);
  assert.match(s, /newest surface sample here/,
    'the group date is the newest of temperature, DO and turbidity -- it does not belong to any '
    + 'one of them and must not be printed as though it did');
});

test('sampleDated admits an undated sample rather than going quiet', () => {
  assert.equal(sampleDated(null, null), ' (grab sample, date not recorded)');
  assert.equal(sampleDated(undefined, ''), ' (grab sample, date not recorded)');
});

test('the worker summary dates the surface temperature it hands to the plan', () => {
  const text = buildFactualSummary(NORMAN({
    recentTempF: 43.88, recentTempLastObserved: '2025-12-16',
    recentDissolvedOxygenMgL: 9.2, recentDissolvedOxygenLastObserved: '2025-12-16',
    lastObserved: '2025-12-16',
  }));
  assert.match(text, /43\.88°F when last sampled 2025-12-16/);
  assert.match(text, /9\.2 mg\/L when last sampled 2025-12-16/);
  assert.doesNotMatch(text, /recent surface water/,
    'the word "recent" on an eight-month-old grab sample is the bug');
});

test('a profile written before per-characteristic dates still gets dated', () => {
  const text = buildFactualSummary(NORMAN({
    recentTempF: 43.88, recentDissolvedOxygenMgL: 9.2, lastObserved: '2025-12-16',
  }));
  assert.match(text, /43\.88°F \(grab sample; newest surface sample here 2025-12-16\)/,
    'the 61 profiles already in R2 carry only the group date and must not stay undated');
});

test('a surface temperature never reaches the summary undated', () => {
  const text = buildFactualSummary(NORMAN({ recentTempF: 43.88 }));
  assert.match(text, /43\.88°F \(grab sample, date not recorded\)/);
});

// Each characteristic is its own sample. On a lake monitored for DO this summer and temperature
// last December, the group date makes the temperature look eight months fresher than it is.
test('limnology.js keeps the per-characteristic sample dates it computes', () => {
  const src = read('Worker/research/limnology.js');
  for (const field of ['recentTempLastObserved', 'recentDissolvedOxygenLastObserved',
                       'recentTurbidityLastObserved']) {
    assert.ok(src.includes(field), `limnology.js must write ${field}`);
  }
  assert.ok(/lastObserved: \[swTemp\?\.lastObserved, swDO\?\.lastObserved, swTurbidity\?\.lastObserved\]/.test(src),
    'the combined lastObserved stays -- lake-research-ui.js and the legacy branch above read it');
});

// The client builds the same sentence and cannot import from Worker/. If one side is changed
// alone, a plan built in the browser and a profile built in the worker disagree about the same
// lake.
test('the client mirror dates the same two numbers', () => {
  const src = read('js/modules/lake-research-engine.js');
  assert.ok(src.includes('function sampleDated(ownDate, groupDate)'),
    'lake-research-engine.js must carry the mirrored helper');
  assert.ok(src.includes('surface water near ${lim.surfaceWater.recentTempF}°F${swDated('),
    'the client temperature sentence must be dated');
  assert.ok(src.includes('surface dissolved oxygen near ${lim.surfaceWater.recentDissolvedOxygenMgL} mg/L${swDated('),
    'the client dissolved-oxygen sentence must be dated');
  assert.ok(!/recent surface water near/.test(src), 'the undated client phrasing is the bug');
});

test('both mirrors answer the three cases identically', () => {
  const src = read('js/modules/lake-research-engine.js');
  const body = src.slice(src.indexOf('function sampleDated(ownDate, groupDate)'));
  const clientFn = new Function(`${body.slice(0, body.indexOf('\n}') + 2)}\nreturn sampleDated;`)();
  for (const [own, group] of [['2025-12-16', '2026-07-01'], [null, '2025-12-16'], [null, null]]) {
    assert.equal(clientFn(own, group), sampleDated(own, group),
      `the mirrors disagree for own=${own} group=${group}`);
  }
});
