import { describe, it, expect } from './expect-shim.mjs';
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const { searchWaters, buildWaterIndex, invalidateWaterIndex } =
  await import('../js/modules/water-search.js');
const { WATER_TO_R2_KEY } = await import('../js/data/water-aliases.js');
const { COASTAL_ZONES, COASTAL_SLUGS } = await import('../js/data/coastal-zones.js');

/**
 * The search box called Nominatim, so the one thing it could not find was TrollMap's own
 * water. "Cooper River" is in water-aliases.js pointing at coast_charleston_sc and typing it
 * returned nothing.
 */

describe('search covers the sources the dropdown does not', () => {
  it('finds a coastal pointer that has no dropdown row', () => {
    invalidateWaterIndex();
    const hits = searchWaters('Cooper River');
    const p = hits.find((h) => h.kind === 'pointer' && h.label === 'Cooper River');
    expect(p, 'Cooper River should be findable').toBeTruthy();
    // and it must select the ZONE, because that is what holds the contours
    expect(p.selectName).toBe(COASTAL_ZONES[WATER_TO_R2_KEY['Cooper River']].name);
  });

  it('every coastal zone is findable by its own name', () => {
    invalidateWaterIndex();
    for (const slug of COASTAL_SLUGS) {
      const nm = COASTAL_ZONES[slug].name;
      const hits = searchWaters(nm);
      expect(hits.length, `no hit for ${nm}`).toBeGreaterThan(0);
    }
  });

  it('every pointer resolves to a zone that exists', () => {
    const idx = buildWaterIndex();
    const names = new Set(COASTAL_SLUGS.map((s) => COASTAL_ZONES[s].name));
    for (const e of idx.filter((x) => x.kind === 'pointer')) {
      expect(names.has(e.selectName), `${e.label} -> ${e.selectName}`).toBe(true);
    }
  });
});

describe('ranking puts the exact name first', () => {
  it('an exact match outranks a longer name containing it', () => {
    invalidateWaterIndex();
    const hits = searchWaters('Charleston Harbor, SC');
    expect(hits[0].label).toBe('Charleston Harbor, SC');
  });

  it('an empty query returns nothing rather than everything', () => {
    expect(searchWaters('')).toHaveLength(0);
    expect(searchWaters('   ')).toHaveLength(0);
  });
});

describe('the index never invents a selection target', () => {
  it('every entry carries a selectName and something to move the map to', () => {
    for (const e of buildWaterIndex()) {
      expect(e.selectName, `${e.kind} ${e.label} has no selectName`).toBeTruthy();
      expect(Boolean(e.bounds || e.center), `${e.kind} ${e.label} has no position`).toBe(true);
    }
  });
});
