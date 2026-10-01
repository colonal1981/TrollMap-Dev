#!/usr/bin/env python3
"""sonar_depths.py -- where the fish marks were by depth on one trip, against the plan's band.

Personal use only, not for distribution or resale; not for navigation.

Ryan, 2026-10-01. Asked what would help the plan most, I offered to read each trip's sonar for where
the bigger marks were thickest against the plan's band. He: "on wateree there was fish pretty much
all day long on the sonar... so i think it would turn into noise", and then "#1 we can build the
script". So this is a script, run on a trip's folder, and it answers one question: at what depth
were the marks thickest, against the depth the plan said. It does not say whether fish were there.
On 9/26 and 9/28 they were there all day; what the recordings added was the depth.

    python Scripts/sonar_depths.py F:\\TrollMapPipeline\\28Sep26_Trip [--plan plan.json]

READS, from the folder: every *.RSD (Garmin sonar recording) and the unit's *EXPORT*.GPX (its
ACTIVE LOG, and the plan's legs if they were loaded on the unit). From --plan, the JSON the app
exports with "JSON": the fish band, each leg's line and what the baits ran at. WRITES
sonar_depths_<date>.txt beside them. Never writes to a recording.

EVERY RULE BELOW WAS MEASURED ON HIS OWN RECORDINGS, and each says where:
  - Decoding is Scripts/rsd_track.py's and _scratch/rsd_down3.py's: the AC 8E F9 trailer, the
    channel byte at body+14, lat/lon tags 0x4c/0x54, clock 0x2c (ms since the file began), the
    sample start after an 81-83 byte header. The down channel is the one whose blocks are a
    different length from the other two, which are the side beams (THE_DEPTH_WAS_IN_EVERY_PING,
    2026-09-26: "Do not hard-code 5").
  - Depth and span are in every ping's header: ft = 0.0016321 * v + 0.083 (same page; matched the
    track log's depth to a median 0.05 ft on 9/28).
  - The clock is aligned to the ACTIVE LOG by position: the file's name gives the minute it began,
    and the offset that puts the pings on the track is searched from a minute before to two after.
    Misread clocks (2-3% of pings) are found by a running median and interpolated (9/26).
  - A FISH MARK, from THE_DEEP_WATER_WAS_NOT_EMPTY (2026-09-28): a cell at or above the bar, where
    the bar is the brightest plain water in this recording -- at each 1 ft depth from 4 to 28 ft, the
    99th percentile of the quietest tenth of 40 s stretches. That rises with the unit's gain and
    levels off; the bar is where it levels, the median of the deeper half of those depths. 9/28 read
    3.8 off one file; it is measured on each recording again, because a range or gain change moves
    it. Cells are counted from 3.5 ft (where the recording begins: quiet water below that is stored
    as 0, and is water, 9/28) to 2 ft off the unit's bottom. Joined cells are a mark; one lasting 4
    or more pings and no taller than 3 ft is arch-like (a fish or a tight school).
  - THE BIGGER MARKS are the brightest quarter of the day's arch-like marks by their peak. Brighter
    is likelier a bigger fish, or a tight school; a count cannot tell those apart (9/26).
  - PER VOLUME OF WATER. The beam is narrow at the transducer and wide at depth, so a layer at 20 ft
    is swept four times as wide as one at 5 ft. Marks per 100 m trolled over water that has the
    layer, divided by the layer's depth, compare fish per volume (9/28). 2 ft layers from 3.5 ft.
  - WHERE THEY WERE THICKEST is said against the plan's band: the densest stretch of water as deep
    as the band is wide (10 ft for a 20-30 ft band), pooled, so a few marks in a thin layer cannot
    carry it; and the band against the water above it and below it.
  - TROLLING SPEED ONLY. At full throttle a fish passes in fewer pings and draws as a dim tick
    (9/28: the bright echoes fell fivefold the moment he throttled up). The line is the plan's own
    transit speed when a plan is given, and 3 mph without one (9/28's).
  - ON A LEG means within 25 m of its line: he has no GPS steering and wanders +/-25 m
    (js/modules/plan-water.js).
"""
import argparse, glob, json, os, re, struct, sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

import numpy as np
from scipy import ndimage

try:
    from zoneinfo import ZoneInfo
    EASTERN = ZoneInfo('America/New_York')
except Exception:                                   # no tz database: EDT, which is fishing season
    EASTERN = timezone(timedelta(hours=-4))

# ── decoding (rsd_down3.py) ────────────────────────────────────────────────────────────────────
MARK = bytes.fromhex('ac8ef9')
TRAILER, CH = 11, 14
SC = 180.0 / 2 ** 31
TAG_CLOCK, TAG_LAT, TAG_LON, TAG_TEMP = 0x2c, 0x4c, 0x54, 0x5c
DS, WIDTH = 4, 600
FT = lambda v: 0.0016321 * v + 0.083


def blocks(path, limit=None):
    """Yield (channel, body) for each block, in order. `limit` stops after that many bytes."""
    with open(path, 'rb') as fh:
        carry, base, prev, read = b'', 0, None, 0
        while True:
            chunk = fh.read(1 << 24)
            if not chunk:
                return
            read += len(chunk)
            buf = carry + chunk
            i = buf.find(MARK)
            while 0 <= i <= len(buf) - 11:
                p = base + i
                ln = struct.unpack_from('<I', buf, i + 3)[0]
                if prev is not None and ln == p - prev:
                    bs = prev - base + TRAILER
                    if 0 <= bs and i - bs > CH + 1:
                        yield buf[bs + CH], buf[bs:i]
                prev = p
                i = buf.find(MARK, i + 1)
            keep = max(0, len(buf) - 11)
            carry, base = buf[keep:], base + keep
            if limit and read >= limit:
                return


def down_channel(path):
    """The channel whose blocks are not the side beams' length. Read off the first 64 MB."""
    lens = defaultdict(Counter)
    for ch, body in blocks(path, limit=64 << 20):
        lens[ch][len(body)] += 1
    mode = {ch: c.most_common(1)[0][0] for ch, c in lens.items() if sum(c.values()) > 50}
    if len(mode) == 1:
        return next(iter(mode))
    by_len = Counter(mode.values())
    odd = [ch for ch, n in mode.items() if by_len[n] == 1]
    # Three channels: two side beams of one length, one down beam of another.
    if len(odd) == 1:
        return odd[0]
    # Otherwise the shortest: the side beams carry 2,048 samples, the down beam fewer.
    return min(mode, key=mode.get)


def varint(h, at):
    val, sh = 0, 0
    for b in h[at:at + 4]:
        val |= (int(b) & 0x7f) << sh
        sh += 7
        if not b & 0x80:
            break
    return val


def tag_at(body, tag, upto=400):
    for o in range(min(upto, len(body) - 5)):
        if body[o] == tag:
            return o + 1
    return None


def find_fix(body, upto=400):
    for o in range(min(upto, len(body) - 10)):
        if body[o] != TAG_LAT or body[o + 5] != TAG_LON:
            continue
        lat = struct.unpack_from('<i', body, o + 1)[0] * SC
        lon = struct.unpack_from('<i', body, o + 6)[0] * SC
        if -90 <= lat <= 90 and -180 <= lon <= 180 and (lat or lon):
            return lat, lon
    return None


def decode(path, ch):
    rows, cols = [], []
    for c, body in blocks(path):
        if c != ch or len(body) < 1100:
            continue
        fix = find_fix(body)
        if fix is None:
            continue
        t1 = body[40]
        if t1 not in (0x0a, 0x0b):
            continue
        k2 = 43 if t1 == 0x0a else 44
        t2 = body[k2]
        k4 = k2 + (3 if t2 == 0x12 else 4) + 2
        t4 = body[k4]
        D = FT(varint(body, 41))
        R = FT(varint(body, k4 + 1)) if t4 in (0x22, 0x23) else np.nan
        st0 = 79 + (t1 == 0x0b) + (t2 == 0x13) + (t4 == 0x23)
        s = np.frombuffer(body, dtype='<u2', offset=st0, count=(len(body) - st0) // 2)
        co, to = tag_at(body, TAG_CLOCK), tag_at(body, TAG_TEMP)
        clk = struct.unpack_from('<I', body, co)[0] if co else 0
        tmp = struct.unpack_from('<f', body, to)[0] if to else np.nan
        m = (s.size // DS) * DS
        col = np.zeros(WIDTH, np.uint16)
        v = s[:m].reshape(-1, DS).mean(axis=1)[:WIDTH]
        col[:v.size] = v
        rows.append((clk, fix[0], fix[1], tmp, len(body), D, R))
        cols.append(col)
    a = np.array(rows, dtype=float)
    return {'clock': a[:, 0], 'lat': a[:, 1], 'lon': a[:, 2], 'temp': a[:, 3], 'n': a[:, 4],
            'D': a[:, 5], 'R': a[:, 6], 'cols': np.stack(cols)}


def fix_clock(c):
    """Misread clocks: a 501-ping running median, and anything 5 s off it interpolated (9/28)."""
    c = c.astype(float).copy()
    c[c > 1e8] = np.nan
    k, h = 501, 250
    pad = np.pad(c, h, mode='edge')
    med = np.array([np.nanmedian(pad[i:i + k]) for i in range(0, len(c), 50)])
    med = np.interp(np.arange(len(c)), np.arange(0, len(c), 50), med)
    bad = ~np.isfinite(c) | (np.abs(c - med) > 5000)
    ix = np.arange(len(c))
    if (~bad).sum() > 1:
        c[bad] = np.interp(ix[bad], ix[~bad], c[~bad])
    return c, int(bad.sum())


# ── the unit's track and the plan ─────────────────────────────────────────────────────────────

def read_gpx(path):
    with open(path, encoding='utf-8', errors='replace') as fh:
        s = fh.read()
    log, legs = [], {}
    for m in re.finditer(r'<trk>\s*<name>([^<]*)</name>(.*?)</trk>', s, re.S):
        name, body = m.group(1).strip(), m.group(2)
        if '<time>' in body:
            for p in re.finditer(r'<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"[^>]*>(.*?)</trkpt>', body, re.S):
                tm = re.search(r'<time>([^<]+)</time>', p.group(3))
                if tm:
                    t = datetime.fromisoformat(tm.group(1).replace('Z', '+00:00')).timestamp()
                    log.append((t, float(p.group(1)), float(p.group(2))))
        else:
            leg = re.match(r'(L\d+)\b', name)
            if leg:
                xy = [(float(a), float(b)) for a, b in re.findall(r'<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"', body)]
                legs[leg.group(1)] = {'name': name, 'pts': xy}
    log.sort()
    return np.array(log), legs


def read_plan(path):
    with open(path, encoding='utf-8') as fh:
        j = json.load(fh)
    plan = j.get('plan') or {}
    band = ((plan.get('conditions') or {}).get('depthBand') or {}).get('ft') or (j.get('trolling') or {}).get('speciesBandFt')
    transit = [s.get('speedMph') for s in (j.get('trolling') or {}).get('legSpeeds', []) if s.get('type') == 'transit']
    legs = {}
    for t in (j.get('gpx') or {}).get('trackList', []):
        m = re.match(r'(L\d+)\b', t.get('name', ''))
        if m:
            legs[m.group(1)] = {'name': t['name'], 'pts': [tuple(p) for p in t.get('pts', [])]}
    baits = {}
    for e in j.get('timeline') or []:
        if e.get('legType') == 'troll' and e.get('legId'):
            baits[e['legId']] = [f"{r.get('rod')} {r.get('lure')} {r.get('depth')} ft" for r in e.get('rods', [])]
    meta = j.get('meta') or {}
    return {'band': band, 'transit': min(transit) if transit else None, 'legs': legs, 'baits': baits,
            'name': meta.get('name'), 'date': meta.get('date')}


def start_of(path):
    m = re.search(r'(\d{2})([A-Z]{3})(\d{2})-(\d{2})(\d{2})', os.path.basename(path).upper())
    if not m:
        return None
    mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].index(m.group(2)) + 1
    local = datetime(2000 + int(m.group(3)), mon, int(m.group(1)), int(m.group(4)), int(m.group(5)), tzinfo=EASTERN)
    return local.timestamp()


def metres(lat, lon, lat0):
    return np.asarray(lon) * 111320 * np.cos(np.radians(lat0)), np.asarray(lat) * 111320


def align(d, t0, log):
    """The offset (s) that puts the pings on the ACTIVE LOG, and the median gap there (m)."""
    if t0 is None or len(log) < 2:
        return 0.0, None
    sub = np.arange(0, len(d['clock']), 50)
    lat0 = np.nanmedian(d['lat'])
    best = None
    for off in np.arange(-60, 120.01, 0.5):
        t = t0 + off + d['clock'][sub] / 1000
        inside = (t > log[0, 0]) & (t < log[-1, 0])
        if inside.sum() < 10:
            continue
        la = np.interp(t[inside], log[:, 0], log[:, 1])
        lo = np.interp(t[inside], log[:, 0], log[:, 2])
        x1, y1 = metres(la, lo, lat0)
        x2, y2 = metres(d['lat'][sub][inside], d['lon'][sub][inside], lat0)
        gap = float(np.median(np.hypot(x1 - x2, y1 - y2)))
        if best is None or gap < best[0]:
            best = (gap, float(off))
    return (best[1], best[0]) if best else (0.0, None)


def dist_to_line(px, py, line):
    """Each point's distance (m) to a polyline, in the same metres."""
    lx, ly = line
    best = np.full(len(px), np.inf)
    for i in range(len(lx) - 1):
        ax, ay, bx, by = lx[i], ly[i], lx[i + 1], ly[i + 1]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        u = np.clip(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1) if L2 > 0 else 0
        best = np.minimum(best, np.hypot(px - (ax + u * dx), py - (ay + u * dy)))
    return best


# ── the water column ──────────────────────────────────────────────────────────────────────────

def column(d, dz=0.1):
    """log10 of each ping's samples on one feet axis, and where each ping's recording begins."""
    zmax = float(np.nanmax(d['D'])) + 1
    Z = np.arange(0, zmax, dz) + dz / 2
    n = len(d['D'])
    E = np.full((n, len(Z)), np.nan, np.float16)
    top = np.full(n, np.nan)
    ns = (d['n'] - 80) // 2
    fps = d['R'] / ns
    for i in range(n):
        if not np.isfinite(fps[i]) or fps[i] <= 0:
            continue
        k = int(min(ns[i] // DS, WIDTH))
        c = d['cols'][i, :k].astype(np.float32)
        zc = (np.arange(k) * DS + 1.5) * fps[i]
        m = Z <= zc[-1]
        E[i, m] = np.interp(Z[m], zc, np.log10(np.clip(c, 1, None)))
        nz = np.nonzero(c > 0)[0]
        top[i] = zc[nz[0]] if nz.size else np.nan
    return Z, E, top


def measure_bar(Z, E, D, top, tsec):
    """The brightest plain water: per 1 ft layer from 4 to 28 ft, the 99th percentile of the cells in
    the quietest tenth of 40 s stretches; the highest of those."""
    win = np.floor((tsec - tsec[0]) / 40).astype(int)
    prof = []
    for z0 in range(4, 28):
        zz = (Z >= z0) & (Z < z0 + 1)
        ok = (D - 2 >= z0 + 1)
        if ok.sum() < 1000:
            continue
        L = E[:, zz][ok].astype(np.float32)
        w = win[ok]
        means = defaultdict(list)
        for k, v in zip(w, np.nanmean(L, axis=1)):
            means[k].append(v)
        wm = {k: np.nanmean(v) for k, v in means.items() if len(v) >= 10}
        if len(wm) < 10:
            continue
        q = np.nanpercentile(list(wm.values()), 10)
        quiet = np.isin(w, [k for k, v in wm.items() if v <= q])
        prof.append((z0, float(np.nanpercentile(L[quiet], 99))))
    if not prof:
        return None, prof
    deep = [p for _, p in prof[len(prof) // 2:]]
    return float(np.median(deep)), prof


def marks_in(Z, E, D, top, bar):
    valid = (Z[None, :] >= ZTOP) & (Z[None, :] <= D[:, None] - 2.0) & np.isfinite(E)
    Ef = np.nan_to_num(E.astype(np.float32))
    tgt = valid & (Ef >= bar)
    lab, n = ndimage.label(tgt, structure=np.ones((3, 3)))
    del tgt
    if not n:
        return [], valid
    peak = ndimage.maximum(Ef, lab, index=np.arange(1, n + 1))
    del Ef
    out = []
    for j, s in enumerate(ndimage.find_objects(lab)):
        p0, p1, z0, z1 = s[0].start, s[0].stop, s[1].start, s[1].stop
        tall = Z[z1 - 1] - Z[z0] + (Z[1] - Z[0])
        if (p1 - p0) < 4 or tall > 3.0:
            continue
        sub = lab[s] == j + 1
        zc = Z[z0:z1][np.argmax(sub.sum(axis=0))]
        out.append(((p0 + p1) // 2, float(zc), float(peak[j])))
    return out, valid


# ── the report ────────────────────────────────────────────────────────────────────────────────
ZTOP = 3.5
LAYERS = np.arange(ZTOP, 80, 2.0)


def table(acc, keys):
    """Per volume by layer, the day's average = 1.00: rows [(z0, km, n_all, n_big)], rel {key: [..]}.

    Marks per 100 m swept over water that has the layer, divided by the layer's depth (the cone)."""
    sel = acc['dist'] > 0
    vol = acc['dist'] / 100 * (LAYERS + 1)
    rows = [(LAYERS[i], acc['dist'][i] / 1000, *[int(acc[k][i]) for k in keys]) for i in np.nonzero(sel)[0]]
    rel = {}
    for k in keys:
        avg = acc[k][sel].sum() / vol[sel].sum() if vol[sel].sum() > 0 else 0
        rel[k] = [(acc[k][i] / vol[i]) / avg if avg > 0 else 0 for i in np.nonzero(sel)[0]]
    return rows, rel


def ft(v):
    return f'{v:g}'


def summary(acc, k, band):
    """Where `k` marks were, against the band, per volume and pooled over layers.

    The band against the water above and below it, each against the trip's average; and the densest
    stretch of water as deep as the band is wide. That stretch is the one whose pooled density minus
    one standard error (the square root of its count) is highest, so a stretch with little water
    under it cannot win on a few marks; the number printed is its density itself."""
    sel = acc['dist'] > 0
    if not sel.any() or not acc[k].sum():
        return 'none at trolling speed'
    vol = acc['dist'] / 100 * (LAYERS + 1)
    avg = acc[k][sel].sum() / vol[sel].sum()
    n_all = int(acc[k].sum())
    head = f'{n_all} mark{"s" if n_all != 1 else ""}'
    if not band:
        return f'{head}; no band given (--plan or --band), so read the table'
    lo, hi = band
    mid = LAYERS + 1
    def grp(m):
        g = [j for j in np.nonzero(sel)[0] if m(mid[j])]
        v = vol[g].sum() if g else 0
        return f'{acc[k][g].sum() / v / avg:.2f}x' if v > 0 else 'no water'
    s = (f'{head}; in the band {grp(lambda z: lo <= z <= hi)}, above it {grp(lambda z: z < lo)}, '
         f'below it {grp(lambda z: z > hi)}')
    nl = max(1, int(round((hi - lo) / 2)))
    best = None
    for i in range(len(LAYERS) - nl + 1):
        g = list(range(i, i + nl))
        if not sel[g].all():
            continue
        n, v = acc[k][g].sum(), vol[g].sum()
        score = (n - np.sqrt(n)) / v
        if best is None or score > best[0]:
            best = (score, i, int(n), n / v)
    if best:
        _, i, n, d = best
        s += f'; the densest {ft(hi - lo)} ft was {ft(LAYERS[i])}-{ft(LAYERS[i] + 2 * nl)} ft ({d / avg:.2f}x, {n} marks)'
    return s


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('folder')
    ap.add_argument('--plan', help="the plan's JSON, from the app's JSON button")
    ap.add_argument('--out')
    ap.add_argument('--only', help='only the recordings whose file name contains this')
    ap.add_argument('--band', help='the fish band to read against, e.g. 20-30, when there is no plan')
    a = ap.parse_args()
    rsds = sorted(glob.glob(os.path.join(a.folder, '*.RSD')) + glob.glob(os.path.join(a.folder, '*.rsd')))
    rsds = sorted(r for r in set(rsds) if not a.only or a.only in os.path.basename(r))
    if not rsds:
        sys.exit(f'No .RSD recordings in {a.folder}')
    gpxs = [g for g in glob.glob(os.path.join(a.folder, '*.GPX')) + glob.glob(os.path.join(a.folder, '*.gpx'))
            if 'EXPORT' in os.path.basename(g).upper()]
    log, gpx_legs = (read_gpx(gpxs[0]) if gpxs else (np.zeros((0, 3)), {}))
    plan = read_plan(a.plan) if a.plan else None
    legs = (plan['legs'] if plan and plan['legs'] else gpx_legs)
    band = plan['band'] if plan else None
    band_from = 'the plan' if band else None
    if a.band:
        band, band_from = [float(x) for x in a.band.split('-')], '--band'
    slow_mph = plan['transit'] if plan and plan['transit'] else 3.0
    L = []
    say = L.append
    say('Personal use only, not for distribution or resale; not for navigation.')
    say(f'SONAR DEPTHS -- {os.path.basename(os.path.normpath(a.folder))}' + (f' -- plan "{plan["name"]}"' if plan and plan['name'] else ''))
    say(f'Track: {os.path.basename(gpxs[0]) if gpxs else "none (no *EXPORT*.GPX), so no speed and no clock check"}; '
        f'legs from {"the plan" if plan and plan["legs"] else "the GPX" if gpx_legs else "nowhere"} ({len(legs)}); '
        f'band: {f"{ft(band[0])}-{ft(band[1])} ft ({band_from})" if band else "none given"}; '
        f'trolling = under {slow_mph} mph ({"the plan transit speed" if plan and plan["transit"] else "9/28 line"}).')

    keys = ('all', 'big')
    day = {'dist': np.zeros(len(LAYERS)), 'all': np.zeros(len(LAYERS)), 'big': np.zeros(len(LAYERS))}
    per_leg = defaultdict(lambda: {'dist': np.zeros(len(LAYERS)), 'all': np.zeros(len(LAYERS)),
                                   'big': np.zeros(len(LAYERS)), 'D': []})
    per_hour = defaultdict(lambda: {'dist': np.zeros(len(LAYERS)), 'all': np.zeros(len(LAYERS)), 'big': np.zeros(len(LAYERS))})
    all_marks = []
    if len(log) > 1:
        lat0 = float(np.median(log[:, 1]))
        lx, ly = metres(log[:, 1], log[:, 2], lat0)
        cum = np.r_[0, np.cumsum(np.hypot(np.diff(lx), np.diff(ly)))]
        mph = np.r_[np.nan, np.diff(cum) / np.maximum(np.diff(log[:, 0]), 1e-6)] * 2.23694
    leg_xy = {}
    for f in rsds:
        ch = down_channel(f)
        d = decode(f, ch)
        d['clock'], nbad = fix_clock(d['clock'])
        t0 = start_of(f)
        off, gap = align(d, t0, log)
        t = (t0 or 0) + off + d['clock'] / 1000
        Z, E, top = column(d)
        bar, prof = measure_bar(Z, E, d['D'], top, t)
        if bar is None:
            say(f'{os.path.basename(f)}: too little water from 4 to 28 ft to measure the plain water; skipped')
            continue
        marks, valid = marks_in(Z, E, d['D'], top, bar)
        if len(log) > 1:
            dd = np.interp(t, log[:, 0], cum)
            step = np.r_[0, np.clip(np.diff(dd), 0, None)]
            slow = np.interp(t, log[:, 0], np.nan_to_num(mph)) < slow_mph
            inside = (t >= log[0, 0]) & (t <= log[-1, 0])
            slow &= inside
        else:
            lat0 = float(np.nanmedian(d['lat']))
            x, y = metres(d['lat'], d['lon'], lat0)
            step = np.r_[0, np.hypot(np.diff(x), np.diff(y))]
            step[step > 50] = 0
            slow = np.ones(len(t), bool)
        px, py = metres(d['lat'], d['lon'], lat0)
        on_leg = np.full(len(t), '', object)
        best = np.full(len(t), np.inf)
        for lid, lg in legs.items():
            if lid not in leg_xy:
                la = [p[0] for p in lg['pts']]
                lo = [p[1] for p in lg['pts']]
                leg_xy[lid] = metres(la, lo, lat0)
            dl = dist_to_line(px, py, leg_xy[lid])
            hit = (dl <= 25) & (dl < best)
            on_leg[hit], best[hit] = lid, dl[hit]
        hours = np.array([datetime.fromtimestamp(x, EASTERN).hour for x in t])
        # The water each ping swept, layer by layer: a layer counts where over half of it is in the
        # ping's valid water (9/28).
        for i, z0 in enumerate(LAYERS):
            zz = (Z >= z0) & (Z < z0 + 2)
            if not zz.any():
                continue
            has = valid[:, zz].mean(axis=1) > 0.5
            sw = step * (has & slow)
            day['dist'][i] += sw.sum()
            for lid in legs:
                per_leg[lid]['dist'][i] += sw[on_leg == lid].sum()
            for h in np.unique(hours):
                per_hour[h]['dist'][i] += sw[hours == h].sum()
        for lid in legs:
            per_leg[lid]['D'].extend(d['D'][(on_leg == lid) & slow].tolist())
        for p, z, pk in marks:
            if slow[p]:
                all_marks.append((z, pk, on_leg[p], hours[p]))
        say(f'{os.path.basename(f)}: down beam ch {ch}, {len(t):,} pings, '
            f'{datetime.fromtimestamp(t[0], EASTERN):%H:%M}-{datetime.fromtimestamp(t[-1], EASTERN):%H:%M}, '
            f'clock {off:+.1f} s{f" (median {gap:.1f} m off the track)" if gap is not None else " (not checked)"}, '
            f'{nbad} misread clocks fixed; bottom {np.nanpercentile(d["D"], 10):.0f}-{np.nanpercentile(d["D"], 90):.0f} ft (p10-p90); '
            f'plain water levels at {bar:.2f} (9/28: 3.80), {len(marks):,} arch-like marks')
        del E, valid, d
    if not all_marks:
        say('No marks at trolling speed.')
    else:
        M = np.array([(z, pk) for z, pk, _, _ in all_marks])
        big_bar = float(np.percentile(M[:, 1], 75))
        say(f'{len(M):,} arch-like marks at trolling speed; the bigger marks are the brightest quarter, peak {big_bar:.2f} or more.')
        for z, pk, lid, h in all_marks:
            i = int((z - LAYERS[0]) // 2)
            if not 0 <= i < len(LAYERS):
                continue
            for acc in [day] + ([per_leg[lid]] if lid else []) + [per_hour[h]]:
                acc['all'][i] += 1
                if pk >= big_bar:
                    acc['big'][i] += 1
        rows, rel = table(day, keys)
        say('')
        say("THE DAY, per volume of water (the cone taken out), 2 ft layers; the day's average = 1.00")
        say('  layer ft     water km   marks  bigger    all  bigger' + ('   (< the band)' if band else ''))
        for r, ra, rb in zip(rows, rel['all'], rel['big']):
            mid = r[0] + 1
            inb = band and band[0] <= mid <= band[1]
            say(f'  {r[0]:4.1f}-{r[0] + 2:4.1f}   {r[1]:7.1f}  {r[2]:6d} {r[3]:6d}   {ra:5.2f}  {rb:5.2f}{"   <" if inb else ""}')
        say("Per volume, against the day's average:")
        say(f'  all marks: {summary(day, "all", band)}.')
        say(f'  bigger marks: {summary(day, "big", band)}.')
        say('')
        say('BY LEG (within 25 m of its line, trolling speed)')
        for lid in sorted(legs, key=lambda k: int(k[1:])):
            acc = per_leg[lid]
            if not acc['dist'].any():
                say(f'  {lid} {legs[lid]["name"]}: not under the boat at trolling speed')
                continue
            Dl = np.array(acc['D'])
            baits = '; baits: ' + ', '.join(plan['baits'].get(lid, [])) if plan and plan['baits'].get(lid) else ''
            say(f'  {lid} {legs[lid]["name"]}: bottom {np.percentile(Dl, 10):.0f}-{np.percentile(Dl, 90):.0f} ft, '
                f'{int(acc["all"].sum())} marks, {int(acc["big"].sum())} bigger{baits}')
            say(f'     bigger: {summary(acc, "big", band)}')
        say('')
        say('BY HOUR (EDT)')
        for h in sorted(per_hour):
            acc = per_hour[h]
            if not acc['all'].sum():
                continue
            say(f'  {h:02d}:00  {int(acc["all"].sum()):5d} marks; bigger: {summary(acc, "big", band)}')
    say('')
    say("Each number is the recording's, not a forecast. Per volume of water, so a deep layer is not favoured by the "
        'wider beam, and a shallow layer swept by a narrow beam is a thin sample: read the km column. The plan\'s band '
        'and baits are what it said, not what he fished.')
    text = '\n'.join(L) + '\n'
    out = a.out or os.path.join(a.folder, f'sonar_depths_{os.path.basename(os.path.normpath(a.folder))}.txt')
    open(out, 'w', encoding='utf-8').write(text)
    print(text)
    print(f'-> {out}')


if __name__ == '__main__':
    main()
