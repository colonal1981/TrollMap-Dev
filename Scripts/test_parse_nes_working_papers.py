#!/usr/bin/env python3
r"""test_parse_nes_working_papers.py

    py .\scripts\test_parse_nes_working_papers.py

The page this is built on is Lake Murray, working paper 9100D9LY, page 41, station 450701 --
read by eye off the scan at 500 dpi so the parser has something to be wrong against:

    73/07/09  0000  30.2   -      0006  30.1  7.9    0015  29.8  8.0    0030  24.2  2.6
              0060  19.3  3.2     0090  15.9  4.5    0120  15.2  3.9    0150  14.8  3.6
              0178  14.4  2.7
    73/09/22  0000  27.0  6.8     0025  26.8  6.2    0040  26.1  1.2    0060  22.5  1.1
              0110  19.5  0.1     0140  18.6  0.1    0175  17.6  0.1

The July surface row is the whole reason for the geometry: its oxygen cell is BLANK and the next
number printed is 108, a nine-foot Secchi disc. Any parser that counts tokens reads that as the
oxygen. The x-coordinates below are the real ones off that page.
"""
from __future__ import annotations
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import parse_nes_working_papers as P

FAIL = []


def ok(name, got, want):
    if got != want:
        FAIL.append('%s\n      got  %r\n      want %r' % (name, got, want))


def truthy(name, got):
    if not got:
        FAIL.append('%s\n      got  %r  (wanted something truthy)' % (name, got))


# --- building a tesseract TSV with real geometry ----------------------------------------------

HDR = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext'


def tsv(lines):
    """lines: [[(centre_x, token), ...], ...] -> a tesseract TSV string."""
    out = [HDR]
    for i, ln in enumerate(lines, 1):
        for j, (c, t) in enumerate(ln, 1):
            w = 100
            out.append('5\t1\t1\t1\t%d\t%d\t%d\t0\t%d\t40\t90\t%s' % (i, j, int(c - w / 2), w, t))
    return '\n'.join(out) + '\n'


# The real column ruler off page 41: STORET codes at 325 px spacing.
CODES = [(1501, '00010'), (1826, '00300'), (2150, '00077'), (2476, '00094'), (2798, '00400'),
         (3123, '00410'), (3449, '00610'), (3778, '00625'), (4101, '00630'), (4428, '00671')]
X_DATE, X_TIME_H, X_TIME_M, X_DEPTH = 839, 1034, 1128, 1259
X_TEMP, X_DO, X_TRANSP, X_COND, X_PH = 1552, 1892, 2219, 2556, 2848


def row(date, depth, temp=None, do=None, transp=None, cond=None, ph=None, time=('10', '50')):
    ln = []
    if date:
        ln.append((X_DATE, date))
    ln += [(X_TIME_H, time[0]), (X_TIME_M, time[1]), (X_DEPTH, depth)]
    for x, v in ((X_TEMP, temp), (X_DO, do), (X_TRANSP, transp), (X_COND, cond), (X_PH, ph)):
        if v is not None:
            ln.append((x, v))
    return ln


STATION_BLOCK = [
    [(1553, '76/04/27')],
    [(2945, '450701')],
    [(2850, '34'), (2947, '02'), (3076, '59.0'), (3221, '081'), (3340, '13'), (3467, '00.0')],
    [(2896, '45063')],
    [(3725, '030891')],                       # the HUC code: six digits, no coordinate after it
    [(2947, '1'), (3615, '2111202')],
    [(2912, '0183'), (3661, '00')],
    CODES,
]

PAGE41 = STATION_BLOCK + [
    row('73/07/09', '0000', temp='30.2', transp='108', cond='63', ph='8.30'),
    row(None, '0006', temp='30.1', do='79', cond='60', ph='7.70'),
    row(None, '6015', temp='29.8', do='8.0', cond='60'),          # depth OCR: 0015 -> 6015
    row(None, '0030', temp='2402', do='2.6', cond='63'),
    row(None, '0060', temp='19.3', do='3.2', cond='63'),
    row(None, '0090', temp='15.9', do='4.5'),
    row(None, '0120', temp='15.2', do='329', cond='63'),
    row(None, '0150', temp='14.8', do='326', cond='63'),
    row(None, '0178', temp='1464', do='2.7', cond='68'),
    row('73/09/22', '0000', temp='27.0', do='6.8', transp='102', cond='57', time=('10', '30')),
    row(None, '0025', temp='26.8', do='6.2', cond='55', time=('10', '30')),
    row(None, '0040', temp='261', do='1.2', cond='51', time=('10', '30')),
    row(None, '0060', temp='22.5', do='0', cond='56', time=('10', '30')),
    row(None, '0110', temp='19.5', do='0.1', cond='57', time=('10', '30')),
    row(None, '0140', temp='18.6', do='0.1', cond='72', time=('10', '30')),
    row(None, '0175', temp='17.6', do='0.1', cond='60', time=('10', '30')),
]

WORDS41 = '\n'.join([
    'APPENDIX D',
    'LAKE CODE 4507 LAKE MURRAY',
    'LAKE CODE 4507 LAKE MURRAY',
    'LAKE CODE 4590 LAKE MURRAY',              # the same code, misread once
    '450701',
    '34 02 59.0 081 13 00.0 3',
    'LAKE MURRAY',
    '45063 SOUTH CAROLINA',
    '0183 FEET DEPTH CLASS 00',
])

# --- 1. a value is as printed, or it is nothing -----------------------------------------------

for tok, want in [('9.6', 9.6), ('0.1', 0.1), ('10.0', 10.0), ('0.0', 0.0), ('19.9', 19.9)]:
    ok('one_decimal keeps the printed form %r' % tok, P.one_decimal(tok, *P.DO_RANGE), want)
ok('one_decimal keeps a printed water temperature', P.one_decimal('30.2', *P.TEMP_RANGE), 30.2)

for tok in ['79', '0', '329', '2402', '1464', '261', '12', '108', '', None, '7.90', '.9', '7.',
            'K', '0.200K']:
    ok('one_decimal refuses OCR damage %r' % tok, P.one_decimal(tok, *P.DO_RANGE), None)

ok('one_decimal refuses 25.0 mg/L oxygen', P.one_decimal('25.0', *P.DO_RANGE), None)
ok('one_decimal refuses 45.0 C water', P.one_decimal('45.0', *P.TEMP_RANGE), None)
ok('one_decimal keeps 39.9 C water', P.one_decimal('39.9', *P.TEMP_RANGE), 39.9)

# --- 2. the date ------------------------------------------------------------------------------

ok('read_date reads a good date', P.read_date('73/07/09'), '1973-07-09')
ok('read_date refuses month 63', P.read_date('73/63/26'), None)
ok('read_date refuses month 00', P.read_date('73/00/09'), None)
ok('read_date refuses day 32', P.read_date('73/07/32'), None)
ok('read_date refuses a depth', P.read_date('0178'), None)

# --- 3. the ruler -----------------------------------------------------------------------------

r = P.column_ruler(CODES)
truthy('column_ruler reads the parameter-code line', r)
have, spacing, left_edge = r
ok('ruler spacing is the median gap', round(spacing), 325)
ok('ruler puts temperature at its printed centre', have[P.TEMP_CODE], 1501)
ok('ruler puts oxygen at its printed centre', have[P.DO_CODE], 1826)
truthy('ruler left edge falls between the depth and the first column',
       X_DEPTH < left_edge < X_TEMP)

ok('no ruler from a data row', P.column_ruler(PAGE41[8]), None)
ok('no ruler from five codes', P.column_ruler(CODES[:5]), None)
ok('no ruler when temperature did not read', P.column_ruler([c for c in CODES
                                                             if c[1] != P.TEMP_CODE]), None)
ok('no ruler when oxygen did not read', P.column_ruler([c for c in CODES
                                                        if c[1] != P.DO_CODE]), None)

# --- 4. THE ONE THAT MATTERS: a blank cell shifts every token after it -------------------------

left, cells = P.assign(PAGE41[8], r)          # the July surface row
ok('the surface row leaves the oxygen column EMPTY', cells.get(P.DO_CODE), None)
ok('108 is a Secchi disc, and lands in 00077', cells.get('00077'), '108')
ok('the surface temperature still reads', cells.get(P.TEMP_CODE), '30.2')
ok('the date, the time and the depth are not measurements',
   [t for _c, t in left], ['73/07/09', '10', '50', '0000'])

left, cells = P.assign(PAGE41[9], r)          # the row below it, where 79 IS the oxygen
ok('one row down, the same position is the oxygen', cells.get(P.DO_CODE), '79')
ok('and that row has no Secchi', cells.get('00077'), None)

skew = [(1501, '11'), (1560, '22'), (X_DEPTH, '0000')]
_l, c2 = P.assign(skew, r)
ok('two numbers in one column is a skewed row, not a reading', c2.get(P.TEMP_CODE), None)

far = [(X_DEPTH, '0000'), ((1501 + 1826) / 2, '9.9')]
_l, c3 = P.assign(far, r)
ok('a number halfway between two columns belongs to neither', c3, {})

# --- 5. the page, end to end ------------------------------------------------------------------

name, code, appendix_d, meta = P.read_structure([(41, WORDS41)])
ok('the lake is named from the words pass', name, 'LAKE MURRAY')
ok('and carries the survey\'s own key', code, '4507')
ok('page 41 is Appendix D', 41 in appendix_d, True)
ok('the station carries its charted depth', meta['450701']['station_depth_ft'], 183)
ok('and its coordinate', (meta['450701']['lat'], meta['450701']['lon']), (34.04972, -81.21667))

st = P.read_rows([(41, tsv(PAGE41))], appendix_d, meta, 'test')
ok('one station on the page', sorted(st), ['450701'])
ok('the HUC code did not open a station', len(st), 1)
casts = st['450701']['casts']
ok('two casts', sorted(casts), ['1973-07-09', '1973-09-22'])

july = [(r2['depthFt'], r2.get('tempC'), r2.get('doMgL')) for r2 in casts['1973-07-09']['readings']]
ok('July, as printed', july, [
    (0, 30.2, None),      # oxygen blank on the page
    (6, 30.1, None),      # printed 7.9, OCR `79` -- damage, dropped
    (30, None, 2.6),      # printed 24.2, OCR `2402` -- damage, dropped
    (60, 19.3, 3.2),
    (90, 15.9, 4.5),
    (120, 15.2, None),    # printed 3.9, OCR `329`
    (150, 14.8, None),    # printed 3.6, OCR `326`
    (178, None, 2.7),     # printed 14.4, OCR `1464`
])
ok('the 15 ft row is gone with its depth', [d for d, _t, _o in july if d == 15], [])
ok('a depth of 6015 ft is refused, not stored', st['450701'].get('rejected_out_of_range'), 1)

sept = [(r2['depthFt'], r2.get('tempC'), r2.get('doMgL')) for r2 in casts['1973-09-22']['readings']]
ok('September, as printed', sept, [
    (0, 27.0, 6.8), (25, 26.8, 6.2), (40, None, 1.2),
    (60, 22.5, None),     # printed 1.1, OCR `0` -- 0.0 mg/L is anoxia nobody measured
    (110, 19.5, 0.1), (140, 18.6, 0.1), (175, 17.6, 0.1),
])
ok('no reading claims 0.0 mg/L', [d for d, _t, o in sept if o == 0.0], [])

# --- 6. the gates -----------------------------------------------------------------------------

ok('a page outside Appendix D is not read', P.read_rows([(41, tsv(PAGE41))], set(), meta, 't'), {})

wild = P.read_rows([(41, tsv(STATION_BLOCK + [row('73/07/09', '9040', temp='19.3', do='3.2')]))],
                   {41}, meta, 't')
ok('nothing in these lakes is 9,040 feet deep', wild['450701']['casts'], {})
ok('and the refusal is counted', wild['450701'].get('rejected_out_of_range'), 1)

# The station prints `0183 FEET DEPTH` and the boat sounded 178. Keowee 451302 prints 98 and its
# November cast reaches 160. The charted depth is where the station is, not how deep the cast went.
past = P.read_rows([(41, tsv(STATION_BLOCK + [row('73/07/09', '0006', temp='19.3', do='3.2'),
                                              row(None, '0100', temp='15.9', do='2.2'),
                                              row(None, '0200', temp='14.4', do='1.1')]))],
                   {41}, meta, 't')
ok('a cast deeper than the charted station depth is still a cast',
   [r2['depthFt'] for r2 in past['450701']['casts']['1973-07-09']['readings']], [6, 100, 200])
ok('and the charted depth is kept as what it is', past['450701']['station_depth_ft'], 183)

short = P.read_rows([(41, tsv(STATION_BLOCK + [row('73/07/09', '00312', temp='27.0', do='1.0')]))],
                    {41}, meta, 't')
ok('a five-digit depth is not a depth -- 0031 read as 00312', short['450701']['casts'], {})

# `11 00` merged into one token is four digits, exactly like a depth. The only thing that separates
# them is that a data row prints BOTH -- a time and then a depth.
merged = P.read_rows([(41, tsv(STATION_BLOCK
                               + [[(X_DATE, '73/07/09'), ((X_TIME_H + X_TIME_M) / 2, '1100'),
                                   (X_TEMP, '19.3'), (X_DO, '3.2')]]))], {41}, meta, 't')
ok('a row with a time and no depth is not a reading at 1,100 feet',
   merged['450701']['casts'], {})

# --- 6b. THE SECOND TABLE ON THE PAGE ---------------------------------------------------------
# Under `00665 32217` the same page prints total phosphorus and chlorophyll-a AT THE SAME
# x-positions as water temperature and dissolved oxygen. Robinson's September chlorophyll of
# 9.4 ug/L was being stored as 9.4 mg/L of oxygen at 0 ft on a lake that was 7.8 at the surface.
ok('a two-code line is a header', P.is_header([(1000, '00665'), (1400, '32217')]), True)
ok('a data row is not a header', P.is_header(PAGE41[8]), False)
ok('a lone station id is not a header', P.is_header([(2945, '450701')]), False)
ok('the parameter-code line is a header', P.is_header(CODES), True)
ok('and it is the one that yields a ruler', P.column_ruler([(1000, '00665'), (1400, '32217')]),
   None)

CHLORO = STATION_BLOCK + [
    row('73/09/21', '0000', temp='30.0', do='7.8'),
    row(None, '0015', temp='28.9', do='6.6'),
    row(None, '0030', temp='28.6', do='5.6'),
    [(1000, '00665'), (1400, '32217')],                # <- the second table starts here
    row('73/09/21', '0000', temp='0.020', do='17.3'),  # phosphorus and CHLOROPHYLL, not oxygen
    row(None, '0015', temp='0.014'),
]
sec = P.read_rows([(41, tsv(CHLORO))], {41}, meta, 't')
ok('the chlorophyll table is not read as oxygen',
   [(r2['depthFt'], r2.get('doMgL')) for r2 in sec['450701']['casts']['1973-09-21']['readings']],
   [(0, 7.8), (15, 6.6), (30, 5.6)])

# --- 6c. A DATE THAT DID NOT READ CLOSES THE CAST ---------------------------------------------
# Keowee 451302 prints 73/11/13 and it OCR'd as `73411713`. Keeping the previous date filed a
# November cast to 130 ft under 17 September, out of order and eight readings long.
TWO = STATION_BLOCK + [
    row('73/09/17', '0015', temp='25.5', do='6.0'),
    row(None, '0025', temp='22.9', do='4.4'),
    row(None, '0045', temp='20.5', do='3.8'),
    row('73411713', '0010', temp='15.9', do='8.8'),    # <- November, and the date did not read
    row(None, '0025', temp='15.8', do='8.8'),
    row(None, '0130', temp='8.3', do='3.9'),
]
sep = P.read_rows([(41, tsv(TWO))], {41}, meta, 't')
ok('only the cast whose date read survives', sorted(sep['450701']['casts']), ['1973-09-17'])
ok('and November did not land inside September',
   [r2['depthFt'] for r2 in sep['450701']['casts']['1973-09-17']['readings']], [15, 25, 45])

nodate = P.read_rows([(41, tsv(STATION_BLOCK + [row('73/63/26', '0030', temp='19.3', do='3.2')]))],
                     {41}, meta, 't')
ok('a row whose date did not read is not filed under the wrong day',
   nodate['450701']['casts'], {})

noruler = P.read_rows([(41, tsv([b for b in STATION_BLOCK if b is not CODES]
                                + [row('73/07/09', '0030', temp='19.3', do='3.2')]))],
                      {41}, meta, 't')
ok('with no parameter-code header the page is not read', noruler['450701']['casts'], {})

# --- 7. a cast is a column, not a couple of points --------------------------------------------

ok('a cast with two oxygen readings is not a profile',
   P.keep_cast({'readings': [{'depthFt': 0, 'doMgL': 8.0}, {'depthFt': 40, 'doMgL': 1.0}]})[0],
   False)
ok('depths out of order mean the rows did not read',
   P.keep_cast({'readings': [{'depthFt': 0, 'doMgL': 8.0}, {'depthFt': 40, 'doMgL': 1.0},
                             {'depthFt': 20, 'doMgL': 2.0}]})[0], False)
ok('a cast spanning 6 ft is a grab',
   P.keep_cast({'readings': [{'depthFt': 0, 'doMgL': 8.0}, {'depthFt': 3, 'doMgL': 7.0},
                             {'depthFt': 6, 'doMgL': 6.0}]})[0], False)
ok('July survives as a profile', P.keep_cast(casts['1973-07-09'])[0], True)
ok('September survives as a profile', P.keep_cast(casts['1973-09-22'])[0], True)

# --- 8. THE CALL, AND THE QUIET CALL ----------------------------------------------------------

d = tempfile.mkdtemp()
open(os.path.join(d, '9100D9LY.300.041.txt'), 'w').write(WORDS41)
open(os.path.join(d, '9100D9LY.500.041.tsv'), 'w').write(tsv(PAGE41))
got = P.load(d)
ok('load pairs the words page and the digits page', sorted(got['9100D9LY']['words']), [41])
ok('and finds the tsv', sorted(got['9100D9LY']['tsv']), [41])
ok('the loud call runs', P.main(['--pages', d]), 0)

quiet = tempfile.mkdtemp()
open(os.path.join(quiet, '9100D9LY.300.041.txt'), 'w').write(WORDS41)
ok('a paper whose digits pass never ran does not crash', P.main(['--pages', quiet]), 0)

empty = tempfile.mkdtemp()
try:
    P.main(['--pages', empty])
    FAIL.append('an empty directory should stop, not write nothing quietly')
except SystemExit:
    pass

reg = tempfile.mkdtemp()
ok('--go writes', P.main(['--pages', d, '--registry', reg, '--go']), 0)
out = os.path.join(reg, P.OUT_NAME)
truthy('the registry file exists', os.path.exists(out))
import json
w = json.load(open(out))
ok('the year travels with the numbers', '1973' in w['_note'], True)
ok('the file names its lake', w['papers']['9100D9LY']['lake_as_printed'], 'LAKE MURRAY')
ok('and keys it the way the survey does', w['papers']['9100D9LY']['storet_lake_code'], '4507')
ok('no thermocline is derived here', w['derivation'].startswith('none here'), True)

# ----------------------------------------------------------------------------------------------

if FAIL:
    print('%d FAILED' % len(FAIL))
    for f in FAIL:
        print('  x ' + f)
    sys.exit(1)
print('all checks passed')
