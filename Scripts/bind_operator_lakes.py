#!/usr/bin/env python3
"""bind_operator_lakes.py -- attach utility-operator level feeds to registry slugs.

Personal use only, not for distribution or resale; not for navigation.

WHY THIS IS A PIPELINE SCRIPT AND NOT WORKER CODE
-------------------------------------------------
Ryan, 2026-08-16: *"i have no idea... these don't seem to be fishing questions... why can't the
geography sort itself?"*

It can, and the reason it has to happen HERE is that sorting it needs the whole registry --
every row's centroid, and every row's existing dam bindings. The Worker has neither. It has
`water_bindings.json`, which is exactly the file this writes into. Same division of labour as
`build_water_bindings.py`: the pipeline does the geometry join once, offline, and the Worker
reads the answer.

THE THREE RULES, and each one earns its place on a case that fails without it
----------------------------------------------------------------------------
A feed publishes a lake NAME. Several registry rows can carry that name.

  1. NEIGHBOURHOOD. The feed's unambiguous matches define where this operator's water is.
     A candidate farther from that cluster than the cluster's own span is not this
     operator's lake.
       -> Cube's "Falls" is the fourth step of the Yadkin chain. Its cluster (High Rock,
          Tuckertown, Badin) spans 28 km; the nearest candidate, blewett_falls_lake, is
          65.6 km away on the Pee Dee and belongs to Duke. falls_lake is the Neuse near
          Raleigh, 146 km off. ALL THREE ARE DROPPED, which is right: Falls Reservoir is
          not in the index, and any match would have been the wrong lake.

  2. A DAM OPERATOR'S LAKE HAS A DAM. Prefer a candidate that already carries a usace or
     tva binding, or a bound pool gauge.
       -> "Russell" is where distance alone gets it WRONG: lake_russell (88 ac, Habersham
          Co GA) sits 34.9 km from the cluster and richard_b_russell_lake (24,608 ac) sits
          54.4 km out. The 88-acre one is nearer and has no binding of any kind; the
          reservoir Southern Company publishes a full-pond elevation for has USACE.

  3. REFUSE A TIE. Two candidates that survive both rules are not resolved by picking one.

Name spelling is NOT this script's problem. Where an operator simply calls a lake something
the registry has never called it -- Southern Company writes "Clark Hill (Thurmond Dam)" and
"Tugalo" -- that is an alias, and it belongs in registry/lake_display_names.json under `also`,
which consolidate folds into legacy_display_names.

Usage:
    py .\\scripts\\bind_operator_lakes.py --registry F:\\TrollMapPipeline\\registry \\
       --pagesrc F:\\TrollMapPipeline\\_pagesrc
    py .\\scripts\\bind_operator_lakes.py --registry ... --pagesrc ... --write
"""
import argparse, json, math, os, re, sys, html as _html

STOP = {'lake', 'lakes', 'reservoir', 'res', 'the', 'a', 'of', 'at', 'near', 'on'}
ABBREV = {'ft': 'fort', 'mt': 'mount'}


def tokens(s):
    s = re.sub(r'\([^)]*\)', ' ', str(s or ''))
    s = re.sub(r',\s*[A-Z]{2}(/[A-Z]{2})?\b', ' ', s)
    out = []
    for t in re.split(r'[^a-z0-9]+', s.lower()):
        if t and t not in STOP:
            out.append(ABBREV.get(t, t))
    return set(out)


FLOWING = re.compile(r'\b(river|creek|canal|branch|run|fork|swamp|slough|tailwater|tailrace)\b', re.I)


def name_matches(feed_name, registry_names):
    """Feed name must be contained BY a registry name. Mirrors matchWaterName with
    sourceMayBeBroader=false: an operator never publishes one row for two lakes."""
    cand = tokens(feed_name)
    if not cand:
        return None
    best = None
    for nm in registry_names:
        w = tokens(nm)
        if not w or not cand <= w:
            continue
        extra = w - cand
        if any(FLOWING.search(t) for t in extra):
            continue
        overlap = len(cand & w)
        if best is None or overlap > best[1]:
            best = (nm, overlap)
    return best[0] if best else None


def km(a, b):
    (la, lo), (lb, lob) = a, b
    v = (math.sin(math.radians(la)) * math.sin(math.radians(lb))
         + math.cos(math.radians(la)) * math.cos(math.radians(lb)) * math.cos(math.radians(lo - lob)))
    return 6371.0 * math.acos(max(-1.0, min(1.0, v)))


# ── the three operator pages ────────────────────────────────────────────────────────────────
def _unwrap_view_source(s):
    """Browser 'view-source' saves wrap the real HTML in a line-number table."""
    cells = re.findall(r'<td class="line-content">(.*?)</td>', s, re.S)
    if not cells:
        return s
    out = []
    for c in cells:
        c = re.sub(r'<br\s*/?>', '', c)
        c = re.sub(r'<[^>]+>', '', c)
        out.append(_html.unescape(c))
    return '\n'.join(out)


def _cells(row):
    return re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', row, re.S | re.I)


def _text(h):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', h or '').replace('&nbsp;', ' ')).strip()


def parse_cube(src):
    m = re.search(r'<table[^>]*id="GridView1"[^>]*>(.*?)</table>', src, re.S | re.I)
    if not m:
        return []
    out = []
    for row in re.findall(r'<tr[^>]*>(.*?)</tr>', m.group(1), re.S | re.I):
        c = _cells(row)
        if len(c) < 3:
            continue
        name, elev = _text(c[0]), _text(c[1])
        if not name or not re.match(r'^-?[\d.]+$', elev or ''):
            continue
        out.append(name)
    return out


def parse_southernco(src):
    m = re.search(r'<table[^>]*id="MainContent_LakeGrid"[^>]*>(.*?)</table>', src, re.S | re.I)
    if not m:
        return []
    out = []
    for row in re.findall(r'<tr[^>]*>(.*?)</tr>', m.group(1), re.S | re.I):
        c = _cells(row)
        if len(c) < 5:
            continue
        name, cur = _text(c[0]), _text(c[3])
        if not name or name.lower() == 'lake' or not re.match(r'^-?[\d.]+$', cur or ''):
            continue
        out.append(name)
    return out


OPERATORS = {
    'cube': ('cube.html', parse_cube, 'https://ww4.cubecarolinas.com/lake/levels?orgID=3'),
    'southernco': ('southernco.html', parse_southernco, 'https://lakes.southernco.com/default.aspx'),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', required=True)
    ap.add_argument('--pagesrc', required=True)
    ap.add_argument('--write', action='store_true', help='write operator into water_bindings.json')
    a = ap.parse_args()

    idx_path = os.path.join(a.registry, 'lake_index.json')
    with open(idx_path, encoding='utf-8') as f:
        idx = json.load(f)
    bpath = os.path.join(a.registry, 'water_bindings.json')
    with open(bpath, encoding='utf-8') as f:
        bdoc = json.load(f)
    bindings = bdoc.get('bindings', bdoc)

    rows = []
    for slug, r in idx.items():
        if not isinstance(r.get('centroid'), list) or len(r['centroid']) != 2:
            continue
        names = [r.get('name'), r.get('display_name')] + list(r.get('legacy_display_names') or [])
        rows.append({'slug': slug, 'names': [n for n in names if n],
                     'pt': (r['centroid'][1], r['centroid'][0]),
                     'acres': r.get('area_acres') or 0})

    def has_dam_binding(slug):
        v = bindings.get(slug) or {}
        return bool(v.get('usace') or v.get('tva') or v.get('pool'))

    total_bound = 0
    result = {}
    for op, (fname, parser, url) in OPERATORS.items():
        path = os.path.join(a.pagesrc, fname)
        if not os.path.exists(path):
            print('  %-12s SKIP -- %s not found' % (op, fname))
            continue
        with open(path, encoding='utf-8', errors='replace') as f:
            src = _unwrap_view_source(f.read())
        feed_names = parser(src)

        # pass 1 -- every candidate, by name only
        cands = {}
        for fn in feed_names:
            hits = [row for row in rows if name_matches(fn, row['names'])]
            cands[fn] = hits

        anchors = [h[0] for h in cands.values() if len(h) == 1]
        if not anchors:
            print('  %-12s no unambiguous match to anchor on' % op)
            continue
        pts = [r['pt'] for r in anchors]
        ctr = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
        span = max((km(p, q) for p in pts for q in pts), default=0.0)

        print('\n%s  (%d rows read, %d anchors, cluster span %.0f km)' % (op, len(feed_names), len(anchors), span))
        for fn, hits in cands.items():
            if not hits:
                continue
            if len(hits) == 1:
                pick, why = hits[0], 'unique name'
            else:
                near = [h for h in hits if km(h['pt'], ctr) <= max(span, 25.0)]
                if not near:
                    print('    REFUSED  %-28s all %d candidates outside the operator cluster (nearest %.0f km, span %.0f km)'
                          % (fn, len(hits), min(km(h['pt'], ctr) for h in hits), span))
                    continue
                if len(near) > 1:
                    dammed = [h for h in near if has_dam_binding(h['slug'])]
                    if len(dammed) == 1:
                        near, why = dammed, 'nearest cluster + only one carries a dam binding'
                    else:
                        print('    REFUSED  %-28s %d candidates survive both rules: %s'
                              % (fn, len(near), ', '.join(h['slug'] for h in near)))
                        continue
                else:
                    why = 'only candidate inside the operator cluster'
                pick = near[0]
            result.setdefault(pick['slug'], {'operator': op, 'feed_name': fn, 'url': url, 'why': why})
            total_bound += 1
            print('    %-30s -> %-28s %9s ac   [%s]' % (fn, pick['slug'], format(pick['acres'], ',.0f'), why))

    print('\n%d slug(s) bound to an operator feed.' % total_bound)
    if a.write:
        for slug, v in result.items():
            bindings.setdefault(slug, {'slug': slug})['operator'] = v
        with open(bpath, 'w', encoding='utf-8') as f:
            json.dump(bdoc, f, indent=1, ensure_ascii=False)
        print('wrote operator bindings -> %s' % bpath)
    else:
        print('(dry run -- pass --write to record these in water_bindings.json)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
