// Personal use only, not for distribution or resale; not for navigation.
//
// A LANE ALONE IS NOT WHAT IT ADDS TO A DAY.
//
// Lake Marion from Rowland, 2026-10-02, 11:00-19:00. The model chose five lanes whose `estMin` came
// to 395 minutes, wrote a 243-minute day into a 480-minute window and stopped, with four hours
// unwritten and no reason given. `estMin` is a lane fished ALONE -- the run out from the ramp, one
// pass, the run home -- and nothing in the prompt said so. Ryan, shown it: "lol ok lets try again".
//
// So each Smart Plan lane now also carries `trollMin`, one pass in the water, and the prompt says
// what `estMin` and `batteryAh` are and how a day is timed. Pick Water's `estMin` is already one
// pass (plan-from-water.js), so the paragraph is not printed on that path.
//
//   node --test test/a-lane-alone-is-not-what-it-adds-to-a-day.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCandidates, forModel } from '../js/modules/plan-candidates.js';
import { buildPlanRequest } from '../js/modules/plan-prompt.js';
import { TRANSIT_MPH } from '../js/modules/plan-water.js';

const LAT = 34.38, LON = -80.725;
const lane = (id, lat) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: Array.from({ length: 41 }, (_, k) => [LON + k * 0.0006, lat]) },
  properties: { id, depth_ft: 24, length_m: 2200, routable: true, relief: 'flat', fitted: true,
                envelope_step_m: 100, envelope_line_ft: Array(23).fill(24), envelope_ft: Array(23).fill(23),
                near: Array.from({ length: 6 }, (_, k) => ({ s: 200 + k * 300, t: 'point', d: 25 })) },
});
const RUNS = [lane('a', 34.392), lane('b', 34.386)];
const DAY = { ramp: [-80.73, 34.38], slug: 'w', fishDepthFt: [20, 30], holding: 'suspended',
              usableAh: 999, windowMin: 9999, trollMph: 2, transitMph: 4, limit: 2 };
const metresPerMin = (mph) => (mph * 1609.344) / 60;

test('trollMin is one pass in the water, and estMin is that pass plus the ramp runs', () => {
  const out = selectCandidates(RUNS, DAY);
  assert.ok(out.length >= 1);
  for (const c of out) {
    assert.equal(c.trollMin, Math.round(c.lengthM / metresPerMin(DAY.trollMph)));
    const ramp = (c.transitInM + c.transitOutM) / metresPerMin(DAY.transitMph);
    assert.ok(Math.abs(c.estMin - (c.lengthM / metresPerMin(DAY.trollMph) + ramp)) <= 1);
    assert.ok(c.estMin > c.trollMin, `${c.runId}: the ramp runs are in estMin and not in trollMin`);
    assert.equal(forModel(c).trollMin, c.trollMin);
  }
});

const prompt = (o = {}) => buildPlanRequest({
  water: 'Test Water', ramp: 'A ramp', date: '2026-10-02', launchTime: '11:00',
  returnTime: '19:00', species: ['Striped Bass'], conditions: {}, candidates: [], ...o,
}).user;

test('the lake prompt says what estMin and batteryAh are, and how a day is timed', () => {
  const p = prompt();
  assert.match(p, /AND WHAT A LANE COSTS ON ITS OWN IS NOT WHAT IT ADDS TO A DAY/);
  assert.match(p, /`estMin` and `batteryAh` on a\ncandidate are that lane fished ALONE/);
  assert.match(p, /they do NOT add up/);
  assert.match(p, /`trollMin` is one pass in the water/);
  assert.match(p, new RegExp(`\`transitToRampM\` home, the metres at ${TRANSIT_MPH} mph`));
});

test('Pick Water, where estMin is already one pass, does not get it', () => {
  assert.doesNotMatch(prompt({ waterIsChosen: true }), /AND WHAT A LANE COSTS ON ITS OWN/);
});
