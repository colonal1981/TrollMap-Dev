// Personal use only, not for distribution or resale; not for navigation.
//
// THE SUN AND MOON TIMES ARE ON THE PLAN DAY'S CLOCK, AND THE SCRAPED REPORT PAGE IS NOT PRINTED.
//
// Ryan's Moultrie plan for Sunday 11/8, built 11/6: the light block read civil dawn 07:19 and sunrise 07:45 (real:
// 06:18 and 06:44, EST since 11/1). No caller sends the Worker a `tz`, and /conditions defaulted to -4 all year. And
// of the trip report's AHQ card ("Catch of the Week", "AHQ INSIDER ... Exclusive Content"): "this does nothing for me".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleConditions, easternOffsetHours } from '../Worker/conditions.js';

test('Eastern time on a calendar day: daylight time from the second Sunday of March to the first of November', () => {
  assert.equal(easternOffsetHours('2026-11-08'), -5, 'his Sunday on Moultrie');
  assert.equal(easternOffsetHours('2026-11-01'), -5, 'the changeover Sunday is standard time from 2 AM');
  assert.equal(easternOffsetHours('2026-10-31'), -4);
  assert.equal(easternOffsetHours('2026-03-07'), -5);
  assert.equal(easternOffsetHours('2026-03-08'), -4);
  assert.equal(easternOffsetHours('2026-12-25'), -5);
  assert.equal(easternOffsetHours('2027-03-14'), -4);
  assert.equal(easternOffsetHours('2027-11-07'), -5);
  assert.equal(easternOffsetHours('not a date'), -4);
});

const env = { R2_TROLLMAP_CHARTPACKS: { async get() { return null; } } };
async function almanacTz(query) {
  const asked = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    if (u.includes('aa.usno.navy.mil')) {
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({ properties: { data: {
        sundata: [{ phen: 'Begin Civil Twilight', time: '06:18' }, { phen: 'Rise', time: '06:44' }] } } }) };
    }
    return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
  };
  try {
    const url = new URL(`https://x/conditions/lake_moultrie?lat=33.2545&lon=-79.9887&${query}`);
    await handleConditions(new Request(url, { method: 'GET' }), env, url);
  } finally { globalThis.fetch = real; }
  const usno = asked.find((u) => u.includes('aa.usno.navy.mil'));
  return usno && Number(new URL(usno).searchParams.get('tz'));
}

test('no tz sent: the almanac is asked on the date\'s own clock; a tz sent is used as sent', async () => {
  assert.equal(await almanacTz('date=2026-11-08'), -5);
  assert.equal(await almanacTz('date=2026-10-24'), -4);
  assert.equal(await almanacTz('date=2026-11-15&tz=-4'), -4, 'a caller that says -4 gets -4');
  assert.equal(await almanacTz('date=2026-11-22&tz=0'), 0, 'and 0 is a number, not "none"');
});

test("the trip report and the lake briefing no longer print AHQ's page around its reports", () => {
  const pb = readFileSync(new URL('../js/modules/plan-builder.js', import.meta.url), 'utf8');
  assert.doesNotMatch(pb, /\/reports\/\$\{encodeURIComponent\(rec\.slug\)\}/, 'the card asked the Worker\'s /reports');
  assert.doesNotMatch(pb, /📰 Recent Fishing Reports/);
  assert.match(pb, /🎣 What the Guides Reported/, 'the guides\' dated reports stay');
  assert.match(pb, /📚 Years of Reports for This Time of Year/, '"i like this"');
  const li = readFileSync(new URL('../js/modules/lake-intel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(li, /Latest scraped fishing-report intel/);
  assert.doesNotMatch(li, /latestReport/);
});
