#!/usr/bin/env python3
r"""survey_chart.py - a water's chart from Ryan's own sounder, where he has recorded it.

Personal use only, not for distribution or resale; not for navigation.

    py Scripts\survey_chart.py --slug bates_old_river --qdc F:\TrollMapPipeline\27Sep26_Trip\U `
       --registry F:\TrollMapPipeline\registry
    # ... says what it would write and writes nothing. Then --go, which writes
    # registry\surveys\<slug>\{depth_areas,contours,coverage}.geojson and survey.json.

build_all_chartpacks.py reads registry\surveys\<slug>\ when it builds that water's pack: inside
his coverage his chart is the chart, and Garmin's fills the water he has not driven (apply()).

WHY. Ryan, 2026-10-05: *"lets see if you can make contours on bates using my the data from my fish
finder"*. Garmin charted 18.4 of Bates Old River's 55 acres; his Quickdraw holds 38.4. Checked
against what his sounder read on the 9/27 trip, 628 track points: his chart within 1.5 ft at 95%,
median error 0.09 ft; Garmin's 2.41 ft deeper than that day's water and within 1.5 ft at 20%.
Bates was the first. Any water he records gets the same treatment by running this for its slug --
the card's Quickdraw folder holds every water he has driven, and the boundary picks the water out.

THE SOUNDINGS ARE DECODED BY THE APP'S OWN READER (qdc_points.mjs imports
js/modules/qdc-decoder.js), so the pipeline and the app's Quickdraw layer cannot disagree about
where a sounding is.

WHAT IS BUILT, AND THE ONE CHOICE IN IT
  * The soundings stay on their own lattice: one cell per sounding, 90/2**(22-layer) degrees
    (layer 0: about 2.4 m). Nothing is drawn where he has not been.
  * Smoothed by the app's own Quickdraw rule: each sounded cell takes the mean of the sounded cells
    in its 3x3 neighbourhood (buildDepthGrid() in qdc-decoder.js, doSmooth).
  * Depth bands at every whole foot, `k-(k+1) ft`, TILED -- one band per point -- in the fields
    the Garmin layer uses, so depthSampler() in the app and DepthRaster in the fitter read them
    unchanged. Contours at every whole foot. Both cut to his coverage and to the boundary.
  * Lines are simplified by half a cell: no detail finer than the cell it was drawn from.

AND THE ONE THING IT CANNOT KNOW. Quickdraw records depth against the water the day he drove it.
A water that rises and falls with a river carries cells from different trips on different levels.
"""
import argparse, datetime, json, math, os, subprocess, sys, tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
NOTE = 'Personal use only, not for distribution or resale; not for navigation.'
SOURCE = 'ryan_quickdraw'
LAYERS = ('depth_areas', 'contours')


def cell_deg(layer):
    """QDC_LAYER_PARAMETERS[layer].a_step in js/modules/qdc-decoder.js: 90/2**22 at layer 0, halving
    in resolution each layer up."""
    return 90.0 / 2 ** (22 - int(layer))


# ── decode ──────────────────────────────────────────────────────────────────────────────────

def decode(folders, layer):
    """[[lon, lat, depth_ft], ...] from the app's own reader, run under node."""
    fd, tmp = tempfile.mkstemp(suffix='.json')
    os.close(fd)
    try:
        cmd = ['node', os.path.join(HERE, 'qdc_points.mjs'), '--layer', str(layer), '--out', tmp] + list(folders)
        r = subprocess.run(cmd, capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        if r.returncode != 0:
            sys.stderr.write(r.stderr)
            raise SystemExit('qdc_points.mjs failed (exit %d)' % r.returncode)
        with open(tmp, encoding='utf-8') as fh:
            return json.load(fh)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def load_boundary(registry, slug):
    from shapely.geometry import shape
    from shapely.ops import unary_union
    p = os.path.join(registry, 'boundaries', slug + '.geojson')
    with open(p, encoding='utf-8') as fh:
        gj = json.load(fh)
    feats = gj.get('features') if gj.get('type') == 'FeatureCollection' else [gj]
    gs = [shape(f['geometry']) for f in feats if f.get('geometry')]
    gs = [g if g.is_valid else g.buffer(0) for g in gs]
    return unary_union(gs)


def acres(geom):
    """Area of a lon/lat geometry, by the local scale at its centre (water-sized areas only)."""
    lat = geom.centroid.y if not geom.is_empty else 0.0
    return geom.area * 111320.0 * math.cos(math.radians(lat)) * 110540.0 / 4046.86


# ── build ───────────────────────────────────────────────────────────────────────────────────

def smooth3(grid):
    """The app's own Quickdraw smoothing: every sounded cell becomes the mean of the sounded cells
    in its 3x3 neighbourhood. Unsounded cells stay unsounded."""
    real = ~np.isnan(grid)
    v = np.where(real, grid, 0.0)
    w = real.astype(float)
    pv = np.pad(v, 1)
    pw = np.pad(w, 1)
    H, W = grid.shape
    sv = sum(pv[1 + dy:1 + dy + H, 1 + dx:1 + dx + W] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
    sw = sum(pw[1 + dy:1 + dy + H, 1 + dx:1 + dx + W] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
    out = np.where(real, sv / np.maximum(sw, 1.0), np.nan)
    return out


def _band_props(k):
    return {'mode': SOURCE, 'zoom': 0, 'depth_min_dm': int(round(k * 3.048)),
            'depth_max_dm': int(round((k + 1) * 3.048)), 'depth_min_ft': k, 'depth_max_ft': k + 1,
            'band': '%d-%d ft' % (k, k + 1), 'layer': 'depth_areas', 'tile': 'qdc', 'source': SOURCE}


def _line_props(k):
    return {'layer': 'contours', 'mode': SOURCE, 'zoom': 0, 'depth_dm': int(round(k * 3.048)),
            'depth_ft': float(k), 'depth_m': round(k * 0.3048, 2), 'tile': 'qdc', 'source': SOURCE}


def build(points, boundary, layer=0):
    """points [[lon, lat, ft]] and the water's boundary -> {'depth_areas', 'contours', 'coverage',
    'stats'}. Pure: no files."""
    import contourpy
    from shapely.geometry import Point, Polygon, LineString, MultiLineString, box, mapping
    from shapely.ops import unary_union
    from shapely.prepared import prep

    a = cell_deg(layer)
    pb = prep(boundary)
    pts = [p for p in points if pb.contains(Point(p[0], p[1]))]
    stats = {'soundings_in': len(points), 'soundings_inside': len(pts), 'layer': int(layer)}
    if not pts:
        return {'depth_areas': [], 'contours': [], 'coverage': None, 'stats': stats}
    P = np.array(pts, float)
    ix = np.rint((P[:, 0] - a / 2) / a).astype(int)
    iy = np.rint((P[:, 1] - a / 2) / a).astype(int)
    x0, y0 = ix.min() - 2, iy.min() - 2
    W, H = ix.max() - x0 + 3, iy.max() - y0 + 3
    grid = np.full((H, W), np.nan)
    grid[iy - y0, ix - x0] = P[:, 2]          # one sounding per cell: it is the lattice it came off
    sm = smooth3(grid)
    lons = (x0 + np.arange(W)) * a + a / 2
    lats = (y0 + np.arange(H)) * a + a / 2

    half = a / 2
    cells = [box(lons[c] - half, lats[r] - half, lons[c] + half, lats[r] + half)
             for r, c in zip(*np.nonzero(~np.isnan(sm)))]
    coverage = unary_union(cells).intersection(boundary)
    if not coverage.is_valid:
        coverage = coverage.buffer(0)
    pc = prep(coverage)

    zmask = np.ma.masked_invalid(sm)
    gen = contourpy.contour_generator(x=lons, y=lats, z=zmask,
                                      line_type=contourpy.LineType.Separate,
                                      fill_type=contourpy.FillType.OuterOffset)
    top = int(math.floor(float(np.nanmax(sm))))

    areas = []
    for k in range(0, top + 1):
        hi = k + 1 if k < top else float(np.nanmax(sm)) + 1e-6
        pts_list, offs_list = gen.filled(float(k), float(hi))
        for xy, off in zip(pts_list, offs_list):
            rings = [xy[off[i]:off[i + 1]] for i in range(len(off) - 1)]
            rings = [r for r in rings if len(r) >= 4]
            if not rings:
                continue
            poly = Polygon(rings[0], rings[1:])
            if not poly.is_valid:
                poly = poly.buffer(0)
            g = poly.intersection(coverage)
            for part in (getattr(g, 'geoms', None) or [g]):
                if part.geom_type != 'Polygon' or part.is_empty:
                    continue
                part = part.simplify(a / 2, preserve_topology=True)
                if part.is_empty:
                    continue
                areas.append({'type': 'Feature', 'properties': _band_props(k), 'geometry': mapping(part)})

    lines = []
    for k in range(1, top + 1):
        for xy in gen.lines(float(k)):
            if len(xy) < 2:
                continue
            g = LineString(xy).intersection(coverage)
            for part in (getattr(g, 'geoms', None) or [g]):
                if part.geom_type != 'LineString' or part.is_empty:
                    continue
                part = part.simplify(a / 2)
                if len(part.coords) < 2:
                    continue
                lines.append({'type': 'Feature', 'properties': _line_props(k), 'geometry': mapping(part)})

    d = P[:, 2]
    stats.update({'cells': int((~np.isnan(sm)).sum()), 'coverage_acres': round(acres(coverage), 1),
                  'boundary_acres': round(acres(boundary), 1), 'depth_ft_min': round(float(d.min()), 1),
                  'depth_ft_max': round(float(d.max()), 1), 'bands': len(areas), 'contours': len(lines)})
    return {'depth_areas': areas, 'contours': lines, 'coverage': coverage, 'stats': stats}


# ── read back, and lay into a pack ──────────────────────────────────────────────────────────

def surveys_dir(registry, override=None):
    return override or os.path.join(registry, 'surveys')


def load(sdir, slug):
    """The survey for `slug`, or None when he has not recorded it."""
    d = os.path.join(sdir, slug)
    if not os.path.isfile(os.path.join(d, 'coverage.geojson')):
        return None
    from shapely.geometry import shape
    out = {}
    for layer in LAYERS:
        with open(os.path.join(d, layer + '.geojson'), encoding='utf-8') as fh:
            out[layer] = json.load(fh).get('features') or []
    with open(os.path.join(d, 'coverage.geojson'), encoding='utf-8') as fh:
        cg = json.load(fh)
    out['coverage'] = shape(cg['features'][0]['geometry'] if cg.get('type') == 'FeatureCollection' else cg)
    meta = os.path.join(d, 'survey.json')
    out['meta'] = json.load(open(meta, encoding='utf-8')) if os.path.isfile(meta) else {}
    return out


def _vertices(geom):
    t = geom.get('type')
    c = geom.get('coordinates') or []
    if t == 'Point':
        return [c]
    if t in ('LineString', 'MultiPoint'):
        return list(c)
    if t in ('Polygon', 'MultiLineString'):
        return [p for r in c for p in r]
    if t == 'MultiPolygon':
        return [p for poly in c for r in poly for p in r]
    return []


def apply(layers, survey, allowed=None):
    """Lay his survey into a pack's layers, in place. Returns what it did.

    INSIDE HIS COVERAGE HIS CHART IS THE CHART. A Garmin contour or depth area goes when at least
    half its vertices are inside his coverage -- the same half the pipeline already uses to decide
    whether a polygon belongs to a boundary (build_chartpack.trim_geometry). The rest of Garmin's
    stays: water he has not driven keeps the only chart it has.

    Only the layers this run actually read are touched (`allowed`, None for all), so an
    --only-layers run that did not read contours cannot have them replaced behind its back. A layer
    Garmin has nothing for is still his to fill.
    """
    from shapely.geometry import Point
    from shapely.prepared import prep
    pc = prep(survey['coverage'])
    st = {}
    for layer in LAYERS:
        if allowed is not None and layer not in allowed:
            continue
        kept = []
        gone = 0
        for f in layers.get(layer) or []:
            vs = _vertices(f.get('geometry') or {})
            inside = sum(1 for v in vs if pc.contains(Point(v[0], v[1])))
            if vs and inside * 2 >= len(vs):
                gone += 1
            else:
                kept.append(f)
        layers[layer] = list(survey[layer]) + kept
        st[layer] = {'his': len(survey[layer]), 'garmin_replaced': gone, 'garmin_kept': len(kept)}
    # AND WHERE HE SOUNDED IT, IT IS NOT UNSURVEYED. `unsurveyed` is Garmin's complement of ITS OWN
    # depth areas (build_all_chartpacks reads it at the depth areas' level for that reason), so once
    # his bands are the chart inside his coverage, Garmin's "no survey here" is false there. Found
    # in the app on Bates the day this went live: 24.7 of its 37.6 hatched acres sat on water he had
    # recorded, under the tooltip "Not sounded -- Garmin has no survey here". Cut, not dropped by
    # vertex count -- one of these polygons can run on past his coverage into water he has not
    # driven, and that part is still unsurveyed.
    if (allowed is None or UNSURVEYED in allowed) and layers.get(UNSURVEYED):
        st[UNSURVEYED] = _cut_unsurveyed(layers, survey['coverage'])
    return st


UNSURVEYED = 'unsurveyed'


def _cut_unsurveyed(layers, coverage):
    from shapely.geometry import shape, mapping
    out, cut, gone, removed = [], 0, 0, 0.0
    for f in layers[UNSURVEYED]:
        try:
            g = shape(f['geometry'])
        except Exception:
            out.append(f)
            continue
        if not g.is_valid:
            g = g.buffer(0)
        if not g.intersects(coverage):
            out.append(f)
            continue
        d = g.difference(coverage)
        removed += acres(g) - (acres(d) if not d.is_empty else 0.0)
        parts = [p for p in (getattr(d, 'geoms', None) or [d]) if p.geom_type == 'Polygon' and not p.is_empty]
        if not parts:
            gone += 1
            continue
        cut += 1
        for p in parts:
            out.append({'type': 'Feature', 'properties': dict(f.get('properties') or {}), 'geometry': mapping(p)})
    layers[UNSURVEYED] = out
    return {'cut': cut, 'gone': gone, 'kept': len(out), 'acres_removed': round(removed, 1)}


# ── CLI ─────────────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--slug', required=True)
    ap.add_argument('--qdc', action='append', required=True,
                    help='a folder of his own Quickdraw tiles (the card\'s U folder); repeatable')
    ap.add_argument('--registry', required=True)
    ap.add_argument('--layer', type=int, default=0,
                    help='QDC layer. 0 is the finest his unit writes (about 2.4 m)')
    ap.add_argument('--out', default=None, help='default <registry>\\surveys')
    ap.add_argument('--go', action='store_true', help='write. Default is a dry run.')
    a = ap.parse_args()
    for d in a.qdc:
        if not os.path.isdir(d):
            raise SystemExit('no such folder: %s' % d)
    bpath = os.path.join(a.registry, 'boundaries', a.slug + '.geojson')
    if not os.path.isfile(bpath):
        raise SystemExit('no boundary for %s at %s' % (a.slug, bpath))

    boundary = load_boundary(a.registry, a.slug)
    pts = decode(a.qdc, a.layer)
    res = build(pts, boundary, a.layer)
    s = res['stats']
    if not res['coverage']:
        raise SystemExit('none of the %d soundings is inside %s -- nothing to write' % (s['soundings_in'], a.slug))
    print('%s: %d of %d soundings inside the boundary, %.1f-%.1f ft' % (
        a.slug, s['soundings_inside'], s['soundings_in'], s['depth_ft_min'], s['depth_ft_max']))
    print('   his coverage %.1f of %.1f acres (%d%%); %d depth bands, %d contour lines' % (
        s['coverage_acres'], s['boundary_acres'], round(100 * s['coverage_acres'] / max(s['boundary_acres'], 1e-9)),
        s['bands'], s['contours']))
    if not a.go:
        print('\nDRY RUN -- nothing written. Add --go.')
        return
    from shapely.geometry import mapping
    out = os.path.join(surveys_dir(a.registry, a.out), a.slug)
    os.makedirs(out, exist_ok=True)
    head = {'key': a.slug, 'source': SOURCE, 'generator': 'survey_chart.py', 'note': NOTE}
    for layer in LAYERS:
        with open(os.path.join(out, layer + '.geojson'), 'w', encoding='utf-8') as fh:
            json.dump({'type': 'FeatureCollection', 'properties': dict(head, layer=layer),
                       'features': res[layer]}, fh)
    with open(os.path.join(out, 'coverage.geojson'), 'w', encoding='utf-8') as fh:
        json.dump({'type': 'FeatureCollection', 'properties': dict(head, layer='coverage'),
                   'features': [{'type': 'Feature', 'properties': {},
                                 'geometry': mapping(res['coverage'])}]}, fh)
    meta = dict(s, slug=a.slug, qdc=[os.path.abspath(d) for d in a.qdc],
                built=datetime.datetime.now().isoformat(timespec='seconds'), generator='survey_chart.py',
                note=NOTE)
    with open(os.path.join(out, 'survey.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, indent=1)
    print('-> %s' % out)


if __name__ == '__main__':
    main()
