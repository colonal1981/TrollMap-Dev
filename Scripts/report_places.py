#!/usr/bin/env python3
"""report_places.py -- the places a report names, put on his chart: "Shull Island", "Buffalo Creek", "the Little River".

Personal use only, not for distribution or resale; not for navigation.

Ryan, 11/6, on what the reports are for: "if the app can tell me that i should be throwing a certain type of topwater
bait in a certain area at a certain time i will do that". The area is in the words. Before 11/6 only the Santee
Cooper scratch pass (parse_reports.py) put the words on the chart; every saved file's `places` was empty.

THE NAMES, per water, all from his drive (nothing fetched):
  - the chart's own place names (chartpack/<slug>/pois.geojson, poi_type "place_name"): the names on his chart.
    A name of one word ("Shoal", "Stump", "Pile", "Bridge") is the chart labelling a kind of thing, not a place.
  - the water's landings (chartpack/<slug>/launches.json), with any name in brackets as well:
    "Larry Koon Landing (Shull Island)".
  - the registry's waters whose bounds overlap this one (a river into the lake, a canal), where the chart has no
    label of that name. A river is also called by its first word ("up the Saluda"), but not where another proper
    name runs on from it ("Lake Wateree", "Santee State Park").
  - registry/gnis_historical.json for this water: the old names.
  - his own names: "lake moultrie dam = pinopolis dam" (11/3).
A name the chart prints several times (a creek labelled along its length) is placed at its middle label, and the spread
of its labels is kept: a name whose labels are far apart (the Georgia and South Carolina Little Rivers on Thurmond)
says so instead of pretending to one spot.

THE MATCH is of proper names as written: "around the timber" is not the chart's "Timber". A captain's name and a
business given with its phone number ("Pack's Landing (803-452-5514)") say who reported, not where the fish were, and
are blanked first.

AREA: the named parts of a water the words use ("the upper end", "the backs of the creeks", "main lake points").
"""
import json, math, os, re

PLACE_WORD = re.compile(r"(Creek|Island|Islands|Point|Cove|Landing|Marina|Dam|River|Bridge|Branch|Bay|Hole|Park|Club|Camp|"
                        r"Lake|Canal|Slough|Flats?|Hump|Shoal|Shoals|Ferry|Mill|Access|Area|Inlet|Narrows|Run|Fork|Pond)s?$")
ATTRIB = re.compile(r"(?:Captain|Capt\.?)\s+[A-Z][\w.]*(?:\s+[A-Z][\w.]*)*|"
                    r"[A-Z][\w’'&.]*(?:\s+(?:[A-Z][\w’'&.]*|of|and|the))*\s*\(\s*\d{3}[-)\s]\s*\d{3}-\d{4}\s*\)")
FAR_M = 6000            # labels of one name further apart than this: two places, said so
ALIASES = {             # his names for a place the chart names otherwise
    'Pinopolis Dam': (['Lake Moultrie Dam', 'Moultrie Dam'], 'Ryan, 2026-11-03: "lake moultrie dam = pinopolis dam"'),
}
AREAS = [('upper lake', r'upper (?:end|lake|part|reaches|portion|section)|up the lake|upper end of the lake|headwaters'),
         ('lower lake', r'lower (?:end|lake|part|portion|section)|down the lake|lower end of the lake|near the dam'),
         ('mid lake', r'mid-?lake|middle of the lake|mid-?section|middle section'),
         ('main lake', r'main[- ]lake'),
         ('creek mouths', r'creek mouths?|mouths? of (?:the )?(?:creeks?|coves?|pockets?)'),
         ('backs of creeks', r'backs? of (?:the )?(?:creeks?|coves?|pockets?)|creek backs|back ends? of')]
AREA_RX = [(k, re.compile(v, re.I)) for k, v in AREAS]


def _m(a, b):
    """Metres between two (lon, lat), near enough for a lake."""
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * 111320 * k, (a[1] - b[1]) * 110540)


def _middle(points):
    """The label nearest the others (a creek's middle label), and how far apart its labels are."""
    best = min(points, key=lambda p: sum(_m(p, q) for q in points))
    return best, round(max((_m(p, q) for p in points for q in points), default=0))


def _bare(n):
    return re.sub(r'\s*\(.*?\)', '', re.sub(r"[’'`]", '', n or '')).strip()


# The sources call Santee Cooper's two lakes "Santee" and "Cooper" ("on Santee"), so those words alone are not the
# rivers (found on the Santee Cooper pass, 11/3: "Santee Cooper" had been read as two rivers, 79 and 54 times).
NO_BARE = {'santee', 'cooper'}
GENERIC = {'boat ramp', 'boat landing', 'public ramp', 'fishing pier', 'swim area', 'swimming area', 'no wake',
           'public access', 'boat launch'}   # a chart's label for a kind of thing, not a place


def _norm(n):
    return re.sub(r'[^a-z0-9 ]', '', re.sub(r'\s+', ' ', (n or '').lower())).strip()


def gazetteer(packs, regdir, slug):
    """Every name for this water, with where it is: [{'name', 'lon', 'lat', 'from', 'labels', 'spread_m', ...}]."""
    idx = json.load(open(os.path.join(regdir, 'lake_index.json'), encoding='utf-8'))
    row = idx.get(slug, {})
    own = {_norm(_bare(n)) for n in [row.get('name'), row.get('display_name')] + (row.get('legacy_display_names') or [])}
    own |= {re.sub(r' [a-z]{2}$', '', n) for n in own}
    own_words = {w for n in own for w in n.split() if w not in ('lake', 'reservoir')}
    # Another lake's name in a report is that lake, not a place on this one ("Lake Keowee" in a Hartwell report).
    lakes = {_norm(_bare(n)) for k, v in idx.items() if v.get('feature_type') == 'lake' and k != slug
             for n in [v.get('name')] + (v.get('legacy_display_names') or [])}
    lakes |= {re.sub(r' [a-z]{2}$', '', n) for n in lakes}
    raw = {}                                              # name -> {'pts': [...], 'from': ...}
    def add(name, lon, lat, frm, **kw):
        n = _bare(name); k = _norm(n)
        if (not n or k in own or k in lakes or k in GENERIC or re.search(r'\b[A-Z]\.?$', n) or re.fullmatch(r'[\d"\'.\s-]+', n)
                or len(n) < 4 or n.startswith('"') or (len(n.split()) < 2 and not kw.get('keep'))
                or (kw.get('bare') and (k in own_words or k in NO_BARE))):
            return
        e = raw.setdefault(n, {'pts': [], 'from': frm, **{k: v for k, v in kw.items() if k != 'keep'}})
        e['pts'].append((lon, lat))
    pack = os.path.join(packs, slug)
    try:
        for f in json.load(open(os.path.join(pack, 'pois.geojson'), encoding='utf-8'))['features']:
            pr = f['properties']
            if pr.get('poi_type') == 'place_name' and f['geometry']['type'] == 'Point':
                add(pr.get('name'), *f['geometry']['coordinates'][:2], 'chart')
                # the chart's "River Bed - Little River" is the Little River the reports name
                m = re.match(r'(?:River|Creek) Bed\s*-\s*(.+)$', pr.get('name') or '')
                if m: add(m.group(1), *f['geometry']['coordinates'][:2], 'chart')
    except FileNotFoundError:
        pass
    try:
        for x in json.load(open(os.path.join(pack, 'launches.json'), encoding='utf-8')).get('landings', []):
            if x.get('name'):
                add(x['name'], x['lon'], x['lat'], 'landing')
                for inner in re.findall(r'\(([^)]+)\)', x['name']):
                    add(inner, x['lon'], x['lat'], 'landing')
    except FileNotFoundError:
        pass
    b = row.get('bounds_wsen')
    if b:
        for k, v in idx.items():
            o = v.get('bounds_wsen')
            if (k == slug or v.get('feature_type') != 'river' or not o
                    or not (o[0] <= b[2] and o[2] >= b[0] and o[1] <= b[3] and o[3] >= b[1])):
                continue
            n = _bare(re.sub(r'\s*\(.*?\)', '', v.get('name') or ''))
            if not n or n in raw or not v.get('centroid'): continue
            # A river's middle can be miles up it. Where its middle is off this water, it is put at this water's edge
            # toward it, which is where it comes in or goes out; said so with `approx`.
            lon, lat = v['centroid']
            cl = (min(max(lon, b[0]), b[2]), min(max(lat, b[1]), b[3]))
            approx = cl != (lon, lat)
            add(n, cl[0], cl[1], 'registry water', slug=k, **({'approx': 'the edge of the water toward it'} if approx else {}))
            if n.endswith(' River') and len(n.split()) == 2:
                add(n[:-len(' River')], cl[0], cl[1], 'registry water', slug=k, keep=True, bare=True, of=n,
                    **({'approx': 'the edge of the water toward it'} if approx else {}))
    try:
        for x in json.load(open(os.path.join(regdir, 'gnis_historical.json'), encoding='utf-8'))['waters'].get(slug, []):
            add(x['name'], x['lon'], x['lat'], 'gnis_historical')
    except (FileNotFoundError, KeyError):
        pass
    for name, (aliases, said) in ALIASES.items():
        if name in raw:
            for a in aliases:
                raw.setdefault(a, {'pts': raw[name]['pts'], 'from': raw[name]['from'], 'alias_of': name, 'said_by': said})
    out = []
    for n, e in raw.items():
        (lon, lat), spread = _middle(e['pts'])
        g = {'name': e.get('alias_of') or e.get('of') or n, 'as_written': n, 'lon': round(lon, 6), 'lat': round(lat, 6),
             'from': e['from'], 'labels': len(e['pts']), 'spread_m': spread}
        if spread > FAR_M: g['far_apart'] = True
        for k in ('slug', 'bare', 'said_by', 'approx'):
            if e.get(k): g[k] = e[k]
        out.append(g)
    return out


class Matcher:
    """One pass over a text for every name of a water: a single alternation, longest names first."""
    def __init__(self, gaz):
        self.by = {}
        full, bare = [], []
        for g in gaz:
            core = re.escape(g['as_written']).replace(r'\ ', r'\s+')
            core = re.sub(r'(Landing|Marina|Camp|Creek)$', r'\1s?', core)
            (bare if g.get('bare') else full).append((len(g['as_written']), core, g))
        for _, core, g in full + bare:
            self.by.setdefault(g['as_written'].lower(), g)
        full.sort(key=lambda x: -x[0])
        self.full = re.compile(r"(?<![A-Za-z])(?:" + '|'.join(c for _, c, _ in full) + r")(?![A-Za-z])") if full else None
        self.bare = [(re.compile(r"(?<![A-Za-z])" + c + r"(?![A-Za-z])"), g) for _, c, g in bare]

    def places(self, text):
        t = re.sub(r"[’'`]", '', ATTRIB.sub(' ', text))
        hit = []
        if self.full:
            for m in self.full.finditer(t):
                key = re.sub(r'\s+', ' ', m.group(0)).lower()
                g = self.by.get(key) or self.by.get(re.sub(r's$', '', key))
                if g: hit.append(g)
        for rx, g in self.bare:
            # "the Saluda" is the river; "Saluda Shoals" and "Lake Saluda" are not
            if any(not re.search(r"[A-Z][a-z]+[\s-]+$", t[:m.start()]) and not re.match(r"[\s-]+[A-Z]", t[m.end():])
                   for m in rx.finditer(t)):
                hit.append(g)
        seen, out = set(), []
        for g in hit:
            if g['name'] in seen: continue
            seen.add(g['name'])
            p = {'name': g['name'], 'lon': g['lon'], 'lat': g['lat'], 'from': g['from'], 'as_written': g['as_written']}
            if g.get('far_apart'): p['far_apart'] = True; p['spread_m'] = g['spread_m']
            if g.get('slug'): p['slug'] = g['slug']
            if g.get('approx'): p['approx'] = g['approx']
            out.append(p)
        return out


def areas(text):
    return [k for k, rx in AREA_RX if rx.search(text)]
