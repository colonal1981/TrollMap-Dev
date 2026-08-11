import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { assemblePlan, planRoute } from '../js/modules/plan-assemble.js';
import { state } from '../js/core/state.js';
import { materialisePlan, planTracks, planWaypoints, trackName, legColor } from '../js/modules/plan-tracks.js';
import { metresBetween } from '../js/modules/plan-candidates.js';
import { planToTimeline, LEG_COLORS, TRANSIT_COLOR, RETURN_COLOR }
  from '../js/modules/plan-to-timeline.js';

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


// -----------------------------------------------------------------------------------------------
// "i can't tell what is what", 2026-08-09.
//
// Every leg of every v2 plan drew in the same magenta, because renderMap() decided a track's
// colour by matching its NAME against v1's phase names ("Phase 1 Dawn") and no v2 track is called
// that. Two trolling legs, the deadheads between them and the run home were one indistinguishable
// tangle. The colour is a property of the leg now, off the same palette the timeline cards use.
// -----------------------------------------------------------------------------------------------
describe('plan-tracks — troll, transit and the way home are told apart', () => {
  const routed = (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b] });
  const built = () => assemblePlan({
    transit: routed, candidates: [A, B], launch: LAUNCH, loadout: LOADOUT,
    launchTime: '06:00', returnTime: '15:00', usableAh: 80,
    deploy: { 'w#1': { port: 'R1', starboard: 'R5' }, 'w#2': { port: 'R1', starboard: 'R5' } },
  });

  it('every track carries its own colour, and no two kinds share one', () => {
    const tracks = planTracks(built(), 'run1');
    const troll = tracks.filter((t) => t.planStep === 'troll');
    const transit = tracks.filter((t) => t.planStep === 'transit' && t.legRole !== 'return');
    const home = tracks.filter((t) => t.legRole === 'return');
    expect(troll.length).toBeGreaterThan(1);
    expect(transit.length).toBeGreaterThan(0);
    expect(home).toHaveLength(1);

    for (const t of tracks) expect(/^#[0-9a-f]{6}$/i.test(t.color)).toBe(true);
    // the two trolling legs are not the same colour as each other
    expect(troll[0].color).not.toBe(troll[1].color);
    // and none of the three kinds shares a colour with another kind
    const trollColors = new Set(troll.map((t) => t.color));
    expect(trollColors.has(transit[0].color)).toBe(false);
    expect(trollColors.has(home[0].color)).toBe(false);
    expect(home[0].color).not.toBe(transit[0].color);
  });

  it('a transit is dashed and a trolling leg is not', () => {
    for (const t of planTracks(built())) {
      expect(t.dashed).toBe(t.planStep === 'transit');
    }
  });

  it('the line on the water is the colour of its card', () => {
    // planToTimeline() builds the cards from the same palette. A card the user matches to a line
    // by colour is the entire point, so the two are asserted equal rather than asserted separately.
    const plan = built();
    const cards = planToTimeline(plan).cards;
    for (const t of planTracks(plan)) {
      const card = cards.find((c) => c.key === t.legId);
      expect(card.color, `${t.legId} card colour`).toBe(t.color);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // "the 2 trolling lanes themselves need to be different colors from each other" -- Ryan,
  // 2026-08-09, AFTER 36dbb56 had already given every leg its own palette entry.
  //
  // It had. The entries were `#00e5ff` and `#00bcd4`: two hex values, one colour to the eye. A
  // test that only asserts `!==` passes on two shades of the same cyan, which is exactly what
  // shipped, so this measures hue instead.
  //
  // THE 75-DEGREE FLOOR IS A JUDGEMENT AND NOT A MEASUREMENT. Nothing tested how far apart two
  // lines must be to read as different on the water. It is comfortably past the ~10 degrees
  // between the two cyans and the ~15 between the two ambers that followed them.
  // ---------------------------------------------------------------------------------------------
  const hue = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return null;                                  // grey has no hue
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return ((h * 60) % 360 + 360) % 360;
  };
  const apart = (a, b) => { const d = Math.abs(hue(a) - hue(b)); return Math.min(d, 360 - d); };
  const HUE_FLOOR = 75;

  it('consecutive troll legs are different COLOURS, not just different hex values', () => {
    for (let i = 1; i < LEG_COLORS.length; i++) {
      expect(apart(LEG_COLORS[i - 1], LEG_COLORS[i]),
             `${LEG_COLORS[i - 1]} and ${LEG_COLORS[i]} are the same colour family`)
        .toBeGreaterThan(HUE_FLOOR);
    }
    // and the cycle does not put a twin next to leg 1 when it wraps
    expect(apart(LEG_COLORS[LEG_COLORS.length - 1], LEG_COLORS[0])).toBeGreaterThan(HUE_FLOOR);
    // the specific pairs that shipped and were reported
    expect(LEG_COLORS.includes('#00bcd4')).toBe(false);
    expect(LEG_COLORS.includes('#ffb300')).toBe(false);
  });

  it('the first two legs — the ones a real day has — are as far apart as colours get', () => {
    expect(apart(LEG_COLORS[0], LEG_COLORS[1])).toBeGreaterThan(120);
  });

  it('no troll colour is a shade of the transit grey or the return green', () => {
    for (const c of LEG_COLORS) {
      expect(c).not.toBe(TRANSIT_COLOR);
      expect(c).not.toBe(RETURN_COLOR);
      // TRANSIT_COLOR is deliberately desaturated so it recedes; every leg colour is saturated.
      expect(apart(c, RETURN_COLOR), `${c} is the return colour's hue`).toBeGreaterThan(30);
    }
  });

  it('a real two-leg plan draws two lanes the eye can separate', () => {
    const troll = planTracks(built()).filter((t) => t.planStep === 'troll');
    expect(troll.length).toBe(2);
    expect(apart(troll[0].color, troll[1].color)).toBeGreaterThan(HUE_FLOOR);
  });

  it('legColor is total — an unknown leg still gets a colour rather than undefined', () => {
    expect(/^#/.test(legColor(null))).toBe(true);
    expect(/^#/.test(legColor({ type: 'troll' }, 999))).toBe(true);
  });

  it('the map draws the track\'s own colour, not one derived from its name', () => {
    // renderMap() needs Leaflet and a live map, so this is a source assertion. What it protects
    // is the line that made every v2 leg magenta: `const color = getTrackColor(t.name)`.
    const map = readFileSync(new URL('../js/core/map-init.js', import.meta.url), 'utf8');
    expect(map).toContain('t.color || getTrackColor(t.name)');
    expect(map).toContain('t.dashed');
    // the name-matching fallback stays for v1 routes and user-loaded GPX, but it is the fallback
    expect(map).not.toContain('const color = getTrackColor(t.name);');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CHARTED STRUCTURE AS WAYPOINTS — for checking the chart, not for fishing.
//
// Ryan: "so i can see them on the echomap to compare if they are actually showing where 1 garmin
// says the structure is and 2 where the actual fish finder shows the structure is". That purpose
// dictates every assertion below: a mark must carry the CHARTED depth unmodified, must be absent
// where the chart has none, and must not be confusable with a place to stop.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('planWaypoints — charted marks', () => {
  const plan = { legs: [{ id: 'L1', type: 'troll', startM: 0, lengthM: 1000, stops: [],
    marks: [{ id: 'm1', type: 'timber', what: 'flooded timber', at: [-80.72, 34.38], atM: 100,
              depthFt: 22 },
            { id: 'm2', type: 'hazard', what: 'hazard', at: [-80.71, 34.38], atM: 400,
              depthFt: null }] }] };

  it('writes nothing unless asked — card-wide this would be thousands', () => {
    expect(planWaypoints(plan, null, 'r1').length).toBe(0);
  });

  it('names the charted depth where there is one and stays silent where there is not', () => {
    const w = planWaypoints(plan, null, 'r1', { marks: true });
    expect(w.length).toBe(2);
    expect(/22ft/.test(w[0].name)).toBe(true);
    // A zero would read as "the chart says zero". Nothing reads as "the chart does not say",
    // which is the truth, and a guess would poison the comparison the waypoint exists for.
    expect(/\d+ft/.test(w[1].name)).toBe(false);
    expect(w[1].depth).toBe(null);
  });

  it('is not a casting stop, so nothing downstream offers it as one', () => {
    const w = planWaypoints(plan, null, 'r1', { marks: true });
    expect(w.every((x) => x.chartMark === true)).toBe(true);
    expect(w.some((x) => x.castingStop)).toBe(false);
  });

  it('carries distance along the whole day, not along its own leg', () => {
    const two = { legs: [plan.legs[0], { ...plan.legs[0], id: 'L2', startM: 1000 }] };
    const w = planWaypoints(two, null, 'r1', { marks: true });
    expect(w[2].atM).toBe(1100);
  });
});
