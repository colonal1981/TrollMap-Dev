// Personal use only, not for distribution or resale; not for navigation.
//
// FOUR THINGS OFF RYAN'S 9/27 MURRAY PLAN, THE FIRST ONE CLAUDE WROTE ON HIS PC (2026-09-26 night).
//
//   1. "you keep saying that i pick the order for pick water... i dont see a way to do that".
//      He did not: the day was built in searchOrder(), and the veto was an argument nothing
//      passed. Offered a choice, he picked "Always shortest-first".
//   2. The re-seat moved the rod ids the app reads and not the ones the model wrote: 28 rod
//      numbers in the text pointed at a different lure on the card.
//   3. Every "if they are not producing" line was built into `longDesc`, which nothing draws.
//   4. "point -4ft" on the Garmin, for a point the lake has dropped off.
import { describe, it, expect } from './expect-shim.mjs';
import { planFromWater } from '../js/modules/plan-from-water.js';
import { dayCost, dayOrder, searchOrder } from '../js/modules/plan-water.js';
import { planArgsFrom } from '../js/modules/plan-prompt.js';
import { planToTimeline } from '../js/modules/plan-to-timeline.js';
import { stopName, stopUnit, planWaypoints } from '../js/modules/plan-tracks.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';
import { connectionFor } from '../js/data/lure-knowledge.js';

const RAMP = [-80.7107, 34.3486];
function piece(key, lon, lat, holdsFt) {
  const coords = Array.from({ length: 40 }, (_, i) => [lon + i * 0.0004, lat + i * 0.00012]);
  return {
    key, runId: `wateree_lake#${key}`, coords, lengthM: 1800, laneLengthM: 4000, holdsFt,
    near: [{ t: 'hump', s: 400, d: 12 }], partners: [], reasons: { for: ['1.1 mi'], against: [] },
    envelope: Array(20).fill(holdsFt + 2), envelopeStepM: 90, chartedFrac: 1,
  };
}
// Near, far, near-ish, farther: the kind of set a diagnostic order walks back and forth across.
const PICKED = [piece(1, -80.705, 34.350, 12), piece(2, -80.640, 34.300, 30),
                piece(3, -80.700, 34.345, 30), piece(4, -80.630, 34.295, 12)];
const OPTS = { ramp: RAMP, usableAh: 80, windowMin: 480 };

const TACKLE = TACKLE_INVENTORY.filter((l) => l.trollable).map((l) => l.name);
const connectionOf = (n) => {
  const hit = TACKLE_INVENTORY.find((l) => l.name === n);
  return hit ? connectionFor(hit.type) : null;
};

describe('Pick Water builds shortest-first -- "Always shortest-first"', () => {
  it('the day order is the cheapest order, never dearer than the diagnostic one', () => {
    const od = dayOrder(PICKED, OPTS);
    const cheapest = dayCost(PICKED, OPTS);
    expect(od.order).toEqual(cheapest.order);
    expect(od.cost.moveM).toBe(cheapest.moveM);
    const searched = dayCost(PICKED, { ...OPTS, order: searchOrder(PICKED) });
    expect(od.cost.moveM <= searched.moveM).toBe(true);
  });

  it('builds the plan in that order and tells the model the app ordered it', async () => {
    let sent = null;
    const r = await planFromWater({
      picked: PICKED, spots: [], ramp: RAMP, slug: 'wateree_lake', usableAh: 80, windowMin: 480,
      launchTime: '06:30', returnTime: '13:00', tackle: TACKLE, connectionOf,
      askModel: async (req) => {
        sent = req;
        return JSON.stringify({
          loadout: { rods: [{ id: 'R5', lure: '3" Lipless Crankbait', role: 'troll', leadFt: 60 },
                            { id: 'R6', lure: 'P-Line Laser Minnow 2oz (PLM2)', role: 'troll', leadFt: 60 }] },
          legs: PICKED.map((p) => ({ runId: p.runId, deploy: { port: 'R5', starboard: 'R6' }, why: 'x' })),
          stops: [], changes: [],
        });
      },
      planArgs: { water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-07-29',
                  species: ['Striped Bass'], usableAh: 80, tackle: TACKLE, conditions: {} },
    });
    expect(r.order).toEqual(dayOrder(PICKED, OPTS).order);
    expect(sent.user).toMatch(/the shortest route through them it could find/);
    expect(sent.user).not.toMatch(/SEARCH order/);
    expect(sent.user).not.toMatch(/ALREADY CHOSE THIS WATER AND THIS ORDER/);
    expect(sent.user).not.toMatch(/veto/);
  });
});

describe('the rod numbers in the model\'s sentences follow the re-seat', () => {
  // DD4 is tie-only and keeps R1. The three snap-friendly baits fill the snap rods first, in the
  // order they were named, and the third spills back onto a leader rod: R2→R5, R5→R6, R6→R2.
  const res = {
    loadout: {
      why: 'R5 is the deep bait and R6 the shallow one',
      rods: [{ id: 'R1', lure: 'DD4 Crankbait (25ft+)', role: 'troll', leadFt: 150,
               why: 'goes out beside R5 on the deep legs' },
             { id: 'R2', lure: 'Swimbait 5" – Jighead', role: 'troll', leadFt: 75 },
             { id: 'R5', lure: 'P-Line Laser Minnow 2oz (PLM2)', role: 'troll', leadFt: 95 },
             { id: 'R6', lure: '3" Lipless Crankbait', role: 'troll', leadFt: 60 }],
    },
    legs: [{ runId: 'lake_murray#12606', deploy: { port: 'R6', starboard: 'R5' },
             why: 'R6 runs about 18 ft and R5 about 26 ft; R2 waits behind the seat',
             ifNotProducing: { rodId: 'R2', insteadOf: 'R6', why: 'swap R6 for R2 if it is quiet' } }],
    stops: [{ runId: 'lake_murray#12606', id: 'x:s0', rods: ['R5'], durationMin: 10,
              why: 'the ledge', presentation: 'Take a few casts of R6 lipless, then jig R5',
              positioning: 'hover' }],
    changes: [],
    notes: { scoutNotes: 'Troll today.', fishfinderNarrative: 'Mark them, then set R5 at 36 ft.' },
  };
  const a = planArgsFrom(res, [{ runId: 'lake_murray#12606' }], { tackle: TACKLE, connectionOf });
  const lureOn = (id) => a.loadout.rods.find((r) => r.id === id).lure;

  it('seats the rods the way the app always has', () => {
    expect(lureOn('R1')).toBe('DD4 Crankbait (25ft+)');
    expect(lureOn('R5')).toBe('Swimbait 5" – Jighead');
    expect(lureOn('R6')).toBe('P-Line Laser Minnow 2oz (PLM2)');
    expect(lureOn('R2')).toBe('3" Lipless Crankbait');
    expect(a.deploy['lake_murray#12606']).toEqual({ port: 'R2', starboard: 'R6' });
  });

  it('rewrites every id the model wrote, once, without chaining', () => {
    const leg = a.candidates[0];
    // R6 (lipless) is now R2, R5 (Laser) is now R6, R2 (swimbait) is now R5 -- and R2 must not go
    // on to become R6 because R5→R6 is also in the map.
    expect(leg.why).toBe('R2 runs about 18 ft and R6 about 26 ft; R5 waits behind the seat');
    expect(leg.ifNotProducing).toEqual({ rodId: 'R5', insteadOf: 'R2',
                                         why: 'swap R2 for R5 if it is quiet' });
    expect(a.stops[0].presentation).toBe('Take a few casts of R2 lipless, then jig R6');
    expect(a.notes.fishfinderNarrative).toBe('Mark them, then set R6 at 36 ft.');
    expect(a.loadout.why).toBe('R6 is the deep bait and R2 the shallow one');
    expect(a.loadout.rods.find((r) => r.id === 'R1').why).toBe('goes out beside R6 on the deep legs');
  });

  it('and the lure each sentence names is the lure on that rod now', () => {
    expect(lureOn('R2')).toMatch(/Lipless/);
    expect(lureOn('R6')).toMatch(/Laser Minnow/);
  });
});

describe('the "if they are not producing" line reaches what is drawn', () => {
  it('is in the troll entry the panel, the print and the export read', async () => {
    const r = await planFromWater({
      picked: PICKED, spots: [], ramp: RAMP, slug: 'wateree_lake', usableAh: 80, windowMin: 480,
      launchTime: '06:30', returnTime: '13:00', tackle: TACKLE, connectionOf,
      askModel: async () => JSON.stringify({
        loadout: { rods: [{ id: 'R5', lure: '3" Lipless Crankbait', role: 'troll', leadFt: 60 },
                          { id: 'R6', lure: 'P-Line Laser Minnow 2oz (PLM2)', role: 'troll', leadFt: 60 },
                          { id: 'R2', lure: 'Swimbait 5" – Jighead', role: 'troll', leadFt: 60 }] },
        legs: PICKED.map((p) => ({ runId: p.runId, deploy: { port: 'R5', starboard: 'R6' },
                                   why: 'the ledge here',
                                   ifNotProducing: { rodId: 'R2', insteadOf: 'R5', why: 'quieter' } })),
        stops: [], changes: [],
      }),
      planArgs: { water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-07-29',
                  species: ['Striped Bass'], usableAh: 80, tackle: TACKLE, conditions: {} },
    });
    const built = planToTimeline(r.plan);
    const troll = built.timeline.filter((e) => e.legType === 'troll');
    expect(troll.length > 0).toBe(true);
    for (const e of troll) {
      expect(e.why.startsWith('the ledge here')).toBe(true);
      expect(e.why).toMatch(/If they are not producing: put R\d \(Swimbait/);
    }
  });
});

describe('a mark the lake has dropped off reads as dry', () => {
  const leg = {
    id: 'L1', type: 'troll', depthFt: 11, depthMinFt: 7, depthMaxFt: 27, drawdownFt: 5.56,
    runId: 'lake_murray#10210', startM: 0, lengthM: 1000,
    coordinates: [[-81.3279, 34.0878], [-81.3279, 34.0968]],
    marks: [{ id: 'p5', type: 'point', depthFt: 1.4, at: [-81.32748, 34.09559], atM: 778, charted: true }],
    stops: [],
  };
  it('names it dry and says so in the note, with the chart\'s figure kept', () => {
    const w = planWaypoints({ legs: [leg] }, [-81.3289, 34.0943], 'r', { marks: true })
      .find((x) => x.chartMark);
    expect(w.name).toBe('point dry');
    expect(w.chartDepth).toBe(1.4);
    expect(w.tacticalNote).toMatch(/1\.4 ft on the chart, out of the water today with the lake 5\.56 ft below the level its chart was made at/);
  });
  it('a stop on one says dry too, and with no level published the chart stands', () => {
    // Ten characters on his unit (2026-09-28): the id and the kind in the name, the depth in the
    // comment.
    expect(stopName({ id: 'S1.1', structureType: 'point', depthFt: 1.4 }, 5.56)).toBe('S1.1 point');
    expect(stopUnit({ id: 'S1.1', structureType: 'point', depthFt: 1.4 }, 5.56).cmt).toBe('point dry');
    expect(stopUnit({ id: 'S1.1', structureType: 'point', depthFt: 1.4 }).cmt).toBe('point 1ft');
  });
});
