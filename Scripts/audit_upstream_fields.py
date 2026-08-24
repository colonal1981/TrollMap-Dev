#!/usr/bin/env python3
"""
audit_upstream_fields.py -- WHAT DOES THE UPSTREAM SEND THAT NOTHING IN THIS REPO READS?

    py .\\scripts\\audit_upstream_fields.py --repo F:\\TrollMapPipeline\\TrollMap-Dev ^
        --capture F:\\TrollMapPipeline\\CurrentConditions.json
    py .\\scripts\\audit_upstream_fields.py --repo ... --dir F:\\TrollMapPipeline\\_captures
    py .\\scripts\\audit_upstream_fields.py --self-test

WHY THIS EXISTS

Ryan, 2026-08-24: *"what other data like this are we leaving on the cutting floor or not pulling
at all... i have asked this same question about 50 times... and get assured that we have
everything useful but every time i look somewhere i found more stuff."*

He is right, and the reason is a bad method rather than bad luck. Every previous answer was
produced by grepping OUR OWN CODE, and our own code can only ever say what is WIRED. It cannot
say what ARRIVED. The gap between those two has never been measured, so every new thing he
stumbles on is a discovery, and always will be.

This measures the gap the only way it can be measured: take an ACTUAL RESPONSE from an upstream,
enumerate every key it contains, and ask the repo whether anything reads that key.

Five instances of the same failure were found in one afternoon on 2026-08-24:

  build_water_bindings.py   fetches 00010 and 63680 per site, unions them into g['parms'],
                            then intersects them away against LEVEL_PARMS before writing.
  worker-data.js fetchUsgs  requests period=P2D -- two days of readings -- and keeps
                            good[good.length - 1]. One point survives.
  conditions.js parseSiteCatalog
                            parses begin, end and count per parameter, and waterProbe() uses
                            the result only for truthiness.
  the WQP pull              computes seasonalTemp.summerAvgTempF and peakSummerTempF on 23 of
                            24 profiles, and a secchi min/max range on 16 of 24. Nothing reads
                            any of them.
  the dashboard OData row   carries 76 properties. The app's request asks for 15.

None of those is a missing source. Every one is a response we already paid for, read one field
out of, and dropped. That is the pattern, and this script is pointed at it.

HOW IT DECIDES, AND WHERE IT CANNOT

A grep knows names, not reachability -- the same warning `audit_research_fields.py` carries, for
the same reason, and it cost that auditor five wrong answers before it was believed. So:

  READ          a distinctive key name found in the repo, with the files listed so it can be
                checked by hand rather than trusted.
  NOT READ      a distinctive key name found nowhere. This is the cut list -- or rather, the
                LOOK-AT-THIS list.
  AMBIGUOUS     a key too generic to grep honestly. `Value`, `name`, `id`, `type`, `data`, `lat`
                match half a codebase by accident, and reporting them as READ would be a lie
                that flatters the result. They are counted and set aside, never claimed.

Dynamic access is listed as risk, not resolved: a file doing obj[k] or Object.keys(obj) can read
a key this script will call NOT READ. Those files are named in the report so the human check has
somewhere to start.

WHAT TO FEED IT. Any saved response from any upstream this app touches -- JSON or USGS RDB. The
ones worth capturing, because each one is a response we already pay for:

    waterservices.usgs.gov/nwis/iv           what fetchUsgs actually receives
    waterservices.usgs.gov/nwis/site         the series catalogue (RDB)
    api.water.noaa.gov/nwps/v1/gauges/{lid}  and its /stageflow
    api.tidesandcurrents.noaa.gov            CO-OPS
    api.open-meteo.com/v1/forecast           what the plan asks for vs what comes back
    dashboard.waterdata.usgs.gov .../odata   CurrentConditions, Statistics, Sites, FloodStages
    www.waterqualitydata.us                  WQP
    api.waterdata.usgs.gov/nims/v0/cameras   NIMS

READ-ONLY. Writes one report file and nothing else.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import collections
import csv
import json
import os
import re
import sys

# Keys whose names are too common in any JavaScript codebase for a grep to mean anything.
# Reported as AMBIGUOUS and never claimed as read. Lower-cased comparison.
GENERIC = {
    'id', 'name', 'value', 'values', 'type', 'data', 'items', 'list', 'code', 'codes', 'key',
    'keys', 'url', 'href', 'text', 'title', 'label', 'description', 'status', 'state', 'error',
    'message', 'result', 'results', 'count', 'total', 'index', 'time', 'date', 'lat', 'lon',
    'lng', 'latitude', 'longitude', 'x', 'y', 'z', 'unit', 'units', 'source', 'sources', 'note',
    'notes', 'properties', 'features', 'geometry', 'coordinates', 'self', 'links', 'link',
    'start', 'end', 'begin', 'min', 'max', 'mean', 'avg', 'sum', 'level', 'size', 'length',
}
CODE_EXT = ('.js', '.mjs', '.cjs', '.ts', '.py', '.html')
# Object.keys/entries/values ONLY. An earlier version also matched any obj[ident], which is
# arr[i] -- it flagged 315 of 443 files as risk, and a risk list covering 71% of a repo is noise.
DYNAMIC = re.compile(r'Object\.(keys|entries|values)\s*\(')
# THE AUDITOR MUST NOT READ THE FETCHERS. `pull_usgs_dashboard.py` carries the upstream's whole
# field list inside a $select string; indexing it makes the audit find its own request and report
# every field as used. Caught on the first real run, 2026-08-24, which reported 12 of 17 keys READ
# for an endpoint the app has never once called.
SKIP_DIRS = {'node_modules', '.git', 'dist', 'build', '_to_delete', 'coverage',
             'Scripts', 'scripts', 'test', 'tests', '__pycache__'}


def keys_of_json(obj, out, depth=0, maxdepth=12):
    """Every distinct KEY NAME anywhere in the structure, with a count and a sample value."""
    if depth > maxdepth:
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            rec = out.setdefault(str(k), {'n': 0, 'sample': None})
            rec['n'] += 1
            if rec['sample'] is None and not isinstance(v, (dict, list)):
                rec['sample'] = v
            keys_of_json(v, out, depth + 1, maxdepth)
    elif isinstance(obj, list):
        for v in obj:
            keys_of_json(v, out, depth + 1, maxdepth)


def keys_of_rdb(text):
    """USGS RDB: the first non-comment line is the header. Column names are the key set."""
    lines = [l for l in text.split('\n') if l and not l.startswith('#')]
    if len(lines) < 2:
        return None
    head = lines[0].split('\t')
    if len(head) < 2:
        return None
    out = {}
    for h in head:
        h = h.strip()
        if h:
            out[h] = {'n': 1, 'sample': None}
    # A second line of type codes ("5s", "15s", "20d") is the RDB signature.
    if not re.match(r'^\d+[sndv](\t|$)', lines[1].strip()):
        return None
    return out


def keys_of_csv(text):
    """A comma-delimited header row is a key set too.

    The Water Quality Portal answers in CSV and the first version of this auditor refused it,
    which quietly excused the single biggest block the hybrid plan is trying to shrink from ever
    being measured. A header is NAMES, not values: mostly non-numeric, none absurdly long.
    """
    lines = [l for l in text.split('\n') if l.strip()]
    if not lines:
        return None
    try:
        head = next(csv.reader([lines[0]]))
    except Exception:                                            # noqa: BLE001
        return None
    named = [h.strip() for h in head if h.strip()]
    if len(named) < 3:
        return None
    if sum(1 for h in named if re.fullmatch(r'-?\d+(\.\d+)?', h)) > len(named) / 3:
        return None
    if any(len(h) > 80 for h in named):
        return None
    return {h: {'n': 1, 'sample': None} for h in named}


def load_capture(path):
    raw = open(path, encoding='utf-8', errors='replace').read()
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        rdb = keys_of_rdb(raw)
        if rdb is not None:
            return rdb, 'rdb'
        csvk = keys_of_csv(raw)
        if csvk is not None:
            return csvk, 'csv'
        return None, 'not JSON, USGS RDB or CSV'
    out = {}
    keys_of_json(obj, out)
    return out, 'json'


def index_repo(repo, extra_skip=None):
    """One pass over the repo. Returns (blob_by_file, dynamic_files)."""
    blobs, dyn = {}, []
    skip = set(SKIP_DIRS) | set(extra_skip or ())
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in skip]
        for f in files:
            if not f.endswith(CODE_EXT):
                continue
            p = os.path.join(root, f)
            try:
                t = open(p, encoding='utf-8', errors='replace').read()
            except OSError:
                continue
            blobs[os.path.relpath(p, repo)] = t
            if DYNAMIC.search(t):
                dyn.append(os.path.relpath(p, repo))
    return blobs, dyn


def readers_of(key, blobs, limit=4):
    """(read_in, mentioned_in) -- and the difference between them is the whole point.

    READ means the code performs a PROPERTY ACCESS on that name: `row.ParameterUnit` or
    `row['ParameterUnit']`. MENTIONED means the name merely occurs -- in a $select string, a
    comment, a variable that happens to share the name, or a key we define ourselves on an
    object of our own. An earlier version treated the two as one and reported a field as used
    because our own request listed it. A name in a request string is the OPPOSITE of evidence
    that the response is read.
    """
    access = [re.compile(r'\.%s\b' % re.escape(key)),
              re.compile(r'''\[\s*['"]%s['"]\s*\]''' % re.escape(key)),
              # destructuring: const { ParameterUnit, Value } = row
              re.compile(r'\{[^{}\n]*\b%s\b[^{}\n]*\}\s*=' % re.escape(key))]
    read, mentioned = [], []
    for rel, t in blobs.items():
        if key not in t:
            continue
        if any(p.search(t) for p in access):
            read.append(rel)
        else:
            mentioned.append(rel)
        if len(read) >= limit and len(mentioned) >= limit:
            break
    return read[:limit], mentioned[:limit]


def self_test():
    ok = True

    def check(label, got, want):
        nonlocal ok
        if got != want:
            ok = False
            print('FAIL %-52s got %r want %r' % (label, got, want))
        else:
            print('ok   %-52s %r' % (label, got))

    out = {}
    keys_of_json({'a': 1, 'b': {'c': 2}, 'd': [{'e': 3}, {'e': 4}]}, out)
    check('every nested key found', sorted(out), ['a', 'b', 'c', 'd', 'e'])
    check('repeats are counted', out['e']['n'], 2)
    check('scalar sample captured', out['a']['sample'], 1)
    check('container keys have no sample', out['b']['sample'], None)

    rdb = ('# comment\nagency_cd\tsite_no\tparm_cd\n5s\t15s\t5s\n'
           'USGS\t02147801\t00010\n')
    k = keys_of_rdb(rdb)
    check('rdb header parsed', sorted(k), ['agency_cd', 'parm_cd', 'site_no'])
    check('non-rdb text refused', keys_of_rdb('hello\nworld\n'), None)
    c = keys_of_csv('OrganizationIdentifier,ActivityStartDate,ResultMeasureValue\nUSGS,2025-01-01,7.2\n')
    check('csv header parsed', sorted(c),
          ['ActivityStartDate', 'OrganizationIdentifier', 'ResultMeasureValue'])
    check('a row of numbers is not a header', keys_of_csv('1,2,3\n4,5,6\n'), None)
    check('prose is not a csv header', keys_of_csv('hello world\n'), None)
    check('manifest is not graded as a capture', '_manifest.json' in open(__file__,
          encoding='utf-8').read(), True)

    blobs = {'Worker/x.js': 'const t = row.ParameterUnit; obj["IsPrimary"];',
             'Worker/z.js': 'const { LatencyMinutes } = row;',
             'js/y.js': 'nothing here',
             'fetcher.py': "SELECT = 'AgencyCode,RateOfChangeUnitPerHour'"}
    check('dotted read found', readers_of('ParameterUnit', blobs)[0], ['Worker/x.js'])
    check('bracket read found', readers_of('IsPrimary', blobs)[0], ['Worker/x.js'])
    check('destructured read found', readers_of('LatencyMinutes', blobs)[0], ['Worker/z.js'])
    # THE BUG THE FIRST REAL RUN FOUND: a field listed in our own request string is not read.
    check('request-string name is NOT read', readers_of('RateOfChangeUnitPerHour', blobs)[0], [])
    check('request-string name IS mentioned',
          readers_of('RateOfChangeUnitPerHour', blobs)[1], ['fetcher.py'])
    check('absent key found nowhere', readers_of('NwsIdentifier', blobs), ([], []))
    check('Scripts is skipped by default', 'Scripts' in SKIP_DIRS, True)
    check('arr[i] no longer counts as dynamic', bool(DYNAMIC.search('a = arr[i];')), False)
    check('Object.keys still counts', bool(DYNAMIC.search('Object.keys(o)')), True)
    check('generic guard holds a common name', 'value' in GENERIC, True)
    print('\n%s' % ('SELF-TEST PASSED' if ok else 'SELF-TEST FAILED'))
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--repo', default='.', help='TrollMap-Dev root')
    ap.add_argument('--capture', action='append', default=[], help='a saved upstream response')
    ap.add_argument('--dir', default=None, help='a folder of saved responses')
    ap.add_argument('--out', default=None, help='report path (default: beside the repo)')
    ap.add_argument('--exclude', action='append', default=[],
                    help='extra directory name to skip (Scripts/ and test/ are skipped already)')
    ap.add_argument('--self-test', action='store_true')
    a = ap.parse_args()
    if a.self_test:
        return self_test()

    caps = list(a.capture)
    if a.dir:
        if not os.path.isdir(a.dir):
            print('FATAL: %s is not a folder.' % a.dir)
            return 2
        caps += [os.path.join(a.dir, f) for f in sorted(os.listdir(a.dir))
                 if f.lower().endswith(('.json', '.txt', '.rdb', '.tsv', '.csv'))
                 # the capture run's own bookkeeping is not an upstream response
                 and f != '_manifest.json']
    if not caps:
        print('FATAL: give me at least one --capture or a --dir of them.')
        print('       See the module docstring for which responses are worth saving.')
        return 2
    if not os.path.isdir(a.repo):
        print('FATAL: --repo %s is not a folder.' % a.repo)
        return 2

    print('indexing %s ...' % os.path.abspath(a.repo))
    blobs, dyn = index_repo(a.repo, a.exclude)
    print('  %d source files, %d of them use dynamic property access\n' % (len(blobs), len(dyn)))

    report = {'_note': 'Keys an upstream sent that nothing in the repo reads. A grep knows names, '
                       'not reachability -- see dynamic_access_risk. Built by '
                       'audit_upstream_fields.py.',
              'repo': os.path.abspath(a.repo), 'dynamic_access_risk': sorted(dyn)[:40],
              'captures': {}}
    grand = collections.Counter()
    for cap in caps:
        if not os.path.exists(cap):
            print('!! %s not found, skipping' % cap)
            continue
        keys, kind = load_capture(cap)
        if keys is None:
            print('!! %s: %s, skipping' % (os.path.basename(cap), kind))
            continue
        read, ment, unread, ambig = [], [], [], []
        for k, rec in keys.items():
            if k.lower() in GENERIC or len(k) < 3:
                ambig.append((k, rec['n'], rec['sample']))
                continue
            r, m = readers_of(k, blobs)
            if r:
                read.append((k, rec['n'], rec['sample'], r))
            elif m:
                ment.append((k, rec['n'], rec['sample'], m))
            else:
                unread.append((k, rec['n'], rec['sample'], []))
        for L in (read, ment, unread):
            L.sort(key=lambda x: -x[1])
        grand['read'] += len(read)
        grand['mentioned'] += len(ment)
        grand['unread'] += len(unread)
        grand['ambiguous'] += len(ambig)

        def dump(title, rows):
            if not rows:
                return
            print('    --- %s ---' % title)
            for k, n, sv, where in rows:
                ex = ('' if sv is None
                      else '  e.g. %r' % (sv if not isinstance(sv, str) else sv[:34]))
                w = ('  <- %s' % ', '.join(where[:2])) if where else ''
                print('      %-32s x%-5d%s%s' % (k, n, ex, w))

        print('=== %s  (%s, %d distinct keys)' % (os.path.basename(cap), kind, len(keys)))
        print('    READ %d   MENTIONED-ONLY %d   NOT FOUND %d   AMBIGUOUS %d'
              % (len(read), len(ment), len(unread), len(ambig)))
        dump('NOT FOUND ANYWHERE IN THE REPO', unread)
        dump('MENTIONED BUT NEVER READ AS A PROPERTY', ment)
        print()
        report['captures'][os.path.basename(cap)] = {
            'kind': kind, 'distinct_keys': len(keys),
            'not_found': [{'key': k, 'occurrences': n, 'sample': s} for k, n, s, _ in unread],
            'mentioned_only': [{'key': k, 'occurrences': n, 'files': w}
                               for k, n, s, w in ment],
            'read': [{'key': k, 'occurrences': n, 'readers': w} for k, n, s, w in read],
            'ambiguous': [{'key': k, 'occurrences': n} for k, n, s in ambig]}

    print('TOTAL   read %d   mentioned-only %d   not found %d   ambiguous %d'
          % (grand['read'], grand['mentioned'], grand['unread'], grand['ambiguous']))
    print('\nMENTIONED-ONLY is the interesting column: the name occurs in the repo but nothing')
    print('performs a property access on it. A field named in our own request string and never')
    print('read off the response lands here -- that is data we ask for and throw away.')
    print('AMBIGUOUS is not a verdict; those names are too generic to grep honestly.')
    print('%d files call Object.keys/entries/values and could reach a key by name.' % len(dyn))

    out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.repo)),
                                '_upstream_field_audit.json')
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump(report, fh, indent=1)
    print('\nwrote %s' % os.path.abspath(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
