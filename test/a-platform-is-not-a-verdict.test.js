/**
 * A video is judged on whether it names the water, not on being a video.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * discover.js banned facebook, youtube, instagram, tiktok, x, pinterest and fourteen fishing forums
 * by domain, on two stated grounds. Both were wrong.
 *
 * "never fetchable" / "TinyFish can't fetch them anyway" -- measured false 2026-09-16: tinyfishFetch
 * on the Congaree striper video returned its title, view count, date and full description in 29
 * seconds, free, and the description holds the best seasonal fact this pipeline has for that river.
 *
 * "usable content rate is near zero" -- Ryan, who fishes these waters: "guides post on all of those
 * with actual information... there are no 'official' sources on how to fish."
 *
 * The junk was real, but it came from a query that had drifted off the river. Every junk result
 * fails the name test and the striper video passes it, so the name is the verdict now.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultNamesWater, ANGLING_PRESS_DOMAINS, TOURISM_DOMAINS, SEARCH_EXCLUDE_DOMAINS }
  from '../Worker/research/discover.js';

const BASE = 'congaree river';

// Verbatim from the 2026-09-16 per-result log and from Ryan's hand search.
const SURVIVES = [
  ['Non-Stop! Small mouth & Striped bass fishing Congaree River Columbia SC.',
   'https://www.youtube.com/watch?v=X5fd8JYaU2o', ''],
  ['HOW TO: Fishing Columbia\'s Rivers', 'https://www.youtube.com/watch?v=abc',
   'In the early summer, Striped Bass run up the Santee Cooper lakes and all the way up the '
   + 'Congaree river to Columbia, SC.'],
];

const REJECTED = [
  ['Bluegill Gets DEVOURED!!!', 'https://www.youtube.com/watch?v=zzz', ''],
  ['Crispy Bluegill Tacos on the Weber Slate with Kevin VanDam',
   'https://www.youtube.com/watch?v=yyy', ''],
  ['New scientific term: #bluegill', 'https://www.instagram.com/p/xyz/', ''],
  ['Mr. Bluegill Outdoors - Troy Peterson (@walleyeguide)',
   'https://www.facebook.com/walleyeguide', ''],
  ['The Ultimate Bluegill Catch and Cook Adventure', 'https://www.tiktok.com/@x/video/1', ''],
  ['Satin seam puckering ruins all my hard work : r/sewhelp',
   'https://www.reddit.com/r/sewhelp/comments/1', ''],
  ['Who Would I Be Mailing This Poor Bluegill To?',
   'https://www.reddit.com/r/fishing/comments/2', ''],
];

test('the striper video and the guide\'s post name the water and survive', () => {
  for (const [title, url, snippet] of SURVIVES) {
    assert.equal(resultNamesWater(title, url, snippet, BASE), true,
      `should have survived: ${title}`);
  }
});

test('every piece of junk from that run fails the name test', () => {
  for (const [title, url, snippet] of REJECTED) {
    assert.equal(resultNamesWater(title, url, snippet, BASE), false,
      `should have been rejected: ${title}`);
  }
});

test('a known miss, recorded rather than smoothed over', () => {
  // A real Facebook group post from Ryan's hand search: "What fish to target in Congaree National
  // Park, South ...". It is about fishing this water and the rule rejects it, because the water is
  // named "Congaree River" and the page says "Congaree National Park".
  //
  // Not fixed by matching on "congaree" alone, which is the obvious loosening and the wrong one:
  // that token belongs to the national park, to the Congaree people, and to a Smithsonian
  // ethnography PDF that already 403'd its way into one run. The strict phrase is what keeps those
  // out. This post is the price of that, and it is the cheaper side of the trade.
  assert.equal(
    resultNamesWater('What fish to target in Congaree National Park, South ...',
                     'https://www.facebook.com/groups/65970536072/posts/10158185587796073/', '',
                     BASE),
    false, 'if this now passes, check that "congaree" alone did not become the test');
});

test('the snippet counts, because a guide often names the water only there', () => {
  assert.equal(resultNamesWater('Big cats on the river', 'https://example.com/a', '', BASE), false);
  assert.equal(
    resultNamesWater('Big cats on the river', 'https://example.com/a',
                     'Fishing the Congaree River below the shoals', BASE), true);
});

test('the url counts too', () => {
  assert.equal(
    resultNamesWater('Untitled', 'https://www.sctrails.net/trails/trail/congaree-river-blue', '',
                     BASE), false,
    'a hyphenated slug is not the spaced name and must not be claimed as one');
  assert.equal(resultNamesWater('Untitled', 'https://example.com/congaree river guide', '', BASE),
    true);
});

test('no base name means no name test, so nothing is waved through on an empty string', () => {
  for (const empty of ['', null, undefined]) {
    assert.equal(resultNamesWater('Bluegill Gets DEVOURED!!!', 'https://youtube.com/x', '', empty),
      false, 'an empty base name let a result through');
  }
});

test('a missing title, url or snippet does not throw', () => {
  assert.equal(resultNamesWater(undefined, undefined, undefined, BASE), false);
  assert.equal(resultNamesWater(null, null, null, BASE), false);
});

test('the case of the page does not matter', () => {
  assert.equal(resultNamesWater('CONGAREE RIVER STRIPERS', 'https://x.com/a', '', BASE), true);
});

test('the exclusion list is empty, and the press list is what we ask for instead', () => {
  assert.deepEqual(SEARCH_EXCLUDE_DOMAINS, [],
    'a domain went back into the exclusion list without a measurement');
  assert.ok(ANGLING_PRESS_DOMAINS.includes('carolinasportsman.com'));
  // Ryan's press-scoped playground run returned ten results, all real fishing writing, from these.
  for (const d of ['gameandfishmag.com', 'columbiametro.com', 'anglersheadquarters.com',
                   'onwaterapp.com']) {
    assert.ok(ANGLING_PRESS_DOMAINS.includes(d), `${d} answered the press query and is not listed`);
  }
});

test('tourism domains are recognised but never requested', () => {
  for (const d of TOURISM_DOMAINS) {
    assert.ok(!ANGLING_PRESS_DOMAINS.includes(d),
      `${d} writes about visiting a water and is in the ask list`);
  }
  assert.ok(TOURISM_DOMAINS.includes('southcarolinaparks.com'));
});

test('both domain lists fit the 1000 characters TinyFish allows across them', () => {
  const press = ANGLING_PRESS_DOMAINS.join(',');
  const exclude = SEARCH_EXCLUDE_DOMAINS.join(',');
  assert.ok(press.length + exclude.length <= 1000,
    `${press.length + exclude.length} characters across both lists`);
});
