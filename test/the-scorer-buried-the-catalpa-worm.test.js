/**
 * The pre-fetch scorer gave a fishing magazine nothing and took nine points off a video.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Measured on the Congaree, 2026-09-16, from the per-result log. Seventeen candidates found, ten
 * kept by SOURCE_CAP sorted on this score:
 *
 *     12  An Assessment of Fisheries Species to Inform Time-of-Year ...
 *     10  SCDES Now Accepting Grant Applications for Watershed Projects
 *     10  Appendix Z: Environmental Clearances - Savannah District
 *     10  Appendix 10 Endangered Species Act - Biological Opinion
 *      7  AN OLD-SCHOOL BAIT IS BACK IN THE LIMELIGHT        <- the catalpa worm piece
 *      7  15 Best Catfish Fishing Lakes and Rivers in South Carolina
 *
 * Four tied at 7 for one remaining slot. The two that say how to fish lost to a Corps environmental
 * appendix and a grant announcement. A .gov host was worth +3 and the word "assessment" +2; a
 * fishing magazine earned nothing at all, and ANGLING_PRESS_DOMAINS sat three hundred lines above
 * this function unread.
 *
 * And a separate -5 for facebook/youtube/instagram survived the removal of the identical ban in
 * offLakePattern -- the same judgment in a second place, which would have buried the Congaree
 * striper-run video: +5 for the title, +4 for the description, minus nine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreCandidateRelevance as score, ANGLING_PRESS_DOMAINS }
  from '../Worker/research/discover.js';

const NAME = 'Congaree River (to SC-601) (Richland Co, SC)';
const BASE = 'Congaree River';
const S = (candidate, agentKey) => score(candidate, NAME, BASE, [], 'SC', agentKey);

test('the catalpa-worm article now outscores the environmental appendix', () => {
  const catalpa = S({
    title: 'AN OLD-SCHOOL BAIT IS BACK IN THE LIMELIGHT',
    url: 'https://www.carolinasportsman.com/content/an-old-school-bait/',
    snippet: 'Catalpa worms on the Congaree River are hard to beat for catfish.',
  }, 'fisheries');
  const appendix = S({
    title: 'Appendix Z: Environmental Clearances - Savannah District',
    url: 'https://www.sas.usace.army.mil/appendix-z.pdf',
    snippet: 'Congaree River reach, environmental assessment and clearances.',
  }, 'fisheries');
  assert.ok(catalpa > appendix,
    `catalpa ${catalpa} still does not beat the appendix ${appendix}`);
});

test('the press bonus is fisheries only -- limnology still prefers the agency study', () => {
  const press = { title: 'Congaree River catfish', url: 'https://www.carolinasportsman.com/a',
                  snippet: 'Congaree River' };
  assert.ok(S(press, 'fisheries') > S(press, 'limnology'),
    'the press bonus leaked outside the fisheries agent');
  const study = { title: 'Congaree River dissolved oxygen assessment',
                  url: 'https://www.usgs.gov/x.pdf', snippet: 'Congaree River study' };
  assert.ok(S(study, 'limnology') > S(press, 'limnology'),
    'limnology stopped preferring an agency study');
});

test('a video that names the water is not penalised for being a video', () => {
  const video = {
    title: 'Non-Stop! Small mouth & Striped bass fishing Congaree River Columbia SC.',
    url: 'https://www.youtube.com/watch?v=X5fd8JYaU2o',
    snippet: 'In the early summer, Striped Bass run up the Santee Cooper lakes and all the way up '
           + 'the Congaree River to Columbia, SC.',
  };
  // Title +5 and snippet +4. The old -5 took most of that back and the cap did the rest.
  assert.ok(S(video, 'fisheries') >= 9,
    `a named video scores ${S(video, 'fisheries')}; the platform penalty is back`);
});

test('a video about nothing in particular still scores nothing', () => {
  assert.ok(S({ title: 'Bluegill Gets DEVOURED!!!', url: 'https://www.youtube.com/watch?v=z',
                snippet: '' }, 'fisheries') < 2,
    'removing the platform penalty let unrelated video through the threshold');
});

test('a seed still short-circuits everything', () => {
  assert.equal(S({ priority: 1, title: 'x', url: 'https://example.com', snippet: '' },
                 'fisheries'), 999);
});

test('another state still costs five', () => {
  const here = { title: 'Congaree River catfish', url: 'https://example.com/a', snippet: '' };
  const there = { title: 'Congaree River catfish in florida', url: 'https://example.com/a',
                  snippet: '' };
  assert.equal(S(here, 'fisheries') - S(there, 'fisheries'), 5);
});

test('an unparseable url does not throw and earns no press bonus', () => {
  assert.doesNotThrow(() => S({ title: 'Congaree River', url: 'not a url', snippet: '' },
                              'fisheries'));
});

test('the bonus matches on the host, not anywhere in the string', () => {
  const spoof = { title: 'Congaree River', snippet: '',
                  url: 'https://example.com/?ref=carolinasportsman.com' };
  const real = { title: 'Congaree River', snippet: '',
                 url: 'https://carolinasportsman.com/a' };
  assert.ok(S(real, 'fisheries') > S(spoof, 'fisheries'),
    'a domain in the query string earned the press bonus');
});

test('www is stripped, so the real article host matches the list', () => {
  const bare = { title: 'Congaree River', snippet: '', url: 'https://carolinasportsman.com/a' };
  const www = { title: 'Congaree River', snippet: '', url: 'https://www.carolinasportsman.com/a' };
  assert.equal(S(bare, 'fisheries'), S(www, 'fisheries'));
  assert.ok(ANGLING_PRESS_DOMAINS.includes('carolinasportsman.com'));
});
