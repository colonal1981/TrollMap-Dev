import { describe, it, expect } from './expect-shim.mjs';

const noop = () => {};
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {} }), addEventListener: noop, readyState: 'complete',
};
const { assemblePlan } = await import('../js/modules/plan-assemble.js');
const { metresBetween } = await import('../js/modules/plan-candidates.js');
const { planToTimeline } = await import('../js/modules/plan-to-timeline.js');
const { TACKLE_INVENTORY } = await import('../js/data/tackle-inventory.js');
const { depthWindow } = await import('../js/data/lure-knowledge.js');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE PLAN CANNOT KNOW WHERE THE FISH ARE, AND THE SOUNDER CAN
//
// Ryan, 2026-09-18, the same day the app stopped claiming a fish depth nothing had measured:
//
//   "which is actually ok for it not to have a depth... as long as the app still routes over the
//    holes with a bait that is appropriate for that reach of river... if i go over a hole and see
//    that the fish are much deeper than what my current bait can do i can always turn around run
//    back the other way with a different rod... the plan is a mechanism to get me onto the fish with
//    a high probability of catching... but it can't know exactly where the fish are... if someone
//    could invent that they would be an instant billionaire... but i have the electronics on the
//    kayak to tell me if i need to change something... but a note in the plan that says hey check
//    your sonar if fish are deeper than x change to this bait... something like that"
//
// So `x` is not a threshold and this file's whole job is to prove it: x is the deeper end of the pair
// that is in the water, priced by the same capBaitDepth()/depthWindow() pair the leg was built with,
// and the rods offered are the rest of HIS loadout at the same speed. No number in `sonarCheck` is
// chosen; every one of them is read off a rig.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const lureByName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
const RUN = 'wateree_lake#900';
const LINE = [[-80.70, 34.40], [-80.70, 34.41]];
const LEG = {
  runId: RUN, runIndex: 1, startM: 0, lengthM: Math.round(metresBetween(LINE[0], LINE[1])),
  depthFt: 24, depthMinFt: 20, depthMaxFt: 28, maxRunDepthFt: 24,
  start: LINE[0], end: LINE[1], coordinates: LINE, passes: [], support: null, why: 'the shelf',
};
const ROD = (id, lure, leadFt = 60) => ({ id, rig: 'fluoro', role: 'troll', lure,
                                          color: 'chartreuse', leadFt });
const build = (rods, deploy, extra = {}) => assemblePlan({
  transit: (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b] }),
  candidates: [{ ...LEG, ...extra }], launch: LINE[0], loadout: { rods },
  slug: 'wateree_lake', water: 'Lake Wateree, SC', ramp: 'Clearwater Cove',
  launchTime: '06:00', returnTime: '15:00', usableAh: 80, lureByName,
  deploy: { [RUN]: deploy },
});
const trollLeg = (plan) => plan.legs.find((l) => l.type === 'troll');
const cardFor = (plan) => planToTimeline(plan).cards.find((c) => c.icon === '🎣');

// FOUR RODS AT FOUR DEPTHS, every one of them a bait in his own bag. The two shallow ones go out and
// the two deep ones stay on the bench, which is the shape the note exists for.
const FOUR = [ROD('R1', 'Squarebill Crankbait'), ROD('R2', 'MR Crankbait (6-12ft)'),
               ROD('R3', 'DD1 Crankbait (14-18ft)'), ROD('R4', 'DD3 Crankbait (20-25ft)')];
for (const r of FOUR) if (!lureByName(r.lure)) throw new Error(`fixture lure missing: ${r.lure}`);

describe('sonarCheck — x is the pair, not a number anybody picked', () => {
  it('reports the pair in the water and takes x off its deeper end', () => {
    const leg = trollLeg(build(FOUR, { port: 'R1', starboard: 'R2' }));
    const s = leg.sonarCheck;
    const mine = ['R1', 'R2'].map((id) => leg.rodPlan && leg.rodPlan[id]
      ? leg.rodPlan[id].runsDepthFt
      : [depthWindow(lureByName(FOUR.find((r) => r.id === id).lure),
                     { speedMph: leg.speedMph, leadFt: 60 }).min,
         depthWindow(lureByName(FOUR.find((r) => r.id === id).lure),
                     { speedMph: leg.speedMph, leadFt: 60 }).max]);
    expect(s.pairFt).toEqual([Math.min(...mine.map((w) => w[0])),
                              Math.max(...mine.map((w) => w[1]))]);
    // The whole point: x is the pair's own floor, read back off the same field.
    expect(s.ifDeeperThanFt).toBe(s.pairFt[1]);
  });

  it('offers the rods on the bench that actually reach past it, shallowest step first', () => {
    const s = trollLeg(build(FOUR, { port: 'R1', starboard: 'R2' })).sonarCheck;
    const ids = s.reach.map((r) => r.rodId);
    expect(ids.includes('R3')).toBe(true);
    expect(ids.includes('R4')).toBe(true);
    // Neither rod that is already behind the boat is offered as a change.
    expect(ids.includes('R1') || ids.includes('R2')).toBe(false);
    // Every one of them reaches deeper than x, and they are ordered by how deep they go.
    for (const r of s.reach) expect(r.runsDepthFt[1] > s.ifDeeperThanFt).toBe(true);
    const maxes = s.reach.map((r) => r.runsDepthFt[1]);
    expect(maxes.slice().sort((a, b) => a - b)).toEqual(maxes);
    expect(s.deepestInBoatFt).toBe(Math.max(...maxes));
  });

  it('says so plainly when the deepest thing he owns is already in the water', () => {
    const s = trollLeg(build(FOUR, { port: 'R4', starboard: 'R3' })).sonarCheck;
    expect(s.reach).toEqual([]);
    expect(s.deepestInBoatFt).toBe(s.ifDeeperThanFt);
    const card = cardFor(build(FOUR, { port: 'R4', starboard: 'R3' }));
    expect(card.longDesc.includes('nothing else in the boat reaches them')).toBe(true);
  });

  it('is stamped on every troll leg, not only the ones with something wrong', () => {
    // Nothing is out of place here -- the pair is in the band, the water clears both baits. The note
    // is still there, because it is about what the sounder might say and not about a defect.
    const plan = build(FOUR, { port: 'R2', starboard: 'R3' });
    for (const l of plan.legs.filter((x) => x.type === 'troll')) {
      expect(Array.isArray(l.sonarCheck.pairFt)).toBe(true);
    }
  });
});

describe('what controls the bait is a property of the bait, never of the leg', () => {
  // ── THE BUG THIS PAIR OF TESTS IS HERE FOR ──────────────────────────────────────────────────
  //
  // The first cut read `mode` as "did capBaitDepth write a leadFt for this rod" -- which asks whether
  // the LEG was shallow, not what sets the bait's depth. So the identical rod reported lead-controlled
  // while it sat on the bench and NOT lead-controlled the moment it was deployed, and leg 3 of the
  // 2026-09-18 Congaree day told him "nothing else in the boat reaches them" over 13 ft of water
  // while holding two lead-controlled baits that more line would have put straight on the fish.
  const LEAD = [ROD('L1', '3" Lipless Crankbait'), ROD('L2', '3/8oz Chatterbait'),
                 ROD('L3', 'DD3 Crankbait (20-25ft)')];
  for (const r of LEAD) if (!lureByName(r.lure)) throw new Error(`fixture lure missing: ${r.lure}`);

  it('calls a lead-controlled pair lead-controlled when it is the pair in the water', () => {
    const s = trollLeg(build(LEAD, { port: 'L1', starboard: 'L2' })).sonarCheck;
    expect(s.pairLeadWillGoDeeper).toBe(true);
    const card = cardFor(build(LEAD, { port: 'L1', starboard: 'L2' }));
    // More line before a rod change: reeling in to swap a rod that would have gone deeper on more
    // lead is a worse answer than saying nothing.
    expect(card.longDesc.includes('more lead takes what is already out there deeper')).toBe(true);
  });

  it('and calls the same rod lead-controlled while it is sitting on the bench', () => {
    const s = trollLeg(build(LEAD, { port: 'L3', starboard: 'L3' })).sonarCheck;
    const back = s.reach.find((r) => r.rodId === 'L1') || s.reach.find((r) => r.rodId === 'L2');
    if (back) expect(back.leadWillGoDeeper).toBe(true);
    // A bill-controlled bait is not offered more lead, because lead does not lift it.
    const bill = trollLeg(build(FOUR, { port: 'R1', starboard: 'R2' }))
      .sonarCheck.reach.find((r) => r.rodId === 'R4');
    expect(bill.leadWillGoDeeper).toBe(false);
  });
});

describe('two baits worked on top have no "below x" to offer', () => {
  // Every fish in the river is below 1 ft, so quoting it would be a sentence about nothing. The case
  // is read off depthWindow()'s own 'surface' mode -- not off a depth this file decided was shallow.
  const TOP = [ROD('R1', 'Wake Bait', 80), ROD('R2', 'Wake Bait', 80),
                ROD('R3', 'DD1 Crankbait (14-18ft)')];
  for (const r of TOP) if (!lureByName(r.lure)) throw new Error(`fixture lure missing: ${r.lure}`);

  it('says what the sounder changes instead of quoting a foot of water', () => {
    const plan = build(TOP, { port: 'R1', starboard: 'R2' });
    const s = trollLeg(plan).sonarCheck;
    expect(s.pairSurfaceOnly).toBe(true);
    const desc = cardFor(plan).longDesc;
    expect(desc.includes('Both rods are worked on top here')).toBe(true);
    expect(desc.includes('Anything the sounder shows down in the column wants R3')).toBe(true);
    expect(/below \d+ ft/.test(desc)).toBe(false);
  });

  it('and is false the moment one of the two is fishing under the surface', () => {
    const s = trollLeg(build(TOP, { port: 'R1', starboard: 'R3' })).sonarCheck;
    expect(s.pairSurfaceOnly).toBe(false);
    expect(cardFor(build(TOP, { port: 'R1', starboard: 'R3' })).longDesc
      .includes('In the water here:')).toBe(true);
  });
});

describe('and it never invents a rig to make the sentence work', () => {
  it('leaves out a bait with no running depth rather than talking it up', () => {
    // A Senko is a cast-only bait and planes at trolling speed: depthWindow() answers null, and a rod the app cannot place
    // is not a rod it may offer. The pair still reports, so the note survives the bad neighbour.
    const rods = [ROD('R1', 'Squarebill Crankbait'), ROD('R2', 'MR Crankbait (6-12ft)'),
                  ROD('R3', 'Stick Bait (Senko)')];
    if (!lureByName('Stick Bait (Senko)')) throw new Error('fixture lure missing: Stick Bait');
    const s = trollLeg(build(rods, { port: 'R1', starboard: 'R2' })).sonarCheck;
    expect(s.reach.some((r) => r.rodId === 'R3')).toBe(false);
    expect(Number.isFinite(s.ifDeeperThanFt)).toBe(true);
  });

  it('and says nothing at all when neither rod in the water can be placed', () => {
    const rods = [ROD('R1', 'Stick Bait (Senko)'), ROD('R2', 'Stick Bait (Senko)')];
    const leg = trollLeg(build(rods, { port: 'R1', starboard: 'R2' }));
    expect(leg.sonarCheck).toBe(undefined);
    // And the card simply does not carry the sentence, rather than carrying half of one.
    const card = cardFor(build(rods, { port: 'R1', starboard: 'R2' }));
    expect(card.sonarCheck).toBe(null);
    expect(card.longDesc.includes('sounder')).toBe(false);
  });
});
