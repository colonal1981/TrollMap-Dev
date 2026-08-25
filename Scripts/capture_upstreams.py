#!/usr/bin/env python3
"""
capture_upstreams.py -- find every upstream URL IN THE CODE, fill in its holes, fetch it, save
the raw body. Discovery, not a hand-list.

    py .\\scripts\\capture_upstreams.py
    py .\\scripts\\capture_upstreams.py --list                 show what it found, fetch nothing
    py .\\scripts\\capture_upstreams.py --host duke-energy     just one host
    py .\\scripts\\capture_upstreams.py --water wateree
    py .\\scripts\\capture_upstreams.py --subst basinId=2 --subst slug=lake-wateree
    py .\\scripts\\capture_upstreams.py --self-test            no network

WHY THIS EXISTS, AND WHY THE FIRST VERSION WAS WRONG

Ryan, 2026-08-24: *"i dont want to have to save responses... that is dumb i shouldn't have to go
find all of this when i already built a program that pulls everything."*

He is right, and the first version of this script deserved it. It carried a TABLE OF ENDPOINTS I
had hand-copied out of the two files I happened to have read. That table missed most of what the
app actually calls -- and the proof is embarrassing: `https://www.tva.com/RestApi` is at
`conditions.js:748` and `https://aa.usno.navy.mil/api/rstt/oneday` is at `conditions.js:158`.
Both were in the code the whole time, while I went looking for them on the open web and told him
to go check whether they existed.

Two files alone hold 56 distinct URL templates. A hand-list will always be a subset of the truth
and will always be silently out of date. So this version READS THE REPO.

HOW

1. Walk every .js / .mjs / .py file. Pull out every string and template literal starting https://.
2. Reduce each to a template, with `${expr}` as a named hole.
3. Fill the holes from a REAL water's bindings -- site number, gauge lid, coordinates -- plus a
   small table of constants and anything passed with --subst. Anything still unfilled is REPORTED,
   with its file and line, rather than guessed at.
4. Fetch what resolves, with the per-host headers the code itself uses, and save the raw body.
5. Print what it could not resolve and what failed, so the gaps are visible instead of absent.

SOME HOSTS NEED HEADERS OR THEY REFUSE. `worker-data.js:246` sends Duke an `Origin` and a
`Referer` and would 403 without them; USGS answers Python's default agent with a bare 403 from
the Cloudflare edge, which reads as a broken route and is not one. Those are carried below and
are the reason a naive curl of the same URL behaves differently from the Worker.

THIS FETCHES PAGES AS WELL AS APIS. `anglersheadquarters.com`, `lakemonster.com`,
`santeecooper.com`, `cubecarolinas.com`, `southernco.com` are scraped HTML, not JSON. They are
captured anyway -- `audit_upstream_fields.py` will skip them because it reads JSON and RDB, and
"captured but not auditable" is a truthful state that a missing file is not.

READ-ONLY against the app. Writes only into --out.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA = 'trollmap-capture/1.0 (+personal use; https://github.com/colonal1981/TrollMap-Dev)'
URL_LIT = re.compile(r'([`"\'])(https://[^`"\'\s\\]{12,})\1')
HOLE = re.compile(r'\$\{([^}]*)\}')
CODE_EXT = ('.js', '.mjs', '.cjs', '.py')
# `test/` holds FIXTURE urls -- example.com, x.gov, whitehouse.gov -- that the app never calls.
# `Scripts/` holds THIS FILE and its siblings, which quote every endpoint they probe; indexing
# them makes the scan find its own homework, which is the same bug the field auditor had.
SKIP_DIRS = {'node_modules', '.git', 'dist', 'build', '_to_delete', 'coverage', '__pycache__',
             'test', 'tests', '__tests__', 'Scripts', 'scripts'}

# NOT DATA. Every one of these is a real call the app makes and none of them is an upstream whose
# response we would ever audit for fishing data.
DENY_HOST = (
    # asset delivery and basemaps
    'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'tile.openstreetmap.org',
    'arcgisonline.com', 'basemap.nationalmap.gov', 'fonts.g',
    # model providers
    'api.groq.com', 'api.cerebras.ai', 'openrouter.ai', 'generativelanguage.googleapis.com',
    'api.openai.com', 'api.anthropic.com',
    # fetch/scrape brokers -- these carry tokens and return OTHER sites' bytes, not their own
    'api.scrape.do', 'r.jina.ai', 's.jina.ai', 'api.firecrawl.dev', 'api.tavily.com',
    'tinyfish.ai',
    # infrastructure, analytics, self
    'api.cloudflare.com', 'googletagmanager', 'google-analytics', 'github.com',
    'google.com/maps', 'workers.dev', 'trollmap.dev', '.r2.dev',
    'nominatim.openstreetmap.org', 'www.openstreetmap.org',   # geocoder / deep link, not data
    'lakes.hydro-derived.duke-energy.app',                    # this is Duke's Origin/Referer
                                                              # HEADER VALUE, not an endpoint
)
# printf-style placeholders left for later substitution are holes too. Fetching `/thumbnail/%s/`
# gets a 404 and teaches nothing.
PRINTF = re.compile(r'%[sdif]')

# ── BASE CONSTANTS THAT NEED COMPLETING ─────────────────────────────────────────────────────
#
# Some URL literals in the code are PREFIXES. The app appends the query at call time, so the
# string in the source is not a request anyone could make. Fetching it verbatim returns 400 and
# reads as "this endpoint is broken" -- which is how the first sweep lost the six most
# interesting responses in the whole app: the series catalogue, the daily statistics, CO-OPS,
# the Water Quality Portal, USNO and the TVA API.
#
# So each prefix gets ONE known-complete form. These are not invented: every one is the shape
# the app itself builds, or the shape verified by hand on 2026-08-24. A completed URL is MARKED
# in the output, because fetching something the source does not literally contain is a claim and
# should look like one.
COMPLETIONS = [
    ('nwis/site/?format=rdb&seriesCatalogOutput=true',
     'https://waterservices.usgs.gov/nwis/site/?format=rdb&seriesCatalogOutput=true'
     '&outputDataTypeCd=iv&sites=${site}',
     'conditions.js:siteParameters appends outputDataTypeCd and sites', ('sites=',)),
    ('nwis/stat/?format=rdb&statReportType=daily',
     'https://waterservices.usgs.gov/nwis/stat/?format=rdb&statReportType=daily'
     '&statTypeCd=p10,p25,p50,p75,p90&parameterCd=00060&sites=${site}',
     'conditions.js:flowVsHistory appends statTypeCd, parameterCd and sites', ('sites=',)),
    ('api/prod/datagetter',
     'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=water_temperature'
     '&station=${coopsStation}&date=latest&units=english&time_zone=lst_ldt&format=json'
     '&application=TrollMap_personal',
     'verified live 2026-08-24: Charleston 8665530 returned 86.2 degF', ('station=',)),
    ('waterqualitydata.us/data/Result/search',
     'https://www.waterqualitydata.us/data/Result/search?siteid=USGS-${site}'
     '&characteristicName=Temperature%2C%20water&mimeType=csv&zip=no&startDateLo=01-01-2025',
     'bounded to one site and one characteristic so the sweep stays small', ('siteid=',)),
    ('aa.usno.navy.mil/api/rstt/oneday',
     'https://aa.usno.navy.mil/api/rstt/oneday?date=${date}&coords=${lat},${lon}&tz=${tz}',
     'the bare date 400s; coords and tz are required', ('coords=',)),
    ('tva.com/RestApi',
     'https://www.tva.com/RestApi/locations?format=json',
     'the base 404s; ?format=json or ServiceStack serves an HTML snapshot page',
     ('/RestApi/',)),
    # THE TIMESERIES RESPONSE, NOT THE CATALOGUE. Both `usaceRelease` and the level readers build
    # their URLs from the bare `CWMS` constant at call time, so the scan finds one base literal
    # and gets one request out of it -- and the catalogue's field set is already captured in
    # `_captures/cwms-data..._catalog_TIMESERIES...json`, while the DATA envelope's is not.
    # That envelope is where the trap lives: it carries `value-columns`, `quality-code`, and a
    # `units` that DISAGREES WITH THE CATALOGUE'S for the same series -- "m" there, "ft" here,
    # verified live 2026-08-25. An auditor that has never seen it cannot report on it.
    ('cwms-data.usace.army.mil/cwms-data',
     'https://cwms-data.usace.army.mil/cwms-data/timeseries'
     '?name=Hartwell.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS&office=SAS',
     'NO unit= on purpose: the catalogue says "m" and this endpoint says "ft" for the SAME '
     'series, and converting on the catalogue would report 2,138 ft for a lake at 651.59',
     ('/timeseries',)),
    # The National Water Dashboard's OData service. `dashboardUrl` builds the $filter from the
    # binding's own site numbers, so the literal in the source is a bare collection URL that
    # returns the whole national feed or an error depending on the day.
    ('dashboard.waterdata.usgs.gov/service/cwis/1.0/odata/CurrentConditions',
     "https://dashboard.waterdata.usgs.gov/service/cwis/1.0/odata/CurrentConditions"
     "?%24filter=(AccessLevelCode%20eq%20'P')%20and%20(SiteNumber%20in('02168500'%2C'02175148'))"
     '&%24select=SiteNumber%2CParameterCode%2CTimeLocal%2CTimeZoneCode%2CValue%2CValueFlagCode'
     '%2CRateOfChangeUnitPerHour%2CFloodStageStatusCode&%24top=500&caller=TrollMap%20personal%20use',
     'verified live 2026-08-25: the SiteNumber filter answers. Bounded to two bound sites so '
     'the sweep stays small -- unfiltered this collection is the whole country',
     # ONE required token, not two. `any(tok not in u)` with both spellings would fire on a URL
     # that already carries %24filter, overwriting a complete request -- which is the exact case
     # this file's self-test was written to catch.
     ('%24filter',)),
]


def complete(u):
    """(url, why_completed or None). A prefix in the source becomes one real request.

    A URL is treated as a PREFIX only when it is missing a token a complete request must carry --
    `sites=`, `station=`, `coords=`. Comparing lengths instead, as the first attempt did, would
    overwrite a genuinely complete URL that happened to be shorter than the template. The
    self-test carries that exact case.
    """
    for needle, full, why, required in COMPLETIONS:
        if needle in u and any(tok not in u for tok in required):
            return full, why
    return u, None
# A hole named like a credential means the URL carries a secret. NEVER resolve or fetch one.
CREDENTIAL_HOLE = re.compile(r'token|key|secret|passw|auth|bearer', re.I)

# Headers a host needs, copied from what the app itself sends. Without these the same URL that
# works in the Worker fails here, which would read as "endpoint dead" and would be wrong.
HOST_HEADERS = {
    'api.hydro-derived.duke-energy.app': {
        'Origin': 'https://lakes.hydro-derived.duke-energy.app',
        'Referer': 'https://lakes.hydro-derived.duke-energy.app/',
        'Accept': 'application/json'},
}
# Hosts whose API wants a format nudge or it serves an HTML snapshot page instead.
HOST_QUERY = {
    'www.tva.com': {'format': 'json'},
}
# Holes we can fill without the user telling us. Anything not here is reported, never guessed.
_PARMS = '00062,62614,62615,63160,00065,00060,00010,00300,63680,72137,00095,00480'
CONSTANTS = {
    'paramCd': _PARMS, 'params': _PARMS, 'parameterCd': _PARMS,
    'periodDays': '2', 'days': '2', 'office': 'SAS', 'format': 'json',
    # Duke LocationId 17 is Jocassee, read off a real /lakes/current-level response.
    'dukeLocId': '17',
    # CO-OPS Charleston -- the station this project verified by hand.
    'coopsStation': '8665530', 'station': '8665530',
    'tz': '-4',
}


def strip_expr(e):
    """`encodeURIComponent(lid)` -> `lid`; `a.b` -> `b`; anything else unchanged."""
    e = e.strip()
    m = re.match(r'^\s*encodeURIComponent\s*\(\s*(.+?)\s*\)\s*$', e)
    if m:
        e = m.group(1).strip()
    return e.split('.')[-1].strip()


def scan(repo):
    """{template: {'holes': [...], 'sites': [(file,line)...]}} -- every https:// literal."""
    found = {}
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if not f.endswith(CODE_EXT):
                continue
            p = os.path.join(root, f)
            try:
                t = open(p, encoding='utf-8', errors='replace').read()
            except OSError:
                continue
            rel = os.path.relpath(p, repo)
            for m in URL_LIT.finditer(t):
                u = m.group(2)
                line = t[:m.start()].count('\n') + 1
                rec = found.setdefault(u, {'holes': [strip_expr(h) for h in HOLE.findall(u)],
                                           'sites': []})
                rec['sites'].append((rel, line))
    return found


def resolve(template, subst):
    """(url, unresolved[]) -- fill ${...} from subst, report what is missing."""
    missing = []

    def rep(m):
        k = strip_expr(m.group(1))
        if k in subst and subst[k] not in (None, ''):
            return urllib.parse.quote(str(subst[k]), safe='')
        missing.append(k)
        return m.group(0)
    return HOLE.sub(rep, template), missing


def classify(template, holes):
    """'data' | why-it-was-skipped. The reason travels so a skip can be argued with."""
    pu = urllib.parse.urlparse(template)
    host = pu.netloc.lower()
    if not host:
        return 'no host'
    for h in holes:
        if CREDENTIAL_HOLE.search(h):
            return 'carries a credential (%s) -- never fetched' % h
    if '.' not in host.split(':')[0]:
        return 'fixture host'                       # https://x/... , https://worker/...
    if any(d in host or d in template.lower() for d in DENY_HOST):
        return 'not a data upstream'
    if host.startswith('example.') or host.endswith('.invalid') or host.startswith('w.'):
        return 'fixture host'
    if PRINTF.search(template):
        return 'printf placeholder, not a real URL'
    # A bare origin is a BASE CONSTANT the code concatenates onto -- fetching it returns a
    # homepage, which is not the upstream and would pollute the audit with page furniture.
    if pu.path in ('', '/') and not pu.query:
        return 'origin only -- a base constant, not an endpoint'
    return 'data'


def slugify(u):
    pu = urllib.parse.urlparse(u)
    base = (pu.netloc + pu.path).replace('/', '_').strip('_')
    q = re.sub(r'[^A-Za-z0-9]+', '', pu.query)[:24]
    s = re.sub(r'[^A-Za-z0-9._-]+', '-', base)[:90]
    return s + ('__' + q if q else '')


def ext_for(ctype, body):
    c = (ctype or '').lower()
    if 'json' in c:
        return 'json'
    if 'xml' in c:
        return 'xml'
    if 'html' in c:
        return 'html'
    head = body[:200].lstrip()
    if head.startswith(b'{') or head.startswith(b'['):
        return 'json'
    if head.startswith(b'<'):
        return 'xml' if head.startswith(b'<?xml') else 'html'
    return 'txt'


def fetch(u, timeout):
    pu = urllib.parse.urlparse(u)
    q = HOST_QUERY.get(pu.netloc)
    if q:
        parts = urllib.parse.parse_qs(pu.query)
        for k, v in q.items():
            parts.setdefault(k, [v])
        u = urllib.parse.urlunparse(pu._replace(
            query=urllib.parse.urlencode({k: v[0] for k, v in parts.items()})))
    hdr = {'User-Agent': UA, 'Accept': '*/*'}
    hdr.update(HOST_HEADERS.get(pu.netloc, {}))
    req = urllib.request.Request(u, headers=hdr)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(), r.status, r.headers.get('Content-Type'), None
    except urllib.error.HTTPError as exc:
        return None, exc.code, None, str(exc.reason)
    except urllib.error.URLError as exc:
        return None, 0, None, 'unreachable: %s' % exc.reason
    except Exception as exc:                                     # noqa: BLE001
        return None, 0, None, '%s: %s' % (type(exc).__name__, exc)


def pick_water(B, want):
    best = None
    for slug, r in B.items():
        if want and want.lower() not in (slug + ' ' + (r.get('display_name') or '')).lower():
            continue
        site = lid = None
        for g in [r.get('pool'), r.get('tailwater')] + list(r.get('gauges') or []):
            if isinstance(g, dict):
                site = site or g.get('usgs_site')
                lid = lid or g.get('lid')
        c = r.get('centroid') or []
        lat, lon = (c[1], c[0]) if isinstance(c, list) and len(c) == 2 else (None, None)
        score = sum(1 for x in (site, lid, lat) if x)
        if best is None or score > best[0]:
            best = (score, slug, r.get('display_name'), site, lid, lat, lon)
        if score == 3 and want:
            break
    return best


def self_test():
    ok = True

    def check(label, got, want):
        nonlocal ok
        if got != want:
            ok = False
            print('FAIL %-52s got %r want %r' % (label, got, want))
        else:
            print('ok   %-52s %r' % (label, got))

    check('encodeURIComponent unwrapped', strip_expr('encodeURIComponent(lid)'), 'lid')
    check('dotted expr reduced', strip_expr('cfg.river'), 'river')
    check('plain identifier kept', strip_expr(' basinId '), 'basinId')

    u, miss = resolve('https://x/gauges/${encodeURIComponent(lid)}/stageflow', {'lid': 'WATS1'})
    check('hole filled from bindings', u, 'https://x/gauges/WATS1/stageflow')
    check('nothing reported missing', miss, [])
    u2, miss2 = resolve('https://x/rivers/flow-arrivals/${basinId}', {})
    check('unfillable hole is REPORTED not guessed', miss2, ['basinId'])
    check('template left intact when unresolved', u2.endswith('${basinId}'), True)

    src = '/tmp/_cap_selftest'
    os.makedirs(src, exist_ok=True)
    open(os.path.join(src, 'a.js'), 'w').write(
        'const a = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";\n'
        'const b = `https://waterservices.usgs.gov/nwis/iv/?sites=${site}&period=P${periodDays}D`;\n'
        'const c = "https://www.tva.com/RestApi";\n')
    f = scan(src)
    check('scanner found all three', len(f), 3)
    tmpl = [k for k in f if 'nwis/iv' in k][0]
    check('holes captured', sorted(f[tmpl]['holes']), ['periodDays', 'site'])
    check('file and line recorded', f[tmpl]['sites'][0][0], 'a.js')

    check('duke gets its Origin header', 'Origin' in HOST_HEADERS['api.hydro-derived.duke-energy.app'], True)
    check('tva gets format=json nudged in', HOST_QUERY['www.tva.com']['format'], 'json')
    check('json sniffed without a content-type', ext_for(None, b'  [{"a":1}]'), 'json')
    # THE BUG THAT LOST SIX ENDPOINTS: a prefix fetched verbatim 400s and reads as broken.
    full, why = complete('https://waterservices.usgs.gov/nwis/stat/?format=rdb&statReportType=daily')
    check('stat prefix is completed', 'statTypeCd' in full and 'sites=' in full, True)
    check('completion states its reason', bool(why), True)
    full2, _ = complete('https://www.tva.com/RestApi')
    check('tva base becomes a real call', full2, 'https://www.tva.com/RestApi/locations?format=json')
    same, why2 = complete('https://waterservices.usgs.gov/nwis/iv/?sites=1&parameterCd=2')
    check('a complete url is left alone', why2, None)
    long_ = ('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=x&station=y'
             '&date=latest&units=english&time_zone=lst_ldt&format=json&application=z&extra=1')
    check('a longer real url is not overwritten', complete(long_)[1], None)
    check('rdb-ish text falls through to txt', ext_for(None, b'# USGS\nagency\tsite'), 'txt')
    print('\n%s' % ('SELF-TEST PASSED' if ok else 'SELF-TEST FAILED'))
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--repo', default='TrollMap-Dev')
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--out', default='_captures')
    ap.add_argument('--water', default=None)
    ap.add_argument('--host', default=None, help='only URLs whose host contains this')
    ap.add_argument('--subst', action='append', default=[], help='fill a hole: --subst basinId=2')
    ap.add_argument('--timeout', type=float, default=90.0)
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--all', action='store_true',
                    help='include CDNs, basemaps, model providers and fixtures (normally hidden)')
    ap.add_argument('--self-test', action='store_true')
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    if not os.path.isdir(a.repo):
        print('FATAL: --repo %s is not a folder.' % a.repo)
        return 2

    import datetime as _dt
    today = _dt.date.today().isoformat()
    subst = dict(CONSTANTS)
    subst.update({'date': today, 'dateOnly': today, 'startDate': today, 'endDate': today})
    p = os.path.join(a.registry, 'water_bindings.json')
    if os.path.exists(p):
        B = json.load(open(p, encoding='utf-8')).get('bindings') or {}
        best = pick_water(B, a.water)
        if best:
            _, slug, dn, site, lid, lat, lon = best
            subst.update({'site': site, 'siteNo': site, 'sites': site, 'lid': lid,
                          'gauge': lid, 'lat': lat, 'lon': lon, 'latitude': lat,
                          'longitude': lon, 'slug': slug})
            print('water   %s  [%s]\n        site=%s lid=%s lat=%s lon=%s\n'
                  % (dn or slug, slug, site, lid, lat, lon))
    else:
        print('!! %s not found -- site/lid/lat/lon holes will be reported unresolved\n' % p)
    for kv in a.subst:
        if '=' in kv:
            k, v = kv.split('=', 1)
            subst[k.strip()] = v.strip()

    found = scan(a.repo)
    if a.host:
        found = {u: r for u, r in found.items() if a.host.lower() in u.lower()}
    print('URL literals in %s: %d\n' % (os.path.abspath(a.repo), len(found)))

    plan, unresolved, skipped = [], [], collections.Counter()
    completed = 0
    for u, rec in sorted(found.items()):
        full, why_c = complete(u)
        holes = rec['holes'] if not why_c else [strip_expr(h) for h in HOLE.findall(full)]
        why = classify(full, holes)
        if why != 'data' and not a.all:
            skipped[why] += 1
            continue
        url, missing = resolve(full, subst)
        if missing:
            unresolved.append((full, sorted(set(missing)), rec['sites'][0]))
        else:
            if why_c:
                completed += 1
            plan.append((url, rec['sites'][0], why_c))

    if skipped:
        print('skipped %d (use --all to see them):' % sum(skipped.values()))
        for why, n in skipped.most_common():
            print('   %-44s %d' % (why, n))
        print()

    if a.list:
        byhost = collections.defaultdict(list)
        for url, site, why_c in plan:
            byhost[urllib.parse.urlparse(url).netloc].append((url, site, why_c))
        print('%d URL(s) to fetch across %d hosts   (%d completed from a base constant)\n'
              % (len(plan), len(byhost), completed))
        for host in sorted(byhost):
            print('%s  (%d)' % (host, len(byhost[host])))
            for url, (f, l), why_c in sorted(byhost[host]):
                pu = urllib.parse.urlparse(url)
                tail = pu.path + ('?' + pu.query if pu.query else '')
                print('    %-76s %s:%s' % ((tail or '/')[:76], f, l))
                if why_c:
                    print('      ^ COMPLETED: %s' % why_c)
            print()
        if unresolved:
            print('%d unresolved -- pass --subst NAME=VALUE to fill:' % len(unresolved))
            for u, miss, (f, l) in unresolved:
                print('   %-72s needs %-16s %s:%s' % (u[:72], ','.join(miss), f, l))
        return 0

    os.makedirs(a.out, exist_ok=True)
    manifest, byhost = [], collections.Counter()
    print('%-58s %-6s %-9s %s' % ('URL', 'STATUS', 'BYTES', 'SAVED AS'))
    for url, (f, l), why_c in plan:
        body, status, ctype, err = fetch(url, a.timeout)
        host = urllib.parse.urlparse(url).netloc
        byhost[host] += 1
        if body is None:
            print('%-58s %-6s %-9s %s' % (url[:58], status or '-', '-', err))
            manifest.append({'url': url, 'from': '%s:%s' % (f, l), 'status': status,
                             'error': err, 'completed': why_c})
            continue
        name = '%s.%s' % (slugify(url), ext_for(ctype, body))
        with open(os.path.join(a.out, name), 'wb') as fh:
            fh.write(body)
        print('%-58s %-6d %-9d %s' % (url[:58], status, len(body), name[:44]))
        manifest.append({'url': url, 'from': '%s:%s' % (f, l), 'status': status,
                         'bytes': len(body), 'file': name, 'content_type': ctype,
                         'completed': why_c})
        time.sleep(0.3)

    print('\nhosts touched: %d' % len(byhost))
    if unresolved:
        print('\n%d URL(s) COULD NOT BE RESOLVED -- reported, not guessed:' % len(unresolved))
        for u, miss, (f, l) in unresolved:
            print('   %-80s needs %-18s %s:%s' % (u[:80], ','.join(miss), f, l))
        print('   supply one with --subst NAME=VALUE and re-run.')
    with open(os.path.join(a.out, '_manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump({'_note': 'Every https:// literal found in the repo, resolved and fetched. '
                            'Built by capture_upstreams.py.',
                   'captured': manifest,
                   'unresolved': [{'template': u, 'needs': m, 'at': '%s:%s' % (f, l)}
                                  for u, m, (f, l) in unresolved]}, fh, indent=1)
    print('\nNext:\n  py .\\scripts\\audit_upstream_fields.py --repo %s --dir %s' % (a.repo, a.out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
