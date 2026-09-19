// THE QUIET WATER BETWEEN TWO REACHES IS STILL THE RIVER, AND HE RAN IT WITH THE RODS OUT.
//
// Ryan's Congaree plan of 2026-09-19, launching Bates Bridge, put a 1,826 m transit between the
// green leg and the purple one and another coming back -- 19 minutes and 4.33 Ah each, on a river,
// between two legs on the same centreline. He asked the obvious question: "why it is all river????"
//
// It is all river. Measured against the reaches riverDriftRuns actually emitted that day:
//
//     reach              reach is    leg was    dropped    crossed anyway?
//     @119500 upstream     8,322 m    3,134 m    5,188 m   no  -- the turnaround
//     @127500 downstream   8,351 m    6,500 m    1,851 m   YES, TWICE
//     @135500 downstream   8,402 m    3,750 m    4,652 m   no  -- the turnaround
//
// bestWindow() found the densest stretch of @127500, grew it until the water went quiet, and then
// dropped the quiet tail "so a leg never ends with half a kilometre of blank water tacked on". On a
// lake that is right: the boat goes somewhere else next and never touches it. On a river the boat
// has to cross it to reach the next reach, so the drop did not save the trip -- it took the rods
// out for 38 of the 40 minutes the day ran over its own 540-minute window.
//
// Two files already said so and neither was enforced. riverDay(): "the day fishes every metre it
// covers." travelOrder(): the reaches come out contiguous, "0.0 m apart", so "every hop between legs
// is zero by construction". Both were true of the REACHES and neither was true of the LEGS.
//
// The two drops at the turnarounds are correct and free, and no per-reach rule can tell them from
// the one in the middle -- that depends on what else is on the day. So the reach is the window, and
// where to turn around stays trimReach()'s question, which is the one it exists to answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';
import { riverDriftRuns, LATERALS } from '../js/modules/river-drifts.js';
import { structureIndex, selectCandidates } from '../js/modules/plan-candidates.js';

const here = dirname(fileURLToPath(import.meta.url));

// A straight river running due east at 34.0 N. Same shape as the fixture in
// a-river-leg-is-a-drift-not-a-lane.test.js: 9 profile columns RIGHT to LEFT, deep on the right.
function eastwardRiver({ stations = 400, width = 120 } = {}) {
  const station_m = [], bearing_deg = [], width_m = [], depth_profile_ft = [], coords = [];
  const lon0 = -81.0, lat0 = 34.0, mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  for (let i = 0; i < stations; i++) {
    station_m.push(i * 50);
    bearing_deg.push(90);
    width_m.push(width);
    coords.push([lon0 + (i * 50) / mPerDegLon, lat0]);
    depth_profile_ft.push([18, 15, 13, 11, 9, 6, 4, 2, null]);
  }
  return { type: 'FeatureCollection', features: [{
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: { slug: 'test_river', step_m: 50, length_m: (stations - 1) * 50,
                  stations, station_m, bearing_deg, width_m, depth_profile_ft,
                  profile_fractions: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1] },
  }] };
}

const pointFeat = (lon, lat, kind, id) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { kind, id, depth_ft: 20 },
});

// ONE HOLE IN THE MIDDLE OF EACH REACH AND NOTHING ELSE. This is the shape that produced the 1,826 m
// transit: the seed lands on the hole, both ends grow until they have gone `quietM` with nothing,
// and everything past that is dropped -- about 3 km off each end of an 8 km reach.
function riverWithOneHolePerReach({ stations = 400 } = {}) {
  const river = eastwardRiver({ stations });
  const coords = river.features[0].geometry.coordinates;
  const feats = [];
  // Reaches are 8,000 m = 160 stations. Middle of each: station 80, 240, ...
  for (let i = 80; i < coords.length; i += 160) {
    feats.push(pointFeat(coords[i][0], coords[i][1], 'hole', `h${i}`));
  }
  return { river, coords, structures: structureIndex(feats) };
}

const SELECT = (structures, ramp, extra = {}) => ({
  ramp, slug: 'test_river', fishDepthFt: [0, 30], holding: 'suspended',
  usableAh: 400, windowMin: 2000, structures, limit: 24, ...extra,
});

const metres = (a, b) => {
  const cos = Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * 111320 * cos, (b[1] - a[1]) * 110540);
};

test('a river reach is offered whole, not as the densest stretch of itself', () => {
  const { river, coords, structures } = riverWithOneHolePerReach();
  const drifts = riverDriftRuns(river, { structures, slug: 'test_river', laterals: LATERALS });
  const byId = new Map(drifts.map((d) => [d.properties.id, d]));
  const cands = selectCandidates(drifts, SELECT(structures, coords[0]));
  assert.ok(cands.length > 0, 'candidates came back at all');

  for (const c of cands) {
    const run = byId.get(c.runId);
    assert.ok(run, `candidate ${c.runId} came from a run in the list`);
    assert.equal(c.startM, 0, `${c.runId} starts at the head of its reach`);
    assert.equal(c.wholeRun, true, `${c.runId} says it is the whole reach`);
    // Within a metre of the reach's own length; `lengthM` is rounded.
    assert.ok(Math.abs(c.lengthM - run.properties.length_m) <= 1,
              `${c.runId} is ${c.lengthM} m of a ${run.properties.length_m} m reach`);
  }
});

test('and consecutive reaches leave no water between the legs', () => {
  // travelOrder()'s invariant, asserted rather than assumed: the hop between two legs on one arm
  // has to be zero, because a hop on a river is water the boat crosses with nothing in it.
  const { river, coords, structures } = riverWithOneHolePerReach();
  const drifts = riverDriftRuns(river, { structures, slug: 'test_river', laterals: LATERALS });
  const cands = selectCandidates(drifts, SELECT(structures, coords[0]));

  const byLane = new Map();
  for (const c of cands) {
    const lane = (c.drift && c.drift.side) || '?';
    const at = Number(/@(\d+)$/.exec(c.runId)[1]);
    if (!byLane.has(lane)) byLane.set(lane, []);
    byLane.get(lane).push({ at, c });
  }
  let pairsChecked = 0;
  for (const [lane, list] of byLane) {
    list.sort((x, y) => x.at - y.at);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1].c, next = list[i].c;
      const gap = metres(prev.coordinates[prev.coordinates.length - 1], next.coordinates[0]);
      assert.ok(gap < 1, `${lane}: ${prev.runId} -> ${next.runId} leaves ${gap.toFixed(1)} m unfished`);
      pairsChecked++;
    }
  }
  assert.ok(pairsChecked > 0, 'there were consecutive reaches to check');
});

test('a lake run is still windowed, which is the A/B that says this is about rivers', () => {
  // Same geometry, same structure, same scores. The only difference is whether the run says it is a
  // drift -- so if this ever comes back equal, the change has leaked onto water where dropping a
  // quiet tail is the right answer.
  const { river, coords, structures } = riverWithOneHolePerReach();
  const drifts = riverDriftRuns(river, { structures, slug: 'test_river', laterals: LATERALS });
  const asLanes = drifts.map((d) => {
    const props = { ...d.properties };
    delete props.drift;
    return { ...d, properties: props };
  });
  const laneCands = selectCandidates(asLanes, SELECT(structures, coords[0]));
  assert.ok(laneCands.length > 0, 'the lane version produced candidates too');
  const windowed = laneCands.filter((c) => !c.wholeRun);
  assert.ok(windowed.length > 0,
            'with one hole in the middle of an 8 km run, a lane keeps the dense stretch and drops '
            + 'the rest');
});

test('maxM does not get applied twice to the same river', () => {
  // reachesFromRamp() already cut the river into maxM blocks. A reach's LANE is longer than its
  // station span -- on the Congaree an 8,000 m block comes out 8,322-8,450 m of line -- so capping
  // again here would leave a sliver unfished at every reach boundary. Forced with a small ceiling so
  // the double cap is unmistakable: 2,000 m reaches, a 900 m leg ceiling.
  const { river, coords, structures } = riverWithOneHolePerReach({ stations: 200 });
  const drifts = riverDriftRuns(river, { structures, slug: 'test_river', laterals: LATERALS,
                                         maxM: 2000 });
  assert.ok(drifts.length > 1, 'the river came out as several reaches');
  const cands = selectCandidates(drifts, SELECT(structures, coords[0], { maxM: 900, minM: 500 }));
  assert.ok(cands.length > 0, 'candidates came back');
  assert.ok(cands.some((c) => c.lengthM > 900),
            `a drift is its reach and not the leg ceiling; longest was ${
              Math.max(...cands.map((c) => c.lengthM))} m`);

  // And the same ceiling still binds a lane.
  const asLanes = drifts.map((d) => {
    const props = { ...d.properties };
    delete props.drift;
    return { ...d, properties: props };
  });
  const laneCands = selectCandidates(asLanes, SELECT(structures, coords[0], { maxM: 900, minM: 500 }));
  if (laneCands.length) {
    assert.ok(laneCands.every((c) => c.lengthM <= 900),
              'a lane is still capped at maxM');
  }
});

test('and a reach too short to be a leg is still refused', () => {
  // minM was never about skipping water: a 400 m pass is a legitimate thing to fish and not a leg.
  const { river, coords, structures } = riverWithOneHolePerReach({ stations: 200 });
  const drifts = riverDriftRuns(river, { structures, slug: 'test_river', laterals: LATERALS,
                                         maxM: 2000 });
  const cands = selectCandidates(drifts, SELECT(structures, coords[0], { minM: 1500 }));
  for (const c of cands) {
    assert.ok(c.lengthM >= 1500, `${c.runId} is ${c.lengthM} m, under the 1,500 m floor`);
  }
  assert.ok(cands.selection.rejected.noWindow >= 0, 'the refusals are counted');
});
// ── AND THEN THE DAY WITH NO GAPS IN IT REPORTED 644 m OF DEADHEAD ─────────────────────────────
//
// Ryan ran the fix and sent the plan back. The assembler measured the hops off the real geometry
// and got 20 m and 29 m; the budget came to 164 m of transit including the 95 m out of the ramp.
// The PROMPT, in the same file, told the model "644 m of the whole day is transit".
//
// stampPassClock() walked a one-dimensional position built as `fromRamp.m ± lengthM`. Those are
// two different measurements: `fromRamp.m` is STATION metres, the axis reachesFromRamp cut into
// 8,000 m blocks, and `lengthM` is the CHORD of the LANE, which wanders bank to bank and comes out
// 8,322 m for the same block. So reach @119500 appeared to end at 8,322 where @111500 began at
// 8,000, and 322 m of overlap that is not there was charged as a hop — twice, out and back.
//
// Making the window the whole reach is what exposed it: before, the window fell short of the reach
// and the subtraction happened to land on a real gap.
//
// The same walk also started at position zero on the station axis, so the run out of the ramp cost
// `fromRamp.m` — 49 m along the line for a launch that sits about 92 m off it.
describe('the hop between two legs is a distance between two places', () => {
  const src = (f) => readFileSync(join(here, '..', f), 'utf8');
  const cands = src('js/modules/plan-candidates.js');
  const walk = cands.slice(cands.indexOf('function stampPassClock'),
                           cands.indexOf('export function riverDay'));

  it('no longer adds a chord length to a station offset', () => {
    expect(/const\s+enterM\s*=/.test(walk)).toBe(false);
    expect(/nearM\s*\+\s*lenM/.test(walk)).toBe(false);
    expect(walk.includes('hopBetween(posPt, enterPt)')).toBe(true);
  });

  it('asks the same transit function the candidates were priced with', () => {
    // centrelineTransit() on a river, straight line without one -- the selector's own fallback.
    expect(walk.includes('o.transitM || metresBetween')).toBe(true);
  });

  it('starts the walk at the ramp, so the run out to the water is counted', () => {
    expect(walk.includes('Array.isArray(o.launch) ? o.launch : null')).toBe(true);
  });
});

describe('the model is told about the day it is actually handed', () => {
  const prompt = readFileSync(join(here, '..', 'js/modules/plan-prompt.js'), 'utf8');
  // The comment above the block quotes the old sentence on purpose, so what the model is SENT has
  // to be read off the executable lines. A whole-file search would match the explanation forever.
  const sent = prompt.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');

  it('stopped claiming the app took the richer side', () => {
    // riverDay takes the UPSTREAM arm because a dead motor far downstream is a fight home, not
    // because it scored higher. On the 2026-09-19 Congaree day it took 132.3 over 239.2.
    expect(sent.includes('the app took the richer side')).toBe(false);
    expect(sent.includes('this day fishes ONE of them')).toBe(true);
  });

  it('marks the arm it did not take as not fished, rather than listing it as part of the day', () => {
    expect(sent.includes('not fished today')).toBe(true);
    expect(sent.includes('is not yours to plan')).toBe(true);
  });

  it('still names the other arm and what it was worth, because declining is a fact', () => {
    expect(sent.includes('worth ${a.worth}')).toBe(true);
    expect(sent.includes('There is water on BOTH sides of the launch')).toBe(true);
  });
});
