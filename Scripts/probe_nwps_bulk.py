#!/usr/bin/env python3
"""
probe_nwps_bulk.py -- one download against 371, and it carries more than the 371 did.

    py .\\scripts\\probe_nwps_bulk.py                     download, compare, report
    py .\\scripts\\probe_nwps_bulk.py --csv <path>        use a copy already on disk
    py .\\scripts\\probe_nwps_bulk.py --self-test         parser only, no network
    py .\\scripts\\probe_nwps_bulk.py --out <path.json>   where the report lands

WHY THIS EXISTS

`build_water_bindings.py` asks NWPS for two things, and `registry\\_bindings_cache` holds
**371** responses between them:

    65   tile sweeps    /nwps/v1/gauges?bbox=...   the roster, tiled at 1.5 degrees
    306  per gauge      /nwps/v1/gauges/{lid}      ONE PER BOUND WATER

**The 306 exist to read a single field.** Line 1536 fetches the whole gauge document for the
first valid lid on every binding and takes `reachId` off it -- the NWM/NHDPlus comid -- and
nothing else. 306 full documents for one integer apiece.

That is 371 requests for one rebind, and it is where the 429s come from. The binder already
carries a `RateLimited` abort that stops the run after three refusals in a row and says to come
back later.

NOAA publishes the entire national roster as ONE FILE:

    https://water.noaa.gov/resources/downloads/reports/nwps_all_gauges_report.csv

44 columns. A tile gauge object has 9 keys. **The binder reads six fields off a tile gauge and
the CSV carries every one of them:**

    tile object                          CSV column
    lid                                  nws shef id
    name                                 location name
    latitude / longitude                 latitude / longitude
    wfo.abbreviation                     wfo          (already an abbreviation)
    rfc.abbreviation                     rfc
    pedts.observed  -> [:2] is HG/HP/HT  pedts        (flat string, same value)

Nothing else in the binder touches an NWPS gauge object. `status` -- the live observed and
forecast readings each tile carries -- is fetched and never read at bind time, and
`pedts.forecast` likewise. Those two are the ONLY things the tiles have that this file does not,
and neither is consumed.

WHAT THE CSV ADDS, none of which the binder can see today:

    usgs id                        the USGS join, stated rather than inferred
    action / flood / moderate / major flood stage, and the unit they are in
    low water threshold value / units      LOW water. For a kayak that outranks flood stage
    nrldb / navd88 / ngvd29 / msl / other vertical datum, and the datum's name
    reach id                       the NWM / NHDPlus COMID -- THE FIELD THE 306 CALLS EXIST FOR
    in service                     a dead gauge currently reads as a gauge with no data
    forecast status                a sentence saying whether this point is forecast at all
    state, county                  the county every water is supposed to be named with
    give data attribution, attribution wording
    probabilistic flags, inundation, fema wms, hydrograph page, timezone

THIS PROBES, IT DOES NOT CHANGE THE BINDER. A REMOVAL IS NOT VERIFIED BY THE WRITER REPORTING
SUCCESS, and cutting a 371-request sweep on the strength of a column list would be exactly that.
So this compares the CSV against everything ALREADY ON DISK -- no NWPS requests at all beyond
the one download -- and reports coverage both ways plus field-by-field agreement.

THE DECISIVE CHECK IS THE REACH IDS, and it is free. The 306 cached per-gauge documents are 306
answers NWPS has already given about `reachId`. If the CSV's `reach id` column agrees with all
306, those 306 requests can go on a measurement rather than on a column name.

SCOPED THE SAME WAY ON BOTH SIDES. The cache is a UNION OF EVERY BOX EVER SWEPT -- `bbox_covering`
snaps the box to the registry in both directions, so tiles from wider historical boxes are still
on disk. Comparing an unscoped tile roster against a box-filtered CSV would report every
historical out-of-box gauge as "missing from the bulk file", which is a false alarm dressed as a
blocker. Both sides are filtered to the same box, and the out-of-box remainder is reported
separately.

TWO TRAPS, BOTH MET IN ANOTHER SERVICE THE SAME DAY.

  **A BLANK IS A SINGLE SPACE.** `"low water threshold value / units"` arrives as `" "` on a
  gauge that has none. `v or None` keeps the space, the space is truthy, and it renders as a
  value.

  **-9999 IS "UNSET", NOT A STAGE.** A real row carries `action stage` -9999 beside a flood
  stage of 13. Read as a number that is a river 9,999 feet below its action level.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import glob
import os
import re
import sys
import urllib.request

BULK_URL = 'https://water.noaa.gov/resources/downloads/reports/nwps_all_gauges_report.csv'
UA = 'trollmap-probe/1.0 (+personal use; https://github.com/colonal1981/TrollMap-Dev)'

# The six the binder actually reads, and where each lives in the CSV.
CONSUMED = (
    ('lid',       'nws shef id'),
    ('name',      'location name'),
    ('latitude',  'latitude'),
    ('longitude', 'longitude'),
    ('wfo',       'wfo'),
    ('rfc',       'rfc'),
    ('pedts',     'pedts'),
)

# Everything the tiles cannot answer. Named explicitly so the report says what was gained,
# rather than leaving a reader to diff two column sets by eye.
GAINED = (
    'usgs id', 'action stage', 'flood stage', 'moderate flood stage', 'major flood stage',
    'flood stage unit', 'low water threshold value / units', 'nrldb vertical datum name',
    'nrldb vertical datum', 'navd88 vertical datum', 'ngvd29 vertical datum',
    'msl vertical datum', 'other vertical datum', 'reach id', 'in service', 'forecast status',
    'state', 'county', 'timezone', 'give data attribution', 'attribution wording',
    'hydrograph page', 'inundation', 'fema wms', 'probabilistic site',
)


def text(v):
    """A blank NWPS field is a single space, not empty and not null."""
    s = '' if v is None else str(v).strip()
    return s or None


def number(v):
    """A float, or None. -9999 is this file's way of saying a threshold is not set."""
    s = text(v)
    if s is None:
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return None if f <= -9990 else f


def boolean(v):
    """The file spells booleans two ways -- bare `false` and quoted `"TRUE"`. Both, or None."""
    s = text(v)
    if s is None:
        return None
    low = s.lower()
    if low in ('true', 't', 'yes', '1'):
        return True
    if low in ('false', 'f', 'no', '0'):
        return False
    return None


def parse_bulk(handle):
    """CSV text -> ({lid: row-dict}, header, duplicate-count).

    Keyed by the SHEF id because that is what the binder keys by and what the tiles key by, so
    the two sides of the comparison line up without a join.
    """
    rdr = csv.DictReader(handle)
    header = list(rdr.fieldnames or [])
    out = {}
    dupes = 0
    for row in rdr:
        lid = text(row.get('nws shef id'))
        if not lid:
            continue
        if lid in out:
            dupes += 1
        out[lid] = row
    return out, header, dupes


# `nwps_*.json` ALSO MATCHES `nwps_gauge_<LID>.json`, of which there are 306. A glob wide enough
# to catch both counts per-gauge documents as tiles and reports a sweep three times the size it
# is. Tile tags are four signed decimals and nothing else.
TILE_TAG = re.compile(r'^nwps_-?[0-9.]+_-?[0-9.]+_-?[0-9.]+_-?[0-9.]+\.json$')
GAUGE_TAG = re.compile(r'^nwps_gauge_([A-Z0-9]+)\.json$')


def load_tiles(cache_dir):
    """Every gauge the cached tile sweep holds, deduped by lid -- the same reduction the binder
    performs at `src['nwps'] = gauges`."""
    gauges, tiles = {}, 0
    for p in sorted(glob.glob(os.path.join(cache_dir, 'nwps_*.json'))):
        if not TILE_TAG.match(os.path.basename(p)):
            continue
        try:
            with io.open(p, encoding='utf-8') as fh:
                d = json.load(fh)
        except Exception:
            continue
        tiles += 1
        for g in (d or {}).get('gauges') or []:
            lid = g.get('lid')
            if lid:
                gauges[lid] = g
    return gauges, tiles


def load_gauge_docs(cache_dir):
    """The 306 per-gauge documents the binder already paid for -> {lid: reachId-as-text}.

    `reachId` empty is a real answer, not a failure: a dam tailwater is not an NWM reach and
    NRTT1 returns "". The binder counts those as `reach_empty`. Empty is kept as '' so the
    comparison can tell "agreed there is none" from "one side did not know".
    """
    out = {}
    for p in sorted(glob.glob(os.path.join(cache_dir, 'nwps_gauge_*.json'))):
        m = GAUGE_TAG.match(os.path.basename(p))
        if not m:
            continue
        try:
            with io.open(p, encoding='utf-8') as fh:
                d = json.load(fh)
        except Exception:
            continue
        out[m.group(1)] = str(((d or {}).get('reachId') or '')).strip()
    return out


def compare_reaches(docs, bulk):
    """The 306 answers NWPS has already given, against the one column that would replace them."""
    agree = missing = 0
    disagree, only_doc = [], []
    for lid, rid in sorted(docs.items()):
        row = bulk.get(lid)
        if row is None:
            only_doc.append(lid)
            continue
        csv_rid = text(row.get('reach id')) or ''
        if csv_rid == rid:
            agree += 1
        elif not csv_rid and not rid:
            agree += 1
        elif not csv_rid:
            missing += 1
            disagree.append({'lid': lid, 'per_gauge': rid, 'bulk': None})
        else:
            disagree.append({'lid': lid, 'per_gauge': rid or None, 'bulk': csv_rid})
    return {
        'per_gauge_docs': len(docs),
        'agree': agree,
        'bulk_blank_where_doc_had_one': missing,
        'disagree': disagree,
        'lids_not_in_bulk': only_doc,
    }


def in_box(lat, lon, box):
    w, s, e, n = box
    return (lat is not None and lon is not None
            and s <= lat <= n and w <= lon <= e)


def compare(tiles, bulk, box):
    """Field by field, over the lids the two sides share, inside the registry's own box."""
    bulk_in_box = {}
    for lid, r in bulk.items():
        lat, lon = number(r.get('latitude')), number(r.get('longitude'))
        if in_box(lat, lon, box):
            bulk_in_box[lid] = r

    # BOTH SIDES, SAME BOX. The cache is a union of every box ever swept; the CSV is national
    # and filtered. Scoping only one of them manufactures a difference that is not one.
    tiles_in_box = {lid: g for lid, g in tiles.items()
                    if in_box(g.get('latitude'), g.get('longitude'), box)}
    tiles_outside = sorted(set(tiles) - set(tiles_in_box))

    only_tiles = sorted(set(tiles_in_box) - set(bulk_in_box))
    only_bulk = sorted(set(bulk_in_box) - set(tiles_in_box))
    shared = sorted(set(tiles_in_box) & set(bulk_in_box))

    # A tile gauge outside the current box that the CSV also lacks is worth knowing about, but
    # it is not a reason to keep the sweep -- the sweep would not fetch it either any more.
    outside_and_absent = sorted(lid for lid in tiles_outside if lid not in bulk)

    disagree = {k: [] for k, _ in CONSUMED}
    for lid in shared:
        g, r = tiles[lid], bulk_in_box[lid]
        pairs = (
            ('lid',       lid, text(r.get('nws shef id'))),
            ('name',      text(g.get('name')), text(r.get('location name'))),
            ('latitude',  number(g.get('latitude')), number(r.get('latitude'))),
            ('longitude', number(g.get('longitude')), number(r.get('longitude'))),
            ('wfo',       text((g.get('wfo') or {}).get('abbreviation')), text(r.get('wfo'))),
            ('rfc',       text((g.get('rfc') or {}).get('abbreviation')), text(r.get('rfc'))),
            # Only the first two characters are ever read, and only those are compared -- the
            # binder's question is HG vs HP vs HT and nothing finer.
            ('pedts',     (text((g.get('pedts') or {}).get('observed')) or '')[:2].upper() or None,
                          (text(r.get('pedts')) or '')[:2].upper() or None),
        )
        for field, a, b in pairs:
            if field in ('latitude', 'longitude'):
                # The same instrument reported to different precision. A metre is not a
                # disagreement; a kilometre is.
                same = (a is not None and b is not None and abs(a - b) < 1e-4)
            else:
                same = (a == b)
            if not same:
                disagree[field].append({'lid': lid, 'tiles': a, 'bulk': b})

    gained = {}
    for col in GAINED:
        gained[col] = sum(1 for lid in shared
                          if text(bulk_in_box[lid].get(col)) is not None)

    return {
        'box': list(box),
        'tiles_gauges': len(tiles),
        'tiles_gauges_in_box': len(tiles_in_box),
        'tiles_gauges_outside_box': len(tiles_outside),
        'outside_box_and_absent_from_bulk': outside_and_absent,
        'bulk_gauges_national': len(bulk),
        'bulk_gauges_in_box': len(bulk_in_box),
        'shared': len(shared),
        'only_in_tiles': only_tiles,
        'only_in_bulk_count': len(only_bulk),
        'only_in_bulk_sample': only_bulk[:25],
        'disagreements': {k: v for k, v in disagree.items() if v},
        'disagreement_counts': {k: len(v) for k, v in disagree.items()},
        'gained_field_coverage': gained,
    }


# -- self-test ---------------------------------------------------------------------------------
#
# FIXTURES ARE REAL. The header and the first two data rows are transcribed verbatim from the
# live file on 2026-08-25 -- sentinels, single-space blanks and both boolean spellings included.
SELF_HEADER = (
    '"location name","proximity","river/water-body name","nws shef id","location type",'
    '"usgs id","latitude","longitude","wfo","rfc","state","county","wrr","timezone",'
    '"inundation","elevation","action stage","flood stage","moderate flood stage",'
    '"major flood stage","flood stage unit","coeid","hydrograph page","pedts","in service",'
    '"hemisphere","low water threshold value / units","forecast status",'
    '"display low water impacts","low flow display","give data attribution",'
    '"attribution wording","fema wms","probabilistic site",'
    '"weekly chance probabilistic enabled","short-term probabilistic enabled",'
    '"chance of exceeding probabilistic enabled","nrldb vertical datum name",'
    '"nrldb vertical datum","navd88 vertical datum","ngvd29 vertical datum",'
    '"msl vertical datum","other vertical datum","reach id"'
)
SELF_ROWS = [
    '"Cheyenne River above Angostura at Hwy 71","","","AACS2","","",43.30577,-103.562797,'
    '"UNR","MBRFC","SD","Fall River","","MST7MDT",false,,3206,3207,3209,3211,"ft","",'
    '"https://water.noaa.gov/gauges/AACS2","HGIRG",true,""," ",'
    '"Forecasts are not available. Only observed stages are available for this point.",'
    '"TRUE","FALSE","TRUE","South Dakota Department of Agriculture and Natural Resources","",'
    '"FALSE","FALSE","FALSE","FALSE","NAVD88",0,"","","","","9555409"',
    '"Williamson Creek at Manchaca Road at Austin","","","AAIT2","","08158930",'
    '30.221111111111,-97.793333333333,"EWX","WGRFC","TX","Travis","","CST6CDT",false,,-9999,'
    '13,14,18,"ft","","https://water.noaa.gov/gauges/AAIT2","HGIRG",true,""," ",'
    '"Graphical forecasts are not available during times of high water, forecast crest '
    'information can be found in the local WFO web page.","FALSE","FALSE","TRUE",'
    '"US Geological Survey","","FALSE","FALSE","FALSE","FALSE",,,"","","","","5781731"',
]


def self_test():
    ok = fail = 0

    def check(name, cond, detail=''):
        nonlocal ok, fail
        if cond:
            ok += 1
            print('  ok    %s%s' % (name, ('  ' + detail) if detail else ''))
        else:
            fail += 1
            print('  FAIL  %s  %s' % (name, detail))

    print('\nprobe_nwps_bulk --self-test -- the parser against two real rows\n')
    rows, header, dupes = parse_bulk(io.StringIO('\n'.join([SELF_HEADER] + SELF_ROWS) + '\n'))

    check('44 columns', len(header) == 44, '%d' % len(header))
    check('both rows keyed by SHEF id', sorted(rows) == ['AACS2', 'AAIT2'], str(sorted(rows)))
    check('no duplicate lids', dupes == 0)

    a, b = rows['AACS2'], rows['AAIT2']

    check('the six the binder reads are all present columns',
          all(c in header for _, c in CONSUMED))
    check('pedts is a flat string whose first two chars are the element',
          (text(a.get('pedts')) or '')[:2].upper() == 'HG', repr(a.get('pedts')))
    check('wfo is already an abbreviation', text(a.get('wfo')) == 'UNR')
    check('rfc is already an abbreviation', text(a.get('rfc')) == 'MBRFC')
    check('coordinates parse', number(a.get('latitude')) == 43.30577
          and number(a.get('longitude')) == -103.562797)

    # THE TWO TRAPS.
    check('-9999 action stage reads as UNSET, not as a stage',
          number(b.get('action stage')) is None, repr(b.get('action stage')))
    check('a set stage still reads', number(b.get('flood stage')) == 13.0)
    check('a single-space blank is None, not " "',
          text(b.get('low water threshold value / units')) is None,
          repr(b.get('low water threshold value / units')))
    check('the raw value really is a space, which is why `or None` was not enough',
          b.get('low water threshold value / units') == ' ')

    # Booleans, spelled two ways, in one file.
    check('bare lowercase false parses', boolean(a.get('inundation')) is False)
    check('bare lowercase true parses', boolean(a.get('in service')) is True)
    check('quoted TRUE parses', boolean(a.get('display low water impacts')) is True)
    check('quoted FALSE parses', boolean(a.get('low flow display')) is False)
    check('an unrecognised boolean is None, not False', boolean('maybe') is None)

    # The fields that are the reason for doing any of this.
    check('usgs id present when the gauge has one', text(b.get('usgs id')) == '08158930')
    check('usgs id absent reads None, not ""', text(a.get('usgs id')) is None)
    check('reach id is the NWM comid', text(a.get('reach id')) == '9555409')
    check('vertical datum name carried', text(a.get('nrldb vertical datum name')) == 'NAVD88')
    check('a zero datum is kept, not swallowed', number(a.get('nrldb vertical datum')) == 0.0)
    check('county carried', text(b.get('county')) == 'Travis')
    # TWO ADJACENT COLUMNS WITH ALMOST THE SAME NAME, AND ONLY ONE OF THEM IS THE TEXT.
    # `give data attribution` is a "TRUE"/"FALSE" flag; the agency name is in the NEXT column.
    # Reading the flag as the credit line prints "TRUE" under a gauge.
    check('give data attribution is a FLAG, not the credit line',
          boolean(b.get('give data attribution')) is True
          and text(b.get('give data attribution')) == 'TRUE')
    check('attribution wording is the credit line',
          text(b.get('attribution wording')) == 'US Geological Survey')
    check('and the same pair on the other row',
          boolean(a.get('give data attribution')) is True
          and text(a.get('attribution wording'))
              == 'South Dakota Department of Agriculture and Natural Resources')
    check('forecast status is a sentence, not a flag',
          (text(a.get('forecast status')) or '').startswith('Forecasts are not available'))
    check('a comma inside a quoted sentence does not split the row',
          ', forecast crest information' in (text(b.get('forecast status')) or ''))

    # The box filter.
    check('in_box rejects South Dakota against the registry floor',
          not in_box(43.30577, -103.562797, (-90.6, 30.2, -75.2, 36.9)))
    check('in_box accepts a Carolina coordinate',
          in_box(34.5, -82.9, (-90.6, 30.2, -75.2, 36.9)))

    # The comparison itself, against a synthetic tile that agrees and then one that does not.
    tiles = {
        'AAIT2': {'lid': 'AAIT2', 'name': 'Williamson Creek at Manchaca Road at Austin',
                  'latitude': 30.221111111111, 'longitude': -97.793333333333,
                  'wfo': {'abbreviation': 'EWX'}, 'rfc': {'abbreviation': 'WGRFC'},
                  'pedts': {'observed': 'HGIRG', 'forecast': 'HGIFF'}},
    }
    res = compare(tiles, rows, (-180.0, -90.0, 180.0, 90.0))
    check('an agreeing gauge produces no disagreement',
          all(n == 0 for n in res['disagreement_counts'].values()),
          json.dumps(res['disagreement_counts']))
    check('the two rosters join on lid', res['shared'] == 1)
    check('a gauge only the bulk file has is reported', res['only_in_bulk_count'] == 1)

    tiles['AAIT2'] = dict(tiles['AAIT2'], name='Something Else Entirely',
                          pedts={'observed': 'HPIRG'})
    res2 = compare(tiles, rows, (-180.0, -90.0, 180.0, 90.0))
    check('a name disagreement is caught', res2['disagreement_counts']['name'] == 1)
    check('a pool/stage element disagreement is caught',
          res2['disagreement_counts']['pedts'] == 1)

    # A LINT THAT CANNOT FAIL IS NOT A LINT: prove the coverage half fires too.
    res3 = compare({'ZZZZ9': {'lid': 'ZZZZ9', 'name': 'Nowhere', 'latitude': 34.0,
                              'longitude': -81.0}}, rows, (-180.0, -90.0, 180.0, 90.0))
    check('a tile gauge missing from the bulk file is reported',
          res3['only_in_tiles'] == ['ZZZZ9'], str(res3['only_in_tiles']))

    # THE CACHE TAGS. `nwps_*` catches both, and only one of them is a tile.
    check('a tile tag is four signed decimals',
          bool(TILE_TAG.match('nwps_-75.6_30.2_-75.2_31.7.json')))
    check('a per-gauge cache is NOT a tile',
          not TILE_TAG.match('nwps_gauge_YNHG1.json'))
    check('a per-gauge cache yields its lid',
          GAUGE_TAG.match('nwps_gauge_YNHG1.json').group(1) == 'YNHG1')

    # SCOPING. A tile gauge outside the box must not be reported as missing from the bulk file:
    # the sweep would not fetch it under the current box either.
    carolina_box = (-90.6, 30.2, -75.2, 36.9)
    far = {'FARR1': {'lid': 'FARR1', 'name': 'Somewhere In Montana',
                     'latitude': 47.0, 'longitude': -110.0}}
    res4 = compare(far, rows, carolina_box)
    check('an out-of-box tile gauge is not counted as a bulk gap',
          res4['only_in_tiles'] == [] and res4['tiles_gauges_outside_box'] == 1,
          '%s outside=%d' % (res4['only_in_tiles'], res4['tiles_gauges_outside_box']))
    check('but it is still reported separately',
          res4['outside_box_and_absent_from_bulk'] == ['FARR1'])

    # THE DECISIVE CHECK: the 306 answers already on disk against the one column.
    r = compare_reaches({'AACS2': '9555409', 'AAIT2': '5781731'}, rows)
    check('reach ids that match are counted as agreement', r['agree'] == 2 and not r['disagree'])
    r = compare_reaches({'AACS2': '9999999'}, rows)
    check('a reach id disagreement is caught',
          len(r['disagree']) == 1 and r['disagree'][0]['bulk'] == '9555409')
    r = compare_reaches({'NRTT1': ''}, {'NRTT1': {'reach id': ''}})
    check('empty on both sides is agreement, not a hole', r['agree'] == 1)
    r = compare_reaches({'NRTT1': '123'}, {'NRTT1': {'reach id': ' '}})
    check('a single-space reach id counts as blank, and as a LOSS',
          r['bulk_blank_where_doc_had_one'] == 1)
    r = compare_reaches({'NOPE1': '123'}, rows)
    check('a lid the bulk file does not carry is reported, not silently agreed',
          r['lids_not_in_bulk'] == ['NOPE1'] and r['agree'] == 0)

    print('\n  %d ok, %d failed\n' % (ok, fail))
    return 1 if fail else 0


def main():
    ap = argparse.ArgumentParser(description='compare the NWPS bulk gauge report against the '
                                             'cached tile sweep',
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--csv', default=None, help='an already-downloaded copy; otherwise fetched')
    ap.add_argument('--registry', default=None, help='default <cwd>\\registry')
    ap.add_argument('--cache', default=None, help='default <registry>\\_bindings_cache')
    ap.add_argument('--out', default=None, help='default <registry>\\_nwps_bulk_probe.json')
    ap.add_argument('--self-test', action='store_true', help='parser only, no network')
    a = ap.parse_args()

    if a.self_test:
        return self_test()

    reg = a.registry or os.path.join(os.getcwd(), 'registry')
    cache = a.cache or os.path.join(reg, '_bindings_cache')
    out = a.out or os.path.join(reg, '_nwps_bulk_probe.json')

    if not os.path.isdir(cache):
        print('no bindings cache at %s -- nothing to compare against.' % cache)
        print('Run build_water_bindings.py --stage fetch first, or pass --cache.')
        return 2

    # THE BOX IS THE REGISTRY'S OWN, not a hand-typed one. Imported rather than restated so the
    # two scripts can never disagree about how far to look.
    box = (-90.6, 30.2, -75.2, 36.9)
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from build_water_bindings import bbox_covering, BBOX_FLOOR
        with io.open(os.path.join(reg, 'lake_index.json'), encoding='utf-8') as fh:
            box = bbox_covering(json.load(fh), BBOX_FLOOR)
    except Exception as e:
        print('  !! could not size the box from the registry (%s) -- using the floor' % e)

    if a.csv:
        with io.open(a.csv, encoding='utf-8-sig', newline='') as fh:
            bulk, header, dupes = parse_bulk(fh)
        note = 'from %s' % a.csv
    else:
        print('downloading %s' % BULK_URL)
        req = urllib.request.Request(BULK_URL, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=180) as r:
            raw = r.read().decode('utf-8-sig', 'replace')
        bulk, header, dupes = parse_bulk(io.StringIO(raw))
        note = '%d bytes, one request' % len(raw)

    tiles, ntiles = load_tiles(cache)
    docs = load_gauge_docs(cache)
    res = compare(tiles, bulk, box)
    res['reaches'] = compare_reaches(docs, bulk)
    res['source'] = note
    res['csv_columns'] = header
    res['duplicate_lids_in_csv'] = dupes
    res['cached_tiles'] = ntiles

    print('')
    print('  box            W %.3f  S %.3f  E %.3f  N %.3f' % tuple(box))
    print('  cached         %d tile sweeps + %d per-gauge documents = %d NWPS requests'
          % (ntiles, res['reaches']['per_gauge_docs'], ntiles + res['reaches']['per_gauge_docs']))
    print('  tile gauges    %d deduped, %d inside the box, %d from wider historical boxes'
          % (res['tiles_gauges'], res['tiles_gauges_in_box'], res['tiles_gauges_outside_box']))
    print('  bulk file      %d gauges nationally, %d inside the box, 1 request'
          % (res['bulk_gauges_national'], res['bulk_gauges_in_box']))
    print('  shared         %d' % res['shared'])
    print('')
    if res['only_in_tiles']:
        print('  !! %d gauge(s) the tiles have and the bulk file does NOT. The sweep cannot be'
              % len(res['only_in_tiles']))
        print('     cut until every one of them is explained:')
        for lid in res['only_in_tiles'][:40]:
            g = tiles[lid]
            print('       %-8s %s' % (lid, (g.get('name') or '')[:60]))
        if len(res['only_in_tiles']) > 40:
            print('       ... and %d more' % (len(res['only_in_tiles']) - 40))
    else:
        print('  ok  every gauge the %d tiles found is in the one file.' % ntiles)
    print('  %d gauge(s) only the bulk file has%s'
          % (res['only_in_bulk_count'],
             (' -- e.g. ' + ', '.join(res['only_in_bulk_sample'][:8]))
             if res['only_in_bulk_sample'] else ''))
    print('')
    print('  the six fields the binder reads:')
    for field, _ in CONSUMED:
        n = res['disagreement_counts'].get(field, 0)
        print('    %-10s %s' % (field, 'agree' if not n else '%d DISAGREE' % n))
        for d in res['disagreements'].get(field, [])[:5]:
            print('        %-8s tiles=%r  bulk=%r' % (d['lid'], d['tiles'], d['bulk']))
    rr = res['reaches']
    print('')
    print('  THE 306: reachId, the only field those per-gauge documents were fetched for')
    print('    %d cached documents, %d agree with the bulk file\'s `reach id`'
          % (rr['per_gauge_docs'], rr['agree']))
    if rr['bulk_blank_where_doc_had_one']:
        print('    !! %d where the document had a comid and the bulk file is blank -- a LOSS'
              % rr['bulk_blank_where_doc_had_one'])
    if rr['disagree']:
        print('    !! %d disagree:' % len(rr['disagree']))
        for d in rr['disagree'][:20]:
            print('       %-8s per-gauge=%r  bulk=%r' % (d['lid'], d['per_gauge'], d['bulk']))
    if rr['lids_not_in_bulk']:
        print('    !! %d bound lid(s) the bulk file does not carry: %s'
              % (len(rr['lids_not_in_bulk']), ', '.join(rr['lids_not_in_bulk'][:12])))
    if not rr['disagree'] and not rr['lids_not_in_bulk'] and rr['per_gauge_docs']:
        print('    ok  every one of them. Those %d requests can go.' % rr['per_gauge_docs'])
    print('')
    print('  what the tiles cannot answer, and how many shared gauges carry it:')
    for col, n in sorted(res['gained_field_coverage'].items(), key=lambda kv: -kv[1]):
        pct = (100.0 * n / res['shared']) if res['shared'] else 0.0
        print('    %-38s %5d  %5.1f%%' % (col, n, pct))
    print('')
    print('  NOT IN THE BULK FILE, and neither is read at bind time: `status` (the live observed')
    print('  and forecast readings) and `pedts.forecast`.')

    with io.open(out, 'w', encoding='utf-8') as fh:
        json.dump(res, fh, indent=1)
    print('\n  wrote %s\n' % out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
