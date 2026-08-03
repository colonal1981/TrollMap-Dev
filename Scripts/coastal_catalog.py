#!/usr/bin/env python3
"""
coastal_catalog.py — TrollMap coastal/tidal zone definitions for SC, GA, and NC.

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
        'bbox': (33.15, 33.55, -79.50, -79.10),
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
        'bbox': (33.45, 33.65, -79.20, -78.92),
        'center': (33.55, -79.05),
        'priority': 8,
        'coastal': True,
        'tide_station': '8661070',
        'state': 'SC',
        'ramps': {
            'Morse Park Landing':    [33.553, -79.047],
            'Garden City Boat Ramp': [33.601, -79.007],
            # Added 2026-08-03. It went into js/data/coastal-zones.js by hand first, which
            # is a GENERATED file -- the next gen_coastal_zones_js.py run would have deleted
            # it without a word. Ramps belong here; the .js is an output.
            'Oyster Landing (Kayak/Sm Boat)': [33.54751, -79.04484],
        }
    },
    'coast_santee_delta_sc': {
        'name': 'Santee River Delta / North Inlet, SC',
        'bbox': (33.05, 33.35, -79.55, -79.15),
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
        'bbox': (32.60, 32.95, -80.10, -79.75),
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
        'bbox': (32.35, 32.75, -80.70, -80.25),
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
        'bbox': (32.25, 32.65, -80.90, -80.45),
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
    'coast_cumberland_st_marys_ga': {
        'name': 'Cumberland Island / St. Marys, GA',
        'bbox': (30.60, 30.98, -81.65, -81.30),
        'center': (30.80, -81.48),
        'priority': 8,
        'coastal': True,
        'tide_station': '8720357',  # Fernandina Beach (closest)
        'state': 'GA',
        'ramps': {
            'St. Marys Boat Ramp':    [30.735, -81.550],
            'Lang Marina St. Marys':  [30.728, -81.546],
        }
    },

    # ── North Carolina Coastal Zones ─────────────────────────────────────────
    'coast_brunswick_nc': {
        'name': 'Brunswick County / Shallotte Inlet, NC',
        'bbox': (33.85, 34.05, -78.70, -78.30),
        'center': (33.95, -78.50),
        'priority': 8,
        'coastal': True,
        'tide_station': '8658120',  # Wilmington
        'state': 'NC',
        'ramps': {
            'Holden Beach Ramp':      [33.913, -78.330],
            'Shallotte Inlet Access': [33.892, -78.385],
            'Sunset Beach Ramp':      [33.878, -78.512],
        }
    },
    'coast_cape_fear_nc': {
        'name': 'Cape Fear River / Wilmington, NC',
        'bbox': (34.05, 34.30, -78.10, -77.75),
        'center': (34.18, -77.95),
        'priority': 8,
        'coastal': True,
        'tide_station': '8658120',  # Wilmington
        'state': 'NC',
        'ramps': {
            'Wilmington Riverfront Ramp': [34.235, -77.948],
            'Carolina Beach State Park':  [34.052, -77.893],
            'Masonboro Inlet Access':     [34.171, -77.842],
            'Wrightsville Beach Ramp':    [34.208, -77.797],
        }
    },
    'coast_topsail_new_river_nc': {
        'name': 'Topsail Island / New River Inlet, NC',
        'bbox': (34.30, 34.60, -77.75, -77.30),
        'center': (34.45, -77.52),
        'priority': 8,
        'coastal': True,
        'tide_station': '8658163',  # Wrightsville Beach
        'state': 'NC',
        'ramps': {
            'Sneads Ferry Ramp':       [34.557, -77.398],
            'Topsail Beach Access':    [34.388, -77.647],
            'New River Inlet Ramp':    [34.527, -77.338],
        }
    },
    'coast_bogue_sound_nc': {
        'name': 'Bogue Sound / Morehead City, NC',
        'bbox': (34.60, 34.80, -77.10, -76.60),
        'center': (34.70, -76.85),
        'priority': 8,
        'coastal': True,
        'tide_station': '8656483',  # Beaufort NC
        'state': 'NC',
        'ramps': {
            'Morehead City Ramp':      [34.724, -76.731],
            'Beaufort Town Ramp':      [34.718, -76.664],
            'Atlantic Beach Ramp':     [34.699, -76.741],
        }
    },
    'coast_core_sound_nc': {
        'name': 'Core Sound / Cape Lookout, NC',
        'bbox': (34.55, 34.80, -76.60, -76.10),
        'center': (34.68, -76.35),
        'priority': 8,
        'coastal': True,
        'tide_station': '8656483',  # Beaufort NC
        'state': 'NC',
        'ramps': {
            'Harkers Island Ramp':  [34.692, -76.558],
            'Davis Shore Ramp':     [34.782, -76.457],
        }
    },
    'coast_pamlico_sound_nc': {
        'name': 'Pamlico Sound / Neuse River, NC',
        'bbox': (34.80, 35.40, -77.10, -75.80),
        'center': (35.10, -76.45),
        'priority': 8,
        'coastal': True,
        'tide_station': '8654467',  # USCG Station Hatteras
        'state': 'NC',
        'ramps': {
            'New Bern Ramp':         [35.108, -77.044],
            'Oriental Ramp':         [35.024, -76.694],
            'Bay River Ramp':        [35.138, -76.778],
        }
    },
    'coast_outer_banks_nc': {
        'name': 'Outer Banks / Oregon Inlet, NC',
        'bbox': (35.40, 36.00, -75.90, -75.40),
        'center': (35.70, -75.65),
        'priority': 8,
        'coastal': True,
        'tide_station': '8654467',  # USCG Station Hatteras
        'state': 'NC',
        'ramps': {
            'Oregon Inlet Ramp':        [35.779, -75.531],
            'Manteo Waterfront Ramp':   [35.908, -75.667],
            'Nags Head Fishing Pier':   [35.953, -75.621],
        }
    },
    'coast_albemarle_sound_nc': {
        'name': 'Albemarle Sound / Elizabeth City, NC',
        'bbox': (35.90, 36.55, -76.80, -75.80),
        'center': (36.20, -76.30),
        'priority': 8,
        'coastal': True,
        'tide_station': '8651370',  # Duck NC
        'state': 'NC',
        'ramps': {
            'Elizabeth City Ramp':   [36.295, -76.222],
            'Edenton Ramp':          [36.058, -76.607],
            'Columbia Ramp':         [35.916, -76.251],
        }
    },
}

if __name__ == '__main__':
    print(f'Loaded {len(COASTAL_CATALOG)} coastal zone definitions.')
    for slug, z in COASTAL_CATALOG.items():
        print(f'  {slug}: {z["name"]} (tide: {z["tide_station"]})')
