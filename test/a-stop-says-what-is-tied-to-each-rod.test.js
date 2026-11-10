// Personal use only, not for distribution or resale; not for navigation.
//
// A STOP SAYS WHAT IS TIED TO EACH ROD IT NAMES (item 81).
//
// Ryan, 2026-11-07, on his Moultrie plan for 11/8: "for the casting stop with the jighead and swimbait is that the same
// rod as legs 14 and 17? the casting stop doesn't say what size jighead or color of swimbait". It was R6, the 5" pearl
// swimbait on a 3/4 oz head, trolled on L5, L14 and L17 and cast at the stops; the stop printed "R6: Swimbait 5" –
// Jighead" and nothing else. His "81 can be done", 11/10.
import { describe, it, expect } from './expect-shim.mjs';
import { planToTimeline, stopRodLine, castHeadOz } from '../js/modules/plan-to-timeline.js';
import { rodsAtLaunch } from '../js/modules/rods-at-launch.js';

const SWIM = 'Swimbait 5" – Jighead';
const PLAN = {
  planVersion: 2,
  meta: { water: 'Lake Moultrie', ramp: 'Short Stay', launchTime: '07:00' },
  loadout: { rods: [
    { id: 'R4', lure: SWIM, color: 'pearl/chartreuse tail', rig: 'fluoro', role: 'cast' },
    { id: 'R5', lure: 'A-Rig – five 1/2oz heads (~4.1oz)', color: 'white shad', leadFt: 70, rig: 'snap', role: 'troll' },
    { id: 'R6', lure: SWIM, color: 'pearl', leadFt: 94, runsDepthFt: [19, 23], rig: 'snap', role: 'troll' },
  ] },
  legs: [
    { id: 'L1', type: 'troll', runId: 'w#1', startM: 0, lengthM: 2500, depthFt: 30, speedMph: 2.0,
      deploy: { port: 'R5', starboard: 'R6' }, rodPlan: { R6: { jigheadOz: 0.75, leadFt: 94 } },
      estDurationMin: 46, estStartTime: '07:00', why: 'the flat', stops: [] },
    { id: 'L2', type: 'troll', runId: 'w#2', startM: 2500, lengthM: 2500, depthFt: 30, speedMph: 2.0,
      deploy: { port: 'R5', starboard: 'R6' }, estDurationMin: 46, estStartTime: '07:46', why: 'the ledge',
      stops: [
        { id: 'S2.1', atM: 900, at: [-80.0, 33.3], structureType: 'ledge', structure: 'ledge, 18 ft',
          depthFt: 18, offM: 20, rods: ['R6', 'R4'], durationMin: 15, why: 'the lip', presentation: 'count it down' },
      ] },
  ],
  budget: { totalM: 5000 }, warnings: [],
};

describe('a stop names each rod\'s lure, colour and head', () => {
  const built = planToTimeline(PLAN, {});
  const stop = built.timeline.find((e) => e.id === 'S2.1');

  it('a trolled swimbait cast at the stop says its colour and the head it was fitted on an earlier leg', () => {
    expect(stop.recommendedLures[0]).toBe('R6: Swimbait 5" – Jighead · pearl · on the 3/4oz head');
  });

  it('a rod only ever cast gets the lightest head he owns that the bait carries, on the stop and in Rods At Launch', () => {
    expect(castHeadOz(SWIM)).toBe(0.75);                       // a 5" carries 3/4 to 1 oz; he owns both
    expect(stop.recommendedLures[1]).toBe('R4: Swimbait 5" – Jighead · pearl/chartreuse tail · on the 3/4oz head');
    expect(built.castRods.find((r) => r.rod === 'R4').jigheadWeight).toBe('3/4oz');
    const r4 = rodsAtLaunch({ plan: PLAN, timeline: built.timeline, castRods: built.castRods }).rods.find((r) => r.id === 'R4');
    expect(r4.weight).toBe('Head: 3/4oz');
  });

  it('a bait with no head to fit says only what it is and its colour', () => {
    expect(stopRodLine({ id: 'R3', lure: '3" Lipless Crankbait', color: 'chrome', role: 'troll' }, null, null))
      .toBe('R3: 3" Lipless Crankbait · chrome');
    expect(castHeadOz('3" Lipless Crankbait')).toBe(null);
  });

  it('the stop still starts with the rod id, which Rods At Launch reads to place the rod at the stop', () => {
    const r6 = rodsAtLaunch({ plan: PLAN, timeline: built.timeline, castRods: built.castRods }).rods.find((r) => r.id === 'R6');
    expect(r6.where.some((w) => /cast at S2\.1/.test(w))).toBe(true);
  });
});
