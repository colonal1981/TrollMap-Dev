// The Corps' conservation pool, evaluated for a date.
//
// FIXTURES ARE REAL. Every level object below was fetched from
// cwms-data.usace.army.mil/cwms-data/levels on 2026-08-16 and is reproduced field for field,
// not invented -- including Thurmond's interval-months of 13 and its missing interpolate
// flag, which are the two things this shaper exists to handle honestly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usaceProjectOf, usacePickProject, usaceSeasonalValue, usaceShape } from '../Worker/conditions.js';

// /levels?office=SAS&level-id-mask=Hartwell.Elev.*&unit=EN
const HARTWELL_TOP = {
  'office-id': 'SAS', 'location-level-id': 'Hartwell.Elev.Inst.0.Top of Conservation',
  'specified-level-id': 'Top of Conservation', 'parameter-id': 'Elev', 'parameter-type-id': 'Inst',
  'interpolate-string': 'T', 'level-units-id': 'ft', 'level-date': '1961-12-31T05:00:00Z',
  'level-comment': 'at Construction', 'duration-id': '0',
  'interval-origin': '1962-01-01T05:00:00Z', 'interval-months': 12,
  'seasonal-values': [
    { value: 656.0, 'offset-months': 0, 'offset-minutes': 0 },
    { value: 660.0, 'offset-months': 3, 'offset-minutes': 0 },
    { value: 660.0, 'offset-months': 9, 'offset-minutes': 20160 },
    { value: 656.0, 'offset-months': 11, 'offset-minutes': 20160 },
    { value: 656.0, 'offset-months': 12, 'offset-minutes': 0 },
  ],
};
const HARTWELL_BOTTOM = {
  'office-id': 'SAS', 'location-level-id': 'Hartwell.Elev.Inst.0.Bottom of Conservation',
  'specified-level-id': 'Bottom of Conservation', 'interpolate-string': 'T', 'level-units-id': 'ft',
  'level-date': '1962-04-01T05:00:00Z', 'duration-id': '0',
  'interval-origin': '1962-04-01T05:00:00Z', 'interval-months': 12,
  'seasonal-values': [
    { value: 624.9999999999999, 'offset-months': 0, 'offset-minutes': 0 },
    { value: 624.9999999999999, 'offset-months': 12, 'offset-minutes': 0 },
  ],
};
const HARTWELL_DROUGHT1 = {
  'office-id': 'SAS', 'location-level-id': 'Hartwell.Elev.Inst.0.Drought Level 1',
  'specified-level-id': 'Drought Level 1', 'interpolate-string': 'T', 'level-units-id': 'ft',
  'level-date': '2024-12-12T19:00:00Z',
  'level-comment': 'Drought Level 1.  Reduction at Thurmond to 4200 cfs', 'duration-id': '0',
  'interval-origin': '2024-01-01T05:00:00Z', 'interval-months': 12,
  'seasonal-values': [
    { value: 654.0, 'offset-months': 0, 'offset-minutes': 0 },
    { value: 656.0, 'offset-months': 3, 'offset-minutes': 20160 },
    { value: 656.0, 'offset-months': 9, 'offset-minutes': 20160 },
    { value: 654.0, 'offset-months': 11, 'offset-minutes': 20160 },
  ],
};
// Thurmond: interval-months 13, and NO interpolate-string at all.
const THURMOND_TOP = {
  'office-id': 'SAS', 'location-level-id': 'Thurmond.Elev.Inst.0.Top of Conservation',
  'specified-level-id': 'Top of Conservation', 'level-units-id': 'ft',
  'level-date': '1962-01-01T05:00:00Z', 'level-comment': 'Construction', 'duration-id': '0',
  'interval-origin': '1953-01-01T05:00:00Z', 'interval-months': 13,
  'seasonal-values': [
    { value: 326.0, 'offset-months': 0, 'offset-minutes': 0 },
    { value: 330.0, 'offset-months': 3, 'offset-minutes': 0 },
    { value: 330.0, 'offset-months': 9, 'offset-minutes': 20160 },
    { value: 326.0, 'offset-months': 11, 'offset-minutes': 20160 },
    { value: 326.0, 'offset-months': 12, 'offset-minutes': 0 },
  ],
};

// The real Savannah-district roster, 2026-08-16. Four locations, out of everything the district
// publishes — which is exactly why the project is picked from this and not from a name rule.
const SAS_ROSTER = new Set(['Hartwell', 'NSBLD', 'Russell', 'Thurmond']);

// The real candidate lists water_bindings.json carries for these two lakes.
const HARTWELL_CANDIDATES = ['02187010', 'HDam', 'HartwellPowerhouse', 'Hartwell-Powerhouse', 'Hartwell', 'Hartwell-Unit1']
  .map((n) => ({ office: 'SAS', cwms_name: n }));
const THURMOND_CANDIDATES = ['Thurmond_Basin', 'Thurmond-O2System-Line3', 'Thurmond', 'Thurmond-Line1', 'Thurmond-Powerhouse', 'Thurmond-Powerhouse-Unit1']
  .map((n) => ({ office: 'SAS', cwms_name: n }));

const AUG16 = Date.parse('2026-08-16T12:00:00Z');

test('the project is taken, not the turbine', () => {
  assert.equal(usacePickProject(HARTWELL_CANDIDATES, SAS_ROSTER), 'Hartwell');
  assert.equal(usacePickProject(THURMOND_CANDIDATES, SAS_ROSTER), 'Thurmond');
});

test('a lake the district publishes no conservation pool for returns null', () => {
  // lake_jocassee's binding offers Keowee and Jocassee. Neither is on the SAS roster, and
  // inventing one would put a neighbouring project's pool on the lake.
  const jocassee = ['Keowee', 'Jocassee'].map((n) => ({ office: 'SAS', cwms_name: n }));
  assert.equal(usacePickProject(jocassee, SAS_ROSTER), null);
  // and a bare USGS site number is never a project
  assert.equal(usacePickProject([{ office: 'SAS', cwms_name: '02187010' }], new Set(['02187010'])), null);
});

test('the project segment is read off the dotted id', () => {
  assert.equal(usaceProjectOf('Hartwell.Elev.Inst.0.Top of Conservation'), 'Hartwell');
  assert.equal(usaceProjectOf('Thurmond.Elev.Inst.0BOP.Bottom of Conservation'), 'Thurmond');
  assert.equal(usaceProjectOf(''), null);
});

test('mid-August reads summer pool, and it is the number that was hand-typed', () => {
  const v = usaceSeasonalValue(HARTWELL_TOP, AUG16);
  assert.equal(v.value, 660);          // worker-data.js carried 660 by hand
  assert.equal(v.seasonal, true);
  assert.equal(v.interpolated, false); // both bracketing set points are 660
});

test('winter is a different number on the same lake, which is why a constant would be wrong', () => {
  // 1 January and 20 December both sit on published 656 set points.
  assert.equal(usaceSeasonalValue(HARTWELL_TOP, Date.parse('2026-01-01T05:00:00Z')).value, 656);
  assert.equal(usaceSeasonalValue(HARTWELL_TOP, Date.parse('2026-12-20T12:00:00Z')).value, 656);
  // Mid-January is already on the spring refill ramp -- USACE runs 656 to 660 from 1 Jan to
  // 1 Apr, so "winter pool is 656" is only true on the day, not for the season.
  const jan15 = usaceSeasonalValue(HARTWELL_TOP, Date.parse('2026-01-15T12:00:00Z'));
  assert.equal(jan15.interpolated, true);
  assert.ok(jan15.value > 656 && jan15.value < 657, `expected early refill, got ${jan15.value}`);
});

test('20160 minutes is fourteen days, so the October set point is the 15th', () => {
  // The day before the ramp begins is still 660; a month later it is on the way down.
  const before = usaceSeasonalValue(HARTWELL_TOP, Date.parse('2026-10-14T12:00:00Z'));
  assert.equal(before.value, 660);
  assert.equal(before.next.at.slice(0, 10), '2026-10-15');
});

test('the drawdown ramp is interpolated when USACE says to interpolate, and reported as such', () => {
  const mid = usaceSeasonalValue(HARTWELL_TOP, Date.parse('2026-11-15T00:00:00Z'));
  assert.equal(mid.interpolated, true);
  assert.ok(mid.value < 660 && mid.value > 656, `expected a ramp value, got ${mid.value}`);
  assert.equal(mid.prev.value, 660);
  assert.equal(mid.next.value, 656);
});

test('with no interpolate flag the previous set point is HELD, and the answer says so', () => {
  const mid = usaceSeasonalValue(THURMOND_TOP, Date.parse('2026-11-15T00:00:00Z'));
  assert.equal(mid.interpolated, false);
  assert.equal(mid.value, 330);        // held from October 15, not invented between 330 and 326
  assert.ok(/no interpolate flag/.test(mid.caution));
});

test("Thurmond's 13-month interval is evaluated annually and the anomaly travels with it", () => {
  const v = usaceSeasonalValue(THURMOND_TOP, AUG16);
  assert.equal(v.value, 330);          // summer pool, every year, as published
  assert.ok(/interval-months 13/.test(v.caution));
});

test('a level whose seasonal values do not wrap still brackets at year end', () => {
  // Drought Level 1 has no offset-months 12 entry. Without the previous cycle there would be
  // no lower bracket in January and the level would evaluate to null.
  const jan = usaceSeasonalValue(HARTWELL_DROUGHT1, Date.parse('2026-01-05T12:00:00Z'));
  assert.ok(jan, 'no bracket found at the start of the year');
  assert.equal(jan.prev.value, 654);
  assert.ok(jan.value >= 654 && jan.value < 655, `expected the January bracket, got ${jan.value}`);
});

test('the whole project, shaped', () => {
  const shaped = usaceShape([HARTWELL_TOP, HARTWELL_BOTTOM, HARTWELL_DROUGHT1, THURMOND_TOP], 'Hartwell', AUG16);
  assert.equal(shaped.project, 'Hartwell');
  assert.equal(shaped.office, 'SAS');
  assert.equal(shaped.conservation_pool_ft, 660);
  assert.equal(shaped.bottom_of_conservation_ft, 625);   // 624.9999999999999, rounded
  assert.equal(shaped.drought_levels.length, 1);
  assert.equal(shaped.drought_levels[0].ft, 656);
  // The operational consequence is published on the level and is carried through verbatim.
  assert.equal(shaped.drought_levels[0].comment, 'Drought Level 1. Reduction at Thurmond to 4200 cfs');
  // Thurmond's level was in the same array and must not leak into Hartwell.
  assert.ok(!shaped.levels_published.includes(undefined));
  assert.equal(shaped.levels_published.length, 3);
});

test('shaping a project with nothing published returns null, not an empty shell', () => {
  assert.equal(usaceShape([HARTWELL_TOP], 'Russell', AUG16), null);
  assert.equal(usaceShape([], 'Hartwell', AUG16), null);
});
