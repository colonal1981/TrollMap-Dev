/**
 * Shared lake display-name → R2 key map.
 * Single source of truth for contour-data.js and supplemental-layers.js.
 *
 * resolveR2Key() uses a 4-pass strategy:
 *   1. Exact match
 *   2. Case-insensitive exact match (handles all-caps feed names like "FALLS LAKE, NC")
 *   3. State-suffix-stripped exact + case-insensitive
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
export const LAKE_NAME_TO_R2_KEY = {
  // ── SC Lakes ────────────────────────────────────────────────────────────────
  'Lake Marion, SC':                    'lake_marion',
  'Lake Moultrie, SC':                  'lake_moultrie',
  'Lake Murray, SC':                    'lake_murray',
  'Lake Wateree, SC':                   'lake_wateree_fishing_creek',
  'Fishing Creek Reservoir, SC':        'lake_wateree_fishing_creek',
  'Lake Wylie, SC/NC':                  'lake_wylie',
  'Catawba Narrows, SC/NC':             'catawba_narrows',
  'Lake Hartwell, SC/GA':               'lake_hartwell',
  'Lake Greenwood, SC':                 'lake_greenwood_secession',
  'Lake Keowee, SC':                    'lake_keowee',
  'Lake Jocassee, SC/NC':               'lake_jocassee',
  'Lake Secession, SC':                 'lake_thurmond_russell',
  'Secession Lake, SC':                 'lake_thurmond_russell',
  'Lake Russell, SC/GA':                'lake_thurmond_russell',
  'Lake Russell, GA':                   'lake_thurmond_russell',
  'Lake Russell, SC':                   'lake_thurmond_russell',
  'Richard B. Russell Lake, GA':        'lake_thurmond_russell',
  'Clarks Hill / Thurmond, SC/GA':      'lake_thurmond_russell',
  'Lake Thurmond, SC':                  'lake_thurmond_russell',
  'Clarks Hill Lake, GA':               'lake_thurmond_russell',
  'Lake Monticello, SC':                'lake_monticello_parr',
  'Parr Reservoir, SC':                 'lake_monticello_parr',
  'Lake Robinson, SC':                  'north_saluda_reservoir',
  'Lake Bowen, SC':                     'lake_bowen',
  'Lake Blalock, SC':                   'lake_blalock',

  // ── NC Lakes ────────────────────────────────────────────────────────────────
  'Lake Norman, NC':                    'lake_norman_mountain_island',
  'Mountain Island Lake, NC':           'lake_norman_mountain_island',
  'Lake Norman (South), NC':            'lake_norman',
  'Lake Hickory, NC':                   'lake_hickory_rhodhiss',
  'Lake Rhodhiss, NC':                  'lake_hickory_rhodhiss',
  'Lake James, NC':                     'lake_james',
  'High Rock Lake, NC':                 'yadkin_river_chain',
  'Badin Lake, NC':                     'yadkin_river_chain',
  'Lake Tillery, NC':                   'yadkin_river_chain',
  'Blewett Falls Lake, NC':             'yadkin_river_chain',
  'Jordan Lake, NC':                    'jordan_lake',
  // Explicit: "falls" normalizes to match "blewett falls" → yadkin without this
  'Falls Lake, NC':                     'falls_lake',
  'W. Kerr Scott Reservoir, NC':        'w_kerr_scott_reservoir',
  // Explicit: "kerr" alone matches "w kerr scott" without this
  'Kerr Lake, NC':                      'kerr_lake',
  'John H. Kerr Reservoir, NC':         'kerr_lake',
  'Shearon Harris Reservoir, NC':       'shearon_harris_reservoir',
  'Randleman Lake, NC':                 'randleman_lake',
  'Lake Mackintosh, NC':                'lake_mackintosh',
  'Lake Townsend, NC':                  'lake_townsend',
  'Lake Michie / Little River, NC':     'lake_michie',
  'Lake Reidsville, NC':                'lake_reidsville',
  'North Fork Reservoir, NC':           'north_fork_reservoir',
  'Belews Lake, NC':                    'belews_lake',
  'Hyco Lake, NC':                      'hyco_lake',
  'Mayo Lake, NC':                      'mayo_lake',
  'Auman Lake, NC':                     'auman_lake',
  'Bonnie Doone Lake, NC':              'bonnie_doone_lake',
  'John D. Long Lake, NC':              'john_d_long_lake',
  'John H. Moss Lake, NC':              'john_h_moss_lake',
  'Oak Hollow / Higgins Lake, NC':      'oak_hollow_higgins',
  'Lake Summit, NC':                    'lake_summit',
  'Lake Waccamaw, NC':                  'lake_waccamaw',
  'Nantahala Lake, NC':                 'nantahala_lake',
  'Lake Santeetlah, NC':                'lake_santeetlah',
  'Hiwassee Lake, NC':                  'hiwassee_lake',
  'Fontana Lake, NC':                   'fontana_lake',
  'Lake Cheoah, NC':                    'lake_cheoah',

  // ── GA Lakes ────────────────────────────────────────────────────────────────
  'Lake Oconee, GA':                    'lake_oconee',
  'Lake Sinclair, GA':                  'lake_sinclair',
  'Lake Lanier, GA':                    'lake_lanier',
  // Explicit: "jackson" alone matches "lake jackson" → juliette chain without this
  'Lake Jackson, GA':                   'lake_juliette_high_falls',
  'Lake Juliette / High Falls, GA':     'lake_juliette_high_falls',
  'Lake Blackshear, GA':                'lake_blackshear',
  'Lake Allatoona, GA':                 'lake_allatoona',
  'Tobesofkee Reservoir, GA':           'tobesofkee_reservoir',
  'Kornbow Lake, GA':                   'kornbow_lake',
  'Lake Blue Ridge, GA':                'lake_blue_ridge',
  'Lake Nottely, GA':                   'lake_nottely',
  'Lake Burton, GA':                    'lake_burton',
  'Lake Chatuge, GA/NC':                'lake_chatuge',

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
  'Melton Hill Lake, TN':               'melton_hill_lake',
  'Melton Hill Reservoir, TN':          'melton_hill_lake',
  'South Holston Lake, TN':             'south_holston_lake',
  'South Holston Reservoir, TN':        'south_holston_lake',
  'Lake Chilhowee, TN':                 'lake_chilhowee',
  'Lake Cheoah, TN/NC':                 'lake_cheoah',
  'Watauga Lake, TN':                   'watauga_boone_chain',
  'Boone Lake, TN':                     'watauga_boone_chain',
  'Boone Reservoir, TN':                'watauga_boone_chain',
  'Watauga / Boone Chain, TN/NC':       'watauga_boone_chain',
  'Watts Bar Lake, TN':                 'watts_bar_lake',
  'Watts Bar Reservoir, TN':            'watts_bar_lake',

  // ── SC Coastal ──────────────────────────────────────────────────────────────
  'Winyah Bay / Georgetown, SC':              'coast_winyah_bay_sc',
  'Murrells Inlet / Pawleys Island, SC':      'coast_murrells_inlet_sc',
  'Santee River Delta / North Inlet, SC':     'coast_santee_delta_sc',
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
  'Cumberland Island / St. Marys, GA':        'coast_cumberland_st_marys_ga',

  // ── NC Coastal ──────────────────────────────────────────────────────────────
  'Brunswick County / Shallotte Inlet, NC':   'coast_brunswick_nc',
  'Cape Fear River / Wilmington, NC':         'coast_cape_fear_nc',
  'Topsail Island / New River Inlet, NC':     'coast_topsail_new_river_nc',
  'Bogue Sound / Morehead City, NC':          'coast_bogue_sound_nc',
  'Core Sound / Cape Lookout, NC':            'coast_core_sound_nc',
  'Pamlico Sound / Neuse River, NC':          'coast_pamlico_sound_nc',
  'Outer Banks / Oregon Inlet, NC':           'coast_outer_banks_nc',
  'Albemarle Sound / Elizabeth City, NC':     'coast_albemarle_sound_nc',
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

export function resolveR2Key(displayName) {
  if (!displayName || typeof displayName !== 'string') return null;
  const trimmed = displayName.trim();
  if (!trimmed) return null;

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

  // Pass 4 — normalized fuzzy match
  // Derives R2 key from core lake name, handling word-order inversions,
  // all-caps, variant suffixes, and vendor naming differences automatically.
  // Prefers longer canonical key matches to avoid short tokens over-matching.
  const dn = _normalize(trimmed);
  if (!dn) return null;

  let best = null;
  let bestLen = 0;
  for (const [kn, v] of _NORM_MAP) {
    if (dn === kn || dn.includes(kn) || kn.includes(dn)) {
      if (kn.length > bestLen) {
        bestLen = kn.length;
        best = v;
      }
    }
  }
  return best;
}
