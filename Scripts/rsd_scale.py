#!/usr/bin/env python3
"""rsd_scale.py - solve feet-per-sample by fitting the RSD's bottom against Quickdraw.

Personal use only, not for distribution or resale; not for navigation.

The recording gives a bottom in SAMPLES for every ping, and nothing in the header is the depth --
every float was checked against the measured bottom and none tracks it. So the scale has to be
fitted, and it should not be fitted to one number off a photograph of a screen.

Ryan already has the right reference on disk. `wateree_community.csv` is the Quickdraw community
bathymetry for this lake -- longitude, latitude, depth in METRES, about a million points -- and
the recording's 84,516 fixes sit inside it. Snap each ping to the Quickdraw cell it falls in,
regress metres against samples, and the slope is the scale, measured over thousands of points
instead of asserted.

Two things this fit cannot fix and does not pretend to. Quickdraw community data was recorded by
other people at other lake levels, and Wateree moves; and a cell is tens of feet across while a
ping is inches. Both add scatter rather than bias, which is why the fit wants thousands of points
and reports its own spread.
"""
import argparse, collections, csv, math, statistics as st


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('track', help='rsd_track CSV: lat, lon, bottom_sample')
    ap.add_argument('qdc', help='wateree_community.csv: X, Y, Depth(m)')
    ap.add_argument('--cell', type=float, default=0.0001, help='degrees, ~36 ft')
    ap.add_argument('--samples', type=int, default=1576, help='samples per down ping')
    ap.add_argument('--known-ft', type=float, default=None,
                    help='a depth read off the unit, for a second opinion')
    ap.add_argument('--known-sample', type=float, default=None)
    a = ap.parse_args()

    grid = collections.defaultdict(list)
    n = 0
    with open(a.qdc, newline='') as f:
        for row in csv.DictReader(f):
            try:
                x = float(row['X']); y = float(row['Y']); d = float(row['Depth(m)'])
            except (KeyError, ValueError):
                continue
            grid[(round(y / a.cell), round(x / a.cell))].append(d)
            n += 1
    print('%d Quickdraw points in %d cells' % (n, len(grid)))
    cell_mean = {k: st.mean(v) for k, v in grid.items()}

    xs, ys = [], []
    matched = miss = 0
    with open(a.track, newline='') as f:
        rows = [l for l in f if not l.startswith('#')]
    for row in csv.DictReader(rows):
        b = row.get('bottom_sample')
        if not b:
            continue
        try:
            lat = float(row['lat']); lon = float(row['lon']); bs = float(b)
        except ValueError:
            continue
        k = (round(lat / a.cell), round(lon / a.cell))
        if k in cell_mean:
            xs.append(bs); ys.append(cell_mean[k]); matched += 1
        else:
            miss += 1
    print('%d pings matched a Quickdraw cell, %d fell outside' % (matched, miss))
    if matched < 100:
        print('not enough overlap to fit'); return 1

    mx, my = st.mean(xs), st.mean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = sum((x - mx) ** 2 for x in xs) or 1
    slope = num / den                       # metres per sample
    icept = my - slope * mx
    r = num / math.sqrt(den * (sum((y - my) ** 2 for y in ys) or 1))
    ft_per_sample = slope * 3.28084
    print('\nfit: depth_m = %.6g * samples + %.4f   (r = %+.3f over %d points)'
          % (slope, icept, r, matched))
    print('     %.6g metres per sample  =  %.6g FEET PER SAMPLE' % (slope, ft_per_sample))
    print('     a full %d-sample ping is %.1f ft of range' % (a.samples, ft_per_sample * a.samples))
    resid = [abs((slope * x + icept) - y) * 3.28084 for x, y in zip(xs, ys)]
    print('     residual: median %.2f ft, p90 %.2f ft'
          % (st.median(resid), sorted(resid)[int(len(resid) * .9)]))
    print('\n     mean bottom %.0f samples -> %.1f ft' % (mx, (slope * mx + icept) * 3.28084))
    if a.known_ft and a.known_sample:
        print('     the unit read %.1f ft; this fit puts %d samples at %.1f ft'
              % (a.known_ft, a.known_sample,
                 (slope * a.known_sample + icept) * 3.28084))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
