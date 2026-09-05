#!/usr/bin/env python3
r"""build_document_limnology.py -- the casts we hold, in the shape the profile stores.

    py .\scripts\build_document_limnology.py --registry "F:\TrollMapPipeline\registry"
    py .\scripts\build_document_limnology.py --registry "F:\TrollMapPipeline\registry" --go

WHY THIS EXISTS. Three files hold vertical profiles and NOT ONE OF THEM IS READ:

    registry/nla_limnology.json        137 waters, EPA National Lakes Assessment 2007/2012/2022
    registry/nes_limnology.json          6 waters, EPA National Eutrophication Survey 1973
    registry/lake_program_limnology.json 3 statements, SC DES lake nutrient studies

`fetch_nla_limnology.py` has written the first since 2026-09-04 and `upload_garmin_to_r2.py` has
shipped it to R2 since the same day. `audit_limnology_gaps.py` opens it to COUNT what it would
fix. Nothing serves it. Measured today by that audit: **thirteen waters** carry a measured
thermocline or anoxic depth in these files while their stored profile carries null.

Seventh file to learn this lesson, and the reason is always the same: parsed correctly,
addressed to nobody. So this collapses the three into ONE object keyed by registry slug, in the
field names `js/utils/wqp-limnology.js` already writes, and `upload_garmin_to_r2.py` ships it as
`_registry/document_limnology.json` for `Worker/registry.js` to load like the eight before it.

THE RULES ARE THE APP'S RULES, NOT NEW ONES.

**Summer is June through September.** `SUMMER = (6, 9)` in derive_nes_limnology.py and
`r.month >= 6 && r.month <= 9` in the Worker's WQP derivation. Same window here.

**A thermocline shallower than 6 ft is not offered.** The Worker's temperature-gradient branch
already refuses one: `maxBin >= 6`. Lake Russell (Habersham Co, GA) offers 1.8 ft from a 9/7/2022
cast, and shipping a number the app would have thrown out from its own primary source is how two
rules become two answers. The refusal is recorded, not silently dropped.

**Several casts collapse by MEDIAN, never by mean.** The Worker medians every 2-ft depth bin
before walking it, so the median is this codebase's operator for repeated measurements of the
same thing. Where the count is even the deeper of the two middle casts is taken, so the stored
number is one somebody actually measured rather than the average of two that nobody did. Every
cast that went in is named in the note, with its date, so a 17 ft June and a 60 ft September do
not vanish into one number with no history -- Lake Keowee's 1973 survey is exactly that pair.

**An undated cast is used and SAID TO BE UNDATED.** The NLA 2007 rows publish no sample date;
the survey's own index period is summer. Four of the thirteen waters are 2007 rows, so refusing
them costs nearly a third of the yield to a field the EPA did not print. The note says the date
was not published rather than implying one.

WHAT IT WILL NOT WRITE.

The SC DES lake-program statements are collapsed here but **offered to nothing**. The 2021 and
2022 Lake Murray reports state a boundary below 3-4 m -- at S-326, in the Clouds Creek arm, whose
average total depth the same report prints as 5.1 m, in a lake our chart takes to 192 ft. The
depth is real, the station is real, and writing 9.8 ft into `lake_murray` as the lake's oxygen
boundary is the Lake Wateree 27 ft fabrication with better paperwork. Physics does not settle it
-- the boundary sits inside that station's water column, so a bottom check passes it -- and
whether an arm may speak for a lake is a fishing judgment, not a threshold. They are written with
`offered: false` and the two numbers that make the case, and a person decides.

Personal use only, not for distribution or resale; not for navigation.
"""
from __future__ import annotations
import argparse
import json
import os
import statistics
import sys

OUT_NAME = 'document_limnology.json'
SUMMER = (6, 9)                 # the window derive_nes_limnology.py and the Worker both use
MIN_THERMOCLINE_FT = 6.0        # the Worker's own floor: `maxBin >= 6`

SOURCES = [
    ('nla_limnology.json', 'EPA National Lakes Assessment'),
    ('nes_limnology.json', 'EPA National Eutrophication Survey, 1973'),
]


def month_of(visit):
    """The month this cast was taken, or None where the survey published no date."""
    d = str(visit.get('date') or '').strip()
    if not d:
        return None
    for sep in ('/', '-'):
        if sep in d:
            p = d.split(sep)
            try:
                return int(p[1]) if sep == '-' else int(p[0])
            except (ValueError, IndexError):
                return None
    return None


def in_window(visit):
    """(usable, why). An undated cast is usable and says so; a winter cast is not."""
    m = month_of(visit)
    if m is None:
        return True, 'the survey published no sample date'
    return (SUMMER[0] <= m <= SUMMER[1]), None


def when(visit):
    return str(visit.get('date') or '').strip() or str(visit.get('year') or '?')


def collapse(values):
    """The median, and never a number nobody measured.

    statistics.median averages the two middle values when the count is even, which invents a
    reading. median_high returns one of them. Where two casts disagree the deeper is taken --
    it is the one that saw a fully developed summer water column rather than one still forming.
    """
    return statistics.median_high(sorted(values))


def gather(waters, field, label):
    """Every summer cast that offers `field`, collapsed. Returns (value, note, refusals)."""
    taken, refused = [], []
    for src, visit in waters:
        v = visit.get(field)
        if v is None:
            continue
        ok, undated = in_window(visit)
        if not ok:
            refused.append('%s %s is outside June-September' % (src, when(visit)))
            continue
        if field == 'thermoclineFt' and v < MIN_THERMOCLINE_FT:
            refused.append('%s %s derived %.1f ft, under the %.0f ft floor the app applies to '
                           'its own WQP derivation' % (src, when(visit), v, MIN_THERMOCLINE_FT))
            continue
        taken.append((v, '%s %s%s' % (src, when(visit), ' (%s)' % undated if undated else '')))
    if not taken:
        return None, None, refused
    value = collapse([t[0] for t in taken])
    if len(taken) == 1:
        note = '%s, %s' % (label, taken[0][1])
    else:
        note = ('%s -- the median of %d summer casts: %s'
                % (label, len(taken), '; '.join('%.1f ft %s' % t for t in sorted(taken))))
    return value, note, refused


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', default=os.environ.get('TROLLMAP_REGISTRY',
                                                         r'F:\TrollMapPipeline\registry'))
    ap.add_argument('--go', action='store_true', help='write the registry file')
    a = ap.parse_args(argv)

    by_slug = {}
    seen = []
    for fname, label in SOURCES:
        fp = os.path.join(a.registry, fname)
        if not os.path.exists(fp):
            print('!! %s not found -- nothing from %s' % (fname, label))
            continue
        doc = json.load(open(fp, encoding='utf-8'))
        w = doc.get('waters') or {}
        seen.append('%s (%d waters)' % (fname, len(w)))
        for slug, rec in w.items():
            for visit in (rec.get('visits') or []):
                by_slug.setdefault(slug, []).append((label.split(',')[0], visit))
    if not by_slug:
        raise SystemExit('no cast in any source file -- run fetch_nla_limnology.py --go')
    print('read %s' % ', '.join(seen))

    rows, offered = {}, 0
    for slug, waters in sorted(by_slug.items()):
        th, thn, th_ref = gather(waters, 'thermoclineFt', 'measured vertical profile')
        an, ann, an_ref = gather(waters, 'anoxicBelowFt', 'measured vertical profile')
        de, den, de_ref = gather(waters, 'depletionDepthFt', 'measured vertical profile')
        if th is None and an is None and de is None:
            continue
        srcs = sorted({s for s, _ in waters})
        rows[slug] = {
            'slug': slug,
            'thermoclineFt': th, 'thermoclineNote': thn,
            'anoxicBelowFt': an, 'anoxicNote': ann,
            'depletionDepthFt': de, 'depletionNote': den,
            'castCount': len(waters),
            'sources': srcs,
            'refused': sorted(set(th_ref + an_ref + de_ref)) or None,
            'offered': True,
        }
        offered += 1

    # THE LAKE-PROGRAM STATEMENTS RIDE ALONG AND ARE OFFERED TO NOTHING. See the module docstring.
    lp_fp = os.path.join(a.registry, 'lake_program_limnology.json')
    held = {}
    if os.path.exists(lp_fp):
        lp = json.load(open(lp_fp, encoding='utf-8'))
        for fname, rep in (lp.get('reports') or {}).items():
            for f in (rep.get('depth_statements') or []):
                if not f.get('slug'):
                    continue
                held.setdefault(f['slug'], []).append({
                    'depth_ft_low': f['depth_ft_low'], 'depth_ft_high': f['depth_ft_high'],
                    'as_printed': f['as_printed'], 'station': f.get('station'),
                    'station_bottom_ft': f.get('station_bottom_ft'),
                    'charted_max_ft': f.get('charted_max_ft'),
                    'reach': f.get('reach'), 'months_named': f.get('months_named'),
                    'report': fname, 'page': f.get('page'), 'quote': f.get('quote'),
                    'offered': False,
                    'held_because': 'a document statement is not written into a profile until a '
                                    'person has said the station may speak for the water',
                })
    for slug, sts in held.items():
        rows.setdefault(slug, {'slug': slug, 'thermoclineFt': None, 'thermoclineNote': None,
                               'anoxicBelowFt': None, 'anoxicNote': None,
                               'depletionDepthFt': None, 'depletionNote': None,
                               'castCount': 0, 'sources': [], 'refused': None, 'offered': False})
        rows[slug]['statedInProse'] = sts

    n_th = sum(1 for r in rows.values() if r['thermoclineFt'] is not None)
    n_ox = sum(1 for r in rows.values() if r['anoxicBelowFt'] is not None
               or r['depletionDepthFt'] is not None)
    n_ref = sum(1 for r in rows.values() if r.get('refused'))
    print('%d water(s) offer something: %d a thermocline, %d an oxygen depth. '
          '%d carry a refusal.' % (offered, n_th, n_ox, n_ref))
    print('%d water(s) hold a prose statement offered to nothing.' % len(held))
    print()
    for slug, r in sorted(rows.items()):
        if r.get('refused'):
            print('   %-34s REFUSED %s' % (slug, '; '.join(r['refused'])[:110]))
    for slug, sts in sorted(held.items()):
        for s in sts:
            print('   %-34s HELD    %.1f-%.1f ft at %s -- %s'
                  % (slug, s['depth_ft_low'], s['depth_ft_high'], s['station'] or '?',
                     s['reach'] or 'no bottom printed'))

    if not a.go:
        print()
        print('dry run. Re-run with --go to write %s'
              % os.path.join(a.registry, OUT_NAME))
        return 0

    doc = {'_note': 'Vertical-profile limnology from documents, collapsed to the fields '
                    'js/utils/wqp-limnology.js stores. Read by Worker/registry.js as '
                    '_registry/document_limnology.json and merged into a profile ONLY where the '
                    'Water Quality Portal left the field null -- a measurement from the water '
                    'itself outranks a compilation. Summer is June-September, the window the '
                    'Worker already uses. A thermocline under 6 ft is refused, the floor the '
                    'Worker applies to its own derivation. Several casts collapse by median and '
                    'never by mean, and every cast is named in the note. Entries with '
                    '"offered": false are NOT to be written into a profile. '
                    'Personal use only, not for distribution or resale; not for navigation.',
           'sources': [s for _, s in SOURCES] + ['SC DES lake nutrient studies (held, not offered)'],
           'derivation': 'Scripts/fetch_nla_limnology.py -- thermocline_from(), oxygen_from()',
           'generated': __import__('datetime').date.today().isoformat(),
           'water_count': len(rows),
           'waters': rows}
    fp = os.path.join(a.registry, OUT_NAME)
    with open(fp, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write('\n')
    print('-> %s  (%.0f KB)' % (fp, os.path.getsize(fp) / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
