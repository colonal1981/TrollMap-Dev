/**
 * coastal-zones.js — SC / GA coastal + tidal zone catalog.
 *
 * NC REMOVED 2026-09-01. Ryan: "i plan to cut all coastal areas from NC anyways." Three zones
 * went — Brunswick County / Shallotte Inlet, Cape Fear River / Wilmington, and Topsail Island /
 * New River Inlet — together with NC's block in coastal-regulations.js, which was a hand-typed
 * copy of NCDMF's rules against a parser that now reads the book.
 *
 * THE TWO HAD TO GO TOGETHER. coastal-regulations.test.js asserts that every coastal zone maps to
 * a state with a regulation table, and removing the table first broke it — correctly. A zone the
 * app offers with no rules behind it is a plan on closed water reported legal, which is the
 * failure that whole file exists to prevent.
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
    "bbox": [[33.325, -79.586], [33.571, -79.093]],
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
    "bbox": [[33.499, -79.178], [33.854, -78.6]],
    "priority": 8,
    "ramps": {
      "Oyster Landing (Kayak/Sm Boat)": [33.54751, -79.04484],
      "Morse Park Landing": [33.553, -79.047],
      "Garden City Boat Ramp": [33.601, -79.007],
    },
    "usgsGauges": [],
    "usgsRivers": [],
  },
  "coast_cape_romain_sc": {
    "slug": "coast_cape_romain_sc",
    "name": "Cape Romain / Bulls Bay, SC",
    "state": "SC",
    "coastal": true,
    "tideStation": "8665530",
    "center": [32.94, -79.66],
    "bbox": [[32.85, -79.836], [33.156, -79.536]],
    "priority": 8,
    "ramps": {
      "Garris Landing (Bulls Bay)": [32.93974, -79.65744],
      "Buck Hall Landing (Awendaw)": [33.03846, -79.56095],
      "Five Fathom Creek Ramp": [33.01592, -79.58791],
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
    "bbox": [[32.99, -79.622], [33.327, -79.158]],
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
    "bbox": [[32.623, -80.19], [33.115, -79.734]],
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
    "bbox": [[32.296, -80.709], [32.76, -80.129]],
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
    "bbox": [[32.25, -80.92], [32.65, -80.45]],
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
  const out = { SC: [], GA: [] };
  for (const slug of COASTAL_SLUGS) {
    const zone = COASTAL_ZONES[slug];
    if (out[zone.state]) out[zone.state].push(zone.name);
  }
  return out;
}
