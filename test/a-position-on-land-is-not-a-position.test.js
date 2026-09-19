import { describe, it, expect } from './expect-shim.mjs';
const { catchSupport } = await import('../js/modules/plan-candidates.js');
const { waterTest } = await import('../js/modules/river-drifts.js');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A POSITION ON LAND IS NOT A POSITION
//
// Ryan, 2026-09-19, after I had spent three separate guesses defending his phone's EXIF — first
// that his catches were simply downstream of the reaches offered, then that the registry had a
// hole, then that the delta was braided and he fished another channel:
//
//   "i am looking at the map and those coords for those fish are on land nowhere near the river"
//
// He was right and the evidence had been in front of me: nothing in 3,368 boundaries contained
// the point and the nearest thing of any kind was a farm pond 2.2 km away. His own Garmin, the
// same afternoon, put him 4 km from where the phone did.
//
// THE JOURNAL IS MIXED, NOT BAD. Three of his Bates Old River fixes land exactly inside that
// boundary — zero metres — and he has 32 distinct positions across 46 catches there. What it has
// never carried is a mark saying which fixes are trustworthy, so a bad one that lands near a line
// counts as evidence about that water and is indistinguishable from a real one.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// A CHANNEL, NOT A LAKE, and it has to be narrower than the search radius or this test cannot
// reach the thing it is testing. The first cut used a 1 km square with the line down the middle,
// so every point inside 300 m of the line was also inside the water and the off-water branch was
// never entered -- the fixture asserted the gate worked by never invoking it.
//
// 0.002 deg of longitude here is about 185 m, which is the Congaree's own p50 width of 135 m in
// the same order. A bad fix 139 m off the line is then genuinely on the bank.
const WATER = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
  geometry: { type: 'Polygon', coordinates: [[
    [-80.6460, 33.745], [-80.6440, 33.745], [-80.6440, 33.755], [-80.6460, 33.755], [-80.6460, 33.745],
  ]] } }] };
const LINE = [[-80.645, 33.746], [-80.645, 33.754]];
const ON   = { lat: 33.750, lon: -80.6452, species: 'Striped Bass', date: '2026-04-13' };
// 139 m east of the line -- well inside the 300 m radius -- and on the far side of the bank.
const OFF  = { lat: 33.750, lon: -80.6435, species: 'Striped Bass', date: '2026-04-13' };

describe('catchSupport screens a catch against the water it claims to be on', () => {
  it('counts a catch that is on the water', () => {
    const s = catchSupport(LINE, [ON], { water: waterTest(WATER) });
    expect(s.n).toBe(1);
    expect(s.offWater).toBe(0);
  });

  it('refuses one that is near the line but not on the water', () => {
    const s = catchSupport(LINE, [OFF], { water: waterTest(WATER) });
    expect(s.n).toBe(0);
    expect(s.nearestM).toBe(null);
  });

  it('COUNTS what it refused rather than dropping it silently', () => {
    // Three of his fish vanishing from a plan with no sentence about it is the same silence this
    // file keeps being fixed for. The number is his to act on -- it says a trip needs re-placing.
    const s = catchSupport(LINE, [ON, OFF, OFF], { water: waterTest(WATER) });
    expect(s.n).toBe(1);
    expect(s.offWater).toBe(2);
  });

  it('and does not touch the count when no boundary was supplied', () => {
    // "Outside" and "nothing to be outside of" are different answers. A pack with no boundary
    // screens nothing rather than rejecting everything.
    const s = catchSupport(LINE, [ON, OFF], {});
    expect(s.n).toBe(2);
    expect(s.offWater).toBe(0);
    expect(catchSupport(LINE, [ON, OFF], { water: waterTest(null) }).n).toBe(2);
  });

  it('screens on the water, not on the distance — a far catch is still just far', () => {
    const far = { lat: 33.8174, lon: -80.6838, species: 'Bowfin', date: '2025-08-30' };
    const s = catchSupport(LINE, [far], { water: waterTest(WATER) });
    expect(s.n).toBe(0);
    // Out of radius entirely, so it is not an off-water REJECTION, it is simply elsewhere.
    expect(s.offWater).toBe(0);
  });
});

describe('waterTest is one copy of the containment question', () => {
  it('answers null for a water with no boundary, so absence is distinguishable', () => {
    expect(waterTest(null)).toBe(null);
    expect(waterTest({ type: 'FeatureCollection', features: [] })).toBe(null);
  });

  it('takes a bare Feature as well as a collection', () => {
    const t = waterTest(WATER.features[0]);
    expect(typeof t).toBe('function');
    expect(t(-80.645, 33.750)).toBe(true);
    expect(t(-80.600, 33.750)).toBe(false);
  });
});
