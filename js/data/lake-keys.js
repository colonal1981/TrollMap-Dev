/**
 * Shared lake display-name → R2 key map.
 * Single source of truth for contour-data.js and supplemental-layers.js.
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
  'Falls Lake, NC':                     'falls_lake',
  'W. Kerr Scott Reservoir, NC':        'w_kerr_scott_reservoir',
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
  'Fort Loundon Reservoir, TN':         'fort_loudoun_lake',
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

export function resolveR2Key(displayName) {
  // 1. Exact match
  if (LAKE_NAME_TO_R2_KEY[displayName]) return LAKE_NAME_TO_R2_KEY[displayName];
  // 2. Strip state suffix ", SC" / ", NC/GA" etc
  const stripped = displayName.replace(/,\s*[A-Z]{2}(\/[A-Z]{2})?$/, '').trim();
  if (LAKE_NAME_TO_R2_KEY[stripped]) return LAKE_NAME_TO_R2_KEY[stripped];
  // 3. Case-insensitive partial match (handles "(Duke Energy)", county suffixes, etc.)
  const dl = stripped.toLowerCase();
  const found = Object.entries(LAKE_NAME_TO_R2_KEY).find(([k]) => {
    const kl = k.toLowerCase().replace(/,\s*[a-z]{2}(\/[a-z]{2})?$/, '').trim();
    return dl.includes(kl) || kl.includes(dl);
  });
  return found ? found[1] : null;
}
