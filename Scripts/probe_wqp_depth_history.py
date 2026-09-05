#!/usr/bin/env python3
r"""probe_wqp_depth_history.py -- what the 2015 cut-off is hiding, water by water.

    py .\scripts\probe_wqp_depth_history.py --registry "F:\TrollMapPipeline\registry"
    py .\scripts\probe_wqp_depth_history.py --registry "F:\TrollMapPipeline\registry" --only lake_moultrie,lake_murray
    py .\scripts\probe_wqp_depth_history.py --registry "F:\TrollMapPipeline\registry" --jobs 4
    py .\scripts\probe_wqp_depth_history.py --registry "F:\TrollMapPipeline\registry" --resume

WHAT THIS ANSWERS, AND WHY IT IS NOT THE WORKER'S JOB.

`Worker/research/limnology.js` asks WQP with `startDateLo=01-01-2015`. On 2026-09-05 that window
was found to be hiding real vertical profiles:

    21SCSANT-SC-027  Lake Moultrie NW quadrant   280 DO rows 1983-1987, every one depth-tagged, 1-19 ft
    21SCSANT-SC-030  Lake Moultrie CM 17         150 DO rows 2000-2004, every one depth-tagged, 1-46 ft

Santee Cooper's profiling era is under the LEGACY organisation `21SCSANT` and is largely
pre-2015; the modern `21SCSANT_WQX` records are one grab at 0.3 m per visit. The profile said
"surface/grab samples only" and that was true of the window, not of the lake. A ceiling measured
under a ceiling.

Norris Lake is the other result: 1990-2014, zero depth-bearing rows, organisations TDEC only and
TVA absent from WQP entirely. So the TN reservoirs are a different errand from the SC ones, and
this script is how we tell which is which without guessing.

THIS SCRIPT MEASURES THE INPUTS. IT DOES NOT DERIVE A THERMOCLINE. The rule lives in
`Worker/research/limnology.js` -- summer is months 6-9, depths bin at 2 ft, and the thermocline
is the first bin whose median dissolved oxygen falls under 4 mg/L, needing at least three summer
DO records that carry a depth. A second copy of that in Python is how two readers of one feed
start disagreeing, which this project has paid for more than once. So the report gives the
NUMBERS THE RULE CONSUMES and stops there:

    summer_do_depth_recs   the count the rule needs >= 3 of
    distinct_2ft_bins      how many rungs the ladder actually has
    hidden_*               the same counts restricted to records the 2015 window EXCLUDES

A water whose `hidden_summer_do_depth_recs` is 0 is not being hurt by the cut-off, whatever else
is wrong with it. A water with 3 or more is a thermocline we already own and have never asked for.

The depth unit rule is copied from the Worker deliberately and is the only duplicated logic here,
because it is two lines and getting it wrong turns 10 m into 10 ft: a unit containing `m` and not
`ft` is metres, times 3.28084, rounded to a tenth.

TWO SERVICES, TWO COLUMN DIALECTS, AND ONE OF THEM IS MISSING TWO YEARS.

waterqualitydata.us says outright: *"This user interface only serves WQX2.2 profiles, which do
NOT contain USGS data added after March 11, 2024."* The 3.0 profiles live at `/wqx3/` and rename
every column -- `ActivityDepthHeightMeasure/MeasureValue` becomes `Activity_DepthHeightMeasure`,
`CharacteristicName` becomes `Result_Characteristic`. The Worker looks its columns up by
case-insensitive SUBSTRING, so a 3.0 response would parse as zero usable records without
erroring: the same silent shape as `programs`, which was an empty array for weeks because it
searched for `projectname` in a profile whose column is `ProjectIdentifier`.

So this probe asks BOTH and reports both. A water where they disagree is a water whose recent
history we have never seen. `--api` picks one if you want only one.

A PARTIAL RUN MUST NOT WRITE A WHOLE FILE. Each water is appended to the output as it finishes
and the document says how many of how many are done, so a run that dies is resumable with
--resume rather than starting over. Nothing here needs or touches a credential.
"""
from __future__ import annotations
import argparse
import csv
import io
import json
import os
import sys
import time
import zipfile
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

OUT_NAME = '_wqp_depth_history.json'
WINDOW_START = '2015-01-01'          # what Worker/research/limnology.js asks for today
SUMMER = (6, 7, 8, 9)                # months 6-9, same as the Worker
CHARS = ['Temperature, water', 'Dissolved oxygen (DO)', 'Dissolved oxygen']
UA = 'TrollMap/1.0 (personal fishing project; depth-history probe)'

# WQP REPORTS A CUT STREAM INSIDE THE BODY, NOT IN THE STATUS LINE.
# 2026-09-05, the 3.0 service returned Lake Robinson as one row followed by
#   ERROR: INCOMPLETE DATA - THE RESULTS FOR THIS REQUEST ARE NOT COMPLETE AND MORE DATA IS
#   LIKELY AVAILABLE.  PLEASE RETRY THE REQUEST.
# The census read that as a data row and stored the error text as an ORGANISATION -- so the file
# said Lake Robinson is monitored by a sentence. A partial answer wearing a success stamp is the
# same lie as a partial run writing a whole file, and the service itself says what to do about it.
TRUNCATED = 'PLEASE RETRY THE REQUEST'

# Worker/research/limnology.js needs three summer dissolved-oxygen records carrying a depth before
# it will derive anything. Not a tuning knob -- it is the rule's own minimum, and it is what makes
# "already answered" mean something here.
RULE_NEEDS = 3


# One census, two dialects. First name that exists in the header wins.
COLUMNS = {
    'date':       ('ActivityStartDate', 'Activity_StartDate'),
    'org':        ('OrganizationIdentifier', 'Org_Identifier'),
    'char':       ('CharacteristicName', 'Result_Characteristic'),
    'value':      ('ResultMeasureValue', 'Result_Measure'),
    'depth':      ('ActivityDepthHeightMeasure/MeasureValue', 'Activity_DepthHeightMeasure'),
    'depth_unit': ('ActivityDepthHeightMeasure/MeasureUnitCode', 'Activity_DepthHeightMeasureUnit'),
    'rdepth':     ('ResultDepthHeightMeasure/MeasureValue', 'ResultDepthHeight_Measure'),
    'rdepth_unit': ('ResultDepthHeightMeasure/MeasureUnitCode', 'ResultDepthHeight_MeasureUnit'),
    'station':    ('MonitoringLocationIdentifier', 'Location_Identifier'),
}

APIS = {
    # (base, dataProfile). 2.2 is what the Worker asks today; 3.0 is where USGS data added after
    # 2024-03-11 lives, and nothing in this project has ever read it.
    'legacy': ('https://www.waterqualitydata.us/data/Result/search', 'resultPhysChem'),
    'wqx3':   ('https://www.waterqualitydata.us/wqx3/Result/search', 'basicPhysChem'),
}


def wqp_url(bbox, api):
    base, profile = APIS[api]
    w, s, e, n = bbox
    parts = ['bBox=%s,%s,%s,%s' % (w, s, e, n)]
    parts += ['characteristicName=' + urllib.parse.quote(c) for c in CHARS]
    # NO startDateLo. That omission is the entire point of this script.
    parts += ['mimeType=csv', 'zip=yes', 'dataProfile=' + profile,
              'providers=NWIS', 'providers=STORET']
    return base + '?' + '&'.join(parts)


def pick(row, key):
    for name in COLUMNS[key]:
        if name in row:
            return row.get(name)
    return None


def fetch(url, timeout=300, tries=3):
    """ASK FOR THE ZIP. These are full-history pulls with no date bound -- Lake Moultrie alone
    carries 5,227 records inside the 2015 window and we are asking for everything back to 1983.
    `zip=yes` returns the same CSV inside a ZIP; a water-quality CSV is highly repetitive text
    and compresses to a small fraction of the wire size, which is the difference between an
    afternoon and an overnight run over 64 lakes. The body is unpacked here so the census never
    knows the difference."""
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA,
                                                       'Accept': 'application/zip, text/csv'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
            if raw[:2] == b'PK':
                with zipfile.ZipFile(io.BytesIO(raw)) as z:
                    names = [n for n in z.namelist() if n.lower().endswith('.csv')] or z.namelist()
                    if not names:
                        return '', None               # an empty archive is an empty answer
                    raw = z.read(names[0])
            text = raw.decode('utf-8', 'replace')
            if TRUNCATED in text.upper():
                last = 'WQP returned an incomplete stream and asked to be retried'
                if i < tries - 1:
                    time.sleep(4 * (i + 1))
                    continue
                return None, last
            return text, None
        except Exception as exc:                      # noqa: BLE001 -- report, do not classify
            last = '%s: %s' % (type(exc).__name__, exc)
            if i < tries - 1:
                time.sleep(4 * (i + 1))
    return None, last


def depth_ft(raw, unit):
    """The Worker's rule, two lines, copied on purpose. `m` and not `ft` means metres."""
    try:
        d = float(raw)
    except (TypeError, ValueError):
        return None
    if d < 0:
        return None
    u = (unit or '').lower()
    if 'm' in u and 'ft' not in u:
        d = d * 3.28084
    return round(d * 10) / 10


def census(csv_text):
    """Every number the Worker's thermocline rule consumes, and the same again for the records
    the 2015 window would refuse."""
    # WHAT THE DEEPEST READING ACTUALLY IS. A bBox is a rectangle, not a lake. Lake Moultrie's
    # probe reported a maximum of 100.0 ft against a Garmin chart whose deepest band is 69-70 ft
    # over 11,488 polygons -- so either the chart misses the Pinopolis forebay or the rectangle
    # caught a station that is not the lake, and a groundwater well reads in feet like anything
    # else. `USGS-SC` is in that water's organisation list beside Santee Cooper. A number that
    # cannot be traced to a station is an arbitrary number, and this project has a rule about
    # those, so the deepest record now carries its station and date out with it.
    out = {'deepest': None,
           'rows': 0, 'depth_recs': 0, 'summer_do_depth_recs': 0, 'distinct_2ft_bins': 0,
           'min_depth_ft': None, 'max_depth_ft': None, 'first_date': None, 'last_date': None,
           'organizations': [], 'hidden_depth_recs': 0, 'hidden_summer_do_depth_recs': 0,
           'hidden_max_depth_ft': None, 'hidden_first_date': None, 'hidden_last_date': None,
           'hidden_organizations': []}
    if not csv_text or '\n' not in csv_text:
        return out
    rd = csv.DictReader(io.StringIO(csv_text))
    bins, orgs, hidden_orgs = set(), set(), set()
    for row in rd:
        out['rows'] += 1
        date = (pick(row, 'date') or '').strip()
        if date:
            if not out['first_date'] or date < out['first_date']:
                out['first_date'] = date
            if not out['last_date'] or date > out['last_date']:
                out['last_date'] = date
        org = (pick(row, 'org') or '').strip()
        if org:
            orgs.add(org)
        d = depth_ft(pick(row, 'depth'), pick(row, 'depth_unit'))
        if d is None:
            d = depth_ft(pick(row, 'rdepth'), pick(row, 'rdepth_unit'))
        if d is None:
            continue
        try:
            float(pick(row, 'value') or '')
        except ValueError:
            continue                                  # a depth on a row with no reading is not a reading
        out['depth_recs'] += 1
        out['min_depth_ft'] = d if out['min_depth_ft'] is None else min(out['min_depth_ft'], d)
        char = (pick(row, 'char') or '').lower()
        if out['max_depth_ft'] is None or d > out['max_depth_ft']:
            out['max_depth_ft'] = d
            out['deepest'] = {'depthFt': d, 'station': (pick(row, 'station') or '').strip(),
                              'date': date, 'characteristic': (pick(row, 'char') or '').strip(),
                              'organization': org}
        is_do = 'oxygen' in char
        month = int(date[5:7]) if len(date) >= 7 and date[5:7].isdigit() else None
        is_summer_do = is_do and month in SUMMER
        if is_summer_do:
            out['summer_do_depth_recs'] += 1
            bins.add(int(d // 2) * 2)
        if date and date < WINDOW_START:
            out['hidden_depth_recs'] += 1
            out['hidden_max_depth_ft'] = d if out['hidden_max_depth_ft'] is None \
                else max(out['hidden_max_depth_ft'], d)
            if org:
                hidden_orgs.add(org)
            if not out['hidden_first_date'] or date < out['hidden_first_date']:
                out['hidden_first_date'] = date
            if not out['hidden_last_date'] or date > out['hidden_last_date']:
                out['hidden_last_date'] = date
            if is_summer_do:
                out['hidden_summer_do_depth_recs'] += 1
    out['distinct_2ft_bins'] = len(bins)
    out['organizations'] = sorted(orgs)
    out['hidden_organizations'] = sorted(hidden_orgs)
    return out


def answered(rec, apis=None):
    """A water is done when EVERY SERVICE IT WAS ASKED OF came back.

    One rule, used by both --resume and the completeness stamp, because two copies of "is this
    water finished" is how a run reports complete over a hole.

    HALF AN ANSWER TO A TWO-PART QUESTION IS NOT AN ANSWER. 2026-09-05, on the both-dialect
    census: the 3.0 service returned HTTP 500 on Lake Marion, Thurmond and Hartwell while 2.2
    answered. `best` took the 2.2 leg, so no top-level error was written, `done` counted them and
    --resume would have skipped them for good -- leaving the three biggest lakes in the census
    legacy-only, which is the exact question the run was started to settle. And an older file
    written under `--api legacy` has no 3.0 leg at all; asked for both, those waters are not done
    either, whatever the old run thought.
    """
    if 'error' in rec:
        return False
    by = rec.get('by_api') or {}
    for api in (apis or by.keys()):
        got = by.get(api)
        if not isinstance(got, dict) or 'error' in got:
            return False
    return True


def load_done(fp, apis=None):
    """Only the waters that ACTUALLY ANSWERED. A row carrying an error is not done -- --resume
    must retry it, or one bad afternoon at WQP becomes a permanent hole in the census."""
    if not os.path.exists(fp):
        return {}
    try:
        got = (json.load(open(fp, encoding='utf-8')) or {}).get('waters') or {}
    except Exception:
        return {}
    return {k: v for k, v in got.items() if answered(v, apis)}


def save(fp, waters, total, note=None, apis=None):
    # A FAILED FETCH IS NOT PROGRESS. The first version counted every attempted water toward
    # `done` and set `complete` from that, so a run in which every single request was refused
    # wrote {"done": 1, "of": 1, "complete": true} -- which is the same lie as a partial run
    # writing a whole file, wearing a success stamp.
    ok = {k: v for k, v in waters.items() if answered(v, apis)}
    bad = sorted(k for k in waters if k not in ok)
    # WHICH SERVICES WERE ACTUALLY ASKED, WRITTEN DOWN.
    # The 2026-09-04 census carries `by_api` with only a `legacy` key on all 64 waters, and read
    # cold that is ambiguous in the worst way: it looks identical whether `--api legacy` was
    # passed or `--api both` ran and the 3.0 leg vanished. It matters, because 3.0 is where USGS
    # lives -- and USGS appears in ZERO of those 64 results while holding, for one example,
    # thirty-four dissolved-oxygen samples on Lake Bowen and thirty-one years of top-and-bottom
    # daily oxygen on Lake Murray. A census has to say what it asked, not only what answered.
    doc = {'generated': __import__('datetime').date.today().isoformat(),
           'window_the_worker_uses': WINDOW_START,
           'characteristics': CHARS,
           'apis_asked': list(apis) if apis else None,
           'done': len(ok), 'failed': len(bad), 'of': total,
           'complete': len(ok) >= total,
           'note': note or (None if len(ok) >= total else
                            'INCOMPLETE -- %d answered, %d failed, %d total. Re-run with --resume.'
                            % (len(ok), len(bad), total)),
           'failed_waters': bad,
           'waters': dict(sorted(waters.items()))}
    tmp = fp + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write('\n')
    os.replace(tmp, fp)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', default=os.environ.get('TROLLMAP_REGISTRY',
                                                         r'F:\TrollMapPipeline\registry'))
    ap.add_argument('--only', default=None, help='comma-separated slugs, for a first look')
    ap.add_argument('--min-acres', type=float, default=1000.0)
    ap.add_argument('--jobs', type=int, default=4, help='keep it modest; this is a federal API')
    ap.add_argument('--resume', action='store_true', help='skip waters already in the output')
    ap.add_argument('--do-only', action='store_true',
                    help='ask for dissolved oxygen alone. The thermocline rule counts SUMMER DO '
                         'records with a depth, so this answers the question on a fraction of '
                         'the payload; temperature only widens the reported depth span.')
    ap.add_argument('--api', default='both', choices=('both', 'legacy', 'wqx3'),
                    help='which service to ask. Default both -- 2.2 is what the Worker uses '
                         'today and it has no USGS data after 2024-03-11')
    ap.add_argument('--from-csv', default=None,
                    help='parse a saved WQP CSV instead of fetching -- for testing the census')
    ap.add_argument('--out', default=None)
    a = ap.parse_args(argv)

    if a.do_only:
        del CHARS[0]                                  # 'Temperature, water'
    if a.from_csv:
        text = open(a.from_csv, encoding='utf-8', errors='replace').read()
        print(json.dumps(census(text), indent=1))
        return 0

    reg = a.registry
    if not os.path.isdir(reg):
        raise SystemExit('registry not found: %s' % reg)
    IDX = {k: v for k, v in json.load(
        open(os.path.join(reg, 'lake_index.json'), encoding='utf-8')).items()
        if isinstance(v, dict)}

    want = []
    only = set(x.strip() for x in (a.only or '').split(',') if x.strip())
    for slug, row in IDX.items():
        if only:
            if slug not in only:
                continue
        else:
            if (row.get('feature_type') or 'lake') != 'lake':
                continue                              # a thermocline is a lake question
            if (row.get('area_acres') or 0) < a.min_acres:
                continue
        b = row.get('bounds_wsen')
        if not b or len(b) != 4:
            print('   !! %s has no bounds_wsen -- skipped' % slug)
            continue
        want.append((slug, row, b))
    want.sort(key=lambda t: -(t[1].get('area_acres') or 0))

    apis = ('legacy', 'wqx3') if a.api == 'both' else (a.api,)
    out_fp = a.out or os.path.join(reg, OUT_NAME)
    waters = load_done(out_fp, apis) if a.resume else {}
    todo = [t for t in want if t[0] not in waters]
    print('%d water(s) to probe%s (%d already done)'
          % (len(todo), '' if only else ' at or above %g acres' % a.min_acres, len(waters)))
    if not todo:
        print('nothing to do.')
        return 0

    done = [0]

    def one(t):
        slug, row, b = t
        rec = {'display_name': row.get('display_name') or slug,
               'state': row.get('state'), 'acres': row.get('area_acres'), 'by_api': {}}
        for api in apis:
            # DO NOT ASK THE SLOW SERVICE A QUESTION THAT IS ALREADY ANSWERED.
            #
            # Ryan, 2026-09-05: *"wouldn't 3.0 only add newer findings from 2024 on. why pull the
            # history from it that we already have?"* The premise is wrong -- 3.0 carries USGS
            # records going back to 2005, because "added since March 11 2024" is when they entered
            # the system, not when the water was sampled -- but the instinct is right. Measured
            # across 61 waters: 2.2 already finds a profile on 42 of them, and 3.0 changed the
            # verdict on exactly TWO lakes in the whole census, Cherokee and Bowen, both of which
            # 2.2 saw nothing on. On a water 2.2 has already answered, 3.0 can only add rows to a
            # lake we already know stratifies.
            #
            # And it is where the failures live: fourteen of the nineteen HTTP 500s from the 3.0
            # service were on waters 2.2 had already answered. Requests we did not need to make.
            prior = rec['by_api'].get('legacy') or {}
            got_already = prior.get('hidden_summer_do_depth_recs') or 0
            if api != 'legacy' and got_already >= RULE_NEEDS:
                rec['by_api'][api] = {'not_asked': '2.2 already found %d summer depth records; '
                                                   '3.0 cannot change the verdict' % got_already}
                print('        ... %-6s not asked for %s -- 2.2 answered it'
                      % (api, rec['display_name'][:40]), flush=True)
                continue
            # SILENCE IS INDISTINGUISHABLE FROM A HANG, and one of these requests can run for
            # minutes. Said before the wait, not after it.
            print('        ... asking %-6s for %s' % (api, rec['display_name'][:40]), flush=True)
            t0 = time.time()
            text, err = fetch(wqp_url(b, api))
            print('        ... %-6s %s in %.0fs'
                  % (api, 'failed' if err else '%d KB' % (len(text) // 1024), time.time() - t0),
                  flush=True)
            rec['by_api'][api] = {'error': err} if err else census(text)
        # The headline is the BEST of the two -- whichever service saw more of the lake. They are
        # reported separately underneath because a difference is itself the finding.
        best = max((v for v in rec['by_api'].values()
                    if 'error' not in v and 'not_asked' not in v),
                   key=lambda v: (v.get('summer_do_depth_recs', 0), v.get('depth_recs', 0)),
                   default=None)
        if best is None:
            rec['error'] = '; '.join('%s: %s' % (k, v.get('error'))
                                     for k, v in rec['by_api'].items())
        else:
            rec.update(best)
        return slug, rec

    with ThreadPoolExecutor(max_workers=max(1, a.jobs)) as ex:
        for slug, rec in ex.map(one, todo):
            waters[slug] = rec
            done[0] += 1
            # A long read-only run must say where it is; silence is indistinguishable from a hang.
            print('   [%3d/%3d] %-42s %s'
                  % (done[0], len(todo), (rec.get('display_name') or slug)[:42],
                     rec.get('error') or
                     ('%5d rows, %4d with a depth, %3d summer DO, %2d bins, max %sft, hidden %d'
                      % (rec.get('rows', 0), rec.get('depth_recs', 0),
                         rec.get('summer_do_depth_recs', 0), rec.get('distinct_2ft_bins', 0),
                         rec.get('max_depth_ft'), rec.get('hidden_summer_do_depth_recs', 0)))))
            save(out_fp, waters, len(want), apis=apis)

    gain = [(s, r) for s, r in waters.items()
            if (r.get('hidden_summer_do_depth_recs') or 0) >= RULE_NEEDS]
    gain.sort(key=lambda t: -(t[1].get('acres') or 0))
    print()
    print('WATERS THE 2015 WINDOW IS HIDING A PROFILE FROM -- %d' % len(gain))
    for s, r in gain:
        print('   %-44s %-3s %8s ac  %d summer DO records before %s, to %s ft  [%s]'
              % (r['display_name'][:44], r.get('state') or '',
                 ('%.0f' % r['acres']) if r.get('acres') else '?',
                 r['hidden_summer_do_depth_recs'], WINDOW_START,
                 r.get('hidden_max_depth_ft'), ', '.join(r.get('hidden_organizations') or [])))
        dp = r.get('deepest') or {}
        if dp:
            print('        deepest record: %s ft at %s on %s (%s)'
                  % (dp.get('depthFt'), dp.get('station') or '?', dp.get('date') or '?',
                     dp.get('characteristic') or '?'))
    if a.api == 'both':
        diff = []
        for sl, r in waters.items():
            ba = r.get('by_api') or {}
            lg, w3 = ba.get('legacy') or {}, ba.get('wqx3') or {}
            if 'error' in lg or 'error' in w3:
                continue
            if (w3.get('rows', 0) - lg.get('rows', 0)) != 0 \
                    or (w3.get('depth_recs', 0) - lg.get('depth_recs', 0)) != 0:
                diff.append((sl, r, lg, w3))
        diff.sort(key=lambda t: -(t[1].get('acres') or 0))
        print()
        print('THE TWO SERVICES DISAGREE -- %d water(s). WQX 2.2 has no USGS data after '
              '2024-03-11; a difference here is what we have never seen.' % len(diff))
        for sl, r, lg, w3 in diff[:40]:
            print('   %-44s 2.2: %5d rows / %4d depth    3.0: %5d rows / %4d depth'
                  % (r['display_name'][:44], lg.get('rows', 0), lg.get('depth_recs', 0),
                     w3.get('rows', 0), w3.get('depth_recs', 0)))
    print()
    print('-> %s   (%d of %d)' % (out_fp, len(waters), len(want)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
