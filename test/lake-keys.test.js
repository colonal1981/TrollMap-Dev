import { describe, it, expect } from './expect-shim.mjs';
import { LAKE_NAME_TO_R2_KEY, resolveR2Key } from '../js/data/lake-keys.js';

describe('LAKE_NAME_TO_R2_KEY — single source of truth (102 entries)', () => {
  it('has 102 entries (full map, not truncated worker copy)', () => {
    // 97 freshwater + 21 coastal zones. Was 101 before the coastal expansion
    // split the single `sc_ga_coastal` key into 21 per-zone `coast_*` keys.
        // 102 after the 2026-08-04 rebind to lake_index.json. Fewer names than before:
        // 15 whose packs do not exist are refused outright rather than mapped, and two
        // combined names were split into their halves.
        // (was 117 = 95 freshwater + 22 coastal, Cape Romain added 2026-08-03,
    // a stretch that previously fell in the gap between the Charleston and Santee boxes). Was 118 until 2026-08-03, when 'High Rock
    // Lake, NC' and 'Blewett Falls Lake, NC' were removed: the R2 prune retired
    // `yadkin_river_chain` and 3DHP never named those two, so they have no
    // replacement pack. A name bound to a slug with no pack is a lake that appears
    // in the list and then fails to load, which is worse than an absent name.
    // Goes back to 118 once high_rock_lake and blewett_falls_lake are built --
    // see claude/YADKIN_ORPHANS_RECOVERY_2026-08-03.md.
    //
    // This literal is doing its job. It is not a nuisance to be silenced: it fired
    // the moment two lakes left the data, which is exactly when someone should look.
    // 2026-08-04: rebound to lake_index.json. 36 slugs the app referenced did not
    // exist there -- ~20 renamed when the index was regenerated from 3DHP
    // (lake_hartwell -> hartwell_lake), 8 combined packs that had been split into
    // halves, and the rest never built. Names with no pack are now REFUSED in
    // LAKE_NAMES_WITHOUT_PACK rather than merely deleted, because deleting one lets
    // the fuzzy pass answer instead -- 'Kerr Lake, NC' was resolving to
    // w_kerr_scott_reservoir, a different lake 1/40th the size.
    // 117 as of 2026-08-04: 102 + fifteen names whose packs were built and installed that night
    // (Randleman, Kerr x2, High Rock, Falls, John H. Moss, Bonnie Doone, Blewett Falls,
    // Hiwassee, Cheoah x2, Lookout Shoals, Juliette, Blalock) plus Catawba Narrows, which
    // has no pack of its own and is aliased to lake_wylie because the reach IS Wylie's water.
    // 120 as of 2026-08-11: three spellings of the Congaree bound to `congaree_river`. The plain
    // name resolved to NOTHING before the registry loaded, and afterwards it depended on which of
    // two registry rows for the same water registered first — the one with the pack, or the
    // packless duplicate `congaree_river_to_sc_601`. Bates Old River now shares that pack, so the
    // Congaree resolving by load order would have taken Bates down with it.
    expect(Object.keys(LAKE_NAME_TO_R2_KEY).length).toBe(120);
  });

  it('contains critical keys that were missing in old worker copy', () => {
    // These were missing in old Worker/research/limnology.js 74-entry copy
    // Catawba Narrows still has no pack, but it is now ALIASED rather than refused: the
    // reach is the water between Wylie and Fishing Creek, both of which ship. Ryan,
    // 2026-08-04: "Catawba narrows being combined with either wylie or Fishing Creek is
    // fine". An alias loads the right contours; a refusal loaded nothing at all.
    expect(LAKE_NAME_TO_R2_KEY['Catawba Narrows, SC/NC']).toBe('lake_wylie');
    expect(LAKE_NAME_TO_R2_KEY['Fort Loudoun Lake, TN']).toBe('fort_loudoun_lake');
    expect(LAKE_NAME_TO_R2_KEY['Fort Loudoun Reservoir, TN']).toBe('fort_loudoun_lake');
    expect(LAKE_NAME_TO_R2_KEY['Lake Bowen, SC']).toBe('lake_william_c_bowen');
    // Built and installed 2026-08-04 -- 1,481 ac cut from 3DHP, seeded from its one SC DNR
    // landing. This is the "goes back to a real slug when the pack is built" case landing.
    expect(LAKE_NAME_TO_R2_KEY['Lake Blalock, SC']).toBe('lake_blalock');
  });

  it('maps each coastal zone to its own per-zone R2 key', () => {
    // The coastal expansion replaced the shared `sc_ga_coastal` chartpack with
    // one prefix per zone, so every zone gets its own contours / oyster_beds /
    // marsh_edges / depth_soundings under `chartpacks/{slug}/`.
    expect(LAKE_NAME_TO_R2_KEY['ACE Basin / Edisto, SC']).toBe('coast_ace_basin_sc');
    expect(LAKE_NAME_TO_R2_KEY['Charleston Harbor, SC']).toBe('coast_charleston_sc');
    expect(LAKE_NAME_TO_R2_KEY['Pamlico Sound / Neuse River, NC']).toBe('coast_pamlico_sound_nc');
    expect(LAKE_NAME_TO_R2_KEY['Savannah River / Savannah, GA']).toBe('coast_savannah_ga');

    const coastal = Object.values(LAKE_NAME_TO_R2_KEY).filter((k) => k.startsWith('coast_'));
    expect(new Set(coastal).size).toBe(22);
  });

  it('contains Wateree chain and Russell chain aliases', () => {
    expect(LAKE_NAME_TO_R2_KEY['Lake Wateree, SC']).toBe('wateree_lake');
    expect(LAKE_NAME_TO_R2_KEY['Fishing Creek Reservoir, SC']).toBe('fishing_creek_reservoir');
    expect(LAKE_NAME_TO_R2_KEY['Lake Russell, SC/GA']).toBe('richard_b_russell_lake');
    expect(LAKE_NAME_TO_R2_KEY['Clarks Hill / Thurmond, SC/GA']).toBe('j_strom_thurmond_reservoir');
    expect(LAKE_NAME_TO_R2_KEY['Richard B. Russell Lake, GA']).toBe('richard_b_russell_lake');
  });
});

describe('resolveR2Key — fuzzy resolver (canonical)', () => {
  const cases = [
    ['Lake Wateree, SC', 'wateree_lake'],
    ['Lake Wateree', 'wateree_lake'],
    ['Wateree', 'wateree_lake'],
    ['Lake Wateree (Duke Energy)', 'wateree_lake'], // partial match handles suffix
    ['Lake Murray, SC', 'lake_murray'],
    ['Lake Marion, SC', 'lake_marion'],
    ['Catawba Narrows, SC/NC', 'lake_wylie'],   // aliased: the reach IS Wylie's water
    ['Catawba Narrows', 'lake_wylie'],          // aliased
    ['Lake Wylie, SC/NC', 'lake_wylie'],
    ['Lake Wylie', 'lake_wylie'],
    ['Fort Loudoun Lake, TN', 'fort_loudoun_lake'],
    ['Fort Loudoun Reservoir, TN', 'fort_loudoun_lake'],
    ['Tellico Lake, TN', 'tellico_lake'],
    ['Lake Norman, NC', 'lake_norman'],
    ['Mountain Island Lake, NC', 'mountain_island_lake'],
    ['ACE Basin / Edisto, SC', 'coast_ace_basin_sc'],
    ['Charleston Harbor, SC', 'coast_charleston_sc'],
    ['Lake Hickory, NC', 'lake_hickory'],
    ['Lake James, NC', 'lake_james'],
    // 2026-08-04: was 'lake_lanier', which is an 85-acre pond in Greenville Co, SC.
    // Lake Lanier GA is Lake Sidney Lanier, 38,293 ac in Hall Co. This row asserted
    // the wrong lake and would have kept asserting it.
    ['Lake Lanier, GA', 'lake_sidney_lanier'],
    ['Lake Burton, GA', 'lake_burton'],
    ['Watauga Lake, TN', 'watauga_lake'],
    ['Boone Lake, TN', 'boone_lake'],
    ['Watauga / Boone Chain, TN/NC', null]  // refused: both halves are selectable on their own,
  ];

  for (const [input, expected] of cases) {
    it(`resolveR2Key('${input}') → '${expected}'`, () => {
      expect(resolveR2Key(input)).toBe(expected);
    });
  }

  it('returns null for unknown lake (not generic fallback)', () => {
    // Old worker fallback generated lake_${base} which masked misses and broke shoreline R2 lookups
    expect(resolveR2Key('Fake Lake That Does Not Exist, SC')).toBeNull();
    expect(resolveR2Key('Nonexistent Reservoir')).toBeNull();
    expect(resolveR2Key('')).toBeNull();
    expect(resolveR2Key(null)).toBeNull();
  });

  it('handles state suffix stripping', () => {
    expect(resolveR2Key('Lake Marion')).toBe('lake_marion');
    expect(resolveR2Key('Lake Marion, SC')).toBe('lake_marion');
    // NC/GA suffix
    expect(resolveR2Key('Lake Wylie, SC/NC')).toBe('lake_wylie');
    expect(resolveR2Key('Lake Wylie')).toBe('lake_wylie');
  });

  it('is case-insensitive partial match for Duke Energy / county suffix variations', () => {
    expect(resolveR2Key('Lake Wateree (Duke Energy)')).toBe('wateree_lake');
    expect(resolveR2Key('Lake Wateree - Kershaw County, SC')).toBe('wateree_lake');
  });
});
