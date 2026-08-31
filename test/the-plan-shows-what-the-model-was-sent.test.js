import { describe, it, expect } from './expect-shim.mjs';
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { metresBetween } from '../js/modules/plan-candidates.js';
import { materialisePlan } from '../js/modules/plan-tracks.js';
import { state } from '../js/core/state.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// Ryan, 2026-08-31, holding a saved plan with four of nine legs trolled empty:
//
//   "the plan doesn't show what the models get sent to them????"
//
// It did not. buildSmartPlanV2() returns `{plan, candidates, request, response,
// problems}` and the wiring parks all of it on `window._planV2Result` -- and
// collectPlan() then read `window._planV2` and saved the plan alone. Every part
// of the exchange was in memory and none of it reached the file.
//
// The cost was exact and immediate. That plan warned "wateree_lake#46 has no
// rods in the water for 0.7 mi" four times over, and the file could not say
// whether the model had left `deploy` off those legs or had named rods the app
// then refused -- two different bugs with two different fixes, identical in the
// saved JSON, one line apart in `problems`.
//
// Same for the geometry: `gpx.trackList` recorded that L5 had 52 points and not
// where any of them were, so nothing about an ordering, an orientation or a
// deadhead could be measured out of the one file the app hands him.
// ---------------------------------------------------------------------------

const LAUNCH = [-80.7300, 34.3800];
const routed = (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b] });

function leg(id, fromLon, toLon, lat, depthFt) {
  const coordinates = [];
  for (let i = 0; i <= 10; i++) coordinates.push([fromLon + (toLon - fromLon) * i / 10, lat]);
  return {
    runId: id, runIndex: Number(id.split('#')[1]), startM: 0,
    lengthM: Math.abs(toLon - fromLon) * 111320 * Math.cos(lat * Math.PI / 180),
    depthFt, start: coordinates[0], end: coordinates[coordinates.length - 1],
    coordinates, passes: [], support: null,
  };
}

// The shape of the day he actually got: one leg rigged, one leg with nothing in the water.
const PLAN = assemblePlan({
  transit: routed,
  candidates: [leg('w#1', -80.7200, -80.6800, 34.3800, 22.4),
               leg('w#2', -80.6700, -80.6400, 34.3850, 31)],
  launch: LAUNCH,
  loadout: { rods: [{ id: 'R1', rig: 'fluoro', role: 'troll', lure: 'A-Rig', color: 'Shad' },
                    { id: 'R5', rig: 'snap', role: 'troll', lure: 'Spoon', color: 'Chrome' }] },
  deploy: { 'w#1': { port: 'R1', starboard: 'R5' } },
  slug: 'wateree_lake', water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-08-31',
  launchTime: '06:00', returnTime: '15:00', usableAh: 80,
  species: ['Striped Bass'],
});

const REQUEST = { system: 'one valid JSON object', user: 'THE CANDIDATES\n{"runId":"w#1"}' };
const RESPONSE = { legs: [{ runId: 'w#1', speedMph: 2.0, deploy: { port: 'R1', starboard: 'R5' } },
                          { runId: 'w#2', speedMph: 2.0 }] };
// The line that was missing: the app refusing a leg's rods, which never reached the file.
const PROBLEMS = ['w#2 needs one port rod and one starboard rod, got {} — no rods deployed',
                  ...PLAN.warnings];

const noop = () => {};
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {} }), addEventListener: noop, readyState: 'complete',
};
const { collectPlan } = await import('../js/modules/plan-builder.js');

describe('the saved plan shows what the model was sent and what it sent back', () => {
  state.DATA = { waypoints: [], tracks: [], routes: [] };
  globalThis.window._planV2 = PLAN;
  // The tracks are what the GPX is written from and what `trackList` projects. Drawing them is
  // the same call the wiring makes before the day reaches the screen.
  materialisePlan(PLAN, { launch: LAUNCH, win: globalThis.window });
  globalThis.window._planV2Result = { plan: PLAN, request: REQUEST, response: RESPONSE,
                                      problems: PROBLEMS };
  const saved = collectPlan();

  it('carries the prompt that was actually sent', () => {
    expect(saved.model).toBeTruthy();
    expect(saved.model.request.system).toBe(REQUEST.system);
    expect(saved.model.request.user).toContain('w#1');
  });

  it('carries the answer that came back, as the model wrote it', () => {
    expect(saved.model.response.legs.length).toBe(2);
    // The second leg has no `deploy` -- which is the whole diagnosis, and it is now readable.
    expect(saved.model.response.legs[1].deploy).toBe(undefined);
  });

  it('carries what the app refused, not just what the assembler warned', () => {
    // plan.warnings is the assembler's third of it and says the leg was empty.
    expect(saved.plan.warnings.some((w) => /no rods in the water/.test(w))).toBe(true);
    // model.problems is the union the screen shows, and says WHY it was empty.
    expect(saved.model.problems.some((p) => /needs one port rod and one starboard rod/.test(p)))
      .toBe(true);
  });

  it('carries the line the boat runs, so a deadhead can be measured from this file alone', () => {
    // In the gpx block, beside the count it belongs to -- NOT a second copy on the legs, which
    // would be two copies of one geometry in one file.
    const tl = saved.gpx.trackList;
    expect(tl.length).toBeGreaterThan(0);
    for (const t of tl) {
      expect(Array.isArray(t.pts)).toBe(true);
      expect(t.pts.length).toBe(t.points);
    }
    expect(saved.plan.legs.every((l) => l.coordinates === undefined)).toBe(true);

    // And the measurement that could not be made before: what was fished against what was not,
    // straight off the saved file. `pts` is [lat, lon] as GPX writes it.
    const seg = (c) => c.slice(1).reduce((d, q, i) => d + metresBetween(
      [c[i][1], c[i][0]], [q[1], q[0]]), 0);
    const fished = tl.filter((t) => /^L/.test(t.name)).reduce((d, t) => d + seg(t.pts), 0);
    const dead = tl.filter((t) => /^T/.test(t.name)).reduce((d, t) => d + seg(t.pts), 0);
    // Within a fraction of a percent of the budget rather than equal to it -- the spine is
    // accumulated from each leg's declared `lengthM`, and walking the drawn line is a second,
    // independent measurement of the same water. Agreement is the point; identity would only
    // mean one of them was copied from the other.
    const off = (a, b) => Math.abs(a - b) / b;
    expect(off(fished, saved.plan.budget.fishingM)).toBeLessThan(0.01);
    expect(off(dead, saved.plan.budget.transitM)).toBeLessThan(0.01);
  });

  it('refuses a stale exchange rather than attaching yesterday\'s prompt to today\'s plan', () => {
    globalThis.window._planV2Result = { plan: { legs: [] }, request: REQUEST,
                                        response: RESPONSE, problems: PROBLEMS };
    expect(collectPlan().model).toBe(null);
  });

  it('is null when nothing recorded an exchange at all', () => {
    delete globalThis.window._planV2Result;
    expect(collectPlan().model).toBe(null);
  });
});
