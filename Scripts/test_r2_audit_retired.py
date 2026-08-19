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

RETIRED = {'zones.json', 'zones_spines.json', 'chartpack.json'}
assert ra.RETIRED_PACK_FILES == RETIRED, ra.RETIRED_PACK_FILES

# --- the whole point: an OFFERED pack does not protect a retired file ------------------------
# lake_marion is the same shape for chartpack.json: an offered pack holding a dead manifest.
for fn in sorted(RETIRED):
    for slug in ('lake_wateree_fishing_creek', 'lake_marion'):
        assert ra.deletable(slug, fn, {slug}) == 'retired-layer', (slug, fn)
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
# THE REPORT MUST NAME EVERY DESTINATION IT HAS. It offered two while three existed, which is
# how a kind with a third answer available goes on being re-asked in prose instead of recorded.
for dest in ('KNOWN_PACK_FILES', 'NON_PACK_PREFIXES', 'RETIRED_PACK_FILES'):
    assert src.count('print("     %s' % dest) == 1, \
        'the unjudged report must route to %s -- a category the report does not name is a ' \
        'category nobody puts an answer in' % dest
assert src.index('if fname in RETIRED_PACK_FILES') < src.index('if offered and name not in offered'), \
    'the by-name rule must be tested BEFORE the offered rule'
print('the unjudged report excludes them, and the rule is ordered ahead of the offered check')


# --- THE BACKUP HALF OF THE RULE -------------------------------------------------------------
# Ryan, 2026-08-19: "if it belongs to water that is in the app or it doesn't have a copy on my
# drive it can stay in r2... if the water is no longer offered in the app and we have a backup
# for it then it can be removed from r2... the end".
BACKED = {'orphan_lake/contours.geojson'}

# not offered AND backed up -> goes
assert ra.deletable('orphan_lake', 'contours.geojson', {'falls_lake'}, BACKED) == 'not-offered'
# not offered and NOT backed up -> stays. Unoffered is only half a reason: no upload can put
# back a file that is not on the drive, so this is the only copy of something, not spare weight.
assert ra.deletable('orphan_lake', 'depth_areas.geojson', {'falls_lake'}, BACKED) is None, \
    'an object with no local copy must never be proposed, however unoffered its water is'
# offered and backed up -> stays, because the app serves it
assert ra.deletable('falls_lake', 'contours.geojson', {'falls_lake'}, BACKED) is None
print('unoffered alone does not delete -- it takes unoffered AND a local copy')

# None must mean "not checked", not "nothing is backed up". An empty index is a read failure and
# would otherwise propose the entire bucket -- the same trap `offered` carries two lines above.
assert ra.deletable('orphan_lake', 'depth_areas.geojson', {'falls_lake'}, None) == 'not-offered', \
    'no drive index means no backup opinion, not "delete everything"'
assert ra.deletable('orphan_lake', 'depth_areas.geojson', {'falls_lake'}, set()) is None, \
    'an EMPTY drive index means nothing is backed up, so nothing may be proposed'
print('a missing drive index is silent; an empty one refuses everything')

# the named-garbage list is the one exception and it is deliberate -- chartpack.json has no local
# copy anywhere. Pinned so that if the exception is ever removed, this line says why it existed.
assert ra.deletable('lake_marion', 'chartpack.json', {'lake_marion'}, set()) == 'retired-layer', \
    'RETIRED_PACK_FILES is condemned by name and outranks the backup gate on purpose'
print('the by-name list still outranks the backup gate, which is the documented exception')

# research profiles are not packs, so no rule here can reach them at all. Ryan: "all research
# profiles for all waters should stay because there is no local backup".
for pfx in ('research', 'lakes', 'lake_packages'):
    assert ra.is_pack(pfx) is False, pfx
print('research, lakes and lake_packages are not packs -- unreachable by every rule above')

# --- REGENERABLE COUNTS AS BACKED UP ----------------------------------------------------------
# "On the drive" is not "on the drive as this exact file". Ryan set that test on 2026-08-13 for
# osm-structures and r2_vs_local has carried the table since; the gate ignored it and held back
# 59 osm-structures plus every marsh and oyster bed, against a ruling that already existed.
from r2_vs_local import REGENERABLE
for fn in ('osm-structures.geojson', 'marsh_edges.geojson', 'oyster_beds.geojson'):
    assert fn in REGENERABLE, '%s regenerates from inputs on the drive' % fn
    assert ra.deletable('orphan_lake', fn, {'falls_lake'}, set()) == 'not-offered', \
        '%s has no local FILE and does not need one -- its input is on the drive' % fn
print('a regenerable layer is not held back for having no file of its own')

# and it is still gated on the app: regenerable does not override "the app offers this water"
for fn in ('osm-structures.geojson', 'marsh_edges.geojson', 'oyster_beds.geojson'):
    assert ra.deletable('falls_lake', fn, {'falls_lake'}, set()) is None, fn
print('regenerable still loses to the app -- offered water keeps every layer')

# a NON-regenerable layer with no local copy is still held back. This is the half of the gate
# that matters, and it must not be widened by the exemption above.
assert ra.deletable('orphan_lake', 'depth_areas.geojson', {'falls_lake'}, set()) is None, \
    'a layer with neither a local copy nor a way to rebuild is the only copy of something'
print('a layer with no copy and no way back is still held')

print('\nOK')
