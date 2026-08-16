// A stated rule instead of invented per-lake numbers.
//
// SPECIES_BEHAVIOR carried dawn/day/dusk depth shifts and trolling speeds for ONE species on TWO
// lakes. Ryan, 2026-08-16: "those 2 got hand built numbers because you hand built them... you
// were that agent that invented them in the first place." Two lakes had them and 452 did not,
// and the two were not better off — they were confidently wrong.
//
// His rule: topwater is much more possible at dawn and dusk, because fish feed then and have no
// eyelids; more prevalent on overcast days; speed is variable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudFraction, lowLightFactor, phaseWindow } from '../js/utils/species-phase.js';

// trollingIntelligence[species][season] as the pipeline writes it.
const SUMMER = {
  preferredDepth: [12, 22], waterDepthFt: [20, 40], holding: 'suspended',
  structures: ['channel ledges', 'creek mouths'], forage: ['blueback herring'],
  recommendedPresentations: ['umbrella rig', 'flutter spoon'],
  notes: 'works the 12- to 22-foot range',
};

test('the window never leaves the band the profile measured', () => {
  // A rule may move you inside measured water. It may not invent new water.
  for (const phaseNum of [1, 2, 3]) {
    for (const weather of [null, 'Sunny', 'Overcast', 'Partly Cloudy']) {
      const w = phaseWindow(SUMMER, { phaseNum, weather });
      assert.ok(w.depthMin >= 12, `min ${w.depthMin} escaped the band`);
      assert.ok(w.depthMax <= 22, `max ${w.depthMax} escaped the band`);
      assert.ok(w.depthMin <= w.depthMax);
    }
  }
});

test('low light works the top of the band and glare works the bottom', () => {
  const dawn = phaseWindow(SUMMER, { phaseNum: 1, weather: 'Clear' });
  const noon = phaseWindow(SUMMER, { phaseNum: 2, weather: 'Sunny' });
  assert.ok(dawn.depthMin < noon.depthMin, `${dawn.depthMin} should be shallower than ${noon.depthMin}`);
});

test('an overcast midday is treated as lower light than a clear one', () => {
  const clear = phaseWindow(SUMMER, { phaseNum: 2, weather: 'Sunny' });
  const grey = phaseWindow(SUMMER, { phaseNum: 2, weather: 'Overcast' });
  assert.ok(grey.lowLight > clear.lowLight);
  assert.ok(grey.depthMin <= clear.depthMin);
});

test('an overcast midday is still brighter than first light', () => {
  // Saying otherwise would be the invention this file exists to remove.
  const grey = phaseWindow(SUMMER, { phaseNum: 2, weather: 'Overcast' });
  const dawn = phaseWindow(SUMMER, { phaseNum: 1, weather: 'Clear' });
  assert.ok(grey.lowLight < dawn.lowLight, `${grey.lowLight} should be under ${dawn.lowLight}`);
});

test('topwater is carried in low light and dropped in glare', () => {
  assert.equal(phaseWindow(SUMMER, { phaseNum: 1, weather: 'Clear' }).topwaterViable, true);
  assert.equal(phaseWindow(SUMMER, { phaseNum: 2, weather: 'Sunny' }).topwaterViable, false);
  // The overcast case is the one Ryan named specifically.
  assert.equal(phaseWindow(SUMMER, { phaseNum: 2, weather: 'Overcast' }).topwaterViable, true);
});

test('NO SPEED IS ASSERTED — speed is variable', () => {
  // The old table published 1.8 and 2.0 as though they had been measured on those lakes.
  for (const phaseNum of [1, 2, 3]) {
    assert.equal(phaseWindow(SUMMER, { phaseNum }).speed, null);
  }
});

test('the presentations, structure and forage come through from the profile untouched', () => {
  const w = phaseWindow(SUMMER, { phaseNum: 1 });
  assert.deepEqual(w.presentations, ['umbrella rig', 'flutter spoon']);
  assert.deepEqual(w.structure, ['channel ledges', 'creek mouths']);
  assert.deepEqual(w.forage, ['blueback herring']);
  assert.equal(w.holding, 'suspended');
});

test('a season the profile could not fill is null, not a default band', () => {
  assert.equal(phaseWindow(null, { phaseNum: 1 }), null);
  assert.equal(phaseWindow({ preferredDepth: null }, { phaseNum: 1 }), null);
  assert.equal(phaseWindow({ preferredDepth: [22] }, { phaseNum: 1 }), null);
  assert.equal(phaseWindow({ preferredDepth: [22, 12] }, { phaseNum: 1 }), null, 'inverted band');
});

test('a forecast that says nothing about the sky leaves the phase alone', () => {
  assert.equal(cloudFraction(null), null);
  assert.equal(cloudFraction(''), null);
  assert.equal(cloudFraction('Breezy'), null);
  const withNothing = lowLightFactor({ phaseNum: 2, weather: 'Breezy' });
  const bare = lowLightFactor({ phaseNum: 2 });
  assert.equal(withNothing, bare);
});

test('cloud cover as a number is accepted in either scale', () => {
  assert.equal(cloudFraction(90), 0.9);
  assert.equal(cloudFraction(0.9), 0.9);
  assert.equal(cloudFraction(0), 0);
});

test('a one-foot band does not collapse to a zero-width window', () => {
  const w = phaseWindow({ preferredDepth: [8, 9] }, { phaseNum: 1 });
  assert.ok(w.depthMax > w.depthMin || w.depthMax === w.depthMin);
  assert.ok(w.depthMin >= 8 && w.depthMax <= 9);
});
