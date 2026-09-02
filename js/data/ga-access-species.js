/**
 * js/data/ga-access-species.js — the fish Georgia publishes as 48 yes/no columns.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * GEORGIA HAS SPECIES AND WE WERE ASKING THE WRONG QUESTION. Both readers of the WRD Water
 * Access Points layer -- RESEARCH_RAMP_SOURCES in Worker/research/facts-util.js and
 * Scripts/build_dnr_ramps_by_lake.py -- ask it for `SpeciesList`, which is South Carolina's
 * field name. Georgia's layer does not have it and never has. The comment in the Python said
 * the saved dump "was written before this field was noticed"; the dump is not the problem.
 *
 * What the layer actually publishes, counted on Ryan's 2026-09-02 download of the same service:
 * 895 access points, 892 of them carrying at least one species, across 373 distinct waterbodies
 * -- 306 Major Reservoir, 235 Small Impoundment, 231 River, 73 Coastal, 47 Trout Stream. All 48
 * columns are in use. That is the roster for every Georgia river and small impoundment we hold,
 * and the full inshore set for all four Georgia coastal zones, and we were reading none of it.
 *
 * ONE DEFINITION, TWO RUNTIMES. The Worker imports this directly -- Worker/research/limnology.js
 * already imports js/data/lake-keys.js, so reaching into js/data from the Worker bundle is the
 * established shape -- and the Python build runs it under node rather than keeping a second
 * copy, the same way Scripts/research_lakes.py runs the off-lake gate. A table that maps an
 * abbreviation to a fish is exactly the kind that drifts when it is written twice, and this
 * project has paid for that twice today already.
 *
 * `Y` IS THE ONLY YES. The layer's values are Y, N, U, None and blank; `U` is unknown, which is
 * not a fish. Counted across all 895 points, those five are the whole vocabulary.
 *
 * The NAMES are what the app calls these fish, so canonicalizeResearchSpecies() folds them onto
 * the plan form's own checkbox values. Nothing here decides whether a fish is worth showing:
 * uniqueResearchSpecies() drops the forage and rough fish through NON_GAME_SPECIES, which is why
 * American and Hickory Shad, Common Carp, Smallmouth Buffalo, Longnose Gar and Freshwater Drum
 * are named here and never reach a roster.
 */

/** Column name in the layer -> the fish, in the app's vocabulary. The layer's own order. */
export const GA_ACCESS_SPECIES_COLUMNS = Object.freeze({
  Largemouth:   'Largemouth Bass',
  Smallmouth:   'Smallmouth Bass',
  ShoalBass:    'Shoal Bass',
  SpotBass:     'Spotted Bass',
  SuwBass:      'Suwannee Bass',
  RedeyeBass:   'Redeye Bass',
  WhiteBass:    'White Bass',
  StripBass:    'Striped Bass',
  HybStrpBas:   'Hybrid Striped Bass',
  ChannelCat:   'Channel Catfish',
  Flathead:     'Flathead Catfish',
  BlueCat:      'Blue Catfish',
  WhiteCat:     'White Catfish',
  YellowBull:   'Yellow Bullhead',
  WhiteCrap:    'White Crappie',
  BlackCrap:    'Black Crappie',
  Flier:        'Flier',
  Bluegill:     'Bluegill',
  Redbreast:    'Redbreast Sunfish',
  RedearSun:    'Redear Sunfish (Shellcracker)',
  SpottedSun:   'Spotted Sunfish',
  RockBass:     'Rock Bass',
  ShadowBass:   'Shadow Bass',
  Warmouth:     'Warmouth',
  BrownTrout:   'Brown Trout',
  RbwTrout:     'Rainbow Trout',
  BrookTrout:   'Brook Trout',
  AmerShad:     'American Shad',
  HickShad:     'Hickory Shad',
  Walleye:      'Walleye',
  Yell_Perch:   'Yellow Perch',
  YellowBass:   'Yellow Bass',
  ChainPick:    'Chain Pickerel',
  RedfinPick:   'Redfin Pickerel',
  FreshDrum:    'Freshwater Drum',
  CommonCarp:   'Common Carp',
  SM_Buffalo:   'Smallmouth Buffalo',
  LN_Gar:       'Longnose Gar',
  Bowfin:       'Bowfin',
  Redfish:      'Red Drum (Redfish)',
  SeaTrout:     'Spotted Seatrout',
  Flounder:     'Southern Flounder',
  Sheepshead:   'Sheepshead',
  BrownBull:    'Brown Bullhead',
  // THE REDEYE COMPLEX GEORGIA NOW SEPARATES. These four were one fish until the descriptions
  // of the last few years split them out by river system, and the layer carries a column each:
  // Bartram's on 7 access points, Chattahoochee on 6, Altamaha on 5, Tallapoosa on 5. Named
  // without an apostrophe on purpose -- normalizeResearchName() turns "Bartram's Bass" into
  // "bartram s bass", which matches nothing, while "Bartrams Bass" already folds to Redeye Bass
  // in RESEARCH_SPECIES_CANON.
  ChattBass:    'Chattahoochee Bass',
  Bartrams:     'Bartrams Bass',
  Tallapoosa:   'Tallapoosa Bass',
  AltamahaBass: 'Altamaha Bass',
});

/** The layer says a fish is here only when it says Y. `U` is unknown and is not a yes. */
const isYes = (v) => String(v == null ? '' : v).trim().toUpperCase() === 'Y';

/**
 * One access point's properties -> the fish it lists, in the app's vocabulary.
 *
 * Returns a comma-joined string rather than an array because that is the shape both callers
 * already handle: SCDNR's `SpeciesList` is a comma-joined string and splitSpeciesText() is what
 * reads it. One shape for both states means the readers do not need to know which is which.
 */
export function gaAccessSpecies(props) {
  const out = [];
  for (const [col, name] of Object.entries(GA_ACCESS_SPECIES_COLUMNS)) {
    if (isYes(props && props[col])) out.push(name);
  }
  return out.join(', ');
}
