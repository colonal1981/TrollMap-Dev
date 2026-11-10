// Personal use only, not for distribution or resale; not for navigation.
//
// THE PLAN FITS WHAT THE SOUNDER SHOWS: a ladder on every troll leg, fish at -> which two rigged rods, what speed.
//
// Ryan, 2026-11-10: "one day on the lake doesn't help us get depths of fish... for a-rigs or spoons it is simple to slow
// down to drop the baits lower... but for plans that call for deep diving crank baits i can't make them just drop... so we
// need to write the plan to have options that fit what i see on the sounder". Of his DD4 (the Deep Hit Stick 12): "the
// dd4 doesn't get as low as it says". His rule: "honestly for 25 and down the safest bet is slowing down an a-rig, spoon,
// paddletail, or bucktail". The on-the-water tap was dropped: "lets skip number 3".
import { describe, it, expect } from './expect-shim.mjs';
import { depthLadder, DEEP_TYPES } from '../js/modules/plan-assemble.js';
import { planToTimeline, ladderRowText } from '../js/modules/plan-to-timeline.js';
import { buildPlanRequest } from '../js/modules/plan-prompt.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';

const byName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
const RODS = [
  { id: 'R1', lure: 'DD2 Crankbait (16-20ft)', leadFt: 76, role: 'troll', rig: 'fluoro' },
  { id: 'R2', lure: 'DD4 Crankbait (25ft+)', leadFt: 120, role: 'troll', rig: 'fluoro' },
  { id: 'R3', lure: '3" Lipless Crankbait', leadFt: 60, role: 'troll', rig: 'fluoro' },
  { id: 'R4', lure: 'Swimbait 5" – Jighead', leadFt: 90, role: 'troll', rig: 'fluoro' },
  { id: 'R5', lure: 'A-Rig – five 1/2oz heads (~4.1oz)', leadFt: 70, role: 'troll', rig: 'snap' },
  { id: 'R6', lure: 'Nichols Lake Fork Flutter Spoon 3/4oz', leadFt: 60, role: 'troll', rig: 'snap' },
];
const typeOf = (id) => byName(RODS.find((r) => r.id === id).lure).type;

describe('the depth ladder', () => {
  const L = depthLadder(RODS, { port: 'R5', starboard: 'R1' }, null, 2.0, byName, 40);

  it('runs in 5 ft rows, the same pair at the same speed merged, down to the leg\'s shallowest water', () => {
    expect(L.rows.length >= 4).toBe(true);
    for (let i = 1; i < L.rows.length; i += 1) {
      expect(L.rows[i].fromFt).toBe(L.rows[i - 1].toFt);
      expect(L.rows[i].fromFt % 5).toBe(0);
    }
    expect(L.rows[L.rows.length - 1].toFt <= 40).toBe(true);
  });

  it('25 ft and deeper is his four, slowed: never a crankbait', () => {
    for (const row of L.rows.filter((r) => r.fromFt >= 25)) {
      for (const rod of row.rods) expect(DEEP_TYPES.includes(typeOf(rod.id))).toBe(true);
      expect(row.mph < 2.0).toBe(true);
    }
  });

  it('the DD4 is never counted, at any depth', () => {
    expect(L.rows.some((r) => r.rods.some((x) => x.id === 'R2'))).toBe(false);
  });

  it('no row is under his motor\'s 0.75 mph, and no bait runs past the leg\'s shallowest water', () => {
    for (const row of L.rows) {
      expect(row.mph >= 0.75).toBe(true);
      for (const rod of row.rods) expect(rod.runsFt[1] <= 40).toBe(true);
    }
  });

  it('the pair already out, at the leg\'s speed, is marked as rigged where it fits', () => {
    const r = L.rows.find((x) => x.fromFt === 15);
    expect(r.asRigged).toBe(true);
    expect(r.rods.map((x) => x.id).sort()).toEqual(['R1', 'R5']);
    expect(ladderRowText(r)).toMatch(/^Fish at 15–20 ft: .*as rigged at 2\.0 mph\.$/);
  });

  it('over shallow water the ladder stops at the leg\'s shallowest water', () => {
    const S = depthLadder(RODS, { port: 'R5', starboard: 'R1' }, null, 2.0, byName, 23);
    expect(S.rows[S.rows.length - 1].toFt).toBe(23);
    for (const row of S.rows) for (const rod of row.rods) expect(rod.runsFt[1] <= 23).toBe(true);
  });
});

describe('the ladder reaches the cards, and the plan is told to rig for it', () => {
  const PLAN = {
    planVersion: 2, meta: {},
    loadout: { rods: RODS.map((r) => ({ ...r, color: 'white' })) },
    legs: [{ id: 'L1', type: 'troll', runId: 'w#1', startM: 0, lengthM: 2000, depthFt: 34, depthMinFt: 30,
             depthMaxFt: 45, speedMph: 2.0, deploy: { port: 'R5', starboard: 'R1' }, estStartTime: '08:30',
             why: 'the basin', stops: [],
             sonarCheck: { pairFt: [13, 20], ifDeeperThanFt: 20, pairLeadWillGoDeeper: true, reach: [] },
             depthLadder: depthLadder(RODS, { port: 'R5', starboard: 'R1' }, null, 2.0, byName, 30) }],
    budget: {}, warnings: [],
  };
  const built = planToTimeline(PLAN, {});
  const leg = built.timeline.find((e) => e.type === 'troll');

  it('a troll entry carries the rows, each with its sentence, and says where the leg stops it', () => {
    expect(leg.ladder.rows.length > 0).toBe(true);
    expect(leg.ladder.rows.every((r) => /^Fish at \d+–\d+(\.\d)? ft: /.test(r.text))).toBe(true);
    expect(leg.ladder.note).toMatch(/Deeper than 30 ft: this leg's shallowest water is about 30 ft/);
  });

  it('the one-line sonar check gives way to the ladder on a leg that has one', () => {
    expect(/more lead takes what is already out there deeper/.test(leg.why)).toBe(false);
  });

  it('the plan is asked for two of the four deep baits wherever it trolls 25 ft and deeper', () => {
    const names = RODS.map((r) => r.lure);
    const p = buildPlanRequest({ water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-11-12',
      launchTime: '08:00', returnTime: '15:00', species: ['Striped Bass'], conditions: {}, tackle: names,
      trollable: names, lureByName: byName, candidates: [] }).user;
    expect(p).toContain('FISH AT 25 FT AND DEEPER ARE REACHED BY SLOWING DOWN, NOT BY A CRANKBAIT');
    expect(p).toContain('honestly for 25 and down the safest bet is slowing down an a-rig, spoon, paddletail, or bucktail');
  });
});

// AND THE PLAN SAYS SO WHEN IT RIGGED FEWER THAN TWO OF THEM over water 25 ft and deeper.
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { metresBetween } from '../js/modules/plan-candidates.js';

describe('a day over deep water with fewer than two of his deep baits rigged is told so', () => {
  const RUN = 'wateree_lake#901';
  const LINE = [[-80.70, 34.40], [-80.70, 34.41]];
  const build = (rods, deploy, depthMaxFt) => assemblePlan({
    transit: (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b] }),
    candidates: [{ runId: RUN, runIndex: 1, startM: 0, lengthM: Math.round(metresBetween(LINE[0], LINE[1])),
                   depthFt: 32, depthMinFt: 28, depthMaxFt, maxRunDepthFt: 28, start: LINE[0], end: LINE[1],
                   coordinates: LINE, passes: [], support: null, why: 'the basin' }],
    launch: LINE[0], loadout: { rods }, slug: 'wateree_lake', water: 'Lake Wateree, SC', ramp: 'Clearwater Cove',
    launchTime: '08:00', returnTime: '15:00', usableAh: 80, lureByName: byName, deploy: { [RUN]: deploy },
  });
  const said = (plan) => (plan.warnings || []).join(' | ');
  const one = [RODS[0], RODS[1], RODS[2], RODS[4]];          // only the A-rig of his four

  it('one of the four rigged: names it and asks for a second', () => {
    expect(said(build(one, { port: 'R5', starboard: 'R1' }, 40)))
      .toMatch(/only one rod rigged to troll can be slowed down to fish that deep: R5 \(A-Rig/);
  });

  it('two rigged, or water never 25 ft: nothing said', () => {
    expect(/slowed down to fish that deep|Rig two before you leave/.test(said(build(RODS, { port: 'R5', starboard: 'R1' }, 40)))).toBe(false);
    expect(/slowed down to fish that deep/.test(said(build(one, { port: 'R5', starboard: 'R1' }, 22)))).toBe(false);
  });

  it('every troll leg carries its ladder', () => {
    const plan = build(RODS, { port: 'R5', starboard: 'R1' }, 40);
    for (const l of plan.legs.filter((x) => x.type === 'troll')) expect(l.depthLadder.rows.length > 0).toBe(true);
  });
});
