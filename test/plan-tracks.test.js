import { describe, it, expect } from './expect-shim.mjs';
import { assemblePlan, planRoute } from '../js/modules/plan-assemble.js';
import { state } from '../js/core/state.js';
import { materialisePlan, planTracks, planWaypoints, trackName } from '../js/modules/plan-tracks.js';
import { metresBetween } from '../js/modules/plan-candidates.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// Ryan's plan for 2026-08-10 described ten miles of trolling and exported this:
//
//     "gpx": { "waypoints": 2, "tracks": 0, "trackPoints": 0, "trackList": [] }
//
// So it could not be loaded onto the ECHOMAP 93sv and followed, which is the entire
// point of the feature. The geometry was on `plan.legs[].coordinates` the whole time;
// nothing copied it to `state.DATA.tracks`, and `state.DATA.tracks` is the only thing
// `collectPlan()` reads.
//
// The last test in this file is the acceptance criterion, and it runs the REAL
// `collectPlan()` out of plan-builder.js rather than re-deriving what it would say.
// Re-deriving is exactly the mistake that produced the defect: two modules agreeing
// about a plan neither of them exports.
// ---------------------------------------------------------------------------

const LAUNCH = [-80.7300, 34.3800];

function leg(id, fromLon, toLon, lat, passes = []) {
  const coordinates = [];
  for (let i = 0; i <= 10; i++) coordinates.push([fromLon + (toLon - fromLon) * i / 10, lat]);
  const lengthM = Math.abs(toLon - fromLon) * 111320 * Math.cos(lat * Math.PI / 180);
  return {
    runId: id, runIndex: Number(id.split('#')[1]),
    startM: 0, lengthM, depthFt: 22.4,
    start: coordinates[0], end: coordinates[coordinates.length - 1],
    coordinates,
    passes: passes.map((p, k) => ({
      id: `${id}:p${k}`, atM: p.atM, type: p.type, offM: p.offM ?? 30, weight: p.weight ?? 3,
      at: [fromLon + (toLon - fromLon) * (p.atM / lengthM), lat],
      structureId: p.structureId ?? null, what: p.what ?? p.type, depthFt: p.depthFt ?? null,
      matchM: 12,
    })),
    support: null,
  };
}

const LOADOUT = { rods: [
  { id: 'R1', rig: 'fluoro', role: 'troll', lure: 'A-Rig Medium', color: 'Blueback Herring' },
  { id: 'R5', rig: 'snap', role: 'troll', lure: 'Flutter Spoon 3/4oz', color: 'Chrome' },
  { id: 'R6', rig: 'snap', role: 'cast', lure: 'Walking Bait', color: 'Bone' },
] };

const A = leg('w#1', -80.7200, -80.6800, 34.3800, [
  { atM: 1200, type: 'hump', structureId: 'hump_7', what: 'offshore hump, crown 41 ft', depthFt: 41 },
]);
const B = leg('w#2', -80.6700, -80.6400, 34.3850, [
  { atM: 900, type: 'creek_mouth', what: 'Crooked Creek mouth', depthFt: null },
]);

function plan() {
  return assemblePlan({
    candidates: [A, B], launch: LAUNCH, loadout: LOADOUT,
    slug: 'wateree_lake', water: 'Lake Wateree, SC', ramp: 'Clearwater Cove',
    launchTime: '06:00', returnTime: '15:00', usableAh: 80,
    deploy: { 'w#1': { port: 'R1', starboard: 'R5' }, 'w#2': { port: 'R1', starboard: 'R5' } },
    stops: [{ runId: 'w#1', structureId: 'w#1:p0', rods: ['R6'], durationMin: 15, why: 'crown' },
            { runId: 'w#2', structureId: 'w#2:p0', rods: ['R6'], durationMin: 10, why: 'mouth' }],
  });
}

function reset() { state.DATA = { waypoints: [], tracks: [] }; }

describe('plan-tracks — the route reaches state.DATA', () => {
  it('builds one track per leg, in leg order', () => {
    const p = plan();
    const tracks = planTracks(p, 'run1');
    expect(tracks.length).toBe(p.legs.length);
    expect(tracks.map((t) => t.legId)).toEqual(p.legs.map((l) => l.id));
  });

  it('flips [lon, lat] to [lat, lon] — a flipped route still draws, just in Kansas', () => {
    const p = plan();
    const t = planTracks(p)[0];
    const [lon, lat] = p.legs[0].coordinates[0];
    expect(t.pts[0]).toEqual([lat, lon]);
    // Lake Wateree is at 34 N, 80 W. Latitude first, and never the other way round.
    expect(t.pts[0][0] > 30 && t.pts[0][0] < 40).toBe(true);
    expect(t.pts[0][1] < -70).toBe(true);
  });

  it('names a track for a 4-inch screen, not for a report', () => {
    expect(trackName({ id: 'L1', type: 'troll', depthFt: 16.1 })).toBe('L1 · 16.1 ft');
    expect(trackName({ id: 'T2', type: 'transit' })).toBe('T2 · transit');
    // The run home is the leg he most needs to find on the unit at the end of the day.
    expect(trackName({ id: 'T3', type: 'transit', role: 'return' })).toBe('T3 · home');
    // A leg the pack could not sound keeps its identity rather than printing a bare "ft".
    expect(trackName({ id: 'L3', type: 'troll', depthFt: null })).toBe('L3 · troll');
    for (const t of planTracks(plan())) expect(t.name.length).toBeLessThanOrEqual(24);
  });

  it('every track carries the run id, so the cleaner cannot delete this run', () => {
    // 2026-08-09: isSmartPlanTrack() in smart-plan.js matches `smartPlan: true` and spares only
    // tracks carrying window._smartPlanRunId. Without both flags the cleaner wipes the run that
    // just finished -- the console says "2 troll, 2 transit" and the GPX says 0.
    for (const t of planTracks(plan(), 'run7')) {
      expect(t.planRunId).toBe('run7');
      expect(t.smartPlan).toBe(true);
    }
  });

  it('waypoints are the launch plus one stop each, at the stop’s own position', () => {
    const p = plan();
    const stops = p.legs.flatMap((l) => l.stops || []);
    const wpts = planWaypoints(p, LAUNCH, 'run1');
    expect(wpts.length).toBe(stops.length + 1);
    expect(wpts[0].name).toBe('Launch');
    expect(wpts[0].lat).toBe(LAUNCH[1]);
    expect(wpts[1].lat).toBe(stops[0].at[1]);
    expect(wpts[1].lon).toBe(stops[0].at[0]);
    // castingStop is what parsers.js turns into the GPX type CAST, and what smart-plan-ui
    // filters on -- so this waypoint REPLACES the one it would have made, not doubles it.
    expect(wpts[1].castingStop).toBe(true);
  });

  it('replaces its own output and leaves the user’s loaded GPX alone', () => {
    reset();
    state.DATA.tracks.push({ name: 'My saved run', pts: [[34, -80], [34.1, -80.1]] });
    state.DATA.waypoints.push({ name: 'Home dock', lat: 34, lon: -80 });
    const p = plan();
    materialisePlan(p, { launch: LAUNCH, win: {} });
    const first = state.DATA.tracks.length;
    materialisePlan(p, { launch: LAUNCH, win: {} });
    expect(state.DATA.tracks.length).toBe(first);          // not doubled on a second run
    expect(state.DATA.tracks[0].name).toBe('My saved run'); // and the user's track survived
    expect(state.DATA.waypoints[0].name).toBe('Home dock');
  });

  it('publishes the run id on the window it is given', () => {
    reset();
    const w = {};
    const r = materialisePlan(plan(), { launch: LAUNCH, win: w });
    expect(w._smartPlanRunId).toBe(r.runId);
  });
});

// ---------------------------------------------------------------------------
// THE ACCEPTANCE TEST
//
// collectPlan() lives in plan-builder.js, which wires DOM listeners at module scope, so the
// stub below exists only to let it import. Everything it asserts on comes from `state.DATA`,
// which is the module the app itself writes to.
// ---------------------------------------------------------------------------
const noop = () => {};
const stubEl = { value: '', dataset: {}, style: {}, textContent: '', innerHTML: '',
                 appendChild: noop, addEventListener: noop, querySelectorAll: () => [],
                 classList: { add: noop, remove: noop, toggle: noop, contains: () => false } };
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ ...stubEl }), addEventListener: noop, readyState: 'complete',
};
const { collectPlan } = await import('../js/modules/plan-builder.js');

describe('plan-tracks — ACCEPTANCE: the plan can be exported', () => {
  it('collectPlan().gpx.tracks === plan.legs.length and trackPoints === every vertex', () => {
    reset();
    const p = plan();
    materialisePlan(p, { launch: LAUNCH, win: globalThis.window });

    const vertices = p.legs.reduce((a, l) => a + l.coordinates.length, 0);
    const gpx = collectPlan().gpx;

    expect(gpx.tracks).toBe(p.legs.length);
    expect(gpx.trackPoints).toBe(vertices);
    expect(gpx.trackList.length).toBe(p.legs.length);
    // Two legs and a transit between them is three tracks, and the day is not one line.
    expect(p.legs.length).toBeGreaterThan(1);
    // The whole day's geometry is present: planRoute() drops only the duplicated seam vertices.
    expect(gpx.trackPoints).toBeGreaterThanOrEqual(planRoute(p).length);
  });

  it('a plan with legs and zero tracks is a failed render, and this is what catches it', () => {
    reset();
    expect(collectPlan().gpx.tracks).toBe(0);
    const p = plan();
    materialisePlan(p, { launch: LAUNCH, win: globalThis.window });
    expect(collectPlan().gpx.tracks).toBe(p.legs.length);
    expect(collectPlan().gpx.waypoints).toBeGreaterThan(0);
  });
});


// -----------------------------------------------------------------------------------------------
// THE ROUTE HOME REACHES THE UNIT, 2026-08-09.
//
// Ryan: "this entire plan leaves me stranded miles from the ramp with no timing included for
// getting home and no route to do it." The plan he took out ended 2.8 km from Clearwater Cove
// and the GPX had no track back. A leg that is not in `state.DATA.tracks` is not on the
// chartplotter, and a route home that is not on the chartplotter is not a route home.
// -----------------------------------------------------------------------------------------------
describe('plan-tracks — the way back is on the unit', () => {
  const routed = (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b] });

  function withHome() {
    return assemblePlan({
      transit: routed,
      candidates: [A, B], launch: LAUNCH, loadout: LOADOUT,
      slug: 'wateree_lake', water: 'Lake Wateree, SC', ramp: 'Clearwater Cove',
      launchTime: '06:00', returnTime: '15:00', usableAh: 80,
      deploy: { 'w#1': { port: 'R1', starboard: 'R5' }, 'w#2': { port: 'R1', starboard: 'R5' } },
    });
  }

  it('the return leg gets its own track, named for what it is', () => {
    const p = withHome();
    const home = p.legs.find((l) => l.role === 'return');
    expect(Boolean(home)).toBe(true);
    const t = planTracks(p, 'run1').find((x) => x.legId === home.id);
    expect(t.name).toBe(`${home.id} · home`);
    expect(t.legRole).toBe('return');
    expect(t.pts.length).toBeGreaterThan(1);
    // and it finishes at the ramp, in [lat, lon]
    expect(t.pts[t.pts.length - 1]).toEqual([LAUNCH[1], LAUNCH[0]]);
  });

  it('the day\'s route ends at the ramp, so the GPX does too', () => {
    const route = planRoute(withHome());
    expect(route[route.length - 1]).toEqual(LAUNCH);
  });

  it('materialising the plan puts the way home in state.DATA', () => {
    reset();
    const p = withHome();
    const out = materialisePlan(p, { launch: LAUNCH, win: {} });
    expect(out.tracks).toBe(p.legs.length);
    expect(state.DATA.tracks.some((t) => t.legRole === 'return')).toBe(true);
  });
});
