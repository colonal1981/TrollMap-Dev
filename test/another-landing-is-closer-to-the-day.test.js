// ANOTHER LANDING IS CLOSER TO THE DAY'S WATER, AND THE PLAN SAYS WHICH.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Change request 10. Ryan, 2026-09-25: "if i am going to fish june creek then i should have just
// launched at june creek". No cap -- "I honestly don't know that number" -- and nothing refused:
// the plan names the landing that reaches its water for the least running, with the miles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayEnds, closerLanding, closerLandingNote, metresBetween } from '../js/modules/closer-landing.js';

// A straight shore running east along latitude 34.2; x in km east of lon -80.8.
const LON0 = -80.8, LAT = 34.2;
const kx = 111320 * Math.cos(LAT * Math.PI / 180);
const P = (km) => [LON0 + (km * 1000) / kx, LAT];
const LAUNCH = P(0);

// Launch at 0 km; the day fishes 5-6 km east and ends at 6 km.
const PLAN = { legs: [
  { id: 'T1', type: 'transit', lengthM: 5100, coordinates: [LAUNCH, P(5)] },
  { id: 'L1', type: 'troll', coordinates: [P(5), P(6)] },
  { id: 'T2', type: 'transit', role: 'return', lengthM: 6100, coordinates: [P(6), LAUNCH] },
] };

const landing = (name, km, extra = {}) => ({ name, lon: P(km)[0], lat: P(km)[1], ...extra });

// The router: 2% over the straight line, like the Wateree graph measured. Counts its calls.
function router(refuse = new Set()) {
  const r = async (a, b) => {
    r.calls++;
    const key = [a, b].map((c) => c.map((v) => v.toFixed(5)).join(',')).join('>');
    for (const k of refuse) if (key.includes(k)) return null;
    return { distanceM: metresBetween(a, b) * 1.02 };
  };
  r.calls = 0;
  return r;
}

test('dayEnds reads the run out, the day and the run home off the plan', () => {
  const e = dayEnds(PLAN, LAUNCH);
  assert.deepEqual(e.first, P(5));
  assert.deepEqual(e.last, P(6));
  assert.equal(e.outM, 5100);
  assert.equal(e.homeM, 6100);
  assert.equal(dayEnds({ legs: [] }, LAUNCH), null, 'no troll leg, no day to be closer to');
});

test('the landing next to the water wins, with routed miles', async () => {
  const route = router();
  const best = await closerLanding({ plan: PLAN, launch: LAUNCH, route,
    landings: [landing('Home ramp', 0), landing('Middle', 3), landing('June Creek', 5.5)] });
  assert.equal(best.landing.name, 'June Creek');
  assert.ok(Math.abs(best.outM - 0.5 * 1000 * 1.02) < 5);
  assert.ok(best.savedM > 9000);
  assert.equal(best.fromOutM, 5100);
  assert.equal(best.fromHomeM, 6100);
});

test('his own launch is never offered back to him', async () => {
  const best = await closerLanding({ plan: PLAN, launch: LAUNCH, route: router(),
    landings: [landing('Same ramp, other feed', 0.01)] });
  assert.equal(best, null);
});

test('branch and bound: a landing the straight line already rules out is never routed', async () => {
  const route = router();
  const far = Array.from({ length: 40 }, (_, i) => landing(`far ${i}`, -10 - i));
  await closerLanding({ plan: PLAN, launch: LAUNCH, route,
    landings: [...far, landing('June Creek', 5.5), landing('Middle', 3)] });
  assert.ok(route.calls <= 4, `asked the router ${route.calls} times`);
});

test('a landing the router will not reach is skipped, never costed as a straight line', async () => {
  const jc = landing('June Creek', 5.5);
  const route = router(new Set([`${jc.lon.toFixed(5)},${jc.lat.toFixed(5)}`]));
  const best = await closerLanding({ plan: PLAN, launch: LAUNCH, route,
    landings: [jc, landing('Middle', 3)] });
  assert.equal(best.landing.name, 'Middle');
});

test('a landing up a creek pays for its own path to the channel, both ways', async () => {
  const creek = landing('Up the creek', 5.5, { water_m: 4000, route: [P(5.5), P(5.4)] });
  const best = await closerLanding({ plan: PLAN, launch: LAUNCH, route: router(),
    landings: [creek, landing('Middle', 3)] });
  assert.equal(best.landing.name, 'Middle', '4 km of creek each way costs more than it saves');
});

test('a day already at his ramp names nobody', async () => {
  const near = { legs: [{ id: 'L1', type: 'troll', coordinates: [P(0.1), P(0.3)] }] };
  const best = await closerLanding({ plan: near, launch: LAUNCH, route: router(),
    landings: [landing('June Creek', 5.5), landing('Next door', 0.2)] });
  assert.equal(best, null, 'no run out and no run home drawn: nothing to save');
});

test('the note gives the landing, the saving and both legs of it, and says what it does not change', () => {
  const n = closerLandingNote({ landing: { name: 'June Creek', listing: 'semi-private' },
    outM: 510, homeM: 520, savedM: 10170, fromOutM: 5100, fromHomeM: 6100 }, 'Clearwater Cove');
  assert.match(n, /^June Creek \(semi-private — a fee is likely\) is 6\.3 mi closer to this day's water by boat/);
  assert.match(n, /0\.3 mi out to the first leg and 0\.3 mi back from the last, against 3\.2 and 3\.8 mi from Clearwater Cove/);
  assert.match(n, /launching there instead would change which water it offers/);
  assert.equal(closerLandingNote({ landing: { name: 'X' }, outM: 1, homeM: 1, savedM: 60,
    fromOutM: 31, fromHomeM: 31 }, 'Y'), null, 'what prints as 0.0 mi is not said');
  assert.equal(closerLandingNote(null, 'Y'), null);
});
