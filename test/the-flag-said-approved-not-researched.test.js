/**
 * test/the-flag-said-approved-not-researched.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * DRAFT/VERIFIED IS RETIRED. 2026-09-23, and it had been due since 2026-09-04 -- Ryan then:
 * *"once we remove the research tab and make it more of a smartplan prompt viewer then there
 * won't be a way to verify them or mark them verified"*, and again today: *"that whole verify
 * and draft thing is dumb... i never looked at them anyways."*
 *
 * WHAT THE FLAG ACTUALLY MEASURED, off the 78-profile mirror on the day it went:
 *
 *     61 verified -- every one created in July, every one carrying a real verifiedAt
 *     17 draft    -- every one created 2026-08-23 or later, NOT ONE with a verifiedAt, ever
 *
 * So `verified` meant one thing: somebody clicked Approve in the research tab before he stopped
 * using it. It was not about the profile. 54 of the 61 verified profiles held ZERO extracted
 * facts, while the profile with the most facts on the drive -- congaree_river, 62 -- was a draft.
 *
 * AND IT WAS A GATE, NOT A LABEL. `lake-intel.js` read
 *
 *     d.hasResearchedProfile && d.researched?.status === 'verified' ? d.researched.fullProfile : null
 *
 * and printed "No curated lake profile is available yet" for the other half. Sixteen lakes
 * researched after August were being told their own research did not exist.
 *
 *   node --test test/the-flag-said-approved-not-researched.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const SURFACES = [
  ['js/modules/lake-intel.js', '../js/modules/lake-intel.js'],
  ['js/modules/lake-research-ui.js', '../js/modules/lake-research-ui.js'],
  ['js/modules/lake-research-engine.js', '../js/modules/lake-research-engine.js'],
  ['Worker/research/storage.js', '../Worker/research/storage.js'],
  ['Scripts/which_profile_serves.mjs', '../Scripts/which_profile_serves.mjs'],
];

test('no surface still branches on the retired flag', () => {
  for (const [name, rel] of SURFACES) {
    const src = read(rel);
    // A COMMENT EXPLAINING THE RETIREMENT IS NOT A BRANCH. Strip comment-only lines first --
    // this file would otherwise fail on the very notes that record why the flag went.
    const code = src.split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    for (const pat of [/status\s*===\s*['"]verified['"]/, /status\s*===\s*['"]draft['"]/,
                       /metadata\??\.?\.?verified/]) {
      assert.ok(!pat.test(code), `${name} still branches on ${pat}`);
    }
  }
});

test('lake-intel uses a profile because it exists, not because it was approved', () => {
  const src = read('../js/modules/lake-intel.js');
  assert.match(src, /const rp = d\.hasResearchedProfile \? \(d\.researched\?\.fullProfile \|\| null\) : null;/,
    'the status gate is back on the lake-intel profile read');
});

test('lake-intel says what is behind the biology instead', () => {
  // The replacement is derived on every save and needs no button -- confidence.biology.reason,
  // "14 official, 12 secondary, 26 total". Present on all 78 mirrored profiles, measured
  // 2026-09-23. That is the question the flag was pretending to answer.
  const src = read('../js/modules/lake-intel.js');
  assert.match(src, /rp\.confidence\?\.biology\?\.reason/,
    'lake-intel dropped the flag and put nothing in its place');
});

test('the save writes none of the four retired keys', () => {
  const src = read('../Worker/research/storage.js');
  for (const key of ['status', 'verified', 'verifiedAt', 'approvedBy']) {
    assert.ok(!new RegExp(`^\\\\s{6}${key}:`, 'm').test(src),
      `handleResearchSave still writes metadata.${key}`);
  }
});

test('the batch asserts nothing about a status either', () => {
  // A BATCH MAY NOT ASSERT A FIELD IT DID NOT COMPUTE -- 00_START_HERE, 2026-09-04, after
  // research_lakes.py reset 46 verifications by defaulting the field on a document it rebuilt
  // fresh each run. The rule stands; there is simply nothing left for it to apply to here.
  const src = read('../Scripts/research_lakes.py');
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/["']status["']/.test(code), 'research_lakes.py still sends a status');
});

test('nothing in the tree still calls /research/approve', () => {
  for (const [name, rel] of SURFACES) {
    assert.ok(!read(rel).includes('/research/approve'), `${name} still calls the retired route`);
  }
  assert.ok(!read('../Worker/trollmap-worker.js').includes('/research/approve'),
    'the worker still routes /research/approve');
});

test('the scripts that existed only to repair the flag are gone', () => {
  for (const f of ['../Scripts/restore_verified_stamps.py',
                   '../Scripts/test_restore_verified_stamps.py',
                   './research-approve-resolves.test.js']) {
    assert.ok(!existsSync(new URL(f, import.meta.url)),
      `${f} survived the retirement of the thing it repaired`);
  }
});

test('the research tab offers no way to set it', () => {
  const html = read('../index.html');
  assert.ok(!html.includes('btnApprove'), 'the Approve / Verify button is still in index.html');
  const ui = read('../js/modules/lake-research-ui.js');
  assert.ok(!ui.includes('btnApprove'), 'the Approve handler is still wired');
  assert.ok(!/All statuses/.test(ui), 'the status filter is still in the lake status modal');
});

test('prune_shadowed decides on counts, which is what the flag stood in for', () => {
  const src = read('../Scripts/prune_shadowed_profiles.py');
  assert.match(src, /COUNTS = \("sources", "species", "facts"\)/,
    'the prune rule lost its counts');
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/get\("status"\)/.test(code), 'prune_shadowed still reads a status');
});
