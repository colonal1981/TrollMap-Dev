#!/usr/bin/env python3
r"""
coastal_preview.py — draw what the coastal cut WOULD do, before anything is written.

Personal use only, not for distribution or resale; not for navigation.

2026-08-09. Ryan, after being asked to approve a cut he could not see:

    "is there a way for you to show me what it will look like so i can tell you if it is good
     or bad... i do not want to ship 18 zones... there are 22 that need to be shipped"

Three zones had already been caught by eye that no measurement here caught -- Albemarle and
Pamlico have no Atlantic in their box at all, and the Outer Banks needed its sea found by edge
rather than by size. Numbers did not distinguish those from a correct cut. A picture does.

Appends one record per zone to a JSON file so it can be run a few zones at a time, then
`--html` renders the lot into a single self-contained page.
"""
import argparse, glob, importlib.util, json, os, sys

def load_pinch(path):
    spec = importlib.util.spec_from_file_location('cp', path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--packs', required=True)
    ap.add_argument('--feeds', required=True)
    ap.add_argument('--radius-km', type=float, default=2.0)
    ap.add_argument('--only')
    ap.add_argument('--out', required=True)
    ap.add_argument('--simplify', type=int, default=3)
    a = ap.parse_args()
    cp = load_pinch(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'coastal_pinch.py'))

    store = {}
    if os.path.exists(a.out):
        store = json.load(open(a.out, encoding='utf-8'))

    ramps = []
    for f in (glob.glob(os.path.join(a.feeds, '_dnr_ramps_*.json'))
              + glob.glob(os.path.join(a.feeds, '_dnr_paddle_*.json'))):
        try:
            d = json.load(open(f, encoding='utf-8'))
        except Exception:
            continue
        for wb, ps in (d.get('waterbodies') or {}).items():
            for p in (ps if isinstance(ps, list) else []):
                if p.get('lat') and p.get('lon'):
                    ramps.append([float(p['lat']), float(p['lon']), p.get('name') or '?'])

    want = {x.strip() for x in (a.only or '').split(',') if x.strip()}
    for z in sorted(glob.glob(os.path.join(a.packs, 'coast_*'))):
        slug = os.path.basename(z)
        if want and slug not in want:
            continue
        bfp = os.path.join(a.feeds, 'boundaries', '%s.geojson' % slug)
        rect = cp.boundary_bbox(bfp)
        rec = {'slug': slug, 'rect': rect, 'radius_km': a.radius_km,
               'skipped': None, 'keep': [], 'cut': [], 'ramps': []}
        if slug in getattr(cp, 'NOT_WORTH_CUTTING', set()):
            rec['skipped'] = 'not worth cutting -- left alone'
        elif slug in cp.NO_ATLANTIC:
            rec['skipped'] = 'no open Atlantic in this box -- left alone'
        else:
            wg = cp.water_grid(z, include_bbox=rect)
            if wg is None:
                rec['skipped'] = 'no contours or depth areas'
            else:
                rpx = [(int((r[0] - wg['y0']) * wg['sy']), int((r[1] - wg['x0']) * wg['sx']))
                       for r in ramps]
                m, why = cp.ocean_mask(wg, a.radius_km * 1000.0,
                                       cp.OCEAN_EDGE.get(slug), rpx)
                if m is None:
                    rec['skipped'] = why
                else:
                    zone = cp.rasterise_boundary(bfp, wg)
                    if zone is None:
                        rec['skipped'] = 'no boundary to intersect with'
                    else:
                        rec['keep'] = cp.trace_keep(zone & ~m, wg, a.simplify)
                        rec['cut'] = cp.trace_keep(zone & m, wg, a.simplify)
                        rec['edge'] = cp.OCEAN_EDGE.get(slug)
        if rect:
            w, s, e, n = rect
            rec['ramps'] = [r for r in ramps if w <= r[1] <= e and s <= r[0] <= n]
        store[slug] = rec
        print('  %-32s %s' % (slug, rec['skipped'] or
              ('keep %d part(s), cut %d part(s), %d landings'
               % (len(rec['keep']), len(rec['cut']), len(rec['ramps'])))))
    json.dump(store, open(a.out, 'w', encoding='utf-8'))
    print('-> %s  (%d zone(s) recorded)' % (a.out, len(store)))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
