/**
 * coastal-zones.js — SC / GA / NC coastal + tidal zone catalog.
 *
 * GENERATED FILE — DO NOT EDIT BY HAND.
 * Source of truth: Scripts/coastal_catalog.py
 * Regenerate:      python3 Scripts/gen_coastal_zones_js.py
 * Guarded by:      test/coastal-zones-parity.test.js
 *
 * Why generated: the Python catalog already drives the R2 data pipeline
 * (trollmap_pipeline_coastal.py, fetch_osm_coastal.py). Hand-copying it into
 * JS is how lake-keys.js and limnology.js drifted apart — see AGENT_GUIDE.md
 * section 1. One source, one generator, one parity test.
 *
 * Each zone carries:
 *   slug         R2 key prefix, e.g. `${CF_WORKER_URL}/chartpacks/{slug}/...`
 *   tideStation  NOAA CO-OPS station ID for noaa-tides.js
 *   center       [lat, lon]
 *   bbox         [[south, west], [north, east]] — Leaflet order
 *   ramps        name -> [lat, lon]
 *   usgsGauges   USGS NWIS site IDs for the freshwater-intrusion proxy
 *                (empty array = no gauge coverage, skip the check)
 */

export const COASTAL_ZONES = {
  "coast_winyah_bay_sc": {
    "slug": "coast_winyah_bay_sc",
    "name": "Winyah Bay / Georgetown, SC",
    "state": "SC",
    "coastal": true,
    "tideStation": "8661070",
    "center": [33.35, -79.28],
    "bbox": [[33.15, -79.5], [33.55, -79.1]],
    "priority": 8,
    "ramps": {
      "Sampit River Ramp (Georgetown)": [33.357, -79.282],
      "Andrews Boat Landing": [33.452, -79.561],
      "North Island Ramp": [33.217, -79.183],
    },
    "usgsGauges": ["02171700"],
    "usgsRivers": ["Santee River"],
  },
  "coast_murrells_inlet_sc": {
    "slug": "coast_murrells_inlet_sc",
    "name": "Murrells Inlet / Pawleys Island, SC",
    "state": "SC",
    "coastal": true,
    "tideStation": "8661070",
    "center": [33.55, -79.05],
    "bbox": [[33.45, -79.2], [33.65, -78.92]],
    "priority": 8,
    "ramps": {
      "Morse Park Landing": [33.553, -79.047],
      "Garden City Boat Ramp": [33.601, -79.007],
      "Oyster Landing (Kayak/Sm Boat)": [33.54751, -79.04484],
    },
    "usgsGauges": [],
    "usgsRivers": [],
  },
  "coast_santee_delta_sc": {
    "slug": "coast_santee_delta_sc",
    "name": "Santee River Delta / North Inlet, SC",
    "state": "SC",
    "coastal": true,
    "tideStation": "8661070",
    "center": [33.18, -79.35],
    "bbox": [[33.05, -79.55], [33.35, -79.15]],
    "priority": 8,
    "ramps": {
      "Santee Coastal Reserve Ramp": [33.172, -79.358],
    },
    "usgsGauges": ["02171700"],
    "usgsRivers": ["Santee River"],
  },
  "coast_charleston_sc": {
    "slug": "coast_charleston_sc",
    "name": "Charleston Harbor, SC",
    "state": "SC",
    "coastal": true,
    "tideStation": "8665530",
    "center": [32.77, -79.93],
    "bbox": [[32.6, -80.1], [32.95, -79.75]],
    "priority": 8,
    "ramps": {
      "Brittlebank Park Ramp": [32.774, -79.959],
      "Remley's Point": [32.817, -79.918],
      "Shem Creek": [32.795, -79.883],
    },
    "usgsGauges": ["02172002", "02172300"],
    "usgsRivers": ["Cooper River", "Ashley River"],
  },
  "coast_ace_basin_sc": {
    "slug": "coast_ace_basin_sc",
    "name": "ACE Basin / Edisto, SC",
    "state": "SC",
    "coastal": true,
    "tideStation": "8665530",
    "center": [32.55, -80.47],
    "bbox": [[32.35, -80.7], [32.75, -80.25]],
    "priority": 8,
    "ramps": {
      "Edisto Beach State Park Ramp": [32.489, -80.309],
      "Steamboat Landing (Edisto River)": [32.638, -80.617],
      "Jehossee Island Landing": [32.576, -80.496],
    },
    "usgsGauges": [],
    "usgsRivers": [],
  },
  "coast_st_helena_sc": {
    "slug": "coast_st_helena_sc",
    "name": "St. Helena Sound, SC",
    "state": "SC",
    "coastal": true,
    "tideStation": "8670870",
    "center": [32.37, -80.43],
    "bbox": [[32.2, -80.65], [32.55, -80.2]],
    "priority": 8,
    "ramps": {
      "Edding's Point Ramp": [32.393, -80.434],
      "Coosaw River Landing": [32.441, -80.548],
    },
    "usgsGauges": [],
    "usgsRivers": [],
  },
  "coast_beaufort_sc": {
    "slug": "coast_beaufort_sc",
    "name": "Beaufort / Port Royal Sound, SC",
    "state": "SC",
    "coastal": true,
    "tideStation": "8670870",
    "center": [32.43, -80.67],
    "bbox": [[32.25, -80.9], [32.65, -80.45]],
    "priority": 8,
    "ramps": {
      "Henry C. Chambers Waterfront": [32.431, -80.671],
      "Lady's Island Marina": [32.426, -80.654],
      "Port Royal Landing": [32.38, -80.693],
    },
    "usgsGauges": [],
    "usgsRivers": [],
  },
  "coast_hilton_head_sc": {
    "slug": "coast_hilton_head_sc",
    "name": "Hilton Head / Calibogue Sound, SC",
    "state": "SC",
    "coastal": true,
    "tideStation": "8670870",
    "center": [32.18, -80.75],
    "bbox": [[32.05, -80.9], [32.32, -80.6]],
    "priority": 8,
    "ramps": {
      "Broad Creek Marina": [32.197, -80.747],
      "Shelter Cove": [32.209, -80.722],
    },
    "usgsGauges": [],
    "usgsRivers": [],
  },
  "coast_savannah_ga": {
    "slug": "coast_savannah_ga",
    "name": "Savannah River / Savannah, GA",
    "state": "GA",
    "coastal": true,
    "tideStation": "8670659",
    "center": [32.08, -81.09],
    "bbox": [[31.9, -81.25], [32.25, -80.9]],
    "priority": 8,
    "ramps": {
      "Houlihan Bridge Ramp": [32.134, -81.107],
      "Port Wentworth Ramp": [32.155, -81.167],
    },
    "usgsGauges": ["02198500"],
    "usgsRivers": ["Savannah River"],
  },
  "coast_ossabaw_st_catherines_ga": {
    "slug": "coast_ossabaw_st_catherines_ga",
    "name": "Ossabaw / St. Catherines Sound, GA",
    "state": "GA",
    "coastal": true,
    "tideStation": "8677344",
    "center": [31.75, -81.12],
    "bbox": [[31.55, -81.35], [31.95, -80.9]],
    "priority": 8,
    "ramps": {
      "Kilkenny Creek Landing": [31.818, -81.237],
      "Pine Harbor Marina": [31.882, -81.195],
    },
    "usgsGauges": ["02198500"],
    "usgsRivers": ["Savannah River"],
  },
  "coast_sapelo_altamaha_ga": {
    "slug": "coast_sapelo_altamaha_ga",
    "name": "Sapelo Sound / Altamaha River, GA",
    "state": "GA",
    "coastal": true,
    "tideStation": "8679511",
    "center": [31.42, -81.32],
    "bbox": [[31.25, -81.55], [31.6, -81.1]],
    "priority": 8,
    "ramps": {
      "Shellman Bluff Ramp": [31.542, -81.328],
      "Crescent Landing": [31.432, -81.355],
    },
    "usgsGauges": [],
    "usgsRivers": [],
  },
  "coast_brunswick_st_simons_ga": {
    "slug": "coast_brunswick_st_simons_ga",
    "name": "Brunswick / St. Simons Sound, GA",
    "state": "GA",
    "coastal": true,
    "tideStation": "8679511",
    "center": [31.12, -81.42],
    "bbox": [[30.95, -81.65], [31.3, -81.2]],
    "priority": 8,
    "ramps": {
      "Blythe Island Regional Park": [31.148, -81.537],
      "Golden Isles Marina": [31.152, -81.393],
      "Schnell Landing": [31.09, -81.45],
    },
    "usgsGauges": [],
    "usgsRivers": [],
  },
  "coast_cumberland_st_marys_ga": {
    "slug": "coast_cumberland_st_marys_ga",
    "name": "Cumberland Island / St. Marys, GA",
    "state": "GA",
    "coastal": true,
    "tideStation": "8720357",
    "center": [30.8, -81.48],
    "bbox": [[30.6, -81.65], [30.98, -81.3]],
    "priority": 8,
    "ramps": {
      "St. Marys Boat Ramp": [30.735, -81.55],
      "Lang Marina St. Marys": [30.728, -81.546],
    },
    "usgsGauges": [],
    "usgsRivers": [],
  },
  "coast_brunswick_nc": {
    "slug": "coast_brunswick_nc",
    "name": "Brunswick County / Shallotte Inlet, NC",
    "state": "NC",
    "coastal": true,
    "tideStation": "8658120",
    "center": [33.95, -78.5],
    "bbox": [[33.85, -78.7], [34.05, -78.3]],
    "priority": 8,
    "ramps": {
      "Holden Beach Ramp": [33.913, -78.33],
      "Shallotte Inlet Access": [33.892, -78.385],
      "Sunset Beach Ramp": [33.878, -78.512],
    },
    "usgsGauges": ["02105769"],
    "usgsRivers": ["Cape Fear River"],
  },
  "coast_cape_fear_nc": {
    "slug": "coast_cape_fear_nc",
    "name": "Cape Fear River / Wilmington, NC",
    "state": "NC",
    "coastal": true,
    "tideStation": "8658120",
    "center": [34.18, -77.95],
    "bbox": [[34.05, -78.1], [34.3, -77.75]],
    "priority": 8,
    "ramps": {
      "Wilmington Riverfront Ramp": [34.235, -77.948],
      "Carolina Beach State Park": [34.052, -77.893],
      "Masonboro Inlet Access": [34.171, -77.842],
      "Wrightsville Beach Ramp": [34.208, -77.797],
    },
    "usgsGauges": ["02105769"],
    "usgsRivers": ["Cape Fear River"],
  },
  "coast_topsail_new_river_nc": {
    "slug": "coast_topsail_new_river_nc",
    "name": "Topsail Island / New River Inlet, NC",
    "state": "NC",
    "coastal": true,
    "tideStation": "8658163",
    "center": [34.45, -77.52],
    "bbox": [[34.3, -77.75], [34.6, -77.3]],
    "priority": 8,
    "ramps": {
      "Sneads Ferry Ramp": [34.557, -77.398],
      "Topsail Beach Access": [34.388, -77.647],
      "New River Inlet Ramp": [34.527, -77.338],
    },
    "usgsGauges": [],
    "usgsRivers": [],
  },
  "coast_bogue_sound_nc": {
    "slug": "coast_bogue_sound_nc",
    "name": "Bogue Sound / Morehead City, NC",
    "state": "NC",
    "coastal": true,
    "tideStation": "8656483",
    "center": [34.7, -76.85],
    "bbox": [[34.6, -77.1], [34.8, -76.6]],
    "priority": 8,
    "ramps": {
      "Morehead City Ramp": [34.724, -76.731],
      "Beaufort Town Ramp": [34.718, -76.664],
      "Atlantic Beach Ramp": [34.699, -76.741],
    },
    "usgsGauges": [],
    "usgsRivers": [],
  },
  "coast_core_sound_nc": {
    "slug": "coast_core_sound_nc",
    "name": "Core Sound / Cape Lookout, NC",
    "state": "NC",
    "coastal": true,
    "tideStation": "8656483",
    "center": [34.68, -76.35],
    "bbox": [[34.55, -76.6], [34.8, -76.1]],
    "priority": 8,
    "ramps": {
      "Harkers Island Ramp": [34.692, -76.558],
      "Davis Shore Ramp": [34.782, -76.457],
    },
    "usgsGauges": [],
    "usgsRivers": [],
  },
  "coast_pamlico_sound_nc": {
    "slug": "coast_pamlico_sound_nc",
    "name": "Pamlico Sound / Neuse River, NC",
    "state": "NC",
    "coastal": true,
    "tideStation": "8654467",
    "center": [35.1, -76.45],
    "bbox": [[34.8, -77.1], [35.4, -75.8]],
    "priority": 8,
    "ramps": {
      "New Bern Ramp": [35.108, -77.044],
      "Oriental Ramp": [35.024, -76.694],
      "Bay River Ramp": [35.138, -76.778],
    },
    "usgsGauges": ["02091814"],
    "usgsRivers": ["Neuse River"],
  },
  "coast_outer_banks_nc": {
    "slug": "coast_outer_banks_nc",
    "name": "Outer Banks / Oregon Inlet, NC",
    "state": "NC",
    "coastal": true,
    "tideStation": "8654467",
    "center": [35.7, -75.65],
    "bbox": [[35.4, -75.9], [36.0, -75.4]],
    "priority": 8,
    "ramps": {
      "Oregon Inlet Ramp": [35.779, -75.531],
      "Manteo Waterfront Ramp": [35.908, -75.667],
      "Nags Head Fishing Pier": [35.953, -75.621],
    },
    "usgsGauges": [],
    "usgsRivers": [],
  },
  "coast_albemarle_sound_nc": {
    "slug": "coast_albemarle_sound_nc",
    "name": "Albemarle Sound / Elizabeth City, NC",
    "state": "NC",
    "coastal": true,
    "tideStation": "8651370",
    "center": [36.2, -76.3],
    "bbox": [[35.9, -76.8], [36.55, -75.8]],
    "priority": 8,
    "ramps": {
      "Elizabeth City Ramp": [36.295, -76.222],
      "Edenton Ramp": [36.058, -76.607],
      "Columbia Ramp": [35.916, -76.251],
    },
    "usgsGauges": [],
    "usgsRivers": [],
  },
};

/** All coastal slugs. */
export const COASTAL_SLUGS = Object.keys(COASTAL_ZONES);

/**
 * True when an R2 key / zone slug refers to tidal saltwater.
 * All coastal slugs are prefixed `coast_` by the pipeline, so this is a
 * cheap check that does not require the catalog to be loaded.
 */
export function isCoastalKey(key) {
  return typeof key === 'string' && key.startsWith('coast_');
}

/** Look up a zone by its slug. Returns null when unknown. */
export function getCoastalZone(slug) {
  return COASTAL_ZONES[slug] || null;
}

/** Zones for one state, in catalog order. */
export function coastalZonesByState(stateCode) {
  const want = String(stateCode || '').toUpperCase();
  return COASTAL_SLUGS
    .filter((slug) => COASTAL_ZONES[slug].state === want)
    .map((slug) => COASTAL_ZONES[slug]);
}

/** Display names grouped for the lake selector: { SC: [...], GA: [...], NC: [...] } */
export function coastalNamesByState() {
  const out = { SC: [], GA: [], NC: [] };
  for (const slug of COASTAL_SLUGS) {
    const zone = COASTAL_ZONES[slug];
    if (out[zone.state]) out[zone.state].push(zone.name);
  }
  return out;
}
