import { describe, it, expect } from './expect-shim.mjs';
import { getSeason, calendarSeason, seasonNote, SUMMER_WATER_F } from '../js/data/species-intel.js';
import { readFileSync } from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS TEST EXISTS
//
// Ryan built a Wateree striper day dated 2026-09-01 and asked: "how do you fish 19-25ft suspended
// in 19-25ft of water?" Chasing that back through the plan reached the season.
//
// getSeason() keyed on the month: 6-8 summer, 9-11 fall. So the plan read the FALL entry of the
// research profile, and his striped bass band moved from `15-40 ft suspended` — sourced to a quote
// that measures FISH ("the depths fish are marked range from 15-40 feet, but the fish are often
// suspended") — to `19-25 ft suspended`, sourced to a quote that measures the FLAT ("lower lake
// flats which he knows hold fish in 19-22 feet of water"). One day on the calendar, nothing
// different in the lake.
//
// "why are we looking at fall... fall doesn't start until sep 22... so sep 1 is wrong no matter
// what." Correct, so the boundaries are astronomical now.
//
// "surface water temp today was 85 degrees... does that sound like fall to you?" It does not. So
// the water gets a say — above SUMMER_WATER_F it is summer whatever the month is. That number is
// his and he flagged it himself: "its a guess".
//
// AND THE APP ALREADY HAD THE TEMPERATURE. depthBandFor(species, lake, season, waterTempF,
// researched) takes it and returns the researched band before ever reading it, so the better a
// lake's data the more certainly its season came off a calendar.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const d = (iso) => new Date(`${iso}T12:00:00`);

describe('the calendar, on the boundaries that exist', () => {
  it('September 1st is summer, which is the day that started this', () => {
    expect(calendarSeason(d('2026-09-01'))).toBe('summer');
    expect(getSeason(d('2026-09-01'))).toBe('summer');
    // And it no longer changes under him between one day and the next.
    expect(getSeason(d('2026-08-31'))).toBe(getSeason(d('2026-09-01')));
  });

  it('turns over on the equinoxes and solstices, not the first of the month', () => {
    expect(calendarSeason(d('2026-09-21'))).toBe('summer');
    expect(calendarSeason(d('2026-09-22'))).toBe('fall');
    expect(calendarSeason(d('2026-06-20'))).toBe('spring');
    expect(calendarSeason(d('2026-06-21'))).toBe('summer');
    expect(calendarSeason(d('2026-12-20'))).toBe('fall');
    expect(calendarSeason(d('2026-12-21'))).toBe('winter');
    expect(calendarSeason(d('2026-03-19'))).toBe('winter');
    expect(calendarSeason(d('2026-03-20'))).toBe('spring');
  });
});

describe('the water outranks the calendar', () => {
  it('85 degrees in October is still summer', () => {
    expect(calendarSeason(d('2026-10-15'))).toBe('fall');
    expect(getSeason(d('2026-10-15'), 85)).toBe('summer');
  });

  it('cold water leaves the calendar alone — there is no lower bound and none was guessed', () => {
    expect(getSeason(d('2026-10-15'), 68)).toBe('fall');
    expect(getSeason(d('2026-01-10'), 45)).toBe('winter');
  });

  it('an absent temperature is the common case and changes nothing', () => {
    for (const t of [null, undefined, '', NaN, 'warm']) {
      expect(getSeason(d('2026-10-15'), t)).toBe('fall');
    }
  });

  it('is one named number, so changing his mind costs one edit', () => {
    expect(SUMMER_WATER_F).toBe(75);
    expect(getSeason(d('2026-10-15'), SUMMER_WATER_F)).toBe('fall');
    expect(getSeason(d('2026-10-15'), SUMMER_WATER_F + 1)).toBe('summer');
  });
});

describe('an override that happens silently is the same as no override', () => {
  it('says which way it went and that the number is a working one', () => {
    const note = seasonNote(d('2026-10-15'), 85);
    expect(note).toMatch(/the calendar says fall/);
    expect(note).toMatch(/85°F/);
    expect(note).toMatch(/planned as summer/);
    expect(note).toMatch(/working number, not a measurement/);
  });

  it('says nothing when there was nothing to overrule', () => {
    expect(seasonNote(d('2026-07-04'), 85)).toBe('');   // already summer
    expect(seasonNote(d('2026-10-15'), 68)).toBe('');   // temperature did not fire
    expect(seasonNote(d('2026-10-15'), null)).toBe(''); // no temperature at all
  });

  it('reaches the screen on both planners', () => {
    for (const f of ['js/modules/smart-plan-v2-wiring.js', 'js/modules/plan-water-ui.js']) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
      expect(src, `${f} does not import seasonNote`).toContain('seasonNote');
      expect(src, `${f} computes the note and drops it`).toMatch(/if \(sn\) r\.problems/);
    }
  });
});

describe('one implementation of one rule', () => {
  it('the duplicate month-based getSeason is gone from lure-knowledge', () => {
    const lk = readFileSync(new URL('../js/data/lure-knowledge.js', import.meta.url), 'utf8');
    expect(/export function getSeason/.test(lk)).toBe(false);
  });

  it('and both planners ask the live one with the temperature', () => {
    const wiring = readFileSync(new URL('../js/modules/smart-plan-v2-wiring.js', import.meta.url), 'utf8');
    expect(wiring).toMatch(/getSeason\(date, inp\.waterTempF\)/);
    const ui = readFileSync(new URL('../js/modules/plan-water-ui.js', import.meta.url), 'utf8');
    expect(ui).toMatch(/getSeason\(date, inp\.waterTempF\)/);
    // And the tab state carries it across the two halves, the way `dateStr` is carried.
    expect(ui).toMatch(/waterTempF: inp\.waterTempF/);
  });
});
