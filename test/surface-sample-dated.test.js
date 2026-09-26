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
//
// ── AND ON 2026-09-14 IT STOPPED BEING SPOKEN THERE AT ALL ─────────────────────────────────────
//
// Dating it was not enough. Off the bench on Lake Wateree in September, the profile sentence read
// "surface water near 67.19°F when last sampled 2026-04-06" -- correctly dated -- in the same
// prompt as the conditions block's live gauge reading. The model had two temperatures for one lake
// and a reason to believe the wrong one. A dated number is not a safe number when a live one sits
// beside it.
//
// So the surface temperature and surface oxygen came OUT of the profile summary in both builders,
// and the reasoning is written above the cut in each: a summary asserts what the lake IS, and a
// point sample from one visit is weather. The values are not deleted -- limnology.surfaceWater
// keeps them with their dates, and the conditions strip still reads them.
//
// THIS FILE WAS THE STALE SIDE. Four of its tests still required the summary to date two numbers
// it no longer states, so they failed on the change that superseded them. They are rewritten to
// the claim that replaced theirs, which is the stronger one: the summary does not assert a surface
// temperature at all, `sampleDated` still behaves exactly as specified for wherever the number IS
// spoken, and the two builders still agree. (sampleDated and the second builder went with the
// Research tab on 2026-09-25.) The dating rule was not relaxed; it was made moot in
// this one sentence and it still governs the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildFactualSummary } from '../Worker/research/facts-util.js';

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

// Three tests of `sampleDated` stood here. It had no caller left in the Worker, and was kept only
// because the Research tab's engine mirrored it; both went on 2026-09-25.

test('the worker summary states no surface temperature at all, however well dated', () => {
  const dated = buildFactualSummary(NORMAN({
    recentTempF: 43.88, recentTempLastObserved: '2025-12-16',
    recentDissolvedOxygenMgL: 9.2, recentDissolvedOxygenLastObserved: '2025-12-16',
    lastObserved: '2025-12-16',
  }));
  assert.doesNotMatch(dated, /43\.88/, 'a dated surface temperature is still a second temperature');
  assert.doesNotMatch(dated, /9\.2 mg/);
  assert.doesNotMatch(dated, /surface water near/);
  assert.doesNotMatch(dated, /recent surface water/,
    'the word "recent" on an eight-month-old grab sample was the original bug');

  // The group-date-only shape -- the 61 profiles already in R2 -- and the undated one.
  for (const sw of [{ recentTempF: 43.88, recentDissolvedOxygenMgL: 9.2, lastObserved: '2025-12-16' },
                    { recentTempF: 43.88 }]) {
    assert.doesNotMatch(buildFactualSummary(NORMAN(sw)), /43\.88/);
  }
});

// AND THE CHARACTERISTICS IT DOES STATE ARE STILL THERE, because "removed the surface sample" must
// not have quietly become "removed the limnology sentence". Ryan's own line on what belongs: a
// thermocline is a boundary and a property of the lake; a surface grab is what it was on one day.
test('but the durable characteristics still reach the plan', () => {
  const text = buildFactualSummary(NORMAN({ recentTempF: 43.88, lastObserved: '2025-12-16' }));
  assert.match(text, /summer thermocline near 16 ft/);
  assert.match(text, /Available limnology data indicate/);
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
    'the combined lastObserved stays -- the legacy branch above reads it');
});

// TWO MIRROR TESTS STOOD HERE: that the Research tab's engine dropped the same two numbers and
// answered sampleDated's three cases the same way. The engine was deleted on 2026-09-25. The
// half that still has something to hold is the Worker's own:
test('no dead swDated binding is left in the worker', () => {
  assert.ok(!/const swDated =/.test(read('Worker/research/facts-util.js')),
    'dead swDated binding in the worker');
});
