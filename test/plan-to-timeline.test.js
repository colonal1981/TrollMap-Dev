import { describe, it, expect } from './expect-shim.mjs';
import { planToTimeline, installTimeline } from '../js/modules/plan-to-timeline.js';

// ---------------------------------------------------------------------------
// Ryan, 2026-08-08, on the first v2 plan: "doesn't work with the json, html or preview buttons...
// since it doesn't hook up to the preview or html you can't get the full plan."
//
// None of those buttons read v2's markup. They read collectPlan(), which reads
// window._smartPlanTimeline. So the export path is only as good as this conversion, and the
// fields below are not decoration — each one is read by name somewhere in plan-builder.js.
// ---------------------------------------------------------------------------
const PLAN = {
  planVersion: 2,
  meta: { water: 'Lake Wateree', ramp: 'Clearwater Cove', launchTime: '06:00' },
  loadout: { rods: [
    { id: 'R1', lure: 'DT-6', color: 'shad', leadFt: 95, runsDepthFt: [8, 12], rig: 'fluoro', role: 'troll' },
    { id: 'R5', lure: 'Flutter Spoon', color: 'chrome', leadFt: 60, rig: 'snap', role: 'troll' },
    { id: 'R6', lure: 'Ned Rig', color: 'green pumpkin', rig: 'snap', role: 'cast', staged: true },
  ] },
  legs: [
    { id: 'L1', type: 'troll', runId: 'w#1', startM: 0, lengthM: 2500, depthFt: 24, speedMph: 2.0,
      deploy: { port: 'R1', starboard: 'R5' }, batteryAh: 3.9, estDurationMin: 46,
      estStartTime: '06:00', why: 'shad on the break',
      stops: [
        { id: 'S1.1', atM: 900, at: [-80.71, 34.38], structureId: 'hump_9', structureType: 'hump',
          structure: 'offshore hump, crown 18 ft', depthFt: 18, offM: 30, rods: ['R6'],
          durationMin: 15, why: 'crown stands proud', presentation: 'count it down',
          positioning: 'pedal-hover' },
        { id: 'S1.2', atM: 1600, at: [-80.705, 34.38], structureId: null, structureType: 'timber',
          structure: 'standing timber', depthFt: null, offM: 15, rods: ['R6'], durationMin: 10 },
      ] },
    { id: 'T1', type: 'transit', startM: 2500, lengthM: 1800, speedMph: 3.5, batteryAh: 4.2,
      estDurationMin: 19, estStartTime: '06:46', coordinates: [[-80.70, 34.38], [-80.67, 34.39]] },
    { id: 'L2', type: 'troll', runId: 'w#2', startM: 4300, lengthM: 1800, depthFt: 31, speedMph: 1.8,
      deploy: { port: 'R1', starboard: 'R5' }, batteryAh: 2.8, estDurationMin: 37,
      estStartTime: '07:05', why: 'deeper channel edge', stops: [] },
  ],
  budget: { totalM: 6100 }, warnings: [],
};

describe('plan-to-timeline — a v2 plan in the shape the export path reads', () => {
  const built = planToTimeline(PLAN, { depthBand: [18, 28], rationale: 'shad up on the flats' });

  it('emits every leg and every stop, in plan order', () => {
    expect(built.timeline.map((e) => e.type))
      .toEqual(['troll', 'stop_and_cast', 'stop_and_cast', 'troll', 'troll']);
    expect(built.timeline.map((e) => e.step)).toEqual([1, 2, 3, 4, 5]);
  });

  it('gives every entry the fields the renderer interpolates raw', () => {
    // `color` goes straight into a style attribute (smart-plan-ui.js:515) and `step` is printed
    // as "Step ${entry.step}" — a missing one renders "undefined44" or "Step undefined".
    for (const e of built.timeline) {
      expect(typeof e.step).toBe('number');
      expect(typeof e.key).toBe('string');
      expect(e.key.length > 0).toBe(true);
    }
    for (const e of built.timeline.filter((x) => x.type === 'troll')) {
      expect(typeof e.color).toBe('string');
      expect(e.color.startsWith('#')).toBe(true);
      expect(Array.isArray(e.rods)).toBe(true);
    }
  });

  it('keys every leg uniquely, so the rod pencil edits the leg you clicked', () => {
    const keys = built.timeline.filter((e) => e.type === 'troll').map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(['L1', 'T1', 'L2']);
  });

  it('puts port first and starboard second, because the slots are positional', () => {
    const leg = built.timeline.find((e) => e.key === 'L1');
    expect(leg.rods.map((r) => r.rod)).toEqual(['R1', 'R5']);
    expect(leg.rods[0].side).toBe('Port');
    expect(leg.port).toBe('DT-6');
    expect(leg.starboard).toBe('Flutter Spoon');
    expect(leg.portLeadFt).toBe(95);
  });

  it('shows the run between legs rather than swallowing it', () => {
    // The one part of v2 Ryan liked was the return leg. A deadhead is real battery and real time.
    const t = built.timeline.find((e) => e.key === 'T1');
    expect(t.label).toBe('Run — 1.1 mi');
    expect(t.rods).toEqual([]);
    expect(t.desc).toContain('4.2 Ah');
  });

  it('carries a stop\'s position as lat/lon together or not at all', () => {
    // plan-builder.js:461 guards on `lat != null` then does Number(e.lon).toFixed(4) — a lone
    // lat renders the stop at 0.0000 longitude, which is the Atlantic off Ghana.
    for (const s of built.timeline.filter((e) => e.type === 'stop_and_cast')) {
      expect((s.lat == null) === (s.lon == null)).toBe(true);
    }
    const hump = built.timeline.find((e) => e.id === 'S1.1');
    expect([hump.lat, hump.lon]).toEqual([34.38, -80.71]);   // from [lon, lat] in the plan
  });

  it('passes a null structure depth through instead of inventing 6 ft', () => {
    // Rule 5 of the prompt tells the model to say so rather than guess where the pipeline has no
    // depth. Defaulting here would launder that back into a confident number.
    expect(built.timeline.find((e) => e.id === 'S1.2').targetDepth).toBe(null);
    expect(built.timeline.find((e) => e.id === 'S1.1').targetDepth).toBe(18);
  });

  it('names the lure on a cast rod, not just its id', () => {
    expect(built.timeline.find((e) => e.id === 'S1.1').recommendedLures).toEqual(['R6: Ned Rig']);
  });

  it('sends only the rods that stay in the boat to the pre-rig table', () => {
    expect(built.castRods.map((r) => r.rod)).toEqual(['R6']);
    expect(built.castRods[0].rigging).toContain('swivel snap');
  });

  it('builds routeRods and routeSpeeds keyed the same as the cards', () => {
    expect(Object.keys(built.routeSpeeds)).toEqual(['L1', 'T1', 'L2']);
    expect(built.routeSpeeds.L2).toBe(1.8);
    expect(built.cards.map((c) => c.key)).toEqual(['L1', 'T1', 'L2']);
    // A transit leg has no rods, so it must not appear in routeRods and claim two empty slots.
    expect(Object.keys(built.routeRods)).toEqual(['L1', 'L2']);
  });

  it('clears the v1 fallback timeline when it installs', () => {
    // plan-builder.js:194 falls back to _groqPlanTimeline when the unified one is empty, and
    // assigns it unnormalised. A leftover from a v1 run earlier in the session would win.
    const w = { _groqPlanTimeline: [{ stale: true }] };
    installTimeline(w, built);
    expect(w._groqPlanTimeline).toBe(null);
    expect(w._smartPlanTimeline.length).toBe(5);
    expect(w._smartPlanRationale).toBe('shad up on the flats');
    expect(w._smartPlanPhaseRoutes.map((p) => p.phase)).toEqual([1, 2]);
  });

  it('returns empty rather than throwing on a plan that never got built', () => {
    expect(planToTimeline(null).timeline).toEqual([]);
    expect(planToTimeline({}).timeline).toEqual([]);
    expect(planToTimeline({ legs: [] }).cards).toEqual([]);
  });
});
