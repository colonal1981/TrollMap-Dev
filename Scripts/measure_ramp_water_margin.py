"""At the 250 m margin, which ramps are on MORE THAN ONE water -- and do his own answers agree?

RYAN CLOSED THE MARGIN QUESTION, 2026-09-22: *"the 250m is probably ok... my point was to make
sure we allow 2 bodies of water to have both have access to the ramp if the bodies of water are
actually connected and fairly nearby."* So the number was never what he was pushing back on. What
he was pushing back on is a rule that MOVES a landing off a water instead of ADDING the second one
-- the ADDITIVE, NEVER SUBTRACTIVE half of the landing rule.

TWO INSTRUMENTS, AND KEEPING THEM APART IS THE WHOLE POINT. This margin decides FILING: which
water's list a ramp appears on. It does NOT establish that two waters are connected -- two waters
can sit 250 m apart with a road between them. Connection is measured by `build_ramp_reach.py`,
which floods the CHARTED WATER at 25 m and is what puts "0.2 mi by water" on the label. That is
also why the canal case needs no cutoff: Marion and Moultrie are connected, and the reach number
comes back large enough that Ryan ignores it.

SO THIS ANSWERS TWO QUESTIONS AND NOT THE ONE IT WAS WRITTEN FOR.

1. Is 250 m comfortably clear of where real ramps actually sit? Measured against CONFIRMED PAIRS
   -- every `dnr`/`dnr_paddle` row in `lake_index.json` carries `wb`, the agency's own name for
   the water the ramp is on, and where that name resolves BY NAME ALONE to the slug we filed it
   under, two independent sources agree and no distance was involved in deciding so.

2. At 250 m, how many ramps are on MORE THAN ONE water -- the additive case he asked for -- and
   do the seven landings he named by hand come out the way he described them?

    python3 Scripts/measure_ramp_water_margin.py --registry registry
    python3 Scripts/measure_ramp_water_margin.py --registry registry --margin-m 250 --json out.json

Personal use only, not for distribution or resale; not for navigation.
"""
import argparse, json, math, os, re, sys

try:
    from shapely.geometry import shape, Point
    from shapely.ops import transform as sh_transform, unary_union
except ImportError:
    sys.exit('needs shapely')

PAREN = re.compile(r'\s*\([^)]*\)\s*$')


def norm(n):
    """Lowercase, drop a trailing parenthetical, punctuation to spaces, runs collapsed.

    The parenthetical is the registry's own county/state tie-break -- "Richard B Russell Lake
    (Abbeville Co, SC/GA)" -- and no agency feed writes one. Stripping it is what lets a name
    match at all; it is NOT a fuzzy pass and nothing here matches on a substring.
    """
    s = PAREN.sub('', str(n or ''))
    s = re.sub(r'[^a-z0-9]+', ' ', s.lower())
    return re.sub(r'\s+', ' ', s).strip()


def name_map(rows):
    """norm(name) -> set of slugs, from the registry's OWN name fields only."""
    m = {}
    for slug, r in rows.items():
        for f in ('name', 'display_name', 'legacy_display_name'):
            v = r.get(f)
            if v:
                m.setdefault(norm(v), set()).add(slug)
        for v in (r.get('legacy_display_names') or []):
            if v:
                m.setdefault(norm(v), set()).add(slug)
    return m


class Boundaries:
    """Per-slug geometry, transformed ONCE and cached.

    THE FIRST VERSION OF THIS RAN sh_transform PER QUERY and never finished -- it re-projected a
    whole MultiPolygon for every ramp against every nearby water. The scale factor only has to be
    right near the ramp, and a boundary is small enough that its own centroid latitude is right
    everywhere on it, so the transform is a property of the SLUG and not of the query.
    """

    def __init__(self, registry):
        self.dir = os.path.join(registry, 'boundaries')
        self.cache = {}

    def get(self, slug):
        if slug in self.cache:
            return self.cache[slug]
        fp = os.path.join(self.dir, slug + '.geojson')
        out = None
        if os.path.exists(fp):
            try:
                gj = json.load(open(fp, encoding='utf-8'))
                feats = gj.get('features') if gj.get('type') == 'FeatureCollection' else [gj]
                geoms = [shape(f['geometry']) for f in (feats or []) if (f or {}).get('geometry')]
                if geoms:
                    g = geoms[0] if len(geoms) == 1 else unary_union(geoms)
                    lat0 = g.centroid.y
                    k = math.cos(math.radians(lat0)) or 1e-9
                    out = (sh_transform(lambda x, y, z=None: (x * k, y), g), k)
            except Exception:
                out = None
        self.cache[slug] = out
        return out

    def metres(self, slug, lat, lon):
        """Metres from (lat,lon) to the boundary, or None. ZERO means inside the polygon."""
        got = self.get(slug)
        if got is None:
            return None
        g, k = got
        return g.distance(Point(lon * k, lat)) * 111320.0


def pct(v, q):
    if not v:
        return float('nan')
    v = sorted(v)
    i = min(len(v) - 1, max(0, int(round((len(v) - 1) * q))))
    return v[i]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--json', help='write the per-pair table here')
    ap.add_argument('--margin-m', type=float, default=250.0,
                    help='the filing margin under test. 250 m is Ryan\'s, 2026-09-22.')
    ap.add_argument('--named', action='store_true', default=True,
                    help='check the landings he named by hand (on by default)')
    ap.add_argument('--near-deg', type=float, default=0.25,
                    help='how far out to look for a competing water. Default 0.25 deg (~28 km) '
                         'so the answer is not bounded by the search')
    a = ap.parse_args()

    rows = json.load(open(os.path.join(a.registry, 'lake_index.json'), encoding='utf-8'))
    nm = name_map(rows)
    bnd = Boundaries(a.registry)

    # bbox index off the registry's own bounds_wsen, so competitors are found without loading
    # 3,361 polygons per ramp.
    boxes = []
    for slug, r in rows.items():
        b = r.get('bounds_wsen')
        if b and len(b) == 4:
            boxes.append((slug, float(b[0]), float(b[1]), float(b[2]), float(b[3])))

    pairs, ambiguous, unresolved, nogeom = [], 0, 0, 0
    n_rows, done = len(rows), 0
    print('scanning %d registry rows for confirmed pairs...' % n_rows, flush=True)
    for slug, r in rows.items():
        done += 1
        if done % 400 == 0:
            print('  %d/%d rows, %d pairs so far' % (done, n_rows, len(pairs)), flush=True)
        for bucket in ('dnr', 'dnr_paddle'):
            for ramp in ((r.get('ramps') or {}).get(bucket) or []):
                lat, lon, wb = ramp.get('lat'), ramp.get('lon'), ramp.get('wb')
                if lat is None or lon is None or not wb:
                    continue
                hit = nm.get(norm(wb))
                if not hit:
                    unresolved += 1
                    continue
                if len(hit) > 1:
                    ambiguous += 1
                    continue
                if next(iter(hit)) != slug:
                    continue          # the agency names a DIFFERENT water -- not a confirmed pair
                d_own = bnd.metres(slug, float(lat), float(lon))
                if d_own is None:
                    nogeom += 1
                    continue
                d_next, next_slug = None, None
                for s2, w, s, e, n in boxes:
                    if s2 == slug:
                        continue
                    if not (s - a.near_deg <= lat <= n + a.near_deg
                            and w - a.near_deg <= lon <= e + a.near_deg):
                        continue
                    d2 = bnd.metres(s2, float(lat), float(lon))
                    if d2 is not None and (d_next is None or d2 < d_next):
                        d_next, next_slug = d2, s2
                pairs.append({'slug': slug, 'ramp': ramp.get('name'), 'wb': wb,
                              'bucket': bucket, 'lat': lat, 'lon': lon,
                              'd_own_m': round(d_own, 1),
                              'd_next_m': None if d_next is None else round(d_next, 1),
                              'next_slug': next_slug})

    own = [p['d_own_m'] for p in pairs]
    nxt = [p['d_next_m'] for p in pairs if p['d_next_m'] is not None]
    inside = sum(1 for d in own if d <= 0.0)

    print('CONFIRMED PAIRS -- the agency name and the registry name agree, no distance used')
    print('  pairs                      %5d' % len(pairs))
    print('  agency name matched nothing %5d   (not evidence of anything, just unresolvable)'
          % unresolved)
    print('  agency name was ambiguous   %5d   (two registry waters share it -- excluded)'
          % ambiguous)
    print('  no boundary geometry        %5d' % nogeom)
    print()
    print('HOW FAR A CONFIRMED RAMP IS FROM ITS OWN WATER\'S DRAWN EDGE')
    print('  inside the polygon          %5d of %d  (%.1f%%)'
          % (inside, len(own), 100.0 * inside / max(1, len(own))))
    for q, lbl in ((0.5, 'p50'), (0.9, 'p90'), (0.95, 'p95'), (0.99, 'p99'), (1.0, 'max')):
        print('  %-4s %10.1f m' % (lbl, pct(own, q)))
    print()
    print('HOW FAR THE NEAREST *OTHER* WATER IS, for the same ramps')
    for q, lbl in ((0.0, 'min'), (0.05, 'p05'), (0.1, 'p10'), (0.5, 'p50')):
        print('  %-4s %10.1f m' % (lbl, pct(nxt, q)))
    print()
    print('IS THERE A BAND? -- a margin is only defensible inside one')
    hi = pct(own, 0.99)
    lo = pct(nxt, 0.05)
    print('  p99 of d_own  %8.1f m' % hi)
    print('  p05 of d_next %8.1f m' % lo)
    if lo > hi:
        print('  BAND: %.1f m wide, between %.1f and %.1f' % (lo - hi, hi, lo))
    else:
        print('  NO BAND -- the two distributions overlap by %.1f m.' % (hi - lo))
        print('  A single distance margin cannot separate "on this water" from "on another".')
    print()
    print('THE WORST CONFIRMED PAIRS -- a real ramp genuinely far from its own water')
    for p in sorted(pairs, key=lambda x: -x['d_own_m'])[:12]:
        print('  %9.1f m  %-30s %-26s next: %s @ %s'
              % (p['d_own_m'], p['slug'], (p['ramp'] or '')[:26], p['next_slug'],
                 'n/a' if p['d_next_m'] is None else '%.0f m' % p['d_next_m']))

    # ---- 2. THE ADDITIVE CASE: at this margin, how many ramps are on more than one water? ----
    #
    # Counted over EVERY ramp bucket, not only the confirmed pairs, because the question is about
    # what the producer would file rather than about what two name sources agree on.
    print()
    print('AT %.0f m, HOW MANY WATERS CLAIM EACH RAMP' % a.margin_m, flush=True)
    seen, census, multi = set(), {}, []
    done2 = 0
    for slug, r in rows.items():
        done2 += 1
        if done2 % 400 == 0:
            print('  %d/%d rows, %d positions' % (done2, n_rows, len(seen)), flush=True)
        for bucket, rl in ((r.get('ramps') or {}).items()):
            for ramp in (rl or []):
                lat, lon = ramp.get('lat'), ramp.get('lon')
                if lat is None or lon is None:
                    continue
                key = (round(float(lat), 6), round(float(lon), 6))
                if key in seen:
                    continue
                seen.add(key)
                claims = []
                for s2, w, so, e, n in boxes:
                    dd = a.margin_m / 111320.0
                    if not (so - dd <= lat <= n + dd and w - dd * 3 <= lon <= e + dd * 3):
                        continue
                    d2 = bnd.metres(s2, float(lat), float(lon))
                    if d2 is not None and d2 <= a.margin_m:
                        claims.append((round(d2, 1), s2))
                census[len(claims)] = census.get(len(claims), 0) + 1
                if len(claims) > 1:
                    multi.append((sorted(claims), ramp.get('name'), lat, lon))
    tot = sum(census.values())
    for k in sorted(census):
        print('  %2d water(s)  %5d ramp(s)   %5.1f%%' % (k, census[k], 100.0 * census[k] / max(1, tot)))
    print('  %d distinct positions in all buckets; %d would be on more than one water' % (tot, len(multi)))
    print()
    print('  the widest multi-bindings -- second water furthest away:')
    for claims, nm_, la, lo in sorted(multi, key=lambda t: -t[0][1][0])[:10]:
        print('    %-28s %s' % ((nm_ or '(unnamed)')[:28],
                                '  '.join('%s @ %.0fm' % (s2, d) for d, s2 in claims[:4])))

    # ---- his own answers, which are the only ground truth that outranks the arithmetic ----
    WANT = ['Low Falls', 'Rimini', "Pack's Landing", 'Amos Lee Gourdine', "Harry's",
            "Mac's", 'Wilsons', 'Sparkleberry']
    print()
    print('THE LANDINGS HE NAMED BY HAND, at %.0f m' % a.margin_m)
    for want in WANT:
        found = None
        for claims, nm_, la, lo in multi:
            if nm_ and want.lower() in nm_.lower():
                found = (claims, nm_, la, lo); break
        if found is None:
            hit = None
            for slug, r in rows.items():
                for bucket, rl in ((r.get('ramps') or {}).items()):
                    for ramp in (rl or []):
                        if ramp.get('name') and want.lower() in str(ramp['name']).lower() \
                           and ramp.get('lat') is not None:
                            hit = (slug, ramp); break
                    if hit: break
                if hit: break
            if hit is None:
                print('  %-22s NOT FOUND in any ramp bucket' % want)
                continue
            slug, ramp = hit
            cl = []
            for s2, w, so, e, n in boxes:
                d2 = bnd.metres(s2, float(ramp['lat']), float(ramp['lon']))
                if d2 is not None and d2 <= a.margin_m:
                    cl.append((round(d2, 1), s2))
            print('  %-22s %s' % (want, '  '.join('%s @ %.0fm' % (s2, d) for d, s2 in sorted(cl))
                                  or 'NOTHING within %.0f m' % a.margin_m))
        else:
            claims, nm_, la, lo = found
            print('  %-22s %s' % (want, '  '.join('%s @ %.0fm' % (s2, d) for d, s2 in claims)))

    if a.json:
        json.dump({'pairs': pairs}, open(a.json, 'w', encoding='utf-8'), indent=1)
        print('\n-> %s' % a.json)


if __name__ == '__main__':
    main()
