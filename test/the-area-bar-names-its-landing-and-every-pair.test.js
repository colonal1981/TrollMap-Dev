// Personal use only, not for distribution or resale; not for navigation.
//
// THE AREA BAR: THE LANDING NEAREST AN AREA, EVERY PAIR OF AREAS, AND NO BAIT SHOP AS AN AREA.
//
// Ryan, 2026-11-08, reading the area bar for Wateree from Clearwater Cove: "for taylor creek or colonel creek this
// should tell you to launch at those instead maybe? clearwater and the dam make sense together though", and "i think
// taylors landing is closed temporarily because of a invasive grass". Read in the reports, the Taylor Creek area came
// from one sentence: "Check Suttons Landing in Taylors Creek on Lake Wateree for live bait." Offered as one change for
// his three points (11/8); his go, 11/9: "work on them all".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layAreas, runCrankbaits, MAX_PAIR_OPTIONS, landingSaid } from '../js/modules/plan-areas.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';
import { closureFor, LANDING_CLOSURES } from '../js/data/landing-closures.js';
import { namedOnlyForBaitOrLaunch, trim } from '../js/modules/reports-this-week.js';

const CRANKS = runCrankbaits(TACKLE_INVENTORY);
const ring = ([w, s, e, n]) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const band = (outer, inner, ft) => ({ type: 'Feature', properties: { depth_max_ft: ft },
  geometry: { type: 'Polygon', coordinates: inner ? [ring(outer), ring(inner).reverse()] : [ring(outer)] } });
// A lake 1.9 km by 6.7 km deepening to a 45 ft core, the ramp on the south shore (the-day-is-spent-in-the-areas).
const B10 = [-80.0, 33.2, -79.98, 33.26], B20 = [-79.998, 33.2015, -79.982, 33.2585];
const B35 = [-79.996, 33.203, -79.984, 33.257], B45 = [-79.993, 33.206, -79.987, 33.254];
const LAKE = [band(B10, B20, 10), band(B20, B35, 20), band(B35, B45, 35), band(B45, null, 45)];
const RAMP = [-79.99, 33.2004];
const NORTH = [-79.99, 33.2585];                                  // a landing on the north shore
const day = (places, landings) => layAreas({ ramp: RAMP, daFeatures: LAKE, places, waterFt: [30, 43], fishFt: [20, 23],
  windowMin: 600, stopMin: 0, cranks: CRANKS, launchTime: '06:00', landings });

test('an area far up the lake names the landing nearest it; one by his ramp names none', () => {
  const d = day([{ at: [-79.99, 33.25], name: 'Far Flats', n: 2 }, { at: [-79.99, 33.208], name: 'Near Point', n: 1 }],
                [{ name: 'North Landing', at: NORTH }, { name: 'His Ramp', at: RAMP }]);
  assert.ok(!d.error, d.error);
  const far = d.areas.find((a) => a.name === 'Far Flats'), near = d.areas.find((a) => a.name === 'Near Point');
  assert.equal(far.landing.name, 'North Landing');
  assert.ok(far.landing.m < far.landing.rampM, JSON.stringify(far.landing));
  assert.equal(near.landing, null);
  assert.match(landingSaid(far.landing), /^nearest landing North Landing, \d\.\d mi by water$/);
});

test('a closed landing is said with who closed it and when that was read, and the nearest open one after it', () => {
  const shut = { why: 'closed for a treatment in the cove', source: 'the agency page', read: '2026-11-08' };
  const d = day([{ at: [-79.99, 33.25], name: 'Far Flats', n: 2 }],
                [{ name: 'North Landing', at: NORTH, closed: shut }, { name: 'Mid Landing', at: [-79.9985, 33.235] }]);
  const l = d.areas[0].landing;
  assert.equal(l.name, 'North Landing');
  assert.equal(l.closed, shut);
  assert.equal(l.open.name, 'Mid Landing');
  assert.match(landingSaid(l), /closed: closed for a treatment in the cove \(the agency page, read 2026-11-08\); nearest open Mid Landing/);
});

test('Taylors Creek Access Area on Wateree is known closed, with its source and the day it was read', () => {
  const c = closureFor('wateree_lake', { lat: 34.43773, lon: -80.875784 });
  assert.ok(c && /giant salvinia/.test(c.why) && c.read === '2026-11-08' && /des\.sc\.gov/.test(c.url));
  assert.equal(closureFor('wateree_lake', { lat: 34.368854, lon: -80.797237 }), null);   // Colonel Creek is open
  assert.equal(closureFor('lake_marion', { lat: 34.43773, lon: -80.875784 }), null);     // another water
  assert.ok(LANDING_CLOSURES.every((x) => x.source && x.read && x.url));
});

test('"both" tries every pair that fits, nearest together first, the nearer the ramp first', () => {
  const d = day([{ at: [-79.99, 33.25], name: 'Far Flats', n: 3 }, { at: [-79.99, 33.208], name: 'Near Point', n: 1 },
                 { at: [-79.99, 33.2275], name: 'Mid Hump', n: 1 }], []);   // 2.2 km from Near Point, 2.5 from Far Flats
  assert.ok(!d.error, d.error);
  const twos = d.options.filter((op) => op.areas.length === 2).map((op) => op.label);
  assert.ok(twos.length >= 1 && twos.length <= MAX_PAIR_OPTIONS, twos.join(' | '));
  // the two nearest together lead, though the most named (Far Flats, 3) is in neither
  assert.equal(twos[0], 'Near Point, then Mid Hump');
});

test('a place named only as where to buy bait, or to launch, is not one of a report\'s places', () => {
  const cs = 'Wolfe said live bait is productive. Check Suttons Landing in Taylors Creek on Lake Wateree for live bait.';
  assert.equal(namedOnlyForBaitOrLaunch(cs, 'Taylor Creek'), true);
  assert.equal(namedOnlyForBaitOrLaunch('A lot of the fish are near the mouth of Taylors Creek where the river channel cuts in.', 'Taylor Creek'), false);
  assert.equal(namedOnlyForBaitOrLaunch('Launch at Colonel Creek and run to the dam.', 'Colonel Creek'), true);
  assert.equal(namedOnlyForBaitOrLaunch('Stripers are on live shad at the mouth of Colonel Creek.', 'Colonel Creek'), false);
  assert.equal(namedOnlyForBaitOrLaunch('Fish near the dam.', 'Wateree Dam'), false);   // not found: never dropped on a guess
  const s = trim({ date: '2024-11-05', source: 'CS', species: ['striped bass'], text: cs,
                   places: [{ name: 'Taylor Creek', as_written: 'Taylors Creek', lon: -80.875, lat: 34.437 }] });
  assert.deepEqual(s.pl, []);
});
