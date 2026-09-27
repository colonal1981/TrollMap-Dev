// PICK WATER PINS THE STRUCTURE, STOPS AT THE SPOTS, AND READS TODAY'S WATER.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan's Pick Water plan for Lake Murray from Hilton, 2026-09-27, and what was wrong with it:
//
//   1. Every GPX flag sat on his trolling line 52-100 m from the point, hump or hole it named, and
//      said "charted position -- compare with the sounder". The point stop was 308 ft from the point.
//   2. 29 cast spots Pick Water found within 1-50 m of his route -- ledges, scour holes, a roadbed,
//      creek channels, a bridge, Fish Attractor #8 -- went to the model keyed by the tab's own piece
//      key (`w123`), with no id, and not one of them could become a stop.
//   3. The page he picked from read the chart at full pool with the lake 5.54 ft down: a pass it
//      called 6-15 ft was about 1.5-9.5 ft that morning.
//   4. The model put an MR crankbait on three legs whose `cannotUse` named it, and a swimbait was
//      left on 114 ft of lead over a pass 5.5 ft deep in the middle.
import { describe, it, expect } from './expect-shim.mjs';
import { planFromWater } from '../js/modules/plan-from-water.js';
import { reasons, todayFt, todayView } from '../js/modules/plan-water.js';
import { structureIndex } from '../js/modules/plan-candidates.js';
import { cannotUseBreaks } from '../js/modules/plan-prompt.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';
import { connectionFor } from '../js/data/lure-knowledge.js';

const RAMP = [-80.7107, 34.3486];

function piece(key, lon, lat, holdsFt, extra = {}) {
  const coords = Array.from({ length: 40 }, (_, i) => [lon + i * 0.0004, lat + i * 0.00012]);
  return {
    key, runId: `wateree_lake#${key}`, coords, lengthM: 1800, laneLengthM: 4000, holdsFt,
    near: [{ t: 'hump', s: 400, d: 12 }, { t: 'hazard', s: 900, d: 30 }],
    partners: [], reasons: { for: ['1.1 mi unbroken'], against: [] },
    envelope: Array(20).fill(holdsFt + 2), envelopeStepM: 90, chartedFrac: 1,
    ...extra,
  };
}

const LURES = ['3" Lipless Crankbait', 'Dr.Fish Diamond Jig / Jigging Spoon 1oz'];
const answer = (picked, o = {}) => JSON.stringify({
  loadout: { rods: o.rods || [{ id: 'R1', lure: LURES[0], role: 'troll', leadFt: 60 },
                              { id: 'R5', lure: LURES[1], role: 'troll', leadFt: 60 }] },
  legs: picked.map((p) => ({ runId: p.runId, speedMph: 2.0,
                             deploy: o.deploy || { port: 'R1', starboard: 'R5' }, why: 'the ledge' })),
  stops: o.stops || [], changes: [],
});

const lureByName = (name) => {
  const n = String(name || '').trim().toLowerCase();
  return n ? TACKLE_INVENTORY.find((l) => String(l.name).toLowerCase() === n) || null : null;
};

const build = (picked, extra = {}) => planFromWater({
  picked, spots: [], ramp: RAMP, slug: 'wateree_lake', usableAh: 80, windowMin: 480,
  launchTime: '06:30', returnTime: '13:00', askModel: async () => answer(picked),
  tackle: TACKLE_INVENTORY.filter((l) => l.trollable).map((l) => l.name),
  connectionOf: (n) => {
    const hit = TACKLE_INVENTORY.find((l) => l.name === n);
    return hit ? connectionFor(hit.type) : null;
  },
  lureByName,
  planArgs: { water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-07-29',
              species: ['Striped Bass'], usableAh: 80, tackle: LURES, conditions: {} },
  ...extra,
});

const trollLegs = (r) => r.plan.legs.filter((l) => l.type !== 'transit');

describe('a mark on a picked leg is pinned where the thing is', () => {
  // piece 81's hump mark is 400 m along a 4,000 m lane: vertex round(0.1 * 39) = 4.
  const P = piece(81, -80.70, 34.35, 22);
  const onLine = P.coords[4];
  // The real hump, about 12 m off the line to the north.
  const hump = [onLine[0], onLine[1] + 0.00011];
  const structures = structureIndex([
    { type: 'Feature', geometry: { type: 'Point', coordinates: hump },
      properties: { kind: 'hump', id: 'hump_7', depth_ft: 18 } },
  ]);

  it('takes the charted position, not the point on the line, and says it is charted', async () => {
    const r = await build([P], { structures });
    const mark = trollLegs(r)[0].marks.find((m) => m.type === 'hump');
    expect(mark.at).toEqual(hump);
    expect(mark.charted).toBe(true);
    expect(mark.depthFt).toBe(18);
  });

  it('and a mark nothing resolves says it is only a point on the line', async () => {
    const r = await build([P], { structures });
    const hazard = trollLegs(r)[0].marks.find((m) => m.type === 'hazard');
    expect(hazard.charted).toBe(false);
  });
});

describe('a cast spot on his route is a stop the plan can make', () => {
  const P = piece(81, -80.70, 34.35, 22);
  const at = P.coords[10];
  const spot = { key: 's1', type: 'brush_pile', what: 'brush pile', at, offM: 0,
                 structureId: null, depthFt: null };

  it('reaches the model with the leg\'s runId and an id that stops there', async () => {
    let asked = null;
    const r = await build([P], {
      spots: [spot],
      askModel: async (req) => { asked = req; return answer([P]); },
    });
    expect(r.plan).toBeTruthy();
    const m = asked.user.match(/"id":"(wateree_lake#\d+:s\d+)","what":"brush pile","onLeg":"([^"]+)"/);
    expect(Boolean(m)).toBe(true);
    expect(m[2]).toBe(P.runId);
    expect(/"onLeg":"w\d+"/.test(asked.user)).toBe(false);
  });

  it('and when the model names it, the stop is placed on the spot itself', async () => {
    const r = await build([P], {
      spots: [spot],
      askModel: async (req) => {
        const m = req.user.match(/"id":"(wateree_lake#\d+:s\d+)","what":"brush pile","onLeg":"([^"]+)"/);
        return answer([P], { stops: [{ runId: m[2], id: m[1], rods: ['R1'], durationMin: 15,
                                       why: 'brush on the edge' }] });
      },
    });
    const stops = trollLegs(r).flatMap((l) => l.stops || []);
    expect(stops.length).toBe(1);
    expect(stops[0].at).toEqual(at);
  });

  it('a spot he ticked is a stop even when the model leaves it out', async () => {
    const r = await build([P], { spots: [spot], chosenSpotKeys: ['s1'] });
    const stops = trollLegs(r).flatMap((l) => l.stops || []);
    expect(stops.length).toBe(1);
    expect(r.problems.some((p) => /left out a spot you ticked/.test(p))).toBe(true);
  });
});

describe('the Water tab reads today\'s water', () => {
  it('todayFt takes the drawdown off and leaves a missing or unsounded depth alone', () => {
    expect(todayFt(16, 5.54)).toBe(10.5);
    expect(todayFt(3, 5.54)).toBe(0);
    expect(todayFt(-1, 5.54)).toBe(-1);
    expect(todayFt(null, 5.54)).toBe(null);
    expect(todayFt(16, null)).toBe(16);
  });

  it('the reasons describe the water he will be over, and the piece keeps the chart', () => {
    const P = piece(81, -80.70, 34.35, 14, { envelope: Array(20).fill(16),
                                               envelopeDeep: Array(20).fill(22) });
    const chart = reasons(P, { minM: 800 });
    const today = reasons(P, { minM: 800, todayOffsetFt: 5.54 });
    expect(chart.for[0]).toContain('16–22 ft of water');
    expect(today.for[0]).toContain('10.5–16.5 ft of water');
    // FOR DISPLAY ONLY. The plan subtracts the drawdown itself; taking it off the piece as well
    // would take it off twice.
    expect(P.envelope[0]).toBe(16);
    expect(todayView(P, 5.54).holdsFt).toBe(8.5);
  });

  it('and against a band, a pass shallower than it today is said to be', () => {
    const P = piece(81, -80.70, 34.35, 44, { envelope: Array(20).fill(46),
                                               envelopeDeep: Array(20).fill(52) });
    const today = reasons(P, { minM: 800, fishBandFt: [50, 70], todayOffsetFt: 5.54 });
    expect(today.against.some((s) => /tops out at 46.5 ft/.test(s))).toBe(true);
  });
});

describe('a bait the leg was told it cannot use goes back to the model once', () => {
  it('cannotUseBreaks finds a banned bait in the water', () => {
    const res = { loadout: { rods: [{ id: 'R2', lure: 'MR Crankbait (6-12ft)' },
                                    { id: 'R5', lure: LURES[1] }] },
                  legs: [{ runId: 'a#1', deploy: { port: 'R2', starboard: 'R5' } },
                         { runId: 'a#2', deploy: { port: 'R5', starboard: 'R2' } }] };
    const got = cannotUseBreaks(res, { 'a#1': ['MR Crankbait (6-12ft)'] });
    expect(got).toEqual([{ runId: 'a#1', rod: 'R2', lure: 'MR Crankbait (6-12ft)' }]);
    expect(cannotUseBreaks(res, {})).toEqual([]);
  });

  it('re-asks, and takes the answer that breaks the rule less', async () => {
    // A 10 ft ceiling: the MR crank is rated to 12 ft, so it is on this leg's cannotUse.
    const P = piece(81, -80.70, 34.35, 10);
    let calls = 0;
    const r = await build([P], {
      // The bag the prompt lists, as the Water tab sends it -- the MR has to be in it to be banned.
      planArgs: { water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-07-29',
                  species: ['Striped Bass'], usableAh: 80, conditions: {},
                  tackle: [...LURES, 'MR Crankbait (6-12ft)'] },
      askModel: async () => {
        calls += 1;
        return calls === 1
          ? answer([P], { rods: [{ id: 'R2', lure: 'MR Crankbait (6-12ft)', role: 'troll', leadFt: 36 },
                                 { id: 'R5', lure: LURES[1], role: 'troll', leadFt: 60 }],
                          deploy: { port: 'R2', starboard: 'R5' } })
          : answer([P]);
      },
    });
    expect(calls).toBe(2);
    expect(r.request.user.includes('THAT ANSWER BROKE A RULE')).toBe(true);
    const leg = trollLegs(r)[0];
    const lures = r.plan.loadout.rods.filter((x) => [leg.deploy.port, leg.deploy.starboard]
      .includes(x.id)).map((x) => x.lure);
    expect(lures.includes('MR Crankbait (6-12ft)')).toBe(false);
  });
});

describe('a lead bait no lead keeps off the rise is still brought up off the middle', () => {
  it('Leg 8: 2 ft at the rise, 8 ft in the middle, a 1 oz swimbait left at 114 ft', async () => {
    const swim = TACKLE_INVENTORY.find((l) => /^Swimbait 5/.test(l.name));
    const P = piece(81, -80.70, 34.35, 2, {
      water: { line: { medianFt: 8, sustainedMinFt: 2, minFt: 2, maxFt: 22 } },
    });
    const r = await build([P], {
      planArgs: { water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-07-29',
                  species: ['Striped Bass'], usableAh: 80, conditions: {},
                  tackle: [...LURES, swim.name] },
      askModel: async () => answer([P], {
        rods: [{ id: 'R1', lure: LURES[0], role: 'troll', leadFt: 60 },
               { id: 'R5', lure: swim.name, role: 'troll', leadFt: 114 }],
      }),
    });
    const said = [...r.problems, ...(r.plan.warnings || [])];
    const line = said.find((s) => /No lead keeps it off that rise, so the lead is shortened/.test(s));
    expect(Boolean(line)).toBe(true);
    const leg = trollLegs(r)[0];
    const r5 = (leg.rods || []).find((x) => x.id === 'R5' || x.rod === 'R5');
    if (r5 && Number.isFinite(r5.leadFt)) expect(r5.leadFt < 114).toBe(true);
  });
});
