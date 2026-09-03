"""consolidate_lake_index.py -- a coastal zone the catalog dropped must leave the index.

Personal use only, not for distribution or resale; not for navigation.

WHY
    Scripts/coastal_catalog.py is the only place a coastal zone exists. It drives the R2
    pipeline and it GENERATES js/data/coastal-zones.js, which is where the app reads a zone's
    tide station, bbox and ramps.

    a4bfd02 cut the three NC coastal zones out of the app on 2026-09-01 -- coastal-zones.js,
    lake-keys.js and NC's block in coastal-regulations.js all lost them -- and lake_index.json
    went on carrying all sixteen `coast_` rows. lake-ramp-select.js builds its picker from the
    index FIRST and only then folds in COASTAL_ZONES, so for two days the app offered
    "Cape Fear River / Wilmington, NC (New Hanover Co, NC)" under NC -- Coast with no tide
    station, no bbox, no ramps and no regulation table behind it. That is the failure
    coastal-regulations.test.js exists to prevent, arriving by the one path it does not walk:
    it iterates COASTAL_SLUGS, and those three had already left it.

    The scope gate could not catch this. All three are INSIDE the polygon Ryan drew --
    coast_brunswick_nc 119/119 boundary vertices, coast_cape_fear_nc 618/658,
    coast_topsail_new_river_nc 20/150, measured against registry/region_mask.json. Geometry
    was never going to remove them; the catalog is.

    py test_consolidate_coastal_gate.py
"""
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cli', HERE / 'consolidate_lake_index.py')
cli = importlib.util.module_from_spec(spec)
sys.modules['cli'] = cli
spec.loader.exec_module(cli)

# The thirteen the catalog declares, and the three it does not.
DECLARED = {'coast_charleston_sc', 'coast_savannah_ga', 'coast_winyah_bay_sc'}
CUT = ('coast_cape_fear_nc', 'coast_brunswick_nc', 'coast_topsail_new_river_nc')


def idx_of(*slugs):
    return {s: {'name': s.replace('_', ' ').title(), 'state': 'SC'} for s in slugs}


# --- the real case: the three NC zones leave, the declared ones stay -------------------------
idx = idx_of(*DECLARED, *CUT, 'lake_marion', 'cooper_river')
removed = cli.drop_undeclared_coastal(idx, zones=DECLARED)
assert {r['slug'] for r in removed} == set(CUT), removed
assert set(idx) == DECLARED | {'lake_marion', 'cooper_river'}, idx
assert all(r['why'] for r in removed), 'a removal that cannot say why is not reviewable'
print('the three NC zones leave the index; the thirteen declared ones stay:', len(removed))

# --- idempotent -----------------------------------------------------------------------------
assert cli.drop_undeclared_coastal(idx, zones=DECLARED) == []
print('idempotent: a second pass removes nothing')

# --- FRESHWATER IS NOT TOUCHED, whatever it is called ----------------------------------------
# The gate reads the slug prefix, not feature_type. A tidal river the classifier labelled
# 'coastal' has its own 3DHP row and no zone behind it, so gating on the type would take it.
tidal = {'cooper_river': {'name': 'Cooper River, SC', 'feature_type': 'coastal'},
         'ashley_river': {'name': 'Ashley River, SC', 'feature_type': 'coastal'}}
before = dict(tidal)
assert cli.drop_undeclared_coastal(tidal, zones=DECLARED) == []
assert tidal == before, tidal
print("a river classified 'coastal' is a tidal river, not a zone -- kept")

# --- the loader reads the real catalog, and it is not empty -----------------------------------
# An empty set would drop every coastal row in the index and read as a data problem rather than
# a broken catalog, which is why _declared_coastal_zones() raises instead of returning one.
zones = cli._declared_coastal_zones()
assert len(zones) >= 13, zones
assert all(z.startswith('coast_') for z in zones), zones
assert not (set(CUT) & zones), 'the catalog still declares a zone that was cut: %s' % (
    sorted(set(CUT) & zones))
print('the live catalog declares %d zones and none of them is NC' % len(zones))

# --- and the gate run against the LIVE catalog removes exactly the cut zones -------------------
idx2 = idx_of(*sorted(zones), *CUT)
removed2 = cli.drop_undeclared_coastal(idx2)
assert {r['slug'] for r in removed2} == set(CUT), removed2
assert set(idx2) == zones, sorted(set(idx2) ^ zones)
print('against the real coastal_catalog.py the gate removes the three and keeps every zone')

print('\nOK')
