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
# `entry['tva'] = {}` is us DEFINING a key on an object of our own, which is the same
# class of false positive as a name sitting in a $select string: the presence of the name
# is not evidence the upstream's value was ever looked at. A trailing `=` that is not part
# of `==`, `===`, `>=`, `<=`, `!=` or `+=` marks the match as a write target and disqualifies
# it. Compound assignment (`+=`) still counts -- it reads before it writes.
NOT_ASSIGNED = r'(?!\s*=[^=])'
# WHY `Scripts/` IS NO LONGER SKIPPED.
#
# The first version skipped it, because `pull_usgs_dashboard.py` carries an upstream's whole
# field list inside a $select string and indexing it made the audit find its own request and
# call every field used. That was a real bug -- it reported 12 of 17 keys READ for an endpoint
# the app has never called.
#
# But the blanket skip cured the symptom and caused a worse one: `Scripts/` is also where the
# PIPELINE BUILDERS live, and they are genuine consumers. On 2026-08-25 this auditor reported
# TVA's /RestApi/locations as ten fields, zero read -- while `build_water_bindings.py:1046` had
# been reading TopOfGatesFt, River and RiverMile all along, putting a `tva{}` block on 13 waters.
# A blind spot that says "nobody reads this" about code that does is worse than noise, because
# it reads as a finding.
#
# The READ vs MENTIONED-ONLY split already solves the original problem properly and with
# evidence: a name sitting in a $select string is never a property access, so it lands in
# MENTIONED-ONLY with the file named, and can be judged rather than guessed at.
#
# `test/` stays skipped. A fixture that DEFINES a field is not a consumer of it, and the ones
# here are full of example.com and x.gov URLs that are not upstreams at all.
SKIP_DIRS = {'node_modules', '.git', 'dist', 'build', '_to_delete', 'coverage',
             'test', 'tests', '__tests__', '__pycache__'}
# ...but two files in `Scripts/` ARE homework. This script's own self-test fixtures are
# strings full of real upstream field names -- TopOfGatesFt, ParameterUnit, IsPrimary -- so
# indexing it makes it a "reader" of every field it was written to check. `capture_upstreams.py`
# carries upstream URL templates for the same reason. Instruments measure; they do not consume.
SKIP_FILES = {'audit_upstream_fields.py', 'capture_upstreams.py'}


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


DECISIONS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              'upstream_field_decisions.json')


def load_decisions(path=None):
    """WHY A FIELD IS NOT READ, written down so it is decided once instead of every run.

    Ryan, 2026-08-24: *"i have asked this same question about 50 times... and get assured that
    we have everything useful but every time i look somewhere i found more stuff."*

    The first version of this report answered that with a 186-line NOT-FOUND list. A list that
    long gets re-judged from scratch on every run, which means it gets skimmed, which means a
    real finding sits in it indefinitely wearing the same clothes as thirty serialisation
    artefacts. So: a name with a recorded decision is still counted and still shown, but under
    DECIDED. NEW then means what it says -- this upstream is sending something nobody has looked
    at yet -- and NEW is the number worth reading.

    A decision is a claim, not a dismissal. `why` has to say what question the field would have
    answered, so the next person can disagree with a specific sentence.
    """
    p = path or DECISIONS_FILE
    try:
        with open(p, encoding='utf-8') as fh:
            raw = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}
    return {k: v for k, v in raw.items() if not k.startswith('_')}


def capture_host(filename):
    """`api.water.noaa.gov_nwps_v1_gauges_ERJS1.json` -> `api.water.noaa.gov`.

    capture_upstreams.py writes every file host-first and a host never contains an underscore,
    so the first segment is the host and it stays stable while the path after it does not.
    """
    return os.path.basename(filename).split('_')[0]


def decision_for(decisions, host, key):
    """Host-specific first, then a `*::` rule that applies to every upstream."""
    return decisions.get('%s::%s' % (host, key)) or decisions.get('*::%s' % key)


def index_repo(repo, extra_skip=None):
    """One pass over the repo. Returns (blob_by_file, dynamic_files, lower_by_file)."""
    blobs, dyn = {}, []
    skip = set(SKIP_DIRS) | set(extra_skip or ())
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in skip]
        for f in files:
            if not f.endswith(CODE_EXT) or f in SKIP_FILES:
                continue
            p = os.path.join(root, f)
            try:
                t = open(p, encoding='utf-8', errors='replace').read()
            except OSError:
                continue
            blobs[os.path.relpath(p, repo)] = t
            if DYNAMIC.search(t):
                dyn.append(os.path.relpath(p, repo))
    return blobs, dyn, {k: v.lower() for k, v in blobs.items()}


def readers_of(key, blobs, limit=4, lower=None):
    """(read_in, mentioned_in) -- and the difference between them is the whole point.

    READ means the code performs a PROPERTY ACCESS on that name: `row.ParameterUnit` or
    `row['ParameterUnit']`. MENTIONED means the name merely occurs -- in a $select string, a
    comment, a variable that happens to share the name, or a key we define ourselves on an
    object of our own. An earlier version treated the two as one and reported a field as used
    because our own request listed it. A name in a request string is the OPPOSITE of evidence
    that the response is read.
    """
    access = [re.compile(r'\.%s\b%s' % (re.escape(key), NOT_ASSIGNED)),
              # `(?<=[\w)\]])` keeps `row['Foo']` and drops `['Foo']` -- an array literal of
              # field names is a list we wrote, not a value we read off a response.
              re.compile(r'''(?<=[\w)\]])\[\s*['"]%s['"]\s*\]%s''' % (re.escape(key), NOT_ASSIGNED)),
              # destructuring: const { ParameterUnit, Value } = row
              re.compile(r'\{[^{}\n]*\b%s\b[^{}\n]*\}\s*=' % re.escape(key)),
              # PYTHON READS A DICT BY NAME, NOT BY DOT. `t.get('TopOfGatesFt')` is every bit a
              # property access, and missing it made this auditor report TVA's locations feed as
              # ten fields and zero readers while build_water_bindings.py:1046 was reading three
              # of them into a `tva{}` block on 13 waters. The pipeline is written in Python; an
              # auditor that only understands JavaScript syntax is half an auditor.
              re.compile(r'''\.get\(\s*['"]%s['"]''' % re.escape(key)),
              re.compile(r'''\.pop\(\s*['"]%s['"]''' % re.escape(key)),
              # A COLUMN IS OFTEN LOOKED UP BY NAME, NOT REACHED BY ONE.
              #
              # Worker/research/limnology.js resolves every WQP column through
              # `col('characteristicname')`, a case-insensitive substring match against the
              # header row. Eight columns it reads on every limnology request were reported
              # NOT FOUND -- CharacteristicName and ResultMeasureValue among them -- because
              # the name never appears as a property access anywhere.
              #
              # The rule that keeps this from re-admitting the $select false positive: the key
              # must be the WHOLE quoted string AND that string must be a call argument. A
              # request list is 'AgencyCode,RateOfChangeUnitPerHour' -- one quoted string
              # holding many names -- so no single name is ever the whole of it. Case-
              # insensitive, because a header lookup lower-cases both sides.
              re.compile(r'''\(\s*['"]%s['"]\s*[,)]''' % re.escape(key), re.I)]
    read, mentioned = [], []
    # The cheap reject has to be CASE-INSENSITIVE or the column-lookup pattern above can never
    # fire: `col('characteristicname')` does not contain the string `CharacteristicName`. The
    # lower-cased index is built once per run in index_repo rather than per key, because doing
    # it here would lower-case the whole repo 455 times.
    kl = key.lower()
    for rel, t in blobs.items():
        if kl not in (lower.get(rel, '') if lower else t.lower()):
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
    colb = {'lim.js': "const iChar = col('characteristicname');",
            'sel.py': "SELECT = 'CharacteristicName,ResultMeasureValue'",
            'arr.js': "const KEYS = ['CharacteristicName'];"}
    check('a lower-cased column lookup is a read',
          readers_of('CharacteristicName', colb)[0], ['lim.js'])
    check('a name inside a comma list is still not a read',
          readers_of('ResultMeasureValue', colb)[0], [])
    check('a name in an ARRAY literal is not a call argument',
          readers_of('CharacteristicName', {'arr.js': colb['arr.js']})[0], [])
    pyb = {'build.py': "entry['tva'] = {'top': t.get('TopOfGatesFt'), 'rm': t.get('RiverMile')}"}
    check('python .get() counts as a read', readers_of('TopOfGatesFt', pyb)[0], ['build.py'])
    check('python .get() on a second key too', readers_of('RiverMile', pyb)[0], ['build.py'])
    # An assignment TARGET is a write. `entry['tva'] = {}` names the key without ever looking
    # at the upstream's value -- the same false positive as a $select string, in a different
    # syntax. It cost nothing to catch here and would have inflated the read count on every
    # feed whose fields we re-emit under their own names.
    check('a key only assigned to is not a read',
          readers_of('tva', {'x.py': "entry['tva'] = {}"})[0], [])
    check('dotted assignment target is not a read',
          readers_of('Foo', {'x.js': 'out.Foo = 1;'})[0], [])
    check('a write does not mask a read in the same file',
          readers_of('tva', {'x.py': "entry['tva'] = {}\nif row['tva']: pass"})[0], ['x.py'])
    check('=== is a comparison, not an assignment',
          readers_of('Foo', {'x.js': "if (row['Foo'] === 2) {}"})[0], ['x.js'])
    check('+= reads before it writes',
          readers_of('Foo', {'x.js': 'n += row.Foo;'})[0], ['x.js'])
    check('this auditor does not read its own fixtures',
          'audit_upstream_fields.py' in SKIP_FILES, True)
    check('request-string name IS mentioned',
          readers_of('RateOfChangeUnitPerHour', blobs)[1], ['fetcher.py'])
    check('absent key found nowhere', readers_of('NwsIdentifier', blobs), ([], []))
    check('Scripts is INDEXED -- builders are consumers', 'Scripts' in SKIP_DIRS, False)
    check('test/ stays skipped -- a fixture is not a consumer', 'test' in SKIP_DIRS, True)
    check('arr[i] no longer counts as dynamic', bool(DYNAMIC.search('a = arr[i];')), False)
    check('Object.keys still counts', bool(DYNAMIC.search('Object.keys(o)')), True)
    check('generic guard holds a common name', 'value' in GENERIC, True)
    check('host comes off the capture filename',
          capture_host('api.water.noaa.gov_nwps_v1_gauges_ERJS1.json'), 'api.water.noaa.gov')
    check('host survives a query-string filename',
          capture_host('waterservices.usgs.gov_nwis_iv__sites02175148parameterCd.json'),
          'waterservices.usgs.gov')
    dec = {'a.gov::Foo': {'verdict': 'declined'}, '*::Bar': {'verdict': 'envelope'}}
    check('host-specific decision found', decision_for(dec, 'a.gov', 'Foo')['verdict'], 'declined')
    check('a decision for one host does not cover another',
          decision_for(dec, 'b.gov', 'Foo'), None)
    check('a *:: decision covers every host', decision_for(dec, 'b.gov', 'Bar')['verdict'],
          'envelope')
    check('an undecided key stays undecided', decision_for(dec, 'a.gov', 'Baz'), None)
    # The registry ships with this script and is the reason the NEW column can be trusted; a
    # typo in it fails silently as "nothing is decided", which reads as a pile of new findings.
    shipped = load_decisions()
    check('the shipped registry parses and is not empty', len(shipped) > 0, True)
    check('every shipped decision states a reason',
          sorted(k for k, v in shipped.items() if not v.get('why')), [])
    check('every shipped decision uses a known verdict',
          sorted({v.get('verdict') for v in shipped.values()}
                 - {'declined', 'envelope', 'wired-elsewhere'}), [])
    check('every shipped key is host-scoped',
          sorted(k for k in shipped if '::' not in k), [])
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
                    help='extra directory name to skip (test/ is skipped already)')
    ap.add_argument('--decisions', default=None,
                    help='field-decision registry (default: scripts/upstream_field_decisions.json)')
    ap.add_argument('--show-decided', action='store_true',
                    help='list the already-judged NOT-FOUND keys as well as the new ones')
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

    decisions = load_decisions(a.decisions)
    print('%d recorded field decisions' % len(decisions))
    print('indexing %s ...' % os.path.abspath(a.repo))
    blobs, dyn, lower = index_repo(a.repo, a.exclude)
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
            r, m = readers_of(k, blobs, lower=lower)
            if r:
                read.append((k, rec['n'], rec['sample'], r))
            elif m:
                ment.append((k, rec['n'], rec['sample'], m))
            else:
                unread.append((k, rec['n'], rec['sample'], []))
        for L in (read, ment, unread):
            L.sort(key=lambda x: -x[1])
        # A name with a recorded decision is still not read -- it is not read ON PURPOSE, and
        # saying which is the difference between a report and a list.
        host = capture_host(cap)
        decided, fresh = [], []
        for row in unread:
            d = decision_for(decisions, host, row[0])
            if d:
                decided.append(row + (d,))
            else:
                fresh.append(row)
        grand['read'] += len(read)
        grand['mentioned'] += len(ment)
        grand['unread'] += len(unread)
        grand['decided'] += len(decided)
        grand['new'] += len(fresh)
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

        def dump_decided(rows):
            if not rows:
                return
            print('    --- ALREADY JUDGED (%d) ---' % len(rows))
            for k, n, sv, where, d in rows:
                print('      %-32s %-15s %s' % (k, d.get('verdict', '?'), d.get('why', '')[:78]))

        print('=== %s  (%s, %d distinct keys)' % (os.path.basename(cap), kind, len(keys)))
        print('    READ %d   MENTIONED-ONLY %d   NOT FOUND %d (%d NEW)   AMBIGUOUS %d'
              % (len(read), len(ment), len(unread), len(fresh), len(ambig)))
        dump('NOT FOUND AND NOT YET JUDGED', fresh)
        if a.show_decided:
            dump_decided(decided)
        dump('MENTIONED BUT NEVER READ AS A PROPERTY', ment)
        print()
        report['captures'][os.path.basename(cap)] = {
            'kind': kind, 'distinct_keys': len(keys),
            'not_found': [{'key': k, 'occurrences': n, 'sample': s} for k, n, s, _ in fresh],
            'decided': [{'key': k, 'occurrences': n, 'verdict': d.get('verdict'),
                         'why': d.get('why'), 'when': d.get('when')}
                        for k, n, s, _, d in decided],
            'mentioned_only': [{'key': k, 'occurrences': n, 'files': w}
                               for k, n, s, w in ment],
            'read': [{'key': k, 'occurrences': n, 'readers': w} for k, n, s, w in read],
            'ambiguous': [{'key': k, 'occurrences': n} for k, n, s in ambig]}

    print('TOTAL   read %d   mentioned-only %d   not found %d   ambiguous %d'
          % (grand['read'], grand['mentioned'], grand['unread'], grand['ambiguous']))
    print('        of the not-found: %d already judged, %d NEW.'
          % (grand['decided'], grand['new']))
    print('NEW is the number to read. A judged key is still not read -- it is not read on')
    print('purpose, and %s says whose purpose and why.'
          % os.path.basename(a.decisions or DECISIONS_FILE))
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
