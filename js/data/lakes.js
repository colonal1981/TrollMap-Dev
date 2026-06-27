/**
 * Curated lake database with USGS gauges, Duke Energy basin mappings, and
 * fishery notes for the Carolinas region.
 *
 * Each lake entry contains:
 *   center: [lat, lon, defaultZoom]
 *   bounds: [[south, west], [north, east]]
 *   usgs:   { site, params }   — only used for temperature; POOL gauges
 *                            are NOT used for rivers below dams
 *   duke:   Duke Energy basin name (for lake-level dashboard lookup)
 *   ramps:  curated launch sites (object of name → [lat, lon])
 *   normalPool, minPool, etc. — published operating curves
 */

export const LAKE_DB = {
  "Lake Marion, SC": {
    center: [33.55, -80.30, 11],
    bounds: [[33.20, -80.75],[33.82, -80.12]],
    usgs: {site:"02169921", params:"00062"}, // Lake Marion reservoir elevation (USGS lake gauge)
    ramps: {
      "Santee State Park": [33.5181, -80.4889],
      "Rimini / Pack's Landing": [33.6706, -80.5367],
      "C. Alex Harvin III Landing": [33.5589, -80.2039],
      "Rowland Subdivision Landing": [33.5466, -80.2244],
      "White Oak III Landing": [33.5717, -80.2161],
      "Borrow Pit Launch": [33.5147, -80.1850],
      "John C. Land III Landing": [33.5239, -80.3094],
      "Taw Caw Park": [33.5353, -80.3319],
      "Taw Caw Creek Launch": [33.5339, -80.3306],
      "Low Falls Landing": [33.4170, -80.2370]
    }
  },
  "Lake Moultrie, SC": {
    center: [33.28, -80.05, 11],
    bounds: [[33.05, -80.12],[33.50, -79.75]],
    usgs: {site:"02172000", params:"00062"}, // Lake Moultrie reservoir elevation (USGS lake gauge)
    ramps: {
      "Short Stay Recreation Area": [33.2425, -79.9926],
      "Bonneau Ferry Ramp": [33.3262, -79.9701],
      "Amos Lee Gourdine (Russellville)": [33.3283, -80.0381],
      "Angels Landing": [33.3255, -80.1065],
      "Fred L. Day Landing": [33.2956, -80.1564],
      "Hatchery Boat Ramp": [33.2683, -80.1031]
    }
  },
  "Lake Murray, SC": {
    center: [34.08, -81.35, 11],
    bounds: [[33.90, -81.70],[34.20, -81.05]],
    usgs: {site:"02168500", params:"00062,62615"}, // Lake Murray reservoir elevation; NOT downstream Saluda River
    ramps: {
      "Hilton Recreation Area": [34.09421, -81.32882],
      "Larry Koon Landing": [34.04694, -81.36083],
      "Lake Murray Dam (Irmo)": [34.0539, -81.2559],
      "Rocky Point Landing": [34.01505, -81.44525],
      "Billy Dreher Island SP": [34.0875, -81.4322],
      "SCE&G Lake Murray Shores (#3)": [34.0058, -81.4785],
      "SCE&G Riverbend (#4)": [34.0310, -81.5208],
      "SCE&G Lake Murray Estates (#8)": [34.0430, -81.5580],
      "Kempson's Bridge": [34.2805, -81.4875],
      "Buffalo Creek Access": [34.2590, -81.4488],
      "Higgin's Bridge (SC-121)": [34.1935, -81.4442]
    }
  },
  "Lake Wateree, SC": {
    center: [34.41, -80.86, 12],
    bounds: [[34.20, -81.05],[34.58, -80.68]],
    // CRITICAL: USGS 02148000 is the RIVER GAUGE BELOW Wateree Dam.
    // It is NOT the lake pool level. Duke Energy dashboard is authoritative for pool elevation.
    // We only request temperature (00010) from USGS. 00065 (river stage) is deliberately excluded.
    usgs: {site:"02148000", params:"00010"}, 
    ramps: {
      "Clearwater Cove": [34.37927, -80.72881],
      "Lake Wateree State Park": [34.4363, -80.8641],
      "SCDNR Beaver Creek Access": [34.4328, -80.8584],
      "Taylor Creek Access": [34.4375, -80.8758],
      "Wateree Creek Access": [34.4693, -80.9136],
      "June Creek Access": [34.3908, -80.8294],
      "Colonel Creek Access": [34.3692, -80.7986],
      "Lugoff Access (US-1 Bridge)": [34.2230, -80.7050]
    }
  },
  "Lake Wylie, SC/NC": {
    center: [35.10, -81.05, 11],
    bounds: [[34.95, -81.20],[35.20, -80.90]],
    duke: 'lake wylie',
    // Duke API is authoritative for Lake Wylie pool level; USGS 02146000 is river below dam.
    normalPool: 569.4, minPool: 566.0,
    ramps: {
      "Buster Boyd Access": [35.1026, -81.0366],
      "Ebenezer Park": [35.0315, -81.0454],
      "Allison Creek": [35.0441, -81.0664],
      "Copperhead Island": [35.1278, -81.0287]
    }
  },
  "Lake Hartwell, SC/GA": {
    center: [34.48, -82.85, 11],
    bounds: [[34.30, -83.15],[34.65, -82.70]],
    ramps: {
      "Green Pond Landing": [34.5422, -82.7845],
      "Broyles Rec Area": [34.5381, -82.8094],
      "Singing Pines": [34.3934, -82.8587],
      "Tugaloo State Park GA": [34.4988, -83.1042]
    }
  },
  "Clarks Hill / Thurmond, SC/GA": {
    center: [33.66, -82.20, 11],
    bounds: [[33.40, -82.55],[33.90, -82.00]],
    ramps: {
      "Clarks Hill Rec Area": [33.662, -82.199],
      "Elijah Clark State Park GA": [33.652, -82.363],
      "Modoc Ramp": [33.720, -82.220],
      "Chamberlain Ferry": [33.55, -82.12]
    }
  },
  "Lake Greenwood, SC": {
    center: [34.20, -81.95, 12],
    bounds: [[34.08, -82.15],[34.30, -81.80]],
    ramps: {
      "Lake Greenwood State Park": [34.196, -81.948],
      "Main Ramp – US 221": [34.220, -81.980]
    }
  },
  "Lake Keowee, SC": {
    center: [34.70, -82.90, 12],
    bounds: [[34.55, -83.05],[34.85, -82.75]],
    duke: 'lake keowee',
    // Duke API is authoritative for Lake Keowee pool level. Removed bad legacy USGS 02063000 (VA stream).
    normalPool: 800.0, minPool: 790.0,
    ramps: {
      "South Cove Park": [34.648, -82.918],
      "High Falls Park": [34.767, -82.881],
      "Warpath Landing": [34.800, -82.885]
    }
  },
  "Lake Jocassee, SC/NC": {
    center: [34.96, -82.92, 13],
    bounds: [[34.90, -83.00],[35.02, -82.85]],
    ramps: {
      "Devils Fork State Park": [34.961, -82.941]
    }
  },
  "Lake Russell, SC/GA": {
    center: [34.15, -82.60, 11],
    bounds: [[33.95, -82.75],[34.35, -82.45]],
    ramps: {
      "Calhoun Falls State Park": [34.078, -82.609],
      "Elberton Park GA": [34.12, -82.70]
    }
  },
  "Lake Secession, SC": {
    center: [34.08, -82.60, 13],
    bounds: [[34.02, -82.65],[34.14, -82.55]],
    ramps: { "Secession Landing": [34.081, -82.595] }
  },
  "Lake Monticello, SC": {
    center: [34.32, -81.31, 13],
    bounds: [[34.30, -81.42],[34.42, -81.22]],
    // No verified live reservoir gauge wired yet; do not use Broad River 02156500 as lake pool.
    dominion: true,
    ramps: {
      "Hwy 215 Public Ramp": [34.3271, -81.2852],
      "Hwy 99 North Ramp": [34.3763, -81.3179],
      "Recreational Lake Ramp (10hp max)": [34.3793, -81.3134]
    }
  },
  "Parr Reservoir, SC": {
    center: [34.258, -81.337, 13],
    bounds: [[34.22, -81.46],[34.30, -81.28]],
    usgs: {site:"02160990", params:"00062"}, // Parr Reservoir elevation
    dominion: true,
    ramps: {
      "Heller's Creek Access": [34.3192, -81.3764],
      "Broad River Campground Ramp": [34.2780, -81.3850]
    }
  },
  "Lake Robinson, SC": {
    center: [34.45, -80.15, 13],
    bounds: [[34.40, -80.22],[34.50, -80.10]],
    duke: 'lake robinson',
    ramps: { "Lake Robinson Landing": [34.458, -80.160] }
  },
  "Congaree River (to SC-601)": {
    center: [33.875, -80.810, 13],
    bounds: [[33.83, -80.92],[33.92, -80.70]],
    ramps: {}
  },
  "Wateree River": {
    center: [34.010, -80.590, 13],
    bounds: [[33.82, -80.70],[34.20, -80.48]],
    ramps: {}
  },
  "Fishing Creek Reservoir, SC": {
    center: [34.65, -80.88, 12],
    bounds: [[34.55, -80.95],[34.75, -80.78]],
    ramps: { "Fishing Creek Access": [34.645, -80.875] }
  },
  "Lake Bowen, SC": {
    center: [35.11, -82.05, 13],
    bounds: [[35.06, -82.10],[35.16, -82.00]],
    ramps: { "Bowen Landing": [35.109, -82.048] }
  },
  "Lake Blalock, SC": {
    center: [35.20, -82.00, 13],
    bounds: [[35.15, -82.05],[35.25, -81.95]],
    ramps: { "Blalock Park": [35.199, -82.002] }
  },

  // North Carolina
  "Lake Norman, NC": {
    center: [35.50, -80.95, 11],
    bounds: [[35.35, -81.10],[35.60, -80.80]],
    duke: 'lake norman',
    // Duke API is authoritative for Lake Norman pool level; USGS 02142500 is river/stream data.
    normalPool: 760.0, minPool: 745.0,
    ramps: {
      "Blythe Landing": [35.451, -80.952],
      "Beatty's Ford": [35.526, -80.946],
      "Pinnacle Access": [35.584, -80.885]
    }
  },
  "High Rock Lake, NC": {
    center: [35.60, -80.25, 11],
    bounds: [[35.45, -80.35],[35.70, -80.15]],
    ramps: { "Flat Swamp": [35.598, -80.281], "High Rock Marina": [35.612, -80.245] }
  },
  "Badin Lake, NC": {
    center: [35.40, -80.10, 12],
    bounds: [[35.32, -80.15],[35.48, -80.05]],
    ramps: { "Badin Lake Campground": [35.404, -80.092], "Arrowhead Point": [35.428, -80.107] }
  },
  "Lake Tillery, NC": {
    center: [35.20, -80.05, 12],
    bounds: [[35.10, -80.12],[35.30, -79.98]],
    ramps: { "Tillery – Lilly's Bridge": [35.207, -80.058] }
  },
  "Blewett Falls Lake, NC": {
    center: [34.95, -79.85, 12],
    bounds: [[34.88, -79.95],[35.02, -79.75]],
    ramps: { "Blewett Falls Access": [34.952, -79.872] }
  },
  "Jordan Lake, NC": {
    center: [35.75, -79.05, 11],
    bounds: [[35.60, -79.15],[35.85, -78.95]],
    ramps: { "Ebenezer Church": [35.702, -79.033], "Farrington Point": [35.800, -79.018] }
  },
  "Falls Lake, NC": {
    center: [36.02, -78.70, 11],
    bounds: [[35.90, -78.85],[36.15, -78.55]],
    ramps: { "Upper Barton Creek": [36.032, -78.694], "Hwy 50 Access": [35.962, -78.617] }
  },
  "Kerr Lake / Buggs Island, NC/VA": {
    center: [36.50, -78.55, 10],
    bounds: [[36.35, -78.80],[36.65, -78.30]],
    ramps: { "Nutbush Bridge": [36.442, -78.634], "Satterwhite Point": [36.536, -78.423] }
  },
  "Lake Gaston, NC/VA": {
    center: [36.50, -77.95, 11],
    bounds: [[36.45, -78.15],[36.58, -77.80]],
    ramps: { "Holly Grove Marina": [36.513, -77.966] }
  },
  "Lake Hickory, NC": {
    center: [35.75, -81.35, 12],
    bounds: [[35.68, -81.45],[35.82, -81.25]],
    ramps: { "Hickory City Park": [35.764, -81.351] }
  },
  "Lake Rhodhiss, NC": {
    center: [35.78, -81.43, 13],
    bounds: [[35.73, -81.50],[35.83, -81.35]],
    ramps: { "Rhodhiss Access": [35.775, -81.430] }
  },
  "Mountain Island Lake, NC": {
    center: [35.35, -80.98, 12],
    bounds: [[35.30, -81.05],[35.40, -80.92]],
    ramps: { "Mountain Island Access": [35.345, -80.980] }
  },
  "Lake James, NC": {
    center: [35.75, -81.88, 12],
    bounds: [[35.68, -81.98],[35.82, -81.78]],
    ramps: { "Canal Bridge": [35.742, -81.869], "Paddy's Creek State Park": [35.760, -81.880] }
  },
  "Lake Lure, NC": {
    center: [35.43, -82.20, 13],
    bounds: [[35.38, -82.26],[35.48, -82.15]],
    ramps: { "Lake Lure Marina": [35.428, -82.194] }
  },

  // Georgia
  "Lake Oconee, GA": {
    center: [33.30, -83.15, 11],
    bounds: [[33.15, -83.30],[33.45, -83.05]],
    ramps: { "Sugar Creek Marina": [33.312, -83.164], "Parks Ferry": [33.345, -83.210] }
  },
  "Lake Sinclair, GA": {
    center: [33.15, -83.20, 11],
    bounds: [[33.05, -83.30],[33.25, -83.10]],
    ramps: { "Dennis Station": [33.141, -83.203], "Twin Bridges": [33.180, -83.250] }
  },
  "Lake Lanier, GA": {
    center: [34.23, -83.95, 11],
    bounds: [[34.10, -84.10],[34.35, -83.80]],
    ramps: { "Van Pugh South": [34.211, -83.959], "Little Hall Park": [34.288, -83.895] }
  },
  "West Point Lake, GA/AL": {
    center: [32.92, -85.18, 11],
    bounds: [[32.75, -85.25],[33.05, -85.05]],
    ramps: { "Ringer Access": [32.915, -85.176], "Highland Marina": [32.875, -85.158] }
  },
  "Lake Jackson, GA": {
    center: [33.32, -83.84, 12],
    bounds: [[33.25, -83.90],[33.38, -83.78]],
    ramps: { "Jackson Lake Marina": [33.326, -83.835] }
  },
  "Lake Harding, GA/AL": {
    center: [32.68, -85.10, 12],
    bounds: [[32.60, -85.18],[32.76, -85.03]],
    ramps: { "Idle Hour Park": [32.682, -85.102] }
  },
  "Lake Blackshear, GA": {
    center: [31.85, -83.93, 11],
    bounds: [[31.70, -84.05],[31.95, -83.80]],
    ramps: { "Georgia Veterans State Park": [31.842, -83.918] }
  },

  // ── SC & GA Coastal / Tidal Fishing Areas ────────────────────────────────
  "ACE Basin / Edisto, SC": {
    center: [32.55, -80.47, 11],
    bounds: [[32.35, -80.70],[32.75, -80.25]],
    coastal: true, tideStation: '8665530',
    ramps: {
      "Edisto Beach State Park Ramp": [32.489, -80.309],
      "Steamboat Landing (Edisto River)": [32.638, -80.617],
      "Jehossee Island Landing": [32.576, -80.496],
    }
  },
  "Charleston Harbor, SC": {
    center: [32.77, -79.93, 11],
    bounds: [[32.60, -80.10],[32.95, -79.75]],
    coastal: true, tideStation: '8665530',
    ramps: {
      "Brittlebank Park Ramp": [32.774, -79.959],
      "Remley's Point": [32.817, -79.918],
      "Shem Creek": [32.795, -79.883],
    }
  },
  "Winyah Bay / Georgetown, SC": {
    center: [33.35, -79.28, 11],
    bounds: [[33.15, -79.50],[33.55, -79.10]],
    coastal: true, tideStation: '8661070',
    ramps: {
      "Sampit River Ramp (Georgetown)": [33.357, -79.282],
      "Andrews Boat Landing": [33.452, -79.561],
      "North Island Ramp": [33.217, -79.183],
    }
  },
  "Murrells Inlet / Pawleys Island, SC": {
    center: [33.55, -79.05, 12],
    bounds: [[33.45, -79.20],[33.65, -78.92]],
    coastal: true, tideStation: '8661070',
    ramps: {
      "Morse Park Landing": [33.553, -79.047],
      "Garden City Boat Ramp": [33.601, -79.007],
    }
  },
  "Beaufort / Port Royal Sound, SC": {
    center: [32.43, -80.67, 11],
    bounds: [[32.25, -80.90],[32.65, -80.45]],
    coastal: true, tideStation: '8670870',
    ramps: {
      "Henry C. Chambers Waterfront": [32.431, -80.671],
      "Lady's Island Marina": [32.426, -80.654],
      "Port Royal Landing": [32.380, -80.693],
    }
  },
  "St. Helena Sound, SC": {
    center: [32.37, -80.43, 11],
    bounds: [[32.20, -80.65],[32.55, -80.20]],
    coastal: true, tideStation: '8670870',
    ramps: {
      "Edding's Point Ramp": [32.393, -80.434],
      "Coosaw River Landing": [32.441, -80.548],
    }
  },
  "Hilton Head / Calibogue Sound, SC": {
    center: [32.18, -80.75, 12],
    bounds: [[32.05, -80.90],[32.32, -80.60]],
    coastal: true, tideStation: '8670870',
    ramps: {
      "Broad Creek Marina": [32.197, -80.747],
      "Shelter Cove": [32.209, -80.722],
    }
  },
  "Santee River Delta / North Inlet, SC": {
    center: [33.18, -79.35, 11],
    bounds: [[33.05, -79.55],[33.35, -79.15]],
    coastal: true, tideStation: '8661070',
    ramps: {
      "Santee Coastal Reserve Ramp": [33.172, -79.358],
    }
  },
  "Savannah River / Savannah, GA": {
    center: [32.08, -81.09, 11],
    bounds: [[31.90, -81.25],[32.25, -80.90]],
    coastal: true, tideStation: '8670659',
    ramps: {
      "Houlihan Bridge Ramp": [32.134, -81.107],
      "Port Wentworth Ramp": [32.155, -81.167],
    }
  }
};
