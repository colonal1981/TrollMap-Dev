#!/usr/bin/env python3
r"""build_fishbase_traits.py -- the measured number that says whether a fish is forage.

    py .\scripts\build_fishbase_traits.py                    # dry run: what it would fetch
    py .\scripts\build_fishbase_traits.py --go --limit 5     # smoke test, ten seconds
    py .\scripts\build_fishbase_traits.py --go               # the whole pull, ~15 minutes
    py .\scripts\build_fishbase_traits.py --go --refresh     # re-fetch what is already stored

Dry run by default, like every other writer in this pipeline. `--go` writes
registry/fishbase_traits.json. IT IS RESUMABLE: every species is written the moment it parses,
and a second run skips what is already stored, so a run that dies at 400 costs nothing.

WHY THIS EXISTS. `NON_GAME_SPECIES` in Worker/research/facts-util.js is a hand-written set of
about sixty names, and its own comments record every time it was wrong -- hickory shad missing
while American shad was in it, `MULLET (STRIPED AND WHITE)`, `Other Species`, `Black Bass Spp.`
It is the table this codebase most obviously should not be hand-writing, and the reason it was
hand-written is that nothing here held the number that draws the line.

FishBase holds it, per species, from diet studies:

    Micropterus salmoides   Largemouth Bass   3.8 +/- 0.4    Max length 97.0 cm
    Dorosoma petenense      Threadfin Shad    2.8 +/- 0.1    Max length 33.0 cm
    Etheostoma olmstedi     Tessellated Darter 2.9 +/- 0.36  Max length 11.0 cm

THE TROPHIC LEVEL IS NOT THE WHOLE ANSWER AND THIS FILE DOES NOT PRETEND IT IS. A tessellated
darter and a threadfin shad sit within 0.1 of each other and only one of them is a forage base
worth planning around; an 11 cm ceiling and a 33 cm ceiling say more than the trophic levels do.
So max length, common length and the milieu come out of the same page and land beside it, and
what draws the line is left to the reader rather than decided here.

THE MILIEU IS THE OTHER PRIZE. Ryan's rule for what belongs in this app is "nothing saltwater
that is not inshore", and `Marine; freshwater; brackish; pelagic-neritic; anadromous` is that
question answered by the same fetch. Blueback herring reads anadromous and Spanish mackerel
reads marine, and neither of those is currently written down anywhere.

WHERE THE WORK LIST COMES FROM, and it is not typed here.

  1. The four state exports Ryan pulled on 2026-09-04 -- SC/NC/GA/TN_Fishbase_SE_Full.csv,
     1,128 rows, 795 distinct binomials, every one of them clean `Genus species` because they
     came out of FishBase in the first place. Order, Family and Occurrence come free with them.
  2. registry/species_traits.json's `scientific` field -- SCDNR's 56 species -- because sixteen
     of those are NOT in the four freshwater listings and six of the sixteen are exactly the
     inshore saltwater fish the app is supposed to carry: spotted seatrout, weakfish, red drum,
     croaker, southern kingfish, Spanish mackerel.

JOIN ON THE BINOMIAL, NEVER ON THE COMMON NAME, and this file is why. FishBase says "Blueback
shad", "American gizzard shad" and "Largemouth black bass" where the app says Blueback Herring,
Gizzard Shad and Largemouth Bass. A common-name join was measured on 2026-09-04 and matched 30
of the app's 67 canonical species. The binomial matches 795 of 795.

THIRTEEN OF THOSE ARE NOT IN THE STATE EXPORTS AND THEY SPLIT THREE WAYS, measured on
2026-09-04. Five are the agency's own spelling of a fish FishBase files under a slightly
different name, and nearest() below resolves each to exactly one accepted binomial -- Channel
Catfish, Smallmouth Bass, Rainbow Trout, Flathead Catfish and Walleye, five of the species most
often planned for. Seven are valid names simply absent from four FRESHWATER listings, six of
them the inshore saltwater fish the app carries on purpose, and they are fetched like anything
else. One -- `Stizostedion vitreum`, walleye's pre-2004 genus -- shares no string with `Sander
vitreus` and is deliberately left alone; walleye reaches the table through the TN row regardless.
Two more are hybrids, `Morone saxatilis X chrysops`, which correctly have no FishBase page at
all and are never fetched. NOTHING IS PATCHED UPSTREAM: those spellings are what the SCDNR guide
says, and a parser that corrects its document is a parser that cannot be trusted about the rest
of it.

THE CANARY RUNS BEFORE THE LONG RUN. `--go` fetches Micropterus salmoides first and checks the
three fields it already knows the answers to. If the parse has drifted, it stops on request one
with the raw page saved to registry/_fishbase_raw/, instead of spending fifteen minutes writing
811 empty records.

Personal use only, not for distribution or resale; not for navigation.
"""
import argparse
import csv
import difflib
import glob
import html as htmllib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

BASE = 'https://www.fishbase.se/summary/%s.html'
UA = ('trollmap-fishbase/1.0 (+personal use, one pass; '
      'https://github.com/colonal1981/TrollMap-Dev)')
OUT = 'fishbase_traits.json'
RAW_DIR = '_fishbase_raw'

# The canary. Three fields whose values are on the page and were read by hand on 2026-09-04.
CANARY = ('Micropterus salmoides', {'trophic_level': 3.8, 'max_length_cm': 97.0,
                                    'milieu': ['freshwater']})


# ── READING THE PAGE ─────────────────────────────────────────────────────────────────────────
# FishBase summary pages are table soup: `Trophic level (Ref. 69278)` is one <td> and
# `3.8 +/-0.4 se; based on diet studies.` is the next one. So the whole document is flattened to
# a SINGLE LINE with runs of whitespace collapsed, and every pattern below bridges the cell
# boundary with \s*. Splitting on tags into lines would put every label on a line of its own,
# separated from its value, which is the shape that makes this look unparseable.

SCRIPTS = re.compile(r'<(script|style|noscript)\b.*?</\1\s*>', re.I | re.S)
TAGS = re.compile(r'<[^>]+>')
CHARSET = re.compile(rb'charset=["\']?\s*([A-Za-z0-9_\-]+)', re.I)


def decode(body):
    """Bytes to text, believing the page's own meta charset -- unless the result is damaged.

    A PAGE THAT DECLARES A CHARSET IT IS NOT SERVED IN IS THE SILENT FAILURE HERE. Take it at
    its word and `10 deg C - 32 deg C` arrives as `10\ufffdC - 32\ufffdC`, the temperature range
    goes missing, and `feeds_on` is quietly full of replacement characters on every record --
    811 of them, with nothing in the summary saying so. So a declared codec that produces
    replacement characters is not believed, and the others are tried.
    """
    order = []
    m = CHARSET.search(body[:4096])
    if m:
        order.append(m.group(1).decode('ascii', 'ignore'))
    order += ['utf-8', 'cp1252', 'latin-1']
    fallback = None
    for enc in order:
        try:
            text = body.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
        if '\ufffd' not in text:
            return text
        if fallback is None:
            fallback = text
    return fallback if fallback is not None else body.decode('utf-8', 'replace')


def flatten(text):
    """Tags out, entities out, all whitespace to single spaces, one line."""
    text = SCRIPTS.sub(' ', text)
    text = TAGS.sub(' ', text)
    text = htmllib.unescape(text)
    text = text.replace('\xa0', ' ').replace('–', '-').replace('—', '-')
    return re.sub(r'\s+', ' ', text).strip()


PM = r'(?:±|\+\s*/\s*-|\+-)'                       # +/- however the page spells it

TROPHIC = re.compile(
    r'Trophic\s*level\s*\(\s*Ref\.\s*(\d+)\s*\)\s*[:|]?\s*'
    r'(\d+(?:\.\d+)?)\s*(?:' + PM + r'\s*(\d+(?:\.\d+)?))?\s*se\b\s*[;,.]?\s*'
    r'(?:based\s+on\s+([^.]{0,60}))?', re.I)

MAXLEN = re.compile(r'Max\s*length\s*:\s*(\d+(?:\.\d+)?)\s*cm\s*(TL|SL|FL|WD|NG|OT|CL|DL)?')
COMLEN = re.compile(r'common\s*length\s*:\s*(\d+(?:\.\d+)?)\s*cm\s*(TL|SL|FL|WD|NG|OT|CL|DL)?',
                    re.I)
MAXWT = re.compile(r'max\.?\s*published\s*weight\s*:\s*(\d+(?:\.\d+)?)\s*(kg|g)\b', re.I)
MAXAGE = re.compile(r'max\.?\s*reported\s*age\s*:\s*(\d+(?:\.\d+)?)\s*year', re.I)

ENV_HEAD = re.compile(r'Environment\s*:\s*milieu[^A-Za-z]{0,40}climate\s*zone'
                      r'(?:[^A-Za-z]{0,40}depth\s*range)?'
                      r'(?:[^A-Za-z]{0,40}distribution\s*range)?', re.I)
# The heading is `Environment: milieu / climate zone / depth range / distribution range`
# with an `Ecology` link tucked inside it, and the value follows. Consuming the whole
# heading above is not enough on its own -- if FishBase ever shortens it, the leftovers
# land at the FRONT of the stored environment string, which is what the first run of this
# script did: `/ depth range / distribution range Ecology Freshwater; benthopelagic`.
HEAD_TAIL = re.compile(r'^[\s/\[\]:.]*(?:(?:depth|distribution)\s*range|Ecology)'
                       r'[\s/\[\]:.]*', re.I)
DEPTH = re.compile(r'depth\s*range\s*(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*m', re.I)
TEMPS = re.compile(r'(-?\d+(?:\.\d+)?)\s*\W{0,3}\s*C\s*-\s*(-?\d+(?:\.\d+)?)\s*\W{0,3}\s*C')
CLIMATE = re.compile(r'\b(Tropical|Subtropical|Temperate|Boreal|Polar|Deep-water)\b')
COLUMN = re.compile(r'\b(benthopelagic|bathypelagic|bathydemersal|pelagic-neritic|'
                    r'pelagic-oceanic|reef-associated|demersal|pelagic)\b', re.I)
MIGRATION = re.compile(r'\b(anadromous|catadromous|amphidromous|potamodromous|oceanodromous|'
                       r'diadromous|non-migratory)\b', re.I)
MILIEU = ('marine', 'freshwater', 'brackish')

CLASSIF = re.compile(r'\b([A-Z][a-z]+iformes)\b\s*(?:\([^)]*\))?\s*>\s*([A-Z][a-z]+idae)\b')
TITLE = re.compile(r'<title>\s*([^,<]+?)\s*,\s*([^:<]+?)\s*(?::|</title>)', re.I | re.S)

BIOLOGY = re.compile(
    r'\bBiology\b\s*(?:\(\s*Ref\.\s*\d+\s*\))?\s*(.{0,1600}?)'
    r'(?:Life\s+cycle\s+and\s+mating|IUCN\s+Red\s+List|Threat\s+to\s+humans|Human\s+uses|'
    r'Main\s+reference|More\s+information|Tools\b)', re.I)
FEEDING = re.compile(r'\b(feed|feeds|feeding|preys?|diet|forages?|consumes?|eats?|'
                     r'carnivor|herbivor|omnivor|planktivor|piscivor)\w*\b', re.I)


def sentences(text):
    return [s.strip() for s in re.split(r'(?<=[.!?])\s+', text) if s.strip()]


def num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse(raw_html):
    """One FishBase summary page -> the fields the app can use. Missing fields stay None."""
    flat = flatten(raw_html)
    rec = {}

    m = TITLE.search(raw_html)
    if m:
        rec['common'] = m.group(2).strip() or None

    m = CLASSIF.search(flat)
    if m:
        rec['order'], rec['family'] = m.group(1), m.group(2)

    m = TROPHIC.search(flat)
    if m:
        rec['trophic_ref'] = int(m.group(1))
        rec['trophic_level'] = num(m.group(2))
        rec['trophic_se'] = num(m.group(3))
        # "based on diet studies" is stomach contents from real work on this species; "based on
        # food items" and "size and trophs of closest relatives" are estimated. The difference
        # is the whole reason this field is carried rather than the number alone.
        rec['trophic_basis'] = (m.group(4) or '').strip().rstrip(';,') or None

    m = MAXLEN.search(flat)
    if m:
        rec['max_length_cm'], rec['length_type'] = num(m.group(1)), m.group(2)
    m = COMLEN.search(flat)
    if m:
        rec['common_length_cm'] = num(m.group(1))
    m = MAXWT.search(flat)
    if m:
        kg = num(m.group(1))
        rec['max_weight_kg'] = kg / 1000.0 if m.group(2).lower() == 'g' else kg
    m = MAXAGE.search(flat)
    if m:
        rec['max_age_years'] = num(m.group(1))

    # THE ENVIRONMENT LINE IS TAKEN FROM AFTER ITS OWN HEADING, not from the whole page. The
    # words `freshwater` and `demersal` appear in the Biology paragraph too, and reading them
    # from there would report a fish's prey's habitat as the fish's own.
    m = ENV_HEAD.search(flat)
    if m:
        env = flat[m.end():m.end() + 520]
        env = re.split(r'\bDistribution\b|\bCountries\b|\bSize\s*/\s*Weight\b', env)[0]
        while True:
            trimmed = HEAD_TAIL.sub('', env, count=1)
            if trimmed == env:
                break
            env = trimmed
        env = env.strip(' []:.')
        rec['environment'] = env or None
        head = env[:260]
        rec['milieu'] = [w for w in MILIEU if re.search(r'\b%s\b' % w, head, re.I)] or None
        c = COLUMN.search(head)
        rec['water_column'] = c.group(1).lower() if c else None
        g = MIGRATION.search(head)
        rec['migration'] = g.group(1).lower() if g else None
        d = DEPTH.search(env)
        if d:
            rec['depth_min_m'], rec['depth_max_m'] = num(d.group(1)), num(d.group(2))
        cl = CLIMATE.search(env)
        rec['climate'] = cl.group(1) if cl else None
        t = TEMPS.search(env)
        if t:
            rec['temp_min_c'], rec['temp_max_c'] = num(t.group(1)), num(t.group(2))

    m = BIOLOGY.search(flat)
    if m:
        hits = [s for s in sentences(m.group(1)) if FEEDING.search(s)]
        text = ' '.join(hits).strip()
        rec['feeds_on'] = (text[:600] + '...') if len(text) > 600 else (text or None)

    return {k: v for k, v in rec.items() if v not in (None, '', [])}


# ── THE WORK LIST ────────────────────────────────────────────────────────────────────────────

def from_csvs(registry_dir):
    """The four state exports -> {binomial: {states, occurrence, order, family, common}}.

    THEY LIVE IN THE PIPELINE ROOT, NOT IN registry/. Ryan's exports land beside the scripts
    folder and the registry folder both, so both are searched and whichever holds them wins --
    rather than making him move four files to satisfy a path typed in here.
    """
    out = {}
    files = []
    for folder in (registry_dir, os.path.dirname(registry_dir), os.getcwd()):
        files = sorted(glob.glob(os.path.join(folder, '*_Fishbase_SE_Full.csv')))
        if files:
            break
    for path in files:
        state = os.path.basename(path).split('_')[0].upper()
        with open(path, encoding='utf-8-sig', newline='') as fh:
            for row in csv.DictReader(fh):
                name = (row.get('Species') or '').strip()
                if not re.fullmatch(r'[A-Z][a-z]+ [a-z-]+', name):
                    continue
                rec = out.setdefault(name, {'states': [], 'territory_names': []})
                if state not in rec['states']:
                    rec['states'].append(state)
                for key, field in (('order', 'Order'), ('family', 'Family'),
                                   ('csv_common', 'FishBase name'),
                                   ('occurrence', 'Occurrence')):
                    val = (row.get(field) or '').strip()
                    if val and not rec.get(key):
                        rec[key] = val
                terr = (row.get('Name(s) in Territory') or '').strip()
                if terr and terr not in rec['territory_names']:
                    rec['territory_names'].append(terr)
    return out, files


def from_traits(registry_dir):
    """species_traits.json's `scientific` field -> {binomial: [app common names]}.

    A cell holding two species (`Micropterus punctulatus, Micropterus henshalli`) is split;
    anything still not shaped `Genus species` after that -- the two Morone hybrids -- is
    dropped here rather than fetched, because a hybrid has no FishBase page by design.
    """
    path = os.path.join(registry_dir, 'species_traits.json')
    out, skipped = {}, []
    if not os.path.exists(path):
        return out, skipped
    with open(path, encoding='utf-8') as fh:
        table = (json.load(fh) or {}).get('species') or {}
    for common, entries in table.items():
        for entry in entries if isinstance(entries, list) else [entries]:
            raw = (entry or {}).get('scientific') or ''
            for part in [p.strip() for p in raw.split(',') if p.strip()]:
                if re.fullmatch(r'[A-Z][a-z]+ [a-z-]+', part):
                    out.setdefault(part, [])
                    if common not in out[part]:
                        out[part].append(common)
                elif part and part not in skipped:
                    skipped.append(part)
    return out, skipped


# ── A STALE BINOMIAL IS RESOLVED, NEVER ALIASED ──────────────────────────────────────────────
# Six of the thirteen names species_traits.json contributes will not answer at FishBase, and
# none of them is a bug in build_species_traits.py to go and fix. Five are how the AGENCY spells
# the fish in its own guide, faithfully read:
#
#     Ictalurus punctatu     -> Ictalurus punctatus     the guide's own truncation
#     Micropterus dolomieui  -> Micropterus dolomieu    the older ending, still in wide use
#     Sander vitreum         -> Sander vitreus          ditto
#     Oncorhyncus mykiss     -> Oncorhynchus mykiss     a missing 'h'
#     Pylodictus olivaris    -> Pylodictis olivaris     a 'u' for an 'i'
#     Stizostedion vitreum   -> Sander vitreus          the pre-2004 GENUS. Not reachable.
#
# Overwriting them upstream would mean the parser correcting the document, which this pipeline
# deliberately never does. So the repair happens here, at the join, and only for a name that is
# NOT already an accepted binomial: the 795 names in the state exports came out of FishBase and
# are accepted by construction, so a real species never takes this path. A candidate must share
# the genus initial, beat 0.92 similarity, and be the ONLY name that does -- which resolves the
# five and correctly refuses the sixth, because `Stizostedion vitreum` and `Sander vitreus` have
# no string in common to work from. Walleye reaches the table anyway, through the TN row.
#
# It costs Channel Catfish, Smallmouth Bass, Rainbow Trout, Flathead Catfish and Walleye if it
# is not done -- five of the species most often planned for.

def nearest(name, accepted):
    """The one accepted binomial a stale one obviously means, or None. Never a guess."""
    if name in accepted:
        return None
    pool = [c for c in accepted if c[:1] == name[:1]]
    scored = [(difflib.SequenceMatcher(None, name, c).ratio(), c) for c in pool]
    best = sorted((s for s in scored if s[0] >= 0.92), reverse=True)
    if len(best) == 1 or (len(best) > 1 and best[0][0] > best[1][0]):
        return best[0][1]
    return None


def slug(binomial):
    return binomial.replace(' ', '-')


# ── FETCHING ─────────────────────────────────────────────────────────────────────────────────

def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html,*/*'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.status


def load_out(path):
    if not os.path.exists(path):
        return {}, {}
    with open(path, encoding='utf-8') as fh:
        doc = json.load(fh) or {}
    return doc.get('species') or {}, doc.get('unresolved') or {}


def save_out(path, species, unresolved, sources):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump({
            'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'source': BASE % '<Genus>-<species>',
            'built_from': sources,
            'note': 'Trophic level, size ceiling and milieu per species, one FishBase summary '
                    'page each. Personal use only, not for distribution or resale; not for '
                    'navigation.',
            'species_count': len(species),
            'species': dict(sorted(species.items())),
            'unresolved': dict(sorted(unresolved.items())),
        }, fh, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


# A 404 IS AN ANSWER AND A TIMEOUT IS NOT. `Stizostedion vitreum` will 404 on every run this
# pipeline ever makes, and re-asking FishBase about it once a month is asking a settled question.
# A read timeout or a 503 is the opposite: nothing was learned and the next run should try again.
# Without this line the resume skips only the successes, so every re-run pays for every permanent
# failure a second time -- which is exactly what the tests caught.
# `^` BINDS TO ITS OWN BRANCH, NOT TO THE ALTERNATION, and `.match()` then anchored the whole
# thing at position 0 -- so the second branch could never fire, because the reason it has to
# recognise reads `page fetched, no trophic level and no max length`. Found on the real 803-page
# run: Esox americanus came back labelled "(transient -- the next run asks again)" when it is
# nothing of the kind. `.search()` lets branch two match anywhere while `^HTTP 4` keeps its own
# anchor, which is what was meant.
#
# THE ESOX PAGE IS WHY THIS CASE EXISTS AT ALL. fishbase.se/summary/Esox-americanus.html is a
# real page titled `Esox americanus, Redfin pickerel : gamefish, aquarium` and it carries NO
# trophic level, NO max length and NO environment line -- the data lives on the two subspecies
# pages, americanus and vermiculatus. The page answered; the answer is that it holds nothing.
# That is settled, not transient, and re-asking it every run is asking a question FishBase has
# already answered.
PERMANENT = re.compile(r'^HTTP 4|no trophic level and no max length')


def settled(entry):
    return bool(PERMANENT.search((entry or {}).get('reason') or ''))


def canary_ok(rec):
    """Every field the canary claims, or the reason it failed."""
    want = CANARY[1]
    bad = []
    for key, expect in want.items():
        got = rec.get(key)
        if isinstance(expect, list):
            if not got or not set(expect) <= set(got):
                bad.append('%s: wanted %s, parsed %r' % (key, expect, got))
        elif got != expect:
            bad.append('%s: wanted %s, parsed %r' % (key, expect, got))
    return bad


def keep(stored, unresolved, work, traits_only, name, rec):
    """What the page said, plus what the exports already knew about it. One place, because the
    canary and the loop both store a record and two copies of this would drift."""
    meta = work.get(name) or {}
    rec['states'] = meta.get('states') or []
    for key in ('order', 'family', 'occurrence', 'territory_names', 'app_names',
                'resolved_from'):
        if meta.get(key) and not rec.get(key):
            rec[key] = meta[key]
    if meta.get('csv_common') and not rec.get('common'):
        rec['common'] = meta['csv_common']
    rec['url'] = BASE % slug(name)
    rec['fetched'] = datetime.now(timezone.utc).date().isoformat()
    stored[name] = {k: v for k, v in rec.items() if v not in (None, '', [])}
    unresolved.pop(name, None)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--registry', default='registry', help='where the CSVs and the output live')
    ap.add_argument('--go', action='store_true', help='actually fetch and write')
    ap.add_argument('--limit', type=int, default=0,
                    help='stop after N fetches, not counting the canary (smoke test)')
    ap.add_argument('--refresh', action='store_true', help='re-fetch species already stored')
    ap.add_argument('--delay', type=float, default=0.8,
                    help='seconds between requests; this is a courtesy crawl of one small '
                         'academic host, so serial and slow is deliberate')
    ap.add_argument('--timeout', type=float, default=30)
    args = ap.parse_args()

    reg = os.path.abspath(args.registry)
    out_path = os.path.join(reg, OUT)
    raw_dir = os.path.join(reg, RAW_DIR)

    csv_rows, csv_files = from_csvs(reg)
    traits, hybrids = from_traits(reg)
    if not csv_rows:
        sys.exit('no *_Fishbase_SE_Full.csv in %s, %s or %s -- nothing to build from'
                 % (reg, os.path.dirname(reg), os.getcwd()))

    work = dict(csv_rows)
    traits_only, resolved = [], {}
    for name, commons in traits.items():
        target = name
        if name not in csv_rows:
            fixed = nearest(name, csv_rows)
            if fixed:
                resolved[name] = fixed
                target = fixed
        rec = work.setdefault(target, {'states': [], 'territory_names': []})
        rec['app_names'] = sorted(set((rec.get('app_names') or []) + commons))
        if target in resolved.values():
            rec['resolved_from'] = sorted(set((rec.get('resolved_from') or []) + [name]))
        if target not in csv_rows and target not in traits_only:
            traits_only.append(target)

    stored, unresolved = load_out(out_path)
    if args.refresh:
        todo, settled_n = sorted(work), 0
    else:
        todo = sorted(n for n in work
                      if n not in stored and not settled(unresolved.get(n)))
        settled_n = sum(1 for n in work
                        if n not in stored and settled(unresolved.get(n)))

    print('work list')
    print('  %-6d binomials from %d state exports' % (len(csv_rows), len(csv_files)))
    print('  %-6d more from species_traits.json, absent from the state exports and fetched on '
          'their own:' % len(traits_only))
    for name in sorted(traits_only):
        print('           %-24s %s' % (name, ', '.join(traits.get(name) or [])))
    if resolved:
        print('  %-6d stale binomial(s) resolved to the accepted name:' % len(resolved))
        for stale, fixed in sorted(resolved.items()):
            print('           %-24s -> %-24s %s'
                  % (stale, fixed, ', '.join(traits.get(stale) or [])))
    #  NOT a failure list. `Sciaenops ocellatus` is a perfectly good binomial that is simply
    #  absent from four FRESHWATER state exports, and it is fetched on its own like any other.
    #  Only the fetch can tell a valid absent name from an unrepairable stale one, so nothing is
    #  called unresolved until FishBase has been asked.
    if hybrids:
        print('  %-6d not a binomial, never fetched: %s' % (len(hybrids), ', '.join(hybrids)))
    print('  %-6d already stored%s' % (len(stored), ' (--refresh re-fetches them)'
                                       if stored and not args.refresh else ''))
    if settled_n:
        print('  %-6d asked before and permanently unanswered -- not asked again' % settled_n)
    print('  %-6d to fetch%s' % (len(todo), (' (--limit %d)' % args.limit) if args.limit else ''))

    if not args.go:
        mins = (len(todo) * (args.delay + 0.5)) / 60.0
        print('\ndry run. --go fetches %d pages, about %.0f min at --delay %.1f.'
              % (len(todo), mins, args.delay))
        print('run `--go --limit 5` first: it proves the fetch, the parse and the write in '
              'ten seconds.')
        return 0

    # THE CANARY. One request, before the other eight hundred.
    if todo:
        name, _ = CANARY
        print('\ncanary: %s' % name)
        try:
            body, _status = fetch(BASE % slug(name), args.timeout)
        except Exception as exc:                                  # noqa: BLE001
            sys.exit('  canary could not be fetched: %s\n  nothing was written.' % exc)
        os.makedirs(raw_dir, exist_ok=True)
        raw_path = os.path.join(raw_dir, slug(name) + '.html')
        with open(raw_path, 'wb') as fh:
            fh.write(body)
        rec = parse(decode(body))
        bad = canary_ok(rec)
        if bad:
            print('  the page parsed to %d fields and the ones it is checked on are wrong:'
                  % len(rec))
            for line in bad:
                print('    %s' % line)
            sys.exit('  FishBase changed shape. The page is saved at %s -- nothing else was '
                     'fetched and nothing was written.' % raw_path)
        print('  ok: trophic %s %s, max length %s cm, %s'
              % (rec.get('trophic_level'), rec.get('trophic_basis'),
                 rec.get('max_length_cm'), '/'.join(rec.get('milieu') or [])))
        # THE CANARY IS A REAL PAGE, FULLY PARSED. Throwing the record away and letting the
        # loop fetch Micropterus salmoides a second time is one wasted request on every run,
        # for nothing.
        if name in work:
            keep(stored, unresolved, work, traits_only, name, rec)
            todo = [n for n in todo if n != name]

    ok = failed = 0
    reasons = {}
    started = time.time()
    for i, name in enumerate(todo):
        if args.limit and i >= args.limit:
            break
        if i:
            time.sleep(args.delay)
        try:
            body, _status = fetch(BASE % slug(name), args.timeout)
            rec = parse(decode(body))
        except urllib.error.HTTPError as exc:
            reason = 'HTTP %d' % exc.code
            rec = None
        except Exception as exc:                                  # noqa: BLE001
            reason = str(exc)[:120]
            rec = None
        if rec is None or not rec.get('trophic_level') and not rec.get('max_length_cm'):
            if rec is not None:
                reason = 'page fetched, no trophic level and no max length'
            failed += 1
            reasons[reason] = reasons.get(reason, 0) + 1
            unresolved[name] = {'reason': reason,
                                'from': 'species_traits.json' if name in traits_only
                                        else 'state export',
                                'url': BASE % slug(name)}
            continue
        keep(stored, unresolved, work, traits_only, name, rec)
        ok += 1
        if ok % 25 == 0:
            save_out(out_path, stored, unresolved, [os.path.basename(f) for f in csv_files]
                     + ['species_traits.json'])
            print('  %4d/%d  %.0fs elapsed' % (ok, len(todo), time.time() - started))

    save_out(out_path, stored, unresolved,
             [os.path.basename(f) for f in csv_files] + ['species_traits.json'])

    have = lambda k: sum(1 for r in stored.values() if r.get(k) is not None)  # noqa: E731
    print('\n%d fetched, %d failed, %.0f s -> %s' % (ok, failed, time.time() - started, out_path))
    print('%d species stored. field coverage:' % len(stored))
    for key in ('trophic_level', 'max_length_cm', 'common_length_cm', 'milieu',
                'water_column', 'migration', 'climate', 'feeds_on', 'family'):
        n = have(key)
        print('  %-18s %4d  %3.0f%%' % (key, n, 100.0 * n / max(1, len(stored))))
    diet = sum(1 for r in stored.values() if (r.get('trophic_basis') or '').startswith('diet'))
    print('  %-18s %4d  %3.0f%%  (the rest are estimated from food items or relatives)'
          % ('from diet studies', diet, 100.0 * diet / max(1, len(stored))))
    if reasons:
        print('\nwhy the failures failed:')
        for reason, n in sorted(reasons.items(), key=lambda kv: -kv[1])[:5]:
            print('  %4d  %s' % (n, reason))
    if unresolved:
        print('\n%d unresolved, by name. A 404 here means FishBase files the fish under another '
              'binomial than the one we hold -- check the name against fishbase.se before '
              'assuming the species is missing:' % len(unresolved))
        for name in sorted(unresolved)[:20]:
            entry = unresolved[name]
            print('  %-30s %-38s %s'
                  % (name, entry['reason'],
                     '' if settled(entry) else '(transient -- the next run asks again)'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
