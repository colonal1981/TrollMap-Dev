/**
 * test/winter-was-the-answer-to-every-bad-date.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-09-05, reading the research tab's prompt viewer:
 * *"can you tell me why i am reading about winter in september?"*
 *
 * `getSeason()` with no arguments returned winter on EVERY day of the year. `new Date(undefined)`
 * is an Invalid Date; `getMonth()` on it is NaN; `md` is NaN; every comparison against NaN is
 * false; all three ranges fall through to the bare `return 'winter'` at the bottom.
 *
 * lake-research-ui.js called it exactly that way, so the viewer whose whole job is showing what
 * Smart Plan receives was showing the winter bands in September -- 10-30 ft and "winter patterns
 * push fish deeper into main lake basin" for Striped Bass, on a lake at 86°F.
 *
 *   node --test test/winter-was-the-answer-to-every-bad-date.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSeason, calendarSeason, seasonNote } from '../js/data/species-intel.js';

const at = (iso) => new Date(`${iso}T12:00:00`);

test('the calendar boundaries still hold', () => {
  assert.equal(calendarSeason(at('2026-01-15')), 'winter');
  assert.equal(calendarSeason(at('2026-03-20')), 'spring');
  assert.equal(calendarSeason(at('2026-06-20')), 'spring');
  assert.equal(calendarSeason(at('2026-06-21')), 'summer');
  assert.equal(calendarSeason(at('2026-09-21')), 'summer');
  assert.equal(calendarSeason(at('2026-09-22')), 'fall');
  assert.equal(calendarSeason(at('2026-12-20')), 'fall');
  assert.equal(calendarSeason(at('2026-12-21')), 'winter');
});

// THE BUG, ASSERTED FROM BOTH ENDS.
test('September is not winter, and no-argument means today', () => {
  assert.equal(calendarSeason(at('2026-09-05')), 'summer', 'the day he was looking at');
  const today = calendarSeason(new Date());
  assert.equal(getSeason(), today, 'no date asked means today, not winter');
  assert.equal(calendarSeason(), today);
  assert.equal(calendarSeason(''), today, 'an empty date field is no date, not a bad one');
  assert.equal(calendarSeason(null), today);
});

// A DATE THAT WAS SUPPLIED AND CANNOT BE READ IS A BUG, AND A SILENT WINTER IS HOW IT HID.
test('an unreadable date throws instead of becoming winter', () => {
  for (const bad of ['not a date', 'T12:00:00', '2026-13-45', NaN]) {
    assert.throws(() => calendarSeason(bad), /cannot read a date/, `${JSON.stringify(bad)}`);
  }
  assert.throws(() => getSeason('not a date'), /cannot read a date/);
});

// The date must reach calendarSeason() UNTOUCHED. getSeason() used to do `new Date(date)` itself
// and pass the result on, so "no date given" arrived as an Invalid Date object -- indistinguishable
// from "a date I could not read", and both became winter.
test('getSeason does not convert the date before handing it over', () => {
  assert.equal(getSeason(undefined), calendarSeason(new Date()));
  assert.doesNotThrow(() => getSeason(undefined));
});

// The water still overrules the calendar, and still says so out loud.
test('warm water beats the calendar even with no date at all', () => {
  assert.equal(getSeason(at('2026-11-15'), 86), 'summer');
  assert.equal(getSeason(undefined, 86), 'summer', 'and does not need a date to do it');
  assert.match(seasonNote(at('2026-11-15'), 86), /the calendar says fall, but the water is 86/);
  assert.equal(seasonNote(at('2026-07-15'), 86), '', 'nothing to say when it agrees');
});
