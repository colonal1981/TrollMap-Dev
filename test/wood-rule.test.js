// HIS RULE FOR THE WOOD UNDER A TROLLING PASS.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-11-03: "i would say less than 10 ft out from the side of the boat... and as far as above
// i would say we need 5ft of clearance... just because i actually have no idea how deep my lures
// are". So a piece within 10 ft of the line is under the lures, and it is a target for a rod only
// when its top today is 5 ft or more below that rod's deep end. Anything closer is a snag; wood with
// no height yet is a snag. Run on the real pieces in test/fixtures/wood/, under a synthetic leg.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';

const noop = () => {};
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {} }), addEventListener: noop, readyState: 'complete',
};
const { assemblePlan, planCues, rodWindowOnLeg } = await import('../js/modules/plan-assemble.js');
const { woodOnLeg, woodWarning, woodCueText, nearestOnLine } = await import('../js/modules/plan-wood.js');
const { woodPieces, topToday, woodMarkLabel, markRadiusPx, HIS_PASS_M } = await import('../js/utils/wood.js');
const { belowFullPoolTodayFt } = await import('../js/utils/water-conditions.js');
const { metresBetween } = await import('../js/modules/plan-candidates.js');
const { riseSentence } = await import('../js/modules/plan-assemble.js');
const { TACKLE_INVENTORY } = await import('../js/data/tackle-inventory.js');

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (slug) => JSON.parse(readFileSync(join(here, 'fixtures', 'wood', `${slug}.json`), 'utf8'));

// THE PACK'S SHAPE, from the source the way Scripts/build_wood.py writes it (test_build_wood.py holds
// the builder to it): one Point per piece, every read, height the largest bottom - top.
const asPack = (src) => ({
  type: 'FeatureCollection', slug: src.slug, level: src.level,
  features: src.pieces.map((p) => {
    const hs = p.reads.filter((r) => r.top_ft != null && r.bottom_ft != null)
      .map((r) => r.bottom_ft - r.top_ft);
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
             properties: { id: p.id, kind: p.kind, what: p.what ?? null, seen: p.seen ?? null,
                           his_mark: p.his_mark ?? null, reads: p.reads,
                           height_ft: hs.length ? Math.round(Math.max(...hs) * 10) / 10 : null } };
  }),
});
const MARION = asPack(fixture('lake_marion'));
const BATES = asPack(fixture('bates_old_river'));
const only = (fc, id) => ({ ...fc, features: fc.features.filter((f) => f.properties.id === id) });
const pieceOf = (fc, id) => woodPieces(only(fc, id))[0];

// A LAKE AT A LEVEL, the shape readConditions() gives. Marion's gauge is on NGVD29, full pool 76.8.
const marionAt = (levelFt) => ({ featureType: 'lake', fullPoolFt: 76.8, levelFt });

// A STRAIGHT NORTH-SOUTH LINE 200 m LONG, its middle beside the piece, `offFt` east of it.
const FT = 0.3048;
function lineBeside(piece, offFt) {
  const [lon, lat] = piece.at;
  const kx = metresBetween([lon, lat], [lon + 1e-3, lat]) / 1e-3;
  const ky = metresBetween([lon, lat], [lon, lat + 1e-3]) / 1e-3;
  const x = lon + (offFt * FT) / kx;
  return [[x, lat - 100 / ky], [x, lat + 100 / ky]];
}

const lureByName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
const RODS = [
  { id: 'R1', rig: 'snap', role: 'troll', lure: 'Squarebill Crankbait', leadFt: 40 },
  { id: 'R2', rig: 'snap', role: 'troll', lure: 'MR Crankbait (6-12ft)', leadFt: 40 },
];
for (const r of RODS) if (!lureByName(r.lure)) throw new Error(`fixture lure missing: ${r.lure}`);
const DEPLOY = { port: 'R1', starboard: 'R2' };

// THE RODS' DEPTHS GIVEN THROUGH rodPlan[id].runsDepthFt, which the shared window prefers.
function onLeg(fc, id, { offFt = 0, belowTodayFt = null, r1 = [0, 1], r2 = [2, 4], deploy = DEPLOY } = {}) {
  const p = pieceOf(fc, id);
  const rodPlan = { R1: { runsDepthFt: r1 }, R2: { runsDepthFt: r2 } };
  return woodOnLeg({
    coords: lineBeside(p, offFt), pieces: woodPieces(fc), deploy, rods: RODS, belowTodayFt,
    windowFor: (rod) => rodWindowOnLeg(rod, rodPlan, 2.0, lureByName),
  }).filter((e) => e.id === id);
}
const verdicts = (e) => Object.fromEntries(e.rods.map((r) => [r.rodId, r.verdict]));
const sentence = (e) => woodWarning('lake_marion#1', e, `about ${riseSentence([e.atM])}`);

describe('today\'s feet below full pool, alone', () => {
  it('is full pool less the level, and the stated figure wins', () => {
    expect(belowFullPoolTodayFt(marionAt(74.37))).toBe(2.43);
    expect(belowFullPoolTodayFt({ ...marionAt(74.37), belowFullPoolFt: 3 })).toBe(3);
  });
  it('is NOT less the chart\'s own level, which is poolOffsetFt()\'s business', () => {
    expect(belowFullPoolTodayFt({ ...marionAt(74.37), chartBelowFullPoolFt: 2 })).toBe(2.43);
  });
  it('is null on a river, a failed read, or a water with no level', () => {
    expect(belowFullPoolTodayFt({ featureType: 'river', levelFt: 3, fullPoolFt: 5 })).toBe(null);
    expect(belowFullPoolTodayFt({ error: 'x', levelFt: 74, fullPoolFt: 76.8 })).toBe(null);
    expect(belowFullPoolTodayFt({ featureType: 'lake' })).toBe(null);
    expect(belowFullPoolTodayFt(null)).toBe(null);
  });
});

describe('Marion m047, two pictures of one snag, lake at 74.37 today (2.43 below)', () => {
  const [e] = onLeg(MARION, 'lake_marion-2026-11-02-m047', { belowTodayFt: 2.43 });
  it('is under the lures, its top today the shallower read: 6.5', () => {
    expect(e.topTodayFt).toBe(6.5);
    expect(e.topBasis).toBe('today');
  });
  it('is a target for the rod running 0-1 ft (5.5 clear), a snag for the one at 2-4 (2.5)', () => {
    expect(verdicts(e)).toEqual({ R1: 'target', R2: 'snag' });
    expect(e.rods.map((r) => r.deepFt)).toEqual([1, 4]);
  });
  it('is said as a snag for R2, naming where it is, its top, and how deep R2 runs', () => {
    const w = sentence(e);
    expect(w.includes('m into the pass')).toBe(true);
    expect(w.includes('top 6.5 ft at today\'s level')).toBe(true);
    expect(w.includes('R2 runs to 4 ft')).toBe(true);
    expect(w.includes('R1 at 1 ft clears it by 5.5 ft')).toBe(true);
  });
});

describe('the same, the lake 1 ft lower today (3.43 below)', () => {
  const [e] = onLeg(MARION, 'lake_marion-2026-11-02-m047', { belowTodayFt: 3.43 });
  it('brings the top up to 5.5, and the 0-1 ft rod becomes a snag (4.5 clear)', () => {
    expect(e.topTodayFt).toBe(5.5);
    expect(verdicts(e)).toEqual({ R1: 'snag', R2: 'snag' });
    const w = sentence(e);
    expect(w.includes('with the lake 2.43 ft below full pool; it is 3.43 below today')).toBe(true);
  });
});

describe('Bates 23, a water with no level', () => {
  it('stands on the shallower read, as read on 11/1: 10.3', () => {
    const [e] = onLeg(BATES, 'bates_old_river-23', { r1: [0, 5], r2: [0, 6] });
    expect(e.topTodayFt).toBe(10.3);
    expect(e.topBasis).toBe('as read on 11/1');
    expect(verdicts(e)).toEqual({ R1: 'target', R2: 'snag' });       // 5.3 clear, 4.3 clear
    expect(sentence(e).includes('top 10.3 ft as read on 11/1')).toBe(true);
  });
});

describe('Bates 24, his laydown, never gone over', () => {
  const [e] = onLeg(BATES, 'bates_old_river-24', { r1: [0, 1], r2: [0, 1] });
  it('has no top and is a snag for every rod', () => {
    expect(e.topTodayFt).toBe(null);
    expect(e.topBasis).toBe(null);
    expect(verdicts(e)).toEqual({ R1: 'snag', R2: 'snag' });
  });
  it('and the sentence says it has never been gone over', () => {
    expect(sentence(e).includes('never been gone over')).toBe(true);
    expect(woodCueText(e, 27).includes('never gone over')).toBe(true);
  });
});

describe('his 10 ft either side of the line', () => {
  it('counts a piece 9 ft off and not one 11 ft off', () => {
    expect(onLeg(MARION, 'lake_marion-2026-11-02-m047', { offFt: 9 }).length).toBe(1);
    expect(onLeg(MARION, 'lake_marion-2026-11-02-m047', { offFt: 11 }).length).toBe(0);
    expect(HIS_PASS_M).toBe(10 * 0.3048);
  });
  it('measures to the nearest point of the line', () => {
    const p = pieceOf(MARION, 'lake_marion-2026-11-02-m047');
    const hit = nearestOnLine(lineBeside(p, 9), p.at);
    expect(Math.abs(hit.offM - 9 * FT) < 0.01).toBe(true);
    expect(Math.abs(hit.atM - 100) < 0.5).toBe(true);
  });
});

describe('a rod whose depth the app cannot measure', () => {
  it('is counted as running below, and the sentence says so', () => {
    const p = pieceOf(MARION, 'lake_marion-2026-11-02-m047');
    const [e] = woodOnLeg({ coords: lineBeside(p, 0), pieces: [p], deploy: DEPLOY, rods: RODS,
                            belowTodayFt: 2.43, windowFor: () => null });
    expect(verdicts(e)).toEqual({ R1: 'snag', R2: 'snag' });
    expect(sentence(e).includes('R1 has no depth the app can measure, so it is counted as '
                                + 'running below it')).toBe(true);
  });
});

describe('nothing to say', () => {
  const p = pieceOf(MARION, 'lake_marion-2026-11-02-m047');
  it('on a leg with no rods in the water', () => {
    expect(woodOnLeg({ coords: lineBeside(p, 0), pieces: [p], deploy: null, rods: RODS,
                       windowFor: () => ({ min: 0, max: 1 }) })).toEqual([]);
  });
  it('with no wood', () => {
    expect(woodOnLeg({ coords: lineBeside(p, 0), pieces: [], deploy: DEPLOY, rods: RODS,
                       windowFor: () => ({ min: 0, max: 1 }) })).toEqual([]);
  });
});

// ── THROUGH THE ASSEMBLER, as both planners reach it ─────────────────────────────────────────────
const M047 = pieceOf(MARION, 'lake_marion-2026-11-02-m047');
const RUN = 'lake_marion#1';
const LINE = lineBeside(M047, 3);
const LEG = {
  runId: RUN, runIndex: 1, startM: 0, lengthM: Math.round(metresBetween(LINE[0], LINE[1])),
  depthFt: 12, depthMinFt: 10, depthMaxFt: 14, maxRunDepthFt: 12,
  start: LINE[0], end: LINE[1], coordinates: LINE, passes: [], support: null, why: 'the flat',
};
const build = (extra = {}) => assemblePlan({
  transit: (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b] }),
  candidates: [{ ...LEG, ...(extra.leg || {}) }], launch: LINE[0], loadout: { rods: RODS },
  slug: 'lake_marion', water: 'Lake Marion, SC', ramp: 'Rowland',
  launchTime: '06:00', returnTime: '15:00', usableAh: 80, lureByName,
  deploy: 'deploy' in extra ? extra.deploy : { [RUN]: DEPLOY },
  waterState: marionAt(74.37),
  ...(extra.o || {}),
});
const trollLegs = (plan) => plan.legs.filter((l) => l.type === 'troll');
const woodWarnings = (plan) => plan.warnings.filter((w) => /: wood about/.test(w));

describe('in assemblePlan()', () => {
  it('stamps leg.wood with the contract\'s fields, and every rod on the window sonarCheck reads', () => {
    const plan = build({ o: { wood: MARION.features } });
    const leg = trollLegs(plan)[0];
    expect(Array.isArray(leg.wood)).toBe(true);
    const e = leg.wood.find((w) => w.id === 'lake_marion-2026-11-02-m047');
    expect(Object.keys(e).sort()).toEqual(['at', 'atM', 'id', 'kind', 'offM', 'rods', 'topBasis',
                                           'topTodayFt', 'what'].sort());
    expect(e.topTodayFt).toBe(6.5);
    // THE SAME WINDOW: the deeper of the two rods' deep ends is sonarCheck's floor.
    expect(Math.max(...e.rods.map((r) => r.deepFt))).toBe(leg.sonarCheck.pairFt[1]);
  });

  it('cues it one spread-length before the piece, kind wood', () => {
    const plan = build({ o: { wood: MARION.features } });
    const leg = trollLegs(plan)[0];
    const e = leg.wood.find((w) => w.id === 'lake_marion-2026-11-02-m047');
    const cue = planCues(plan).find((c) => c.kind === 'wood' && c.woodId === e.id);
    expect(cue.atM).toBe(leg.startM + Math.max(0, e.atM - 27));
    expect(typeof cue.what).toBe('string');
  });

  it('warns once per snag on the leg, and moves nothing', () => {
    const without = build();
    const plan = build({ o: { wood: MARION.features } });
    const a = trollLegs(without)[0], b = trollLegs(plan)[0];
    expect(b.coordinates).toEqual(a.coordinates);
    expect(b.deploy).toEqual(a.deploy);
    expect(b.sonarCheck).toEqual(a.sonarCheck);
    const snags = b.wood.filter((e) => e.rods.some((r) => r.verdict === 'snag')).length;
    expect(woodWarnings(plan).length).toBe(snags);
  });

  it('mirrors the wood onto a pass fished back', () => {
    const plan = build({ leg: { trollPasses: 2 }, o: { wood: MARION.features } });
    const [one, two] = trollLegs(plan);
    expect(two.wood.length).toBe(one.wood.length);
    const e1 = one.wood.find((w) => w.id === 'lake_marion-2026-11-02-m047');
    const e2 = two.wood.find((w) => w.id === 'lake_marion-2026-11-02-m047');
    expect(e2.atM).toBe(Math.max(0, Math.round(one.lengthM - e1.atM)));
  });

  it('says nothing and throws nothing with no wood.geojson, no deploy, or on a transit', () => {
    for (const plan of [build(), build({ o: { wood: [] } }), build({ o: { wood: null } }),
                        build({ deploy: {}, o: { wood: MARION.features } })]) {
      expect(woodWarnings(plan)).toEqual([]);
      for (const l of plan.legs) expect(l.wood).toBe(undefined);
      expect(planCues(plan).filter((c) => c.kind === 'wood')).toEqual([]);
    }
  });
});

describe('the map\'s marks', () => {
  it('label today\'s top, or the top as read with its date', () => {
    expect(woodMarkLabel(topToday(pieceOf(MARION, 'lake_marion-2026-11-02-m047'), 2.43))).toBe('6 ft');
    expect(woodMarkLabel(topToday(pieceOf(BATES, 'bates_old_river-23'), null))).toBe('10 ft on 11/1');
    expect(woodMarkLabel(topToday(pieceOf(BATES, 'bates_old_river-24'), null))).toBe('');
  });
  it('are sized against the tallest piece on the water, by area', () => {
    expect(markRadiusPx(8, 8, 10)).toBe(10);
    expect(markRadiusPx(2, 8, 10)).toBe(5);
    expect(markRadiusPx(null, 8, 10)).toBe(10);
  });
});

describe('on the leg\'s card', () => {
  it('counts the wood under the pass, and carries the list', async () => {
    const { planToTimeline } = await import('../js/modules/plan-to-timeline.js');
    const plan = build({ o: { wood: MARION.features } });
    const card = planToTimeline(plan).cards.find((c) => c.icon === '🎣');
    expect(card.longDesc.includes('Wood under this pass:')).toBe(true);
    expect(Array.isArray(card.wood)).toBe(true);
    const none = planToTimeline(build()).cards.find((c) => c.icon === '🎣');
    expect(none.longDesc.includes('Wood under')).toBe(false);
  });
});
