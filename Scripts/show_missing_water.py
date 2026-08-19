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
import gzip
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


def _albers(geom):
    """The same equal-area projection shape_of uses, or None if pyproj is absent."""
    try:
        import pyproj
        from shapely.ops import transform
        return transform(pyproj.Transformer.from_crs(
            'EPSG:4326', '+proj=aea +lat_1=29 +lat_2=45 +lat_0=37 +lon_0=-96 '
            '+datum=WGS84 +units=m', always_xy=True).transform, geom)
    except Exception:
        return None


def metres(geom):
    """Length of a lon/lat geometry in metres.

    NOT degrees times 111,000. A degree of longitude at 33 N is 93 km, not 111, so the flat
    factor overstates every east-west run by 19% -- and the number this feeds is "how much
    contour the app does not draw", which is the one line of the report a person would act on.
    An invented number that looks like a measurement is worse than no number.
    """
    if geom is None or geom.is_empty:
        return 0.0
    m = _albers(geom)
    return (m if m is not None else geom).length


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


def _open_tile(path):
    """A tile is <name>.geojson.gz, and sometimes <name>.geojson. Return features or []."""
    for p in (path + '.gz', path):
        if os.path.exists(p):
            try:
                op = gzip.open(p, 'rt', encoding='utf-8') if p.endswith('.gz') \
                    else open(p, encoding='utf-8')
                with op as fh:
                    return (json.load(fh).get('features') or [])
            except Exception:
                return []
    return []


def tiles_for(root, slug):
    """(B tiles, C tiles) for a slug, from tile_lake_map.json.

    C TILES CARRY THE SOUNDINGS, B TILES CARRY EVERYTHING ELSE, AND THE MAP STORES B.
    contours and depth_areas live under extract/contours/C4E0F4.geojson.gz; waterbody,
    shoreline, pois, docks and labels live under B4E0F4. `by_lake` holds the B name, so the
    sounding layers have to be asked for by the C name or they come back empty and the tool
    reports that Garmin charts nothing here -- which is the same sentence it prints when
    Garmin really charts nothing, and there is no way to tell the two apart from the output.
    """
    fp = os.path.join(root, 'registry', 'tile_lake_map.json')
    if not os.path.exists(fp):
        return [], []
    try:
        by_lake = (json.load(open(fp, encoding='utf-8')).get('by_lake') or {})
    except Exception:
        return [], []
    b = [t for t in (by_lake.get(slug) or []) if t]
    return b, [('C' + t[1:]) if len(t) > 1 else t for t in b]


def garmin_evidence(root, slug, area, min_ac=0.02):
    """What GARMIN charts inside `area`, and how much of it the pack does not carry.

    THIS REPLACES A SHAPE TEST WITH THE QUESTION THE SHAPE TEST WAS A PROXY FOR.

    The verdict used to come from 4*pi*A/P^2 -- sliver or lobe -- and on prestwood_lake it
    called the entire upper half of the lake, 262 acres and 129 m of mean width, a sliver, and
    concluded "shoreline disagreement between two traces of the same water, not missing lake".
    Ryan had already looked at that lake in the app: "its definitely cut short on most banks".

    Mean width does not separate them either, and the test file says so without noticing: the
    lake-sized rim it builds to prove a rim is a sliver is about 100 m wide, and Prestwood's
    missing arm is 129 m. There is no shape threshold with a rim on one side and a creek arm
    on the other, because the difference between them is not a shape -- it is whether there is
    water there.

    Garmin already answered that. extract/waterbody says where it drew water, and
    extract/contours and extract/depth_areas say where it sounded. So this counts:

        water_ac        acres Garmin draws as water inside the gap
        contours        Garmin's zoom-0 contours whose geometry meets the gap
        depth_areas     the same for depth areas
        pack_*          how many of those the pack ALREADY carries

    and re-tracing earns its keep only where Garmin sounded water the pack is not shipping.
    That is the lake_marion answer and the prestwood_lake answer from one measurement instead
    of two opposite guesses.

    ZOOM 0 ON BOTH SIDES. Contours ship at six zooms that are generalised copies of one line,
    and the pack keeps zoom 0. Counting every zoom in the tile against a zoom-0 pack reports a
    gap that is six renderings of a contour the pack already has.
    """
    ev = {'tiles': 0, 'water_ac': 0.0, 'contours': 0, 'depth_areas': 0,
          'pack_contours': 0, 'pack_depth_areas': 0, 'read': False, 'water': None,
          'unshipped_m': {}, 'unshipped': {}}
    if area is None or area.is_empty:
        return ev
    from shapely.geometry import shape as _shape
    from shapely.ops import unary_union as _uu, unary_union
    btiles, ctiles = tiles_for(root, slug)
    if not btiles:
        return ev
    ev['tiles'] = len(btiles)
    ex = os.path.join(root, 'extract')

    # ONE POLYGON PER DISTINCT `raw`. Garmin emits the same water at several display modes and
    # the duplicates are byte-identical in `raw`, so counting rows counts renderings.
    seen, water = set(), []
    for t in btiles:
        for f in _open_tile(os.path.join(ex, 'waterbody', t + '.geojson')):
            p = f.get('properties') or {}
            k = (t, p.get('raw'))
            if p.get('raw') is not None and k in seen:
                continue
            seen.add(k)
            try:
                g = _shape(f['geometry'])
            except Exception:
                continue
            if g.is_empty or not g.intersects(area):
                continue
            try:
                water.append(g.buffer(0))
            except Exception:
                continue
    if water:
        ev['read'] = True
        try:
            ev['water'] = _uu(water)
            ev['water_ac'] = sphere_acres(ev['water'].intersection(area))
        except Exception:
            ev['water'], ev['water_ac'] = None, 0.0

    pack = os.path.join(root, 'chartpack', slug)
    for key, layer in (('contours', 'contours'), ('depth_areas', 'depth_areas')):
        hits = []
        for t in ctiles:
            for f in _open_tile(os.path.join(ex, layer, t + '.geojson')):
                p = f.get('properties') or {}
                if p.get('zoom') not in (0, None):
                    continue
                try:
                    g = _shape(f['geometry'])
                except Exception:
                    continue
                if g.is_empty or not g.intersects(area):
                    continue
                ev['read'] = True
                hits.append(g)
        ev[key] = len(hits)
        if not hits:
            continue

        # WHAT THE PACK HOLDS IS MATCHED BY GEOMETRY. Two earlier versions of this got it
        # wrong in opposite directions and both were confident.
        #
        # The first drew a bounding box around the gap and counted every pack feature whose
        # first coordinate landed in it. The box around a gap contains the lake beside it, so
        # prestwood_lake came back "42 contours already drawn" for a gap the pack was assumed
        # not to reach.
        #
        # The second matched on the tile's `raw` field. THE PACK DOES NOT CARRY `raw` -- its
        # properties are layer, mode, zoom, depth_* and tile -- so the comparison ran against
        # an empty set and reported 0 shipped for every water, on every layer, always. It was
        # tested against a fixture invented with a `raw` on it, which is how a match key that
        # does not exist in the real file passed a test.
        #
        # AND THE ASSUMPTION UNDER BOTH WAS FALSE: a pack is NOT clipped to its boundary.
        # build_chartpack dilates the mask, so Prestwood's 193-acre ring ships contours out to
        # -80.1024, well into a gap that starts at -80.0917. Ryan saw that immediately -- "the
        # green area is present" -- because the app was drawing it.
        #
        # So the only honest question is how much of Garmin's line the app does not draw
        # ANYWHERE, and the answer is metres, not features: a feature the mask cut in half is
        # half shipped, and counting it as missing or as present is wrong either way.
        pk = []
        fp = os.path.join(pack, layer + '.geojson')
        if os.path.exists(fp):
            try:
                for ft in (json.load(open(fp, encoding='utf-8')).get('features') or []):
                    try:
                        pg = _shape(ft['geometry'])
                    except Exception:
                        continue
                    if pg.is_empty:
                        continue
                    pk.append(pg.buffer(0) if pg.geom_type.endswith('Polygon') else pg)
            except Exception:
                pk = []
        if not pk:
            ev['unshipped_m'][key] = sum(metres(g) for g in hits)
            continue
        # EPS is float noise, not a tolerance. The pack's coordinates come out of the same
        # tile decode as the tile's, so a shipped feature is the SAME geometry; ~2 m of buffer
        # absorbs the round trip through JSON and nothing else.
        cover = unary_union(pk).buffer(2e-5)
        short, left = 0, []
        for g in hits:
            d = g.difference(cover)
            if d.is_empty or (g.length and d.length / g.length < 0.10):
                short += 1
            if not d.is_empty:
                left.append(d)
        ev['pack_' + key] = short
        if left:
            try:
                ev['unshipped_m'][key] = metres(unary_union(left))
                ev['unshipped'][key] = unary_union(left)
            except Exception:
                pass
    return ev


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
 <div class="k"><span class="sw" style="background:#1f8a4c"></span>what GARMIN charts as water
   in there &mdash; <span class="n">%(wet)s ac</span></div>
 <div class="k"><span class="sw" style="background:#8e44ad"></span>Garmin line NO pack draws
   &mdash; <span class="n">%(unm)s m</span></div>
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
// GARMIN LAST AND ON TOP. The red is what NHD says is missing; the green is the part of it a
// depth sounder actually went over, and that is the layer the decision turns on.
if (D.garmin) L.geoJSON(D.garmin,
  {style:{color:'#1f8a4c',weight:1,fillOpacity:.55}}).addTo(map);
// AND THE ONE LINE THAT IS ACTUALLY ABSENT. Not the gap, not the water -- the contour Garmin
// drew that no pack ships. Everything else on this page is context for it.
if (D.unshipped) L.geoJSON(D.unshipped,
  {style:{color:'#8e44ad',weight:3,opacity:.95,fill:false}}).addTo(map);
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

    # ASK GARMIN BEFORE PRINTING A WORD ABOUT ANY OF THESE PIECES.
    #
    # `shape_of` describes the arithmetic of a piece and nothing else, and on prestwood_lake it
    # described 262 acres of open water -- the whole upper half of the lake, 16 km of sinuous
    # bank around a 129 m wide arm -- as a sliver, which is true of its 4*pi*A/P^2 and reads as
    # "not water". A flooded creek arm has the perimeter of a ribbon. So the shape stays in the
    # table as a shape, and whether the piece is WATER is answered by the tile that charts it.
    ev = garmin_evidence(root, a.slug, unary_union([p for acr, p in scored if acr >= 0.02])
                         if scored else None)
    gw = ev.get('water')

    # THE TABLE LISTS WHAT A PERSON COULD FIND. `union.difference(boundary)` leaves a crumb of
    # topology at every vertex where the two traces cross -- prestwood_lake came back as 1 real
    # arm and 105 pieces of 0.00 acres -- and fifteen rows of zeroes under one real row reads as
    # fifteen findings. The remainder is reported as a total below, not hidden.
    listed = [t for t in scored if t[0] >= a.min_draw][:a.top]
    print('   %4s %10s %9s %9s %8s   %s'
          % ('#', 'acres', 'mean wide', 'shape', 'garmin', 'centre'))
    rows, marks = [], []
    for n, (acr, p) in enumerate(listed, 1):
        width, kind = shape_of(p)
        wet = ''
        if gw is not None:
            try:
                wet = '%.0f ac' % sphere_acres(gw.intersection(p))
            except Exception:
                wet = '?'
        c = p.representative_point()
        print('   %4d %10.1f %8.0f m %9s %8s   %.5f, %.5f'
              % (n, acr, width, kind, wet or '-', c.x, c.y))
        rows.append('<tr><td>%.0f ac</td><td>%.0f m wide</td><td>%s</td><td>%s water</td></tr>'
                    % (acr, width, kind, wet or 'no garmin'))
        marks.append([round(c.x, 6), round(c.y, 6), round(acr, 1),
                      '%s, %.0f m wide, garmin charts %s' % (kind, width, wet or 'nothing')])
    if len(listed) < len(scored):
        rest = [t for t in scored if t not in listed]
        print('   ... and %d more, none over %.2f ac unless the list was cut at --top %d,'
              ' together %.1f acres'
              % (len(rest), a.min_draw, a.top, sum(s for s, _ in rest)))

    # DOES THE APP ALREADY DRAW IT? That is the only question that matters, and it is not the
    # same question as whether the boundary covers it.
    #
    # lake_marion, 2026-08-18. The audit called it 11,580 acres short and the difference came
    # back as one 11,125-acre piece over Sparkleberry Swamp. Ryan, looking at TrollMap: "that
    # section shows contours and depth areas for most of it... the boundary wouldn't add
    # anything because the swamp is mostly unsounded by garmin anyways".
    #
    # prestwood_lake, the same day, is the other half of the lesson. Ryan: "its definitely cut
    # short on most banks... the boundary doesn't line up with the shoreline pretty much at
    # all". Same audit, same shape of gap, opposite answer -- and the two versions of this
    # block that ran before both got Prestwood backwards. The bounding box around the gap
    # includes the lake beside it, so it counted the pack's own soundings and said the app
    # already drew a gap the pack cannot reach; and the sliver-versus-lobe call read 262 acres
    # of open water as a trace disagreement.
    #
    # Both were proxies. garmin_evidence() asks the source instead.
    gained_c = ev['contours'] - ev['pack_contours']
    gained_d = ev['depth_areas'] - ev['pack_depth_areas']
    un_c = ev['unshipped_m'].get('contours', 0.0)
    un_d = ev['unshipped_m'].get('depth_areas', 0.0)
    if not ev['tiles']:
        verdict = ('<b>%s is not in tile_lake_map.json</b>, so there is no Garmin tile to ask '
                   'whether this gap is water.' % a.slug)
    elif not ev['read']:
        verdict = ('<b>Garmin charts nothing inside this gap</b> across %d tile(s) &mdash; no '
                   'water, no soundings. Re-tracing would add outline and nothing to display.'
                   % ev['tiles'])
    else:
        print('\n   inside the gap Garmin charts %.1f acres of water, %d contour(s) and %d '
              'depth area(s) at zoom 0' % (ev['water_ac'], ev['contours'], ev['depth_areas']))
        print('   the pack already draws %d of those contour(s) and %d of those depth area(s)'
              ' -- a pack is NOT clipped to its boundary, the mask is dilated'
              % (ev['pack_contours'], ev['pack_depth_areas']))
        print('   Garmin line the app does not draw anywhere: %.0f m of contour, %.0f m of'
              ' depth-area edge' % (un_c, un_d))
        if un_c >= 500 or un_d >= 500:
            verdict = ('<b>Garmin sounded this and the app is not drawing all of it:</b> %.0f ac '
                       'of charted water in the gap, and %.0f m of contour and %.0f m of '
                       'depth-area edge that appear in no pack. Re-tracing adds soundings.'
                       % (ev['water_ac'], un_c, un_d))
        elif ev['contours'] or ev['depth_areas']:
            verdict = ('<b>The app already draws this.</b> Garmin has %d contour(s) and %d '
                       'depth area(s) inside the gap and the pack reaches essentially all of '
                       'them, so re-tracing would add outline, not soundings.'
                       % (ev['contours'], ev['depth_areas']))
        else:
            verdict = ('<b>Garmin draws %.0f ac of water here and never sounded it.</b> '
                       'Re-tracing adds outline, not soundings.' % ev['water_ac'])
    print('\n   %s' % verdict.replace('<b>', '').replace('</b>', '').replace('&mdash;', '--'))

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
    wet_draw = None
    if gw is not None:
        try:
            wet_draw = gw.intersection(miss_draw)
        except Exception:
            wet_draw = None
    data = {'registry': mapping(g.simplify(0.00008, preserve_topology=True)),
            'union': mapping(union.simplify(0.00008, preserve_topology=True)),
            'missing': mapping(miss_draw.simplify(0.00002, preserve_topology=True)),
            'garmin': (mapping(wet_draw.simplify(0.00002, preserve_topology=True))
                       if wet_draw is not None and not wet_draw.is_empty else None),
            'unshipped': (mapping(_uu([v for v in ev['unshipped'].values() if v is not None]))
                          if ev.get('unshipped') else None),
            'marks': marks}
    open(fp, 'w', encoding='utf-8').write(HTML % {
        'title': '%s -- what NHD has and the boundary does not' % a.slug,
        'reg': format(int(sphere_acres(g)), ','), 'union': format(int(u_ac), ','),
        'miss': format(int(total), ','), 'pieces': len(keep),
        'wet': format(int(ev.get('water_ac') or 0), ','),
        'unm': format(int(sum(ev['unshipped_m'].values())), ','),
        'verdict': verdict, 'rows': ''.join(rows),
        'data': json.dumps(data, separators=(',', ':'))})
    print('\n   -> %s' % fp)
    return 0


if __name__ == '__main__':
    sys.exit(main())
