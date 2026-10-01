// THE WIND ACROSS THE WATER: how much open water is upwind of a leg, and the waves it makes.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Change request 22. Ryan, 2026-09-26: "The routes would have taken me way too far from the ramp
// with 1-2 ft swells due to the wind... i kept in closer to the coves so i had somewhere to get out
// of the wind". Fetch off the water's own outline, waves off the Shore Protection Manual's formula,
// and his own 1 ft as the point a leg is worth saying.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shoreRays, waveHeightFt, exposure, wavesByHour, roughLegs, shelter, TOO_ROUGH_FT }
  from '../js/utils/wind-waves.js';
import { airAndFrontBlock } from '../js/modules/plan-prompt.js';

// A 4 km square lake centred on (LON0, LAT) with a 400 m square island 1 km east of the centre.
const LON0 = -80.8, LAT = 34.3;
const kx = 111320 * Math.cos(LAT * Math.PI / 180), ky = 111320;
const P = (xm, ym) => [LON0 + xm / kx, LAT + ym / ky];
const sq = (cx, cy, h) => [P(cx - h, cy - h), P(cx + h, cy - h), P(cx + h, cy + h),
                           P(cx - h, cy + h), P(cx - h, cy - h)];
const LAKE = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
  geometry: { type: 'Polygon', coordinates: [sq(0, 0, 2000), sq(1000, 0, 200)] } }] };

test('fetch is the open water upwind, to the shore or to an island', () => {
  const rays = shoreRays(LAKE);
  const c = P(0, 0);
  assert.ok(Math.abs(rays(c[0], c[1], 0) - 2000) < 5, 'north wind: 2 km of water to the north shore');
  assert.ok(Math.abs(rays(c[0], c[1], 270) - 2000) < 5, 'west wind: 2 km to the west shore');
  assert.ok(Math.abs(rays(c[0], c[1], 90) - 800) < 5, 'east wind: the island is 800 m upwind');
  assert.equal(shoreRays(null), null, 'no boundary, nothing to measure on');
});

test('the wave formula: nothing from nothing, more from more, less in shallow water', () => {
  assert.equal(waveHeightFt(0, 5000, 30), 0);
  assert.equal(waveHeightFt(12, 0, 30), 0);
  assert.equal(waveHeightFt(null, 5000, 30), null);
  const h = waveHeightFt(15, 5000, 33);
  assert.ok(h > 0.7 && h < 1.0, `15 mph over 5 km of 33 ft water is under a foot significant: ${h}`);
  assert.ok(waveHeightFt(20, 5000, 33) > h, 'more wind, bigger waves');
  assert.ok(waveHeightFt(15, 10000, 33) > h, 'more fetch, bigger waves');
  assert.ok(waveHeightFt(15, 5000, 6) < h, 'shallow water holds them down');
  assert.ok(waveHeightFt(15, 5000) >= h, 'no depth given means deep water');
});

test('a leg is as exposed as its most open point', () => {
  const rays = shoreRays(LAKE);
  // A line from just west of the island out to the west shore; an east wind has the island in the
  // way at its east end and 3 km of water at its west end... which is downwind. Its most open
  // point to an EAST wind is the west end, with 3.2 km upwind to the island.
  const leg = [P(700, 0), P(-1800, 0)];
  const x = exposure(leg, rays, { mph: 12, deg: 90 }, 30);
  assert.ok(Math.abs(x.fetchM - 2600) < 10, `fetch ${x.fetchM}`);
  assert.equal(x.from, 'E');
  assert.equal(x.mph, 12);
  assert.ok(x.waveFt > 0);
});

test('wavesByHour gives the model one number per forecast hour', () => {
  const rays = shoreRays(LAKE);
  const w = wavesByHour([P(0, 0), P(0, 500)], rays,
    [{ hour: 7, mph: 4, deg: 0 }, { hour: 11, mph: 16, deg: 0 }], 30);
  assert.deepEqual(Object.keys(w), ['07:00', '11:00']);
  assert.ok(w['11:00'] > w['07:00']);
  assert.equal(wavesByHour([P(0, 0)], rays, [], 30), null);
  assert.equal(wavesByHour([P(0, 0)], null, [{ hour: 7, mph: 4, deg: 0 }], 30), null);
});

test('roughLegs stamps every leg and says only the ones at his 1 ft', () => {
  const rays = shoreRays(LAKE);
  const plan = { legs: [
    { id: 'L1', type: 'troll', estStartTime: '07:10', estDurationMin: 30, depthFt: 30,
      coordinates: [P(-1900, 1900), P(-1900, 1400)] },
    { id: 'T1', type: 'transit', coordinates: [P(0, 0), P(1, 1)] },
    { id: 'L2', type: 'troll', estStartTime: '10:40', estDurationMin: 50, depthFt: 60,
      coordinates: [P(0, -1900), P(-500, -1900)] },
  ] };
  // A northerly all day, building to 22 mph by 11:00. L1 hugs the north shore; L2 has 4 km of
  // lake to the north of it.
  const wind = [7, 8, 9, 10, 11].map((h) => ({ hour: h, mph: h < 10 ? 6 : h === 10 ? 14 : 22, deg: 0 }));
  const said = roughLegs(plan, rays, wind);
  assert.ok(plan.legs[0].exposure && plan.legs[2].exposure, 'every troll leg carries its exposure');
  assert.equal(plan.legs[1].exposure, undefined, 'a transit is not stamped');
  assert.ok(plan.legs[0].exposure.waveFt < TOO_ROUGH_FT);
  assert.equal(plan.legs[2].exposure.at, '11:00', 'the roughest hour the leg is fished in');
  assert.ok(plan.legs[2].exposure.waveFt >= TOO_ROUGH_FT, `L2 ${plan.legs[2].exposure.waveFt}`);
  assert.equal(said.length, 1);
  assert.match(said[0], /^L2 \(10:40\) is exposed: at 11:00, 2\.\d mi of open water to the N; 22 mph from there makes waves about \d\.\d ft — you found 1-2 ft too much on Wateree/);
  // and how far to water under his 1 ft, in place of "keep a cove close" (item 22, 2026-10-01)
  assert.ok(plan.legs[2].exposure.shelter && plan.legs[2].exposure.shelter.m > 0);
  assert.equal(plan.legs[0].exposure.shelter, undefined, 'a leg under the limit is not asked');
  assert.match(said[0], /the nearest water under 1 ft at that wind is about \d\.\d mi to the N of its most open point, straight into the wind\.$/);
});

// ── HOW FAR TO GET OUT OF IT ─────────────────────────────────────────────────────────────────
// Item 22's third measurement, 2026-10-01. Ryan, 2026-09-26: "i kept in closer to the coves so i
// had somewhere to get out of the wind if it got too bad". Sheltered is his 1 ft, at the same wind.
test('shelter: straight into the wind, where the fetch left makes under his 1 ft', () => {
  const rays = shoreRays(LAKE);
  // Open water 3.5 km south of the north shore, a 22 mph northerly. No shore on any bearing is
  // sheltered nearer than that, so the answer is upwind, and exactly where the waves fall to 1 ft.
  const sh = shelter([P(-1000, -1500)], rays, { mph: 22, deg: 0 }, 30);
  assert.equal(sh.upwind, true);
  assert.equal(sh.toward, 'N');
  const left = 3500 - sh.m;
  assert.ok(Math.abs(waveHeightFt(22, left, 30) - TOO_ROUGH_FT) < 0.01,
    `the fetch left at ${sh.m} m makes ${waveHeightFt(22, left, 30)} ft`);
});

test('shelter: under a shore off to the side when that is nearer -- here the lee of the island', () => {
  const rays = shoreRays(LAKE);
  // South-west of the island, with 2.6 km of open water to the north and a 30 mph northerly: about
  // 1.5 ft, and straight upwind the waves only fall under 1 ft some 1.4 km on. The island's south
  // shore is 566 m away to the north-east, and the water against it has a metre of fetch.
  const sh = shelter([P(600, -600)], rays, { mph: 30, deg: 0 }, 30);
  assert.equal(sh.upwind, false);
  assert.equal(sh.toward, 'NE');
  assert.ok(Math.abs(sh.m - 566) < 3, `${sh.m} m`);
});

test('shelter: nothing to go looking for when the leg is already under the limit', () => {
  const rays = shoreRays(LAKE);
  assert.deepEqual(shelter([P(-1900, 1900)], rays, { mph: 6, deg: 0 }, 30),
    { m: 0, toward: 'N', upwind: true });
  assert.equal(shelter([P(0, 0)], null, { mph: 6, deg: 0 }, 30), null);
});

test('the prompt explains wavesFtByHour only when a leg carries it', () => {
  const withIt = airAndFrontBlock([], {}, [{ runId: 'a#1', wavesFtByHour: { '07:00': 0.3 } }]);
  assert.match(withIt, /`wavesFtByHour` ON A LEG is the wave height the forecast wind makes there/);
  assert.match(withIt, /Prefer the sheltered legs/);
  assert.match(withIt, /A leg at 1 ft or\s+more at the hour you put it is one he has already called too rough/);
  assert.equal(airAndFrontBlock([], {}, [{ runId: 'a#1' }]), '');
});
