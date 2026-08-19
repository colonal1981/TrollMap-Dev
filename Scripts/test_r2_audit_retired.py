#!/usr/bin/env python3
"""RETIRED_PACK_FILES in r2_audit.py: dead by name, and it has to outrank the app veto.

Personal use only, not for distribution or resale; not for navigation.

7.7 MB sat in `lake_wateree_fishing_creek` that no rule could reach. Every other rule in
r2_audit.py judges an object by the pack around it, and that pack is a LIVE lake -- still named
in js/, so the app veto puts it straight back into `offered` and `not-offered` never fires. The
objects were unreachable by design, and the unjudged-kinds report was the only thing that said
so. These assertions are about the by-name rule running EARLY enough to matter.
"""
import importlib.util, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('ra', HERE / 'r2_audit.py')
ra = importlib.util.module_from_spec(spec); spec.loader.exec_module(ra)

RETIRED = {'zones.json', 'zones_spines.json'}
assert ra.RETIRED_PACK_FILES == RETIRED, ra.RETIRED_PACK_FILES

# --- the whole point: an OFFERED pack does not protect a retired file ------------------------
for fn in sorted(RETIRED):
    assert ra.deletable('lake_wateree_fishing_creek', fn,
                        {'lake_wateree_fishing_creek'}) == 'retired-layer', \
        '%s must be proposed even when the lake is offered -- the app veto works by adding the ' \
        'slug back to `offered`, so a rule that runs after it can never reach inside' % fn
print('a retired file is proposed on an offered pack, which is what the app veto would block')

# and on an unoffered one it is still called retired, not not-offered: the reason a person reads
# should say the FILE is dead, not that the lake is
for fn in sorted(RETIRED):
    assert ra.deletable('some_orphan_lake', fn, {'falls_lake'}) == 'retired-layer', fn
print('the reason names the file, not the pack, on unoffered packs too')

# --- it must not become a licence to delete live layers --------------------------------------
for fn in ('contours.geojson', 'depth_areas.geojson', 'boundary.geojson',
           'marsh_edges.geojson', 'oyster_beds.geojson', 'osm-structures.geojson'):
    assert ra.deletable('lake_wateree_fishing_creek', fn,
                        {'lake_wateree_fishing_creek'}) is None, \
        '%s is a live layer on an offered pack and must be kept' % fn
print('live layers on the same offered pack are untouched')

# SKIP_SLUGS still outranks it -- a prefix marked do-not-touch is not touched
if ra.SKIP_SLUGS:
    skip = sorted(ra.SKIP_SLUGS)[0]
    assert ra.deletable(skip, 'zones.json', {skip}) == 'skip-slug', \
        'SKIP_SLUGS means do not touch this prefix at all, retired file or not'
    print('SKIP_SLUGS still wins over the by-name rule (checked with %r)' % skip)
else:
    print('SKIP_SLUGS is empty -- nothing to check that ordering against')

# --- a judged file must stop being reported as unjudged ---------------------------------------
# Otherwise the report that FOUND these keeps naming them forever and stops being read.
src = (HERE / 'r2_audit.py').read_text(encoding='utf-8')
assert 'fname not in KNOWN_PACK_FILES and fname not in RETIRED_PACK_FILES' in src, \
    'the unjudged-kinds report must exclude retired files, or it goes on reporting what it fixed'
assert src.index('if fname in RETIRED_PACK_FILES') < src.index('if offered and name not in offered'), \
    'the by-name rule must be tested BEFORE the offered rule'
print('the unjudged report excludes them, and the rule is ordered ahead of the offered check')

print('\nOK')
