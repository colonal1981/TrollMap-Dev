#!/usr/bin/env python3
"""Read any PUBLIC LI-COR Cloud (Davra) dashboard: discover its sensors, pull their data.

Personal use only, not for distribution or resale; not for navigation.

NO CREDENTIALS. No Authorization header, no cookie, no key, and it must never be
given one. The call is authorised by `dashboardUUID` in the body -- the public
dashboard's own id -- which is why bare requests to the endpoint 404: without it
the server has no idea what is being asked for.

RUN FROM POWERSHELL, NOT COWORK. The Cowork VM egress proxy refuses licor.cloud
with "Tunnel connection failed: 403 Forbidden".
    cd F:\\TrollMapPipeline
    py scripts\\fetch_licor_dashboard.py --dashboard 66308fa1-1b12-4db4-b581-06e1003268d9

The request shape is NOT inferred -- it was captured from the browser on 2026-08-27
and is reproduced exactly. Nothing here is hand written per dashboard: the sensor
list, metric names, channel ids and units are all read from the config endpoint, so
this works on any public LI-COR dashboard, not just Randleman's.

  PTRWA / Randleman Lake   66308fa1-1b12-4db4-b581-06e1003268d9
"""
import argparse, json, re, sys, urllib.error, urllib.request
from datetime import datetime, timezone

BASE = 'https://www.licor.cloud'

def call(url, body=None, referer=None):
    hdr = {'User-Agent': 'TrollMap/1.0 (personal use)',
           'Accept': 'application/json, text/plain, */*',
           'Accept-Language': 'en-US,en;q=0.9'}
    if referer:
        hdr['Origin'] = BASE
        hdr['Referer'] = referer
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdr['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=hdr,
                                 method='POST' if data else 'GET')
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:
        return 0, '%s: %s' % (type(e).__name__, e)

def discover(cfg):
    """Walk the dashboard config and yield every sensor it charts."""
    out = []
    for page in (cfg.get('pages') or []):
        for w in (page.get('grid') or []):
            c = w.get('config') or {}
            for m in (c.get('metrics') or []):
                ts = m.get('timeseries') or {}
                chans = ((ts.get('tags') or {}).get('dataChannel') or [])
                if not ts.get('metricName') or not chans:
                    continue
                out.append({
                    'title': m.get('name') or c.get('title') or w.get('name'),
                    'metricName': ts['metricName'],
                    'channelUUID': chans[0],
                    'serial': m.get('sensorSerialNumber'),
                    'units': m.get('metricUnits'),
                    'measurement': m.get('onsetMeasurementType'),
                })
    return out

def parse_interval(txt):
    m = re.fullmatch(r'(\d+)\s*([smhd])', txt.strip().lower())
    if not m:
        raise SystemExit('bad --interval %r; use e.g. 30s, 15m, 1h, 1d' % txt)
    n, u = int(m.group(1)), m.group(2)
    return {'value': n, 'unit': {'s': 'seconds', 'm': 'minutes',
                                 'h': 'hours', 'd': 'days'}[u]}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dashboard', required=True)
    ap.add_argument('--days', type=int, default=1)
    ap.add_argument('--limit', type=int, default=10000)
    ap.add_argument('--interval', default=None,
                    help='bucket size, e.g. 30s 15m 1h 1d. Default adapts to --days.')
    ap.add_argument('--out-dir', default='_pagesrc')
    a = ap.parse_args()
    if a.interval:
        interval = parse_interval(a.interval)
    elif a.days <= 2:    interval = {'value': 30, 'unit': 'seconds'}
    elif a.days <= 60:   interval = {'value': 1, 'unit': 'hours'}
    else:                interval = {'value': 1, 'unit': 'days'}
    ref = '%s/dashboards/public/%s/true' % (BASE, a.dashboard)

    st, txt = call('%s/api/v2/dashboards/%s' % (BASE, a.dashboard))
    if st != 200:
        print('config HTTP %s: %s' % (st, txt[:300])); return 1
    cfg = json.loads(txt).get('value') or {}
    print('dashboard : %s  (tenant %s)' % (cfg.get('name'), cfg.get('tenantId')))
    sensors = discover(cfg)
    if not sensors:
        print('no charted sensors found'); return 1
    print('sensors   : %d   window %d day(s)   bucket %s %s'
          % (len(sensors), a.days, interval['value'], interval['unit']))

    body = {'channels': [{'channelUUID': s['channelUUID'], 'channelType': 'dataChannel',
                          'metricName': s['metricName'], 'limit': a.limit,
                          'aggregationFunction': 'avg',
                          'aggregationInterval': interval} for s in sensors],
            'time': {'relative': {'last': a.days, 'unit': 'days'}},
            'dashboardUUID': a.dashboard}
    st, txt = call('%s/api/v2/timeseriesdata' % BASE, body, referer=ref)
    print('timeseriesdata HTTP %s  (%d bytes)' % (st, len(txt)))
    if st != 200:
        print(txt[:600]); return 1
    path = '%s/licor_%s_%dd.json' % (a.out_dir, a.dashboard[:8], a.days)
    open(path, 'w', encoding='utf-8').write(txt)
    print('saved -> %s\n' % path)

    for rec in (json.loads(txt).get('value') or {}).get('records') or []:
        pts = [(t, v) for t, v in (rec.get('datum') or {}).get('valid') or []
               if isinstance(v, (int, float))]
        label = rec.get('sensorLabel') or rec.get('metricName')
        units = rec.get('metricUnits') or ''
        print('%s  [%s]' % (label, rec.get('metricName')))
        if not pts:
            print('   no valid points\n'); continue
        vals = sorted(v for _, v in pts)
        lo, hi = vals[0], vals[-1]
        p99 = vals[int(len(vals) * 0.99) - 1] if len(vals) >= 100 else hi
        print('   %d points  %s .. %s' % (len(pts), _when(rec.get('firstTimestamp')),
                                          _when(rec.get('lastTimestamp'))))
        print('   latest %.4f %s  @ %s' % (pts[-1][1], units, _when(pts[-1][0])))
        print('   min %.4f   p99 %.4f   max %.4f %s' % (lo, p99, hi, units))
        if 'Water Level' in (rec.get('metricName') or '') or units == 'feet':
            if hi < 100:
                print('   -> STAGE (feet above the sensor). Cannot give full pool.')
            else:
                print('   -> ABSOLUTE MSL ELEVATION.')
                top = [v for v in vals if v >= hi - 0.25]
                print('      %d of %d readings (%.1f%%) sit within 0.25 ft of the max.'
                      % (len(top), len(vals), 100.0 * len(top) / len(vals)))
                print('      A spilling reservoir PLATEAUS at full pool. A fat plateau')
                print('      here is evidence the max IS the datum; a lone spike is not.')
        print()
    return 0

def _when(t):
    try:
        n = float(t)
        if n > 1e11:
            n /= 1000.0
        return datetime.fromtimestamp(n, timezone.utc).astimezone().strftime('%Y-%m-%d %H:%M')
    except Exception:
        return str(t)

if __name__ == '__main__':
    sys.exit(main())
