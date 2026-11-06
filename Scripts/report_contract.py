"""report_contract.py -- the one shape every fishing-report collector writes, for every source and every water, lakes
and rivers; and the check that a file of statements keeps to it.

Personal use only, not for distribution or resale; not for navigation.

Ryan, 2026-09-12: "why not extract everything then do the wiring 1 time?" The shape the extractors write to is the
one thing that goes first, so two collectors do not land two spellings of the same idea. One statement is one dated
thing a source said about fish on a water, in its own words.

STORED here, because it is what a source said or a fact about that day: the words, the date, the water, the fish, the
depths and methods read out of the words, the gauge's reading that day (history does not go stale).
NOT STORED, because it is worked out at plan time from today's water and his choices: the era (`sections.era()`),
which statements are "this week" and "as it cools". A stored derivation is a photo of an old chart.

   python3 report_contract.py <statements.json> [...] --rep <folder of source records> --registry <registry folder>
exits 1 if any statement breaks the contract, and says which and why.
"""
import json, os, re, sys, glob, hashlib, datetime as dt, collections

# ---- the closed lists ----------------------------------------------------------------------------------------------
SOURCES = {   # key -> (who publishes it, what it is, the states its waters are in)
    'AHQ': ("Angler's Headquarters", 'weekly guide reports, public weeks', {'SC'}),
    'CS': ('Carolina Sportsman', 'magazine articles', {'SC'}),
    'SCC': ('Santee Cooper Country', 'monthly report: web page and Facebook post', {'SC'}),
    'SCDNR': ('SC Department of Natural Resources', 'Freshwater Fishing Trends page, live and in the Internet Archive', {'SC'}),
    'Item': ('The Sumter Item', "weekly reprint of SCDNR's column, 2004-2017", {'SC'}),
    'YT-BigFishBlanch': ('Capt. Chris Blanchette (YouTube)', 'monthly Lake Murray video report, transcript', {'SC'}),
    'FB-Wolfe': ('Wolfe (Facebook)', 'Lake Wateree posts', {'SC'}),
    # 11/6, his picks: "Georgia DNR weekly blog, Tournament patterns, Santee Cooper Country, Murray videos"
    'GA-WRD': ('Georgia DNR Wildlife Resources Division', 'weekly Georgia Fishing Report blog', {'GA', 'SC'}),
    'BASS': ('B.A.S.S. (Bassmaster)', 'tournament reports and patterns', {'SC', 'GA', 'NC', 'TN'}),
    'MLF': ('Major League Fishing', 'tournament reports and patterns', {'SC', 'GA', 'NC', 'TN'}),
    # 11/6: what he read himself and pasted into the app (item 44), with his date and his water (report_pasted.py)
    'PASTED': ('Ryan', 'a report he read and pasted into the app', {'SC', 'GA', 'NC', 'TN'}),
}
# SC only, his word of 11/5: "when we run research we are going to have to stick to SC waters unless we plan to find
# these type of sources for the other 3 states". A source for another state is one more row here, and a reader.
SPECIES = ['striped bass', 'hybrid striped bass', 'white bass', 'black bass', 'largemouth bass', 'spotted bass',
           'smallmouth bass', 'crappie', 'bream', 'shellcracker', 'catfish', 'white perch', 'yellow perch', 'perch',
           'trout', 'walleye', 'shad', 'carp', 'herring']
ABOUT = ['labelled', 'named', 'continued', 'mention']
DATED_BY = ['section heading', 'release', 'release (no year: the one before the capture)', 'release (year corrected)',
            'published', 'month named',
            'month captured', 'entry date', 'month of the report', 'video date', 'his date']
WATER_FROM = ['heading', 'named', 'place named', 'captains', 'system', 'source page', 'he said', 'none']
DEPTH_KIND = ['water', 'fish', 'unclear']
FISH_POSITION = ['bottom', 'suspended', 'top']
# The lure families a report names (report_text.LURE_WORDS), for every fish. His way is a lure the report trolls, from
# the same list; before 11/6 it was only 'A-rig' and 'crankbait' (stripers). Bait is apart: never his on fresh water.
LURES = ['A-rig', 'square bill', 'deep crankbait', 'lipless crankbait', 'topwater', 'jerkbait', 'crankbait', 'bladed jig',
         'spinnerbait', 'underspin', 'swimbait', 'blade bait', 'spoon', 'inline spinner', 'bucktail', 'soft plastic', 'jig']
HIS_WAY = LURES
BAIT = ['live bait', 'cut bait', 'prepared bait']
TIMES = ['first light', 'morning', 'midday', 'afternoon', 'evening', 'night']
AREAS = ['upper lake', 'lower lake', 'mid lake', 'main lake', 'creek mouths', 'backs of creeks']   # report_places.AREAS
METHODS = ['trolling', 'umbrella rig', 'planer board', 'live bait', 'down-rod', 'cut bait', 'casting', 'jigging']
KINDS = ['humps', 'flats', 'creek channels', 'river / main channel', 'deep water near the dam', 'open water', 'points',
         'trees / timber', 'schooling / birds']
NEVER_STORED = {'era', 'this_week', 'as_it_cools', 'lakes'}   # 'lakes' was the old name; it is `water` now

# field -> (type check, required)
STR, NUM = str, (int, float)
FIELDS = {
    'id': (STR, True), 'source': (STR, True), 'url': (STR, True), 'archived': ((str, type(None)), True),
    'date': (STR, True), 'dated_by': (STR, True),
    'water': (list, True), 'water_from': (STR, True), 'water_as_written': ((str, type(None)), True),
    'species': (list, True), 'species_as_written': ((str, type(None)), True), 'about': (STR, True),
    'who': (list, True), 'text': (STR, True), 'context': ((str, type(None)), True),
    'rating': ((str, type(None)), True), 'water_temp_f_said': ((int, float, type(None)), True),
    'gauge': ((dict, type(None)), True), 'depths': (list, True), 'methods': (list, True),
    'lures': (list, True), 'bait': (list, True), 'time_of_day': (list, True),
    'kinds_of_water': (list, True), 'places': (list, True), 'area': (list, True), 'sentences': (list, True),
    'repeated': (list, True), 'copies': (int, True),
}

def make_id(source, url, date, text):
    return hashlib.sha1('|'.join([source, url or '', date or '', text]).encode('utf-8')).hexdigest()[:12]

def blank(**kw):
    """A statement with every field present; the collector fills what it knows."""
    s = {'archived': None, 'water': [], 'water_from': 'none', 'water_as_written': None, 'species': [],
         'species_as_written': None, 'about': 'named', 'who': [], 'context': None, 'rating': None,
         'water_temp_f_said': None, 'gauge': None, 'depths': [], 'methods': [], 'lures': [], 'bait': [],
         'time_of_day': [], 'kinds_of_water': [], 'places': [],
         'area': [], 'sentences': [], 'repeated': [], 'copies': 0}
    s.update(kw)
    s['id'] = make_id(s['source'], s['url'], s['date'], s['text'])
    return {k: s[k] for k in FIELDS}

# ---- the check -----------------------------------------------------------------------------------------------------
NORM = lambda t: re.sub(r'\s+', ' ', (t or '').replace('**', '')).strip()
# A page's wrapping is not a report ("... Read more" ending a teaser; a report's own "(read more in the Charleston
# report)" is the guide's cross-reference and stays). AHQ's teaser cards were his 8/15 reason for keeping AHQ out of the plan
# ("it had a bunch of general non fishing report stuff stuck to it"); site footers and menus are the same thing.
# "sign up" only as the page says it ("Sign up for our newsletter", "sign up now"): a guide's "you can still sign up the
# morning of the tournament" (AHQ, Lake Murray, 2021-08-25) is his report, and refusing it refused Murray's whole file.
WRAPPING = re.compile(r'exclusive content|(?:\.\.\.|…)\s*read more|read more\s*$|subscribe|ahq insider|members? only|'
                      r'sign up (?:now|today|here|for (?:our|the|a free) (?:newsletter|e-?mail|insider|account)|to (?:receive|get))|'
                      r'advertis|newsletter|'
                      r'phone numbers \||accessibility|all rights reserved|webmaster@|google custom search|'
                      r'skip to content|purchase a fishing license', re.I)

def date_ok(d):
    try:
        (dt.date.fromisoformat(d) if len(d) == 10 else dt.date.fromisoformat(d + '-01'))
        return len(d) in (7, 10)
    except (ValueError, TypeError):
        return False

def check(s, slugs, sources_text):
    e = []
    for k in s:
        if k in NEVER_STORED: e.append('%s is worked out at plan time, never stored' % k)
        elif k not in FIELDS: e.append('unknown field %s' % k)
    for k, (t, req) in FIELDS.items():
        if k not in s: e.append('missing %s' % k); continue
        if not isinstance(s[k], t) or (t is int and isinstance(s[k], bool)): e.append('%s is %r' % (k, type(s[k]).__name__))
    if e: return e
    if s['id'] != make_id(s['source'], s['url'], s['date'], s['text']): e.append('id does not match')
    if s['source'] not in SOURCES: e.append('source %r not in the table' % s['source'])
    if not date_ok(s['date']): e.append('date %r' % s['date'])
    if s['dated_by'] not in DATED_BY: e.append('dated_by %r' % s['dated_by'])
    bad = [w for w in s['water'] if w not in slugs]
    if bad: e.append('water not in the registry: %s' % bad)
    if s['water_from'] not in WATER_FROM: e.append('water_from %r' % s['water_from'])
    if bool(s['water']) == (s['water_from'] == 'none'): e.append('water and water_from disagree')
    if not s['species'] or any(x not in SPECIES for x in s['species']): e.append('species %r' % s['species'])
    if s['about'] not in ABOUT: e.append('about %r' % s['about'])
    if any(not isinstance(x, str) for x in s['who']): e.append('who')
    if not s['text'].strip(): e.append('no text')
    if WRAPPING.search(s['text']): e.append('page wrapping in the text: %r' % WRAPPING.search(s['text']).group(0))
    src = sources_text.get(s['archived']) or sources_text.get(s['url'])
    if src is None: e.append('no stored source record for %s' % (s['archived'] or s['url']))
    elif not any(NORM(s['text']) in t for t in src): e.append('text is not word for word in its source')
    g = s['gauge']
    if g is not None:
        if not {'site', 'of', 'min_f', 'mean_f', 'max_f'} <= set(g): e.append('gauge fields')
        elif not str(g['of']).startswith(s['date'][:7]): e.append('gauge day %s is not the statement\'s' % g['of'])
    for d in s['depths']:
        if d.get('kind') not in DEPTH_KIND or not d.get('ft') or not all(isinstance(x, int) for x in d['ft']): e.append('depth %r' % d)
    if any(m not in METHODS for m in s['methods']): e.append('methods %r' % s['methods'])
    if any(m not in LURES for m in s['lures']): e.append('lures %r' % s['lures'])
    if any(m not in BAIT for m in s['bait']): e.append('bait %r' % s['bait'])
    if any(m not in TIMES for m in s['time_of_day']): e.append('time_of_day %r' % s['time_of_day'])
    if any(k not in KINDS for k in s['kinds_of_water']): e.append('kinds_of_water %r' % s['kinds_of_water'])
    for p in s['places']:
        if not {'name', 'lon', 'lat'} <= set(p) or not all(isinstance(p[k], (int, float)) for k in ('lon', 'lat')):
            e.append('place %r' % p)
    if any(a not in AREAS for a in s['area']): e.append('area %r' % s['area'])
    for x in s['sentences']:
        if (any(f not in FISH_POSITION for f in x.get('fish', [])) or any(h not in HIS_WAY for h in x.get('his_way', []))
                or any(h not in LURES for h in x.get('lures', [])) or any(t not in TIMES for t in x.get('time', []))
                or not set(x.get('his_way', [])) <= set(x.get('lures', x.get('his_way', [])))):
            e.append('sentence %r' % x.get('said', '')[:60])
        elif NORM(x['said']) not in NORM(s['text']): e.append('sentence not in the text')
    if not all(date_ok(r) for r in s['repeated']): e.append('repeated %r' % s['repeated'])
    return e

def source_texts(rep):
    out = collections.defaultdict(list)
    for f in glob.glob(os.path.join(rep, '**', '*.json'), recursive=True):
        try:
            with open(f, encoding='utf-8') as fh: d = json.load(fh)
        except (ValueError, UnicodeDecodeError): continue
        if not isinstance(d, dict) or 'text' not in d: continue
        t = NORM(d.get('text'))
        for c in d.get('comments') or []:
            t += ' ' + NORM(c.get('text'))
        for k in (d.get('archived'), d.get('url')):
            if k: out[k].append(t)
    return out

def main(argv):
    files = [a for a in argv if not a.startswith('--') and argv[argv.index(a) - 1] not in ('--rep', '--registry')]
    rep = argv[argv.index('--rep') + 1]; reg = argv[argv.index('--registry') + 1]
    slugs = set(json.load(open(os.path.join(reg, 'lake_index.json'))))
    texts = source_texts(rep)
    bad_total = 0
    for f in files:
        S = json.load(open(f))['statements']
        errs = collections.Counter(); first = {}
        ids = collections.Counter(s.get('id') for s in S)
        for s in S:
            for x in check(s, slugs, texts) + (['id %s is not unique' % s['id']] if ids[s.get('id')] > 1 else []):
                k = re.sub(r"'[^']*'|\[[^\]]*\]|\d+", '…', x); errs[k] += 1; first.setdefault(k, (s.get('date'), s.get('source'), x, s.get('text', '')[:100]))
        n_bad = sum(1 for s in S if check(s, slugs, texts))
        bad_total += n_bad
        print('%s: %d statements, %d break the contract' % (f, len(S), n_bad))
        for k, n in errs.most_common():
            print('   %5d  %s   e.g. %s' % (n, k, first[k]))
    return 1 if bad_total else 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
