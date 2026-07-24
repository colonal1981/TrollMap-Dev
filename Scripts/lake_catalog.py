#!/usr/bin/env python3
"""
lake_catalog.py — Complete Comprehensive Source of Truth for all TrollMap lake definitions.

Each lake entry contains:
  - 'name': Clean display name
  - 'bbox': (south, north, west, east) exact core bounding box
  - 'center': (lat, lon) reference point used to break ties when bounding boxes overlap
  - 'priority': Integer (higher wins if a feature is inside multiple overlapping boxes)
"""

LAKE_CATALOG = {
    # ── COMBINED RIVER CHAIN REGIONS (Prevents dam-splitting loss) ────────────
    'lake_thurmond_russell': {
        'name': 'Clarks Hill / Thurmond & Russell Chain',
        'bbox': (33.566024, 34.368506, -82.831441, -82.170986),
        'center': (33.80, -82.40),
        'priority': 12
    },
    'lake_hickory_rhodhiss': {
        'name': 'Lake Hickory & Rhodhiss Chain',
        'bbox': (35.745006, 35.843886, -81.663691, -81.182091),
        'center': (35.77, -81.38),
        'priority': 12
    },
    'lake_greenwood_secession': {
        'name': 'Lake Greenwood & Secession Chain',
        'bbox': (34.158713, 34.372716, -82.195883, -81.885858),
        'center': (34.25, -82.10),
        'priority': 12
    },
    'lake_monticello_parr': {
        'name': 'Lake Monticello & Parr Reservoir',
        'bbox': (34.247755, 34.403648, -81.403559, -81.274724),
        'center': (34.30, -81.32),
        'priority': 12
    },
    'yadkin_river_chain': {
        'name': 'Yadkin River Chain (High Rock to Blewett Falls)',
        'bbox': (34.87, 35.76, -80.46, -79.77),
        'center': (35.40, -80.10),
        'priority': 12
    },
    'lake_norman_mountain_island': {
        'name': 'Lake Norman & Mountain Island Chain',
        'bbox': (35.323899, 35.732041, -81.090705, -80.834451),
        'center': (35.50, -80.95),
        'priority': 12
    },
    'lake_wateree_fishing_creek': {
        'name': 'Lake Wateree & Fishing Creek Chain',
        'bbox': (34.323131, 34.694091, -80.947286, -80.689072),
        'center': (34.40, -80.88),
        'priority': 12
    },
    'lake_juliette_high_falls': {
        'name': 'Lake Juliette & High Falls Chain',
        'bbox': (33.1689, 33.222508, -84.057655, -84.005552),
        'center': (33.10, -83.85),
        'priority': 12
    },

    # ── MAJOR INDIVIDUAL RESERVOIRS (SC & GA) ─────────────────────────────────
    'lake_marion': {
        'name': 'Lake Marion',
        'bbox': (33.369487, 33.753202, -80.640906, -80.128812),
        'center': (33.55, -80.30),
        'priority': 10
    },
    'lake_moultrie': {
        'name': 'Lake Moultrie',
        'bbox': (33.200524, 33.425611, -80.175388, -79.955688),
        'center': (33.28, -80.05),
        'priority': 10
    },
    'lake_murray': {
        'name': 'Lake Murray',
        'bbox': (33.989872, 34.1816, -81.700075, -81.206523),
        'center': (34.08, -81.35),
        'priority': 10
    },
    'saluda_river_arm': {
        'name': 'Saluda River Arm (Above Murray)',
        'bbox': (33.95, 34.22, -82.08, -81.50),
        'center': (34.10, -81.78),
        'priority': 8
    },
    'lake_hartwell': {
        'name': 'Lake Hartwell',
        'bbox': (34.322669, 34.659621, -83.292599, -82.791888),
        'center': (34.55, -83.05),
        'priority': 10
    },
    'lake_wylie': {
        'name': 'Lake Wylie',
        'bbox': (35.002494, 35.260145, -81.122292, -80.972685),
        'center': (35.10, -81.05),
        'priority': 10
    },
    'mountain_island_lake': {
        'name': 'Mountain Island Lake',
        'bbox': (35.323899, 35.392757, -81.006415, -80.900794),
        'center': (35.42, -80.98),
        'priority': 10
    },
    'lake_norman': {
        'name': 'Lake Norman',
        'bbox': (35.417214, 35.732041, -81.090705, -80.834451),
        'center': (35.56, -80.95),
        'priority': 10
    },
    'high_point_lake': {
        'name': 'High Point Lake',
        'bbox': (35.984467, 36.033749, -79.970921, -79.925988),
        'center': (36.02, -79.99),
        'priority': 10
    },
    'bear_creek_reservoir_ga': {
        'name': 'Bear Creek Reservoir (GA)',
        'bbox': (33.28, 33.42, -84.77, -84.55),
        'center': (33.32, -84.65),
        'priority': 10
    },
    'john_d_long_lake': {
        'name': 'John D. Long Lake',
        'bbox': (34.70, 34.82, -81.58, -81.42),
        'center': (34.76, -81.50),
        'priority': 10
    },
    'prestwood_lake': {
        'name': 'Prestwood Lake',
        'bbox': (34.362984, 34.398393, -80.101684, -80.058118),
        'center': (34.39, -80.07),
        'priority': 10
    },
    'hb_robinson_lake': {
        'name': 'H.B. Robinson Lake',
        'bbox': (34.39085, 34.500315, -80.184235, -80.131921),
        'center': (34.38, -80.10),
        'priority': 10
    },
    'lake_jocassee': {
        'name': 'Lake Jocassee',
        'bbox': (34.942288, 35.081035, -83.005443, -82.876212),
        'center': (34.96, -82.92),
        'priority': 12
    },
    'lake_keowee': {
        'name': 'Lake Keowee',
        'bbox': (34.68731, 34.973912, -83.019289, -82.823672),
        'center': (34.70, -82.88),
        'priority': 10
    },
    'lake_summit': {
        'name': 'Lake Summit',
        'bbox': (35.41, 35.47, -82.59, -82.49),
        'center': (35.44, -82.54),
        'priority': 10
    },
    'north_fork_reservoir': {
        'name': 'North Fork Reservoir',
        'bbox': (35.649361, 35.68903, -82.356483, -82.321775),
        'center': (35.58, -82.58),
        'priority': 10
    },
    'lake_adger': {
        'name': 'Lake Adger',
        'bbox': (35.37, 35.43, -82.47, -82.35),
        'center': (35.40, -82.41),
        'priority': 10
    },

    # ── SC UPSTATE & GREENVILLE LAKES ─────────────────────────────────────────
    'lake_robinson_greenville': {
        'name': 'Lake Robinson (Greenville)',
        'bbox': (34.971703, 35.030203, -82.221491, -82.175177),
        'center': (34.99, -82.26),
        'priority': 10
    },
    'north_saluda_reservoir': {
        'name': 'North Saluda Reservoir',
        'bbox': (35.12861, 35.176552, -82.431717, -82.35692),
        'center': (34.95, -82.36),
        'priority': 10
    },
    'lake_cunningham': {
        'name': 'Lake Cunningham',
        'bbox': (34.965188, 34.996634, -82.293262, -82.234855),
        'center': (34.95, -82.23),
        'priority': 10
    },
    'lake_blalock': {
        'name': 'Lake Blalock',
        'bbox': (35.084344, 35.122912, -82.027974, -81.959984),
        'center': (35.04, -81.95),
        'priority': 10
    },
    'lake_bowen': {
        'name': 'Lake Bowen',
        'bbox': (35.089064, 35.133419, -82.12985, -82.007191),
        'center': (35.11, -82.05),
        'priority': 10
    },
    'lake_lure': {
        'name': 'Lake Lure',
        'bbox': (35.40592, 35.470918, -82.244736, -82.172223),
        'center': (35.43, -82.20),
        'priority': 10
    },

    # ── NC LAKES (Catawba, Piedmont, Northern Border) ─────────────────────────
    'lake_james': {
        'name': 'Lake James',
        'bbox': (35.704079, 35.805146, -82.007205, -81.810021),
        'center': (35.75, -81.88),
        'priority': 10
    },
    'john_h_moss_lake': {
        'name': 'John H. Moss Lake',
        'bbox': (35.264554, 35.337627, -81.484049, -81.427557),
        'center': (35.30, -81.44),
        'priority': 10
    },
    'lookout_shoals_lake': {
        'name': 'Lookout Shoals Lake',
        'bbox': (35.87, 36.08, -81.15, -80.95),
        'center': (35.97, -81.05),
        'priority': 12
    },
    'w_kerr_scott_reservoir': {
        'name': 'W. Kerr Scott Reservoir',
        'bbox': (36.076844, 36.145925, -81.316189, -81.215833),
        'center': (36.13, -81.22),
        'priority': 10
    },
    'belews_lake': {
        'name': 'Belews Lake',
        'bbox': (36.199134, 36.334144, -80.103568, -79.995932),
        'center': (36.27, -80.05),
        'priority': 10
    },
    'randleman_lake': {
        'name': 'Randleman Lake',
        'bbox': (35.817609, 35.95956, -79.913049, -79.791732),
        'center': (35.80, -80.00),
        'priority': 10
    },
    'shearon_harris_reservoir': {
        'name': 'Shearon Harris Reservoir',
        'bbox': (35.556267, 35.659847, -78.994054, -78.884364),
        'center': (35.63, -78.98),
        'priority': 10
    },
    'buckhorn_reservoir': {
        'name': 'Buckhorn Reservoir',
        'bbox': (35.66, 35.78, -78.73, -78.58),
        'center': (35.72, -78.65),
        'priority': 10
    },
    'mayo_lake': {
        'name': 'Mayo Lake',
        'bbox': (36.420759, 36.546354, -78.909506, -78.839784),
        'center': (36.50, -78.88),
        'priority': 10
    },
    'hyco_lake': {
        'name': 'Hyco Lake',
        'bbox': (36.379587, 36.53722, -79.202712, -79.029897),
        'center': (36.40, -79.18),
        'priority': 10
    },
    'lake_michie': {
        'name': 'Lake Michie',
        'bbox': (36.185212, 36.206086, -79.174382, -79.152409),
        'center': (36.08, -79.06),
        'priority': 12
    },
    'kerr_lake': {
        'name': 'Kerr Lake (John H. Kerr Reservoir)',
        'bbox': (36.374761, 36.738831, -78.761234, -78.257956),
        'center': (36.50, -78.55),
        'priority': 10
    },
    'lake_gaston': {
        'name': 'Lake Gaston',
        'bbox': (36.454623, 36.628711, -78.217647, -77.799346),
        'center': (36.50, -77.95),
        'priority': 10
    },
    'lake_townsend': {
        'name': 'Lake Townsend',
        'bbox': (36.150218, 36.221163, -79.826898, -79.721467),
        'center': (36.18, -79.74),
        'priority': 10
    },
    'lake_mackintosh': {
        'name': 'Lake Mackintosh',
        'bbox': (36.01, 36.09, -79.62, -79.49),
        'center': (36.05, -79.55),
        'priority': 10
    },
    'lake_reidsville': {
        'name': 'Lake Reidsville',
        'bbox': (36.3, 36.42, -79.78, -79.65),
        'center': (36.34, -79.67),
        'priority': 12
    },
    'oak_hollow_higgins': {
        'name': 'Oak Hollow & Lake Higgins Chain',
        'bbox': (35.984504, 36.181004, -80.02977, -79.868797),
        'center': (36.09, -79.88),
        'priority': 12
    },
    'lake_brandt': {
        'name': 'Lake Brandt',
        'bbox': (36.136072, 36.187337, -79.898186, -79.826925),
        'center': (36.18, -79.85),
        'priority': 10
    },
    'auman_lake': {
        'name': 'Lake Auman',
        'bbox': (35.19, 35.29, -79.68, -79.52),
        'center': (35.24, -79.60),
        'priority': 10
    },
    'jordan_lake': {
        'name': 'Jordan Lake',
        'bbox': (35.630627, 35.883924, -79.117851, -78.951395),
        'center': (35.75, -79.05),
        'priority': 10
    },
    'falls_lake': {
        'name': 'Falls Lake',
        'bbox': (35.919452, 36.105283, -78.796082, -78.561928),
        'center': (35.95, -78.88),
        'priority': 10
    },
    'bonnie_doone_lake': {
        'name': 'Bonnie Doone Lake',
        'bbox': (35.099588, 35.128341, -78.956929, -78.932336),
        'center': (35.11, -78.94),
        'priority': 10
    },
    'kornbow_lake': {
        'name': 'Kornbow Lake',
        'bbox': (35.089922, 35.116384, -78.952095, -78.918837),
        'center': (35.10, -78.93),
        'priority': 10
    },

    # ── TENNESSEE & WESTERN NC MOUNTAIN LAKES ─────────────────────────────────
    'fort_loudoun_lake': {
        'name': 'Fort Loudoun Lake',
        'bbox': (35.730664, 35.978777, -84.254564, -83.839433),
        'center': (35.88, -84.10),
        'priority': 10
    },
    'tellico_lake': {
        'name': 'Tellico Lake',
        'bbox': (35.448177, 35.79147, -84.297915, -84.039707),
        'center': (35.62, -84.28),
        'priority': 10
    },
    'melton_hill_lake': {
        'name': 'Melton Hill Lake',
        'bbox': (35.863392, 36.232105, -84.310611, -84.064012),
        'center': (35.95, -84.26),
        'priority': 10
    },
    'watts_bar_lake': {
        'name': 'Watts Bar Lake',
        'bbox': (35.605422, 35.886529, -84.872416, -84.232055),
        'center': (35.70, -84.60),
        'priority': 10
    },
    'lake_chilhowee': {
        'name': 'Lake Chilhowee',
        'bbox': (35.476553, 35.572182, -84.060394, -83.969486),
        'center': (35.54, -84.06),
        'priority': 10
    },
    'chickamauga_lake': {
        'name': 'Chickamauga Lake',
        'bbox': (35.091113, 35.488591, -85.239039, -84.890345),
        'center': (35.35, -85.02),
        'priority': 10
    },
    'nickajack_lake': {
        'name': 'Nickajack Lake',
        'bbox': (34.975064, 35.095626, -85.640749, -85.409844),
        'center': (35.05, -85.44),
        'priority': 10
    },
    'fontana_lake': {
        'name': 'Fontana Lake',
        'bbox': (35.324539, 35.492658, -83.820069, -83.495265),
        'center': (35.35, -83.72),
        'priority': 10
    },
    'hiwassee_lake': {
        'name': 'Hiwassee Lake',
        'bbox': (35.129415, 35.189216, -84.305784, -84.167462),
        'center': (35.17, -84.10),
        'priority': 10
    },
    'lake_chatuge': {
        'name': 'Lake Chatuge',
        'bbox': (34.90824, 35.047631, -83.835255, -83.701828),
        'center': (34.98, -83.79),
        'priority': 10
    },
    'watauga_lake': {
        'name': 'Watauga Lake',
        'bbox': (36.266977, 36.391692, -82.141998, -81.918231),
        'center': (36.31, -82.11),
        'priority': 10
    },
    'norris_lake': {
        'name': 'Norris Lake',
        'bbox': (36.213746, 36.430034, -84.204217, -83.418127),
        'center': (36.30, -83.90),
        'priority': 12
    },
    'douglas_lake': {
        'name': 'Douglas Lake',
        'bbox': (35.892507, 36.134321, -83.549112, -83.180803),
        'center': (35.98, -83.40),
        'priority': 10
    },
    'cherokee_lake': {
        'name': 'Cherokee Lake',
        'bbox': (36.116827, 36.558397, -83.526084, -82.598001),
        'center': (36.28, -83.35),
        'priority': 10
    },
    'boone_lake': {
        'name': 'Boone Lake',
        'bbox': (36.369198, 36.509562, -82.449445, -82.252591),
        'center': (36.43, -82.42),
        'priority': 10
    },
    'south_holston_lake': {
        'name': 'South Holston Lake',
        'bbox': (36.474772, 36.665383, -82.116556, -81.892224),
        'center': (36.56, -82.09),
        'priority': 10
    },
    'nantahala_lake': {
        'name': 'Nantahala Lake',
        'bbox': (35.145468, 35.209521, -83.707658, -83.628081),
        'center': (35.19, -83.65),
        'priority': 10
    },
    'lake_santeetlah': {
        'name': 'Lake Santeetlah',
        'bbox': (35.303499, 35.389216, -83.920349, -83.795346),
        'center': (35.36, -83.85),
        'priority': 10
    },
    'lake_cheoah': {
        'name': 'Lake Cheoah',
        'bbox': (35.42, 35.48, -83.92, -83.79),
        'center': (35.45, -83.86),
        'priority': 10
    },
    'lake_glenville': {
        'name': 'Lake Glenville',
        'bbox': (35.126694, 35.208097, -83.187021, -83.111879),
        'center': (35.18, -83.14),
        'priority': 10
    },
    'lake_toxaway': {
        'name': 'Lake Toxaway',
        'bbox': (35.06039, 35.176755, -82.971422, -82.87518),
        'center': (35.13, -82.93),
        'priority': 10
    },
    'bear_creek_lake': {
        'name': 'Bear Creek Lake',
        'bbox': (35.209852, 35.259613, -83.082727, -83.01045),
        'center': (35.23, -83.05),
        'priority': 10
    },

    # ── GA LAKES (Blue Ridge, Burton, Allatoona, Lanier, etc.) ────────────────
    'lake_lanier': {
        'name': 'Lake Lanier',
        'bbox': (34.136262, 34.449863, -84.131103, -83.679181),
        'center': (34.30, -84.08),
        'priority': 10
    },
    'lake_allatoona': {
        'name': 'Lake Allatoona',
        'bbox': (34.023089, 34.242505, -84.745881, -84.520785),
        'center': (34.14, -84.58),
        'priority': 10
    },
    'lake_blue_ridge': {
        'name': 'Lake Blue Ridge',
        'bbox': (34.787266, 34.895222, -84.308113, -84.22394),
        'center': (34.83, -84.42),
        'priority': 10
    },
    'lake_nottely': {
        'name': 'Lake Nottely',
        'bbox': (34.850008, 34.971567, -84.12573, -83.971155),
        'center': (34.88, -84.12),
        'priority': 10
    },
    'lake_burton': {
        'name': 'Lake Burton',
        'bbox': (34.782047, 34.898577, -83.597655, -83.504895),
        'center': (34.80, -83.54),
        'priority': 10
    },
    'lake_seed': {
        'name': 'Lake Seed',
        'bbox': (34.741543, 34.80016, -83.533243, -83.490656),
        'center': (34.78, -83.51),
        'priority': 10
    },
    'parksville_lake': {
        'name': 'Parksville Lake',
        'bbox': (35.05753, 35.128008, -84.661239, -84.557146),
        'center': (35.10, -84.64),
        'priority': 10
    },
    'west_point_lake': {
        'name': 'West Point Lake',
        'bbox': (32.906163, 33.259421, -85.268062, -84.978882),
        'center': (32.92, -85.18),
        'priority': 10
    },
    'lake_sinclair': {
        'name': 'Lake Sinclair',
        'bbox': (33.128824, 33.361102, -83.442948, -83.091715),
        'center': (33.15, -83.20),
        'priority': 10
    },
    'lake_oconee': {
        'name': 'Lake Oconee',
        'bbox': (33.333734, 33.675438, -83.368145, -83.128944),
        'center': (33.30, -83.15),
        'priority': 10
    },
    'lake_jackson_ga': {
        'name': 'Lake Jackson (GA)',
        'bbox': (33.308492, 33.448649, -83.930717, -83.804795),
        'center': (33.32, -83.84),
        'priority': 10
    },
    'tobesofkee_reservoir': {
        'name': 'Tobesofkee Reservoir',
        'bbox': (32.808051, 32.871423, -83.850553, -83.754148),
        'center': (32.82, -83.78),
        'priority': 10
    },
    'lake_blackshear': {
        'name': 'Lake Blackshear',
        'bbox': (31.824347, 32.065229, -83.991141, -83.879288),
        'center': (31.85, -83.93),
        'priority': 10
    },


    'watauga_boone_chain': {
        'name': 'Watauga / Boone / South Holston Chain',
        'bbox': (36.266977, 36.509562, -82.449445, -81.918231),
        'center': (36.40, -82.40),
        'priority': 12
    },
    'catawba_narrows': {
        'name': 'Catawba River Narrows (Wylie to Mountain Island)',
        'bbox': (34.95, 35.35, -81.22, -80.88),
        'center': (35.15, -81.05),
        'priority': 8
    },
    # ── COASTAL CATCH-ALL (SC/GA tidal/salt — hold for future coastal feature) ──
    'sc_ga_coastal': {
        'name': 'SC/GA Coastal Waters',
        'bbox': (31.50, 33.85, -82.00, -78.80),
        'center': (32.50, -80.40),
        'priority': 5   # lowest priority — all inland lakes win ties
    },
}

if __name__ == '__main__':
    print(f"Loaded {len(LAKE_CATALOG)} unique lake definitions.")
