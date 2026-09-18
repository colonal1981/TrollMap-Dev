import { describe, it, expect } from './expect-shim.mjs';

const noop = () => {};
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {} }), addEventListener: noop, readyState: 'complete',
};
const { assemblePlan } = await import('../js/modules/plan-assemble.js');
const { metresBetween } = await import('../js/modules/plan-candidates.js');
const { buildPlanRequest, planArgsFrom, MODEL_LEG_FIELDS } = await import('../js/modules/plan-prompt.js');
const { planToTimeline } = await import('../js/modules/plan-to-timeline.js');
const { TACKLE_INVENTORY } = await import('../js/data/tackle-inventory.js');
const { connectionFor } = await import('../js/data/lure-knowledge.js');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE APP ASKED FOR FOUR NOTES AND READ ONE, AND THE ONE IT DROPPED WAS THE ONE HE ASKED FOR
//
// Ryan, 2026-09-17, on a plan that rigged two rods and said nothing else about the day: *"and this
// dashboard doesn't tell me to switch if they aren't working or even mention the other 4 rods?"*
//
// The schema HAD an answer to that. `notes.adjustmentTip` -- "if nothing has hit in thirty minutes,
// do this" -- has been asked for on every plan since PLAN_SCHEMA_V2, and nothing in the codebase ever
// read it. Nor `structureFocus`. Nor `fishfinderNarrative`, which is about 150 words generated and
// binned every single run. Three of the four, on both planners, for weeks:
//
//   scoutNotes            read, as `rationale`, by three callers computing the same expression
//   structureFocus        asked for, never read
//   adjustmentTip         asked for, never read   <- the answer to what he was asking for
//   fishfinderNarrative   asked for, never read
//
// AND ONE SENTENCE FOR A NINE-HOUR DAY WAS THE WRONG GRAIN ANYWAY. What to try when nothing is
// hitting is a property of THIS water at THIS hour, which is what a leg is. So `adjustmentTip` is
// gone and `ifNotProducing` is on the leg, naming a rod he has already rigged; `structureFocus` is
// gone, because the narrative covers it; and the narrative is joined onto the rationale, which every
// reader of the scout report already reads.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// FOUR TIE-ONLY BAITS, so seatRods() has no reason to move one and the ids in this test stay put.
// Crankbaits swim on their own lip and a snap at the nose kills the action, so all four belong on
// leader rods -- R1 to R4 -- and the two snap rods stay staged, which is what makes 'R6' below a rod
// this plan never rigged rather than one it happens to have seated there.
const TIE = ['Squarebill Crankbait', 'DD1 Crankbait (14-18ft)',
             'MR Crankbait (6-12ft)', 'DD3 Crankbait (20-25ft)'];
const TACKLE = TACKLE_INVENTORY.map((l) => l.name);
const lureByName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
for (const n of TIE) if (!lureByName(n)) throw new Error(`fixture lure missing: ${n}`);

const RUN = 'wateree_lake#362';
const CANDS = [{ runId: RUN, lengthM: 2000, depthFt: 24, maxRunDepthFt: 24, passes: [] }];
const LOADOUT_RES = { rods: TIE.map((lure, i) => ({ id: `R${i + 1}`, lure, leadFt: 60, role: 'troll' })) };

// WHAT EACH LURE NEEDS AT THE BUSINESS END, which seatRods() cannot work out for itself. Without it
// the four crankbaits above get packed onto the snap rods and every id in this file moves, which is
// what the first draft of this test measured instead of what it meant to: the two staged ids ended up
// being exactly the ids the reseating mapped INTO, so there was no way left to name an unrigged rod.
const TYPE_OF = new Map(TACKLE_INVENTORY.map((l) => [l.name, l.type]));
const connectionOf = (n) => (TYPE_OF.has(n) ? connectionFor(TYPE_OF.get(n)) : null);

const answer = (ifNotProducing) => planArgsFrom({
  loadout: LOADOUT_RES,
  legs: [{ runId: RUN, deploy: { port: 'R1', starboard: 'R2' },
           why: 'the channel edge', ...(ifNotProducing ? { ifNotProducing } : {}) }],
  stops: [], changes: [], notes: {},
}, CANDS, { tackle: TACKLE, connectionOf });

describe('ifNotProducing — the other four rods get a mention, per leg', () => {
  it('rides on the leg through the one list both planners read', () => {
    expect(MODEL_LEG_FIELDS.includes('ifNotProducing')).toBe(true);
  });

  it('keeps a fallback that names a rigged rod not already in the water', () => {
    const a = answer({ rodId: 'R3', insteadOf: 'R1', why: 'it runs shallower' });
    const f = a.candidates[0].ifNotProducing;
    // Asserted against the app's OWN seating rather than against the ids typed above: the rod going
    // out is one of the two it deploys, the rod coming in is neither, and both are rigged.
    const out = a.deploy[RUN];
    expect(f.insteadOf).toBe(out.port);
    expect([out.port, out.starboard].includes(f.rodId)).toBe(false);
    const rigged = a.loadout.rods.filter((r) => !r.staged).map((r) => r.id);
    expect(rigged.includes(f.rodId)).toBe(true);
    expect(f.why).toBe('it runs shallower');
  });

  it('refuses one that names a rod already behind the boat, because that is not a change', () => {
    const a = answer({ rodId: 'R1', insteadOf: 'R2', why: 'x' });
    expect(a.candidates[0].ifNotProducing).toBe(undefined);
    expect(a.problems.some((p) => p.includes('is already in the water on that leg'))).toBe(true);
  });

  it('refuses one that offers to swap out a rod this leg does not deploy', () => {
    const a = answer({ rodId: 'R3', insteadOf: 'R4', why: 'x' });
    expect(a.candidates[0].ifNotProducing).toBe(undefined);
    expect(a.problems.some((p) => p.includes('is not one of the two rods it deploys there')))
      .toBe(true);
  });

  it('refuses one that names a rod this plan never rigged, carrying nobody knows what', () => {
    const a = answer({ rodId: 'R6', insteadOf: 'R1', why: 'x' });
    expect(a.candidates[0].ifNotProducing).toBe(undefined);
    expect(a.problems.some((p) => /the fallback rod on .* refers to R6, which this plan never rigged/
      .test(p))).toBe(true);
  });

  it('and one that is half an answer', () => {
    const a = answer({ rodId: 'R3', why: 'x' });
    expect(a.candidates[0].ifNotProducing).toBe(undefined);
    expect(a.problems.some((p) => p.includes('needs a rod to put on and the rod it replaces')))
      .toBe(true);
  });

  it('says nothing at all when the plan says nothing, which is a real answer', () => {
    const a = answer(null);
    expect(a.candidates[0].ifNotProducing).toBe(undefined);
    expect(a.problems.some((p) => /fallback|not producing/.test(p))).toBe(false);
  });
});

// ── AND ON THE LEG, AND ON THE CARD ─────────────────────────────────────────────────────────────

const LINE = [[-80.70, 34.40], [-80.70, 34.41]];
const LEG_CAND = {
  runId: RUN, runIndex: 1, startM: 0, lengthM: Math.round(metresBetween(LINE[0], LINE[1])),
  depthFt: 24, depthMinFt: 20, depthMaxFt: 28, maxRunDepthFt: 24,
  start: LINE[0], end: LINE[1], coordinates: LINE, passes: [], support: null,
};
const ROD = (id, lure) => ({ id, rig: id === 'R5' || id === 'R6' ? 'snap' : 'fluoro',
                             role: 'troll', lure, color: 'chartreuse', leadFt: 60 });
const LOADOUT = { rods: TIE.map((lure, i) => ROD(`R${i + 1}`, lure)) };

const built = (extra = {}) => assemblePlan({
  transit: (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b] }),
  candidates: [{ ...LEG_CAND, ...extra }], launch: LINE[0], loadout: LOADOUT,
  slug: 'wateree_lake', water: 'Lake Wateree, SC', ramp: 'Clearwater Cove',
  launchTime: '06:00', returnTime: '15:00', usableAh: 80, lureByName,
  deploy: { [RUN]: { port: 'R1', starboard: 'R2' } },
  ...(extra.assemble || {}),
});

describe('the leg carries it, and the card says it in words', () => {
  const FALLBACK = { rodId: 'R3', insteadOf: 'R1', why: 'it runs shallower over the shelf' };

  it('stamps it on a leg whose pair actually holds the rod being replaced', () => {
    const plan = built({ ifNotProducing: FALLBACK });
    const leg = plan.legs.find((l) => l.type === 'troll');
    expect(leg.ifNotProducing).toEqual(FALLBACK);
  });

  it('and leaves it off a pass where a second pair already replaced that rod', () => {
    // `deployBack` puts R3 and R4 in the water on the run back, so "put R3 on in place of R1" is not
    // true there -- R3 is already out and R1 is not. Absent rather than adjusted: which rod is worth
    // reaching for on that pass is a fishing call, not arithmetic the app may do on its own.
    const plan = assemblePlan({
      transit: (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b] }),
      candidates: [{ ...LEG_CAND, ifNotProducing: FALLBACK, pass: 2, ofPasses: 2, trollPasses: 1 }],
      launch: LINE[0], loadout: LOADOUT, slug: 'wateree_lake', water: 'Lake Wateree, SC',
      ramp: 'Clearwater Cove', launchTime: '06:00', returnTime: '15:00', usableAh: 80, lureByName,
      deploy: { [RUN]: { port: 'R1', starboard: 'R2' } },
      deployBack: { [RUN]: { port: 'R3', starboard: 'R4' } },
    });
    const leg = plan.legs.find((l) => l.type === 'troll');
    expect(leg.deploy).toEqual({ port: 'R3', starboard: 'R4' });
    expect(leg.ifNotProducing).toBe(undefined);
  });

  it('names the rod AND what is on it, because an id is not something anybody can act on', () => {
    const t = planToTimeline(built({ ifNotProducing: FALLBACK, why: 'the channel edge here' }));
    const card = t.cards.find((c) => c.icon === '🎣');
    expect(card.longDesc.includes('the channel edge here')).toBe(true);
    expect(card.longDesc.includes('If they are not producing: put R3 (MR Crankbait (6-12ft)) on '
                                + 'in place of R1')).toBe(true);
    expect(card.longDesc.includes('it runs shallower over the shelf')).toBe(true);
    expect(card.ifNotProducing).toEqual(FALLBACK);
  });

  it('and says only the why when the plan gave no fallback', () => {
    const t = planToTimeline(built({ why: 'the channel edge here' }));
    const card = t.cards.find((c) => c.icon === '🎣');
    expect(card.longDesc).toBe('the channel edge here');
    expect(card.ifNotProducing).toBe(null);
  });
});

describe('the scout report reads the plan, and it reads both halves of it', () => {
  const PLAN = () => built({ why: 'x' });

  it('joins the overview and the sonar narrative, each under its own heading', () => {
    const p = PLAN();
    p.notes = { scoutNotes: 'shad up on the flats', fishfinderNarrative: 'arches at 18 ft' };
    const t = planToTimeline(p);
    expect(t.rationale.includes('shad up on the flats')).toBe(true);
    expect(t.rationale.includes('WHAT THE SONAR SHOULD SHOW')).toBe(true);
    expect(t.rationale.includes('arches at 18 ft')).toBe(true);
    // The overview first, because it is the thing he reads to decide; the sonar is what he reads on
    // the water.
    expect(t.rationale.indexOf('shad up') < t.rationale.indexOf('arches at')).toBe(true);
  });

  it('prints no heading over an absent narrative, and no rationale at all over nothing', () => {
    const a = PLAN(); a.notes = { scoutNotes: 'shad up on the flats' };
    expect(planToTimeline(a).rationale).toBe('shad up on the flats');
    const b = PLAN(); b.notes = { fishfinderNarrative: 'arches at 18 ft' };
    expect(planToTimeline(b).rationale.startsWith('WHAT THE SONAR SHOULD SHOW')).toBe(true);
    const c = PLAN();
    expect(planToTimeline(c).rationale).toBe('');
  });

  it('and is not handed in any more, because three callers computed the same expression', () => {
    const p = PLAN();
    p.notes = { scoutNotes: 'off the plan' };
    // The option is gone; anything passed as `rationale` is ignored in favour of the plan's own notes.
    expect(planToTimeline(p, { rationale: 'handed in' }).rationale).toBe('off the plan');
  });
});

describe('the prompt stops asking for what nothing reads', () => {
  const promptFor = (isRiver) => buildPlanRequest({
    candidates: [{ runId: RUN, depthFt: 24, lengthM: 2000, passes: {}, structures: [] }],
    water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-09-18',
    launchTime: '06:00', returnTime: '15:00', species: ['striped bass'],
    conditions: {}, tackle: TACKLE, lureByName, usableAh: 80, windowMin: 540, isRiver,
  }).user;

  it('no longer asks for the two notes it threw away', () => {
    for (const r of [true, false]) {
      const u = promptFor(r);
      expect(u.includes('structureFocus')).toBe(false);
      expect(u.includes('adjustmentTip')).toBe(false);
      // And still asks for the two it reads.
      expect(u.includes('scoutNotes')).toBe(true);
      expect(u.includes('fishfinderNarrative')).toBe(true);
    }
  });

  it('asks for the per-leg fallback on a river and on a lake, in the same words', () => {
    for (const r of [true, false]) {
      const u = promptFor(r);
      expect(u.includes('"ifNotProducing": { "rodId": "R2", "insteadOf": "R1"')).toBe(true);
      expect(u.includes('IS THE ANSWER TO "THESE TWO ARE NOT WORKING"')).toBe(true);
      expect(u.includes('the reason the other four rods are aboard')).toBe(true);
      expect(u.includes('Name a rod THIS PLAN RIGGED that is not in the water')).toBe(true);
    }
  });
});
