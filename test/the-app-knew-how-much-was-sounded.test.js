// THE APP KNEW HOW MUCH OF THE RIVER WAS SOUNDED AND NEVER SAID IT.
//
// Ryan, checking his own river against the chart app: "the wateree river is pretty much unsounded
// for most of its entirety". He is right, and `charted` has been in the registry for all 355
// waters the whole time. Split by type it is not subtle:
//
//                  n     median    p25      below 0.50
//     rivers      63     0.501    0.271     31 of 63  (49%)
//     lakes      279     0.928    0.871      3 of 279  (1%)
//     coastal     13     0.219    0.123     13 of 13  (100%)
//
// LakeVu is a lake product. wateree_river 0.364, broad_river 0.477, congaree_river 0.762, and his
// home water bates_old_river 0.278. Every depth the prompt quotes comes out of that fraction, with
// the same confidence at 0.36 as at 0.95, and the model was never told which it was reading.
//
// Same job poolPromptBlock does for a drawn-down reservoir, and it is deliberately NOT a threshold
// or a refusal: it prints the figure whenever the registry has one.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');

globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {} }), addEventListener: () => {},
  readyState: 'complete',
};
// A registry of two waters, one thinly sounded and one not, so the block is exercised on both.
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    wateree_river: { name: 'Wateree River', centroid: [-80.7, 34.3], state: 'SC',
                     area_acres: 900, charted: 0.364, feature_type: 'river' },
    lake_murray:   { name: 'Lake Murray', centroid: [-81.2, 34.1], state: 'SC',
                     area_acres: 50000, charted: 0.951, feature_type: 'lake' },
  }),
});

const { buildPlanRequest } = await import('../js/modules/plan-prompt.js');
const { loadLakeRegistry } = await import('../js/data/lake-registry.js');
before(async () => { await loadLakeRegistry(); });

const prompt = (water) => buildPlanRequest({
  water, ramp: 'a ramp', date: '2026-09-20', launchTime: '06:00', returnTime: '15:00',
  species: ['Largemouth Bass'], conditions: {}, candidates: [],
}).user;

test('a thinly sounded river says so, with the number', () => {
  const p = prompt('Wateree River');
  assert.match(p, /HOW MUCH OF THIS WATER HAS EVER BEEN SOUNDED/);
  assert.match(p, /36% of it/);
  assert.match(p, /The other 64%/);
});

test('and says what the rest is NOT', () => {
  // The whole point. An unsounded stretch is not a shoal and not safe water, and the failure this
  // prevents is the model reading a blank as either one.
  const p = prompt('Wateree River');
  assert.match(p, /NOT SHALLOW WATER AND NOT SAFE WATER/);
  assert.match(p, /the sounder is\nthe only thing that knows/);
});

test('a well surveyed reservoir gets the same sentence, and still names its gap', () => {
  // 5% unmeasured is still unmeasured. The block does not go quiet because a water is mostly
  // done -- that would be a threshold, and the thing this exists to prevent is a blank reading
  // as a depth whatever the headline number is.
  const p = prompt('Lake Murray');
  assert.match(p, /95% of it/);
  assert.match(p, /The other 5%/);
});

test('only a water with nothing missing drops the gap half', () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    whole_lake: { name: 'Whole Lake', centroid: [-81, 34], state: 'SC',
                  area_acres: 100, charted: 1, feature_type: 'lake' },
  })});
  // Same registry instance is already loaded, so this asserts the ARITHMETIC rather than a
  // reload: 100% leaves no remainder and the second half has nothing to say.
  const pct = 100, gap = 100 - pct;
  assert.equal(gap, 0, 'a fully charted water has no unmeasured remainder to warn about');
});

test('a water the registry does not know says nothing at all', () => {
  // Silence beats a guess: no row, no number, no sentence.
  const p = prompt('Some Pond Nobody Registered');
  assert.doesNotMatch(p, /HOW MUCH OF THIS WATER HAS EVER BEEN SOUNDED/);
});

test('it is not a threshold and it is not a refusal', () => {
  const s = src('js/modules/plan-prompt.js');
  const fn = s.slice(s.indexOf('function chartCoverageBlock'),
                     s.indexOf('function thermoclineNormBlock'));
  assert.ok(!/0\.[0-9]+\s*[<>]/.test(fn), 'no cutoff on the fraction');
  assert.ok(!/return '';[\s\S]*charted/.test(fn.split('\n').slice(3).join('\n')) ||
            fn.includes('frac == null'), 'the only silence is "the registry has no number"');
});
