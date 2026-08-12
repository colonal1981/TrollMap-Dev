#!/usr/bin/env python3
r"""in_region.py -- "is this water in the four states", asked the same way everywhere.

    from in_region import Region
    reg = Region.load()                       # registry/region_mask.json
    reg.inside(-81.03, 34.05)                 # one point
    reg.any_inside([(lon, lat), ...])         # a water: ANY part counts

    py .\scripts\in_region.py --check -81.03,34.05 -87.94,34.44
    py .\scripts\in_region.py --audit-registry

WHY "ANY PART"

TrollMap serves SC, NC, GA and TN, and the pipeline has infrastructure for exactly those four --
DNR ramp feeds, gauge bindings, proclamation rules. Nothing else has any. But Hartwell, Thurmond,
Chatuge, Kentucky Lake and most of the Savannah chain straddle a state line, and Ryan,
2026-08-12: *"if they are border lakes that is one thing."*

So a water is in the region when ANY of its cells is, never when its centroid is. That is not a
style preference. Lake Marion's own registry centroid measures 4,160 m OUTSIDE Lake Marion's own
3DHP polygon, and Kentucky Lake's is 860 m outside its own; a centroid test would have thrown
away real border lakes and called it cleaning.

WHAT IT COSTS TO GET THIS WRONG THE OTHER WAY

`sweep_unclaimed.py`'s only geographic gate was "within 25 km of something already in the
registry". The registry carries `lake_wappapello` (Missouri), `weiss_lake` (Alabama),
`mount_olive_lake` (Mississippi), `cowpen_lake` (Florida) -- so the filter inherited the
contamination and passed 282 clusters and 69,710 acres of out-of-region water.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse, bisect, json, os, sys

DEFAULT_MASK = os.path.join('registry', 'region_mask.json')


class Region:
    __slots__ = ('cell', 'states', 'rows', 'path', 'pad_km')

    def __init__(self, cell, states, rows, path='', pad_km=0.0):
        self.cell = cell
        self.states = states
        self.rows = rows
        self.path = path
        self.pad_km = pad_km

    @classmethod
    def load(cls, path=DEFAULT_MASK, required=True):
        """Returns None when the mask is absent and `required` is False. Callers that get None
        MUST say so out loud -- a region filter that silently does nothing is the exact shape of
        bug this file was written to end."""
        if not os.path.exists(path):
            if required:
                sys.exit('no region mask at %s -- build it with make_region_mask.py' % path)
            return None
        blob = json.load(open(path, encoding='utf-8'))
        rows = {}
        for k, spans in blob['rows'].items():
            spans.sort()
            rows[int(k)] = ([s[0] for s in spans], [s[1] for s in spans])
        return cls(blob['cell'], blob.get('states') or [], rows, path,
                   blob.get('pad_km') or 0.0)

    def cell_inside(self, cx: int, cy: int) -> bool:
        row = self.rows.get(cy)
        if not row:
            return False
        starts, ends = row
        i = bisect.bisect_right(starts, cx) - 1
        return i >= 0 and cx <= ends[i]

    def inside(self, lon: float, lat: float) -> bool:
        return self.cell_inside(int(lon // self.cell), int(lat // self.cell))

    def any_inside(self, pts) -> bool:
        """pts: an iterable of (lon, lat). True as soon as one lands in the region."""
        for lon, lat in pts:
            if self.inside(lon, lat):
                return True
        return False

    def describe(self) -> str:
        cells = sum(e - s + 1 for starts, ends in self.rows.values()
                    for s, e in zip(starts, ends))
        return ('region: %s, %s cell(s) of %.3f deg from %s%s'
                % ('+'.join(self.states), format(cells, ','), self.cell,
                   os.path.basename(self.path),
                   ', padded %.1f km' % self.pad_km if self.pad_km else ''))


def _pts_for(rec, bdir):
    """Every point that speaks for a registry row: its boundary if there is one, else the corners
    and centre of its bounds. A boundary is authoritative; bounds are the fallback and they
    OVERSTATE reach, which is the safe direction for a keep test."""
    slug = rec.get('slug')
    if slug and bdir:
        p = os.path.join(bdir, '%s.geojson' % slug)
        if os.path.exists(p):
            try:
                g = json.load(open(p, encoding='utf-8'))
            except Exception:
                g = None
            if g:
                out, stack = [], [g.get('geometry') or g]
                while stack:
                    v = stack.pop()
                    if isinstance(v, dict):
                        stack.extend([v.get('coordinates'), v.get('geometry'),
                                      v.get('features'), v.get('geometries')])
                    elif isinstance(v, (list, tuple)):
                        if len(v) >= 2 and isinstance(v[0], (int, float)) \
                                and isinstance(v[1], (int, float)):
                            out.append((v[0], v[1]))
                        else:
                            stack.extend(v)
                if out:
                    return out, 'boundary'
    b = rec.get('bounds_wsen')
    if isinstance(b, list) and len(b) == 4:
        w, s, e, n = b
        return ([(w, s), (e, s), (w, n), (e, n), ((w + e) / 2, (s + n) / 2)], 'bounds')
    c = rec.get('centroid')
    if isinstance(c, list) and len(c) == 2:
        return ([(c[0], c[1])], 'centroid-only')
    return ([], 'nothing')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--mask', default=DEFAULT_MASK)
    ap.add_argument('--check', nargs='*', default=None, help='LON,LAT ...')
    ap.add_argument('--audit-registry', action='store_true')
    ap.add_argument('--index', default=os.path.join('registry', 'lake_index.json'))
    ap.add_argument('--boundaries', default=os.path.join('registry', 'boundaries'))
    ap.add_argument('--out', default='')
    a = ap.parse_args()

    reg = Region.load(a.mask)
    print(reg.describe())

    if a.check:
        for s in a.check:
            lon, lat = [float(v) for v in s.replace(' ', '').split(',')]
            print('  %10.5f, %9.5f  %s' % (lon, lat, 'IN' if reg.inside(lon, lat) else 'OUT'))

    if a.audit_registry:
        idx = json.load(open(a.index, encoding='utf-8'))
        recs = idx if isinstance(idx, list) else list(idx.values())
        keep, drop, weak = [], [], 0
        for r in recs:
            pts, how = _pts_for(r, a.boundaries)
            if how in ('centroid-only', 'nothing'):
                weak += 1
            (keep if reg.any_inside(pts) else drop).append((r, how, len(pts)))
        print('\n%d registry row(s): %d touch the region, %d do NOT'
              % (len(recs), len(keep), len(drop)))
        if weak:
            print('!! %d row(s) had no boundary and no bounds_wsen, so only a centroid spoke for '
                  'them -- that is the weak test' % weak)
        drop.sort(key=lambda t: -(t[0].get('area_acres') or 0))
        print('\nNOT in %s, biggest first:' % '+'.join(reg.states))
        for r, how, n in drop[:40]:
            c = r.get('centroid') or [0, 0]
            print('  %10s ac  %-38s %8.4f,%9.4f  (%s, %d pt)'
                  % (format(int(r.get('area_acres') or 0), ','), (r.get('slug') or '?')[:38],
                     c[1], c[0], how, n))
        if len(drop) > 40:
            print('  ... and %d more' % (len(drop) - 40))
        if a.out:
            json.dump([r.get('slug') for r, _, _ in drop], open(a.out, 'w'), indent=1)
            print('\n-> %s' % a.out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
