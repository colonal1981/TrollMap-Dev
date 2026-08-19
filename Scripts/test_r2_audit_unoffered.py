#!/usr/bin/env python3
"""The index rule in r2_audit.py: off by default, and it cannot fire on a bad read.

Personal use only, not for distribution or resale; not for navigation.

r2_audit.py wrote 0 keys against a bucket holding 1,308 pack prefixes the index does not offer,
because it had no rule about the index at all -- `--registry` only ever named orphans in a
report. This is that rule, and every assertion below is about it REFUSING rather than firing.
"""
import importlib.util, json, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('ra', HERE / 'r2_audit.py')
ra = importlib.util.module_from_spec(spec); spec.loader.exec_module(ra)

# --- deletable(): None and empty must behave identically -------------------------------------
# An index that failed to parse yields an empty set, and an empty set makes every slug in the
# bucket unoffered -- a 12,000-object proposal built out of a read error.
for empty in (None, set()):
    assert ra.deletable('kentucky_lake', 'contours.geojson', empty) is None, \
        'no index means no opinion, not "delete everything": %r' % (empty,)
assert ra.deletable('kentucky_lake', 'contours.geojson', {'falls_lake'}) == 'not-offered'
assert ra.deletable('falls_lake', 'contours.geojson', {'falls_lake'}) is None
print('the rule is silent on an empty or missing index, and fires only on a real one')

# a file kind the script does not recognise stays unjudged even inside an unoffered pack
assert ra.deletable('kentucky_lake', 'index.json', {'falls_lake'}) is None, \
    'an unrecognised object inside an unoffered pack is still not ours to judge'
assert ra.deletable('kentucky_lake', 'vectors/contours.geojson', {'falls_lake'}) is None
print('an unrecognised object is left alone even in a pack nothing offers')

# SKIP_SLUGS still wins, and non-pack prefixes never reach this function at all
assert ra.is_pack('research') is False and ra.is_pack('lake_packages') is False
assert ra.is_pack('kentucky_lake') is True
print('research and lake_packages are not packs, so the rule can never reach them')

# --- read_offered(): both registry shapes, and a refusal on either failure --------------------
tmp = Path(tempfile.mkdtemp())
idx = tmp / 'lake_index.json'
idx.write_text(json.dumps({'falls_lake': {}, 'cooper_river': {}}))
got, why = ra.read_offered(str(idx))
assert got == {'falls_lake', 'cooper_river'} and why is None, (got, why)
idx.write_text(json.dumps({'lakes': [{'slug': 'falls_lake'}, {'slug': 'cooper_river'}]}))
got, why = ra.read_offered(str(idx))
assert got == {'falls_lake', 'cooper_river'} and why is None, (got, why)
idx.write_text('{ not json')
got, why = ra.read_offered(str(idx))
assert got == set() and why and 'could not read' in why, (got, why)
idx.write_text('{}')
got, why = ra.read_offered(str(idx))
assert got == set() and why and 'no slugs' in why, (got, why)
print('both registry shapes parse, and an unreadable or empty one refuses with a reason')

# --- named_in_app(): the app's veto -----------------------------------------------------------
js = tmp / 'js'; (js / 'modules').mkdir(parents=True)
(js / 'modules' / 'contour-data.js').write_text(
    "export const CHAIN = { yadkin_river_chain: 'Yadkin' };\nconst x = 'kerr_lake';\n")
hit, note = ra.named_in_app(str(js), {'kerr_lake', 'yadkin_river_chain', 'kentucky_lake'})
assert hit == {'kerr_lake', 'yadkin_river_chain'}, hit
assert note is None
missing, note2 = ra.named_in_app(str(tmp / 'nope'), {'kerr_lake'})
assert missing == set() and note2 and 'NOT checked' in note2, (missing, note2)
print('a slug the app still names is found, and a missing js tree says it did not check')

# --- the app check matches a whole token, never a substring ------------------------------------
# `lake_hartwell` was held back by `'lake_hartwell_sc_ga': 'lake_hartwell_sc'` in research-ids.js
# -- two identifiers that are not that slug. This repo already carries five bidirectional
# substring matchers on the deletion tab for the same reason: a short name claims any longer one
# containing it.
(js / 'data').mkdir()
(js / 'data' / 'research-ids.js').write_text(
    "export const IDS = { 'lake_hartwell_sc_ga': 'lake_hartwell_sc' };\n"
    "const real = 'falls_lake';\n")
hit2, _ = ra.named_in_app(str(js), {'lake_hartwell', 'falls_lake', 'lake_hartwell_sc'})
assert 'lake_hartwell' not in hit2, \
    'a slug that only appears inside a LONGER identifier is not named by the app: %r' % hit2
assert 'lake_hartwell_sc' in hit2, 'but the longer identifier itself is'
assert 'falls_lake' in hit2, 'and a plain quoted slug still counts'
print('the app check matches whole tokens, so a longer identifier no longer claims a shorter slug')

# --- the SC coastal habitat layers are judged, and that is what protects them ------------------
# Ryan, 2026-08-19: "they need to stay". Being in KNOWN_PACK_FILES is not what deletes them --
# the not-offered rule cannot reach a pack the index serves, and every SC zone holding these is
# served. What it buys is that a zone pruned whole does not leave them orphaned in the bucket.
for _f in ('marsh_edges.geojson', 'oyster_beds.geojson', 'osm-structures.geojson'):
    assert _f in ra.KNOWN_PACK_FILES, '%s must be judgeable or a prune orphans it' % _f
    assert ra.deletable('coast_beaufort_sc', _f, {'coast_beaufort_sc'}) is None, \
        '%s on an OFFERED zone must never be proposed' % _f
    assert ra.deletable('coast_pamlico_sound_nc', _f, {'coast_beaufort_sc'}) == 'not-offered', \
        '%s on a zone the index does not serve is exactly what should go with it' % _f
print('coastal habitat is judged, spared on every offered zone, and cleaned up with a pruned one')

# and the feed caches are not packs at all
for _p in ('attractors', 'ramps', 'bankpier', 'paddle', 'clarity-cache', '_duke', 'garmin'):
    assert ra.is_pack(_p) is False, '%s is a feed cache, not a lake' % _p
print('the DNR feed caches and the stray garmin/ prefix are not packs')
