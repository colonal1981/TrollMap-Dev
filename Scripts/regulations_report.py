#!/usr/bin/env python3
"""registry/regulations_table.json -> one HTML page a person can spot-check.

Personal use only, not for distribution or resale; not for navigation.

WHY THIS EXISTS. Every check in build_regulations_table.py answers a question the machine can
ask itself: is this page accounted for, did the grid cut a word, does this phrase map to a
checkbox. None of them can ask the only question that finally matters -- IS THIS WHAT THE BOOK
SAYS ABOUT THIS LAKE -- because that needs somebody who knows the water.

Cape Fear River is the argument for it. Its striped bass rule is `No striped bass may be
possessed.` and it arrived as a size limit reading `No striped bass ma`, having passed the page
ledger, the cut-word check and the species map. It was found by reading the record, not by
counting them, and every count was right the whole time.

So this prints what the app will actually say, water by water, in the order a person would look
things up. It is deliberately NOT a summary: summaries are where a wrong record hides.

    py .\\scripts\\regulations_report.py
    py .\\scripts\\regulations_report.py --out F:\\somewhere\\else.html

Re-run it after every build. It reads the built table and nothing else, so it can never be more
current than registry/regulations_table.json -- the page prints that file's own read date.
"""
import argparse, html, json, os, sys
from collections import defaultdict



def _md(v):
    """`06-15` -> 615, for day arithmetic that does not need a year."""
    try:
        m, d = str(v).split('-')
        return int(m) * 100 + int(d)
    except Exception:
        return None


def _next_day(md):
    """The day after, in the same MM-DD space. Month ends are all that matter here."""
    LAST = {1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30,
            7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31}
    m, d = md // 100, md % 100
    return (m + 1 if m < 12 else 1) * 100 + 1 if d >= LAST[m] else m * 100 + d + 1


def _fold_complementary(rules):
    """Which closure records say the same thing as another one, inverted.

    Returns a set of ids to SKIP, plus ('with', id) -> the skipped record's sentence, so the
    surviving line can carry it. Only an `open_only` and a `closed` on the same species that tile
    the year exactly are folded -- anything that leaves a gap, or overlaps, is two different facts
    and both are printed.
    """
    skip = {}
    by_species = {}
    for r in rules:
        for c in r.get('closures') or []:
            by_species.setdefault(str(c.get('species') or ''), []).append(c)
    for cs in by_species.values():
        opens = [c for c in cs if c.get('effect') == 'open_only']
        shuts = [c for c in cs if c.get('effect') == 'closed']
        for o in opens:
            os_, oe = _md(o.get('start')), _md(o.get('end'))
            if os_ is None or oe is None:
                continue
            for c in shuts:
                cs_, ce = _md(c.get('start')), _md(c.get('end'))
                if cs_ is None or ce is None:
                    continue
                if _next_day(oe) == cs_ and _next_day(ce) == os_:
                    skip[id(c)] = True
                    skip[('with', id(o))] = c.get('text') or ''
                    break
    return skip


def load(path):
    if not os.path.exists(path):
        sys.exit('not found: %s -- run build_regulations_table.py first' % path)
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def clean(v):
    """A cell as a person should read it, or None if the book left it empty."""
    if v is None:
        return None
    s = ' '.join(str(v).split())
    if not s or s in ('-', '—'):
        return None
    return s


def collect(doc, idx):
    """The page's whole payload: waters with their own rules, each state's default, and the
    addresses the books used that bound to nothing."""
    waters = []
    for slug, w in doc.get('by_water', {}).items():
        row = idx.get(slug) or {}
        rules = []
        facts = None
        # THE SAME LAKE TWICE. SC's state lakes spread arrives both as a ruled row and as the
        # structured payload read_sc_state_lakes() builds from it, and the ruled one has no
        # species and no numbers -- so it printed as `no fish named on this row` beside the
        # record that says everything. One water, one card.
        has_payload = any(r.get('state_lake') for r in (w.get('rules') or []))
        for r in (w.get('rules') or []):
            if has_payload and r.get('table') == 'state_lakes' and not r.get('state_lake'):
                continue
            # SC'S STATE LAKES TABLE IS THE RICHEST RECORD IN THE BOOK AND THIS PRINTED NONE OF
            # IT. Lake Ashwood carries catfish 5, bass 3, bream 15, the days it is open, the
            # hours, and the motor it allows -- and the first version of this page showed two
            # rows of `no fish named` and a pair of dashes, because it only ever looked at
            # species/size/creel. Ryan opened it on the second water he checked.
            sl = r.get('state_lake')
            if sl:
                facts = {
                    'acres': clean(sl.get('acres')), 'open_days': clean(sl.get('open_days')),
                    'hours': clean(sl.get('open_to_fishing')),
                    'motor': clean(sl.get('max_boat_motor_hp')),
                    'closed': bool(sl.get('closed')),
                }
                # THESE NUMBERS ARE CREEL LIMITS AND THIS TABLE SETS NO SIZES. Ryan: "the
                # state waters have the creel limit in the size column and do not have the size
                # limit listed at all". They were being printed across both columns, which put
                # `5` under the heading Size limit -- a catfish limit of five per day reading as
                # a five-inch fish. The book's columns here are county, water, acres, the days
                # and hours it is open, the motor allowed, and a creel number per fish.
                # THE BOOK HEADS THESE `CREEL/ SIZE LIMITS` AND MEANS BOTH. Lake Edgar Brown's
                # bass is `3 (16" or longer)` -- three a day, sixteen inches. Calling that a
                # creel number and printing `none in this table` under Size was wrong twice on
                # one row, which is what Ryan found by doing the thing this script cannot:
                # holding the card up against page 37.
                # AND THE BOOK'S ORDER IS CREEL FIRST. Printing the joined value across both
                # columns put `3` and `3 (16" or longer)` under the heading Size limit with the
                # Creel column empty -- the first thing Ryan checked, twice: "this looks like it
                # is still showing up in the size limit instead of creel ... and it is because
                # the state page does it creel (size)". The build splits it now on the book's own
                # punctuation, so each number goes under its own heading and the joined value is
                # quoted in the source cell where it belongs.
                lim = sl.get('limits') or {}
                spl = sl.get('limits_split') or {}
                for fish in ('bass', 'bream', 'catfish'):
                    p = spl.get(fish) or {}
                    creel, size = clean(p.get('creel')), clean(p.get('size'))
                    if not creel and not size:
                        continue
                    # NO SIZE HERE IS NOT NO SIZE LIMIT. This table sets one on some lakes and
                    # says nothing on the rest, and the statewide table still applies to the
                    # rest -- so the cell says which of those two it is.
                    src = ('SC state lakes table — the book prints this as one value, "%s"'
                           % p.get('as_printed') if size else
                           'SC state lakes table — it sets no size here, so the statewide '
                           'size limit is the one that applies')
                    rules.append({
                        'species': fish.title(), 'size': size, 'creel': creel, 'whole': None,
                        'text': None, 'source': src,
                        'page': None, 'closures': [], 'plan': [], 'via': 'state lakes table',
                    })
                # The other two are not creel numbers and must not sit in that column.
                cr = clean(lim.get('statewide_crappie_applies'))
                if cr:
                    rules.append({
                        'species': 'Crappie', 'size': None, 'creel': None,
                        'whole': 'statewide crappie limit applies here — %s' % cr,
                        'text': None, 'source': 'SC state lakes table', 'page': None,
                        'closures': [], 'plan': [], 'via': 'state lakes table',
                    })
                facts['minnows'] = clean(lim.get('minnows_as_bait'))
                # WHETHER, NOT WHERE. Ryan: "it doesn't tell you where the ramp is but tells you
                # if it has one". The DNR ramps feed answers the other half, and on seven of
                # these eighteen the two disagree -- the book marks a ramp and the feed has no
                # record of it. Both are printed and neither is silently preferred.
                facts['has'] = [k.replace('_', ' ') for k, v in
                                (sl.get('facilities') or {}).items() if v]
                continue
            # TN's agency-page records nest their own rules; flatten so the page has one shape.
            inner = r.get('rules')
            if isinstance(inner, list) and inner and isinstance(inner[0], dict) \
                    and 'species' in inner[0]:
                for ir in inner:
                    # TWRA WRITES ONE SENTENCE, NOT TWO COLUMNS. `Largemouth Bass: 14-inch
                    # minimum length limit.` is a SIZE limit and `Five (5) per day in
                    # combination.` is a creel limit, and the agency page gives them in the same
                    # field with nothing to tell them apart. Filing every one under `creel`
                    # printed a size limit beneath a heading that said creel; splitting them by
                    # looking for the word `inch` would be this page guessing at law. So the
                    # sentence is shown whole, across both columns, which is how TWRA prints it.
                    rules.append({
                        'species': clean(ir.get('species')), 'size': None, 'creel': None,
                        'whole': clean(ir.get('rule')) or clean(ir.get('text')),
                        'text': clean(ir.get('text')), 'source': clean(r.get('source')),
                        'page': None, 'closures': [{
                            'effect': c.get('effect'), 'applies_to': c.get('applies_to'),
                            'start': c.get('start'), 'end': c.get('end'),
                            'species': clean(c.get('species')), 'text': clean(c.get('text')),
                            'note': clean(c.get('note')),
                        } for c in (ir.get('closures') or [])],
                        'plan': ir.get('plan_species') or [], 'via': 'agency page',
                    })
                continue
            body = clean(' | '.join(str(c) for c in (r.get('cells') or []) if c))
            sp0 = clean(r.get('species')) or clean(r.get('species_band'))
            sz0, cr0 = clean(r.get('size_limit')), clean(r.get('creel_limit'))
            rules.append({
                'species': sp0, 'size': sz0, 'creel': cr0,
                # WHAT THE ROW SAYS, when it says it in a sentence instead of two columns. The
                # demarcation clauses and SC's seasons bullets have no species and no numbers;
                # printed as dashes they read as a record with nothing in it.
                'whole': None if (sz0 or cr0) else body,
                'text': body,
                'source': clean(r.get('source')), 'page': r.get('page'),
                'via': clean(r.get('matched_via')) or clean(r.get('table')),
                'reach': bool(r.get('address_is_a_reach')),
                # ONE RIVER, TWO STATES, ONE SLUG. SC's book governs the Lumber River's
                # South Carolina reach; our slug is filed in Robeson County, NC. The rule
                # is real and it is not the law where somebody launches on this water, so
                # the card says whose it is instead of leaving Ryan to ask "sc?".
                'other_state': r.get('other_state_reach'),
                'scope': r.get('applies_to_feature_types') or None,
                'damaged': r.get('text_cut_by_the_grid') or None,
                'address': clean(r.get('address')),
                'plan': r.get('plan_species') or [],
                'closures': [{
                    'effect': c.get('effect'), 'applies_to': c.get('applies_to'),
                    'start': c.get('start'), 'end': c.get('end'),
                    'species': clean(c.get('species')), 'text': clean(c.get('text')),
                    'note': clean(c.get('note')),
                } for c in (r.get('closures') or [])],
            })
        waters.append({
            'slug': slug, 'name': w.get('display_name') or slug,
            'state': w.get('state') or row.get('state') or '?',
            'kind': row.get('feature_type') or '?', 'rules': rules, 'facts': facts,
        })
    # EVERY WATER WE OFFER, NOT ONLY THE ONES THE BOOKS NAME. Ryan: "how does smart plan put
    # out the size limit on a lake that does not have an exception... this seems to only list
    # exceptions to the rule". It did, and that is half the answer: a lake with no rule of its
    # own is not a lake with no law, it is a lake the state default governs. Listing only the
    # exceptions makes the other 257 look unanswered when they are the ordinary case.
    have = {w['slug'] for w in waters}
    for slug, row in idx.items():
        if slug in have or not row.get('state'):
            continue
        waters.append({'slug': slug, 'name': row.get('display_name') or slug,
                       'state': row['state'], 'kind': row.get('feature_type') or '?',
                       'rules': [], 'facts': None})
    waters.sort(key=lambda x: (x['state'], x['name'].lower()))

    statewide = {}
    for st, rows in (doc.get('statewide') or {}).items():
        out = []
        for r in rows:
            out.append({
                'species': clean(r.get('species')), 'size': clean(r.get('size_limit')),
                'creel': clean(r.get('creel_limit')),
                'text': clean(' | '.join(str(c) for c in (r.get('cells') or []) if c)),
                'coastal': r.get('scope') == 'statewide coastal',
                'scope': r.get('applies_to_feature_types') or None,
                'damaged': r.get('text_cut_by_the_grid') or None,
                'plan': r.get('plan_species') or [], 'page': r.get('page'),
            })
        statewide[st] = out

    # WHAT THE BOOKS SAID THAT REACHED NOBODY. A person reading this list is the only thing that
    # can tell "we do not offer that water" from "the name missed", and those are different jobs.
    unbound = defaultdict(list)
    for st, blk in (doc.get('states') or {}).items():
        seen = set()
        for tables in (blk.get('tables') or {}).values():
            for tb in tables:
                for r in (tb.get('rows') or []):
                    for u in ((r.get('resolved') or {}).get('unresolved') or []):
                        t = clean(u.get('text'))
                        if t and t not in seen:
                            seen.add(t)
                            unbound[st].append({'text': t, 'why': clean(u.get('why')),
                                                'species': clean(r.get('species_band'))})
    for st in unbound:
        unbound[st].sort(key=lambda x: x['text'].lower())

    offered = defaultdict(int)
    for row in idx.values():
        if row.get('state'):
            offered[row['state']] += 1
    return waters, statewide, dict(unbound), dict(offered)


# ─────────────────────────────────────────────────────────────────────────────────────────────
# THE PAGE
# ─────────────────────────────────────────────────────────────────────────────────────────────
#
# Built as one self-contained file with the data inlined, because the thing it is for is being
# opened on a phone at a boat ramp with no network. Filtering is client-side for the same reason.

CSS = """
:root{
  --ink:#111820; --ground:#f2f5f6; --surface:#ffffff; --line:#dfe6e9;
  --muted:#5c6c77; --accent:#0d6e8c; --accent-soft:#e4f1f5;
  --shut:#b3372c; --shut-soft:#fbe9e7; --warn:#8a6100; --warn-soft:#fbf1dc;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --ink:#e6edf1; --ground:#0e1418; --surface:#18212a; --line:#2a3540;
    --muted:#93a4b0; --accent:#4bb8d8; --accent-soft:#12313d;
    --shut:#f08a7e; --shut-soft:#3a1c18; --warn:#e0b45e; --warn-soft:#332a14;
  }
}
:root[data-theme="dark"]{
  --ink:#e6edf1; --ground:#0e1418; --surface:#18212a; --line:#2a3540;
  --muted:#93a4b0; --accent:#4bb8d8; --accent-soft:#12313d;
  --shut:#f08a7e; --shut-soft:#3a1c18; --warn:#e0b45e; --warn-soft:#332a14;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);
  font:15px/1.55 "Source Sans 3","Segoe UI",system-ui,sans-serif;}
h1,h2,h3,.lbl{font-family:"Barlow Semi Condensed","Segoe UI",system-ui,sans-serif;
  text-wrap:balance;margin:0}
.mono{font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px}
header{border-bottom:1px solid var(--line);background:var(--surface)}
header .wrap{padding-top:26px;padding-bottom:22px}
h1{font-size:30px;font-weight:600;letter-spacing:-.01em}
.sub{color:var(--muted);margin-top:6px;max-width:62ch}
.note{margin-top:14px;font-size:13px;color:var(--muted);border-left:3px solid var(--accent);
  padding-left:12px}
.tally{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.tile{background:var(--ground);border:1px solid var(--line);border-radius:3px;
  padding:9px 13px;min-width:112px}
.tile .n{font-size:21px;font-weight:600}
.lbl{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.bar{position:sticky;top:0;z-index:5;background:var(--surface);border-bottom:1px solid var(--line);
  padding:11px 0}
.bar .wrap{display:flex;flex-wrap:wrap;gap:9px;align-items:center}
input[type=search]{flex:1 1 260px;min-width:200px;padding:8px 11px;border:1px solid var(--line);
  border-radius:3px;background:var(--ground);color:var(--ink);font:inherit}
input[type=search]:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button{font:inherit;font-family:"Barlow Semi Condensed",system-ui,sans-serif;font-size:14px;
  padding:7px 12px;border:1px solid var(--line);border-radius:3px;background:var(--ground);
  color:var(--muted);cursor:pointer}
button[aria-pressed=true]{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);
  font-weight:600}
main .wrap{padding-top:26px;padding-bottom:60px}
section{margin-bottom:38px}
h2{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);
  padding-bottom:7px;border-bottom:1px solid var(--line);margin-bottom:16px}
.water{background:var(--surface);border:1px solid var(--line);border-radius:3px;
  padding:14px 16px;margin-bottom:11px}
.water.shut{border-left:3px solid var(--shut)}
.wname{display:flex;flex-wrap:wrap;gap:9px;align-items:baseline}
.wname h3{font-size:19px;font-weight:600}
.chip{font-family:"Barlow Semi Condensed",system-ui,sans-serif;font-size:11px;letter-spacing:.07em;
  text-transform:uppercase;padding:2px 7px;border-radius:2px;background:var(--ground);
  color:var(--muted);border:1px solid var(--line)}
.chip.shut{background:var(--shut-soft);color:var(--shut);border-color:var(--shut)}
.chip.warn{background:var(--warn-soft);color:var(--warn);border-color:var(--warn)}
.chip.on{background:var(--accent-soft);color:var(--accent);border-color:var(--accent)}
.tbl{width:100%;border-collapse:collapse;margin-top:11px;font-size:14px}
.tbl th{text-align:left;font-family:"Barlow Semi Condensed",system-ui,sans-serif;font-size:11px;
  letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600;
  padding:0 10px 5px 0;border-bottom:1px solid var(--line)}
.tbl td{padding:8px 10px 8px 0;border-bottom:1px solid var(--line);vertical-align:top}
.tbl tr:last-child td{border-bottom:none}
.sp{font-weight:600;width:24%}
.lim{width:30%}
.src{width:16%;color:var(--muted);font-size:12.5px}
.shutline,.warnline,.noteline{margin-top:9px;padding:8px 11px;border-radius:3px;font-size:13.5px}
.shutline{background:var(--shut-soft);color:var(--shut)}
.warnline{background:var(--warn-soft);color:var(--warn)}
.noteline{background:var(--ground);color:var(--muted);border:1px solid var(--line)}
.shutx{color:var(--shut);font-weight:600}
.facts{margin:9px 0 0;font-size:13px;color:var(--muted)}
.facts a{color:var(--accent)}
.shutline b,.warnline b,.noteline b{font-family:"JetBrains Mono",monospace;font-size:12.5px;
  text-transform:uppercase;letter-spacing:.04em}
details{margin-top:9px}
summary{cursor:pointer;font-size:12.5px;color:var(--muted);
  font-family:"Barlow Semi Condensed",system-ui,sans-serif;letter-spacing:.04em}
details p{margin:7px 0 0;font-size:13px;color:var(--muted);
  background:var(--ground);padding:9px 11px;border-radius:3px;overflow-x:auto}
.unb{background:var(--surface);border:1px solid var(--line);border-radius:3px;padding:13px 16px}
.unb ul{margin:9px 0 0;padding-left:19px;columns:2;column-gap:28px;font-size:13.5px}
.unb li{margin-bottom:5px;break-inside:avoid}
.empty{color:var(--muted);font-style:italic;padding:22px 0}
@media (max-width:720px){ .sp,.lim,.src{width:auto} .unb ul{columns:1} .tbl{font-size:13.5px} }
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
"""


JS = """
const q=document.getElementById('q'), only=document.getElementById('only');
const ownBtn=document.getElementById('ownonly'); let ownOnly=false;
const stateBtns=[...document.querySelectorAll('[data-state]')];
let st='ALL', shutOnly=false;
function apply(){
  const t=q.value.trim().toLowerCase();
  let shown=0;
  document.querySelectorAll('.water').forEach(el=>{
    const okS = st==='ALL' || el.dataset.state===st;
    const okT = !t || el.dataset.find.includes(t);
    const okC = !shutOnly || el.dataset.shut==='1';
    const okO = !ownOnly || el.dataset.own==='1';
    const on = okS && okT && okC && okO;
    el.hidden = !on; if(on) shown++;
  });
  document.querySelectorAll('section[data-state]').forEach(el=>{
    el.hidden = st!=='ALL' && el.dataset.state!==st;
  });
  document.getElementById('count').textContent = shown;
  document.getElementById('none').hidden = shown>0;
}
q.addEventListener('input',apply);
only.addEventListener('click',()=>{shutOnly=!shutOnly;only.setAttribute('aria-pressed',shutOnly);apply();});
ownBtn.addEventListener('click',()=>{ownOnly=!ownOnly;ownBtn.setAttribute('aria-pressed',ownOnly);apply();});
stateBtns.forEach(b=>b.addEventListener('click',()=>{
  st=b.dataset.state; stateBtns.forEach(x=>x.setAttribute('aria-pressed',x===b)); apply();
}));
apply();
"""

E = html.escape


def dates(c):
    a, b = c.get('start'), c.get('end')
    if a and b:
        return '%s to %s' % (a, b)
    return 'no dates given' if not a and not b else (a or b)


def render_water(w):
    # FOUR THINGS WEAR THE WORD `closure` AND ONLY ONE OF THEM SHUTS THE WATER. The builder
    # types them -- `closed`, `no_harvest`, `limit_window` (a seasonal creel or size, June 1
    # to Oct 15 one per day), `open_only` (a season open in that window and shut outside it),
    # and `unknown` where it could not tell. Painting all of them the same red said Norris Lake
    # was closed when what the book gives it is a smallmouth window.
    shut = any(c.get('effect') in ('closed', 'no_harvest', 'open_only') for r in w['rules']
               for c in r['closures'])
    unknown = any(c.get('effect') == 'unknown' for r in w['rules'] for c in r['closures'])
    find = (w['name'] + ' ' + w['slug'] + ' ' + ' '.join(
        (r['species'] or '') for r in w['rules'])).lower()
    own = '1' if w['rules'] else '0'
    out = ['<article class="water%s" data-state="%s" data-shut="%s" data-own="%s" data-find="%s">'
           % (' shut' if shut else '', E(w['state']), '1' if (shut or unknown) else '0',
              own, E(find))]
    out.append('<div class="wname"><h3>%s</h3><span class="chip">%s</span>'
               % (E(w['name']), E(w['kind'])))
    if shut:
        out.append('<span class="chip shut">closure</span>')
    if unknown:
        out.append('<span class="chip warn">date-bound rule the app cannot express</span>')
    if any(r.get('damaged') for r in w['rules']):
        out.append('<span class="chip warn">text not read cleanly</span>')
    out.append('</div>')

    f = w.get('facts')
    if f:
        bits = []
        if f.get('acres'):
            bits.append('%s acres' % f['acres'])
        for k in ('open_days', 'hours', 'motor'):
            if f.get(k):
                bits.append(f[k])
        if f.get('minnows'):
            bits.append('minnows as bait: %s' % f['minnows'])
        if f.get('has'):
            bits.append('the book marks: ' + ', '.join(f['has']))
        if f.get('closed'):
            bits.insert(0, 'CLOSED')
        # ESCAPE THE PARTS, NOT THE JOIN. Running the whole string through E() turned the
        # separator into `&amp;middot;` on every state lake card.
        out.append('<p class="facts">%s</p>' % ' &middot; '.join(E(b) for b in bits))

    if not w['rules']:
        out.append('<p class="facts">No rule of its own in the book. Smart plan answers from '
                   'the <a href="#sw-%s">%s statewide limits</a> below &mdash; that is the law '
                   'here, not a gap.</p></article>' % (E(w['state']), E(w['state'])))
        return ''.join(out)

    out.append('<p class="facts">Its own rules, which beat the state default. Anything not '
               'listed falls to the <a href="#sw-%s">%s statewide limits</a>.</p>' 
               % (E(w['state']), E(w['state'])))
    out.append('<table class="tbl"><thead><tr><th class="sp">Fish</th>'
               '<th class="lim">Size limit</th><th class="lim">Creel limit</th>'
               '<th class="src">From</th></tr></thead><tbody>')
    for r in w['rules']:
        # A RULE WITH NO FISH NAMED IS NOT THE SAME AS A CLOSURE. The first draft of this
        # labelled every one of them `shuts the water -- every fish`, which is true only when
        # the row actually carries an all_fishing closure. TWRA's agency pages produce rules
        # whose species did not parse, and calling those a closure on Norris Lake would be the
        # exact failure this page exists to catch, printed by the page itself.
        shuts_here = any(c.get('applies_to') == 'all_fishing' for c in r['closures'])
        if r['species']:
            sp = E(r['species'])
        elif shuts_here:
            sp = '<span class="shutx">shuts the water &mdash; every fish</span>'
        else:
            sp = '<span style="color:var(--muted)">no fish named on this row</span>'
        src = r['source'] or ''
        # The page number where the book has one; TWRA's agency pages are a filename, and
        # `pNorris Reservoir in Tennessee _ Bank and Boat....html` helps nobody.
        pg = r.get('page')
        if isinstance(pg, int) or (isinstance(pg, str) and pg.isdigit()):
            src += ' p%s' % pg
        flags = ''
        if r.get('other_state'):
            flags += ('  <span class="chip warn">%s\'s rule, for the %s reach of this river'
                      '</span>' % (E(r['other_state']), E(r['other_state'])))
        elif r.get('reach'):
            flags += ' <span class="chip warn">part of this water only</span>'
        if r.get('scope'):
            flags += ' <span class="chip on">%s only</span>' % E(', '.join(r['scope']))
        if r.get('whole'):
            # A SPANNING CELL STARTS UNDER `Size limit` AND READS AS ONE. Ryan found this twice
            # in one sitting -- a creel of 3 printed under Size, and then NC's whole county-pond
            # address printed there because that row parsed no limit at all. The cell is labelled
            # now, so a sentence cannot be mistaken for a number in the column it happens to
            # start in.
            out.append('<tr><td class="sp">%s%s</td><td class="lim mono" colspan="2">'
                       '<span class="chip">the book\'s own sentence</span> %s</td>'
                       '<td class="src">%s</td></tr>'
                       % (sp, flags, E(r['whole']), E(src.strip())))
        else:
            out.append('<tr><td class="sp">%s%s</td><td class="lim mono">%s</td>'
                       '<td class="lim mono">%s</td><td class="src">%s</td></tr>'
                       % (sp, flags, E(r['size'] or '—'), E(r['creel'] or '—'), E(src.strip())))
    out.append('</tbody></table>')

    # AN OPEN WINDOW AND ITS OWN COMPLEMENT ARE ONE RULE, NOT TWO. Ryan: "why is there an open
    # and close notice... if it isn't closed it must be open???" SC prints the Santee striper rule
    # as two lines in one cell -- harvest Oct 1 to Jun 15, closed Jun 16 to Sept 30 -- and they
    # tile the year exactly. Both records are real and closuresFor() needs both to gate a date;
    # printing both tells a person the same fact twice and makes them work out that it is the
    # same fact. The complement is folded into the open line, keeping its sentence, because that
    # is where the exceptions live: the Lower Saluda catch-and-release and its hook-gap rule are
    # only on the closed half.
    folded = _fold_complementary(w['rules'])
    for r in w['rules']:
        for c in r['closures']:
            if id(c) in folded:
                continue
            eff = c.get('effect') or 'unknown'
            tone = {'closed': 'shutline', 'no_harvest': 'shutline', 'open_only': 'shutline',
                    'unknown': 'warnline'}.get(eff, 'noteline')
            extra = folded.get(('with', id(c)))
            out.append('<div class="%s"><b>%s</b> &nbsp;%s%s<br>%s%s%s</div>'
                       % (tone, E('harvest window' if extra else eff.replace('_', ' ')),
                          E(dates(c)),
                          ' &middot; ' + E(c['species']) if c.get('species') else '',
                          E(c.get('text') or ''),
                          '<br><span class="chip">shut the rest of the year</span> %s'
                          % E(extra) if extra else '',
                          '<br><em>%s</em>' % E(c['note']) if c.get('note') else ''))

    body = [r for r in w['rules'] if r.get('address') or r.get('text')]
    if body:
        out.append('<details><summary>what the book prints, word for word</summary>')
        for r in body:
            if r.get('address'):
                out.append('<p><b>Addressed as:</b> %s</p>' % E(r['address']))
            if r.get('text'):
                out.append('<p>%s</p>' % E(r['text']))
        out.append('</details>')
    out.append('</article>')
    return ''.join(out)


def render(doc, waters, statewide, unbound, offered):
    states = sorted({w['state'] for w in waters} | set(statewide) | set(offered))
    tiles = ''.join(
        '<div class="tile"><div class="lbl">%s</div><div class="n mono">%d</div>'
        '<div class="lbl">of %d offered</div></div>'
        % (st, sum(1 for w in waters if w['state'] == st), offered.get(st, 0))
        for st in states)

    parts = ['<h2>Every water we offer &mdash; <span id="count" class="mono"></span> shown</h2>']
    parts += [render_water(w) for w in waters]
    parts.append('<p class="empty" id="none" hidden>Nothing matches that.</p>')

    sw = []
    for st in states:
        rows = [r for r in statewide.get(st, []) if not r['coastal']]
        if not rows:
            continue
        sw.append('<section data-state="%s" id="sw-%s"><h2>%s &mdash; the statewide limits, '
                  'which govern every water above that has no rule of its own</h2>'
                  '<table class="tbl"><thead><tr><th class="sp">Fish</th>'
                  '<th class="lim">Size limit</th><th class="lim">Creel limit</th>'
                  '<th class="src">Reaches the plan as</th></tr></thead><tbody>' % (st, st, st))
        for r in rows:
            plan = ', '.join(r['plan']) if r['plan'] else \
                '<span style="color:var(--muted)">no checkbox for this fish</span>'
            scope = (' <span class="chip on">%s only</span>' % E(', '.join(r['scope']))) \
                if r.get('scope') else ''
            sw.append('<tr><td class="sp">%s%s</td><td class="lim mono">%s</td>'
                      '<td class="lim mono">%s</td><td class="src">%s</td></tr>'
                      % (E(r['species'] or '—'), scope, E(r['size'] or '—'),
                         E(r['creel'] or '—'), plan))
        sw.append('</tbody></table></section>')

    ub = []
    for st in states:
        rows = unbound.get(st) or []
        if not rows:
            continue
        ub.append('<section data-state="%s"><h2>%s &mdash; addresses in the book that reached '
                  'no water of ours (%d)</h2><div class="unb"><p style="margin:0;color:'
                  'var(--muted);font-size:13.5px">Each of these is a place the book sets a rule '
                  'for and nothing on our list answered to. Most will be water we do not offer. '
                  'The ones that are not are the gaps worth knowing about.</p><ul>'
                  % (st, st, len(rows)))
        for r in rows:
            ub.append('<li>%s%s</li>' % (E(r['text']),
                      ' <span class="chip">%s</span>' % E(r['species']) if r.get('species') else ''))
        ub.append('</ul></div></section>')

    chips = '<button data-state="ALL" aria-pressed="true">All states</button>' + ''.join(
        '<button data-state="%s" aria-pressed="false">%s</button>' % (st, st) for st in states)

    # A COMPLETE DOCUMENT, because this is opened as a file on a disk.
    #
    # The first cut of this emitted a body fragment -- no doctype, no charset, no viewport --
    # which is the right shape for a hosted page that gets wrapped, and completely wrong for
    # the thing this script actually writes. A browser opening it from F:\ falls back to the
    # system code page, so every em dash and bullet in it renders as mojibake, and with no
    # doctype the whole layout renders in quirks mode. It looked broken because it was.
    return """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TrollMap Regulations Check</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@400;600&family=JetBrains+Mono:wght@400;500&family=Source+Sans+3:wght@400;600&display=swap">
<style>%s</style>
</head>
<body>
<header><div class="wrap">
  <h1>What the books say about our waters</h1>
  <p class="sub">Every rule the four state digests set on a water TrollMap offers, printed the
  way the book prints it. Read the ones you know &mdash; that is the only check this pipeline
  cannot run on itself.</p>
  <div class="tally">%s</div>
  <p class="note">Books read %s. Personal use only, not for distribution or resale; not for
  navigation. Verify against the current digest before you keep a fish.</p>
</div></header>
<div class="bar"><div class="wrap">
  <input type="search" id="q" placeholder="Find a lake, river or fish&hellip;" aria-label="Find a water">
  %s
  <button id="only" aria-pressed="false">Closures only</button>
  <button id="ownonly" aria-pressed="false">Has its own rule</button>
</div></div>
<main><div class="wrap"><section>%s</section>%s%s</div></main>
<script>%s</script>
</body>
</html>
""" % (CSS, tiles, E(str(doc.get('read') or 'unknown')), chips,
       ''.join(parts), ''.join(sw), ''.join(ub), JS)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default='.')
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--out', default=None, help='default <registry>/_regulations_check.html')
    ap.add_argument('--fragment', action='store_true',
                    help='emit the body only, for a host that supplies its own <head>. The '
                         'default is a complete document, which is what a file on a disk has '
                         'to be.')
    a = ap.parse_args()
    reg = os.path.join(a.root, a.registry)
    doc = load(os.path.join(reg, 'regulations_table.json'))
    idx = load(os.path.join(reg, 'lake_index.json'))
    waters, statewide, unbound, offered = collect(doc, idx)
    out = a.out or os.path.join(reg, '_regulations_check.html')
    page = render(doc, waters, statewide, unbound, offered)
    if a.fragment:
        page = page[page.index('<style>'):].replace('</head>\n<body>', '', 1) \
                                           .replace('</body>\n</html>', '', 1)
        page = '<title>TrollMap Regulations Check</title>\n' + page
    with open(out, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(page)
    print('%d waters with a rule of their own, %d statewide rows, %d unbound addresses'
          % (len(waters), sum(len(v) for v in statewide.values()),
             sum(len(v) for v in unbound.values())), flush=True)
    print('wrote %s (%.0f KB)' % (out, os.path.getsize(out) / 1024.0), flush=True)


if __name__ == '__main__':
    main()
