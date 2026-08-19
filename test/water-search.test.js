import { describe, it, expect } from './expect-shim.mjs';
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const { searchWaters, buildWaterIndex, invalidateWaterIndex } =
  await import('../js/modules/water-search.js');
const { WATER_TO_R2_KEY } = await import('../js/data/water-aliases.js');
const { COASTAL_ZONES, COASTAL_SLUGS } = await import('../js/data/coastal-zones.js');

/**
 * The search box called Nominatim, so the one thing it could not find was TrollMap's own
 * water: a name that is only a coastal pointer has no dropdown row, and typing it returned
 * nothing.
 *
 * THE EXAMPLE USED TO BE "Cooper River" AND IT GRADUATED. On 2026-08-18 the Cooper got its own
 * 4,658-acre freshwater pack, cut at the SC Code 50-5-80 dividing line, so
 * gen_water_aliases_js.py dropped the name from water-aliases.js -- "something earlier already
 * answers them" -- and it now resolves out of lake_index.json as a water rather than a pointer.
 * Verified with the registry loaded: searchWaters('Cooper River') returns
 * "Cooper River (Berkeley Co, SC)".
 *
 * So the example moved rather than the rule. Any name still in the pointer table will do; if
 * this one graduates too, move it again and say so here.
 *
 * IT GRADUATED AGAIN, 2026-08-19. The Ashley got its own 406-acre freshwater pack the same week,
 * trimmed at the same 50-5-80 line, and the Sampit and Waccamaw went with it -- so all three
 * dropped out of water-aliases.js on the next regeneration and this test failed within the hour.
 * That is the check working; it is the only thing that notices a pointer becoming a water.
 *
 * PICKING ONE THAT CANNOT GRADUATE THIS TIME. Shem Creek is in classify_salt_fresh.py's
 * NAME_OVERRIDE as 'salt' -- SC Code 50-5-80 declares it saltwater along its ENTIRE length, so
 * trim_at_salt_line.py can never leave it a freshwater remnant and it can never be cut a
 * boundary of its own. Cooper and Ashley were both rivers with a fresh upper reach, which is
 * exactly why they graduated. A name the statute puts wholly on the salt side cannot.
 */
const POINTER_EXAMPLE = 'Shem Creek';

describe('search covers the sources the dropdown does not', () => {
  it('finds a coastal pointer that has no dropdown row', () => {
    invalidateWaterIndex();
    expect(WATER_TO_R2_KEY[POINTER_EXAMPLE], `${POINTER_EXAMPLE} is no longer a pointer -- pick `
      + 'another name from water-aliases.js and update the note above').toBeTruthy();
    const hits = searchWaters(POINTER_EXAMPLE);
    const p = hits.find((h) => h.kind === 'pointer' && h.label === POINTER_EXAMPLE);
    expect(p, `${POINTER_EXAMPLE} should be findable`).toBeTruthy();
    // and it must select the ZONE, because that is what holds the contours
    expect(p.selectName).toBe(COASTAL_ZONES[WATER_TO_R2_KEY[POINTER_EXAMPLE]].name);
  });

  // A name that graduated to its own pack must NOT still be sitting in the pointer table --
  // that is two answers for one water, and the generator drops it precisely to avoid that.
  it('a water with its own pack is not also a coastal pointer', () => {
    for (const n of ['Cooper River', 'Lake Wylie', 'Norris Reservoir', 'Lake Mayer']) {
      expect(WATER_TO_R2_KEY[n], `${n} has its own registry row and must not also point at a `
        + 'coastal zone -- re-run Scripts/gen_water_aliases_js.py').toBeFalsy();
    }
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
