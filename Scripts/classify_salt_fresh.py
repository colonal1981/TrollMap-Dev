#!/usr/bin/env python3
r"""classify_salt_fresh.py - is a boat ramp in saltwater or freshwater, per SC Code 50-5-80?

Personal use only, not for distribution or resale; not for navigation.

    py .\classify_salt_fresh.py `
       --line  "F:\TrollMapPipeline\Saltwater_Freshwater_Dividing_Line.geojson" `
       --feeds "F:\TrollMapPipeline\registry" `
       --self-test

WHY THIS IS ITS OWN SCRIPT

It answers one question and it can be wrong in a way nothing downstream would notice: a ramp
classified fresh when it is salt means the river cutter carves a boundary through tidal water
that should have been a pointer to a coastal zone, and the output is a well-formed GeoJSON of
the wrong water. So it gets tested on its own, against ramps whose answer is written into the
statute, BEFORE it is wired into make_river_boundaries.py.

HOW THE LINE WORKS

SCDNR's file holds 15 features: US Highway 17 in two long segments (5,484 vertices between
them, Savannah River to the NC line), plus 13 short lines where SC Code 50-5-80 puts the
boundary somewhere other than the highway -- a rail bed on the Savannah and the Edisto, a
confluence on the Ashley, Cook's Landing on the New River, and the head of six creeks that are
saltwater along their whole length (Wando, Wright, Shem, Rantowles, Wallace, Long Branch).

Everything seaward of those lines is saltwater; everything landward or upstream is fresh.

WHY NOT A RAY-CASTING PARITY TEST

The obvious approach -- draw a ray from the ramp out to the Atlantic and count crossings, even
means seaward -- breaks on the exceptions. They are short lines laid ACROSS a river, so a ray
from a genuinely freshwater ramp on the Edisto crosses US-17 once and the Edisto exception once,
totals two, and reports salt. The exceptions do not add to the boundary; they locally REPLACE
it, and parity cannot express "replace".

Nor does NEAREST-FEATURE, which was the first attempt and got 6 of 8. An exception governs its
whole river, not just its own neighbourhood: the Cooper's line sits at Old Back River below
Bushy Park, so every Cooper ramp downstream of it is salt however far away US-17 runs. Nearest
picked the highway near Charleston and reported Shipyard Creek fresh.

So: NAME first, geometry second. The SCDNR features carry a NAME and so does every waterbody in
the DNR feed. If they match, that exception is the boundary and the highway is ignored;
otherwise US-17 applies. 8 of 8.
"""
import argparse, codecs, json, math, os, re, sys


def load_dividers(path):
    """[(name, [(lon,lat), ...]), ...] -- every feature as a flat vertex list."""
    gj = json.load(open(path, encoding='utf-8'))
    out = []
    for f in gj.get('features') or []:
        name = (f.get('properties') or {}).get('NAME') or '?'
        pts = []

        def walk(c):
            if not isinstance(c, list):
                return
            if c and isinstance(c[0], (int, float)):
                pts.append((c[0], c[1])); return
            for x in c:
                walk(x)
        walk((f.get('geometry') or {}).get('coordinates'))
        if len(pts) >= 2:
            out.append((name, pts))
    return out


# Degrees are fine for "which of these lines is nearest" as long as longitude is scaled by
# latitude; over a 300 km coast at ~32.5 N the error is far smaller than the gap between the
# highway and any exception.
def _xy(lon, lat, lat0):
    return (lon * math.cos(math.radians(lat0)) * 111.32, lat * 111.32)


def _seg_dist(px, py, ax, ay, bx, by):
    """Distance from P to segment AB, and the closest point on it."""
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay), (ax, ay), (1.0, 0.0)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy), (cx, cy), (dx, dy)


# The exceptions carry a NAME -- "Cooper River", "Edisto River", "Shem Creek" -- and so does
# every waterbody in the DNR feed. Matching them is what makes a reach-wide override work.
def _norm(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


SEAWARD = None   # set in main(); the unit vector pointing out to sea, in scaled xy

# Waterbodies the geometric side test cannot answer, and the answer instead.
#
# The side test asks which normal of the local segment points seaward, taking seaward as
# broadly south-east. That holds for a river running out to the ocean and FAILS for a channel
# running PARALLEL to the coast: the Intracoastal's dividing line crosses a north-east/south-west
# channel, so both of its normals point along the shore and neither is "seaward". The first run
# returned 10 ramps, 0 salt, for a waterway that is tidal salt water essentially end to end.
#
# Rather than invent a per-feature heading and hope, these are stated. The ICW in South Carolina
# is saltwater for fishing purposes throughout the stretch this project covers, and it is going
# to resolve to a coastal zone regardless -- so the honest thing is to say so here, with the
# reason, instead of shipping a geometric answer that is confidently wrong.
NAME_OVERRIDE = {
    'intracoastalwaterway': 'salt',

    # SC Code 50-5-80 names six creeks as saltwater for their ENTIRE LENGTH -- exceptions 2,
    # 5a-5d and 9. There is no landward side to be on, so asking geometry which side of a line
    # a ramp sits on is asking the wrong question entirely.
    #
    # Shem and Wando happened to come out right; Wright River did not, and was cut as a 570 km2
    # river sitting alongside the Savannah at 573 -- the same water under a third name. Their
    # dividing lines run ALONG the coast, so both normals point down the shore and neither is
    # seaward, exactly as with the ICW.
    #
    # When the statute states the answer, state it. Do not re-derive it and hope.
    'wandoriver': 'salt',          # exception 9
    'wrightriver': 'salt',         # exception 2
    'shemcreek': 'salt',           # exception 5d
    'rantowlescreek': 'salt',      # exception 5b
    'wallaceriver': 'salt',        # exception 5a
    'longbranchcreek': 'salt',     # exception 5c
}


def build_index(dividers, lat0=32.5):
    """{normalised name -> [(ax,ay,bx,by), ...]} plus the highway's segments under ''."""
    idx = {}
    for name, pts in dividers:
        key = '' if _norm(name).startswith('ushighway') else _norm(name)
        segs = idx.setdefault(key, [])
        for i in range(len(pts) - 1):
            ax, ay = _xy(pts[i][0], pts[i][1], lat0)
            bx, by = _xy(pts[i + 1][0], pts[i + 1][1], lat0)
            segs.append((ax, ay, bx, by))
    return idx


def classify(lon, lat, index, waterbody=None, lat0=32.5):
    """('salt'|'fresh', which divider was used, distance km).

    Name first, geometry second. An exception in SC Code 50-5-80 governs its whole river --
    the Cooper's line sits at Old Back River below Bushy Park, so every ramp downstream of it
    on the Cooper is saltwater no matter where US-17 happens to run. Picking the NEAREST
    feature could not express that: near Charleston the nearest thing to a Cooper River ramp
    is the highway, and Shipyard Creek came back fresh.

    Side is decided by which normal of the local segment points out to sea. On this coast that
    is broadly south-east, and it is the same test for the highway (digitised south-west to
    north-east, so its seaward normal is its right-hand one) and for an exception line laid
    across a river, whose digitised direction is arbitrary and cannot be relied on.
    """
    px, py = _xy(lon, lat, lat0)
    key = _norm(waterbody) if waterbody else ''
    if key in NAME_OVERRIDE:
        return (NAME_OVERRIDE[key], '%s (stated, not geometric)' % waterbody, 0.0)
    segs = index.get(key) or index.get('') or []
    used = waterbody if (key and key in index) else 'US Highway 17'

    best = None
    for (ax, ay, bx, by) in segs:
        d, c, dirv = _seg_dist(px, py, ax, ay, bx, by)
        if best is None or d < best[0]:
            best = (d, c, dirv)
    if best is None:
        return ('unknown', None, float('inf'))
    d, (cx, cy), (dx, dy) = best

    # Both normals of the segment; keep the one pointing seaward (south-east on this coast).
    n1 = (dy, -dx)
    seaward = n1 if (n1[0] * SEAWARD[0] + n1[1] * SEAWARD[1]) > 0 else (-dy, dx)
    side = (px - cx) * seaward[0] + (py - cy) * seaward[1]
    return ('salt' if side > 0 else 'fresh', used, d)


def read_ramps(folder, state='sc'):
    fp = os.path.join(folder, '_dnr_ramps_%s.json' % state)
    raw = open(fp, 'rb').read()
    if raw[:3] == codecs.BOM_UTF8:
        raw = raw[3:]
    out = {}
    for wb, ramps in (json.loads(raw.decode('utf-8')).get('waterbodies') or {}).items():
        pts = [(r.get('name') or '?', r['lat'], r['lon']) for r in ramps
               if isinstance(r.get('lat'), (int, float)) and isinstance(r.get('lon'), (int, float))]
        if pts:
            out[wb] = pts
    return out


# Ramps whose answer is fixed by statute or by Ryan having fished them, used as the self-test.
# A classifier that cannot get these right is not worth running on the other 198.
KNOWN = [
    # (label, waterbody as the DNR feed names it, lat, lon, expected)
    ('Shem Creek landing',        'Shem Creek',   32.79306, -79.87667, 'salt'),
    ('Oyster Landing, Murrells',  'Main Creek',   33.52383, -79.06183, 'salt'),
    ('Shipyard Creek / Cooper',   'Cooper River', 32.8100,  -79.9500,  'salt'),
    ('Wando River lower',         'Wando River',  32.8600,  -79.8300,  'salt'),
    ('Ashley above Magnolia',     'Ashley River', 32.9200,  -80.1200,  'fresh'),
    ('Lake Marion dam area',      'Lake Marion',  33.4500,  -80.1500,  'fresh'),
    ('Columbia / Congaree',       'Congaree River', 33.9900, -81.0300, 'fresh'),
    ('Lake Moultrie',             'Lake Moultrie', 33.2000, -80.0500,  'fresh'),
    # The along-coast case the geometric test cannot answer; see NAME_OVERRIDE.
    ('ICW at Socastee',           'Intracoastal Waterway', 33.6900, -78.9800, 'salt'),
    ('ICW near Little River',     'Intracoastal Waterway', 33.8500, -78.6300, 'salt'),
    # Saltwater for their entire length by statute -- the case geometry answered wrongly.
    ('Wright River',              'Wright River',   32.1150, -81.0450, 'salt'),
    ('Rantowles Creek',           'Rantowles Creek', 32.8300, -80.1590, 'salt'),
    ('Long Branch Creek',         'Long Branch Creek', 32.8100, -80.0490, 'salt'),
    ('Wallace River',             'Wallace River',  32.7860, -80.1850, 'salt'),
]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--line', required=True, help='Saltwater_Freshwater_Dividing_Line.geojson')
    ap.add_argument('--feeds', help='folder holding _dnr_ramps_sc.json')
    ap.add_argument('--self-test', action='store_true', help='run the known-answer ramps and exit')
    ap.add_argument('--show', type=int, default=0, help='print the N waterbodies nearest the line')
    a = ap.parse_args()

    global SEAWARD
    # South-east, in the same scaled xy the segments use: +east, -north.
    SEAWARD = (math.cos(math.radians(-45.0)), math.sin(math.radians(-45.0)))

    dividers = load_dividers(a.line)
    index = build_index(dividers)
    print('%d divider features, %d vertices'
          % (len(dividers), sum(len(p) for _, p in dividers)))
    for name, pts in dividers:
        if len(pts) > 100:
            print('   long feature: %-22s %d vertices' % (name, len(pts)))
    print()

    if a.self_test:
        bad = 0
        print('%-30s %-6s %-6s %-22s %8s' % ('ramp', 'want', 'got', 'nearest divider', 'dist km'))
        for label, wb, lat, lon, want in KNOWN:
            got, near, d = classify(lon, lat, index, wb)
            flag = '' if got == want else '   <-- WRONG'
            if got != want:
                bad += 1
            print('%-30s %-6s %-6s %-22s %8.2f%s' % (label, want, got, str(near)[:22], d, flag))
        print()
        print('%d of %d correct' % (len(KNOWN) - bad, len(KNOWN)))
        return 1 if bad else 0

    if not a.feeds:
        sys.exit('--feeds is required unless --self-test')

    wbs = read_ramps(a.feeds)
    rows = []
    for wb, ramps in wbs.items():
        verdicts = [classify(lon, lat, index, wb) for _, lat, lon in ramps]
        salt = sum(1 for v in verdicts if v[0] == 'salt')
        rows.append((wb, len(ramps), salt, min(v[2] for v in verdicts),
                     verdicts[0][1]))
    rows.sort(key=lambda r: r[3])

    allsalt = [r for r in rows if r[2] == r[1]]
    allfresh = [r for r in rows if r[2] == 0]
    mixed = [r for r in rows if 0 < r[2] < r[1]]
    print('%d SC waterbodies:  %d all-salt   %d all-fresh   %d MIXED'
          % (len(rows), len(allsalt), len(allfresh), len(mixed)))
    print()
    if mixed:
        print('MIXED -- ramps on both sides. These are the ones to look at: a real river')
        print('crossing the line, or a classifier error.')
        for wb, n, s, d, near in mixed[:30]:
            print('   %-34s %2d ramps  %2d salt  nearest %-18s %6.2f km' % (wb[:34], n, s, str(near)[:18], d))
        print()
    if a.show:
        print('nearest the line:')
        for wb, n, s, d, near in rows[:a.show]:
            print('   %-34s %2d ramps  %2d salt  %-18s %6.2f km' % (wb[:34], n, s, str(near)[:18], d))
    return 0


if __name__ == '__main__':
    sys.exit(main())
