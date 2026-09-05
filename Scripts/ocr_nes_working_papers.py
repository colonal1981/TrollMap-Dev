#!/usr/bin/env python3
r"""ocr_nes_working_papers.py -- the two scans parse_nes_working_papers.py reads.

    python3 scripts/ocr_nes_working_papers.py --pdfs _derived/nes_pdfs --out _derived/nes_ocr
    python3 scripts/ocr_nes_working_papers.py --pdfs . --out _derived/nes_ocr --jobs 3

WHY TWO PASSES. The 1973 National Eutrophication Survey pages carry a heading in words and a
table in digits, and no single tesseract call reads both. A numeric whitelist is the difference
between `3001` and `30.1` -- and it erases every word on the page, so the first attempt parsed
the table beautifully and came back with a lake called `?`.

    pass A   300 dpi, plain          <doc>.300.<page>.txt   Appendix D vs E, the lake's name and
                                                            STORET code, `0183 FEET DEPTH`
    pass B   500 dpi, digits, TSV    <doc>.500.<page>.tsv   the rows, with word boxes
    pass C   300 dpi, digits, TSV    <doc>.300.<page>.tsv   the same rows, read again

PASS C EXISTS BECAUSE ONE SCAN CANNOT CHECK ITSELF. Lake Robinson, 6 July 1973: the page prints
`0015  31.5  6.6` and pass B read the oxygen as `626`, the numeric whitelist eating the decimal
point it was added to protect. Pass C read it correctly. On the row below, the page prints `0031`
and pass B read `00312` while pass C read `0032` -- neither right, and the row is dropped because
they disagree about WHICH ROW IT IS. See merge_passes() in parse_nes_working_papers.py.

Pass B is TSV because the COLUMN IS A POSITION ON THE PAGE. A surface row often has a blank
oxygen cell and the next number printed is the Secchi disc in inches; counting tokens files a
nine-foot Secchi as 108 mg/L of oxygen. Only the x-coordinate tells them apart, so the digits
pass has to carry geometry and a plain text dump cannot.

Pass B runs over the BACK HALF of each document only. Appendix D is the last thing in these
papers -- measured across the seven South Carolina ones, its station blocks start between page
31 and page 40 of 40 to 73 -- and 500 dpi is roughly ten seconds a page.

WHAT THIS NEEDS: `pdftoppm` (poppler) and `tesseract` on PATH. Both are checked before any work
starts, because finding out on page 60 is worse than finding out on page 0.

Personal use only, not for distribution or resale; not for navigation.
"""
from __future__ import annotations
import argparse
import concurrent.futures
import glob
import os
import shutil
import subprocess
import sys
import tempfile

WORDS_DPI = 300
DIGITS_DPI = 500
WHITELIST = '0123456789./K '     # K is STORET's "less than the detection limit" remark code

# THE FRONT OF THE PAPER IS A SECOND TABLE AND IT WAS ONLY EVER READ ONCE.
#
# Appendix D is at the back and gets all three passes. The front carries two things nothing has
# ever parsed: a numbered morphometry block on paper page 3-4 -- surface area, mean depth,
# MAXIMUM depth, volume, hydraulic retention time -- and the LAKE WATER QUALITY SUMMARY table on
# page 5, three visits wide, with the dissolved-oxygen minimum, Secchi, chlorophyll-a and total
# phosphorus. That is the only source that will ever speak for Fishing Creek Reservoir, whose
# Appendix D yielded zero usable casts.
#
# It had exactly one 300 dpi words pass, and one scan cannot check itself. Fishing Creek's oxygen
# row reads `7.6 0° He2 708 728` at 300 dpi. And the morphometry is the reason the second WORDS
# pass is here rather than digits alone: `Maximum depth: 27.3 meters` sits beside a Garmin chart
# that bottoms at 39 ft and a stated deepest cast of 11.0 m, so whether that reads 27.3 or 12.3
# is a question two scans can answer and one cannot.
FRONT_PAGES = range(8, 19)


def need(tool):
    if shutil.which(tool):
        return None
    return tool


def page_count(pdf):
    out = subprocess.run(['pdfinfo', pdf], capture_output=True, text=True)
    for line in out.stdout.split('\n'):
        if line.startswith('Pages:'):
            return int(line.split()[1])
    raise SystemExit('pdfinfo could not count the pages of %s' % pdf)


def render(pdf, page, dpi, stem):
    subprocess.run(['pdftoppm', '-r', str(dpi), '-gray', '-f', str(page), '-l', str(page),
                    '-png', pdf, stem], capture_output=True)
    got = sorted(glob.glob(stem + '*.png'))
    return got[0] if got else None


def one(pdf, page, dpi, out_dir, digits):
    base = os.path.splitext(os.path.basename(pdf))[0]
    out = os.path.join(out_dir, '%s.%d.%03d.%s' % (base, dpi, page, 'tsv' if digits else 'txt'))
    if os.path.exists(out) and os.path.getsize(out) > 0:
        return out, True
    tmp = tempfile.mkdtemp()
    try:
        png = render(pdf, page, dpi, os.path.join(tmp, 'p'))
        if not png:
            return None, False
        cmd = ['tesseract', png, out[:-4], '--psm', '6']
        if digits:
            cmd += ['-c', 'tessedit_char_whitelist=' + WHITELIST, 'tsv']
        else:
            cmd += ['txt']
        subprocess.run(cmd, capture_output=True)
        return (out, False) if os.path.exists(out) else (None, False)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--pdfs', required=True, help='directory of NES working-paper PDFs')
    ap.add_argument('--out', required=True, help='where the .txt and .tsv pages go')
    ap.add_argument('--jobs', type=int, default=3)
    ap.add_argument('--glob', default='9*.pdf', help='which PDFs in --pdfs are working papers')
    a = ap.parse_args(argv)

    missing = [t for t in ('pdftoppm', 'pdfinfo', 'tesseract') if need(t)]
    if missing:
        raise SystemExit('not on PATH: %s. poppler-utils supplies pdftoppm and pdfinfo; '
                         'tesseract-ocr supplies tesseract.' % ', '.join(missing))

    pdfs = sorted(glob.glob(os.path.join(a.pdfs, a.glob)))
    if not pdfs:
        raise SystemExit('no %s under %s' % (a.glob, a.pdfs))
    os.makedirs(a.out, exist_ok=True)

    for pdf in pdfs:
        n = page_count(pdf)
        back = range(max(1, n // 2), n + 1)
        front = [p for p in FRONT_PAGES if p <= n]
        tables = sorted(set(back) | set(front))          # both halves carry a table
        jobs = ([(pdf, p, WORDS_DPI, a.out, False) for p in range(1, n + 1)]
                + [(pdf, p, DIGITS_DPI, a.out, True) for p in tables]
                + [(pdf, p, WORDS_DPI, a.out, True) for p in tables]
                # The second WORDS read, front only: the morphometry block is prose AND numbers,
                # and the digits whitelist erases every word on the page.
                + [(pdf, p, DIGITS_DPI, a.out, False) for p in front])
        made = skipped = failed = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=a.jobs) as pool:
            for got, cached in pool.map(lambda j: one(*j), jobs):
                if got is None:
                    failed += 1
                elif cached:
                    skipped += 1
                else:
                    made += 1
        print('   %-30s %2d pages -> %3d written, %3d already there, %d failed'
              % (os.path.basename(pdf), n, made, skipped, failed))
    print()
    print('-> %s   (%d files)' % (a.out, len(os.listdir(a.out))))
    return 0


if __name__ == '__main__':
    sys.exit(main())
