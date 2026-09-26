// Personal use only, not for distribution or resale; not for navigation.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { planToTimeline, installTimeline } from '../js/modules/plan-to-timeline.js';
import { metresBetween } from '../js/modules/plan-candidates.js';
import { rodsAtLaunch, rodsAtLaunchHtml } from '../js/modules/rods-at-launch.js';
import { esc } from '../js/utils/escape.js';
import { state } from '../js/core/state.js';

// ---------------------------------------------------------------------------
// Ryan, 2026-09-25, the night before a trip: "the one thing the plan html is really missing that
// would make it better is a section that just shows what all 6 rods are rigged with to start the
// day and then any lure changes... i do not see that section on this html".
//
// The report had a pre-rig table, built inside `if (castRods.length)`. His plan had no cast-only
// rod, so the report printed no rigging list at all. When it did print, the trolling rows came off
// the spread, so the two rods the plan rigged and never deployed were not on it either.
// ---------------------------------------------------------------------------

const BUILDER = readFileSync(new URL('../js/modules/plan-builder.js', import.meta.url), 'utf8');

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

// Three rods rigged, two deployed, one change. R3 is rigged and never goes in the water; R2, R4
// and R6 are not named at all, so they stay staged with whatever is on them.
const PLAN = assemblePlan({
  transit: routed,
  candidates: [leg('w#1', -80.7200, -80.6800, 34.3800, 22.4),
               leg('w#2', -80.6700, -80.6400, 34.3850, 31)],
  launch: LAUNCH,
  loadout: { rods: [
    { id: 'R1', rig: 'fluoro', role: 'troll', lure: 'MR Crankbait (6-12ft)', color: 'Chartreuse Shad' },
    { id: 'R3', rig: 'fluoro', role: 'troll', lure: 'Squarebill Crankbait', color: 'Natural Shad' },
    { id: 'R5', rig: 'snap', role: 'troll', lure: 'Flutter Spoon', color: 'Chrome' },
  ] },
  deploy: { 'w#1': { port: 'R1', starboard: 'R5' }, 'w#2': { port: 'R1', starboard: 'R5' } },
  changes: [{ beforeRunId: 'w#2', rodId: 'R5', to: 'Lipless Crankbait', why: 'more flash once the sun is up' }],
  slug: 'wateree_lake', water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-09-26',
  launchTime: '08:00', returnTime: '16:00', usableAh: 80, species: ['Striped Bass'],
  conditions: { waterTempF: 78, clarity: 'Stained' },
  safety: { isGo: true, warning: '', rampEvaluation: 'sheltered' },
});

const noop = () => {};
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {} }), addEventListener: noop, readyState: 'complete',
};
const { collectPlan } = await import('../js/modules/plan-builder.js');

state.DATA = { waypoints: [], tracks: [] };
globalThis.window._planV2 = PLAN;
installTimeline(globalThis.window, planToTimeline(PLAN));
const P = collectPlan();
const R = rodsAtLaunch(P);
const HTML = rodsAtLaunchHtml(P, esc);
const rod = (id) => R.rods.find((r) => r.id === id);

describe('the report says what every rod is rigged with before the boat leaves', () => {
  it('prints on a day with no cast-only rod — the day it used to print nothing', () => {
    expect(P.castRods).toEqual([]);
    expect(HTML).toContain('Rods At Launch');
    // The section is not gated on anything in the builder; the old gate is gone.
    expect(/if \(castRods\.length\)\s*\{/.test(BUILDER)).toBe(false);
    expect(BUILDER).toContain('${rodsHtml}');
  });

  it('lists all six rods in order, not only the two that troll', () => {
    expect(R.rods.map((r) => r.id)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
  });

  it('says which rods wear a leader and which a snap, from the boat, not from prose', () => {
    expect(rod('R1').terminal).toContain('fluoro');
    expect(rod('R5').terminal).toBe('swivel snap');
    expect(HTML).toContain('4 on a 20 lb fluoro leader');
    expect(HTML).toContain('2 on swivel snaps');
  });

  it('names the rod rigged and never used, and says it needs no knot today', () => {
    expect(rod('R3').lure).toBe('Squarebill Crankbait');
    expect(rod('R3').status).toBe('idle');
    expect(HTML).toContain('no need to tie it on today');
  });

  it('leaves the rods the plan never named as they are', () => {
    expect(rod('R2').status).toBe('staged');
    expect(HTML).toContain('keeps whatever is already on it');
  });

  it('gives a changed rod the lure it LEAVES the ramp with, and lists the change', () => {
    // At launch R5 carries the spoon; the lipless is what the change ties on later.
    expect(rod('R5').lure).toBe('Flutter Spoon');
    expect(R.changes.length).toBe(1);
    const c = R.changes[0];
    expect(c.rodId).toBe('R5');
    expect(c.from).toBe('Flutter Spoon');
    expect(c.to).toBe('Lipless Crankbait');
    // Before the leg that fishes w#2, with that leg's start time.
    const w2 = PLAN.legs.find((l) => l.runId === 'w#2');
    expect(c.beforeLeg).toBe(w2.id);
    expect(c.at).toBe(w2.estStartTime);
    expect(HTML).toContain('Lure Changes');
    expect(HTML).toContain('Lipless Crankbait');
  });

  it('says where each deployed rod fishes, in the order the day happens', () => {
    expect(rod('R1').where.length).toBeGreaterThan(0);
    expect(rod('R1').where[0]).toContain('port');
    expect(rod('R5').where[0]).toContain('starboard');
  });

  it('says so in words when nothing changes', () => {
    const none = rodsAtLaunchHtml({ ...P, timeline: P.timeline.filter((e) => e.type !== 'change'),
                                    plan: { ...P.plan, changes: [] } }, esc);
    expect(none).toContain('Every rod keeps what it was rigged with at launch');
  });
});

describe('the saved file carries every rod', () => {
  it('exports the seated loadout on the plan block', () => {
    expect(P.plan.loadout.rods.map((r) => r.id)).toEqual(PLAN.loadout.rods.map((r) => r.id));
  });

  it('reads an older file that has only the model’s loadout', () => {
    // Files saved before the plan block carried `loadout` -- including the one he fished -- still
    // name the rod rigged and never used, from the model's own answer.
    const old = { ...P, plan: { ...P.plan, loadout: undefined },
                  model: { response: { loadout: { rods: PLAN.loadout.rods } } } };
    const r3 = rodsAtLaunch(old).rods.find((r) => r.id === 'R3');
    expect(r3.lure).toBe('Squarebill Crankbait');
    expect(r3.status).toBe('idle');
  });
});
