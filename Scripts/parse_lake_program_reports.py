#!/usr/bin/env python3
r"""parse_lake_program_reports.py -- the depths the SC DES lake studies state in words.

    py .\scripts\parse_lake_program_reports.py --registry "F:\TrollMapPipeline\registry" `
        --pdfs "F:\TrollMapPipeline"
    py .\scripts\parse_lake_program_reports.py --registry "..." --pdfs "..." --go

WHAT THIS IS FOR. SC DES runs one lake nutrient study a year and it is the only South Carolina
document class that deploys a sonde and collects vertical profiles. NONE of the casts are
published as numbers -- they are interpolated section plots, and reading a depth off a plot is an
inference. The rule since Lake Wateree carried a fabricated 27 ft for months is that a number is
recorded ONLY WHERE THE DOCUMENT STATES IT. So this reads the prose.

THE SERIES DOES NOT HAVE ONE NAME, AND THE STATION REGISTER IS A PROPERTY OF THE SERIES.
The annual reports are <YEAR>LakeProgramFinalReport.pdf; the same field program is also published
per basin -- the 2019 Lower Catawba study covers Lake Wateree across seven stations AND Fishing
Creek Reservoir. That study names its LAKE stations and never prints their coordinates; the 2020
study prints coordinates for most of them. So the register is built from EVERY report in the run
before a single sentence is attributed, and each station records which file its coordinate came
from.

WHAT IT REFUSES TO DO.

**It does not read figures.** The section plots hold every cast and this script cannot see them;
a records request can.

**It does not invent the station alphabet.** The first version matched `(?:B|RL|CL|ST|MD)-\d{3,5}`
and so could not see S-279, S-326, LCR-03, CW-208 or CL-089 -- five station families, two whole
reports, and the only Lake Wateree depth anyone has stated. A token now qualifies by SHAPE, and
then only counts if the series printed it in a coordinate row or a total-depth phrase. A shape
test plus the document's own register beats a list somebody typed.

**It does not guess which station a sentence belongs to.** Every fact carries
`station_attributed_by`. `named in the sentence` is fact. Anything else is offered for a person to
confirm, and if the nearest station BEFORE the sentence and the nearest AFTER are different
stations, nothing is attributed at all -- page 14 of the 2019 Lower Catawba study names nine
stations across TWO reservoirs, and a nearest-on-the-page guess there is a coin toss between
Fishing Creek and Wateree.

**It checks the depth against the station's own bottom.** The reports state
`average total depth = 5.1 m` next to the station it belongs to. A boundary below the bottom is
not a boundary, it is a bad attribution: the first version put `below 3-4 m` on RL-19154, whose
average total depth the same report prints as 2.3 m. That fact is now refused and says why.

**A RANGE STAYS A RANGE.** `below 3-4 m` is not 4 m. It is 9.8 to 13.1 ft and both ends are
written, because a lure set to the deep end of a stated range is fishing under the answer.

**It states the season.** "From early June, contracting after July" is part of the fact. A depth
without its window is how a spring reading becomes a summer plan.

Personal use only, not for distribution or resale; not for navigation.
"""
from __future__ import annotations
import argparse
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data_map import name_index                            # noqa: E402  one name resolver
from fetch_nla_limnology import boundary_index, M_TO_FT          # noqa: E402  one join, one unit

OUT_NAME = 'lake_program_limnology.json'

# A STATION ID IS A SHAPE, NOT A LIST. B-890, S-279, RL-04370a, LCR-03B, CW-208, CL-089, LWT-01.
SITE = re.compile(r'\b([A-Z]{1,4}-\d{2,5}[A-Za-z]?)\b')
# `34.06953 / -81.61858`, `34.31591, - 81.317800`. THE MINUS SIGN CAN BE DETACHED FROM ITS NUMBER:
# the 2024 report prints a space after the sign, and a regex wanting them adjacent read the
# longitude as +81.3, which is in China, so the only usable depth in a sixty-page report went
# unbound. Allow the gap, then close it up before float().
COORD = re.compile(r'(-?\s*\d{2,3}\.\d{3,})\s*[,;/\s]\s*(-?\s*\d{2,3}\.\d{3,})')
# The bottom, as the report states it beside the station: `(average total depth = 5.1 m`,
# `with a total depth of 4.3 m`, `~7 m total depth`. The word "total" is required -- `depth of
# 0.3 m` is where the grab sample was taken, and using that as a ceiling would refuse everything.
TOTAL_DEPTH = re.compile(r'(?:average\s+)?total\s+depth\s*(?:=|of)\s*~?\s*(\d+(?:\.\d+)?)\s*m\b',
                         re.I)
TOTAL_DEPTH_PRE = re.compile(r'~?\s*(\d+(?:\.\d+)?)\s*m\b\s+total\s+depth', re.I)

UNIT = r'(m|meters?|metres?|ft|feet)\b'
# Ranges FIRST, and their spans are masked so the ends are never also read as two lone depths.
RANGE = re.compile(r'(\d+(?:\.\d+)?)\s*[-\u2010\u2011\u2012\u2013\u2014\u2015]\s*'
                   r'(\d+(?:\.\d+)?)\s*' + UNIT, re.I)
SINGLE = re.compile(r'(\d+(?:\.\d+)?)\s*' + UNIT, re.I)
# THE NUMBER CAN BE A WORD. The 2019 Lower Catawba study states the only Lake Wateree boundary
# anyone has published as "over the upper ten meters" -- no digit in the sentence at all.
WORDS = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8,
         'nine': 9, 'ten': 10, 'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14,
         'fifteen': 15, 'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19,
         'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50}
WORD = re.compile(r'\b(%s)\s+%s' % ('|'.join(sorted(WORDS, key=len, reverse=True)), UNIT), re.I)

# The sentence has to be ABOUT oxygen or stratification, or a depth in it is something else --
# "collected at a depth of 0.3 m", "a 40.4 m water column" are not boundaries.
ABOUT = re.compile(r'\bDO\b|dissolved oxygen|anoxi|hypoxi|thermocl|stratif|oxycl|hypolimn|'
                   r'epilimn|metalimn|mg/L', re.I)
# and it has to say the oxygen FAILED, not merely that oxygen exists. THE THRESHOLD THAT FAILED
# CARRIES A CONCENTRATION UNIT. `<2.5 mg/L` is a failure; `Upper water column (<2.0 m)` is a
# definition of "upper", and reading it as a failure put a phantom 6.6 ft boundary on Lake Murray.
FAILS = re.compile(r'(?:<|less than|below|fell below|dropped below|under)\s*~?\s*\d+(?:\.\d+)?'
                   r'\s*mg/L|anoxi|hypoxi|depleted', re.I)
MONTHS = re.compile(r'\b(January|February|March|April|May|June|July|August|September|October|'
                    r'November|December)\b', re.I)
# THE SEASON IS OFTEN PRINTED AS A DATE, NOT A MONTH. The only Lake Wateree boundary in the
# series is dated `7/30/2019` and names no month, and a depth without its window is how a
# July reading becomes an April plan.
DATED = re.compile(r'\b(1[0-2]|0?[1-9])/(?:3[01]|[12]\d|0?[1-9])/(?:19|20)\d{2}\b')
MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
               'September', 'October', 'November', 'December']


def sentences(flat):
    """(offset, sentence) over the flattened page. THE OFFSET IS THE POINT.

    The first version found sentences with `[^.]{30,}?\\.(?=\\s|$)`, which cannot cross a full stop
    of any kind -- so `(<2.5 mg/L) below 3-4 m` began at the `5`, because the engine walked the
    start past the decimal point it could not span. Every quote was truncated and every
    "named N characters earlier" was measured from the wrong place. Split on the boundary instead
    and the decimal, which is never followed by a space, is not a boundary.
    """
    start = 0
    for m in re.finditer(r'(?<=[.!?])\s+', flat):
        if m.start() > start:
            yield start, flat[start:m.start()]
        start = m.end()
    if start < len(flat):
        yield start, flat[start:]


def to_ft(value, unit):
    return round(value * M_TO_FT, 1) if unit.lower().startswith('m') else round(value, 1)


def depths_in(sent):
    """Every depth the sentence states, as (low_ft, high_ft, as_printed). A range stays a range."""
    out, masked = [], list(sent)
    for m in RANGE.finditer(sent):
        lo, hi = float(m.group(1)), float(m.group(2))
        if hi < lo:
            lo, hi = hi, lo
        out.append((to_ft(lo, m.group(3)), to_ft(hi, m.group(3)), m.group(0).strip(), m.start()))
        for i in range(m.start(), m.end()):
            masked[i] = ' '
    rest = ''.join(masked)
    for m in WORD.finditer(rest):
        v = float(WORDS[m.group(1).lower()])
        out.append((to_ft(v, m.group(2)), to_ft(v, m.group(2)), m.group(0).strip(), m.start()))
        for i in range(m.start(), m.end()):
            masked[i] = ' '
    rest = ''.join(masked)
    for m in SINGLE.finditer(rest):
        v = float(m.group(1))
        out.append((to_ft(v, m.group(2)), to_ft(v, m.group(2)), m.group(0).strip(), m.start()))
    return sorted(out, key=lambda t: t[3])


def read_register(pagesets):
    """The station register, built from EVERY report before any sentence is attributed.

    A token qualifies by shape; it enters the register only where the series printed a coordinate
    row for it or stated its total depth beside it. `LI-1400` is a LI-COR data logger and `R-19`
    is a regulation -- neither is ever in a coordinate row, so neither becomes a station.
    """
    reg = {}

    def row(sid):
        return reg.setdefault(sid, {'station': sid, 'description': None, 'lat': None, 'lon': None,
                                    'coords_from': None, 'total_depth_m': None,
                                    'total_depth_from': None})

    for fname, pages in pagesets:
        for text in pages:
            for line in (text or '').split('\n'):
                m = SITE.search(line)
                c = COORD.search(line)
                if not (m and c):
                    continue
                r = row(m.group(1))
                if r['lat'] is None:
                    r['lat'] = float(re.sub(r'\s+', '', c.group(1)))
                    r['lon'] = float(re.sub(r'\s+', '', c.group(2)))
                    r['coords_from'] = fname
                desc = line.split(m.group(1), 1)[1].replace(c.group(0), ' ')
                desc = ' '.join(re.sub(r'^[\s\u2013\u2014-]+', '', desc).split())
                if desc and not r['description'] and re.search(r'reservoir|lake|arm|creek|river',
                                                               desc, re.I):
                    r['description'] = desc[:120]
    # THE BOTTOM BELONGS TO THE STATION THE SENTENCE IS ABOUT, AND A SENTENCE THAT NAMES THREE
    # STATIONS IS ABOUT NONE OF THEM. The Appendix caption
    #     `S-222 - Little Saluda River arm below RL-19154 and S-326 (average total depth = 7.0 m)`
    # names S-326 four words before a depth that is not S-326's, and both a nearest-before and a
    # nearest-after rule hand it over. S-326's real bottom is 5.1 m, printed in its own caption,
    # and the difference decides whether a 3-4 m boundary at that station is possible. So: exactly
    # one station named ahead of the phrase in its own sentence, or the bottom is not recorded.
    # A missing ceiling only costs a check; a wrong one silently passes or kills a real fact.
    for fname, pages in pagesets:
        for text in pages:
            flat = ' '.join((text or '').split())
            for _, sent in sentences(flat):
                for d in list(TOTAL_DEPTH.finditer(sent)) + list(TOTAL_DEPTH_PRE.finditer(sent)):
                    ahead = {m.group(1) for m in SITE.finditer(sent[:d.start()])}
                    if len(ahead) != 1:
                        continue
                    r = row(next(iter(ahead)))
                    if r['total_depth_m'] is None:
                        r['total_depth_m'] = float(d.group(1))
                        r['total_depth_from'] = fname
    return reg


def anchors(flat, reg, waters):
    """Where this page names a station, and where it names a water. (offset, key) pairs."""
    st = [(m.start(), m.group(1)) for m in SITE.finditer(flat) if m.group(1) in reg]
    wa = [(m.start(), waters[m.group(0).lower()]) for m in re.finditer(waters['_re'], flat)]
    return st, wa


def nearest(at, span, marks):
    """The mark this sentence belongs to, or a refusal.

    Inside the sentence is fact. Otherwise the nearest mark before and the nearest after must
    AGREE: page 14 of the 2019 Lower Catawba study names nine stations across two reservoirs,
    and picking the closest one there is a coin toss, not an attribution.
    """
    inside = [k for o, k in marks if at <= o < at + span]
    if inside:
        return inside[0], 'named in the sentence', None
    before = [(o, k) for o, k in marks if o < at]
    after = [(o, k) for o, k in marks if o >= at + span]
    b = before[-1] if before else None
    a = after[0] if after else None
    if b and a and b[1] != a[1]:
        return None, None, ('%s is named %d characters before and %s %d after -- the sentence sits '
                            'between two of them' % (b[1], at - b[0], a[1], a[0] - at - span))
    if b:
        return b[1], 'named %d characters earlier on the same page' % (at - b[0]), None
    if a:
        return a[1], 'named %d characters later on the same page' % (a[0] - at - span), None
    return None, None, 'the page never names one'


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', default=os.environ.get('TROLLMAP_REGISTRY',
                                                         r'F:\TrollMapPipeline\registry'))
    ap.add_argument('--pdfs', required=True, help='folder holding the reports')
    ap.add_argument('--glob', action='append', default=None,
                    help='file patterns to read; repeatable. Defaults cover both series.')
    ap.add_argument('--go', action='store_true', help='write the registry file')
    a = ap.parse_args(argv)

    try:
        import pdfplumber
    except ImportError:
        raise SystemExit('pdfplumber is required: py -m pip install pdfplumber')

    pats = a.glob or ['*LakeProgram*.pdf', '*Lake Program*.pdf',
                      '*Nutrient*Stud*.pdf', '*Water_Quality_Study*.pdf',
                      '*Water Quality Study*.pdf']
    found = sorted({fp for pat in pats for fp in glob.glob(os.path.join(a.pdfs, pat))})
    if not found:
        raise SystemExit('nothing matching %s under %s' % (', '.join(pats), a.pdfs))

    idx_fp = os.path.join(a.registry, 'lake_index.json')
    if not os.path.exists(idx_fp):
        raise SystemExit('no lake_index.json in %s' % a.registry)
    IDX = {k: v for k, v in json.load(open(idx_fp, encoding='utf-8')).items()
           if isinstance(v, dict)}
    byname = name_index(IDX)
    # ONE SLUG ONLY, AND NEVER A ONE-WORD NAME. "Lake Wateree" earns its place in the prose;
    # "Wateree" alone also names a river, a dam and a creek in the same paragraph.
    waters = {k: next(iter(v)) for k, v in byname.items()
              if len(v) == 1 and ' ' in k and len(k) >= 8}
    waters['_re'] = re.compile(r'\b(?:%s)\b' % '|'.join(
        re.escape(k) for k in sorted(waters, key=len, reverse=True) if k != '_re'), re.I)
    slug_at, npoly = boundary_index(a.registry)
    print('%d boundary polygon(s), %d water name(s) the prose could name' % (npoly, len(waters) - 1))

    pagesets = []
    for fp in found:
        with pdfplumber.open(fp) as doc:
            pagesets.append((os.path.basename(fp), [p.extract_text() or '' for p in doc.pages]))
    reg = read_register(pagesets)
    for s in reg.values():
        s['slug'] = slug_at(s['lat'], s['lon']) if s['lat'] is not None else None
    print('%d station(s) in the register across %d report(s); %d have coordinates, %d a bottom'
          % (len(reg), len(pagesets),
             sum(1 for s in reg.values() if s['lat'] is not None),
             sum(1 for s in reg.values() if s['total_depth_m'] is not None)))

    reports = {}
    for fname, pages in pagesets:
        year = (re.search(r'(19|20)\d{2}', fname) or [None])[0]
        facts = []
        for pno, text in enumerate(pages, 1):
            flat = ' '.join((text or '').replace('\n', ' ').split())
            st_marks, wa_marks = anchors(flat, reg, waters)
            for at, sent in sentences(flat):
                if len(sent) < 30 or not (ABOUT.search(sent) and FAILS.search(sent)):
                    continue
                sid, how, no_st = nearest(at, len(sent), st_marks)
                wslug, whow, no_wa = nearest(at, len(sent), wa_marks)
                station = reg.get(sid) or {}
                coord = station.get('slug')
                # THE COORDINATE IS THE JOIN AND THE NAME IS THE CROSS-CHECK -- the same order
                # bind() uses in derive_nes_limnology.py, and disagreement is a refusal there too.
                slug, slug_from, why = coord or wslug, None, None
                if coord and wslug and coord != wslug:
                    slug = None
                    why = ('the station %s falls in %s and the prose names %s'
                           % (sid, coord, wslug))
                elif coord:
                    slug_from = ('the coordinate the series prints for %s (%s)'
                                 % (sid, how)) + ('; the prose agrees' if wslug == coord else '')
                elif wslug:
                    slug_from = 'the water named in the prose (%s)' % whow
                else:
                    why = '; '.join(x for x in (no_st, no_wa) if x) or 'nothing to bind to'
                months = sorted({x.title() for x in MONTHS.findall(sent)}
                                | {MONTH_NAMES[int(x) - 1] for x in DATED.findall(sent)},
                                key=MONTH_NAMES.index)
                dates = sorted({m.group(0) for m in DATED.finditer(sent)})
                for lo, hi, printed, _ in depths_in(sent):
                    bottom = station.get('total_depth_m')
                    # WHAT THE STATION CAN SPEAK FOR. S-326 is the Clouds Creek arm and the same
                    # report prints its average total depth as 5.1 m; our chart of Lake Murray
                    # reaches 192 ft. Both numbers are written and neither is thresholded --
                    # a 3-4 m boundary in a 16.7 ft arm is not the main lake's thermocline, and
                    # whoever reads this record has to be able to see that without being told.
                    charted = (IDX.get(slug) or {}).get('max_depth_ft') if slug else None
                    reach = None
                    if bottom is not None and charted:
                        reach = ('the series prints %.1f ft as this station\'s bottom; our chart '
                                 'of this water reaches %s ft'
                                 % (bottom * M_TO_FT, charted))
                    elif charted:
                        reach = ('the series never prints a bottom for this station; our chart '
                                 'of this water reaches %s ft' % charted)
                    impossible = None
                    if bottom is not None and lo > round(bottom * M_TO_FT, 1):
                        impossible = ('%s stops at %.1f m (%.1f ft) in this series, so %s cannot '
                                      'be a boundary there' % (sid, bottom, bottom * M_TO_FT,
                                                               printed))
                    facts.append({
                        'page': pno, 'depth_ft_low': lo, 'depth_ft_high': hi,
                        'as_printed': printed,
                        'station': None if impossible else sid,
                        'station_attributed_by': None if impossible else how,
                        'slug': None if impossible else slug,
                        'slug_from': None if impossible else slug_from,
                        # KEPT EVEN WHEN THE WATER BINDS. The Lake Wateree statement binds on the
                        # name while its station is refused, and without this the record cannot
                        # say that a station WAS named on that page and why it was not taken.
                        'station_unattributed_because': no_st,
                        'unbound_because': impossible or why,
                        'water_named_in_prose': wslug, 'water_named_by': whow,
                        'station_total_depth_m': bottom,
                        'months_named': months,
                        'dates_named': dates,
                        'station_bottom_ft': None if bottom is None
                                             else round(bottom * M_TO_FT, 1),
                        'charted_max_ft': charted,
                        'reach': reach,
                        'quote': sent[:400]})
        reports[fname] = {'year': year, 'depth_statements': facts}
        bound = sum(1 for f in facts if f['slug'])
        print('   %-40s %d statement(s), %d bound' % (fname[:40], len(facts), bound))
        for f in facts:
            rng = ('%.1f ft' % f['depth_ft_low'] if f['depth_ft_low'] == f['depth_ft_high']
                   else '%.1f-%.1f ft' % (f['depth_ft_low'], f['depth_ft_high']))
            print('      p%-3d %-9s %-26s %-12s %s' % (
                f['page'], f['station'] or '?', (f['slug'] or 'UNBOUND')[:26], rng,
                ', '.join(f['months_named']) or 'no month named'))
            if f['reach']:
                print('           %s' % f['reach'])
            print('           as printed "%s"  |  %s' % (
                f['as_printed'], f['slug_from'] or f['unbound_because']))
            print('           "%s"' % f['quote'][:160])

    if not a.go:
        print()
        print('dry run. Re-run with --go to write %s' % os.path.join(a.registry, OUT_NAME))
        return 0

    doc = {'_note': 'Depths STATED IN THE PROSE of the SC DES lake nutrient studies -- the annual '
                    'Lake Program reports and the per-basin studies that carry the same field '
                    'program. These studies collect biweekly vertical profiles and publish them '
                    'as interpolated section plots; reading a depth off a plot is an inference, '
                    'so only sentences are read here. A RANGE STAYS A RANGE: depth_ft_low and '
                    'depth_ft_high are equal only where the document printed one number. Every '
                    'statement carries its verbatim quote, its page, and HOW its station was '
                    'attributed -- only `named in the sentence` is fact, and a statement whose '
                    'page names two different stations around it is left unattributed. A '
                    'boundary deeper than the bottom the same series prints for that station is '
                    'refused. The casts themselves are a records request. '
                    'Personal use only, not for distribution or resale; not for navigation.',
           'source': 'SC DES Bureau of Water lake nutrient studies, '
                     'https://www.des.sc.gov/sites/des/files/Documents/BOW/WaterQuality/',
           'generated': __import__('datetime').date.today().isoformat(),
           'stations': reg,
           'reports': reports}
    fp = os.path.join(a.registry, OUT_NAME)
    with open(fp, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write('\n')
    print('-> %s' % fp)
    return 0


if __name__ == '__main__':
    sys.exit(main())
