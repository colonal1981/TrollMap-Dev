import { describe, it, expect } from './expect-shim.mjs';
import { LAKE_NAME_TO_R2_KEY, LAKE_NAMES_WITHOUT_PACK, resolveR2Key } from '../js/data/lake-keys.js';

describe('LAKE_NAME_TO_R2_KEY — single source of truth (101 entries)', () => {
  it('has 101 entries (full map, not truncated worker copy)', () => {
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
    // 115 as of 2026-08-19, down six from 121. The display names of the six out-of-region
    // coastal zones went with the zones themselves when Scripts/coastal_catalog.py was cut from
    // 22 to 16. They had been pointing at slugs consolidate_lake_index.py drops on every run, so
    // each was a name the picker offered and the loader could not answer.
    // 114 as of 2026-08-19, down one more: 'North Fork Reservoir, NC'. It is INSIDE the
    // region -- 336.7 ac, Buncombe Co NC, 35.66920/-82.33913 -- and Garmin never surveyed it.
    // Zero coverage cells inside its bbox out of 2,707,096 gridded, and zero within ~25 km, so
    // the gap is regional rather than lake-shaped. Its R2 pack is i-BOATING: shoreline,
    // fishing_lines, fishing_points, and none of garmin_shoreline/docks/structure/
    // trolling_runs/water_graph. "i-Boating is dead for contours and depth areas" is standing,
    // so the index dropped it correctly and this name was the only thing still reaching it.
    // Ryan: "it is not water i can fish... i do not care about it".
    // 101 as of 2026-08-19, down thirteen more: nine waters outside the region polygon, some
    // of them large -- Kerr ~41,940 ac, Watts Bar ~33,441 -- carrying thirteen display names
    // between them. Ryan: "if they are outside the boundary then they are cut".
    //
    // THEY MOVED TO LAKE_NAMES_WITHOUT_PACK RATHER THAN BEING DELETED. Measured first: with its
    // mapping merely removed, 'High Falls Lake, GA' resolved to `falls_lake` -- Falls Lake in
    // NORTH CAROLINA, which ships. Deleting a mapping does not stop a name answering, it
    // re-points it, which is the failure this file already documents for Kerr.
    expect(Object.keys(LAKE_NAME_TO_R2_KEY).length).toBe(101)  // was 121 with +Lake Robinson (Greenville Co, SC) 2026-08-14 -- two SC Lake Robinsons, 190 km apart;
  });

  it('every name in LAKE_NAMES_WITHOUT_PACK actually refuses', () => {
    // THE SIZE IS NOT PINNED HERE ANY MORE. hand-written-tables.test.js owns every table count,
    // and on 2026-08-19 its parser was widened to see `new Set([...])` and `[...]` -- it had only
    // ever opened on `{`, which is why this set grew 6 -> 20 without the ledger moving. Two
    // places pinning one number is the "a guard written twice will only be written once" shape,
    // so the count lives there and the BEHAVIOUR lives here.
    //
    // Behaviour is the part that matters anyway: a set is worth exactly its membership test.
    // hasNoPack() runs before any matching, so this is the assertion saying the fuzzy pass
    // cannot answer for a refused name.
    expect(LAKE_NAMES_WITHOUT_PACK.size).toBeGreaterThan(0);
    for (const name of LAKE_NAMES_WITHOUT_PACK) {
      expect(resolveR2Key(name)).toBe(null);
    }
  });

  it('cutting a name must not hand it to a different lake', () => {
    // 'High Falls Lake, GA' resolved to `falls_lake` -- Falls Lake, NORTH CAROLINA, which ships --
    // when its mapping was deleted without being refused. Measured before the cut, not after.
    // Same shape as 'Kerr Lake, NC' -> w_kerr_scott_reservoir, 1,280 ac for ~50,000.
    expect(resolveR2Key('High Falls Lake, GA')).toBe(null);
    expect(resolveR2Key('Falls Lake, NC')).toBe('falls_lake');
    expect(resolveR2Key('Kerr Lake, NC')).toBe(null);
    expect(resolveR2Key('W. Kerr Scott Reservoir, NC')).toBe('w_kerr_scott_reservoir');
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
    // Was 'Pamlico Sound / Neuse River, NC' until 2026-08-19. This line has to name a zone the
    // app still offers or it stops being a sample of anything -- Cape Fear is the NC zone that
    // ships, and one sample per state is the point of the four.
    expect(LAKE_NAME_TO_R2_KEY['Cape Fear River / Wilmington, NC']).toBe('coast_cape_fear_nc');
    expect(LAKE_NAME_TO_R2_KEY['Savannah River / Savannah, GA']).toBe('coast_savannah_ga');

    const coastal = Object.values(LAKE_NAME_TO_R2_KEY).filter((k) => k.startsWith('coast_'));
    expect(new Set(coastal).size).toBe(16);   // 22 until the six out-of-region zones went, 2026-08-19
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
