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

  it('emits every leg and every stop, in the order the boat meets them', () => {
    expect(built.timeline.map((e) => e.type))
      .toEqual(['troll', 'stop_and_cast', 'stop_and_cast', 'troll', 'troll']);
  });

  it('numbers LEGS only — a stop is a pause inside one, not a step beside it', () => {
    // Was [1,2,3,4,5] across every entry, which made a cast stop "Step 2" and the leg it sits
    // on "Step 1" — two peers, when the schema says one is inside the other.
    expect(built.timeline.filter((e) => e.type === 'troll').map((e) => e.step)).toEqual([1, 2, 3]);
    for (const s of built.timeline.filter((e) => e.type === 'stop_and_cast')) {
      expect(s.step).toBeUndefined();
      expect(s.parentLegId).toBe('L1');
      expect(/^S\d+\.\d+$/.test(s.id)).toBe(true);   // keeps the assembler's own identity
    }
    // And the leg points back at them, so a renderer can nest without re-deriving.
    expect(built.timeline.find((e) => e.key === 'L1').stopIds).toEqual(['S1.1', 'S1.2']);
    expect(built.timeline.find((e) => e.key === 'L2').stopIds).toEqual([]);
  });

  it('gives every entry the fields the renderer interpolates raw', () => {
    // `color` goes straight into a style attribute (smart-plan-ui.js:515).
    for (const e of built.timeline) {
      expect(typeof e.key === 'string' || e.type === 'change').toBe(true);
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
    expect(t.label).toBe('Run 1.1 mi');
    expect(t.rods).toEqual([]);
    expect(t.desc).toContain('4.2 Ah');
  });

  it('a transit says it is a transit, and carries no spread to render', () => {
    // 2026-08-09. The card read "TROLL — Run — 0.8 mi" over a Target Depth of "—", a
    // "Port —ft · Stbd —ft" spread and two "no lure assigned" rod rows. Ryan: "if this is the
    // leg to get to the start of the first troll run it doesn't need this information."
    //
    // The entry still rides in as type 'troll' -- that is what both renderers branch on to get
    // a leg row rather than a stop row -- so `legType` is the only thing that can tell them
    // apart, and every field a spread would need must stay empty.
    const t = built.timeline.find((e) => e.key === 'T1');
    expect(t.legType).toBe('transit');
    expect(t.label).not.toContain('Troll');
    expect(t.rods).toEqual([]);
    expect(t.port).toBe('');
    expect(t.starboard).toBe('');
    expect(t.portLeadFt).toBe('');
    expect(t.starboardLeadFt).toBe('');
    expect(t.depthMin).toBe(null);
    expect(t.depthMax).toBe(null);
    // What it DOES carry: distance, speed, battery and time.
    expect(t.stats.distMi).toBe('1.1');
    expect(t.speedMph).toBe(3.5);
    expect(t.estDurationMin != null).toBe(true);
    expect(t.desc).toContain('3.5 mph');
  });

  it('the run home says it is the run home', () => {
    const home = JSON.parse(JSON.stringify(PLAN));
    home.legs.find((l) => l.id === 'T1').role = 'return';
    const t = planToTimeline(home).timeline.find((e) => e.key === 'T1');
    expect(t.role).toBe('return');
    expect(t.label).toBe('1.1 mi to the ramp');
    expect(t.desc).toContain('back to the launch');
    expect(t.rods).toEqual([]);           // still a transit: no spread on it
  });

  it('a transit the router could not answer for says so on the card', () => {
    const straight = JSON.parse(JSON.stringify(PLAN));
    straight.legs.find((l) => l.id === 'T1').unrouted = true;
    const t = planToTimeline(straight).timeline.find((e) => e.key === 'T1');
    expect(t.unrouted).toBe(true);
    expect(t.why).toContain('STRAIGHT LINE');
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


// ---------------------------------------------------------------------------
// DISTANCE IS THE SPINE — 2026-08-09
//
// PLAN_SCHEMA_V2: "THE PLAN IS INDEXED BY DISTANCE, NOT TIME", and "planCues(plan) ... The
// timeline and the phone's notifications read this, not the legs directly."
//
// The old adapter computed the spine upstream and deleted it here: not one metre value reached
// the timeline, the JSON or the HTML. What did reach them was `routeContext.etaMin` — the whole
// LEG's estimated duration, copied onto every stop on that leg, so two stops 3 km apart carried
// the same number. Ryan's reason for the rule is that the clock starts drifting the moment he
// hooks a fish and never catches up.
// ---------------------------------------------------------------------------
const WITH_CHANGES = {
  ...PLAN,
  changes: [
    { id: 'C1', atM: 2500, rodId: 'R5', cost: 'snap', from: 'Flutter Spoon', to: 'DD1 Crankbait',
      why: 'fish moved up once the sun hit the bank' },
    { id: 'C2', atM: 4300, rodId: 'R1', cost: 'fluoro', from: 'DT-6', to: 'A-Rig',
      why: 'deeper channel edge wants weight' },
  ],
};

describe('plan-to-timeline — the distance spine reaches the screen', () => {
  const built = planToTimeline(WITH_CHANGES, { depthBand: [18, 28] });

  it('puts atM and legId on every derived entry', () => {
    for (const e of built.timeline) {
      expect(Number.isFinite(e.atM)).toBe(true);
      expect(typeof e.legId).toBe('string');
    }
  });

  it('places a stop at its own position on the day, not at its leg’s duration', () => {
    const a = built.timeline.find((e) => e.id === 'S1.1');
    const b = built.timeline.find((e) => e.id === 'S1.2');
    expect(a.atM).toBe(900);            // leg L1 starts at 0
    expect(b.atM).toBe(1600);
    expect(a.atM === b.atM).toBe(false); // two stops on one leg are not the same cue
    expect(a.atLegM).toBe(900);
    expect(a.routeContext.atM).toBe(900);
    expect(a.mark).toBe('0.56 mi');
  });

  it('emits changes as entries — a day with two swaps used to ship as a day with none', () => {
    const changes = built.timeline.filter((e) => e.type === 'change');
    expect(changes.map((c) => c.id)).toEqual(['C1', 'C2']);
    expect(changes[0].rodId).toBe('R5');
    expect(changes[0].to).toBe('DD1 Crankbait');
    // The cost is never the model's — it is read off the rod's own rig by the assembler. A snap
    // is seconds; a fluoro retie is a knot with cold wet hands in a moving kayak.
    expect(changes[1].cost).toBe('fluoro');
    expect(changes[1].costLabel).toContain('retie');
  });

  it('sorts on atM and nothing else, with a swap before the leg it precedes', () => {
    const order = built.timeline.map((e) => e.id || e.key);
    expect(order).toEqual(['L1', 'S1.1', 'S1.2', 'C1', 'T1', 'C2', 'L2']);
    let last = -1;
    for (const e of built.timeline) { expect(e.atM >= last).toBe(true); last = e.atM; }
  });

  it('forbids the time-shaped key names the est prefix exists to prevent', () => {
    // "The est prefix travels with the value." estDurationMin -> etaMin -> "~45min" on a stop
    // card is three legal-looking steps to an authoritative-looking time.
    const banned = ['eta', 'etaMin', 'timeMin', 'progressPct'];
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const k of Object.keys(o)) {
        expect(banned.includes(k)).toBe(false);
        walk(o[k]);
      }
    };
    for (const e of built.timeline) walk(e);
    for (const c of built.cards) walk(c);
  });

  it('reads planCues(), so a stop the assembler dropped cannot reappear here', () => {
    // planCues() is the schema's named read interface. Walking plan.legs directly is the one
    // thing that clause forbids, and it is what put a stop with no atM on the screen.
    const orphan = { ...WITH_CHANGES, changes: [{ id: 'C9', atM: 99999, rodId: 'R5', cost: 'snap',
                                                  from: 'x', to: 'y', why: 'off the end' }] };
    const out = planToTimeline(orphan);
    const c9 = out.timeline.find((e) => e.id === 'C9');
    expect(c9.legId).toBe(null);        // no leg contains 99999 m — said, not invented
    expect(c9.atM).toBe(99999);
  });
});
