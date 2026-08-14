import { describe, it, expect } from './expect-shim.mjs';
// access-index.js publishes legacy global helpers on `window` at module scope, so it needs one
// before it can be imported under node. Same shim dnr-registry-merge.test.js uses.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

const { displayLakeName, liveAccessFor, findExistingLakeKey, pruneAccessToRecord,
        absorbDuplicateEntries } = await import('../js/data/access-index.js');
const { makePredicate, setLiveAccessSource, isKeepAlways } = await import('../js/data/water-filter.js');

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE RAMP FACT COMES FROM THE FEED, NOT FROM THE FILE.
 *
 * Ryan, 2026-08-14, reading his own app:
 *
 *   > for the rivers for the planning tab... are you saying that those rivers do not have ramps
 *   > in the dnr database? because trollmap says: broad river 4 ramps, congaree 3 ramps, santee
 *   > 4 ramps, and wateree 3 ramps... so where are those coming from? the hard coded list? or
 *   > are they actually in scdnr
 *
 * They are actually in SCDNR, and `registry/lake_index.json` says `ramp_sources: 0` on all four
 * rows. The dropdown badge was already reading the live index; the FILTERS were not. So the
 * planner dropped water whose badge, in the same list, said how many ramps it had, and
 * KEEP_ALWAYS was quietly carrying those four rivers past a gate they should have walked
 * through on their own.
 *
 * THE NUMBERS BELOW ARE THE ONES OFF HIS SCREEN, and getting them takes the whole join. The raw
 * SC feed lists EIGHT ramps under the name "Broad River" — one of them at 32.39 N, the tidal
 * Broad River near Beaufort, 150 miles away — and the app says four. Asserting "more than zero"
 * would pass with the Beaufort ramp counted and would not have caught a single bug this join
 * has already had.
 *
 * Every row below is verbatim from registry/lake_index.json and the SC/NC /ramps and /paddle
 * snapshots of 2026-08-12.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

// ── The live feeds, exactly as the worker returns them: waterbody name -> access points ──────
const FEED = {
  SC: {
    ramps: {
      'Broad River': [
        ['99 Island', 35.02678, -81.48986],
        ['Broad River', 32.39197, -80.77581],          // tidal Broad River, Beaufort — not this water
        ["Dalton's Landing", 34.93595, -81.47303],
        ['Pick Hill Access', 35.04108, -81.49538],
        ['Sandy & Broad River', 34.57281, -81.42221],
        ['Shelton Ferry', 34.48854, -81.42429],
        ['Woods Ferry', 34.70983, -81.45617],
        ['Woods Ferry Recreation Area', 34.70321, -81.45383],
      ],
      'Congaree River': [
        ['Barney Jordan', 33.9649, -81.0357],
        ['Bates Bridge', 33.75342, -80.64513],
        ['Thomas H Newman', 33.94915, -81.02952],
      ],
      'Santee River': [
        ['Arrowhead Landing', 33.40441, -79.8633],
        ['Highway 52', 33.49487, -79.96049],
        ['Lenuds', 33.30431, -79.67896],
        ['McConnels', 33.24514, -79.52085],           // 3 km east of the registry bbox
        ['Wilsons', 33.44829, -80.15833],
      ],
      'Wateree River': [
        ['Highway 1', 34.24486, -80.65403],
        ['Lugoff', 34.33346, -80.69973],
        ['WT -Billy- Tolar', 33.94721, -80.62891],
      ],
    },
    paddle: {
      'Broad River': [
        ['Bowens River Access and Parking Area', 35.13373, -81.59041],
        ['Broad River Canoe Access', 34.25001, -81.32886],
        ['Cherokee Ford Recreation Area', 35.07479, -81.56091],
        ['Columbia Canal Diversion Dam', 34.03329, -81.06953],
        ['Harbison State Forest Canoe Access', 34.10451, -81.118],
        ['Lockhart Put In below Lockhart Dam #2', 34.7795, -81.45611],
        ['Lockhart Take Out above Lockhart Dam #1', 34.79724, -81.46145],
        ['Neal Shoals Dam Canoe Access', 34.66449, -81.44616],
        ['Ninety Nine Island Canoe Access', 35.02967, -81.49125],
        ['Peake-Alston Canoe Access', 34.24325, -81.31945],
        ['Riverfront Park Access', 34.00304, -81.05369],
        ["Strother's Landing", 34.39255, -81.39614],
      ],
      'Congaree River': [
        ['Granby Park Access', 33.98412, -81.04537],
        ['West Columbia Riverwalk', 33.99492, -81.05249],
      ],
      'Santee River': [
        ['Laurel Hill Landing', 33.37786, -79.8119],
      ],
      'Wateree River': [
        ['Access point below Wateree Dam', 34.33218, -80.69819],
        ['Camden Riverfront Environmental Park', 34.23475, -80.62999],
        ['Water River Veterans Park', 34.24669, -80.65556],
      ],
    },
  },
  NC: {
    // The Broad River crosses the state line, so NC lists its own — and its registry row's box
    // reaches south over the border. That interaction is asserted below; it is the difference
    // between six ramps and the four Ryan sees.
    ramps: { 'BROAD RIVER': [['US 221', 35.20626, -81.83844], ['US 221A', 35.21678, -81.7788]] },
    paddle: { 'BROAD RIVER': [['US 221', 35.20626, -81.83844], ['US 221A', 35.21678, -81.7788]] },
  },
};

// ── The registry rows, in the camelCase shape lake-registry.js hands the app ─────────────────
// `rampSources: 0` on every one of them. That is the defect, preserved.
const REG = [
  {
    slug: 'santee_river', name: 'Santee River', state: 'SC',
    displayName: 'Santee River (Berkeley Co, SC)', legacyDisplayNames: ['Santee River, SC'],
    areaAcres: 6947, lat: 33.397561, lon: -79.894035,
    boundsWSEN: [-80.168928, 33.288625, -79.622, 33.507707],
    ramps: {}, rampSources: 0, charted: 0.8415, shipped: true, featureType: 'river',
  },
  {
    slug: 'congaree_river', name: 'Congaree River (to SC-601)', state: 'SC',
    displayName: 'Congaree River (to SC-601) (Richland Co, SC)',
    legacyDisplayNames: ['Congaree River (to SC-601), SC', 'Bates Old River'],
    areaAcres: 5610, lat: 34.053631, lon: -80.98814,
    boundsWSEN: [-81.357292, 33.742956, -80.618987, 34.364306],
    ramps: {}, rampSources: 0, charted: 0.8085, shipped: true, featureType: 'river',
  },
  {
    slug: 'broad_river_2', name: 'Broad River (2)', state: 'SC',
    displayName: 'Broad River (2) (Union Co, SC)', legacyDisplayNames: ['Broad River (2), SC'],
    areaAcres: 5166.4, lat: 34.675082, lon: -81.771335,
    boundsWSEN: [-82.226693, 34.368308, -81.315977, 34.981857],
    ramps: {}, rampSources: 0, charted: 0.2828, shipped: true, featureType: 'river',
  },
  {
    slug: 'broad_river', name: 'Broad River', state: 'NC',
    displayName: 'Broad River (Cherokee Co, NC)', legacyDisplayNames: ['Broad River, NC'],
    areaAcres: 4083.7, lat: 35.168999, lon: -81.730738,
    boundsWSEN: [-82.187369, 34.796761, -81.412311, 35.503665],
    ramps: {}, rampSources: 0, charted: 0.3729, shipped: true, featureType: 'river',
  },
  {
    slug: 'wateree_river', name: 'Wateree River', state: 'SC',
    displayName: 'Wateree River (Richland Co, SC)', legacyDisplayNames: ['Wateree River, SC'],
    areaAcres: 3120, lat: 34.039705, lon: -80.632613,
    boundsWSEN: [-80.702226, 33.743006, -80.563, 34.336404],
    ramps: {}, rampSources: 0, charted: 0.3642, shipped: true, featureType: 'river',
  },
];

/**
 * buildAccessIndex()'s two passes, over the fixture instead of over eight fetches.
 *
 * Calls the SAME exported functions the app calls — displayLakeName to key the feeds,
 * findExistingLakeKey to claim an entry, then pruneAccessToRecord and absorbDuplicateEntries in
 * that order. A local reimplementation would be testing its own copy, which is the class of bug
 * this whole day has been about. REG is declared largest-first because that is the order
 * lake-registry.js sorts into and absorbDuplicateEntries is order-dependent.
 */
function buildFixtureIndex() {
  const index = { byLake: new Map(), registryByName: new Map() };
  for (const [st, feeds] of Object.entries(FEED)) {
    for (const [kind, payload] of Object.entries(feeds)) {
      const label = kind === 'ramps' ? 'Boat ramp' : 'Paddle launch';
      for (const [wb, items] of Object.entries(payload)) {
        const lakeName = displayLakeName(wb, st);
        if (!index.byLake.has(lakeName)) index.byLake.set(lakeName, []);
        for (const [name, lat, lon] of items) {
          index.byLake.get(lakeName).push({ name, lat, lon, typeLabel: label });
        }
      }
    }
  }
  const claimed = new Map();
  for (const rec of REG) {
    const key = findExistingLakeKey(index, rec.name, rec.lat, rec.lon, 15, rec) || rec.displayName;
    index.registryByName.set(key, rec);
    pruneAccessToRecord(index, key, rec);
    absorbDuplicateEntries(index, key, rec);
    claimed.set(rec.slug, key);
  }
  return { index, claimed };
}

const { index: IDX, claimed: NAME_OF } = buildFixtureIndex();
const bySlug = Object.fromEntries(REG.map((r) => [r.slug, r]));

describe('the live feeds reach the registry row', () => {
  it('claims the DNR name for each river the registry knows under a longer one', () => {
    // "Broad River, SC" from the feed vs "Broad River (2) (Union Co, SC)" in the registry.
    expect(NAME_OF.get('broad_river_2')).toBe('Broad River, SC');
    expect(NAME_OF.get('congaree_river')).toBe('Congaree River, SC');
    expect(NAME_OF.get('santee_river')).toBe('Santee River, SC');
    expect(NAME_OF.get('wateree_river')).toBe('Wateree River, SC');
  });

  it('counts the ramps Ryan sees on his screen, not the ones the raw feed lists', () => {
    expect(FEED.SC.ramps['Broad River'].length).toBe(8);   // what the feed files under the name
    expect(liveAccessFor('Broad River, SC', IDX).ramps).toBe(4);
    expect(liveAccessFor('Congaree River, SC', IDX).ramps).toBe(3);
    expect(liveAccessFor('Santee River, SC', IDX).ramps).toBe(4);
    expect(liveAccessFor('Wateree River, SC', IDX).ramps).toBe(3);
  });

  it('drops the tidal Broad River at Beaufort rather than crediting it upstate', () => {
    const kept = IDX.byLake.get('Broad River, SC').map((p) => p.name);
    expect(kept.includes('Broad River')).toBe(false);       // 32.39 N, 150 miles away
    expect(kept.includes('Woods Ferry')).toBe(true);
  });

  it('files the two ramps above the state line under the NC row, not the SC one', () => {
    // NOT a rounding artefact and NOT cosmetic — it is why the answer is four rather than six.
    // The Broad River is one river with a row in each state, and 99 Islands and Dalton's
    // Landing sit inside the NC row's bbox even though they are in Cherokee County, SC.
    // absorbDuplicateEntries moves the points a record's own geometry contains, per point.
    // Recorded here so that if the boxes are ever re-cut, the count that moves is visible
    // rather than showing up as a mystery change in the badge.
    const sc = IDX.byLake.get('Broad River, SC').map((p) => p.name);
    const nc = IDX.byLake.get('BROAD RIVER, NC').map((p) => p.name);
    expect(sc.includes('99 Island')).toBe(false);
    expect(nc.includes('99 Island')).toBe(true);
    expect(nc.includes("Dalton's Landing")).toBe(true);
  });

  it('counts a paddle launch as somewhere to launch but not as a ramp', () => {
    const wateree = liveAccessFor('Wateree River, SC', IDX);
    expect(wateree.ramps).toBe(3);
    expect(wateree.launches).toBe(6);   // 3 ramps + 3 canoe accesses
    // /bank-pier is off for exactly this reason — a bank point is not a launch. Nothing here
    // may silently start counting one.
    expect(liveAccessFor('Nowhere At All, SC', IDX).launches).toBe(0);
  });
});

describe('the planner picker stops needing the keep-list to see a river', () => {
  const plannable = makePredicate('planner', null);
  // The same preset with its override switched off. Ryan, 2026-08-14, on the research picker:
  // "why have a hard override on that thought process?" A filter that only passes because
  // something reaches past it is a filter that is not working — so the question this suite
  // answers is whether the planner can now say yes on the evidence.
  const onItsOwn = makePredicate('planner', null, { keepAlways: false });
  const RIVERS = ['broad_river_2', 'congaree_river', 'santee_river', 'wateree_river'];

  it('confirms the keep-list is what carries them today', () => {
    for (const slug of RIVERS) {
      expect(isKeepAlways(NAME_OF.get(slug)), slug).toBe(true);
    }
  });

  it('drops all four on the evidence alone when no live source is registered', () => {
    setLiveAccessSource(null);
    for (const slug of RIVERS) {
      expect(onItsOwn(bySlug[slug], NAME_OF.get(slug)), `${slug} before the wire`).toBe(false);
    }
  });

  it('keeps all four on the evidence alone once the live index is wired in', () => {
    setLiveAccessSource((n) => liveAccessFor(n, IDX));
    for (const slug of RIVERS) {
      expect(onItsOwn(bySlug[slug], NAME_OF.get(slug)), `${slug} after the wire`).toBe(true);
      expect(plannable(bySlug[slug], NAME_OF.get(slug)), `${slug} with the keep-list`).toBe(true);
    }
    setLiveAccessSource(null);
  });

  it('still drops water with a launch and no soundings at all', () => {
    // The wire must not turn the planner into "anything with a ramp". A measured zero for
    // bathymetry is still a no — you cannot plan a trolling day on water with no contours.
    setLiveAccessSource(() => ({ points: 4, ramps: 4, launches: 4 }));
    const noSoundings = { ...bySlug.santee_river, charted: 0, slug: 'somewhere', ramps: {} };
    expect(onItsOwn(noSoundings, 'Somewhere With A Ramp, SC')).toBe(false);
    setLiveAccessSource(null);
  });

  it('never lets the live feed REMOVE a ramp the registry already knew about', () => {
    // 63 registry rows carry a Garmin- or OSM-charted ramp that no state feed lists. An empty
    // live answer must not take those away — the wire is a union, never a substitution.
    setLiveAccessSource(() => ({ points: 0, ramps: 0, launches: 0 }));
    const garminOnly = { ...bySlug.santee_river, rampSources: 2 };
    expect(onItsOwn(garminOnly, 'Some Lake With A Garmin Ramp, SC')).toBe(true);
    setLiveAccessSource(null);
  });

  it('survives a live source that throws, and falls back to the file', () => {
    setLiveAccessSource(() => { throw new Error('worker down'); });
    expect(onItsOwn(bySlug.santee_river, 'Santee River, SC')).toBe(false);
    expect(onItsOwn({ ...bySlug.santee_river, rampSources: 1 }, 'Santee River, SC')).toBe(true);
    setLiveAccessSource(null);
  });
});
