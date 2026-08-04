#!/usr/bin/env python3
"""
trollmap_nhd_boundaries.py — Extract lake boundaries from NHDPlus HR GDB files
for slugs that are missing from or confirmed wrong in the 3DHP GPKG.

Reads NHDWaterbody (FType=436 reservoir + 390 lake) from NHDPlus HR GDBs,
matches by GNIS_Name, outputs {slug}_nhd.geojson in the same format as
trollmap_lake_boundaries.py outputs {slug}_3dhp.geojson.

Usage:
    py trollmap_nhd_boundaries.py
    py trollmap_nhd_boundaries.py --lake falls_lake
    py trollmap_nhd_boundaries.py --overwrite
    py trollmap_nhd_boundaries.py --dump-names --lake randleman_lake
    py trollmap_nhd_boundaries.py --list

Requires: geopandas, pyproj, fiona, lake_catalog.py in same directory
NHD GDBs: F:\\TrollMapPipeline\\NHD\\

HUC4 reference for SE US:
  0302 = Neuse (Falls Lake, Jordan, Kerr/Gaston, Buckhorn, Michie, Mayo, Hyco)
  0303 = Santee (Catawba/Wateree/SC lakes)
  0304 = Pee Dee/Yadkin (NC Piedmont west, upstate SC)
  0305 = Cape Fear
  0313 = Upper Coosa (NW GA — Allatoona, Blue Ridge, Nottely, Chatuge)
  0315 = Ocmulgee (Juliette, Tobesofkee)
  0316 = Oconee/Altamaha (Oconee, Sinclair, Blackshear)
  0601 = Upper Tennessee (Norris, Cherokee, Douglas, Ft Loudoun, Tellico,
          Melton Hill, S Holston, Watauga/Boone, Santeetlah, Fontana, Nantahala)
  0602 = Middle Tennessee (Watts Bar, Chickamauga, Nickajack)

NOTE: 0302 GDB not yet downloaded — lakes in that HUC will be skipped.
Download: https://prd-tnm.s3.amazonaws.com/StagedProducts/Hydrography/NHDPlusHR/VPU/Current/GDB/NHDPLUS_H_0302_HU4_GDB.zip
"""
import sys
import re
import argparse
from pathlib import Path

# Piping changes the encoding. When stdout is a console, Python uses the console's codepage;
# when it is a PIPE -- `| Select-String`, `> file`, `| more` -- it falls back to the LOCALE
# default, cp1252 on this machine. Every non-cp1252 character in an f-string then raises
# UnicodeEncodeError mid-print, from inside print() itself, so the traceback points at the
# format string and not at the pipe that actually caused it. `--list` died exactly this way
# on 2026-08-03: it ran clean at the console and crashed the moment it was piped.
#
# The status column is plain ASCII now, so this is belt-and-braces for the em-dashes and the
# superscript-2 in the messages below -- both survive cp1252 today, but neither should be one
# edit away from breaking a piped run again.
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except (AttributeError, ValueError):
    pass          # Python < 3.7, or a stream that does not support it. Not worth failing over.

try:
    from lake_catalog import LAKE_CATALOG
except ImportError:
    print("ERROR: lake_catalog.py not found in same directory")
    sys.exit(1)

NHD_DIR = Path(r'F:\TrollMapPipeline\NHD')
OUT_DIR  = Path(r'F:\TrollMapPipeline\lake_boundaries')
LAYER    = 'NHDWaterbody'
FTYPES   = {390, 436}  # Lake/Pond + Reservoir

# EVERY NHDPlus HR GDB on the card, not just the ones a lake currently asks for.
#
# This listed five. 0304 -- Pee Dee/Yadkin, named in the docstring above -- was missing even
# though NHDPLUS_H_0304_HU4_GDB.zip (321 MB) has been sitting in NHD_DIR since April, so no
# lake could reach NHDPlus HR for that basin at all. High Rock and Blewett Falls were pointed
# at 0306 instead, which is the Santee (Catawba, Wateree, Congaree). Both came back
# "0 features in bbox" -- correctly, they are not in that basin -- fell through to classic
# NHD, failed to match a name there, and were handed to the largest-unnamed-polygon guess.
#
# A missing entry here does not raise. It silently disables a whole basin and the failure
# surfaces three fallbacks later as a bad polygon, so the map is the complete download list.
HUC4_GDB = {
    '0302': NHD_DIR / 'NHDPLUS_H_0302_HU4_GDB.zip',   # Neuse
    '0303': NHD_DIR / 'NHDPLUS_H_0303_HU4_GDB.zip',   # Cape Fear / lower NC
    '0304': NHD_DIR / 'NHDPLUS_H_0304_HU4_GDB.zip',   # Pee Dee / Yadkin
    '0305': NHD_DIR / 'NHDPLUS_H_0305_HU4_GDB.zip',   # Cape Fear
    '0306': NHD_DIR / 'NHDPLUS_H_0306_HU4_GDB.zip',   # Santee -- Catawba, Wateree, Congaree
    '0307': NHD_DIR / 'NHDPLUS_H_0307_HU4_GDB.zip',   # Edisto / Savannah
    '0308': NHD_DIR / 'NHDPLUS_H_0308_HU4_GDB.zip',   # Ogeechee
    '0313': NHD_DIR / 'NHDPLUS_H_0313_HU4_GDB.zip',   # Upper Coosa
    '0315': NHD_DIR / 'NHDPLUS_H_0315_HU4_GDB.zip',   # Ocmulgee
    '0316': NHD_DIR / 'NHDPLUS_H_0316_HU4_GDB.zip',   # Oconee / Altamaha
    '0601': NHD_DIR / 'NHDPLUS_H_0601_HU4_20220418_GDB.zip',   # Upper Tennessee
    '0602': NHD_DIR / 'NHDPLUS_H_0602_HU4_20220418_GDB.zip',   # Middle Tennessee
}

# Classic NHD (not Plus HR) — true HUC4 codes, lowercase columns, compound 3D CRS.
# Third-pass fallback for lakes absent from NHDPlus HR.
NHD_CLASSIC_GDB = {
    'c0302': NHD_DIR / 'NHD_H_0302_HU4_GDB.zip',
    'c0303': NHD_DIR / 'NHD_H_0303_HU4_GDB.zip',
    'c0304': NHD_DIR / 'NHD_H_0304_HU4_GDB.zip',
    'c0313': NHD_DIR / 'NHD_H_0313_HU4_GDB.zip',
    'c0315': NHD_DIR / 'NHD_H_0315_HU4_GDB.zip',
}

CLASSIC_HUCS = {
    'falls_lake':               ['c0302'],
    'buckhorn_reservoir':       ['c0302'],
    'hyco_lake':                ['c0302', 'c0303'],
    'kerr_lake':                ['c0302', 'c0303'],
    'lake_gaston':              ['c0302', 'c0303'],
    'jordan_lake':              ['c0303'],
    'shearon_harris_reservoir': ['c0303'],
    'randleman_lake':           ['c0303'],
    'lake_blackshear':          ['c0313'],
    'lake_allatoona':           ['c0315'],
    # c0304 is Pee Dee/Yadkin — the fallback if NHDPlus HR 0306 does not name these.
    'high_rock_lake':           ['c0304'],
    'blewett_falls_lake':       ['c0304'],
}

CLASSIC_NAME_FILTERS = {
    'jordan_lake':              ['b everett jordan', 'jordan lake'],
    'kerr_lake':                ['john h. kerr', 'kerr reservoir', 'buggs island'],
    'lake_gaston':              ['gaston'],
    'hyco_lake':                ['hyco'],
    'falls_lake':               ['falls lake'],
    'buckhorn_reservoir':       ['buckhorn'],
    'shearon_harris_reservoir': ['shearon harris'],
    'randleman_lake':           ['randleman'],
    'lake_blackshear':          ['blackshear'],
    'lake_allatoona':           ['allatoona'],
    'high_rock_lake':           ['high rock'],
    'blewett_falls_lake':       ['blewett'],
}

SLUG_HUCS = {
    # SC/NC/GA — VPU 0306 (Catawba, Savannah, Blue Ridge, upper SC)
    'lake_wateree_fishing_creek':  ['0306'],
    'lake_monticello_parr':        ['0306'],
    'lake_thurmond_russell':       ['0306'],
    'hb_robinson_lake':            ['0306'],
    'prestwood_lake':              ['0306'],
    'lake_wylie':                  ['0306'],
    'lake_norman_mountain_island': ['0306'],
    'lake_hickory_rhodhiss':       ['0306'],
    'lake_james':                  ['0306'],
    'lake_hartwell':               ['0306'],
    'lake_jocassee':               ['0306'],
    'lake_keowee':                 ['0306'],
    'north_saluda_reservoir':      ['0306'],
    'lake_adger':                  ['0306'],
    'lake_summit':                 ['0306'],
    'north_fork_reservoir':        ['0306'],
    'lake_blalock':                ['0306'],
    'lake_bowen':                  ['0306'],
    'lake_cunningham':             ['0306'],
    'lake_robinson_greenville':    ['0306'],
    'lake_blue_ridge':             ['0306'],
    'lake_seed':                   ['0306'],
    'lake_burton':                 ['0306'],
    'lake_chatuge':                ['0306'],
    'parksville_lake':             ['0306'],
    'belews_lake':                 ['0306'],
    'john_h_moss_lake':            ['0306'],
    # 0304 = Pee Dee/Yadkin. These were 0306 (Santee) and returned 0 features in bbox, which
    # was the truth: the Yadkin is not in the Santee basin. The chain key's own 0306 was
    # equally wrong -- it only produced a file because it fell through to classic c0304.
    'yadkin_river_chain':          ['0304'],
    'high_rock_lake':              ['0304'],
    'blewett_falls_lake':          ['0304'],
    'w_kerr_scott_reservoir':      ['0306'],
    # SC/GA interior — VPU 0307 (Oconee, Ocmulgee, lower SC)
    'lake_murray':                 ['0307'],
    'lake_marion':                 ['0307'],
    'lake_moultrie':               ['0307'],
    'lake_sinclair':               ['0307'],
    'lake_oconee':                 ['0307'],
    'lake_blackshear':             ['0307'],
    'lake_jackson_ga':             ['0307'],
    'lake_juliette_high_falls':    ['0307'],
    'tobesofkee_reservoir':        ['0307'],
    'lake_lanier':                 ['0307'],
    'lake_lure':                   ['0307'],
    'lake_townsend':               ['0307'],
    # Straddle 0306/0307
    'lake_greenwood_secession':    ['0306', '0307'],
    'lake_allatoona':              ['0306', '0307'],
    # 0601, not 0306/0307. The Hiwassee River drains to the Tennessee; it is not in the
    # Santee or the Savannah. Searching the wrong two VPUs is why the boundary on disk
    # is a 1,064 acre fragment of a 6,090 acre lake. 0306/0307 kept as fallbacks.
    'hiwassee_lake':               ['0601', '0306', '0307'],
    'lake_nottely':                ['0306', '0307'],
    'randleman_lake':              ['0306', '0307'],
    'lake_mackintosh':             ['0306', '0307'],
    'lake_reidsville':             ['0306', '0307'],
    'oak_hollow_higgins':          ['0306', '0307'],
    'lake_brandt':                 ['0306', '0307'],
    'bear_creek_reservoir_ga':     ['0306', '0307'],
    # NC Neuse basin — VPU 0302 (confirmed correct)
    'falls_lake':                  ['0302'],
    'jordan_lake':                 ['0302'],
    'shearon_harris_reservoir':    ['0302'],
    'buckhorn_reservoir':          ['0302'],
    'lake_michie':                 ['0302'],
    'mayo_lake':                   ['0302'],
    'hyco_lake':                   ['0302'],
    'kerr_lake':                   ['0302'],
    'lake_gaston':                 ['0302'],
    'bonnie_doone_lake':           ['0302'],
    'kornbow_lake':                ['0302'],
    # TN Upper Tennessee — VPU 0601 (confirmed correct)
    'norris_lake':                 ['0601'],
    'cherokee_lake':               ['0601'],
    'douglas_lake':                ['0601'],
    'fort_loudoun_lake':           ['0601'],
    'tellico_lake':                ['0601'],
    'melton_hill_lake':            ['0601'],
    'south_holston_lake':          ['0601'],
    'watauga_boone_chain':         ['0601'],
    'lake_chilhowee':              ['0601'],
    'lake_santeetlah':             ['0601'],
    'fontana_lake':                ['0601'],
    'nantahala_lake':              ['0601'],
    'lake_glenville':              ['0601'],
    'lake_toxaway':                ['0601'],
    # TN Middle Tennessee — VPU 0602 (confirmed correct)
    'watts_bar_lake':              ['0601', '0602'],
    'chickamauga_lake':            ['0602'],
    'nickajack_lake':              ['0602'],
    # --- added 2026-08-04, the absent-lake pass. Every Garmin tile these need is
    # already decoded; only the registry side was ever missing.
    'lake_juliette':               ['0307'],   # same VPU as lake_juliette_high_falls
    'auman_lake':                  ['0304'],   # Pee Dee/Yadkin -- NC Sandhills
    'lookout_shoals_lake':         ['0306'],   # Catawba
    'lake_cheoah':                 ['0601'],   # Little Tennessee, not the Santee
}

NAME_FILTERS = {
    'lake_wateree_fishing_creek':  ['wateree', 'fishing creek'],
    'lake_monticello_parr':        ['monticello', 'parr'],
    'lake_greenwood_secession':    ['greenwood', 'secession'],
    'lake_thurmond_russell':       ['thurmond', 'russell', 'clarks hill'],
    'lake_wylie':                  ['wylie'],
    'lake_norman_mountain_island': ['norman', 'mountain island'],
    'lake_hickory_rhodhiss':       ['hickory', 'rhodhiss'],
    'lake_james':                  ['james'],
    'yadkin_river_chain':          ['high rock', 'badin', 'tillery', 'blewett'],
    # Per-lake, so the combined key above can eventually be retired without orphaning them.
    # 3DHP names Badin and Tillery; it does not name these two.
    'high_rock_lake':              ['high rock'],
    'blewett_falls_lake':          ['blewett'],
    'w_kerr_scott_reservoir':      ['kerr scott'],
    'kerr_lake':                   ['john h. kerr', 'kerr reservoir', 'buggs island'],
    'lake_gaston':                 ['gaston'],
    'falls_lake':                  ['falls lake'],
    'jordan_lake':                 ['jordan'],
    'shearon_harris_reservoir':    ['shearon harris'],
    'randleman_lake':              ['randleman'],
    'lake_mackintosh':             ['mackintosh'],
    'lake_reidsville':             ['reidsville'],
    'mayo_lake':                   ['mayo'],
    'hyco_lake':                   ['hyco'],
    'buckhorn_reservoir':          ['buckhorn'],
    'lake_michie':                 ['michie'],
    'belews_lake':                 ['belews'],
    'oak_hollow_higgins':          ['oak hollow', 'higgins'],
    'lake_brandt':                 ['brandt'],
    'bonnie_doone_lake':           ['bonnie doone'],
    'kornbow_lake':                ['kornbow'],
    'lake_summit':                 ['summit'],
    'north_fork_reservoir':        ['north fork'],
    'lake_adger':                  ['adger'],
    'john_h_moss_lake':            ['moss', 'kings mountain'],
    'lake_cunningham':             ['cunningham'],
    'lake_robinson_greenville':    ['robinson', 'lyman'],
    'north_saluda_reservoir':      ['north saluda', 'robinson'],
    'lake_jocassee':               ['jocassee'],
    'lake_keowee':                 ['keowee'],
    'lake_hartwell':               ['hartwell'],
    'hb_robinson_lake':            ['robinson'],
    'prestwood_lake':              ['prestwood'],
    'lake_allatoona':              ['allatoona'],
    'lake_blue_ridge':             ['blue ridge'],          # NHD: "Blue Ridge Lake"
    'lake_nottely':                ['nottely'],              # NHD: may be unnamed — fallback
    'lake_chatuge':                ['chatuge'],              # NHD: may be unnamed — fallback
    'lake_burton':                 ['burton'],               # NHD: "Lake Burton"
    'lake_seed':                   ['seed'],                 # NHD: "Seed Lake"
    'hiwassee_lake':               ['hiwassee', 'apalachia'],
    'parksville_lake':             ['ocoee', 'parksville'],  # NHD: "Lake Ocoee"
    'lake_lanier':                 ['lanier', 'sidney lanier'],  # NHD: "Lake Sidney Lanier"
    'lake_jackson_ga':             ['jackson lake'],         # NHD: "Jackson Lake"
    'lake_juliette_high_falls':    ['juliette', 'high falls'],  # NHD: "High Falls Lake"
    'tobesofkee_reservoir':        ['tobesofkee'],           # NHD: "Lake Tobesofkee"
    'lake_sinclair':               ['sinclair'],             # NHD: "Lake Sinclair"
    'lake_oconee':                 ['oconee'],               # NHD: "Lake Oconee"
    'lake_blackshear':             ['blackshear'],           # NHD: "Lake Blackshear"
    'bear_creek_reservoir_ga':     ['bear creek'],
    'lake_greenwood_secession':    ['greenwood', 'secession'],  # NHD: "Secession Lake", "Greenwood Lakes"
    'lake_bowen':                  ['bowen'],                # NHD: "Bowen Lake/Pond"
    'lake_blalock':                ['blalock'],              # NHD: "Blalock Pond"
    'lake_lure':                   ['lure'],                 # NHD: "Lake Lure" in 0307
    'lake_townsend':               ['townsend'],             # NHD: "Townsend Lake"
    'norris_lake':                 ['norris'],
    'cherokee_lake':               ['cherokee'],
    'douglas_lake':                ['douglas'],
    'fort_loudoun_lake':           ['fort loudoun', 'loudoun'],
    'tellico_lake':                ['tellico'],
    'melton_hill_lake':            ['melton hill'],
    'south_holston_lake':          ['south holston'],
    'watauga_boone_chain':         ['watauga', 'boone'],
    'lake_chilhowee':              ['chilhowee'],
    'lake_santeetlah':             ['santeetlah'],
    'fontana_lake':                ['fontana'],
    'nantahala_lake':              ['nantahala'],
    'lake_glenville':              ['glenville'],
    'lake_toxaway':                ['toxaway'],
    'watts_bar_lake':              ['watts bar'],
    'chickamauga_lake':            ['chickamauga'],
    'nickajack_lake':              ['nickajack'],
    # --- added 2026-08-04, the absent-lake pass. Every Garmin tile these need is
    # already decoded; only the registry side was ever missing.
    'lake_juliette':               ['juliette'],
    'auman_lake':                  ['auman'],
    'lookout_shoals_lake':         ['lookout shoals'],
    'lake_cheoah':                 ['cheoah'],
}

SKIP_SLUGS = {
    'sc_ga_coastal', 'saluda_river_arm', 'catawba_narrows',
    'lookout_shoals_lake', 'lake_cheoah',
    'john_d_long_lake', 'auman_lake',
}


# ── Seeds for the unnamed-polygon growth ─────────────────────────────────────
#
# Taken from lake_catalog.py's own centres, not hand-placed here.
#
# The three that had no catalog entry were resolved on 2026-08-04: lake_juliette got one
# (its centre came from the retired lake_juliette_high_falls record, which carried High
# Falls' bbox alongside Juliette's centre -- that mismatch is why the combined name only
# ever returned the 562 acre half). lake_harding and coddle_creek_reservoir were dropped;
# see PUBLISHED_ACRES below for why.
#
# Two catalog boxes disagree with LAKE_DB and should be eyeballed before trusting
# the result -- see NEEDS_REVIEW below.
#
# FOUR of the nine catalog centres fall OUTSIDE their own bbox: randleman_lake,
# falls_lake, hiwassee_lake and lake_blalock. A seed outside the search window finds
# nothing, so those four use the bbox midpoint instead. The bbox is the more
# trustworthy of the two -- those entries carry six-decimal boxes and two-decimal
# round-number centres, which is machine-derived against hand-typed.
SEEDS = {
    'high_rock_lake': (35.6, -80.25),          # High Rock Lake -- catalog centre
    'blewett_falls_lake': (34.95, -79.85),      # Blewett Falls Lake -- catalog centre
    'randleman_lake': (35.88858, -79.85239),          # Randleman Lake -- bbox midpoint (catalog centre falls OUTSIDE its own bbox)
    'falls_lake': (36.01237, -78.679),              # Falls Lake -- bbox midpoint (catalog centre falls OUTSIDE its own bbox)
    'kerr_lake': (36.5, -78.55),               # Kerr Lake (John H. Kerr Reservoir) -- catalog centre
    'hiwassee_lake': (35.15932, -84.23662),           # Hiwassee Lake -- bbox midpoint (catalog centre falls OUTSIDE its own bbox)
    'lake_cheoah': (35.45, -83.86),             # Lake Cheoah -- catalog centre
    'lake_blalock': (35.10363, -81.99398),            # Lake Blalock -- bbox midpoint (catalog centre falls OUTSIDE its own bbox)
    'lookout_shoals_lake': (35.97, -81.05),     # Lookout Shoals Lake -- catalog centre
    # --- added 2026-08-04, the absent-lake pass. Every Garmin tile these need is
    # already decoded; only the registry side was ever missing.
    'lake_juliette': (33.10, -83.85),          # centre carried over from the combined entry
    'lake_michie': (36.19565, -79.1634),       # bbox midpoint
    'lake_mackintosh': (36.05, -79.555),       # bbox midpoint
    'lake_reidsville': (36.36, -79.715),       # bbox midpoint
    'john_h_moss_lake': (35.3011, -81.4558),   # bbox midpoint
    'auman_lake': (35.24, -79.60),             # bbox midpoint
}

# Published surface acreage. The grown polygon is compared against this and the run
# prints OUT OF RANGE outside 75-135%%. High Rock's old result was 12,265 against
# 15,180 -- 81%%, which would have passed a loose gate and is exactly why the gate
# reports rather than silently accepts.
PUBLISHED_ACRES = {
    'blewett_falls_lake': 2560,
    # coddle_creek_reservoir: DROPPED 2026-08-04 -- boating and fishing are prohibited
    # there, so there is nothing to serve. It also appears nowhere on the card: zero hits
    # for 'Coddle' or 'Don T. Howell' in the Garmin gazetteer, and 3DHP does not name it.
    # (The 230 that used to sit here is Lake Fisher's acreage -- same county, different water.)
    'falls_lake': 12410,
    'high_rock_lake': 15180,
    'hiwassee_lake': 6090,
    'kerr_lake': 48900,
    'lake_blalock': 1105,
    'lake_cheoah': 644,
    # lake_harding: DROPPED 2026-08-04 -- GA/AL border, out of scope.
    'lake_juliette': 3600,
    'lookout_shoals_lake': 1270,
    'randleman_lake': 3007,
    # Added 2026-08-04. Published surface acreages, used only for the 75-135%% report --
    # they gate nothing. Slugs deliberately absent below have no figure I could source,
    # so they get no check and have to be eyeballed: auman_lake, bonnie_doone_lake,
    # catawba_narrows.
    'lake_mackintosh': 1100,
    'lake_michie': 480,
    'lake_reidsville': 750,
    'john_h_moss_lake': 1450,
}

# Catalog bbox disagrees with LAKE_DB's bounds by more than the lake's own size.
# Not resolved here because it is a question about water, not code.
NEEDS_REVIEW = {
    'lake_blalock': 'catalog 35.084-35.123 N vs LAKE_DB 35.15-35.25 N -- 0.03 to 0.13 deg apart',
    'lookout_shoals_lake': 'catalog 35.87-36.08 N; Lookout Shoals sits on the Catawba nearer 35.75-35.80',
}

# ── Seed and grow ─────────────────────────────────────────────────────────────
#
# Replaces "largest unnamed polygon in the bbox", which is wrong for exactly the
# lakes it was written for. NHD assigns reach codes per HUC12, so a reservoir that
# crosses a HUC12 line is stored as SEVERAL unnamed rows -- and "largest" keeps one
# of them. High Rock came back 12,265 acres against a published ~15,180: not a bad
# polygon, a fragment of a good one, which is why it looked plausible.
#
# Growing from a seed is the same method the river cutter already uses and has been
# tested on: take the polygon under a known point, add every polygon touching it,
# repeat until nothing new joins. Contiguity is what defines the water body, not
# size, and it reassembles a reservoir split across HUC12 boundaries without
# reaching into a neighbouring lake -- neighbours are not contiguous, that is what
# makes them neighbours.
#
# JOIN_TOL is deliberately tiny. NHD polygons that belong to one lake share edges;
# a tolerance big enough to bridge a dam is big enough to swallow the lake below it.
SEED_BBOX_PAD_DEG = 0.08       # ~9 km; the window, not the lake -- see extract_slug()
JOIN_TOL_DEG = 0.0005          # ~55 m
SEED_MAX_DIST_DEG = 0.02       # ~2 km; further than this and the seed is not on the lake


def _seed_and_grow(unnamed, seed_lat, seed_lon, label=""):
    """Return the connected group of unnamed polygons anchored on the seed point.

    `unnamed` is a GeoDataFrame in the layer's own CRS-projected-to-WGS84 bbox space.
    Returns a GeoDataFrame slice, or None when the seed lands nowhere near anything.
    """
    from shapely.geometry import Point

    geoms = list(unnamed.geometry)
    if not geoms:
        return None
    seed = Point(seed_lon, seed_lat)

    inside = [i for i, g in enumerate(geoms) if g is not None and g.contains(seed)]
    if inside:
        start = inside[0]
    else:
        start = min((i for i, g in enumerate(geoms) if g is not None),
                    key=lambda i: geoms[i].distance(seed), default=None)
        if start is None:
            return None
        d = geoms[start].distance(seed)
        if d > SEED_MAX_DIST_DEG:
            print(f"    seed-and-grow{label}: nearest unnamed polygon is {d:.4f} deg away — no seed")
            return None
        print(f"    seed-and-grow{label}: seed not inside any polygon, using nearest at {d:.4f} deg")

    try:
        sindex = unnamed.sindex
    except Exception:
        sindex = None

    chosen = {start}
    frontier = [start]
    rounds = 0
    while frontier and rounds < 200:
        rounds += 1
        nxt = []
        for i in frontier:
            probe = geoms[i].buffer(JOIN_TOL_DEG)
            cand = (sindex.query(probe) if sindex is not None else range(len(geoms)))
            for j in cand:
                j = int(j)
                if j in chosen or geoms[j] is None:
                    continue
                if geoms[j].intersects(probe):
                    chosen.add(j)
                    nxt.append(j)
        frontier = nxt

    print(f"    seed-and-grow{label}: {len(chosen)} of {len(geoms)} unnamed polygons "
          f"joined in {rounds} round(s)")
    return unnamed.iloc[sorted(chosen)]


def _acre_check(gdf, expected_acres, label=""):
    """Compare the grown polygon against a published acreage. Returns (acres, ok)."""
    if gdf is None or not len(gdf):
        return 0.0, False
    try:
        acres = float(gdf.to_crs(5070).geometry.area.sum()) * 0.000247105
    except Exception as ex:
        print(f"    acreage check{label}: could not project ({ex}) — not gating")
        return 0.0, True
    if not expected_acres:
        print(f"    acreage{label}: {acres:,.0f} ac (no published figure to check against)")
        return acres, True
    ratio = acres / float(expected_acres)
    ok = 0.75 <= ratio <= 1.35
    verdict = "OK" if ok else "OUT OF RANGE"
    print(f"    acreage{label}: {acres:,.0f} ac vs published {expected_acres:,.0f} "
          f"({ratio:.0%}) — {verdict}")
    return acres, ok

def _bbox_for_layer(bbox_wgs84, layer_crs):
    """
    Return bbox in layer native CRS.
    NAD83 (4269) and WGS84 (4326) are sub-metre equivalent for CONUS —
    treat them identically to avoid floating-point drift that kills bbox queries.
    Only transform for genuinely projected CRS (e.g. 5498 used by some TVA GDBs).
    """
    from pyproj import Transformer, CRS
    NAD83_LIKE = {4269, 4326}
    epsg = layer_crs.to_epsg() if layer_crs else None
    if epsg in NAD83_LIKE or layer_crs is None:
        return bbox_wgs84
    wgs84 = CRS('EPSG:4326')
    tr = Transformer.from_crs(wgs84, layer_crs, always_xy=True)
    minx, miny, maxx, maxy = bbox_wgs84
    corners = [tr.transform(minx, miny), tr.transform(maxx, miny),
               tr.transform(minx, maxy), tr.transform(maxx, maxy)]
    xs = [c[0] for c in corners]; ys = [c[1] for c in corners]
    return (min(xs), min(ys), max(xs), max(ys))


def _find_name_col(gdf):
    """Return the GNIS name column, or None."""
    for c in ['GNIS_Name', 'GNIS_NAME', 'gnis_name', 'GNISName']:
        if c in gdf.columns:
            return c
    return None


def extract_slug(slug, overwrite=False, dump_names=False):
    import geopandas as gpd
    import pandas as pd
    from pyproj import CRS

    if slug in SKIP_SLUGS:
        print(f"  {slug}: SKIPPED")
        return True

    out_path = OUT_DIR / f"{slug}_nhd.geojson"
    if out_path.exists() and not overwrite:
        print(f"  {slug}: already exists (--overwrite to replace)")
        return True

    catalog = LAKE_CATALOG.get(slug)
    if not catalog:
        print(f"  {slug}: not in catalog")
        return False

    hucs = SLUG_HUCS.get(slug)
    if not hucs:
        print(f"  {slug}: no HUC mapping defined — skipping")
        return False

    filters = NAME_FILTERS.get(slug)
    if not filters:
        name = re.sub(r'\s*\(.*?\)', '', catalog['name'])
        name = re.sub(r'\s*(chain|above|below|arm)\b.*', '', name, flags=re.IGNORECASE)
        filters = [p.strip().lower() for p in re.split(r'[&/]', name) if p.strip()]

    s, n, w, e = catalog['bbox']
    # A seeded lake gets a PADDED search window.
    #
    # The bbox is only the query window; seed-and-grow decides what the lake is, and it
    # is bounded by contiguity, not by the box. So widening is safe -- a neighbouring
    # reservoir pulled into the window does not join the result, because it does not
    # touch. Not widening is NOT safe: High Rock's catalog box stops at W-80.35/N35.70
    # while its real polygon runs to W-80.404/N35.750, so the window clipped the lake
    # and the growth would have been clipped with it. The box that was meant to help
    # find the lake was cutting a piece off it.
    #
    # Only seeded slugs are padded. Everything else keeps the exact window it has always
    # used, because for a name-matched lake the box IS the constraint.
    if slug in SEEDS:
        pad = SEED_BBOX_PAD_DEG
        s, n, w, e = s - pad, n + pad, w - pad, e + pad
        print(f"  {slug}: search window padded by {pad} deg for seed-and-grow")

    bbox_wgs84 = (w, s, e, n)
    wgs84 = CRS('EPSG:4326')

    print(f"  {slug}: {catalog['name']}")
    print(f"    bbox: S{s} N{n} W{w} E{e}")
    print(f"    filters: {filters}")
    print(f"    HUCs: {hucs}")

    all_matches = []

    for huc in hucs:
        gdb_path = HUC4_GDB.get(huc)
        if not gdb_path:
            print(f"    HUC {huc}: no GDB path configured")
            continue
        if not gdb_path.exists():
            print(f"    HUC {huc}: GDB not downloaded ({gdb_path.name})")
            continue

        try:
            probe = gpd.read_file(str(gdb_path), layer=LAYER, rows=1)
            layer_crs = probe.crs
            epsg = layer_crs.to_epsg() if layer_crs else 'unknown'
            bbox_native = _bbox_for_layer(bbox_wgs84, layer_crs)
            print(f"    HUC {huc}: CRS={epsg} reading...")

            gdf = gpd.read_file(str(gdb_path), layer=LAYER, bbox=bbox_native)
            print(f"    HUC {huc}: {len(gdf)} features in bbox")

            if len(gdf) == 0:
                continue

            if gdf.crs and not gdf.crs.equals(wgs84):
                gdf = gdf.to_crs('EPSG:4326')

            if 'FType' in gdf.columns:
                gdf = gdf[gdf['FType'].isin(FTYPES)]
                print(f"    HUC {huc}: {len(gdf)} after FType filter")

            if len(gdf) == 0:
                continue

            name_col = _find_name_col(gdf)

            if name_col and filters:
                pattern = '|'.join(re.escape(f) for f in filters)
                matches = gdf[gdf[name_col].str.contains(pattern, case=False, na=False)]
                print(f"    HUC {huc}: {len(matches)} name matches")

                if len(matches) == 0:
                    avail = gdf[name_col].dropna().unique()[:15].tolist()
                    print(f"    Available names (sample): {avail}")
                    if dump_names:
                        all_names = sorted(gdf[name_col].dropna().unique().tolist())
                        unnamed = int(gdf[name_col].isna().sum())
                        print(f"    ALL named ({len(all_names)}), unnamed rows: {unnamed}:")
                        for nm in all_names:
                            print(f"      {nm}")

                    # Fallback: largest single waterbody polygon in bbox.
                    # Handles TVA/USACE reservoirs stored without GNIS_Name
                    # (e.g. Chickamauga, Hyco, Kerr) where the reservoir polygon
                    # is real but the name field is null.
                    unnamed_feats = gdf[gdf[name_col].isna()]
                    if len(unnamed_feats) > 0:
                        seed = SEEDS.get(slug)
                        grown = None
                        if seed:
                            grown = _seed_and_grow(unnamed_feats, seed[0], seed[1],
                                                   label=f" [{slug} HUC {huc}]")
                        if grown is not None and len(grown):
                            _acre_check(grown, PUBLISHED_ACRES.get(slug), label=f" [{slug}]")
                            all_matches.append(grown)
                        else:
                            # No seed, or the seed found nothing: fall back to the old
                            # behaviour rather than dropping the lake, but SAY so, because
                            # this is the path that produced High Rock's 12,265 acres.
                            largest = unnamed_feats.loc[[unnamed_feats.geometry.area.idxmax()]]
                            area_deg2 = largest.geometry.area.iloc[0]
                            print(f"    Fallback: largest unnamed feature, area={area_deg2:.6f} deg²"
                                  f"  (NO SEED for {slug} — add one to SEEDS)")
                            if area_deg2 >= 0.001:
                                _acre_check(largest, PUBLISHED_ACRES.get(slug), label=f" [{slug}]")
                                all_matches.append(largest)
                            else:
                                print(f"    Largest unnamed feature too small — skipping fallback")
                    else:
                        print(f"    No unnamed features for fallback")
                else:
                    all_matches.append(matches)
            else:
                print(f"    HUC {huc}: no name column — using all bbox features")
                all_matches.append(gdf)

        except Exception as ex:
            print(f"    HUC {huc}: ERROR — {ex}")
            import traceback; traceback.print_exc()

    if not all_matches:
        # NHDWaterbody miss — try NHDArea (large riverine impoundments like Kerr,
        # Falls Lake, Chickamauga are sometimes stored there instead)
        print(f"    NHDWaterbody: no matches — trying NHDArea...")
        for huc in hucs:
            gdb_path = HUC4_GDB.get(huc)
            if not gdb_path or not gdb_path.exists():
                continue
            try:
                probe = gpd.read_file(str(gdb_path), layer='NHDArea', rows=1)
                layer_crs = probe.crs
                bbox_native = _bbox_for_layer(bbox_wgs84, layer_crs)
                gdf = gpd.read_file(str(gdb_path), layer='NHDArea', bbox=bbox_native)
                print(f"    NHDArea HUC {huc}: {len(gdf)} features in bbox")
                if len(gdf) == 0:
                    continue
                if gdf.crs and not gdf.crs.equals(wgs84):
                    gdf = gdf.to_crs('EPSG:4326')
                if 'FType' in gdf.columns:
                    gdf = gdf[gdf['FType'].isin(FTYPES)]
                    print(f"    NHDArea HUC {huc}: {len(gdf)} after FType filter")
                if len(gdf) == 0:
                    continue
                name_col = _find_name_col(gdf)
                if name_col and filters:
                    pattern = '|'.join(re.escape(f) for f in filters)
                    matches = gdf[gdf[name_col].str.contains(pattern, case=False, na=False)]
                    print(f"    NHDArea HUC {huc}: {len(matches)} name matches")
                    if len(matches) == 0:
                        avail = gdf[name_col].dropna().unique()[:10].tolist()
                        print(f"    NHDArea available names: {avail}")
                        unnamed_feats = gdf[gdf[name_col].isna()]
                        if len(unnamed_feats) > 0:
                            largest = unnamed_feats.loc[[unnamed_feats.geometry.area.idxmax()]]
                            area_deg2 = largest.geometry.area.iloc[0]
                            print(f"    NHDArea fallback: largest unnamed, area={area_deg2:.6f} deg²")
                            if area_deg2 >= 0.001:
                                print(f"    NHDArea: using largest unnamed polygon")
                                all_matches.append(largest)
                            else:
                                print(f"    NHDArea: largest unnamed too small")
                    else:
                        all_matches.append(matches)
                elif name_col is None and len(gdf) > 0:
                    all_matches.append(gdf)
            except Exception as ex:
                print(f"    NHDArea HUC {huc}: ERROR — {ex}")

    if not all_matches and slug in CLASSIC_HUCS:
        # Third pass — classic NHD (not Plus HR).
        # Schema differences: lowercase gnis_name, compound 3D CRS (treat as NAD83).
        print(f"    Trying classic NHD...")
        classic_filters = CLASSIC_NAME_FILTERS.get(slug, filters)
        for huc in CLASSIC_HUCS[slug]:
            gdb_path = NHD_CLASSIC_GDB.get(huc)
            if not gdb_path or not gdb_path.exists():
                print(f"    Classic {huc}: GDB not found")
                continue
            try:
                # Classic NHD uses compound 3D CRS — strip to 2D/NAD83 for bbox
                probe = gpd.read_file(str(gdb_path), layer='NHDWaterbody', rows=1)
                # Treat as NAD83 — same as WGS84 for bbox purposes
                bbox_native = bbox_wgs84
                gdf = gpd.read_file(str(gdb_path), layer='NHDWaterbody', bbox=bbox_native)
                print(f"    Classic {huc}: {len(gdf)} features in bbox")
                if len(gdf) == 0:
                    continue
                # Reproject to WGS84 (drops Z axis from compound CRS)
                try:
                    gdf = gdf.to_crs('EPSG:4326')
                except Exception:
                    gdf = gdf.set_crs('EPSG:4326', allow_override=True)
                # Classic NHD FType is numeric int same as Plus HR
                if 'ftype' in gdf.columns:
                    gdf = gdf[gdf['ftype'].isin(FTYPES)]
                    print(f"    Classic {huc}: {len(gdf)} after FType filter")
                if len(gdf) == 0:
                    continue
                # Classic NHD uses lowercase gnis_name
                name_col = next((c for c in ['gnis_name', 'GNIS_Name', 'GNIS_NAME']
                                 if c in gdf.columns), None)
                if name_col and classic_filters:
                    pattern = '|'.join(re.escape(f) for f in classic_filters)
                    matches = gdf[gdf[name_col].str.contains(pattern, case=False, na=False)]
                    print(f"    Classic {huc}: {len(matches)} name matches")
                    if len(matches) == 0:
                        avail = gdf[name_col].dropna().unique()[:10].tolist()
                        print(f"    Classic {huc} available names: {avail}")
                        # Largest unnamed fallback. This is a GUESS -- it takes the biggest
                        # nameless polygon in the bbox and calls it the lake -- so it says so
                        # out loud and reports acres, which is the number that tells you
                        # whether the guess is the right water.
                        #
                        # Area is computed in EPSG:5070 (CONUS Albers equal-area). It used to
                        # be `.area` on a geographic CRS, which is square DEGREES: geopandas
                        # warned on every call, and the 0.001 cutoff was a threshold in units
                        # that change size with latitude. Blewett Falls measured 0.000867 and
                        # was rejected as "too small" -- that is 8.8 km², about 2,180 acres,
                        # a perfectly real lake. The cutoff is now 10 km², which is what
                        # 0.001 deg² came to at these latitudes, so nothing else shifts.
                        unnamed_feats = gdf[gdf[name_col].isna()]
                        if len(unnamed_feats) > 0:
                            eq = unnamed_feats.to_crs('EPSG:5070')
                            areas_km2 = eq.geometry.area / 1e6
                            largest = unnamed_feats.loc[[areas_km2.idxmax()]]
                            km2 = float(areas_km2.max())
                            print(f"    Classic {huc} fallback: largest UNNAMED polygon, "
                                  f"{km2:.2f} km² ({km2 * 247.105381:,.0f} ac) -- this is a "
                                  f"guess, check the acreage against the real lake")
                            if km2 >= 10.0:
                                print(f"    Classic {huc}: using largest unnamed polygon")
                                all_matches.append(largest)
                            else:
                                print(f"    Classic {huc}: below the 10 km² floor, not used")
                    else:
                        all_matches.append(matches)
                elif name_col is None and len(gdf) > 0:
                    all_matches.append(gdf)
            except Exception as ex:
                print(f"    Classic {huc}: ERROR — {ex}")
                import traceback; traceback.print_exc()

    if not all_matches:
        print(f"    No matches found in NHDWaterbody, NHDArea, or classic NHD")
        return False

    combined = pd.concat(all_matches).drop_duplicates()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    combined.to_crs('EPSG:4326').to_file(str(out_path), driver='GeoJSON')
    size_kb = out_path.stat().st_size // 1024
    print(f"    Saved: {out_path.name} ({size_kb} KB, {len(combined)} features)")
    return True


def main():
    ap = argparse.ArgumentParser(description='Extract lake boundaries from NHDPlus HR GDBs')
    # Repeatable. Each invocation opens and reads the HUC4 GDB zips a slug asks for,
    # so sixteen single-lake runs re-read the same GDBs sixteen times. One run with
    # --lake repeated does it once.
    ap.add_argument('--lake', action='append',
                    help='Extract this slug. Repeatable: --lake a --lake b')
    ap.add_argument('--overwrite', action='store_true')
    ap.add_argument('--dump-names', action='store_true')
    ap.add_argument('--list', action='store_true',
                    help='List all slugs, HUC assignments, and output status')
    args = ap.parse_args()

    if args.list:
        print(f"\n{'STATUS':8} {'HUC':12} {'SLUG':45} NAME")
        print('-' * 100)
        for slug, data in LAKE_CATALOG.items():
            nhd  = OUT_DIR / f"{slug}_nhd.geojson"
            dhp  = OUT_DIR / f"{slug}_3dhp.geojson"
            hucs = SLUG_HUCS.get(slug, [])
            avail = [h for h in hucs if HUC4_GDB.get(h, Path('')).exists()]
            missing_gdbs = [h for h in hucs if not HUC4_GDB.get(h, Path('')).exists()]
            if slug in SKIP_SLUGS:
                status = 'SKIP'
            # ASCII. These carried a U+2713 check mark, which has no cp1252 mapping, so the
            # whole --list crashed as soon as the output was piped anywhere.
            elif nhd.exists():
                status = 'NHD'
            elif dhp.exists():
                status = '3DHP'
            elif missing_gdbs:
                status = f'NO_GDB'
            elif not hucs:
                status = 'NO_HUC'
            else:
                status = '--'
            huc_str = ','.join(hucs) if hucs else '—'
            gdb_note = f" (need {','.join(missing_gdbs)})" if missing_gdbs else ''
            print(f"  {status:6} {huc_str:12} {slug:45} {data['name']}{gdb_note}")
        return

    slugs = args.lake if args.lake else [s for s in SLUG_HUCS if s not in SKIP_SLUGS]
    unknown = [s for s in slugs if s not in LAKE_CATALOG]
    if unknown:
        # Without this the slug silently produces 'No matches found' and reads as a
        # data problem rather than a typo.
        for s in unknown:
            print(f'ERROR: {s} is not in lake_catalog.py -- no bbox to search with')
        sys.exit(1)
    print(f"NHD GDB dir: {NHD_DIR}")
    print(f"Output dir:  {OUT_DIR}")
    print(f"Extracting {len(slugs)} slug(s)...\n")

    ok = 0
    for slug in slugs:
        if extract_slug(slug, overwrite=args.overwrite, dump_names=args.dump_names):
            ok += 1
        print()

    print(f"Done: {ok}/{len(slugs)} extracted")


if __name__ == '__main__':
    main()
