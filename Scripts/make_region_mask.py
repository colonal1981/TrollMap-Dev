#!/usr/bin/env python3
r"""make_region_mask.py -- turn the four states into a mask the pipeline can actually test against.

    py .\scripts\make_region_mask.py
    py .\scripts\make_region_mask.py --states SC,NC,GA,TN --pad-km 3

Reads the Census TIGER state shapefile already on the drive, keeps the four states TrollMap
serves, and writes `registry/region_mask.json` -- a run-length grid on the SAME 0.002 deg cells
`sweep_unclaimed.py` uses, so "is this cell in the region" is a dict lookup and a binary search.

WHY THIS EXISTS

Nothing in the pipeline has ever tested a water against a state line. The only geographic gate
was `sweep_unclaimed.py --near-km 25`: keep anything within 25 km of a water already in the
registry. That comment argued, correctly, that a per-state BOUNDING BOX is a bad filter, because
South Carolina's box holds chunks of Georgia and North Carolina and the open Atlantic sits inside
every coastal state's box. The conclusion drawn from it was wrong: proximity-to-the-registry is
worse, because it can only ever be as clean as the registry, and the registry is not clean. It
carries `lake_wappapello` (Missouri), `weiss_lake` and `bear_creek_reservoir` (Alabama),
`mount_olive_lake` (Mississippi) and `cowpen_lake` (Florida). Every one of those then pulls in
25 km of its own neighbourhood, so the filter propagated the contamination instead of stopping
it: 282 unclaimed clusters, 69,710 acres, outside all four states.

Ryan, 2026-08-12: *"i dont have any of the infrastructure for the other states in the pipeline or
in trollmap... doesn't make sense to expand... if they are border lakes that is one thing."*

BORDER LAKES ARE THE POINT, SO THE TEST IS "ANY PART", NEVER "THE CENTROID"

Hartwell, Thurmond, Chatuge, Kentucky Lake and the whole Savannah chain straddle a state line. A
centroid test would drop the ones whose middle happens to land on the wrong side, and a centroid
test is the single most expensive mistake in this pipeline's history -- Lake Marion's own
centroid measures 4,160 m outside Lake Marion. So the rule is: **a water is in the region if ANY
of its cells is in the region.** A lake with one foot in Georgia stays. A lake wholly in Alabama
goes.

`--pad-km` grows the mask outward by whole cells. It is 0 by default and should stay there for
land; it exists because TIGER draws a state at its legal boundary and Garmin's soundings do not
stop there, so a sliver of a border lake can sit a few hundred metres outside the line with no
cell inside it. If a known border lake comes back OUT, that is the knob, and the audit prints
what changes.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse, json, math, os, struct, sys

CELL = 0.002          # the grid sweep_unclaimed.py and make_river_boundaries.py already use
DEFAULT_STATES = 'SC,NC,GA,TN'


# ------------------------------------------------------------------ shapefile
# No pyshp on the pipeline box, and the format is 100 bytes of header followed by records, so it
# is read longhand rather than adding a dependency for one file.
def read_dbf(path):
    with open(path, 'rb') as fh:
        head = fh.read(32)
        nrec, hlen, rlen = struct.unpack('<iHH', head[4:12])
        fields = []
        fh.seek(32)
        while True:
            fd = fh.read(32)
            if not fd or fd[0:1] in (b'\r', b''):
                break
            fields.append((fd[0:11].rstrip(b'\x00').decode('latin-1'), fd[16]))
        fh.seek(hlen)
        rows = []
        for _ in range(nrec):
            rec = fh.read(rlen)
            if not rec:
                break
            off, d = 1, {}          # byte 0 is the deletion flag
            for name, size in fields:
                d[name] = rec[off:off + size].decode('latin-1').strip()
                off += size
            rows.append(d)
    return rows


def read_shp_polygons(path, want_indexes):
    """Rings for the requested record indexes, as flat [lon,lat,...] lists."""
    out = {}
    with open(path, 'rb') as fh:
        fh.seek(100)
        i = 0
        while True:
            hdr = fh.read(8)
            if len(hdr) < 8:
                break
            _num, clen = struct.unpack('>ii', hdr)
            body = fh.read(clen * 2)
            if i in want_indexes:
                st, = struct.unpack_from('<i', body, 0)
                if st == 5:                                   # Polygon
                    nparts, npts = struct.unpack_from('<ii', body, 36)
                    parts = struct.unpack_from('<%di' % nparts, body, 44)
                    base = 44 + 4 * nparts
                    xy = struct.unpack_from('<%dd' % (npts * 2), body, base)
                    rings = []
                    for k in range(nparts):
                        a = parts[k]
                        b = parts[k + 1] if k + 1 < nparts else npts
                        rings.append(list(xy[2 * a:2 * b]))
                    out[i] = rings
                else:
                    out[i] = []
            i += 1
    return out


# ------------------------------------------------------------------ rasterise
def scanline(rings, cell):
    """Even-odd scanline fill -> {row: [[x0, x1], ...]} in whole cells, inclusive.

    Edges are walked ONCE and each drops its crossing into only the rows it actually spans, so
    the cost is sum-of-rows-per-edge rather than rows x edges. On the four states that is the
    difference between a second and an afternoon.

    A cell belongs to row `yi` when its CENTRE is in it, matching int(lat / CELL) elsewhere in the
    pipeline -- cell yi covers [yi*cell, (yi+1)*cell) and is sampled at (yi + 0.5) * cell.
    """
    cross = {}
    for r in rings:
        n = len(r) // 2
        for i in range(n):
            j = (i + 1) % n
            x1, y1 = r[2 * i], r[2 * i + 1]
            x2, y2 = r[2 * j], r[2 * j + 1]
            if y1 == y2:
                continue                                   # horizontal: no crossing
            lo, hi = (y1, y2) if y1 < y2 else (y2, y1)
            # rows whose sample line (yi + 0.5) * cell lies in [lo, hi)
            r0 = int(math.ceil(lo / cell - 0.5))
            r1 = int(math.ceil(hi / cell - 0.5)) - 1
            for yi in range(r0, r1 + 1):
                yc = (yi + 0.5) * cell
                if yc < lo or yc >= hi:
                    continue
                cross.setdefault(yi, []).append(x1 + (x2 - x1) * (yc - y1) / (y2 - y1))
    rows = {}
    for yi, xs in cross.items():
        xs.sort()
        spans = []
        for k in range(0, len(xs) - 1, 2):
            xa, xb = xs[k], xs[k + 1]
            c0 = int(math.ceil(xa / cell - 0.5))
            c1 = int(math.ceil(xb / cell - 0.5)) - 1
            if c1 < c0:
                continue
            if spans and c0 <= spans[-1][1] + 1:
                spans[-1][1] = max(spans[-1][1], c1)
            else:
                spans.append([c0, c1])
        if spans:
            rows[yi] = spans
    return rows


def merge(a, b):
    for yi, spans in b.items():
        a.setdefault(yi, []).extend(spans)
    return a


def normalise(rows):
    for yi, spans in rows.items():
        spans.sort()
        out = [spans[0]]
        for s in spans[1:]:
            if s[0] <= out[-1][1] + 1:
                out[-1][1] = max(out[-1][1], s[1])
            else:
                out.append(s)
        rows[yi] = out
    return rows


def pad(rows, n):
    """Grow the mask outward by n cells in every direction."""
    if n <= 0:
        return rows
    grown = {}
    for yi, spans in rows.items():
        for dy in range(-n, n + 1):
            grown.setdefault(yi + dy, []).extend([[s[0] - n, s[1] + n] for s in spans])
    return normalise(grown)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--shp', default=os.path.join('PADUS4_1Geodatabase', 'tl_2022_us_state.shp'))
    ap.add_argument('--out', default=os.path.join('registry', 'region_mask.json'))
    ap.add_argument('--states', default=DEFAULT_STATES)
    ap.add_argument('--cell', type=float, default=CELL)
    ap.add_argument('--pad-km', type=float, default=0.0)
    a = ap.parse_args()

    want = [s.strip().upper() for s in a.states.split(',') if s.strip()]
    dbf = a.shp[:-4] + '.dbf'
    for p in (a.shp, dbf):
        if not os.path.exists(p):
            sys.exit('missing %s' % p)

    recs = read_dbf(dbf)
    key = 'STUSPS' if recs and 'STUSPS' in recs[0] else 'STATE'
    idx = {i: r[key] for i, r in enumerate(recs) if r.get(key) in want}
    missing = sorted(set(want) - set(idx.values()))
    if missing:
        sys.exit('%s not found in %s -- field %s holds %s'
                 % (', '.join(missing), os.path.basename(dbf), key,
                    ', '.join(sorted({r.get(key, '') for r in recs})[:8])))
    print('%s -> record(s) %s' % (', '.join(idx.values()), ', '.join(str(i) for i in idx)))

    polys = read_shp_polygons(a.shp, set(idx))
    rows = {}
    for i, st in idx.items():
        rings = polys.get(i) or []
        pts = sum(len(r) // 2 for r in rings)
        got = scanline(rings, a.cell)
        cells = sum(s[1] - s[0] + 1 for spans in got.values() for s in spans)
        print('  %-3s %5d ring(s) %8d point(s) -> %9s cell(s)'
              % (st, len(rings), pts, format(cells, ',')))
        merge(rows, got)
    rows = normalise(rows)

    npad = int(round(a.pad_km / 111.32 / a.cell))
    if npad:
        rows = pad(rows, npad)
        print('padded outward %d cell(s) (~%.1f km)' % (npad, a.pad_km))

    cells = sum(s[1] - s[0] + 1 for spans in rows.values() for s in spans)
    spans = sum(len(v) for v in rows.values())
    ys = [int(y) for y in rows]
    xs = [s[0] for v in rows.values() for s in v] + [s[1] for v in rows.values() for s in v]
    print('%s cell(s) in %s span(s) over %d row(s)'
          % (format(cells, ','), format(spans, ','), len(rows)))
    print('bbox  lon %.4f .. %.4f   lat %.4f .. %.4f'
          % (min(xs) * a.cell, (max(xs) + 1) * a.cell, min(ys) * a.cell, (max(ys) + 1) * a.cell))
    print('area  %s km2 at this latitude band (sanity: SC+NC+GA+TN is about 500,000)'
          % format(int(cells * (a.cell * 111.32) ** 2 * math.cos(math.radians(34))), ','))

    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    json.dump({'cell': a.cell, 'states': want, 'pad_km': a.pad_km,
               'source': os.path.basename(a.shp),
               'rows': {str(k): v for k, v in sorted(rows.items())}},
              open(a.out, 'w'))
    print('-> %s (%.1f MB)' % (a.out, os.path.getsize(a.out) / 1e6))
    return 0


if __name__ == '__main__':
    sys.exit(main())
