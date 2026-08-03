import { describe, it, expect } from './expect-shim.mjs';
import { LAKE_NAME_TO_R2_KEY, resolveR2Key } from '../js/data/lake-keys.js';

describe('LAKE_NAME_TO_R2_KEY — single source of truth (116 entries)', () => {
  it('has 116 entries (full map, not truncated worker copy)', () => {
    // 97 freshwater + 21 coastal zones. Was 101 before the coastal expansion
    // split the single `sc_ga_coastal` key into 21 per-zone `coast_*` keys.
        // 116 = 95 freshwater + 21 coastal. Was 118 until 2026-08-03, when 'High Rock
    // Lake, NC' and 'Blewett Falls Lake, NC' were removed: the R2 prune retired
    // `yadkin_river_chain` and 3DHP never named those two, so they have no
    // replacement pack. A name bound to a slug with no pack is a lake that appears
    // in the list and then fails to load, which is worse than an absent name.
    // Goes back to 118 once high_rock_lake and blewett_falls_lake are built --
    // see claude/YADKIN_ORPHANS_RECOVERY_2026-08-03.md.
    //
    // This literal is doing its job. It is not a nuisance to be silenced: it fired
    // the moment two lakes left the data, which is exactly when someone should look.
    expect(Object.keys(LAKE_NAME_TO_R2_KEY).length).toBe(116);
  });

  it('contains critical keys that were missing in old worker copy', () => {
    // These were missing in old Worker/research/limnology.js 74-entry copy
    expect(LAKE_NAME_TO_R2_KEY['Catawba Narrows, SC/NC']).toBe('catawba_narrows');
    expect(LAKE_NAME_TO_R2_KEY['Fort Loudoun Lake, TN']).toBe('fort_loudoun_lake');
    expect(LAKE_NAME_TO_R2_KEY['Fort Loudoun Reservoir, TN']).toBe('fort_loudoun_lake');
    expect(LAKE_NAME_TO_R2_KEY['Lake Bowen, SC']).toBe('lake_bowen');
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
    expect(new Set(coastal).size).toBe(21);
  });

  it('contains Wateree chain and Russell chain aliases', () => {
    expect(LAKE_NAME_TO_R2_KEY['Lake Wateree, SC']).toBe('lake_wateree_fishing_creek');
    expect(LAKE_NAME_TO_R2_KEY['Fishing Creek Reservoir, SC']).toBe('lake_wateree_fishing_creek');
    expect(LAKE_NAME_TO_R2_KEY['Lake Russell, SC/GA']).toBe('lake_thurmond_russell');
    expect(LAKE_NAME_TO_R2_KEY['Clarks Hill / Thurmond, SC/GA']).toBe('lake_thurmond_russell');
    expect(LAKE_NAME_TO_R2_KEY['Richard B. Russell Lake, GA']).toBe('lake_thurmond_russell');
  });
});

describe('resolveR2Key — fuzzy resolver (canonical)', () => {
  const cases = [
    ['Lake Wateree, SC', 'lake_wateree_fishing_creek'],
    ['Lake Wateree', 'lake_wateree_fishing_creek'],
    ['Wateree', 'lake_wateree_fishing_creek'],
    ['Lake Wateree (Duke Energy)', 'lake_wateree_fishing_creek'], // partial match handles suffix
    ['Lake Murray, SC', 'lake_murray'],
    ['Lake Marion, SC', 'lake_marion'],
    ['Catawba Narrows, SC/NC', 'catawba_narrows'],
    ['Catawba Narrows', 'catawba_narrows'],
    ['Lake Wylie, SC/NC', 'lake_wylie'],
    ['Lake Wylie', 'lake_wylie'],
    ['Fort Loudoun Lake, TN', 'fort_loudoun_lake'],
    ['Fort Loudoun Reservoir, TN', 'fort_loudoun_lake'],
    ['Tellico Lake, TN', 'tellico_lake'],
    ['Lake Norman, NC', 'lake_norman_mountain_island'],
    ['Mountain Island Lake, NC', 'lake_norman_mountain_island'],
    ['ACE Basin / Edisto, SC', 'coast_ace_basin_sc'],
    ['Charleston Harbor, SC', 'coast_charleston_sc'],
    ['Lake Hickory, NC', 'lake_hickory_rhodhiss'],
    ['Lake James, NC', 'lake_james'],
    ['Lake Lanier, GA', 'lake_lanier'],
    ['Lake Burton, GA', 'lake_burton'],
    ['Watauga Lake, TN', 'watauga_boone_chain'],
    ['Boone Lake, TN', 'watauga_boone_chain'],
    ['Watauga / Boone Chain, TN/NC', 'watauga_boone_chain'],
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
    expect(resolveR2Key('Lake Wateree (Duke Energy)')).toBe('lake_wateree_fishing_creek');
    expect(resolveR2Key('Lake Wateree - Kershaw County, SC')).toBe('lake_wateree_fishing_creek');
  });
});
