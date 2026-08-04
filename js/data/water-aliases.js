/**
 * water-aliases.js — DNR waterbody name → chartpack key.
 *
 * GENERATED FILE — DO NOT EDIT BY HAND.
 * Source of truth: lake_boundaries/_coastal_pointers.json + _river_aliases.json,
 *                  written by scripts/make_river_boundaries.py
 * Regenerate:      python3 Scripts/gen_water_aliases_js.py
 * Guarded by:      test/water-aliases.test.js
 *
 * Every name here reaches the picker from the worker's /ramps feed (access-index.js keys
 * byLake by the DNR waterbody name), so they were always selectable — they just had no
 * chartpack behind them. Without this table they fall through to resolveR2Key's fuzzy pass,
 * which on 2026-08-04 answered WRONGLY for 26 of them: "May River" in Bluffton SC resolved
 * to Mayo Lake in North Carolina, "Black Creek" on the Pee Dee to Lake Blackshear in Georgia.
 * A silent wrong answer is worse than no answer, which is why this is consulted BEFORE the
 * fuzzy pass and why the test asserts every key here actually exists.
 *
 *   WATER_TO_R2_KEY         exact display name → key. Coastal names give a coast_* zone
 *                           slug, which is already the chartpack prefix; alias names give the
 *                           slug of the river that owns the water.
 *   WATER_ZONE_CANDIDATES   base name (no "(2)" suffix) → every zone that name has landings
 *                           in, most landings first. Eight names need this; the Intracoastal
 *                           Waterway has eight zones to itself.
 */

export const WATER_TO_R2_KEY = {
  "Abercorn Creek": "coast_savannah_ga",
  "Alligator River": "coast_albemarle_sound_nc",
  "Alligator River (2)": "coast_outer_banks_nc",
  "Ararat River": "yadkin_river",
  "Ashepoo River": "coast_beaufort_sc",
  "Ashley River": "coast_charleston_sc",
  "Back River": "coast_charleston_sc",
  "Barbour River": "coast_ossabaw_st_catherines_ga",
  "Battery Creek": "coast_beaufort_sc",
  "Bay River": "coast_pamlico_sound_nc",
  "Beaufort River": "coast_beaufort_sc",
  "Big Bay Creek": "coast_st_helena_sc",
  "Big Flatty Creek": "coast_albemarle_sound_nc",
  "Black Creek": "great_pee_dee_river",
  "Black Creek (2)": "black_river_2",
  "Blackbeard Creek": "coast_ossabaw_st_catherines_ga",
  "Blounts Creek": "coast_pamlico_sound_nc",
  "Bohicket Creek": "coast_ace_basin_sc",
  "Boyd Creek": "coast_beaufort_sc",
  "Brice Creek": "coast_pamlico_sound_nc",
  "Brickyard Creek": "coast_beaufort_sc",
  "Broad Creek": "coast_hilton_head_sc",
  "Broro River": "coast_sapelo_altamaha_ga",
  "Brunswick River": "coast_brunswick_st_simons_ga",
  "Bull Creek": "coast_murrells_inlet_sc",
  "Bull River": "coast_savannah_ga",
  "Capers Creek": "coast_st_helena_sc",
  "Cashie River": "coast_albemarle_sound_nc",
  "Catawba River": "lake_wylie",
  "Champney River": "coast_sapelo_altamaha_ga",
  "Chechessee River": "coast_beaufort_sc",
  "Chehaw River": "coast_beaufort_sc",
  "Chowan River": "coast_albemarle_sound_nc",
  "Clarks Creek": "coast_murrells_inlet_sc",
  "Colleton River": "coast_hilton_head_sc",
  "Conaby Creek": "coast_albemarle_sound_nc",
  "Cooper River": "coast_charleston_sc",
  "Coosawhatchie River": "coast_beaufort_sc",
  "Crooked River": "coast_cumberland_st_marys_ga",
  "Cuckholds Creek": "coast_ace_basin_sc",
  "Darien River": "coast_sapelo_altamaha_ga",
  "Dawhoo Creek": "coast_ace_basin_sc",
  "Dawson Creek": "coast_pamlico_sound_nc",
  "Demeries Creek": "coast_ossabaw_st_catherines_ga",
  "Dunham Creek": "coast_charleston_sc",
  "East River": "coast_brunswick_st_simons_ga",
  "Ebenezer Creek": "coast_savannah_ga",
  "Elliot Cut": "coast_charleston_sc",
  "Euhaw Creek": "coast_beaufort_sc",
  "Factory Creek": "coast_beaufort_sc",
  "Folly River": "coast_charleston_sc",
  "Frederica River": "coast_brunswick_st_simons_ga",
  "Greens Creek": "coast_pamlico_sound_nc",
  "Haigh Creek": "coast_st_helena_sc",
  "Halls Creek": "coast_albemarle_sound_nc",
  "Hampton River": "coast_brunswick_st_simons_ga",
  "Hancock Creek": "coast_pamlico_sound_nc",
  "Holly Shelter Creek": "coast_topsail_new_river_nc",
  "Hoover Creek": "coast_savannah_ga",
  "Horseshoe Creek": "chessie_creek",
  "Huspah Creek": "coast_beaufort_sc",
  "Intracoastal Waterway": "coast_brunswick_nc",
  "Intracoastal Waterway (2)": "coast_murrells_inlet_sc",
  "Intracoastal Waterway (3)": "coast_bogue_sound_nc",
  "Intracoastal Waterway (4)": "coast_topsail_new_river_nc",
  "Intracoastal Waterway (5)": "coast_cape_fear_nc",
  "Intracoastal Waterway (6)": "coast_cape_romain_sc",
  "Intracoastal Waterway (7)": "coast_santee_delta_sc",
  "Intracoastal Waterway (8)": "coast_albemarle_sound_nc",
  "Jekyll Creek": "coast_brunswick_st_simons_ga",
  "Jenkins Creek": "coast_st_helena_sc",
  "Jeremy Creek": "coast_santee_delta_sc",
  "Jerico River": "coast_ossabaw_st_catherines_ga",
  "Jones Creek": "coast_ossabaw_st_catherines_ga",
  "Kilkenny Creek": "coast_ossabaw_st_catherines_ga",
  "Lazaretto Creek": "coast_savannah_ga",
  "Little Ogeechee River": "coast_savannah_ga",
  "Little River (2)": "pee_dee_river_2",
  "Lucy Point Creek": "coast_st_helena_sc",
  "MacKay River": "coast_brunswick_st_simons_ga",
  "Mackay Creek": "coast_hilton_head_sc",
  "Main Creek": "coast_winyah_bay_sc",
  "May River": "coast_hilton_head_sc",
  "Medway River": "coast_ossabaw_st_catherines_ga",
  "New River": "coast_topsail_new_river_nc",
  "New River (2)": "coast_savannah_ga",
  "Newport River": "coast_bogue_sound_nc",
  "North Edisto River": "coast_ace_basin_sc",
  "North River": "coast_core_sound_nc",
  "North River (2)": "coast_sapelo_altamaha_ga",
  "North River (3)": "coast_cumberland_st_marys_ga",
  "North Santee River": "coast_santee_delta_sc",
  "North Winbee Creek": "coast_beaufort_sc",
  "Northeast Cape Fear River (2)": "coast_cape_fear_nc",
  "Northwest River": "coast_albemarle_sound_nc",
  "Pacolet River": "broad_river_2",
  "Pamlico River": "coast_pamlico_sound_nc",
  "Pantego Creek": "coast_pamlico_sound_nc",
  "Pasquotank River": "coast_albemarle_sound_nc",
  "Pawleys Creek": "coast_winyah_bay_sc",
  "Pee Dee River": "great_pee_dee_river",
  "Penny Creek": "coast_ace_basin_sc",
  "Perquimans River": "coast_albemarle_sound_nc",
  "Pungo River": "coast_pamlico_sound_nc",
  "Quenby Creek": "coast_cape_romain_sc",
  "Rantowles Creek": "coast_charleston_sc",
  "Redbird Creek": "coast_ossabaw_st_catherines_ga",
  "Rice Creek": "coast_cape_fear_nc",
  "Riceboro Creek": "coast_ossabaw_st_catherines_ga",
  "Russ Creek": "little_pee_dee_river",
  "Salt Creek": "coast_savannah_ga",
  "Salters Creek": "coast_pamlico_sound_nc",
  "Sampit River": "coast_winyah_bay_sc",
  "Sapelo River": "coast_sapelo_altamaha_ga",
  "Satilla River (2)": "coast_cumberland_st_marys_ga",
  "Scuppernong River": "coast_albemarle_sound_nc",
  "Shem Creek": "coast_charleston_sc",
  "Skidaway River": "coast_savannah_ga",
  "Skidaway River (ICW)": "coast_savannah_ga",
  "Smith Creek": "coast_pamlico_sound_nc",
  "South Brunswick River": "coast_brunswick_st_simons_ga",
  "South Creek": "coast_pamlico_sound_nc",
  "South Newport River": "coast_ossabaw_st_catherines_ga",
  "Southwest Prong Slocum Creek": "coast_pamlico_sound_nc",
  "Station Creek": "coast_st_helena_sc",
  "Stevens Creek Reservoir": "savannah_river",
  "Stono River": "coast_charleston_sc",
  "Swift Creek": "coast_pamlico_sound_nc",
  "Taylor Creek": "coast_bogue_sound_nc",
  "Toogoodoo Creek": "coast_ace_basin_sc",
  "Tranters Creek": "coast_pamlico_sound_nc",
  "Trent River": "coast_pamlico_sound_nc",
  "Tull Creek": "coast_albemarle_sound_nc",
  "Turner Creek": "coast_savannah_ga",
  "Turtle River": "coast_brunswick_st_simons_ga",
  "Tybee Creek": "coast_savannah_ga",
  "Tyger River": "broad_river_2",
  "Upper Broad Creek": "coast_pamlico_sound_nc",
  "Village Creek": "coast_brunswick_st_simons_ga",
  "Wacammaw River": "coast_murrells_inlet_sc",
  "Waccamaw River": "coast_brunswick_nc",
  "Wadboo Creek": "tail_race_canal",
  "Wadmacon Creek": "coast_santee_delta_sc",
  "Wambaw Creek": "coast_santee_delta_sc",
  "Wando River": "coast_cape_romain_sc",
  "Wando River (2)": "coast_charleston_sc",
  "Wappoo Creek": "coast_charleston_sc",
  "Wards Creek": "coast_st_helena_sc",
  "Whale Branch": "coast_beaufort_sc",
  "White Chimney River": "coast_sapelo_altamaha_ga",
  "White Oak River": "coast_pamlico_sound_nc",
  "Wiccacon River": "coast_albemarle_sound_nc",
  "Williams Creek": "coast_murrells_inlet_sc",
  "Wilmington River": "coast_savannah_ga",
  "Wright River": "coast_savannah_ga",
};

export const WATER_ZONE_CANDIDATES = {
  "Alligator River": ["coast_albemarle_sound_nc", "coast_outer_banks_nc"],
  "Intracoastal Waterway": ["coast_brunswick_nc", "coast_murrells_inlet_sc", "coast_bogue_sound_nc", "coast_cape_fear_nc", "coast_topsail_new_river_nc", "coast_cape_romain_sc", "coast_albemarle_sound_nc", "coast_santee_delta_sc"],
  "New River": ["coast_topsail_new_river_nc", "coast_savannah_ga"],
  "North River": ["coast_core_sound_nc", "coast_cumberland_st_marys_ga", "coast_sapelo_altamaha_ga"],
  "Northeast Cape Fear River": ["coast_cape_fear_nc"],
  "Satilla River": ["coast_cumberland_st_marys_ga"],
  "Wando River": ["coast_cape_romain_sc", "coast_charleston_sc"],
};

/** Chartpack key for a waterbody name, or null. Exact match first, then the base name. */
export function resolveWaterKey(name) {
  if (!name || typeof name !== 'string') return null;
  const n = name.trim();
  if (!n) return null;
  if (WATER_TO_R2_KEY[n]) return WATER_TO_R2_KEY[n];
  const stripped = n.replace(/,\s*[A-Z]{2}(\/[A-Z]{2})*$/i, '').trim();
  if (stripped !== n && WATER_TO_R2_KEY[stripped]) return WATER_TO_R2_KEY[stripped];
  const cands = WATER_ZONE_CANDIDATES[n] || WATER_ZONE_CANDIDATES[stripped];
  return (cands && cands[0]) || null;
}

/**
 * Every zone a name has landings in. lake-ramp-select.js uses this to pick the zone the
 * selected waterbody's own access points actually sit in, which is what makes "Intracoastal
 * Waterway" open the right 30 km of it rather than whichever zone happens to be first.
 */
export function waterZoneCandidates(name) {
  if (!name || typeof name !== 'string') return [];
  const n = name.trim();
  const stripped = n.replace(/,\s*[A-Z]{2}(\/[A-Z]{2})*$/i, '').trim();
  return WATER_ZONE_CANDIDATES[n] || WATER_ZONE_CANDIDATES[stripped]
      || (WATER_TO_R2_KEY[n] ? [WATER_TO_R2_KEY[n]] : []);
}
