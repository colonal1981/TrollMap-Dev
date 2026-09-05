#!/usr/bin/env python3
r"""parse_nes_working_papers.py -- the 1973 vertical profiles, out of Appendix D.

    py .\scripts\parse_nes_working_papers.py --pages "F:\TrollMapPipeline\_derived\nes_ocr"
    py .\scripts\parse_nes_working_papers.py --pages "F:\TrollMapPipeline\_derived\nes_ocr" ^
        --registry "F:\TrollMapPipeline\registry" --go

WHAT THIS IS FOR.

Eight South Carolina lakes had no vertical profile from any source: the Water Quality Portal
holds only a 1 ft depth stamp on a grab, the EPA National Lakes Assessment never drew them, and
the SC DES Lake Program publishes its sonde casts as figures inside a PDF. Ryan, 2026-09-05,
having asked about the EPA eutrophication survey at the start of the session and been ignored:
*"9100D9LY.pdf on my drive"*.

The National Eutrophication Survey working papers -- one per lake, 1973 -- carry Appendix D, a
STORET retrieval printed as a fixed-width table. Seven of the eight are on the drive. Appendix A
of any one of them lists all thirteen South Carolina lakes with their STORET codes, which is how
the set was found.

THE COLUMN IS A POSITION ON THE PAGE, NOT A POSITION IN A SENTENCE.

This is the whole reason the parser is built the way it is. Lake Murray, page 41, July cast:

    73/07/09  10 50  0000  30.2  108   63  8.30   <- 108 is SECCHI, in inches. DO is BLANK.
              10 50  0006  30.1   79   60  7.70   <-  79 is DISSOLVED OXYGEN, printed 7.9.

Both are the second number after the depth. Counting tokens puts a nine-foot Secchi disc into
the oxygen column as 108 mg/L, or -- worse, because it is inside the plausible range and would
never be caught -- puts a fifteen-inch transparency in as 15 mg/L and calls the lake healthy.
Blank cells are common: a surface row often has no oxygen, a mid-column row often has no
conductivity. Nothing in the text stream says a cell was skipped.

So the digits pass is read as TSV -- tesseract's word boxes, with x-coordinates -- and every
number is assigned to whichever parameter-code header it sits under. The header line is the
ruler:

    00010   00300   00077   00094   00400   00410  ...     <- STORET codes, at 325 px spacing
     temp     DO   secchi   cond      pH     alk

A number lands in a column only if it is within 45% of the column spacing of that code's centre.
Two numbers landing in one column means the row skewed, and that column is dropped for that row.
Anything to the LEFT of the first parameter column is the date, the time and the depth -- never a
measurement. That last rule is what keeps `11 00` (the time) out of the temperature column.

If 00010 or 00300 did not read on a page, the page has no ruler and its rows are not read at all.

TWO OCR PASSES, BECAUSE ONE CANNOT DO BOTH JOBS.

    pass A   300 dpi, letters      structure: Appendix D vs E, the lake's name, `0183 FEET DEPTH`
    pass B   500 dpi, digits, TSV  the rows, and the geometry that tells the columns apart

Scripts/ocr_nes_working_papers.py runs both and writes what --pages reads.

A numeric whitelist is what makes the DATA legible -- it is the difference between `3001` and
`30.1` -- and it erases every word on the page, so the first attempt at this parsed the table
beautifully and came back with a lake called `?`, five phantom stations and a reading at 9,000
feet. The two passes are paired BY PAGE NUMBER, and the station header -- a six-digit id, its
degrees/minutes/seconds, its charted depth -- is read in both, so the rows join to the structure
BY STATION ID rather than by which one happened to be last on the page.

THE PAGES ARE SCANNED, SO EVERY NUMBER IS AN OCR GUESS UNTIL IT EARNS ITS PLACE.

The decimal point is what breaks: 24.2 reads as `2402`, 7.9 as `79`, 3.9 as `329`. Those are
recoverable ONLY by guessing which digit was the separator, and a guessed dissolved-oxygen value
puts an anoxic boundary at a depth nobody measured. This project has already shipped one
fabricated thermocline -- Lake Wateree carried 27 ft for months -- so:

    A VALUE IS TAKEN AS PRINTED OR IT IS DROPPED. NOTHING IS REPAIRED.

Temperature and oxygen are printed in this table to exactly one decimal place, every row, without
exception. So that is the only form accepted: `30.2`, `9.6`, `0.1`. A bare integer in one of
those columns is not a reading, it is a decimal point that did not survive -- `79` is not 79 mg/L
and it is not 7.9 mg/L either, it is damage, and it goes. `0` in the oxygen column is the same
thing and is the more dangerous one, because 0.0 mg/L is inside the physical range and would be
stored as anoxia that was never measured.

On Lake Murray's July cast that costs four readings of nine and keeps the one that matters --
2.6 mg/L at 30 ft, under the 4 mg/L the derivation looks for. Every cast reports how many rows it
dropped, so a paper that OCR'd badly is visible rather than quietly thin.

WHAT IS DELIBERATELY NOT DONE HERE. No thermocline is derived. This file is the CASTS, as the
1973 printout has them. The derivation already exists twice and neither copy belongs here:
Worker/research/limnology.js owns the WQP rule, and Scripts/fetch_nla_limnology.py owns the
Python one -- `thermocline_from()` and `oxygen_from()`, with the guards that refuse a number
rather than invent one. A third copy is how two readers of one feed start disagreeing, so
whatever carries these casts into a profile imports that one.

AND THE YEAR TRAVELS WITH EVERY NUMBER. These are 1973 measurements. Lake Murray had the Saluda
dam remediation in 2005-2010, which changed how its hypolimnion is oxygenated. A 1973 profile is
evidence, not a current reading, and every record says so.
"""
from __future__ import annotations
import argparse
import glob
import json
import os
import re
import sys

OUT_NAME = 'nes_1973_profiles.json'

# --- the printed forms -------------------------------------------------------------------
DATE_TOK = re.compile(r'^(\d\d)[/.](\d\d)[/.](\d\d)$')
ONE_DECIMAL = re.compile(r'^\d{1,2}\.\d$')     # the ONLY form temperature and oxygen are printed in
DEPTH_TOK = re.compile(r'^\d{4}$')          # the depth is printed four digits wide, always
STATION_TOK = re.compile(r'^\d{6}$')
CODE_TOK = re.compile(r'^\d{5}$')
HEADER_TOK = re.compile(r'^\d{5,6}$')
STATION_LINE = re.compile(r'^\s*(\d{6})\s*$')
DMS = re.compile(r'^\s*(\d{2})\s+(\d{2})\s+(\d{2})[.\d]*\s+(\d{3})\s+(\d{2})\s+(\d{2})')
FEET_DEPTH = re.compile(r'(\d{3,4})\s*FEET\s+DEPTH', re.I)
LAKE_LINE = re.compile(r'^\s*(LAKE\s+[A-Z .\'-]+|[A-Z][A-Z .\'-]*\s+(?:RESERVOIR|LAKE))\s*$')
LAKE_CODE = re.compile(r'LAKE\s+CODE\s+(\d{4})', re.I)

TEMP_CODE = '00010'
DO_CODE = '00300'
TEMP_RANGE = (0.0, 40.0)          # degrees C
DO_RANGE = (0.0, 20.0)            # mg/L
COL_TOLERANCE = 0.45              # of the column spacing -- past this a token is between columns
LEFT_MARGIN = 0.40                # of the column spacing, left of code 00010: date/time/depth live here
ABSOLUTE_MAX_FT = 450             # deeper than any lake in this survey's SC set
SC_BOX = (32.0, 35.5, -83.5, -78.5)   # lat lo/hi, lon lo/hi -- South Carolina and its borders

# THREE THINGS ON THESE PAGES LOOK LIKE A STATION AND ARE NOT ONE.
#
#   the HUC code       `03089)` OCRs to `030891` and matched a bare six-digit id, opening a
#                      phantom station block that split a real one in half
#   Appendix E         tributary and wastewater-plant records, same layout, same six-digit ids
#                      ending 41/61/81 -- a creek's grab is not a lake cast
#   a garbled DMS      `lat=15.0 lon=-251.21722` and `lon=-45.90833` both passed a regex that
#                      only checked shape
#
# So: stations are read ONLY between the Appendix D and Appendix E headings, a six-digit id is a
# station only when its degrees/minutes/seconds follow it within two lines, and a coordinate
# outside South Carolina and its border counties is refused rather than stored.


def one_decimal(tok, lo, hi):
    """As printed, or nothing. One decimal place, inside the column's physical range."""
    if not ONE_DECIMAL.match(tok or ''):
        return None
    v = float(tok)
    return v if lo <= v <= hi else None


def read_date(tok):
    m = DATE_TOK.match(tok or '')
    if not m:
        return None
    yy, mm, dd = (int(g) for g in m.groups())
    if not (1 <= mm <= 12 and 1 <= dd <= 31):
        return None                      # `73/63/26` is an OCR month, not March. Refuse it.
    return '19%02d-%02d-%02d' % (yy, mm, dd)


def median(xs):
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


# --- pass A: the words ------------------------------------------------------------------------

def read_structure(pages):
    """From the 300 dpi words pass: which pages are Appendix D, the lake's name and STORET code,
    and -- keyed by station id -- the charted depth and the coordinate. Rows join to this BY ID."""
    lake_name, in_d, appendix_d, meta, codes = None, False, set(), {}, {}
    for no, words in pages:
        up = (words or '').upper()
        if 'APPENDIX D' in up:
            in_d = True
        if 'APPENDIX E' in up or ('TRIBUTARY' in up and 'TREATMENT' in up):
            in_d = False
        lines = (words or '').split('\n')
        for line in lines:
            # The lake's name is on the title page, long before Appendix D. Gate the DATA, not the
            # reading -- the first version of this gate cost Lake Secession its name.
            if lake_name is None and LAKE_LINE.match(line):
                lake_name = line.strip()
            # THE SURVEY'S OWN KEY, WHICH IS WHAT THE STATION IDS ARE BUILT FROM: station 450701
            # is lake 4507. It is printed on the flow pages and in Appendix A, several times per
            # paper, and it misreads -- Robinson prints 4508 twice and 4598 once. Take the one the
            # document says most often; that is counting, not guessing.
            c = LAKE_CODE.search(line)
            if c:
                codes[c.group(1)] = codes.get(c.group(1), 0) + 1
        if not in_d:
            continue
        appendix_d.add(no)
        cur = None
        for li, line in enumerate(lines):
            m = STATION_LINE.match(line)
            if m and any(DMS.match(x) for x in lines[li + 1:li + 3]):
                cur = meta.setdefault(m.group(1), {})
                continue
            if cur is None:
                continue
            d = DMS.match(line)
            if d and 'lat' not in cur:
                la = int(d.group(1)) + int(d.group(2)) / 60 + int(d.group(3)) / 3600
                lo = -(int(d.group(4)) + int(d.group(5)) / 60 + int(d.group(6)) / 3600)
                if SC_BOX[0] <= la <= SC_BOX[1] and SC_BOX[2] <= lo <= SC_BOX[3]:
                    cur['lat'], cur['lon'] = round(la, 5), round(lo, 5)
                else:
                    cur['bad_coordinate'] = '%s %s' % (round(la, 3), round(lo, 3))
            f = FEET_DEPTH.search(line)
            if f and 'station_depth_ft' not in cur:
                v = int(f.group(1))
                if v:
                    cur['station_depth_ft'] = v       # `0000 FEET DEPTH` is not a depth
    code = max(codes, key=lambda k: (codes[k], k)) if codes else None
    return lake_name, code, appendix_d, meta


# --- pass B: the digits, with their boxes -----------------------------------------------------

def tsv_lines(text):
    """tesseract TSV -> [[(centre_x, token), ...], ...] in reading order."""
    out, key = [], None
    for raw in (text or '').split('\n')[1:]:
        f = raw.split('\t')
        if len(f) < 12 or f[0] != '5':
            continue
        tok = f[11].strip()
        if not tok:
            continue
        try:
            left, width = int(f[6]), int(f[8])
        except ValueError:
            continue
        k = (f[2], f[3], f[4])
        if k != key:
            out.append([])
            key = k
        out[-1].append((left + width / 2.0, tok))
    return [ln for ln in out if ln]


def is_header(line):
    """A line of nothing but STORET parameter codes. Either a ruler, or a table we cannot read."""
    return len(line) >= 2 and all(HEADER_TOK.match(t) for _c, t in line)


def column_ruler(line):
    """A parameter-code header line, or None. Returns (centres_by_code, spacing, left_edge)."""
    codes = [(c, t) for c, t in line if CODE_TOK.match(t)]
    if len(codes) < 6:
        return None
    have = {t: c for c, t in codes}
    if TEMP_CODE not in have or DO_CODE not in have:
        return None                      # no ruler for the two columns that matter -- read nothing
    xs = sorted(c for c, _ in codes)
    gaps = [b - a for a, b in zip(xs, xs[1:])]
    spacing = median(gaps)
    if spacing <= 0:
        return None
    return have, spacing, xs[0] - spacing * LEFT_MARGIN


def assign(line, ruler):
    """Split a data line at the first parameter column, then put each number under its code."""
    have, spacing, left_edge = ruler
    left = [(c, t) for c, t in line if c < left_edge]
    tol = spacing * COL_TOLERANCE
    cells = {}
    for c, t in line:
        if c < left_edge:
            continue
        code, dist = min(((k, abs(c - x)) for k, x in have.items()), key=lambda kv: kv[1])
        if dist > tol:
            continue                     # between two columns -- which one is a guess
        cells[code] = None if code in cells else t   # two tokens in one column: the row skewed
    return left, cells


def read_rows(pages, appendix_d, meta, source):
    """pages: [(pageno, tsv_text)]. Rows attach to the station whose block they fall in."""
    stations, cur, date, ruler = {}, None, None, None
    for no, text in pages:
        if no not in appendix_d:
            continue
        lines = tsv_lines(text)
        for li, line in enumerate(lines):
            toks = [t for _c, t in line]
            if is_header(line):
                # THE SAME PAGE PRINTS A SECOND TABLE IN THE SAME COLUMNS.
                # Under `00665 32217` come total phosphorus and chlorophyll-a, at the same
                # x-positions as water temperature and dissolved oxygen. Robinson's September
                # chlorophyll of 9.4 ug/L was being stored as 9.4 mg/L of oxygen. A header line
                # either replaces the ruler or removes it -- it never leaves the old one standing.
                ruler = column_ruler(line)
                continue
            if len(toks) == 1 and STATION_TOK.match(toks[0]):
                nxt = ' '.join(t for ln in lines[li + 1:li + 3] for _c, t in ln)
                if DMS.match(nxt):
                    sid = toks[0]
                    cur = stations.setdefault(sid, dict(meta.get(sid, {}), station=sid,
                                                        casts={}, source=source))
                    date, ruler = None, None
                continue
            if cur is None or ruler is None:
                continue
            left, cells = assign(line, ruler)
            for _c, t in left:
                # A DATE THAT DID NOT READ CLOSES THE CAST; IT DOES NOT LEAVE THE OLD ONE OPEN.
                # Keowee 451302 prints `73/11/13` and it OCR'd as `73411713`. The first version
                # kept the previous date, so a November cast to 130 ft was filed under 17
                # September, out of order and eight readings long. Only the date field is this
                # wide -- a time is two digits, a depth is four -- so anything six characters or
                # more in the left region IS the date, and if it does not parse there is no date.
                if len(t) >= 6:
                    date = read_date(t)
            # A DATA ROW CARRIES A TIME AND A DEPTH, IN THAT ORDER.
            # When the depth does not read, the rightmost thing left of the columns is the time,
            # and `11 00` merged into `1100` is four digits exactly like a depth. Requiring two
            # tokens is what keeps 11:00 out of the depth column; taking the rightmost is what
            # keeps it out when the depth DID read.
            depths = [t for _c, t in left if DEPTH_TOK.match(t)]
            if len(left) < 2 or not depths or date is None:
                continue
            depth = int(depths[-1])
            # Nothing in these lakes is 9,000 feet deep, and the first version of this said one
            # was. The station's own printed depth is NOT a cap: it is the charted depth at the
            # sample point, and the boat sounded deeper than it on five of these stations --
            # Keowee 451302 is charted 98 ft and its November cast reaches 160.
            if depth > ABSOLUTE_MAX_FT:
                cur['rejected_out_of_range'] = cur.get('rejected_out_of_range', 0) + 1
                continue
            temp = one_decimal(cells.get(TEMP_CODE), *TEMP_RANGE)
            do = one_decimal(cells.get(DO_CODE), *DO_RANGE)
            cast = cur['casts'].setdefault(date, {'date': date, 'readings': [], 'dropped': 0})
            if temp is None and do is None:
                cast['dropped'] += 1
                continue
            row = {'depthFt': depth}
            if temp is not None:
                row['tempC'] = temp
            if do is not None:
                row['doMgL'] = do
            else:
                cast['dropped'] += 1
            cast['readings'].append(row)
    return stations


def keep_cast(cast):
    """A cast is worth storing when it is a COLUMN, not a couple of points."""
    withdo = [r for r in cast['readings'] if 'doMgL' in r]
    depths = [r['depthFt'] for r in cast['readings']]
    if len(withdo) < 3:
        return False, 'fewer than 3 dissolved-oxygen readings survived'
    if depths != sorted(depths):
        return False, 'depths are not in order -- the rows did not read cleanly'
    if max(depths) - min(depths) < 10:
        return False, 'less than 10 ft of span'
    return True, None


def parse_paper(word_pages, tsv_pages, source):
    lake_name, lake_code, appendix_d, meta = read_structure(word_pages)
    stations = read_rows(tsv_pages, appendix_d, meta, source)
    return lake_name, lake_code, [stations[k] for k in sorted(stations)]


def load(pages_dir):
    """<doc>.300.<page>.txt (words) and <doc>.500.<page>.tsv (digits + boxes), paired by page."""
    pat = re.compile(r'^(?P<doc>.+)\.(?P<dpi>\d+)\.(?P<page>\d+)\.(?P<ext>txt|tsv)$')
    docs = {}
    for fp in sorted(glob.glob(os.path.join(pages_dir, '*.txt'))
                     + glob.glob(os.path.join(pages_dir, '*.tsv'))):
        m = pat.match(os.path.basename(fp))
        if not m:
            continue
        d = docs.setdefault(m.group('doc'), {'words': {}, 'tsv': {}})
        d['tsv' if m.group('ext') == 'tsv' else 'words'][int(m.group('page'))] = fp
    return docs


def read(fp):
    return open(fp, encoding='utf-8', errors='replace').read()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--pages', required=True,
                    help='OCR output: <doc>.300.<page>.txt (words) + <doc>.500.<page>.tsv (digits)')
    ap.add_argument('--registry', default=os.environ.get('TROLLMAP_REGISTRY',
                                                         r'F:\TrollMapPipeline\registry'))
    ap.add_argument('--only', help='one document stem, for checking a single paper')
    ap.add_argument('--dump-station', help='print every surviving reading for this station id')
    ap.add_argument('--go', action='store_true', help='write the registry file')
    a = ap.parse_args(argv)

    docs = load(a.pages)
    if a.only:
        docs = {k: v for k, v in docs.items() if a.only in k}
    if not docs:
        raise SystemExit('no <doc>.<dpi>.<page>.txt/.tsv files under %s' % a.pages)

    papers = {}
    for doc, got in sorted(docs.items()):
        if not got['tsv']:
            print('   !! %-30s no .tsv pages -- the digits pass did not run' % doc)
            continue
        word_pages = [(n, read(got['words'][n])) for n in sorted(got['words'])]
        tsv_pages = [(n, read(got['tsv'][n])) for n in sorted(got['tsv'])]
        name, code, stations = parse_paper(word_pages, tsv_pages, doc)
        kept, dropped = [], []
        for st in stations:
            casts = []
            for date in sorted(st['casts']):
                c = st['casts'][date]
                ok, why = keep_cast(c)
                (casts if ok else dropped).append(c if ok else dict(c, station=st['station'],
                                                                    why=why))
            if casts:
                kept.append(dict(st, casts=casts))
        if a.dump_station:
            for st in kept:
                if st['station'] != a.dump_station:
                    continue
                for c in st['casts']:
                    print('  %s  (%d dropped)' % (c['date'], c['dropped']))
                    for r in c['readings']:
                        print('     %4d ft   %s C   %s mg/L'
                              % (r['depthFt'], r.get('tempC', '   -'), r.get('doMgL', '  -')))
        # A PAPER THAT PRODUCED NOTHING IS STILL RECORDED, WITH WHY.
        # Fishing Creek Reservoir was cast three times in 1973 and two oxygen readings survived
        # the scan. "We asked and it did not carry a profile" and "we never asked" are different
        # answers, and the limnology ledger has to be able to tell them apart.
        papers[doc] = {'lake_as_printed': name, 'storet_lake_code': code,
                       'stations': kept, 'casts_dropped': dropped}
        if not kept:
            print('   !! %-30s %-4s %-24s no cast survived -- %d refused'
                  % (doc, code or '????', (name or '?')[:24], len(dropped)))
            continue
        n = sum(len(s2['casts']) for s2 in kept)
        summer = sum(1 for s2 in kept for c in s2['casts'] if 6 <= int(c['date'][5:7]) <= 9)
        deep = max((r['depthFt'] for s2 in kept for c in s2['casts'] for r in c['readings']),
                   default=0)
        sdo = sum(1 for s2 in kept for c in s2['casts'] if 6 <= int(c['date'][5:7]) <= 9
                  for r in c['readings'] if 'doMgL' in r)
        print('   %-30s %-4s %-24s %d station(s), %2d cast(s), %2d summer, '
              '%3d summer DO readings, to %3d ft  (%d refused)'
              % (doc, code or '????', (name or '?')[:24], len(kept), n, summer, sdo, deep,
                 len(dropped)))

    if not a.go:
        print()
        print('dry run. Re-run with --go to write %s' % os.path.join(a.registry, OUT_NAME))
        return 0

    doc = {'_note': 'EPA National Eutrophication Survey working papers, Appendix D. 1973 vertical '
                    'profiles: depth in feet, water temperature in C, dissolved oxygen in mg/L. '
                    'A VALUE IS AS PRINTED OR ABSENT -- OCR damage is dropped, never repaired; '
                    'temperature and oxygen are accepted only in the one-decimal form the table '
                    'prints. Columns are assigned by x-position under the STORET parameter-code '
                    'header, because a blank cell shifts every token after it. '
                    'THE YEAR IS PART OF THE FACT: these are 1973 measurements and several of '
                    'these reservoirs have been re-operated since.',
           'source': 'EPA National Eutrophication Survey, working paper per lake, 1973 sampling',
           'derivation': 'none here. These are the casts. Scripts/fetch_nla_limnology.py owns '
                         'the Python rule -- thermocline_from() and oxygen_from(), with the '
                         'guards that refuse a number rather than invent one -- and whatever '
                         'carries these into a profile imports that one rather than writing a '
                         'third copy.',
           'keyed_by': 'each key is the NEPIS accession of the working paper; storet_lake_code '
                       'is the survey\'s own four-digit lake key, and every station id begins '
                       'with it.',
           'generated': __import__('datetime').date.today().isoformat(),
           'papers': papers}
    out_fp = os.path.join(a.registry, OUT_NAME)
    with open(out_fp, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write('\n')
    print('-> %s   (%d KB)' % (out_fp, round(os.path.getsize(out_fp) / 1024)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
