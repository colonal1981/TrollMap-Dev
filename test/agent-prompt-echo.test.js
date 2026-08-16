// Agents must not be asked to echo back data they did not produce.
//
// From Ryan's run, 2026-08-16, with the deterministic ramp join finally working:
//
//   ⚠️ Navigation LLM 502: HTTP 502 — Agent returned non-JSON | raw: { "navigation": {
//   "ramps": [ {"name": "Amity RA", ...}, {"name": "Baker Creek State Park", "lat": 33.88
//
// Cut off mid-object. The navigation template interpolated the full ramp array TWICE — once as
// context and again inside the JSON skeleton the model was told to return. That was survivable
// while deterministic ramps came back empty; once the registry's geometry join supplied 116 of
// them they did not fit in max_tokens 3000, the reply truncated, extractJsonPossibly found no
// closing brace, and the agent 502'd twice because the retry sent the identical prompt.
//
// Habitat had the same shape: "structuralElements": ${JSON.stringify(...)} in the skeleton,
// which is where the 402,757-character habitat prompt came from — structuralElements carried
// 3,531 hump coordinates.
//
// The merge in lake-research-engine.js only overwrites keys an agent actually returns, so
// omitting them preserves the deterministic values exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESEARCH_AGENTS } from '../Worker/research/agents.js';

const ramps = (n) => Array.from({ length: n }, (_, i) => ({
  name: `Ramp ${i}`, lat: 33.6 + i / 1000, lon: -82.4 - i / 1000,
  lanes: 3, county: 'Lincoln', owner: 'COE',
}));
const humps = (n) => Array.from({ length: n }, (_, i) => ({
  id: `hump_${i}`, lat: 34 + i / 1e4, lon: -82 - i / 1e4,
  depth: 20, areaAcres: 5, reliefFt: 6, levels: 3,
}));
const skeletonOf = (prompt) => prompt.split('Return ONLY')[1] || '';

test('navigation does not ask for the ramps back', () => {
  const p = RESEARCH_AGENTS.navigation.userTemplate('J. Strom Thurmond Reservoir', 'GA',
    { navigation: { ramps: ramps(116) }, _extractedFacts: [] });
  assert.ok(!/"ramps"/.test(skeletonOf(p)), 'the response skeleton must not contain a ramps key');
  assert.ok(!/"lat":\s*33\.6/.test(p), 'the full ramp array must not be interpolated anywhere');
});

test('navigation still tells the model the ramps exist', () => {
  const p = RESEARCH_AGENTS.navigation.userTemplate('J. Strom Thurmond Reservoir', 'GA',
    { navigation: { ramps: ramps(116) }, _extractedFacts: [] });
  // Context, not payload: a count and a few names so hazards can be written against them.
  assert.match(p, /116 boat ramp/);
  assert.match(p, /Ramp 0/);
  assert.ok(!/Ramp 30\b/.test(p), 'a sample means a sample, not all 116');
});

test('116 ramps no longer blow up the navigation prompt', () => {
  const big = RESEARCH_AGENTS.navigation.userTemplate('X', 'GA', { navigation: { ramps: ramps(116) }, _extractedFacts: [] });
  const none = RESEARCH_AGENTS.navigation.userTemplate('X', 'GA', { navigation: { ramps: [] }, _extractedFacts: [] });
  assert.ok(big.length < 2000, `expected a small prompt, got ${big.length} chars`);
  // It should barely grow with the ramp count — that growth was the whole defect.
  assert.ok(big.length - none.length < 400, `prompt grew ${big.length - none.length} chars for 116 ramps`);
});

test('habitat does not ask for chartpack-derived structure back', () => {
  const p = RESEARCH_AGENTS.habitat.userTemplate('J. Strom Thurmond Reservoir', 'GA',
    { habitat: { structuralElements: { humpCoordinates: humps(3531), humpCount: 3531 } }, _extractedFacts: [] });
  const sk = skeletonOf(p);
  assert.ok(!/"structuralElements"/.test(sk), 'the skeleton must not ask for structuralElements');
  assert.ok(!/"artificialHabitatDetails"/.test(sk), 'nor for artificialHabitatDetails');
});

test('3,531 humps no longer produce a 400,000 character habitat prompt', () => {
  const p = RESEARCH_AGENTS.habitat.userTemplate('X', 'GA',
    { habitat: { structuralElements: { humpCoordinates: humps(3531), humpCount: 3531 } }, _extractedFacts: [] });
  assert.ok(p.length < 12000, `habitat prompt was ${p.length} chars`);
});

test('an agent with no deterministic input still produces a usable prompt', () => {
  const nav = RESEARCH_AGENTS.navigation.userTemplate('Some Lake', 'SC', {});
  assert.match(nav, /Return ONLY/);
  assert.match(nav, /hazards/);
  const hab = RESEARCH_AGENTS.habitat.userTemplate('Some Lake', 'SC', {});
  assert.match(hab, /Return ONLY/);
});
