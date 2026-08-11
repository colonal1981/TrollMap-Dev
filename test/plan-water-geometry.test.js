import { describe, it, expect } from './expect-shim.mjs';
import { buildPieces } from '../js/modules/plan-pieces.js';
import {
  bearingDeg, headwindMph, crosswindMph, worstWind, ampHoursBand,
  shallowSide, shoreAspect, sunAzimuthDeg, sunElevationDeg, sunBehindBank, optionality,
} from '../js/modules/plan-water.js';
import { depthSampler, shorelineIndex } from '../js/modules/plan-water-index.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
//
// On 2026-08-11 three separate pieces of geometry compiled, ran, produced numbers in the right
// units, and were wrong. None of them failed a test, because no test asserted anything about
// them:
//
//   * sunAzimuthDeg floored days since J2000 -- which is NOON -- and lost half a day of sidereal
//     time. It put the sun due west at seven in the morning.
//   * angleBetween returned `180 - d` after already taking the absolute value, so bearings 10
//     degrees apart came back 170. That inverted the lee test and put east-facing banks in shade
//     at sunset.
//   * plan-pieces.js never carried `envelope_ft` out of buildPieces at all. 15 tests passed over
//     it, because they assert holdsFt, offers, duplicates and rampM and none of them touch the
//     envelope -- so the strip chart drew nothing and every corridor read "undefined-undefined".
//
// Every one was found by running the chain and LOOKING at it. These are the assertions that would
// have caught them instead, and the rule they encode is: an orientation or a time of day gets
// pinned to a direction a person can check, never to a number the code happens to produce.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const WATEREE = { lat: 34.38, lon: -80.72 };
const AUG12 = Date.UTC(2026, 7, 12);

describe('the envelope has to survive buildPieces', () => {
  const lane = (id, ft, n) => ({
    type: 'Feature',
    geometry: { type: 'LineString',
                coordinates: Array.from({ length: n }, (_, k) => [-80.72 + (k * 40) / 91851.6, 34.38]) },
    properties: { id, fitted: true, depth_ft: ft, envelope_m: 25, envelope_step_m: 40,
                  envelope_ft: Array(n).fill(ft),
                  envelope_deep_ft: Array(n).fill(ft + 6),
                  envelope_line_ft: Array(n).fill(ft + 2) },
  });

  it('carries all three profiles onto the piece, not just the depth it settled on', () => {
    // THE HOLE THIS PINS. Without these the strip chart has nothing to draw and optionality()
    // reports every corridor as undefined -- both silently, both for weeks.
    const [p] = buildPieces([lane('a', 20, 60)], { clearFt: 0, minM: 600 }).pieces;
    expect(Array.isArray(p.envelope)).toBe(true);
    expect(Array.isArray(p.envelopeDeep)).toBe(true);
    expect(Array.isArray(p.envelopeLine)).toBe(true);
    expect(p.envelopeStepM).toBe(40);
    expect(p.envelope.length > 1).toBe(true);
  });

  it('so optionality can read a real corridor off it', () => {
    const [p] = buildPieces([lane('a', 20, 60)], { clearFt: 0, minM: 600 }).pieces;
    const o = optionality(p);
    expect(o.fromFt).toBe(20);
    expect(o.toFt).toBe(26);
    expect(o.spanFt).toBe(6);
  });
});

describe('bearings and the wind that rides on them', () => {
  const A = [-80.72, 34.38], EAST = [-80.70, 34.38], NORTH = [-80.72, 34.40];

  it('points where a person would point', () => {
    expect(Math.round(bearingDeg(A, EAST))).toBe(90);
    expect(Math.round(bearingDeg(A, NORTH))).toBe(0);
  });

  it('a wind from dead ahead is all headwind and no crosswind', () => {
    expect(Math.round(headwindMph(90, 90, 12))).toBe(12);
    expect(Math.round(crosswindMph(90, 90, 12))).toBe(0);
  });

  it('a wind from astern is a PUSH, and is not floored to zero', () => {
    // Clamping a tailwind to zero would make every day cost more than it does — the same
    // dishonesty as overstating the headwind, pointing the other way.
    expect(Math.round(headwindMph(90, 270, 12))).toBe(-12);
  });

  it('a beam wind is all crosswind and no headwind', () => {
    expect(Math.round(headwindMph(90, 180, 12))).toBe(0);
    expect(Math.round(crosswindMph(90, 180, 12))).toBe(12);
  });

  it('takes the gust, not the mean — a calm six and a blowing eleven are not one number', () => {
    const w = worstWind([{ hour: 6, mph: 4, deg: 90 }, { hour: 11, mph: 9, gustMph: 16, deg: 200 }]);
    expect(w.mph).toBe(16);
    expect(w.deg).toBe(200);
  });
});

describe('amp-hours cost what is measurable and never what is not', () => {
  it('charges current in full, because the amps curve is already a speed-through-water curve', () => {
    const still = ampHoursBand(5000, 2.0, 90, {});
    const against = ampHoursBand(5000, 2.0, 90, { currentMph: 1.0, currentDeg: 90 });
    expect(against.throughWaterMph).toBe(3);
    expect(against.ah > still.ah * 1.3).toBe(true);
  });

  it('charges only 3% of the wind, and reports the rest instead of inventing it', () => {
    // The first version charged the full headwind as water speed and evaluated the v^1.756 curve
    // at FOURTEEN mph — a speed this kayak cannot reach, on a curve anchored at 2.0 and 5.0. It
    // returned 33.8 Ah against 7.8 calm and would have refused fishable days.
    const b = ampHoursBand(5000, 2.0, 90, { wind: { mph: 12, deg: 90 } });
    expect(b.headwindMph).toBe(12);
    expect(b.throughWaterMph).toBe(2.36);
    expect(b.ah < 10).toBe(true);
  });
});

describe('the sun, pinned to directions a person can check', () => {
  // EDT is UTC-4, so local + 4 = UTC. These are the assertions that would have caught the
  // half-day-of-sidereal-time bug immediately.
  const az = (localHour) => sunAzimuthDeg(AUG12, WATEREE.lat, WATEREE.lon, localHour + 4);
  const el = (localHour) => sunElevationDeg(AUG12, WATEREE.lat, WATEREE.lon, localHour + 4);

  it('rises in the east and sets in the west, on an August day in South Carolina', () => {
    expect(az(7) > 45 && az(7) < 110).toBe(true);          // morning sun in the east
    expect(az(19) > 250 && az(19) < 310).toBe(true);       // evening sun in the west
  });

  it('is high at midday and below the horizon before dawn', () => {
    expect(el(13) > 60).toBe(true);
    expect(el(5) < 0).toBe(true);
  });

  it('climbs through the morning rather than jumping around', () => {
    expect(el(7) < el(9) && el(9) < el(11)).toBe(true);
  });
});

describe('sunBehindBank — the test that caught an inverted angle', () => {
  const leg = Array.from({ length: 30 }, (_, k) => [-80.72 + k * 0.0004, 34.38]);
  const window = (bearing) =>
    sunBehindBank({ coords: leg, shoreAspect: { bearingDeg: bearing, distM: 80 } }, AUG12, -4);

  it('shades an EAST bank in the morning and a WEST bank in the evening', () => {
    // The inverted version had these exactly backwards, and nothing failed. Asking which bank
    // ought to shade at breakfast is the whole test.
    const east = window(90), west = window(270);
    expect(east.toLocal < 12).toBe(true);
    expect(west.fromLocal > 12).toBe(true);
  });

  it('never shades a north or south bank at this latitude in August', () => {
    // At 34 N the sun is never low in the north, and it is only low in the south in a season
    // that is not August.
    expect(window(0)).toBe(null);
    expect(window(180)).toBe(null);
  });

  it('says nothing at all when the pack has no shoreline', () => {
    expect(sunBehindBank({ coords: leg, shoreAspect: null }, AUG12, -4)).toBe(null);
  });
});

describe('shallowSide — a side, or honestly nothing', () => {
  const leg = Array.from({ length: 40 }, (_, k) => [-80.72 + k * 0.0004, 34.38]);
  // North is port on an east-running leg.
  const northShallow = (pt) => (pt[1] > 34.38 ? 6 : 30);
  const flat = () => 20;
  // Flip the shallow side from station to station. Keyed on the station INDEX -- an earlier
  // version keyed on `round(lon * 10000) % 2`, and the stations are 0.0004 apart so that value is
  // always even and the sampler never alternated at all. The test passed a clean gradient to a
  // function being asked to reject a messy one, and failed for the right reason.
  // Flip the shallow side from sample to sample. Getting this to actually alternate took two
  // goes and both failures are worth keeping in mind when writing a fixture: `round(lon*10000)%2`
  // is always even because the stations are 0.0004 apart, and the station index itself is always
  // ODD because shallowSide samples at floor(k/10 * 39) = 3, 7, 11, ... So a fixture meant to be
  // messy handed the function a perfectly clean gradient twice, and the test failed for the right
  // reason both times.
  const noisy = (pt) => {
    const station = Math.round((pt[0] + 80.72) / 0.0004);
    return (Math.floor(station / 4) % 2) ? (pt[1] > 34.38 ? 6 : 30) : (pt[1] > 34.38 ? 30 : 6);
  };

  it('finds the side when the bottom rises the same way all along', () => {
    expect(shallowSide(leg, northShallow).side).toBe('port');
  });

  it('returns nothing mid-lake, where both sides are the same water', () => {
    // "what if you are in the middle of the lake lol"
    expect(shallowSide(leg, flat)).toBe(null);
  });

  it('returns nothing when the bottom rises one way here and the other way there', () => {
    // "it is possible for water to get deeper and then shallower again"
    expect(shallowSide(leg, noisy)).toBe(null);
  });

  it('returns nothing where nothing is charted, rather than guessing a side', () => {
    expect(shallowSide(leg, () => null)).toBe(null);
  });
});

describe('the two spatial indexes', () => {
  it('reads the SHALLOWEST band covering a point, because depth areas nest', () => {
    const ring = (d) => ({ type: 'Feature', properties: { depth_max_ft: d },
      geometry: { type: 'Polygon', coordinates: [[[-80.73, 34.37], [-80.71, 34.37],
                                                  [-80.71, 34.39], [-80.73, 34.39], [-80.73, 34.37]]] } });
    const at = depthSampler([ring(30), ring(5)]);
    expect(at([-80.72, 34.38])).toBe(5);
  });

  it('returns null off the charted area — uncharted is not deep', () => {
    const at = depthSampler([]);
    expect(at([-80.72, 34.38])).toBe(null);
  });

  it('finds the nearest shore point and gives up past maxM rather than scanning the lake', () => {
    const idx = shorelineIndex([{ type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: [[-80.72, 34.385], [-80.719, 34.385]] } }]);
    const near = idx.nearest([-80.72, 34.38], 1200);
    expect(near !== null).toBe(true);
    expect(near.distM > 500 && near.distM < 600).toBe(true);
    expect(idx.nearest([-80.99, 34.38], 1200)).toBe(null);
  });
});

describe('shoreAspect averages bearings as vectors, not as degrees', () => {
  it('does not answer due south for a bank that straddles north', () => {
    // Averaging 350 and 10 arithmetically gives 180 — the exact opposite — and a leg running
    // along a bank crosses north constantly.
    const leg = Array.from({ length: 30 }, (_, k) => [-80.72 + k * 0.0004, 34.38]);
    let flip = false;
    const idx = { nearest: (pt) => {
      flip = !flip;
      // Alternate between just-east-of-north and just-west-of-north of the boat.
      const dx = flip ? 0.00005 : -0.00005;
      return { at: [pt[0] + dx, pt[1] + 0.0009], distM: 100 };
    } };
    const a = shoreAspect(leg, idx);
    expect(a !== null).toBe(true);
    expect(a.bearingDeg < 20 || a.bearingDeg > 340).toBe(true);
  });
});
