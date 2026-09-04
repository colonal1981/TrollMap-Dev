// A derivation stored in a profile is a photograph of a chart that has since been replaced.
//
// Ryan, 2026-09-04: "contours can change each time Garmin updates them so anything derived from
// the packs should be ran when a plan is ran... the research refactor docs should cover this".
// They do -- THE_PROFILE_BECAME_A_CACHE_AND_NOBODY_MOVED_THE_READS_2026-09-01.md, item 1. This
// pins the half of that move that is in place: researchIntel() takes the pack-derived block and
// prefers it, field by field, and reads the profile exactly as before when no caller passes one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { researchIntel } from '../js/modules/plan-inputs.js';

const PROFILE = {
  identity: { maxDepthFt: 83, averageDepthFt: 19, bodyType: 'lake' },
  biology: { predatorSpecies: ['Largemouth Bass'] },
  habitat: { structuralElements: { creekMouths: ['Dutchmans', 'Cedar'], points: 12 } },
  limnology: {},
};
const SPECIES = 'Largemouth Bass';
// researchIntel() prefixes every line with '- '.
const line = (out, label) => String(out || '').split('\n').find((l) => l.startsWith(`- ${label}:`)) || '';

test('with no pack, it reads the profile exactly as it always has', () => {
  const out = researchIntel(PROFILE, SPECIES, 'summer');
  assert.match(line(out, 'Max depth'), /83/);
  assert.match(line(out, 'Charted points'), /12/);
});

test('a pack max depth beats the one frozen in the profile', () => {
  // The 83 ft ceiling was a decoder bug for months; every profile written under it says 83.
  const out = researchIntel(PROFILE, SPECIES, 'summer', Date.now(),
    { identity: { maxDepthFt: 110.9 } });
  assert.match(line(out, 'Max depth'), /110\.9/);
  assert.doesNotMatch(line(out, 'Max depth'), /83/);
});

test('a pack that answers one identity field does not delete the others', () => {
  // Field by field, not block by block.
  const out = researchIntel(PROFILE, SPECIES, 'summer', Date.now(),
    { identity: { maxDepthFt: 110.9 } });
  assert.match(line(out, 'Average depth'), /19/);
});

test('pack structure beats stored structure, and stored survives where the pack is silent', () => {
  const out = researchIntel(PROFILE, SPECIES, 'summer', Date.now(),
    { habitat: { structuralElements: { points: 31 } } });
  assert.match(line(out, 'Charted points'), /31/);
  assert.match(line(out, 'Named creek mouths'), /Dutchmans/);
});

test('a pack with no habitat at all does not blank a profile that has one', () => {
  const out = researchIntel(PROFILE, SPECIES, 'summer', Date.now(), { identity: {} });
  assert.match(line(out, 'Charted points'), /12/);
});

test('the species list still comes from the profile, which is not a pack fact', () => {
  const out = researchIntel(PROFILE, SPECIES, 'summer', Date.now(),
    { identity: { maxDepthFt: 110.9 } });
  assert.match(out, /Other predators here/);
});
