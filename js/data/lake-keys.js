/**
 * Shared lake display-name → R2 key map.
 * Single source of truth for contour-data.js and supplemental-layers.js.
 *
 * resolveR2Key() uses a 5-pass strategy:
 *   1. Exact match
 *   2. Case-insensitive exact match (handles all-caps feed names like "FALLS LAKE, NC")
 *   3. State-suffix-stripped exact + case-insensitive
 *   3.5 water-aliases.js — the DNR waterbody names the river cutter placed, coastal
 *      pointers and river aliases. Ahead of the fuzzy pass on purpose; see the comment
 *      at the call site.
 *   4. Normalized fuzzy match — strips "Lake/Reservoir/etc", punctuation, state
 *      suffixes, and compares core name tokens. Handles word-order inversions
 *      ("Allatoona Lake" ↔ "Lake Allatoona"), all-caps, abbreviations, and
 *      variant suffixes without requiring explicit entries for every variant.
 *
 * Only add explicit entries where normalization alone produces a wrong or
 * non-unique match (e.g. "Falls Lake" vs "Blewett Falls Lake"), or where the
 * display name gives no hint of the R2 slug (multi-lake chains, coastal
 * catch-alls, border lakes with fixed canonical IDs).
 */
import { resolveWaterKey } from './water-aliases.js';

export const LAKE_NAME_TO_R2_KEY = {
  // ── SC Lakes ────────────────────────────────────────────────────────────────
  // The Congaree, under the name Ryan actually calls it. The registry row is displayed as
  // "Congaree River (to SC-601)" and there is a second, packless row for the same water, so
  // resolving the plain name depended entirely on which of the two registered its slug first —
  // and before the registry loads it resolved to NOTHING. Ryan, 2026-08-11: "congaree river is
  // called congaree river we have it." A water he fishes should not need a load order to resolve.
  'Congaree River':                     'congaree_river',
  'Congaree River, SC':                 'congaree_river',
  'Congaree River (to SC-601)':         'congaree_river',
  'Lake Marion, SC':                    'lake_marion',
  'Lake Moultrie, SC':                  'lake_moultrie',
  'Lake Murray, SC':                    'lake_murray',
  'Lake Wateree, SC':                   'wateree_lake',
  'Fishing Creek Reservoir, SC':        'fishing_creek_reservoir',
  'Lake Wylie, SC/NC':                  'lake_wylie',
  'Catawba Narrows, SC/NC':             'lake_wylie',   // aliased 2026-08-04 -- the reach IS Wylie's water
  'Lake Hartwell, SC/GA':               'hartwell_lake',
  'Lake Greenwood, SC':                 'lake_greenwood',
  'Lake Keowee, SC':                    'lake_keowee',
  'Lake Jocassee, SC/NC':               'lake_jocassee',
  'Lake Secession, SC':                 'secession_lake',
  'Secession Lake, SC':                 'secession_lake',
  'Lake Russell, SC/GA':                'richard_b_russell_lake',
  'Lake Russell, GA':                   'richard_b_russell_lake',
  'Lake Russell, SC':                   'richard_b_russell_lake',
  'Richard B. Russell Lake, GA':        'richard_b_russell_lake',
  'Clarks Hill / Thurmond, SC/GA':      'j_strom_thurmond_reservoir',
  'Lake Thurmond, SC':                  'j_strom_thurmond_reservoir',
  'Clarks Hill Lake, GA':               'j_strom_thurmond_reservoir',
  'Lake Monticello, SC':                'monticello_reservoir',
  'Parr Reservoir, SC':                 'parr_shoals_reservoir',
  // 2026-08-04: was 'north_saluda_reservoir'. LAKE_DB puts Lake Robinson at
  // 34.45/-80.15, which is 0.009 deg from lake_robinson (Chesterfield Co, 2,099 ac)
  // and 2.35 deg -- about 160 miles -- from North Saluda Reservoir in Greenville
  // County. Greenville Water runs both a Lake Robinson and North Saluda, which is
  // where the confusion came from, but Ryan's is the Duke one on the Black Creek.
  'Lake Robinson, SC':                  'lake_robinson',
  // AND THE OTHER ONE, which the 08-04 note above names but never mapped. Greenville Water's
  // Lake Robinson is its own registry row, `lake_robinson_greer`, 804 ac and shipped -- and
  // asking Pass 4 for its full display name returned Darlington's pack, because both rows carry
  // the legacy string 'Lake Robinson, SC' and the fuzzy pass has no way to prefer either.
  //
  // Pass 0 covers this in the browser once access-index registers the slug, so it is not what
  // the picker does today; it IS what every offline consumer of resolveR2Key does, which is why
  // keys_smoke has been reporting a shipped lake that resolves to a different slug.
  //
  // Recorded here rather than "fixed" in the matcher on purpose. Two real lakes 190 km apart
  // share a name; that is a fact about South Carolina, not a bug in a rule, and an explicit
  // mapping is the honest answer to a genuine naming disagreement -- the same argument the
  // Wittee/Wee Tee alias is filed under.
  //
  // NOT a gauge risk, checked 2026-08-14: consolidate_lake_index.py's bind() requires a centroid
  // within --max-km (25), and build_water_bindings.py requires geometry, so Darlington's Duke
  // binding and its curated ramps could never have reached Greenville. DELETION_TAB said they
  // could. They cannot, and the index proves it -- lake_robinson_greer carries no duke, no usgs
  // and no curated ramps.
  'Lake Robinson (Greenville Co, SC)':  'lake_robinson_greer',
  'Lake Bowen, SC':                     'lake_william_c_bowen',
  'Lake Blalock, SC':                   'lake_blalock',   // shipped 2026-08-04

  // ── NC Lakes ────────────────────────────────────────────────────────────────
  'Lake Norman, NC':                    'lake_norman',
  'Mountain Island Lake, NC':           'mountain_island_lake',
  'Lake Norman (South), NC':            'lake_norman',
  'Lake Hickory, NC':                   'lake_hickory',
  'Lake Rhodhiss, NC':                  'rhodhiss_lake',
  'Lake James, NC':                     'lake_james',
  // The Yadkin chain was served as ONE key, High Rock down to Blewett Falls. That key was
  // pruned from R2 on 2026-08-03 because Badin and Tillery had superseded it with their own
  // per-lake packs -- which is true for those two and false for the other two. 3DHP names
  // Badin and Tillery; it does not name High Rock or Blewett Falls, so those two had no
  // registry record to be superseded BY, and pointing them at the chain key now returns 404.
  //
  // Badin and Tillery are repointed here because their packs exist today. High Rock and
  // Blewett Falls are left OUT rather than pointed at a slug that has not been built yet: an
  // absent name falls through to the resolver and the lake is simply not offered, which is
  // honest. A name bound to a slug with no pack is a lake that appears in the list and then
  // fails to load, which is worse. Add these two back when the packs are in R2:
  //   'High Rock Lake, NC':     'high_rock_lake',
  //   'Blewett Falls Lake, NC': 'blewett_falls_lake',
  'Badin Lake, NC':                     'badin_lake',
  'Lake Tillery, NC':                   'lake_tillery',
  'High Rock Lake, NC':                 'high_rock_lake',   // shipped 2026-08-04
  'Blewett Falls Lake, NC':             'blewett_falls_lake',   // shipped 2026-08-04
  'Lookout Shoals Lake, NC':            'lookout_shoals_lake',   // shipped 2026-08-04
  'Jordan Lake, NC':                    'b_everett_jordan_lake',
  // Explicit, and it stays explicit: "falls" normalizes into "blewett falls", so without
  // this line Falls Lake resolves to Blewett Falls. That is dormant while Blewett Falls is
  // unbuilt and comes straight back the moment it returns to the registry.
  'Falls Lake, NC':                     'falls_lake',   // shipped 2026-08-04
  'W. Kerr Scott Reservoir, NC':        'w_kerr_scott_reservoir',
  // Explicit: "kerr" alone matches "w kerr scott" without this
  'Shearon Harris Reservoir, NC':       'shearon_harris_reservoir',
  'Randleman Lake, NC':                 'randleman_lake',   // shipped 2026-08-04
  // 'Lake Mackintosh, NC': 'lake_mackintosh',   // not in lake_index.json -- no pack; unmapped on purpose
  'Lake Townsend, NC':                  'lake_townsend',
  // 'Lake Michie / Little River, NC': 'lake_michie',   // not in lake_index.json -- no pack; unmapped on purpose
  // 'Lake Reidsville, NC': 'lake_reidsville',   // not in lake_index.json -- no pack; unmapped on purpose
  'Belews Lake, NC':                    'belews_lake',
  'Hyco Lake, NC':                      'hyco_lake',
  'Mayo Lake, NC':                      'mayo_reservoir',
  // 'Auman Lake, NC': 'auman_lake',   // not in lake_index.json -- no pack; unmapped on purpose
  'Bonnie Doone Lake, NC':              'bonnie_doone_lake',   // shipped 2026-08-04
  'John D. Long Lake, NC':              'lake_john_d_long_sc',
  'John H. Moss Lake, NC':              'john_h_moss_lake',   // shipped 2026-08-04
  'Oak Hollow Lake, NC':                'oak_hollow_lake',
  'Lake Higgins, NC':                   'lake_higgins',
  // 'Oak Hollow / Higgins Lake, NC' split 2026-08-04 -- one display name cannot point at two packs
  'Lake Summit, NC':                    'lake_summit',
  'Lake Waccamaw, NC':                  'lake_waccamaw',
  'Nantahala Lake, NC':                 'nantahala_lake',
  'Lake Santeetlah, NC':                'santeetlah_lake',
  'Hiwassee Lake, NC':                  'hiwassee_lake',   // shipped 2026-08-04
  'Fontana Lake, NC':                   'fontana_lake',
  'Lake Cheoah, NC':                    'cheoah_lake',   // shipped 2026-08-04

  // ── GA Lakes ────────────────────────────────────────────────────────────────
  'Lake Oconee, GA':                    'lake_oconee',
  'Lake Juliette, GA':                  'lake_juliette',   // shipped 2026-08-04
  'Lake Sinclair, GA':                  'lake_sinclair',
  // 2026-08-04: was 'lake_lanier', which is Lake Lanier in GREENVILLE COUNTY, SC --
  // 85 acres. Lake Lanier GA is Lake Sidney Lanier, 38,293 acres in Hall Co, one of
  // the largest reservoirs in the state. LAKE_DB puts it at 34.23/-83.95, inside
  // lake_sidney_lanier's bounds and 1.96 deg from the SC pond. A 450x size error in
  // the wrong state, found by coordinates after the name had passed every check.
  'Lake Lanier, GA':                    'lake_sidney_lanier',
  // Explicit: "jackson" alone matches "lake jackson" → juliette chain without this
  'Lake Jackson, GA':                   'jackson_lake',
  // 'Lake Juliette / High Falls, GA' split 2026-08-04 -- one display name cannot point at two packs
  'Kornbow Lake, GA':                   'kornbow_lake',
  'Lake Nottely, GA':                   'nottely_lake',
  'Lake Burton, GA':                    'lake_burton',
  'Lake Chatuge, GA/NC':                'chatuge_lake',

  // ── TN / NC Mountain ────────────────────────────────────────────────────────
  'Norris Lake, TN':                    'norris_lake',
  'Norris Reservoir, TN':               'norris_lake',
  'Douglas Lake, TN':                   'douglas_lake',
  'Douglas Reservoir, TN':              'douglas_lake',
  'Cherokee Lake, TN':                  'cherokee_lake',
  'Cherokee Reservoir, TN':             'cherokee_lake',
  'Fort Loudoun Lake, TN':              'fort_loudoun_lake',
  'Fort Loudoun Reservoir, TN':         'fort_loudoun_lake',
  'Tellico Lake, TN':                   'tellico_lake',
  'Tellico Reservoir, TN':              'tellico_lake',
  'Lake Chilhowee, TN':                 'chilhowee_lake',
  'Lake Cheoah, TN/NC':                 'cheoah_lake',   // shipped 2026-08-04
  'Watauga Lake, TN':                   'watauga_lake',
  'Boone Lake, TN':                     'boone_lake',
  'Boone Reservoir, TN':                'boone_lake',
  // 'Watauga / Boone Chain, TN/NC': removed 2026-08-04 -- both halves now have their own entries

  // ── SC Coastal ──────────────────────────────────────────────────────────────
  'Winyah Bay / Georgetown, SC':              'coast_winyah_bay_sc',
  'Murrells Inlet / Pawleys Island, SC':      'coast_murrells_inlet_sc',
  'Santee River Delta / North Inlet, SC':     'coast_santee_delta_sc',
  'Cape Romain / Bulls Bay, SC':              'coast_cape_romain_sc',
  'Charleston Harbor, SC':                    'coast_charleston_sc',
  'ACE Basin / Edisto, SC':                   'coast_ace_basin_sc',
  'St. Helena Sound, SC':                     'coast_st_helena_sc',
  'Beaufort / Port Royal Sound, SC':          'coast_beaufort_sc',
  'Hilton Head / Calibogue Sound, SC':        'coast_hilton_head_sc',

  // ── GA Coastal ──────────────────────────────────────────────────────────────
  'Savannah River / Savannah, GA':            'coast_savannah_ga',
  'Ossabaw / St. Catherines Sound, GA':       'coast_ossabaw_st_catherines_ga',
  'Sapelo Sound / Altamaha River, GA':        'coast_sapelo_altamaha_ga',
  'Brunswick / St. Simons Sound, GA':         'coast_brunswick_st_simons_ga',

  // ── NC Coastal ──────────────────────────────────────────────────────────────
  'Brunswick County / Shallotte Inlet, NC':   'coast_brunswick_nc',
  'Cape Fear River / Wilmington, NC':         'coast_cape_fear_nc',
  'Topsail Island / New River Inlet, NC':     'coast_topsail_new_river_nc',
};

// Build lowercase lookup once at module load for case-insensitive exact matching.
const _LOWER_MAP = Object.fromEntries(
  Object.entries(LAKE_NAME_TO_R2_KEY).map(([k, v]) => [k.toLowerCase(), v])
);

// Generic water body words stripped before fuzzy comparison so "Lake Allatoona"
// and "Allatoona Lake" and "Allatoona Reservoir" all reduce to "allatoona".
const _GENERIC = /\b(lake|lakes|reservoir|res|impoundment|pond|river|creek|fork|chain|sound|harbor|bay|inlet|basin|cove|narrows|arm)\b/g;

function _normalize(name) {
  return name
    .toLowerCase()
    .replace(/,\s*[a-z]{2}(\/[a-z]{2})*\s*$/g, '') // strip ", SC" / ", SC/GA"
    .replace(/\(.*?\)/g, '')                          // strip parentheticals
    .replace(/\bft\.?\s*/g, 'fort ')                  // "Ft." → "fort"
    .replace(/\bst\.?\s*/g, 'saint ')                 // "St." → "saint"
    .replace(/\bw\.?\s+kerr\b/g, 'w kerr')
    .replace(_GENERIC, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Pre-compute normalized forms of all keys once at module load.
const _NORM_MAP = Object.entries(LAKE_NAME_TO_R2_KEY)
  .map(([k, v]) => [_normalize(k), v])
  .filter(([kn]) => kn.length > 0);

// display name (and its lowercase form) -> registry slug. Populated by access-index.js once
// lake_index.json loads; a curated entry in LAKE_NAME_TO_R2_KEY still wins if it is the
// SAME key, and differs only where the curated map has a legacy name we want to keep.
const _REGISTRY_KEYS = new Map();

/**
 * Teach resolveR2Key() about the registry. Called once per lake as the index is built.
 * Existing curated names are not overwritten — those keys are what is already in R2 and
 * renaming them would orphan live chartpacks.
 */
export function registerR2Key(displayName, slug) {
  if (!displayName || !slug) return;
  const t = String(displayName).trim();
  if (!t) return;
  // THE REGISTRY SLUG WINS, including over a curated name.
  //
  // This used to defer to LAKE_NAME_TO_R2_KEY on the theory that a curated key was already
  // serving a live chartpack and overriding it would orphan the object. That had it exactly
  // backwards. The curated keys exist because lakes could not be cleanly separated out of
  // 3DHP -- which is why several of them are COMBINED packs covering two lakes at once
  // (lake_wateree_fishing_creek, lake_norman_mountain_island, lake_hickory_rhodhiss). The
  // registry now separates them, one pack per lake, and deferring to the old key would keep
  // the app reading a merged pack while the correct per-lake one sat unused beside it.
  //
  // Ryan, 2026-08-02: "i want the lakes to be separated... nothing on R2 is irreplaceable."
  //
  // FIRST writer wins, though. Display names are not unique -- 40 of them in the index belong
  // to two or more lakes -- and the caller walks the registry list in priority order (shipped
  // first, then largest). Last-writer-wins meant the 39-acre `Lake Oconee, GA` registered
  // after the 17,436-acre one and took the name off it, so selecting Oconee fetched
  // `lake_oconee_2`. Ten shipped lakes resolved to a namesake's pack that way, silently: the
  // key is well-formed, the fetch succeeds, and the wrong lake's contours draw.
  //
  // Genuine shipped-vs-shipped collisions never reach here -- lake-registry.js gives those a
  // distinguishing suffix, so both members arrive with names of their own.
  if (!_REGISTRY_KEYS.has(t)) _REGISTRY_KEYS.set(t, slug);
  const lower = t.toLowerCase();
  if (!_REGISTRY_KEYS.has(lower)) _REGISTRY_KEYS.set(lower, slug);
}

/**
 * Names with no chartpack, that must resolve to NOTHING.
 *
 * Commenting an entry out of the map above is NOT enough, and assuming it was is a
 * bug this file already shipped once. With no explicit entry the resolver falls
 * through to the fuzzy pass, which answers anyway — and answers wrong:
 *
 *     'Kerr Lake, NC'  ->  w_kerr_scott_reservoir
 *
 * Kerr Lake (John H. Kerr / Buggs Island) is ~50,000 acres on the NC/VA line.
 * W. Kerr Scott Reservoir is 1,280 acres in Wilkes County. Different lake, 1/40th
 * the size, and the app would have drawn its contours with nothing in the UI saying
 * so. Removing a mapping makes the answer worse than leaving it wrong-but-known,
 * unless the name is also refused explicitly.
 *
 * A name leaves this set when its pack is built, not before.
 */
export const LAKE_NAMES_WITHOUT_PACK = new Set([
  // 2026-08-04: fourteen names left this set when their packs were built and installed --
  // Randleman, Kerr, High Rock, Falls, John H. Moss, Bonnie Doone, Blewett Falls, Hiwassee,
  // Cheoah, Lookout Shoals, Juliette and Blalock. Removing them here is not optional
  // bookkeeping: hasNoPack() is consulted BEFORE any matching runs, so a name left in this
  // set is refused no matter what LAKE_NAME_TO_R2_KEY says about it.
  // What stays below has no pack and no way to get one -- no DNR ramp to seed a boundary
  // from, or a combined name whose halves are separately selectable.
  // Removed by the R2 prune / never built. Listed explicitly so the fuzzy pass
  // cannot answer for them later.
  // Combined names whose halves are now selectable on their own. Both used to
  // resolve to ONE half silently -- 'Lake Juliette / High Falls' returned High
  // Falls (562 ac) while Juliette (~3,600 ac) is the half most people mean.
  'Lake Juliette / High Falls, GA',
  'Watauga / Boone Chain, TN/NC',
  'Auman Lake, NC',
  'Lake Mackintosh, NC',
  'Lake Michie / Little River, NC',
  'Lake Reidsville, NC',
  // OUT OF REGION, cut 2026-08-19. Ryan: "if they are outside the boundary then they are cut".
  //
  // These are NOT here because the water does not exist -- all nine are real, several are big
  // (Kerr ~41,940 ac, Watts Bar ~33,441). They are outside the region polygon, so consolidate
  // drops them and lake_index.json never offered them. What kept them reachable was this file:
  // contour-data.js resolves a display name here and fetches chartpacks/<key>/contours.geojson
  // straight from R2, consulting no registry row.
  //
  // THEY ARE REFUSED RATHER THAN DELETED, and the difference is not bookkeeping. Cutting the
  // mapping alone does not stop a name answering -- it re-points it. Measured before making
  // this change: with its mapping simply removed, 'High Falls Lake, GA' resolved to
  // `falls_lake`, which is Falls Lake in NORTH CAROLINA and does ship. That is the
  // 'Kerr Lake, NC' -> w_kerr_scott_reservoir failure this file already documents, with a new
  // pair. hasNoPack() runs BEFORE any matching, so a name in this set is refused outright.
  'Lake Allatoona, GA',
  'Lake Blue Ridge, GA',
  'High Falls Lake, GA',
  'Kerr Lake, NC',
  'John H. Kerr Reservoir, NC',
  'Lake Blackshear, GA',
  'Tobesofkee Reservoir, GA',
  'Melton Hill Lake, TN',
  'Melton Hill Reservoir, TN',
  'South Holston Lake, TN',
  'South Holston Reservoir, TN',
  'Watts Bar Lake, TN',
  'Watts Bar Reservoir, TN',
  // North Fork Reservoir, NC is IN the region -- Garmin simply never surveyed it, and its R2
  // pack is i-Boating. Same refusal, different reason.
  'North Fork Reservoir, NC',
]);

/** Normalised membership test — the set is keyed by display name, users are not. */
function hasNoPack(name) {
  const n = String(name).trim().toLowerCase();
  for (const k of LAKE_NAMES_WITHOUT_PACK) {
    const kk = k.toLowerCase();
    if (n === kk || n === kk.replace(/,\s*[a-z]{2}(\/[a-z]{2})?$/, '').trim()) return true;
  }
  return false;
}

/*
 * BATES OLD RIVER HAS ITS OWN PACK NOW, AND THE TABLE THAT SENT IT TO THE CONGAREE IS GONE.
 *
 * What stood here was `PACK_SHARED_WITH`, a one-row map from `'bates old river'` to
 * `congaree_river`, consulted BEFORE the registry-slug pass so that a curated answer could
 * outrank the registry. It existed because 3DHP has no waterbody polygon for Bates at all --
 * gnisid 1220360 is eleven flowlines and zero polygons, seven of them filed under the
 * Congaree's own river polygon OH8SM -- so the only place Garmin's soundings for it existed
 * was inside `chartpack/congaree_river/`.
 *
 * Ryan was right about the water the whole time: *"bates river is an oxbow off of the congaree
 * completely separate water... that is like saying lake wateree isn't its own water because the
 * wateree river connects to it"*. On 2026-08-22 it got a boundary of its own, cut from the
 * 3DHP centreline rather than from a polygon that does not exist, and a registry row to go with
 * it: `bates_old_river`, 66.5 acres, 77.1% of the centreline, holding 8,478 of the 10,508
 * Quickdraw soundings, charted 0.293. The pack is in R2.
 *
 * So the registry answers for it now, like every other water, and a curated row that outranks
 * the registry would be actively wrong -- it would keep sending Bates to a pack that no longer
 * has to carry it. The mechanism went with the row: an empty table and the function that read
 * it are two objects nobody uses, and this repo has been bitten by leftovers often enough.
 *
 * `BATES_HAS_ITS_OWN_ROW_2026-08-22.md`, `A_LINE_IS_ENOUGH_TO_CUT_A_BOUNDARY_2026-08-22.md`.
 */

export function resolveR2Key(displayName) {
  if (!displayName || typeof displayName !== 'string') return null;
  const trimmed = displayName.trim();
  if (!trimmed) return null;

  // Refused before any matching runs. See LAKE_NAMES_WITHOUT_PACK above.
  if (hasNoPack(trimmed)) return null;

  // Pass 0 — the 3DHP registry slug, which is authoritative when it exists.
  //
  // It goes FIRST because the fuzzy pass below is the wrong tool at 1,551 lakes. Pass 4
  // matches on substring containment and prefers the longest canonical key, so a registry
  // lake called "Lake Wallace, SC" would happily resolve to whatever curated key contains
  // "wallace" — and SC has TWO Lake Wallaces, at 273 and 155 acres. The registry key is a
  // GNIS-derived slug, so it is unique by construction and needs no guessing.
  //
  // Registered lazily by access-index.js as the registry loads; before that this is empty
  // and behaviour is exactly as it was.
  const slug = _REGISTRY_KEYS.get(trimmed) || _REGISTRY_KEYS.get(trimmed.toLowerCase());
  if (slug) return slug;

  // Pass 1 — exact match
  if (LAKE_NAME_TO_R2_KEY[trimmed]) return LAKE_NAME_TO_R2_KEY[trimmed];

  // Pass 2 — case-insensitive exact match
  const lower = trimmed.toLowerCase();
  if (_LOWER_MAP[lower]) return _LOWER_MAP[lower];

  // Pass 3 — state-suffix-stripped exact + case-insensitive
  const stripped = trimmed.replace(/,\s*[A-Z]{2}(\/[A-Z]{2})*$/i, '').trim();
  if (stripped !== trimmed) {
    if (LAKE_NAME_TO_R2_KEY[stripped]) return LAKE_NAME_TO_R2_KEY[stripped];
    if (_LOWER_MAP[stripped.toLowerCase()]) return _LOWER_MAP[stripped.toLowerCase()];
  }

  // Pass 3.5 — the DNR waterbody names the river cutter placed.
  //
  // 158 coastal names and 12 river aliases, generated into water-aliases.js from
  // _coastal_pointers.json and _river_aliases.json. They come from the worker's /ramps feed,
  // so none of them is in the curated map or the registry, and every one of them used to fall
  // into Pass 4.
  //
  // It goes BEFORE Pass 4 rather than after because Pass 4 does not decline to answer.
  // Measured 2026-08-04 over all 170: 128 resolved to nothing, 9 to the right place, and 21 to
  // the WRONG water -- "May River" in Bluffton SC to Mayo Lake in North Carolina, "Black
  // Creek" on the Pee Dee to Lake Blackshear in Georgia, "South Creek" on the Pamlico to South
  // Holston in Tennessee. A substring match with no notion of distance or state will always
  // beat an empty answer, and it should not.
  const placed = resolveWaterKey(trimmed);
  if (placed) return placed;

  // Pass 4 — normalized fuzzy match
  // Derives R2 key from core lake name, handling word-order inversions,
  // all-caps, variant suffixes, and vendor naming differences automatically.
  // Prefers longer canonical key matches to avoid short tokens over-matching.
  const dn = _normalize(trimmed);
  if (!dn) return null;

  // A river is not a lake, and Pass 4 could never tell.
  //
  // The substring test has no notion of water type, so a name whose subject is moving
  // water matched whatever impoundment happened to contain its letters:
  //
  //     Catawba River  -> lake_wylie                 (an impoundment ON the Catawba)
  //     May River      -> mayo_lake                  (NC, ~400 km away)
  //     Black Creek    -> lake_blackshear            (Georgia)
  //     South Creek    -> south_holston_lake         (Tennessee)
  //
  // Pass 3.5 now places the 170 names the cutter generates, but any OTHER river or
  // creek name still falls to here — and this surfaced again the moment a curated
  // entry was removed: with 'Catawba Narrows' gone, 'Catawba River' immediately began
  // resolving to Lake Wylie. Removing a bad mapping is not neutral while Pass 4 will
  // answer in its place.
  //
  // So the type has to agree. Flowing water and standing water never match each other.
  const FLOWING = /\b(river|creek|run|branch|fork|stream|canal|slough|bayou)\b/i;
  const dnFlowing = FLOWING.test(trimmed);

  let best = null;
  let bestLen = 0;
  for (const [kn, v] of _NORM_MAP) {
    if (dn === kn || dn.includes(kn) || kn.includes(dn)) {
      // `kn` is normalised, which strips the generic word — test the key it came from.
      if (dnFlowing !== FLOWING.test(v)) continue;
      if (kn.length > bestLen) {
        bestLen = kn.length;
        best = v;
      }
    }
  }
  return best;
}
