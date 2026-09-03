#!/usr/bin/env python3
"""
coastal_catalog.py — TrollMap coastal/tidal zone definitions for SC and GA.

THIRTEEN ZONES, AND NORTH CAROLINA IS NOT ONE OF THEM.

a4bfd02 cut the three NC coastal zones -- coast_brunswick_nc, coast_cape_fear_nc,
coast_topsail_new_river_nc -- from the app: out of js/data/coastal-zones.js, out of
lake-keys.js, out of CHAIN_DESCRIPTIONS, out of the hand-typed NCDMF table. It did not cut
them from THIS file, and this file generates coastal-zones.js. So the generated file was
hand-edited to 13 while its source stayed at 16, the staleness guard in
test/coastal-zones-parity.test.js went red, and it stayed red because the number the test
asserted (16) was the stale side. Finished here on 2026-09-03.

The boundary does not settle this and should not be cited as if it did. Run against
registry/region_mask.json the three NC zones come back INSIDE the polygon Ryan drew --
coast_brunswick_nc 119/119 vertices, coast_cape_fear_nc 618/658, coast_topsail_new_river_nc
20/150 -- so a rule that reads only the mask would put them back. Ryan's call, 2026-09-03:
"But keep NC coastal cut... i do not want it back in". That is the reason, and it is the
whole reason.

Also gone: a second, byte-identical 'coast_savannah_ga' block that sat above the Georgia
header. Python kept the last one, so the first had never been read by anything.

Each entry contains:
  - 'name': Clean display name
  - 'bbox': (south, north, west, east) bounding box
  - 'center': (lat, lon) reference point
  - 'priority': Integer (higher wins overlapping boxes)
  - 'coastal': True — flags zone as tidal/saltwater for pipeline and JS
  - 'tide_station': NOAA CO-OPS station ID for tide data
  - 'state': Primary state abbreviation
  - 'ramps': dict of name → [lat, lon]
"""

COASTAL_CATALOG = {
    'coast_winyah_bay_sc': {
        'name': 'Winyah Bay / Georgetown, SC',
        'bbox': (33.325, 33.571, -79.586, -79.093),
        'center': (33.35, -79.28),
        'priority': 8,
        'coastal': True,
        'tide_station': '8661070',
        'state': 'SC',
        'ramps': {
            'Sampit River Ramp (Georgetown)': [33.357, -79.282],
            'Andrews Boat Landing':           [33.452, -79.561],
            'North Island Ramp':              [33.217, -79.183],
        }
    },
    'coast_murrells_inlet_sc': {
        'name': 'Murrells Inlet / Pawleys Island, SC',
        'bbox': (33.499, 33.854, -79.178, -78.6),
        'center': (33.55, -79.05),
        'priority': 8,
        'coastal': True,
        'tide_station': '8661070',
        'state': 'SC',
        'ramps': {
            'Oyster Landing (Kayak/Sm Boat)': [33.54751, -79.04484],
            'Morse Park Landing':    [33.553, -79.047],
            'Garden City Boat Ramp': [33.601, -79.007],
        }
    },
    # Added 2026-08-04. Cape Romain was in COASTAL_PRIMARY, in lake_index.json and in
    # coastal-zones.js -- but never in this file, which is what drives extraction and
    # what upload_to_r2_coastal.py reads for its slug list. So the app offered the zone,
    # the tier list promised it all layers, and nothing built or shipped it. Values are
    # taken verbatim from coastal-zones.js, which had the full record all along.
    'coast_cape_romain_sc': {
        'name': 'Cape Romain / Bulls Bay, SC',
        'bbox': (32.85, 33.156, -79.836, -79.536),
        'center': (32.94, -79.66),
        'priority': 8,
        'coastal': True,
        'tide_station': '8665530',
        'state': 'SC',
        'ramps': {
            'Garris Landing (Bulls Bay)': [32.93974, -79.65744],
            'Buck Hall Landing (Awendaw)': [33.03846, -79.56095],
            'Five Fathom Creek Ramp': [33.01592, -79.58791],
        }
    },
    'coast_santee_delta_sc': {
        'name': 'Santee River Delta / North Inlet, SC',
        'bbox': (32.99, 33.327, -79.622, -79.158),
        'center': (33.18, -79.35),
        'priority': 8,
        'coastal': True,
        'tide_station': '8661070',
        'state': 'SC',
        'ramps': {
            'Santee Coastal Reserve Ramp': [33.172, -79.358],
        }
    },
    'coast_charleston_sc': {
        'name': 'Charleston Harbor, SC',
        'bbox': (32.623, 33.115, -80.19, -79.734),
        'center': (32.77, -79.93),
        'priority': 8,
        'coastal': True,
        'tide_station': '8665530',
        'state': 'SC',
        'ramps': {
            'Brittlebank Park Ramp': [32.774, -79.959],
            "Remley's Point":        [32.817, -79.918],
            'Shem Creek':            [32.795, -79.883],
        }
    },
    'coast_ace_basin_sc': {
        'name': 'ACE Basin / Edisto, SC',
        'bbox': (32.296, 32.76, -80.709, -80.129),
        'center': (32.55, -80.47),
        'priority': 8,
        'coastal': True,
        'tide_station': '8665530',
        'state': 'SC',
        'ramps': {
            'Edisto Beach State Park Ramp':    [32.489, -80.309],
            'Steamboat Landing (Edisto River)': [32.638, -80.617],
            'Jehossee Island Landing':          [32.576, -80.496],
        }
    },
    'coast_st_helena_sc': {
        'name': 'St. Helena Sound, SC',
        'bbox': (32.20, 32.55, -80.65, -80.20),
        'center': (32.37, -80.43),
        'priority': 8,
        'coastal': True,
        'tide_station': '8670870',
        'state': 'SC',
        'ramps': {
            "Edding's Point Ramp":  [32.393, -80.434],
            'Coosaw River Landing': [32.441, -80.548],
        }
    },
    'coast_beaufort_sc': {
        'name': 'Beaufort / Port Royal Sound, SC',
        'bbox': (32.25, 32.65, -80.92, -80.45),
        'center': (32.43, -80.67),
        'priority': 8,
        'coastal': True,
        'tide_station': '8670870',
        'state': 'SC',
        'ramps': {
            'Henry C. Chambers Waterfront': [32.431, -80.671],
            "Lady's Island Marina":         [32.426, -80.654],
            'Port Royal Landing':           [32.380, -80.693],
        }
    },
    'coast_hilton_head_sc': {
        'name': 'Hilton Head / Calibogue Sound, SC',
        'bbox': (32.05, 32.32, -80.90, -80.60),
        'center': (32.18, -80.75),
        'priority': 8,
        'coastal': True,
        'tide_station': '8670870',
        'state': 'SC',
        'ramps': {
            'Broad Creek Marina': [32.197, -80.747],
            'Shelter Cove':       [32.209, -80.722],
        }
    },
    # ── Georgia Coastal Zones ─────────────────────────────────────────────────
    'coast_savannah_ga': {
        'name': 'Savannah River / Savannah, GA',
        'bbox': (31.90, 32.25, -81.25, -80.90),
        'center': (32.08, -81.09),
        'priority': 8,
        'coastal': True,
        'tide_station': '8670659',
        'state': 'GA',
        'ramps': {
            'Houlihan Bridge Ramp': [32.134, -81.107],
            'Port Wentworth Ramp':  [32.155, -81.167],
        }
    },
    'coast_ossabaw_st_catherines_ga': {
        'name': 'Ossabaw / St. Catherines Sound, GA',
        'bbox': (31.55, 31.95, -81.35, -80.90),
        'center': (31.75, -81.12),
        'priority': 8,
        'coastal': True,
        'tide_station': '8677344',  # Fort Pulaski / Savannah
        'state': 'GA',
        'ramps': {
            'Kilkenny Creek Landing': [31.818, -81.237],
            'Pine Harbor Marina':     [31.882, -81.195],
        }
    },
    'coast_sapelo_altamaha_ga': {
        'name': 'Sapelo Sound / Altamaha River, GA',
        'bbox': (31.25, 31.60, -81.55, -81.10),
        'center': (31.42, -81.32),
        'priority': 8,
        'coastal': True,
        'tide_station': '8679511',  # Brunswick
        'state': 'GA',
        'ramps': {
            'Shellman Bluff Ramp': [31.542, -81.328],
            'Crescent Landing':    [31.432, -81.355],
        }
    },
    'coast_brunswick_st_simons_ga': {
        'name': 'Brunswick / St. Simons Sound, GA',
        'bbox': (30.95, 31.30, -81.65, -81.20),
        'center': (31.12, -81.42),
        'priority': 8,
        'coastal': True,
        'tide_station': '8679511',  # Brunswick
        'state': 'GA',
        'ramps': {
            'Blythe Island Regional Park': [31.148, -81.537],
            'Golden Isles Marina':         [31.152, -81.393],
            'Schnell Landing':             [31.090, -81.450],
        }
    },
}

if __name__ == '__main__':
    print(f'Loaded {len(COASTAL_CATALOG)} coastal zone definitions.')
    for slug, z in COASTAL_CATALOG.items():
        print(f'  {slug}: {z["name"]} (tide: {z["tide_station"]})')
