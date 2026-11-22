// Personal use only, not for distribution or resale; not for navigation.
//
// THE LOWER END IS AN AREA, AND THE ENDS ARE HIS.
//
// Ryan, 2026-11-22: "another suggestion would be figuring out what we call the lower end and which ramps fall into it...
// i bet there are reports that say at the lower end or by the dam... anything south of beaver creek i would call lower
// end. middle from beaver north to state park and then upper end from state park north", then "i would have drawn it
// straight across the lake and given beaver creek, june creek, and dutchman to middle. then state park, taylor and
// wateree creek to upper", and "lugoff is the river below the dam". Wateree's striper reports within 3 weeks of 11/23,
// from 2008: two places named once each, and "lower end" in five different reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WATER_ENDS, endsOf, endAt, endFrom } from '../js/data/water-ends.js';
import { endCounts, endsFromReports, withEnds, rampsByReports } from '../js/modules/reports-this-week.js';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const W = 'wateree_lake';
const AT = {
  'Clearwater Cove': [-80.728814, 34.379271], 'Colonel Creek': [-80.797237, 34.368854], 'Molly Creek': [-80.787994, 34.382753],
  'Buckhill Landing': [-80.707209, 34.335864], 'Lakeside Marina': [-80.6993, 34.3641],
  'Beaver Creek': [-80.770029, 34.434081], 'June Creek': [-80.829429, 34.391261], 'Dutchman Marina': [-80.8679, 34.4241],
  'Lake Wateree State Park': [-80.858374, 34.432841], 'Taylor Creek': [-80.875784, 34.43773],
  'Wateree Creek Access Area': [-80.913862, 34.469605],
};

test('every Wateree landing is in the end he put it in, and Lugoff is in none', () => {
  const want = { 'lower lake': ['Clearwater Cove', 'Colonel Creek', 'Molly Creek', 'Buckhill Landing', 'Lakeside Marina'],
                 'mid lake': ['Beaver Creek', 'June Creek', 'Dutchman Marina'],
                 'upper lake': ['Lake Wateree State Park', 'Taylor Creek', 'Wateree Creek Access Area'] };
  assert.deepEqual(endsOf(W).map((e) => [e.key, e.landings.map((l) => l.name)]), Object.entries(want));
  for (const [key, names] of Object.entries(want)) for (const n of names) assert.equal(endAt(W, AT[n]).key, key, n);
  assert.ok(!JSON.stringify(WATER_ENDS).includes('Lugoff'));
  // open water between two landings goes to the nearer: the lower lake off Clearwater, the river channel up by Wateree Creek
  assert.equal(endAt(W, [-80.745, 34.372]).key, 'lower lake');
  assert.equal(endAt(W, [-80.90, 34.50]).key, 'upper lake');
  assert.deepEqual(endsOf('lake_murray'), []);
  assert.equal(endAt('lake_murray', AT['Clearwater Cove']), null);
});

test('an end is fished by the ramp when the ramp is in it, and from its nearest landing when not', () => {
  const lower = endsOf(W)[0];
  assert.deepEqual(endFrom(W, lower, AT['Clearwater Cove']), { at: AT['Clearwater Cove'], byRamp: true, landing: null });
  const fromBeaver = endFrom(W, lower, AT['Beaver Creek']);
  assert.equal(fromBeaver.byRamp, false);
  assert.equal(fromBeaver.landing, 'Molly Creek');
});

// Trimmed statements as askThisWeek() hands them over (reports-this-week.js trim()): sp, ar, pl, d, t.
const st = (d, t, ar, sp = ['striped bass'], pl = []) => ({ d, t, ar, sp, pl, src: 'AHQ', who: [], lu: [], bait: [], tm: [],
                                                             way: [], pos: [], dep: [], kw: [], f: null });
const TW = { days: 21, statements: [
  st('2022-11-10', 'drifting around on the lower end', ['lower lake']),
  st('2022-12-02', 'deep water on the lower end of the main lake', ['lower lake', 'main lake']),
  st('2023-11-02', 'middle to lower end of the lake over deep water', ['lower lake']),
  st('2023-11-09', 'middle to lower end of the lake over deep water', ['lower lake']),        // printed again: one report
  st('2024-11-20', 'especially on the lower end', ['lower lake']),
  st('2019-11-21', 'free-lines on the lower end', ['lower lake']),
  st('2022-10-20', 'schools on the lower end around Colonel Creek', ['lower lake'], ['striped bass'],
     [{ n: 'Colonel Creek', lon: -80.797, lat: 34.37 }]),                                    // counted for the place
  st('2009-11-07', 'caught in the mid-lake area', ['mid lake']),
  st('2014-01-12', 'crappie around the upper end', ['upper lake'], ['crappie']),             // not his fish
] };

test('the reports\' ends are counted for his fish, a repeat once, a report naming a place for the place', () => {
  const c = endCounts(TW, 'Striped Bass', W);
  assert.deepEqual(c.map((x) => [x.key, x.n, x.years]), [['lower lake', 5, '2019-2024'], ['mid lake', 1, '2009']]);
  assert.deepEqual(endCounts(TW, 'Striped Bass', 'lake_murray'), []);
  // a fish the reports never mention: any fish
  assert.ok(endCounts(TW, 'Bowfin', W).find((x) => x.key === 'upper lake'));
});

test('from Clearwater the lower end is an area by the ramp and leads the reports\' areas', () => {
  const ends = endsFromReports(TW, 'Striped Bass', W, { ramp: AT['Clearwater Cove'], reachM: 20000 });
  const lower = ends.find((e) => e.end === 'lower lake');
  assert.deepEqual(lower.at, AT['Clearwater Cove']);
  assert.equal(lower.byRamp, true);
  assert.equal(lower.name, 'Lower end');
  assert.match(lower.why, /Lower end: 5 reports within 21 days of this date say the lower end \(2019-2024\); your ramp is in it/);
  const middle = ends.find((e) => e.end === 'mid lake');
  assert.equal(middle.byRamp, false);
  // with the two places the reports name, most-named first
  const places = [{ at: [-80.797237, 34.368854], name: 'Colonel Creek', n: 1, why: 'c' }, { at: [-80.7031, 34.335], name: 'Wateree Dam', n: 1, why: 'd' }];
  const all = withEnds(places, ends);
  assert.equal(all[0].name, 'Lower end');
  assert.deepEqual(all.map((a) => a.name).sort(), ['Colonel Creek', 'Lower end', 'Middle', 'Wateree Dam']);
  // out of reach, an end is not offered
  assert.ok(!endsFromReports(TW, 'Striped Bass', W, { ramp: AT['Wateree Creek Access Area'], reachM: 3000 }).some((e) => e.end === 'lower lake'));
});

test('an end on a named place adds its reports to the place: one area, not two', () => {
  const ends = endsFromReports(TW, 'Striped Bass', W, { ramp: AT['Colonel Creek'], reachM: 20000 });
  const all = withEnds([{ at: [-80.797237, 34.368854], name: 'Colonel Creek', n: 1, why: 'c' }], ends);
  const cc = all.find((a) => a.name === 'Colonel Creek');
  assert.equal(cc.n, 6);
  assert.equal(cc.inEnd, 'Lower end');
  assert.ok(!all.some((a) => a.name === 'Lower end'));
});

test('the ramp heads-up counts an end for every landing in it', () => {
  const landings = Object.entries(AT).map(([name, at]) => ({ name, lon: at[0], lat: at[1] }));
  const r = rampsByReports(TW, 'Striped Bass', landings, { current: AT['Clearwater Cove'], slug: W });
  const row = (n) => r.rows.find((x) => x.name === n);
  // the place it reaches (Colonel Creek, 1) and the end it is in (the lower end, 5)
  assert.equal(row('Clearwater Cove').score, row('Clearwater Cove').spots.reduce((t, x) => t + x.n, 0));
  assert.equal(row('Clearwater Cove').score, 6);
  assert.ok(row('Clearwater Cove').spots.some((s) => s.name === 'Lower end' && s.n === 5));
  assert.ok(row('June Creek').spots.some((s) => s.name === 'Middle' && s.n === 1));
  assert.ok(!row('Taylor Creek').spots.some((s) => /end|Middle/.test(s.name)));
  // without his ends for the water, nothing changes
  const plain = rampsByReports(TW, 'Striped Bass', landings, { current: AT['Clearwater Cove'] });
  assert.ok(plain.rows.every((x) => !x.spots.some((s) => s.name === 'Lower end')));
});

test('the planner lays the ends with the places, and the ramp heads-up is told which water', () => {
  const ui = read('../js/modules/plan-water-ui.js');
  assert.match(ui, /const ends = endsFromReports\(tw, T\.species, T\.r2Key, \{ ramp: T\.ramp, reachM: runReachM \}\);/);
  assert.match(ui, /turns: withEnds\(T\.reportAreas\.turns, ends\)/);
  assert.match(ui, /rampsByReports\(tw, T\.species, landings, \{ reachM, budgetM, current: T\.ramp, slug: T\.r2Key \}\)/);
});
