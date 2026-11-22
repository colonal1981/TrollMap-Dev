// Personal use only, not for distribution or resale; not for navigation.
//
// HIS FISH IN THESE WEEKS ARE AN AREA, BESIDE THE REPORTS'.
//
// Ryan, 2026-11-22, planning Monday on Wateree from Clearwater, where the reports for these weeks name only Colonel Creek
// and the dam: "how bout if there are catches in an area by me within 3 weeks? can we make that work? so that i dont
// have to click areas... my catch history should build a day maybe idk?". With his 11/6 rule put back to him ("even with
// catches i dont like it... because i am telling the app where to tell me to fish instead of the app telling me"), he
// chose his fish LISTED as an area and the day STARTING on the reports' area: "that last one seems to be the best".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layAreas, runCrankbaits, areasFromCatches, withYourFish, areaCountSaid, startOption, daysApartInYear,
         AREA_R_M, CATCH_WINDOW_DAYS } from '../js/modules/plan-areas.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');

test('the window is the reports\' own: 3 weeks either side of the date, in any year, round the turn of the year', () => {
  assert.equal(CATCH_WINDOW_DAYS, 21);
  assert.equal(daysApartInYear('2026-11-15', '2026-11-23'), 8);
  assert.equal(daysApartInYear('2019-12-14', '2026-11-23'), 21);
  assert.equal(daysApartInYear('2025-12-20', '2026-11-23'), 27);
  assert.equal(daysApartInYear('2026-01-02', '2026-12-20'), 13);
  assert.equal(daysApartInYear('', '2026-11-23'), Infinity);
});

const CLEARWATER = [-80.728814, 34.379271];
const LANDINGS = [{ name: 'Clearwater Cove', at: CLEARWATER }, { name: 'Colonel Creek', at: [-80.797237, 34.368854] }];
const fish = (date, lat, lon) => ({ species: 'Striped Bass', date, lat: String(lat), lon: String(lon) });
const HIS = [fish('2026-11-15', 34.3770, -80.7350), fish('2026-11-15', 34.3720, -80.7400), fish('2026-11-09', 34.3650, -80.7200),
             fish('2025-12-20', 34.3650, -80.7200), fish('2026-02-14', 34.36, -80.71), fish('2026-11-11', 34.47, -80.91)];

test('his fish in these weeks within a day\'s reach are one area, named by the landing nearest it', () => {
  const a = areasFromCatches(HIS, { date: '2026-11-23', ramp: CLEARWATER, reachM: 9000, landings: LANDINGS });
  assert.equal(a.length, 1, JSON.stringify(a));
  assert.equal(a[0].name, 'Your fish by Clearwater Cove');
  assert.equal(a[0].n, 3);
  assert.equal(a[0].trips, 2);
  assert.deepEqual(a[0].dates, ['2026-11-09', '2026-11-15']);
  assert.equal(a[0].mine, true);
  // the 11/11 fish up the lake is out of reach; the December and February ones are out of the window
  assert.equal(areasFromCatches(HIS, { date: '2026-11-23', ramp: CLEARWATER, reachM: 40000, landings: LANDINGS }).length, 2);
  assert.deepEqual(areasFromCatches(HIS, { date: '2026-07-01', ramp: CLEARWATER }), []);
});

test('an area of his on a place the reports name adds its fish to that place, not a second area', () => {
  const mine = areasFromCatches(HIS, { date: '2026-11-23', ramp: CLEARWATER, reachM: 9000, landings: LANDINGS });
  const on = withYourFish([{ at: [-80.73, 34.378], name: 'Clearwater Cove', n: 1 }], mine);
  assert.equal(on.length, 1);
  assert.equal(areaCountSaid(on[0]), '1 report, 3 of your fish');
  const apart = withYourFish([{ at: [-80.797, 34.37], name: 'Colonel Creek', n: 1 }, { at: [-80.703, 34.335], name: 'Wateree Dam', n: 1 }], mine);
  assert.deepEqual(apart.map((p) => p.name), ['Colonel Creek', 'Wateree Dam', 'Your fish by Clearwater Cove']);
  assert.equal(areaCountSaid(apart[2]), '3 of your fish on 2 trips');
  assert.equal(areaCountSaid(apart[0], { anyFish: true }), '1 report (any fish)');
});

// The lake of the-day-is-spent-in-the-areas.test.js: banded 10, 20, 35, 45 ft, the ramp on the south shore.
const ring = ([w, s, e, n]) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const band = (outer, inner, ft) => ({ type: 'Feature', properties: { depth_max_ft: ft },
  geometry: { type: 'Polygon', coordinates: inner ? [ring(outer), ring(inner).reverse()] : [ring(outer)] } });
const B10 = [-80.0, 33.2, -79.98, 33.26], B20 = [-79.998, 33.2015, -79.982, 33.2585];
const B35 = [-79.996, 33.203, -79.984, 33.257], B45 = [-79.993, 33.206, -79.987, 33.254];
const LAKE = [band(B10, B20, 10), band(B20, B35, 20), band(B35, B45, 35), band(B45, null, 45)];
const RAMP = [-79.99, 33.2004];

test('the day lists his area after the reports\' and starts on the reports\' area', () => {
  const reports = [{ at: [-79.99, 33.25], name: 'Far Flats', n: 1, why: 'x' }];
  const yours = [{ at: [-79.99, 33.208], name: 'Your fish by Ramp', n: 4, trips: 3, dates: ['2026-11-09'], mine: true, why: 'y' }];
  const day = layAreas({ ramp: RAMP, daFeatures: LAKE, places: withYourFish(reports, yours), waterFt: [30, 43], fishFt: [20, 23],
                         windowMin: 540, stopMin: 0, cranks: runCrankbaits(TACKLE_INVENTORY), launchTime: '06:00' });
  assert.ok(!day.error, day.error);
  assert.deepEqual(day.areas.map((a) => [a.name, !!a.mine]), [['Far Flats', false], ['Your fish by Ramp', true]]);
  const i = startOption(day);
  const mine = new Set(day.areas.filter((a) => a.mine).map((a) => a.key));
  assert.ok(day.options[i].areas.some((k) => !mine.has(k)), day.options[i].label);
  assert.equal(day.options[i].label, 'Far Flats all day');
  assert.ok(day.options.some((op) => op.label === 'Your fish by Ramp all day'), day.options.map((o) => o.label).join(' | '));
  assert.equal(areaCountSaid(day.areas[1]), '4 of your fish on 3 trips');
  // where only his own area could be laid, the day starts on it: there is nothing else
  assert.equal(startOption({ areas: [{ key: 'a1', mine: true }], options: [{ areas: ['a1'] }] }), 0);
});

test('the area step is fed his fish and starts on the reports\' area; the map shows his in blue', () => {
  const ui = read('../js/modules/plan-water-ui.js');
  assert.match(ui, /areasFromCatches\(catchesOnThisWater\(\), \{ date: T\.dateStr, ramp: T\.ramp, reachM: T\.runReachM \?\? Infinity,/);
  assert.match(ui, /places = withYourFish\(T\.reportAreas\.turns, yours, AREA_R_M\);/);
  assert.match(ui, /T\.areaPick < day\.options\.length \? T\.areaPick : startOption\(day\);/);
  const map = read('../js/modules/loop-on-map.js');
  assert.match(map, /color:\$\{a\.mine \? '#80d8ff' : '#ffe082'\}/);
  assert.match(map, /areaCountSaid\(a, \{ anyFish:/);
  // and in words, for the status line and the prompt (areaDaySaid() lives in the UI module, which needs a page)
  assert.match(ui, /\$\{a\.name\} \(\$\{areaCountSaid\(a\)\};/);
  assert.match(ui, /where your own \$\{sp\} came from in the same weeks/);
  assert.match(ui, /the day starts on the reports\\' area unless you pick yours/);
  assert.equal(AREA_R_M, 2414);
});
