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
  'ACE Basin / Edisto, SC':             'sc_ga_coastal',
  'Charleston Harbor, SC':              'sc_ga_coastal',
  'Winyah Bay / Georgetown, SC':        'sc_ga_coastal',
  'Beaufort / Port Royal Sound, SC':    'sc_ga_coastal',
  'St. Helena Sound, SC':               'sc_ga_coastal',
  'Hilton Head / Calibogue Sound, SC':  'sc_ga_coastal',
  'Santee River Delta / North Inlet, SC': 'sc_ga_coastal',
  'Savannah River / Savannah, GA':      'sc_ga_coastal',
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

export function resolveR2Key(displayName) {
  if (!displayName || typeof displayName !== 'string') return null;
  const trimmed = displayName.trim();
  if (!trimmed) return null;

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
