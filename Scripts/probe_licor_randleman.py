#!/usr/bin/env python3
"""Probe the PTRWA / LI-COR Cloud (Davra) feed for Randleman Lake water level.

Personal use only, not for distribution or resale; not for navigation.

NO CREDENTIALS. Sends no Authorization header, no cookie, no key, and must never
be given one. If the endpoint needs auth it is not a public feed and we stop.

RUN THIS FROM POWERSHELL, NOT FROM COWORK. The Cowork VM's egress proxy refuses
licor.cloud with "Tunnel connection failed: 403 Forbidden".
    cd F:\\TrollMapPipeline
    py scripts\\probe_licor_randleman.py

The dashboard config (confirmed 200) says LI-COR Cloud is Davra underneath --
filter type "davra", tenant "onsetprd". The Water Level widget carries this
query object verbatim, so candidate 1 below is that object, not a guess:
    metricName com.onset.sensordata.waterlevel_us
    aggregator avg, bucketunit minutes, bucketvalue 1
    tags.dataChannel [6a8fcf43-1bcf-455f-a569-8f9e6eeb0cff]
Davra timestamps are EPOCH MILLISECONDS; ISO strings are tried too, second.
"""
import json, sys, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

BASE = 'https://www.licor.cloud/api'
DASH = '66308fa1-1b12-4db4-b581-06e1003268d9'
CHAN = '6a8fcf43-1bcf-455f-a569-8f9e6eeb0cff'
SERIAL = '20895081-4'
METRIC = 'com.onset.sensordata.waterlevel_us'
UA = {'User-Agent': 'TrollMap/1.0 (personal use)', 'Accept': 'application/json'}

def call(url, body=None):
    data = None if body is None else json.dumps(body).encode()
    hdr = dict(UA)
    if data:
        hdr['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=hdr,
                                 method='POST' if data else 'GET')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:
        return 0, '%s: %s' % (type(e).__name__, e)

def main():
    now = datetime.now(timezone.utc)
    then = now - timedelta(days=7)
    ms_e, ms_s = int(now.timestamp() * 1000), int(then.timestamp() * 1000)
    iso_e = now.strftime('%Y-%m-%dT%H:%M:%SZ')
    iso_s = then.strftime('%Y-%m-%dT%H:%M:%SZ')

    print('=== 1. dashboard config (expected 200) ===')
    st, txt = call('%s/v2/dashboards/%s' % (BASE, DASH))
    print('HTTP', st, '-', len(txt), 'bytes')
    if st != 200:
        print(txt[:300])
        print('If this one fails too, the whole host is unreachable from here.')

    widget = {'metricName': METRIC, 'aggregator': 'avg', 'bucketunit': 'minutes',
              'bucketvalue': 1, 'aggregatorType': 'auto',
              'aggregatorMultiplicator': 1, 'tags': {'dataChannel': [CHAN]}}
    qs = urllib.parse.urlencode

    cands = []
    for ver in ('v2', 'v1'):
        for path in ('timeseriesdata', 'timeseriesData'):
            u = '%s/%s/%s' % (BASE, ver, path)
            cands += [
                ('POST widget+ms   %s/%s' % (ver, path), u,
                 dict(widget, start=ms_s, end=ms_e)),
                ('POST widget+iso  %s/%s' % (ver, path), u,
                 dict(widget, start=iso_s, end=iso_e)),
                ('POST query-wrap  %s/%s' % (ver, path), u,
                 {'query': [widget], 'start': ms_s, 'end': ms_e}),
                ('GET  metric+tag  %s/%s' % (ver, path),
                 u + '?' + qs({'metricName': METRIC,
                               'tags': 'dataChannel:' + CHAN,
                               'start': ms_s, 'end': ms_e, 'aggregator': 'avg',
                               'bucketunit': 'minutes', 'bucketvalue': 1}), None),
                ('GET  serial      %s/%s' % (ver, path),
                 u + '?' + qs({'metricName': METRIC, 'UUID': SERIAL,
                               'start': ms_s, 'end': ms_e,
                               'aggregator': 'avg'}), None),
            ]

    print('\n=== 2. %d candidate requests ===' % len(cands))
    win = None
    for label, url, body in cands:
        st, txt = call(url, body)
        head = txt[:180].replace('\n', ' ')
        flag = ' <== 200' if st == 200 else ''
        print('  %-26s HTTP %-4s %s%s' % (label, st, head, flag))
        if st == 200 and 'success' in txt and win is None:
            win = (label, url, body, txt)

    if not win:
        print('\nNone returned 200. Get the real request instead:')
        print('  dashboard in Chrome -> F12 -> Network -> filter "timeseriesdata"')
        print('  -> right-click -> Copy -> Copy as cURL')
        print('  STRIP any authorization/cookie header before sharing it. If it cannot')
        print('  work without one, it is not a public feed and we stop here.')
        return 1

    label, url, body, txt = win
    print('\n=== WORKING: %s ===' % label)
    print('url :', url)
    print('body:', json.dumps(body) if body else '(none, GET)')
    out = '_pagesrc/licor_randleman_level.json'
    open(out, 'w', encoding='utf-8').write(txt)
    print('saved ->', out, '(%d bytes)' % len(txt))
    vals = sorted(v for v in _nums(json.loads(txt)) if 1e6 > abs(v) > 0)
    if vals:
        print('\n%d numeric values   min %.3f   max %.3f' % (len(vals), vals[0], vals[-1]))
        print('READ BEFORE USING: an Onset HOBO waterlevel_us series is feet referenced')
        print('to the SENSOR unless the deployment was set to an msl datum.')
        if vals[-1] < 100:
            print('  -> max under 100 ft: this is STAGE. It cannot give full pool.')
        else:
            print('  -> max in the hundreds: possibly msl elevation. Still a READING,')
            print('     not full pool -- full pool is the maximum, caught spilling.')
    return 0

def _nums(o):
    if isinstance(o, dict):
        for v in o.values():
            yield from _nums(v)
    elif isinstance(o, list):
        for v in o:
            yield from _nums(v)
    elif isinstance(o, (int, float)) and not isinstance(o, bool):
        yield float(o)

if __name__ == '__main__':
    sys.exit(main())
