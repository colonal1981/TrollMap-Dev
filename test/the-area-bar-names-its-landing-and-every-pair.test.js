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
import { readFileSync } from 'node:fs';
import { layAreas, runCrankbaits, MAX_PAIR_OPTIONS, landingSaid } from '../js/modules/plan-areas.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';
import { closureFor, dukeClosureFor, landingKey, LANDING_CLOSURES } from '../js/data/landing-closures.js';
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

// FROM DUKE, NOT A LIST (Ryan, 11/22: "The app should be pulling these from duke?", and "area box check should be as
// automated as possible... you know i despise hand written lists"). His screenshot of Duke's Lake Views alerts, as the
// Worker hands them over (`accessAlerts`).
const DUKE = [
  { place: 'Taylors Creek Access Area', water: 'Lake Wateree', kind: 'POI', last_updated: '2026-09-18T12:00:00',
    text: 'Taylors Creek Access Area: Sep 18, 2026 - The Taylors Creek Access Area is temporarily closing to help prevent the '
        + 'spread of giant salvinia, an invasive aquatic plant. The closure is expected to remain in place for up to 12 months.' },
  { place: 'Buck Hill Access Area', water: 'Lake Wateree', kind: 'POI', last_updated: '2026-02-11',
    text: 'Buck Hill Access Area: Feb 11, 2026 - Buck Hill Access Area will close on March 2, 2026 for approximately one year '
        + 'due to construction work at the Wateree hydro facility. Please use alternate sites, such as Colonels Creek or White '
        + 'Oak Creek for boat access during this time.' },
];

test('a landing Duke says is shut is closed on the area bar, from Duke\'s own notice', () => {
  const taylor = closureFor('wateree_lake', { name: 'Taylor Creek', lat: 34.43773, lon: -80.875784 }, { alerts: DUKE, date: '2026-11-23' });
  assert.equal(taylor.source, 'Duke Energy');
  assert.equal(taylor.read, '2026-09-18');
  assert.match(taylor.why, /^The Taylors Creek Access Area is temporarily closing to help prevent the spread of giant salvinia/);
  const buck = closureFor('wateree_lake', { name: 'Buckhill Landing', lat: 34.335864, lon: -80.707209 }, { alerts: DUKE, date: '2026-11-23' });
  assert.match(buck.why, /will close on March 2, 2026 for approximately one year/);
  // not shut before the day it closes, and not shut where Duke says nothing
  assert.equal(closureFor('wateree_lake', { name: 'Buckhill Landing', lat: 34.335864, lon: -80.707209 }, { alerts: DUKE, date: '2026-02-20' }), null);
  assert.equal(closureFor('wateree_lake', { name: 'Colonel Creek', lat: 34.368854, lon: -80.797237 }, { alerts: DUKE, date: '2026-11-23' }), null);
  // a reopening said in the notice is open
  assert.equal(dukeClosureFor([{ place: 'Taylors Creek Access Area', text: 'The Taylors Creek Access Area has reopened after the closure.' }],
                              { name: 'Taylor Creek' }), null);
  // other notices in the same feed, 11/22: a closure that starts later, and a ramp that stays open through construction
  assert.equal(dukeClosureFor([{ place: 'Conley Creek Access Area (Veteran\'s Park)', text: 'Conley Creek Access Area will be '
    + 'closed beginning November 30, 2026, for parking lot repaving and related improvements.' }], { name: 'Conley Creek' }, '2026-11-23'), null);
  assert.ok(dukeClosureFor([{ place: 'Conley Creek Access Area (Veteran\'s Park)', text: 'Conley Creek Access Area will be '
    + 'closed beginning November 30, 2026, for parking lot repaving and related improvements.' }], { name: 'Conley Creek' }, '2026-12-05'));
  assert.equal(dukeClosureFor([{ place: 'Riverbend Access Area', text: 'Construction continues at the Riverbend Access Area. The boat '
    + 'ramp will remain open, though brief closures may occur during parking lot upgrades.' }], { name: 'Riverbend Access Area' }, '2026-11-23'), null);
  // the two spellings are one landing
  assert.equal(landingKey('Taylors Creek Access Area'), landingKey('Taylor Creek'));
  assert.equal(landingKey('Buck Hill Access Area'), landingKey('Buckhill Landing'));
  assert.notEqual(landingKey('June Creek'), landingKey('Colonel Creek'));
  // without Duke's notices, nothing is invented: the list holds only what no feed carries
  assert.equal(closureFor('wateree_lake', { name: 'Taylor Creek', lat: 34.43773, lon: -80.875784 }), null);
  assert.deepEqual(LANDING_CLOSURES.map((x) => x.name), ['Lakeside Marina']);
  assert.ok(LANDING_CLOSURES.every((x) => x.source && x.read && (x.url || x.source === 'Ryan')));
  assert.equal(closureFor('wateree_lake', { name: 'Lakeside Marina', lat: 34.3641, lon: -80.6993 }).why, 'out of business and for sale');
  assert.equal(closureFor('lake_marion', { name: 'Lakeside Marina', lat: 34.3641, lon: -80.6993 }), null);   // another water
});

test('every landing check in the planner reads Duke\'s notices, and a shut landing is never the one to launch from instead', () => {
  const ui = readFileSync(new URL('../js/modules/plan-water-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /T\.accessAlerts = lakeState && Array\.isArray\(lakeState\.accessAlerts\) \? lakeState\.accessAlerts : \[\];/);
  assert.match(ui, /closureFor\(T\.r2Key, l, \{ alerts: T\.accessAlerts \|\| \[\], date: T\.dateStr \|\| null \}\)/);
  assert.equal((ui.match(/\.filter\(\(l\) => !closedNow\(l\)\)/g) || []).length, 2);
  const v2 = readFileSync(new URL('../js/modules/smart-plan-v2-wiring.js', import.meta.url), 'utf8');
  assert.match(v2, /\.filter\(\(l\) => !closureFor\(r2Key, l, \{ alerts: \(lakeState && lakeState\.accessAlerts\) \|\| \[\], date: inp\.dateStr \}\)\)/);
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
