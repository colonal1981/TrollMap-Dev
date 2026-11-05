"""report_column.py -- SC's weekly freshwater fishing column, every water and every species in it, dated.

Personal use only, not for distribution or resale; not for navigation.

The column is one column in three places: SCDNR's own weekly release from marina and tackle-shop reporters
(2004-2011), then AHQ's guide reports on SCDNR's page (2011 on); The Sumter Item reprinted it weekly (2004-2017), and
the Internet Archive kept SCDNR's page (2005-2026). Three shapes:
  - to about 2011, a paragraph a lake: "LAKE MARION: Largemouth Bass: Fair, ... Striped Bass: Good. ..."
  - 2010-2014, a heading a water ("Santee Cooper System", "**Lake Murray:**") over one line a species
    ("Striped Bass: Very good. Lake World reports ...")
  - 2015 on, AHQ's prose under a heading ("## Santee Cooper System (Updated May 10)", "### Santee Cooper"), the
    species in bold or named in the paragraph ("On the **catfish** front, Captain Jim Glenn ..."); from about 2019
    labelled again ("**Striped bass:** Captain Bobby Winters ...").
Each water heading is matched to the registry by the registry's own names: its name, its legacy display names and
lake_aliases.json, for waters in South Carolina. "Santee Cooper" is the sources' word for Marion and Moultrie
together; it is not a registry name, so it is the one table here.
"""
import json, os, re, datetime as dt

# The sources' own word for two registry waters. Every report calls the pair "Santee Cooper".
SYSTEMS = {'santee cooper system': ['lake_marion', 'lake_moultrie'], 'santee cooper lakes': ['lake_marion', 'lake_moultrie'],
           'santee cooper': ['lake_marion', 'lake_moultrie'], 'santee-cooper': ['lake_marion', 'lake_moultrie']}

def registry_names(regdir):
    """name (lower case) -> [slugs], for every registry water any part of which is in South Carolina."""
    with open(os.path.join(regdir, 'lake_index.json'), encoding='utf-8') as fh: I = json.load(fh)
    with open(os.path.join(regdir, 'lake_aliases.json'), encoding='utf-8') as fh: A = json.load(fh)
    # Lakes and rivers only: the column's saltwater part ("Charleston Area: Red drum ...") is another report, and its
    # "trout" and "black bass" are seatrout and sea bass.
    sc = {k for k, v in I.items() if 'SC' in (v.get('states') or [v.get('state')]) and v.get('feature_type') in ('lake', 'river')}
    names = {}
    def add(n, slug):
        n = re.sub(r'\s*\((?:[^)]*Co|[^)]*County)[^)]*\)', '', n)          # "(Kershaw Co, SC)"
        n = re.sub(r',\s*[A-Z]{2}(?:/[A-Z]{2})*$', '', n).strip()        # ", SC/GA"
        n = re.sub(r'\s+', ' ', n.replace('’', "'")).strip().lower()
        if len(n) > 3 and ' - ' not in n:                                # "Seneca River - Lake Hartwell" is an arm
            names.setdefault(n, [])
            if slug not in names[n]:
                names[n].append(slug)
    for k in sc:
        v = I[k]
        for n in [v.get('name') or ''] + list(v.get('legacy_display_names') or []):
            add(n, k)
    for n, k in A.items():
        if k in sc:
            add(n, k)
    for n, ks in SYSTEMS.items():
        names[n] = list(ks)
    return names, {k: I[k].get('name') for k in sc}

_GLUED = [None]

def heading_rx(names):
    alts = sorted(names, key=len, reverse=True)
    body = '|'.join(re.escape(n).replace(r'\ ', r'\s+') for n in alts)
    # the whole line is the name (with a date in brackets, a colon, or nothing), or the name and a colon open it
    # a heading glued onto the end of the line before it: "... both blues and flatheads.Freshwater Report Lake Jocassee"
    _GLUED[0] = re.compile(r"(?<=[.!?])\s*(?:Freshwater Report\s+)?(?=(?:\*\*)?(?:" + body + r")(?:\*\*)?\s*:?\s*$)", re.I)
    return re.compile(r"^(?:#+\s*)?(?:\*\*)?\s*(?P<name>" + body + r")\s*(?:\*\*)?\s*(?P<paren>\([^)]{1,30}\)|\d{1,2}/\d{1,2}(?:/\d{2,4})?|[-–]\s*(?:[A-Z][a-z]{2,8}\.?\s+\d{1,2}|\d{1,2}/\d{1,2}))?\s*"
                      r"(?P<colon>:)?\s*(?:\*\*)?\s*(?P<rest>.*)$", re.I)

# ---- species ----------------------------------------------------------------------------------------------------
SPECIES_WORDS = [  # (canonical, pattern on one word group); order matters: "striped bass" before "bass"
    ('hybrid striped bass', r'hybrids?(?: bass| stripers?)?'),
    ('striped bass', r'striped(?: bass)?|stripers?(?: bass)?|rockfish'),
    ('white bass', r'white bass'), ('spotted bass', r'spotted(?: bass)?|spots'),
    ('smallmouth bass', r'smallmouth(?: bass)?'), ('largemouth bass', r'largemouth(?: bass)?'),
    ('black bass', r'black bass|bass'),
    ('white perch', r'white perch'), ('yellow perch', r'yellow perch'), ('perch', r'perch'),   # kind not said
    ('crappie', r'crappies?|specks?'),
    ('shellcracker', r'sh[ae]ll ?crac?kers?|redear(?: sunfish)?'), ('bream', r'bream|bluegills?|sunfish'),
    ('catfish', r'(?:channel |blue |flathead )?cat(?:fish)?s?'), ('trout', r'(?:brown |rainbow |brook )?trout'),
    ('walleye', r'walleyes?'), ('shad', r'(?:american |hickory )?shad'), ('carp', r'carp'), ('herring', r'herring'),
]
_SP = [(c, re.compile(r'^(?:' + p + r')$', re.I)) for c, p in SPECIES_WORDS]

def species_of_label(label):
    """'Striped and Hybrid Bass' -> ['striped bass', 'hybrid striped bass']; None if any part is not a fish."""
    lab = re.sub(r'\s+', ' ', label.replace('**', '')).strip().lower()
    parts = [p.strip() for p in re.split(r'\s*(?:,|&|/|\band\b)\s*', lab) if p.strip()]
    if not parts or len(lab) > 45: return None
    out = []
    for i, p in enumerate(parts):
        # "Striped and Hybrid Bass", "Largemouth and Spotted Bass": the last word belongs to every part
        q = p
        tail = parts[-1].split()[-1] if len(parts) > 1 else ''
        hit = next((c for c, rx in _SP if rx.match(q)), None)
        if not hit and tail and i < len(parts) - 1:
            hit = next((c for c, rx in _SP if rx.match(q + ' ' + tail)), None)
        if not hit: return None
        if hit not in out: out.append(hit)
    return out

MENTION = re.compile(r"\b(hybrid(?:s| bass| stripers?)?|striped bass|stripers?|white bass|spotted bass|smallmouth|"
                     r"largemouth|black bass|bass|white perch|yellow perch|crappie|specks?|shellcrackers?|redear|bream|"
                     r"bluegills?|(?:channel |blue |flathead )?catfish|cats|trout|walleyes?)\b", re.I)   # not "spots": good spots

def species_in(text):
    out = []
    for m in MENTION.finditer(text):
        w = m.group(1).lower()
        if w == 'bass' and re.search(r'(striped|white|spotted|largemouth|smallmouth|black|hybrid)\s+$', text[:m.start()].lower()):
            continue
        if re.search(r'\b(cut|live|dead|fresh|frozen|small|using|with|on|(?:strips?|pieces?|chunks?|fillets?|bits?)\s+of)\s+$',
                     text[max(0, m.start() - 16):m.start()].lower()):
            continue                                     # "cut white perch", "live bream", "strips of bream": bait
        # "of" alone is not bait: "a ton of crappie", "numbers of stripers", "speaking of stripers" are the fish reported
        c = next((c for c, rx in _SP if rx.match(w)), None)
        if c and c not in out: out.append(c)
    return out

LABEL = re.compile(r"(?:(?<=[.!?;\n])|^)\s*(?:\*\*)?\s*(?P<lab>[A-Z][A-Za-z]+(?:[ /&,-]+(?:and\s+)?[A-Za-z]+){0,4})\s*"
                   r"(?:\*\*)?\s*:\s*(?:\*\*)?", re.M)
RATING = re.compile(r'^\s*(excellent|very good|good to excellent|good to very good|good|fair to good|fair|slow to fair|'
                    r'slow|poor|erratic|tough|steady|improving|picking up)\b[.,:]?', re.I)
# "... Charleston Area: Redfish ...", "Helena Sound:", "Lake Murray Striper:" -- another place's report run on into
# this one on the same line. The part ends there.
ELSEWHERE = re.compile(r"(?<=[.!?])\s+(?=(?:[A-Z][a-z]+\s+){0,3}(?:Area|Sound|Piers?|Inlet|Harbor|Beach|Inshore|Offshore|Surf)s?\s*:"
                       r"|(?:Lake|LAKE)\s+[A-Z][a-z]+\s+[A-Z][a-z]+\s*:)")
# SCDNR's page footer, run onto the last species line of the page (2008-2011): "... South Carolina Department of
# Natural Resources - Phone Numbers | Accessibility Rembert C. Dennis Building, 1000 Assembly Street ..."
FOOTER = re.compile(r'\s*(?:South Carolina Department of Natural Resources\s*-\s*Phone Numbers|Phone Numbers\s*\||'
                    r'Rembert C\. Dennis Building|©\s*\d{4}|All rights reserved)', re.I)
CONDITIONS = re.compile(r'(?<=[.!?])\s*(?=(?:Water (?:temperatures?|levels?|clarity)|Clarity|Lake levels?)\b)')
TEMP = re.compile(r'water temperatures?\b[^.\d]{0,45}?(?:(low|mid|middle|upper|high|lower)[- ]?)?(\d{2})(s)?'
                  r'(?:\s*(?:-|–|to|and)\s*(?:the )?(?:(?:low|mid|upper|high)[- ]?)?(\d{2})s?)?', re.I)

def temp_f(text):
    m = TEMP.search(text)
    if not m: return None
    a, b = int(m.group(2)), int(m.group(4)) if m.group(4) else None
    if m.group(3) or (m.group(1) and not b):          # "mid-70s", "low 60s"
        adj = {'low': 2, 'lower': 2, 'mid': 5, 'middle': 5, 'upper': 8, 'high': 8}.get((m.group(1) or '').lower(), 5)
        a = a + adj if a % 10 == 0 else a
    v = (a + b) / 2 if b else a
    return v if 35 <= v <= 95 else None

# ---- dates --------------------------------------------------------------------------------------------------------
MON = {m[:3]: i for i, m in enumerate(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
                                      'september', 'october', 'november', 'december'], 1)}
MONTH_NAMED = re.compile(r'\b(january|february|march|april|may|june|july|august|september|october|november|december)\b', re.I)

def near_date(mo, day, ref):
    """month/day nearest before ref (or up to a week after it)."""
    for y in (ref.year, ref.year - 1, ref.year + 1):
        try: d = dt.date(y, mo, day)
        except ValueError: continue
        if dt.timedelta(days=-7) <= ref - d <= dt.timedelta(days=330): return d
    return None

def paren_date(paren, ref):
    if not paren: return None
    p = paren.strip('()-– ').lower()
    m = re.search(r'(\d{1,2})/(\d{1,2})', p)
    if m: return near_date(int(m.group(1)), int(m.group(2)), ref)
    m = re.search(r'([a-z]{3})[a-z]*\.?\s+(\d{1,2})', p)
    if m and m.group(1) in MON: return near_date(MON[m.group(1)], int(m.group(2)), ref)
    return None

RELEASE = re.compile(r'(?:NEWS RELEASE|Fishing Trends)\W{0,12}([A-Z][a-z]{2,8})\.?\s+(\d{1,2})\b(?:,\s*(20\d\d))?', re.I)

def release_date(text, captured):
    """SCDNR's own release date at the top of the page. A year that puts it a year before the capture, when the
    month and day put it within two months of it, is the page's typo ("Jan. 27, 2010" captured 2011-02-03)."""
    m = RELEASE.search(text[:3000])
    if not m or m.group(1)[:3].lower() not in MON: return None, None
    if not m.group(3):                                   # 2012-2015: "Freshwater Fishing Trends - Jan. 10"
        d = near_date(MON[m.group(1)[:3].lower()], int(m.group(2)), captured) if captured else None
        return (d, 'release (no year: the one before the capture)') if d else (None, None)
    try: d = dt.date(int(m.group(3)), MON[m.group(1)[:3].lower()], int(m.group(2)))
    except ValueError: return None, None
    if captured and 300 < (captured - d).days < 430:
        try:
            d2 = d.replace(year=d.year + 1)
            if 0 <= (captured - d2).days <= 62: return d2, 'release (year corrected)'
        except ValueError: pass
    return d, 'release'

# ---- the walk -----------------------------------------------------------------------------------------------------
BREAK = re.compile(r'^(?:#+\s*)?(?:\*\*)?\s*(mountains? area|piedmont area|midlands area|coastal|saltwater|inshore|offshore|'
                   r'piers?|surf|reporters|most\b|updates?|see |information on|fishing trends courtesy|fishing information|'
                   r'sc freshwater|south carolina freshwater|purchase|boat ramp|state fish|copyright|©)', re.I)

AMBIGUOUS = {}

def walk(text, names, hrx):
    """[(slugs, heading as written, paren, body)] in page order. Text before the first heading comes first, with
    slugs [] (no water named): The Item's 2007-2009 stories are often one lake's report with no heading at all."""
    cur = [[], None, None, []]
    out = [cur]
    lines = []
    for raw in text.split('\n'):
        lines += [p for p in _GLUED[0].split(raw)] if _GLUED[0] else [raw]
    for raw in lines:
        line = raw.strip()
        if not line: continue
        clean = line.replace('**', '').strip()
        if not clean: continue                                    # a bold run's closing "**" on its own line
        m = hrx.match(line)
        if m and (not m.group('rest') or m.group('colon')):
            key = re.sub(r'\s+', ' ', m.group('name').replace('’', "'")).lower()
            slugs = names.get(key)
            if slugs and len(slugs) > 1 and key not in SYSTEMS:
                AMBIGUOUS[key] = AMBIGUOUS.get(key, 0) + 1; slugs = None   # two registry waters, one name: neither
            paren, rest = m.group('paren'), m.group('rest')
            pm = re.match(r'^\(([^)]{1,30})\)\s*(.*)$', rest or '')
            if not paren and pm:                         # "**Lake Greenwood:** (unchanged from Jan. 3)"
                paren, rest = '(' + pm.group(1) + ')', pm.group(2)
            cur = [slugs, m.group('name'), paren, []]
            out.append(cur)
            if rest: cur[3].append(rest)
            continue
        short = len(clean) <= 60 and not clean.endswith('.') and not LABEL.match(clean)
        lab = re.match(r"^([A-Z][A-Za-z.'’ /&-]{2,40}?)\s*:", clean)
        other = lab and not species_of_label(lab.group(1)) and not re.match(r'(?i)water|lake level|clarity', lab.group(1))
        if BREAK.match(line) or other or (short and (line.startswith('#') or (line.startswith('**') and line.endswith('**')))):
            cur = None; continue   # another place's report, a menu, a footer: not this water's
        if cur is not None:
            cur[3].append(line)
    return [(s, h, p, '\n'.join(b)) for s, h, p, b in out if s is not None and b]

def parts(body):
    """[(species, label as written or None, rating, text, about)] for one water's section."""
    flat = body.replace('**', '')
    labs = [m for m in LABEL.finditer(flat) if species_of_label(m.group('lab'))]
    out = []
    if labs:
        for i, m in enumerate(labs):
            end = labs[i + 1].start() if i + 1 < len(labs) else len(flat)
            t = flat[m.end():end].strip()
            t = CONDITIONS.split(t)[0].strip()
            t = ELSEWHERE.split(t)[0].strip()
            t = FOOTER.split(t)[0].strip()
            t = re.sub(r'\s+', ' ', t)
            r = RATING.match(t)
            if len(t) > 12:
                out.append((species_of_label(m.group('lab')), m.group('lab'), r.group(1).lower() if r else None, t, 'labelled'))
        return out
    prev = None
    for para in [p.strip() for p in body.split('\n') if p.strip()]:
        bold = [w for b in re.findall(r'\*\*([^*]{2,40})\*\*', para) for w in (species_of_label(b) or [])]
        t = FOOTER.split(re.sub(r'\s+', ' ', para.replace('**', '')).strip())[0].strip()
        if len(t) < 40: continue
        if len(t) < 200 and not re.search(r'[.!?"”’)]\s*$', t): continue      # a photo caption, not a report
        first = re.split(r'(?<=[.!?])\s', t, maxsplit=1)[0]
        sp, about = (bold, 'named') if bold else (species_in(first), 'named')
        if not sp and prev:
            # a paragraph that does not open on a fish carries on the one before it ("Brad says that if you are
            # looking..."); fish named further in are usually bait or by-catch
            sp, about = prev, 'continued'
        if not sp:
            sp, about = species_in(t), 'mention'
        if not sp:
            continue
        if sp:
            out.append((sp, None, None, t, about)); prev = sp if about != 'mention' else prev
    return out

def item_date(rec):
    p = (rec.get('published') or '').strip()
    for f, s in (('%a, %d %b %Y', p[:16].strip()), ('%m/%d/%y', p.split()[0] if p else '')):
        try: return dt.datetime.strptime(s, f).date()
        except ValueError: pass
    return None

def statements(rec, source, names, hrx):
    """Every (water, species) statement in one story or one capture."""
    text = rec.get('text') or ''
    if source == 'Item':
        ref, how = item_date(rec), 'published'
    else:
        cap = dt.date.fromisoformat(rec['fetched'])
        ref, how = release_date(text, cap)
        if not ref: ref, how = cap, None
    if not ref: return []
    out = []
    for slugs, head, paren, body in walk(text, names, hrx):
        pd = paren_date(paren, ref)
        if pd: when, how2 = pd.isoformat(), 'section heading'
        elif how: when, how2 = ref.isoformat(), how
        else:
            # AHQ's monthly page has no date: the month it names, else the month it was captured in
            mn = MONTH_NAMED.search(body)
            mo = MON[mn.group(1)[:3].lower()] if mn else ref.month
            y = ref.year if mo <= ref.month + 1 else ref.year - 1
            when, how2 = '%04d-%02d' % (y, mo), 'month named' if mn else 'month captured'
        t_f = temp_f(body)
        for sp, lab, rating, t, about in parts(body):
            out.append({'source': source, 'url': rec.get('url'), 'archived': rec.get('archived'), 'date': when, 'who': who(t),
                        'dated_by': how2, 'waters': slugs, 'heading': head, 'species': sp, 'label': lab,
                        'rating': rating, 'about': about, 'text': t, 'water_temp_f_said': t_f})
    return out

CAPT = re.compile(r'\b(?:Captain|Capt\.)\s+([A-Z][a-z]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z]+)+)')

def who(text):
    return sorted(set(CAPT.findall(text)))

def _wordset(text):
    return {w[:-1] if w.endswith('s') and len(w) > 3 else w for w in re.findall(r"[a-z]+", text.lower().replace('’', "'"))}

def one_page_two_waters(st, names, long=120):
    """One page's statements, less the report paragraphs it prints word for word under two waters (SCDNR's page of
    2010-08-04 put Lake Greenwood's three paragraphs under Lake Wateree too; The Item copied such pages). The page
    contradicts itself, so the paragraph goes only to a water its own words name ("the bite on Greenwood"), and to
    neither when they name none: the rule for one name on two registry waters. Short stock lines ("Good, using
    nightcrawlers on the bottom.") are said of many lakes and stay with each, and so does one paragraph under the
    two lakes of one system (Marion and Moultrie). Returns (kept, how many were taken off a water)."""
    import report_ahq as _A
    by = {}
    for x in st:
        if x['waters'] and len(x['text']) >= long:
            by.setdefault((tuple(x['species']), re.sub(r'[^a-z0-9]+', ' ', x['text'].lower()).strip()), []).append(x)
    words = {}
    for n, slugs in names.items():
        w = _A.words(n)
        if w:
            for sl in slugs: words.setdefault(sl, []).append(w)
    drop = set()
    for xs in by.values():
        ws = {tuple(x['waters']) for x in xs}
        if len(ws) < 2: continue
        every = set().union(*[set(w) for w in ws])
        if any(every == set(v) for v in SYSTEMS.values()): continue
        said = _wordset(xs[0]['text'])
        named = {sl for sl in every if any(w <= said for w in words.get(sl, []))}
        for x in xs:
            if not set(x['waters']) & named: drop.add(id(x))
    return [x for x in st if id(x) not in drop], len(drop)

def assign_unheaded(rows):
    """A statement under no heading gets a water only from the people it names: when every captain in it is, in
    every headed statement that names him, on the same water(s). Marked `water_from: captains`; the rest stay []."""
    seen = {}
    for r in rows:
        if r['waters']:
            for c in r['who']:
                seen.setdefault(c, set()).add(tuple(r['waters']))
    n = 0
    for r in rows:
        if r['waters'] or not r['who']: continue
        sets = [seen.get(c) for c in r['who']]
        if not all(sets): continue
        union = set().union(*[set(w) for ws in sets for w in ws])
        # one water, or one of the sources' own pairs ("Santee Cooper": a captain on Marion, on Moultrie and on both)
        if len(union) == 1 or any(union == set(v) for v in SYSTEMS.values()):
            r['waters'] = sorted(union); r['water_from'] = 'captains'; n += 1
    return n

SANTEE = {'lake_marion', 'lake_moultrie', 'diversion_canal', 'rediversion_canal'}

def era(date, waters):
    """Santee Cooper's striper law (S.C. Code 50-13-230): derived, never stored. Other waters: None until looked at."""
    if not date or not (set(waters) & SANTEE): return None
    d = date if len(date) == 10 else date + '-15'
    return 'before the 2008 law' if d < '2008-05-21' else '2008-2018' if d < '2018-05-03' else 'the 2018 slot'

def collapse_repeats(rows, at=0.85):
    """AHQ's monthly page re-uses last year's paragraph for the same month with a few words changed ("as the
    striper season reopens a lot of people will fish for them by trolling ..." in 2023, 2025 and 2026). One
    paragraph written once is one statement: the earliest is kept, and the later dates go in `repeated`."""
    import difflib
    norm = lambda t: re.sub(r'[^a-z0-9 ]+', ' ', t.lower()).split()
    groups = {}
    for i, r in enumerate(rows):
        groups.setdefault((tuple(r['waters']), tuple(r['species']), r['date'][5:7]), []).append(i)
    drop = set()
    for ids in groups.values():
        ids.sort(key=lambda i: rows[i]['date'])
        words = {i: norm(rows[i]['text']) for i in ids}
        for a_i, a in enumerate(ids):
            if a in drop: continue
            for b in ids[a_i + 1:]:
                if b in drop: continue
                same_year = rows[b]['date'][:4] == rows[a]['date'][:4]
                # within a year only a reprint folds (The Item's copy of SCDNR's line, "Capt." for "Captain"): one
                # source's next week with a word changed is that week's report
                if same_year and rows[b]['source'] == rows[a]['source']: continue
                need = 0.9 if same_year else at
                sm = difflib.SequenceMatcher(None, words[a], words[b], autojunk=False)
                if sm.real_quick_ratio() >= need and sm.quick_ratio() >= need and sm.ratio() >= need:
                    drop.add(b)
                    rows[a]['repeated'] = sorted((set(rows[a].get('repeated', [])) | {rows[b]['date']}
                                                  | set(rows[b].get('repeated', []))) - {rows[a]['date']})
    return [r for i, r in enumerate(rows) if i not in drop], len(drop)

def species_by_captains(rows, share=0.3, least=5):
    """A paragraph that carries on the one before ("continued") but names a guide who, wherever he is named with a
    fish, talks about other fish, is about his fish: Stevie English on catfish, Steve English on crappie and bream,
    Bobby Winters on stripers. Learned from the statements themselves; changes only `continued` ones."""
    by, n = {}, {}
    for r in rows:
        if r['about'] in ('labelled', 'named'):
            for c in r['who']:
                n[c] = n.get(c, 0) + 1
                for sp in r['species']:
                    by.setdefault(c, {})[sp] = by.setdefault(c, {}).get(sp, 0) + 1
    main = {c: sorted((sp for sp, k in d.items() if k / n[c] >= share), key=lambda sp: -d[sp])
            for c, d in by.items() if n[c] >= least}
    changed = 0
    for r in rows:
        if r['about'] != 'continued' or not r['who'] or not all(main.get(c) for c in r['who']): continue
        his = sorted({sp for c in r['who'] for sp in main[c]})
        if not set(r['species']) & set(his):
            r['species'] = his; changed += 1
    return changed

# ---- reading SCDNR's live page --------------------------------------------------------------------------------------
from html.parser import HTMLParser

class _Text(HTMLParser):
    """Headings kept as #, bold as **, a block as a line: the shape fetch_scdnr_wayback.py saves captures in."""
    BLOCK = {'p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'li', 'tr', 'section', 'td', 'table'}
    def __init__(self): super().__init__(); self.out = []; self.skip = 0
    def handle_starttag(self, t, a):
        if t in ('script', 'style'): self.skip += 1
        if t in self.BLOCK: self.out.append('\n')
        if t in ('h2', 'h3', 'h4'): self.out.append('#' * int(t[1]) + ' ')
        if t in ('strong', 'b'): self.out.append('**')
    def handle_endtag(self, t):
        if t in ('script', 'style'): self.skip -= 1
        if t in ('strong', 'b'): self.out.append('**')
        if t in self.BLOCK: self.out.append('\n')
    def handle_data(self, d):
        if not self.skip: self.out.append(d)

def page_text(raw_html):
    p = _Text(); p.feed(raw_html)
    text = re.sub(r'[ \t\r\f\v\xa0]+', ' ', ''.join(p.out))
    return re.sub(r'\n\s*\n+', '\n', text).strip()

SCDNR_PAGE = 'https://www.dnr.sc.gov/news/freshwater.html'

def fetch_live_page(timeout=60):
    """SCDNR's Freshwater Fishing Trends as it stands today, saved with the day it was read (the page states none)."""
    import urllib.request
    raw = urllib.request.urlopen(urllib.request.Request(SCDNR_PAGE, headers={
        'User-Agent': 'Mozilla/5.0 (personal fishing app research; reading public reports)'}), timeout=timeout).read()
    text = page_text(raw.decode('utf-8', 'replace'))
    day = dt.date.today().isoformat()
    return {'url': SCDNR_PAGE, 'fetched': day, 'title': 'SCDNR Freshwater Fishing Trends, read %s' % day,
            'chars': len(text), 'text': text}
