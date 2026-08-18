#!/usr/bin/env python3
r"""show_missing_water.py - draw what a boundary is NOT covering, instead of quoting a percent.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\show_missing_water.py --slug lake_marion
    py .\scripts\show_missing_water.py --slug lake_marion --out F:\TrollMapPipeline\_scratch

WHY THIS EXISTS

audit_boundary_rings.py says lake_marion covers 87.7% of its NHD union and is therefore missing
about 11,580 acres. Ryan, looking at the same lake in TrollMap: "i am hard pressed to find the
12% you think is missing". One of those is wrong and a percentage cannot settle it.

It has been wrong before in exactly this shape. falls_lake had 15.65 acres outside the polygon
that replaced it, which sounded like water and turned out to be 518 slivers, the largest 0.38
acres, each with two kilometres of perimeter -- shoreline disagreement between two traces of the
same lake, not a missing arm. The only way to tell those apart is to look at the pieces.

So this prints every piece of the difference, biggest first, with a shape test, and draws them.

THE UNION RULE IS COPIED FROM THE MATCHER AND CHECKED AGAINST IT

match_waters_to_nhd.py builds the union from the best-matching NHD polygon plus every other one
that is at least 90% inside the registry boundary. That rule is inline in its main(), so it is
restated here -- and then the union acreage this script computes is compared against the
`nhd_union_acres` the binding stored. If they disagree the restatement has drifted, and the run
says so instead of drawing a confident picture of the wrong thing.
"""
import argparse
import json
import math
import os
import sys

SQM_PER_ACRE = 4046.8564224
EARTH_R_M = 6371008.8


def sphere_acres(geom):
    """Acres of a lon/lat shapely geometry, by spherical excess."""
    def ring(coords):
        pts = list(coords)
        if len(pts) < 4:
            return 0.0
        t = 0.0
        for k in range(len(pts) - 1):
            x1, y1 = math.radians(pts[k][0]), math.radians(pts[k][1])
            x2, y2 = math.radians(pts[k + 1][0]), math.radians(pts[k + 1][1])
            t += (x2 - x1) * (2 + math.sin(y1) + math.sin(y2))
        return abs(t * EARTH_R_M * EARTH_R_M / 2.0)
    total = 0.0
    for part in (list(geom.geoms) if hasattr(geom, 'geoms') else [geom]):
        if not hasattr(part, 'exterior'):
            continue
        total += ring(part.exterior.coords)
        for h in part.interiors:
            total -= ring(h.coords)
    return total / SQM_PER_ACRE


def shape_of(part):
    """(mean width in metres, 'sliver'|'lobe'), by how much area a piece carries per unit edge.

    THE RATIO ALONE WAS USELESS ON THE ONE THAT MATTERED. Marion's difference came back as a
    single connected piece of 11,125 acres and the report labelled it "sliver", which is true
    of its 4*pi*A/P^2 and tells nobody anything: a rim traced all the way around a lake is one
    enormous ring, and a ring has the arithmetic of a ribbon at any size.

    So the number that gets printed is 2A/P -- the mean width of the band. A rim is tens of
    metres wide however many acres it adds up to; a creek arm is hundreds. That is a fact about
    the water rather than about the arithmetic, and it is the one a person can check by looking
    at the map.
    """
    try:
        import pyproj
        from shapely.ops import transform
        ea = pyproj.Transformer.from_crs(
            'EPSG:4326', '+proj=aea +lat_1=29 +lat_2=45 +lat_0=37 +lon_0=-96 '
            '+datum=WGS84 +units=m', always_xy=True).transform
        m = transform(ea, part)
    except Exception:
        m = part
    if not m.length:
        return 0.0, 'point'
    width = 2.0 * m.area / m.length
    r = (4 * math.pi * m.area) / (m.length ** 2)
    return width, ('sliver' if r < 0.05 else 'lobe')


HTML = '''<!doctype html>
<meta charset="utf-8"><title>%(title)s</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css"/>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js"></script>
<style>
 html,body{margin:0;height:100%%;font:13px/1.45 system-ui,sans-serif}
 #map{position:absolute;inset:0}
 .panel{position:absolute;top:10px;right:10px;z-index:1000;background:#fff;padding:12px 14px;
   border-radius:7px;box-shadow:0 2px 10px rgba(0,0,0,.28);max-width:330px}
 .panel h1{font-size:14px;margin:0 0 8px}
 .k{display:flex;align-items:center;gap:7px;margin:4px 0}
 .sw{width:15px;height:11px;border-radius:2px;flex:none}
 .n{font-variant-numeric:tabular-nums}
 .note{margin-top:9px;padding-top:8px;border-top:1px solid #e4e4e4;color:#444;font-size:12px}
 table{border-collapse:collapse;margin-top:6px;font-size:12px}
 td{padding:1px 6px 1px 0;font-variant-numeric:tabular-nums}
</style>
<div id="map"></div>
<div class="panel">
 <h1>%(title)s</h1>
 <div class="k"><span class="sw" style="background:#2f6fb2"></span>the boundary the app draws
   &mdash; <span class="n">%(reg)s ac</span></div>
 <div class="k"><span class="sw" style="background:#e0a30b"></span>NHD union, %(pieces)d piece(s)
   &mdash; <span class="n">%(union)s ac</span></div>
 <div class="k"><span class="sw" style="background:#c0392b"></span>in NHD, not in the boundary
   &mdash; <span class="n">%(miss)s ac</span></div>
 <div class="note">%(verdict)s
 <table>%(rows)s</table></div>
</div>
<script>
const D = %(data)s;
const map = L.map('map');
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  {maxZoom:17, attribution:'&copy; OpenStreetMap'}).addTo(map);
const reg = L.geoJSON(D.registry, {style:{color:'#2f6fb2',weight:1,fillOpacity:.18}}).addTo(map);
// THE VIEW FIRST. Leaflet with no view set draws nothing at all, so a heavy layer added before
// fitBounds means a blank page rather than a slow one -- which is exactly what 16,750 polygons
// produced.
map.fitBounds(reg.getBounds().pad(0.05));
L.geoJSON(D.union, {style:{color:'#e0a30b',weight:1,fill:false,dashArray:'5 4'}}).addTo(map);
L.geoJSON(D.missing, {style:{color:'#c0392b',weight:1,fillOpacity:.75}}).addTo(map);
for (const m of D.marks) {
  L.circleMarker([m[1], m[0]], {radius:5, color:'#c0392b', weight:2, fillOpacity:.9})
    .addTo(map).bindTooltip(m[2] + ' ac \\u2014 ' + m[3], {permanent:false, sticky:true});
}
</script>
'''


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--slug', required=True)
    ap.add_argument('--registry', default=None)
    ap.add_argument('--nhd', default=None, help='default <repo>/NHD')
    ap.add_argument('--out', default=None, help='where the html goes; default <repo>/_scratch')
    ap.add_argument('--top', type=int, default=15, help='how many pieces to list (default 15)')
    ap.add_argument('--min-draw', type=float, default=0.25,
                    help='acres below which a piece is counted but not drawn (default 0.25)')
    a = ap.parse_args()

    try:
        from shapely.ops import unary_union
    except ImportError:
        print('shapely is required. py -m pip install shapely')
        return 2

    here = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, here)
    root = a.registry or os.path.dirname(here)
    if os.path.basename(root) == 'scripts':
        root = os.path.dirname(root)
    reg_dir = os.path.join(root, 'registry')
    if not os.path.isdir(reg_dir):
        print('no registry at %s -- pass --registry' % reg_dir)
        return 2

    nb = json.load(open(os.path.join(reg_dir, '_nhd_bindings.json'),
                        encoding='utf-8')).get('bindings') or {}
    b = nb.get(a.slug)
    if not b:
        print('%s has no NHD binding -- there is nothing to compare it against' % a.slug)
        return 2

    from find_duplicate_waters import rings_of
    from geomcore import _shapely_geom
    bp = os.path.join(reg_dir, 'boundaries', a.slug + '.geojson')
    if not os.path.exists(bp):
        print('no boundary at %s' % bp)
        return 2
    g = _shapely_geom(rings_of(bp))
    if g is None or g.is_empty:
        print('%s has no usable boundary polygon' % a.slug)
        return 2

    import match_waters_to_nhd as mw
    gdbs = mw.find_gdbs(__import__('pathlib').Path(a.nhd or os.path.join(root, 'NHD')),
                        [b.get('vpu')])
    if not gdbs:
        print('no geodatabase for vpu %s under %s' % (b.get('vpu'), a.nhd))
        return 2
    vpu, src = list(gdbs.items())[0]
    print('%s  vpu %s  %s' % (a.slug, vpu, os.path.basename(str(src))))

    WANT = ['Permanent_Identifier', 'GNIS_ID', 'GNIS_Name', 'AreaSqKm', 'FType']
    wb = g.bounds
    world = (wb[0] - 0.05, wb[1] - 0.05, wb[2] + 0.05, wb[3] + 0.05)
    # read_polys returns raw WKB, not geometry -- its own docstring says so, and
    # match_waters_to_nhd.main() calls from_wkb on the array before touching it. Reading the
    # name of a function instead of its docstring is how `bytes` object has no attribute 'area'
    # happens.
    from shapely import from_wkb
    cand = []
    for layer in ('NHDWaterbody', 'NHDArea'):
        try:
            wkb, cols, missing, _have = mw.read_polys(src, layer, WANT, bbox=world)
        except Exception as exc:
            print('   %s not readable (%s)' % (layer, type(exc).__name__))
            continue
        if missing or wkb is None or len(wkb) == 0:
            continue
        geom = from_wkb(wkb)
        for i in range(len(geom)):
            if geom[i] is None or geom[i].is_empty:
                continue
            cand.append({'geom': geom[i],
                         'pid': str(cols['Permanent_Identifier'][i]),
                         'gnis': cols['GNIS_ID'][i],
                         'name': cols['GNIS_Name'][i],
                         'km2': float(cols['AreaSqKm'][i] or 0),
                         'layer': layer})
    if not cand:
        print('   nothing in that geodatabase near this water')
        return 2

    # THE UNION RULE, restated from match_waters_to_nhd.main() and checked below.
    #
    # DISSOLVE BY GNIS ID FIRST. The matcher does this before anything else -- a river is split
    # into many NHDArea pieces and a lake's arms can be separate rows sharing one id -- and
    # skipping it made this report 10 pieces where the binding says 6.
    groups = {}
    for n, c in enumerate(cand):
        key = mw.normalize_gnis(c['gnis'])
        groups.setdefault(key or '_row%d' % n, []).append(n)
    merged = []
    for key, ns in groups.items():
        geo = cand[ns[0]]['geom'] if len(ns) == 1 \
            else unary_union([cand[k]['geom'] for k in ns])
        merged.append({'geom': geo,
                       'pids': {cand[k]['pid'] for k in ns},
                       'km2': sum(cand[k]['km2'] for k in ns),
                       'name': next((cand[k]['name'] for k in ns if cand[k]['name']), None)})
    pid = str(b.get('permanent_identifier'))
    best = [m for m in merged if pid in m['pids']]
    if not best:
        print('   the bound Permanent_Identifier %s is not in this geodatabase' % pid)
        return 2
    keep = [best[0]]
    for m in merged:
        if m is best[0] or m['geom'].area <= 0:
            continue
        if g.intersection(m['geom']).area >= 0.9 * m['geom'].area:
            keep.append(m)
    union = unary_union([m['geom'].buffer(0) for m in keep])
    u_ac = sphere_acres(union)
    declared = sum(m['km2'] for m in keep) * 247.105

    stored = b.get('nhd_union_acres')
    print('   union: %d piece(s)   declared %.1f ac   measured %.1f ac' % (len(keep), declared,
                                                                          u_ac))
    print('   binding stored: %s ac across %s piece(s)' % (stored, b.get('nhd_union_pieces')))
    # DECLARED AGAINST DECLARED. nhd_union_acres is the sum of the source rows' AreaSqKm, not
    # the area of the dissolved geometry, and the two differ by whatever the rows overlap. This
    # compared a measured figure against a declared one and called the gap drift.
    drift = stored and abs(declared - stored) / stored > 0.02
    if drift or (stored and len(keep) != b.get('nhd_union_pieces')):
        print('   !! THIS DISAGREES WITH THE BINDING. The union rule restated here has drifted')
        print('      from match_waters_to_nhd.py, so the picture below is of the wrong thing.')
        print('      Fix that before believing any of it.')

    miss = union.difference(g)
    parts = [p for p in (list(miss.geoms) if hasattr(miss, 'geoms') else [miss])
             if not p.is_empty and p.area > 0]
    scored = sorted(((sphere_acres(p), p) for p in parts), key=lambda t: -t[0])
    total = sum(s for s, _ in scored)
    print('\n   in NHD and not in the boundary: %.1f acres in %d piece(s)' % (total, len(scored)))
    print('   %4s %10s %9s %9s   %s' % ('#', 'acres', 'mean wide', 'shape', 'centre'))
    rows, marks = [], []
    for n, (acr, p) in enumerate(scored[:a.top], 1):
        width, kind = shape_of(p)
        c = p.representative_point()
        print('   %4d %10.1f %8.0f m %9s   %.5f, %.5f' % (n, acr, width, kind, c.x, c.y))
        rows.append('<tr><td>%.0f ac</td><td>%.0f m wide</td><td>%s</td></tr>'
                    % (acr, width, kind))
        marks.append([round(c.x, 6), round(c.y, 6), round(acr, 1),
                      '%s, %.0f m wide' % (kind, width)])
    if len(scored) > a.top:
        print('   ... and %d more, together %.1f acres'
              % (len(scored) - a.top, sum(s for s, _ in scored[a.top:])))

    lobes = [s for s, p in scored if shape_of(p)[1] == 'lobe' and s >= 1.0]
    if lobes:
        verdict = ('<b>%d piece(s) of 1 acre or more are lobes</b>, together %.0f ac. That is '
                   'water, not a trace disagreement.' % (len(lobes), sum(lobes)))
    else:
        verdict = ('<b>No piece of 1 acre or more is a lobe.</b> This is shoreline disagreement '
                   'between two traces of the same water, not missing lake.')
    print('\n   %s' % verdict.replace('<b>', '').replace('</b>', ''))

    from shapely.geometry import mapping
    from shapely.ops import unary_union as _uu
    # 16,750 polygons is not a map. Leaflet builds a Path per part, stalls before fitBounds
    # ever runs, and the page comes up blank with no view set and nothing drawn at all -- which
    # is what Ryan got. Draw the pieces a person could see and say how many were left out.
    shown = [p for acr, p in scored if acr >= a.min_draw]
    hidden = len(scored) - len(shown)
    miss_draw = _uu(shown) if shown else miss
    if hidden:
        print('   drawing %d piece(s) of %.2f acres or more; %d smaller one(s) omitted from the'
              ' map, together %.1f acres'
              % (len(shown), a.min_draw, hidden,
                 sum(acr for acr, _ in scored if acr < a.min_draw)))
    out_dir = a.out or os.path.join(root, '_scratch')
    os.makedirs(out_dir, exist_ok=True)
    fp = os.path.join(out_dir, '%s_missing_water.html' % a.slug)
    data = {'registry': mapping(g.simplify(0.00008, preserve_topology=True)),
            'union': mapping(union.simplify(0.00008, preserve_topology=True)),
            'missing': mapping(miss_draw.simplify(0.00002, preserve_topology=True)),
            'marks': marks}
    open(fp, 'w', encoding='utf-8').write(HTML % {
        'title': '%s -- what NHD has and the boundary does not' % a.slug,
        'reg': format(int(sphere_acres(g)), ','), 'union': format(int(u_ac), ','),
        'miss': format(int(total), ','), 'pieces': len(keep),
        'verdict': verdict, 'rows': ''.join(rows),
        'data': json.dumps(data, separators=(',', ':'))})
    print('\n   -> %s' % fp)
    return 0


if __name__ == '__main__':
    sys.exit(main())
