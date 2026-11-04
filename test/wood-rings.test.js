// THE SNAGS AS GARMIN BOUNDARIES: HIS 10 FT ROUND EACH, AND A STUMP FIELD AS ONE OUTLINE.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Optional at Save ADM, off unless ticked. Ryan, 2026-11-03: "i just don't want to clutter up the
// screen with waypoints". So rings that touch are one boundary, not a pin per stump.
import { describe, it, expect } from './expect-shim.mjs';

globalThis.window = globalThis.window || globalThis;
const { woodBoundaries, unionOutline, snagsOf, RING_POINTS } = await import('../js/utils/wood-rings.js');
const { admFile, ADM_NAME_CHARS } = await import('../js/utils/adm.js');
const { HIS_PASS_M } = await import('../js/utils/wood.js');
const { geoDistanceM } = await import('../js/utils/geo.js');

const FT = 0.3048;
const R = HIS_PASS_M;
// m047's position, and a piece `eastFt` east of it.
const AT = [-80.210405, 33.566154];
const kx = geoDistanceM(AT[1], AT[0], AT[1], AT[0] + 1e-3) / 1e-3;
const east = (ft) => [AT[0] + (ft * FT) / kx, AT[1]];
const entry = (id, at, verdict = 'snag') => ({ id, at, atM: 0, offM: 0, topTodayFt: 5, topBasis: 'today',
                                               rods: [{ rodId: 'R1', deepFt: 2, verdict }] });
const planOf = (...legs) => ({ legs: legs.map((wood, i) => ({ id: `L${i + 1}`, type: 'troll', wood })) });
const toM = (p, c) => geoDistanceM(p[0], p[1], c[1], c[0]);

describe('the ring\'s points', () => {
  it('are the fewest that keep a chord within a tenth of a foot of his 10 ft circle', () => {
    expect(RING_POINTS).toBe(23);
    expect(10 * (1 - Math.cos(Math.PI / RING_POINTS)) <= 0.1).toBe(true);
    expect(10 * (1 - Math.cos(Math.PI / (RING_POINTS - 1))) > 0.1).toBe(true);
  });
});

describe('one snag', () => {
  const [b] = woodBoundaries(planOf([entry('a', AT)]));
  it('is a ring of his 10 ft, every point on it', () => {
    expect(b.pts.length).toBe(RING_POINTS);
    for (const p of b.pts) expect(Math.abs(toM(p, AT) - R) < 0.01).toBe(true);
  });
  it('is named for its leg, with the alarm off', () => {
    expect(b.name).toBe('TM wood L1');
    expect(b.alarm).toBe(false);
    expect(b.warnM).toBe(0);
  });
});

describe('rings that touch', () => {
  it('are one outline, every point on one ring and inside none', () => {
    const at = [AT, east(12), east(24)];
    const bs = woodBoundaries(planOf([entry('a', at[0]), entry('b', at[1]), entry('c', at[2])]));
    expect(bs.length).toBe(1);
    for (const p of bs[0].pts) {
      const ds = at.map((c) => toM(p, c));
      expect(Math.abs(Math.min(...ds) - R) < 0.01).toBe(true);
    }
    // It reaches both outer ends: 10 ft past the first stump and past the last.
    const xs = bs[0].pts.map((p) => p[1]);
    expect(Math.min(...xs) < east(-9.9)[0]).toBe(true);
    expect(Math.max(...xs) > east(33.9)[0]).toBe(true);
  });
  it('and rings that do not touch stay apart, the second on a leg numbered', () => {
    const bs = woodBoundaries(planOf([entry('a', AT), entry('b', east(30))]));
    expect(bs.map((b) => b.name)).toEqual(['TM wood L1', 'TM wood L1.2']);
  });
});

describe('what goes in', () => {
  it('a snag only, once, under the first leg that meets it', () => {
    const plan = planOf([entry('t', AT, 'target')], [entry('a', east(40))], [entry('a', east(40))]);
    expect(snagsOf(plan).map((s) => [s.id, s.legId])).toEqual([['a', 'L2']]);
    expect(woodBoundaries(plan).map((b) => b.name)).toEqual(['TM wood L2']);
  });
  it('nothing for a plan with no snag', () => {
    expect(woodBoundaries(planOf([entry('t', AT, 'target')]))).toEqual([]);
    expect(woodBoundaries({ legs: [] })).toEqual([]);
    expect(woodBoundaries(null)).toEqual([]);
  });
  it('names are cut to what the unit shows', () => {
    const plan = { legs: [{ id: 'L1234567890', wood: [entry('a', AT)] }] };
    expect(woodBoundaries(plan)[0].name.length <= ADM_NAME_CHARS).toBe(true);
  });
});

describe('the outline of a stump field round an open patch', () => {
  it('is its outside, not its hole', () => {
    // Eight stumps on a circle of radius 2.2r: each ring meets its neighbours, the middle stays open.
    const c = Array.from({ length: 8 }, (_, i) => [2.2 * R * Math.cos((i * Math.PI) / 4),
                                                   2.2 * R * Math.sin((i * Math.PI) / 4)]);
    const o = unionOutline(c, R);
    for (const p of o) expect(Math.hypot(p[0], p[1]) > 2.2 * R).toBe(true);
  });
});

describe('written with the existing BDY writer', () => {
  it('goes into an ADM with its name and the alarm byte off', () => {
    const bs = woodBoundaries(planOf([entry('a', AT)]));
    const f = admFile(bs, { when: new Date(2026, 10, 4), rand: () => 0.5 });
    const txt = Buffer.from(f).toString('latin1');
    const at = txt.indexOf('TM wood L1');
    expect(at > 0).toBe(true);
    // The record starts 20 bytes before its name; the alarm byte is record + 103.
    expect(f[at - 20 + 103]).toBe(0);
  });
});
