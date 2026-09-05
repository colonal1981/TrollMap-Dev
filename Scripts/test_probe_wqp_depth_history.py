"""test_probe_wqp_depth_history.py -- run with `py .\scripts\test_probe_wqp_depth_history.py`.

The network call cannot be exercised from the session's container (the proxy blocks
waterqualitydata.us), so what is tested here is everything that decides the ANSWER: the two
column dialects, the metre-to-foot rule, the summer window, the 2 ft bins, and the split between
records the Worker's 2015 window can see and the ones it cannot.

THE CENTRAL ASSERTION IS THAT THE DIALECT DOES NOT CHANGE THE NUMBER. The same eight readings are
written once as a WQX 2.2 response and once as a WQX 3.0 response, and the census must agree.
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import probe_wqp_depth_history as P

FAILS = []
RAN = []


def check(name, got, want):
    RAN.append(name)                     # counted, not typed -- a hand-kept total goes stale
    if got != want:
        FAILS.append('%s: got %r, want %r' % (name, got, want))


# Eight readings on one lake:
#   1983 summer DO at 1, 11 and 21 ft   -- before the window, three summer bins
#   2019 summer DO at 3 m               -- inside the window, metres, = 9.8 ft
#   2019 WINTER DO at 15 ft             -- inside the window, not summer
#   2019 summer TEMPERATURE at 15 ft    -- a depth record, but not DO
#   2019 summer DO with NO depth        -- a reading with no depth is not a depth record
#   2019 summer DO at 5 ft, no value    -- a depth on a row with no reading is not a reading
ROWS = [
    # date,        char,                     value,  depth, unit
    ('1983-07-14', 'Dissolved oxygen (DO)',  '8.1',  '1',   'ft'),
    ('1983-07-14', 'Dissolved oxygen (DO)',  '5.2',  '11',  'ft'),
    ('1983-07-14', 'Dissolved oxygen (DO)',  '1.1',  '21',  'ft'),
    ('2019-08-02', 'Dissolved oxygen (DO)',  '7.4',  '3',   'm'),
    ('2019-01-09', 'Dissolved oxygen (DO)',  '9.9',  '15',  'ft'),
    ('2019-08-02', 'Temperature, water',     '81.2', '15',  'ft'),
    ('2019-08-02', 'Dissolved oxygen (DO)',  '6.6',  '',    ''),
    ('2019-08-02', 'Dissolved oxygen (DO)',  '',     '5',   'ft'),
]

LEGACY_HEAD = ('MonitoringLocationIdentifier,OrganizationIdentifier,ActivityStartDate,CharacteristicName,ResultMeasureValue,'
               'ActivityDepthHeightMeasure/MeasureValue,ActivityDepthHeightMeasure/MeasureUnitCode,'
               'ResultDepthHeightMeasure/MeasureValue,ResultDepthHeightMeasure/MeasureUnitCode')
WQX3_HEAD = ('Location_Identifier,Org_Identifier,Activity_StartDate,Result_Characteristic,Result_Measure,'
             'Activity_DepthHeightMeasure,Activity_DepthHeightMeasureUnit,'
             'ResultDepthHeight_Measure,ResultDepthHeight_MeasureUnit')


def build(head, org):
    lines = [head]
    for date, char, val, dep, unit in ROWS:
        lines.append('ST-1,%s,%s,"%s",%s,%s,%s,,' % (org, date, char, val, dep, unit))
    return '\n'.join(lines) + '\n'


legacy = P.census(build(LEGACY_HEAD, '21SCSANT'))
wqx3 = P.census(build(WQX3_HEAD, '21SCSANT'))

# 1. The dialect must not change a single number.
check('the two dialects agree', legacy, wqx3)

# 2. The counts themselves.
check('rows', legacy['rows'], 8)
# depth records: 1ft, 11ft, 21ft, 3m, 15ft(winter DO), 15ft(temp) = 6.
# The no-depth row and the no-value row are both excluded.
check('depth records', legacy['depth_recs'], 6)
# summer DO with a depth: the three from 1983 plus the 2019 metres one = 4.
check('summer DO depth records', legacy['summer_do_depth_recs'], 4)
# 2 ft bins over those four: 1ft->0, 11ft->10, 21ft->20, 9.8ft->8. Four rungs.
check('distinct 2 ft bins', legacy['distinct_2ft_bins'], 4)

# 3. METRES ARE NOT FEET. 3 m is 9.8 ft and must never be read as 3.
check('max depth ft', legacy['max_depth_ft'], 21.0)
check('3 m became 9.8 ft', 9.8 in (round(3 * 3.28084, 1),), True)

# 4. What the Worker's 2015 window cannot see, which is the whole point of the script.
check('hidden depth records', legacy['hidden_depth_recs'], 3)
check('hidden summer DO records', legacy['hidden_summer_do_depth_recs'], 3)
check('hidden max depth', legacy['hidden_max_depth_ft'], 21.0)
check('hidden first date', legacy['hidden_first_date'], '1983-07-14')
check('organizations', legacy['organizations'], ['21SCSANT'])

# 5. An empty or header-only body is zeroes, never a crash.
check('deepest is traced to a station', legacy['deepest']['station'], 'ST-1')
check('deepest depth', legacy['deepest']['depthFt'], 21.0)
check('deepest date', legacy['deepest']['date'], '1983-07-14')

check('empty body', P.census('')['rows'], 0)
check('header only', P.census(LEGACY_HEAD + '\n')['depth_recs'], 0)

# 6. The URL for each service, including the omission that matters.
u_legacy = P.wqp_url((-80.15, 33.19, -79.98, 33.40), 'legacy')
u_wqx3 = P.wqp_url((-80.15, 33.19, -79.98, 33.40), 'wqx3')
check('legacy has no startDateLo', 'startDateLo' in u_legacy, False)
check('wqx3 has no startDateLo', 'startDateLo' in u_wqx3, False)
check('legacy profile', 'dataProfile=resultPhysChem' in u_legacy, True)
check('wqx3 profile', 'dataProfile=basicPhysChem' in u_wqx3, True)
check('wqx3 endpoint', '/wqx3/Result/search' in u_wqx3, True)

# 7. THE ZIP PATH. WQP is asked with zip=yes on full-history pulls; the census must never know.
import zipfile
import urllib.request

payload = build(LEGACY_HEAD, '21SCSANT')
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('result.csv', payload)
zipped = buf.getvalue()
check('a zip is smaller than the csv', len(zipped) < len(payload.encode()), True)


class FakeResp:
    def __init__(self, body):
        self.body = body

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


_real = urllib.request.urlopen
try:
    urllib.request.urlopen = lambda req, timeout=None: FakeResp(zipped)
    text, err = P.fetch('https://example.invalid/x')
    check('zip unpacked without error', err, None)
    check('zip round-trips to the same census', P.census(text), legacy)
    urllib.request.urlopen = lambda req, timeout=None: FakeResp(payload.encode())
    text2, err2 = P.fetch('https://example.invalid/x')
    check('a plain CSV body still works', P.census(text2), legacy)
finally:
    urllib.request.urlopen = _real

check('the url asks for the zip', 'zip=yes' in P.wqp_url((0, 0, 1, 1), 'legacy'), True)

# A CUT STREAM IS NOT AN ANSWER, AND WQP PUTS THAT NEWS IN THE BODY.
# The 3.0 service returned Lake Robinson as one row followed by "ERROR: INCOMPLETE DATA ...
# PLEASE RETRY THE REQUEST." and the census stored that sentence as the lake's ORGANISATION.
_cut = (payload.split('\n')[0] + '\n'
        + 'ERROR: INCOMPLETE DATA - THE RESULTS FOR THIS REQUEST ARE NOT COMPLETE AND MORE DATA '
          'IS LIKELY AVAILABLE.  PLEASE RETRY THE REQUEST.\n')
_slept = []
_real_sleep = P.time.sleep
try:
    P.time.sleep = lambda n: _slept.append(n)
    urllib.request.urlopen = lambda req, timeout=None: FakeResp(_cut.encode())
    _t, _e = P.fetch('https://example.invalid/x')
    check('a truncated body is an error, not a census', _t, None)
    check('and it says the service asked for a retry', 'incomplete stream' in (_e or ''), True)
    check('and it retried before giving up', len(_slept), 2)
    _slept.clear()
    urllib.request.urlopen = lambda req, timeout=None: FakeResp(payload.encode())
    _t2, _e2 = P.fetch('https://example.invalid/x')
    check('a clean body still comes back whole', P.census(_t2), legacy)
    check('and a clean body is not retried', _slept, [])
finally:
    P.time.sleep = _real_sleep
    urllib.request.urlopen = _real

# And the reason fetch() has to be the one to catch it: census() cannot. Handed the cut body it
# reads the error line as a row and reports a lake with no records and no error.
_poisoned = P.census(_cut)
check('census cannot tell a cut stream from an empty lake', _poisoned.get('rows'), 1)
check('and it raises no objection', 'error' in _poisoned, False)

# HALF AN ANSWER TO A TWO-PART QUESTION IS NOT AN ANSWER.
# The 3.0 service returned HTTP 500 on Marion, Thurmond and Hartwell while 2.2 answered. `best`
# took the 2.2 leg, no top-level error was written, and --resume would have skipped the three
# biggest lakes for good -- legacy-only, on the exact question the run existed to settle.
_both = ('legacy', 'wqx3')
check('both legs answered is done',
      P.answered({'by_api': {'legacy': {'rows': 1}, 'wqx3': {'rows': 1}}}, _both), True)
check('a failed 3.0 leg is not done',
      P.answered({'by_api': {'legacy': {'rows': 1}, 'wqx3': {'error': 'HTTP 500'}}}, _both), False)
check('a failed 2.2 leg is not done either',
      P.answered({'by_api': {'legacy': {'error': 'HTTP 500'}, 'wqx3': {'rows': 1}}}, _both), False)
check('a leg that was never recorded is not done',
      P.answered({'by_api': {'legacy': {'rows': 1}}}, _both), False)
check('but it IS done when only that leg was asked',
      P.answered({'by_api': {'legacy': {'rows': 1}}}, ('legacy',)), True)
check('a top-level error is still not done',
      P.answered({'error': 'no bounds', 'by_api': {'legacy': {'rows': 1}, 'wqx3': {'rows': 1}}},
                 _both), False)
check('an empty answer is an answer -- zero rows is not a failure',
      P.answered({'by_api': {'legacy': {'rows': 0}, 'wqx3': {'rows': 0}}}, _both), True)

_dir = os.path.join(__import__('tempfile').mkdtemp(), 'c.json')
P.save(_dir, {'whole': {'by_api': {'legacy': {'rows': 1}, 'wqx3': {'rows': 1}}},
              'half': {'by_api': {'legacy': {'rows': 1}, 'wqx3': {'error': 'HTTP 500'}}}},
       2, apis=_both)
_saved = __import__('json').load(open(_dir, encoding='utf-8'))
check('the stamp counts only whole answers', (_saved['done'], _saved['failed']), (1, 1))
check('and does not call a run with a hole complete', _saved['complete'], False)
check('and names the water to come back to', _saved['failed_waters'], ['half'])
check('--resume hands back only the whole one', sorted(P.load_done(_dir, _both)), ['whole'])


# A CENSUS HAS TO SAY WHAT IT ASKED, NOT ONLY WHAT ANSWERED.
# The 2026-09-04 run carries `by_api` with a `legacy` key and nothing else on all 64 waters, and
# that reads the same whether only the 2.2 service was asked or both were asked and 3.0 vanished.
# 3.0 is where USGS data lives, and USGS appears in none of those 64 results.
import json as _json                                                       # noqa: E402
import tempfile as _tempfile                                               # noqa: E402
_fp = os.path.join(_tempfile.mkdtemp(), 'probe.json')
P.save(_fp, {'a_lake': {'rows': 1}}, 1, apis=('legacy', 'wqx3'))
_doc = _json.load(open(_fp, encoding='utf-8'))
check('the file names the services it asked', _doc.get('apis_asked'), ['legacy', 'wqx3'])
P.save(_fp, {'a_lake': {'rows': 1}}, 1, apis=('legacy',))
check('and says so when only one was asked',
      _json.load(open(_fp, encoding='utf-8')).get('apis_asked'), ['legacy'])
P.save(_fp, {'a_lake': {'rows': 1}}, 1)
check('an unstated ask is null, never a guess',
      _json.load(open(_fp, encoding='utf-8')).get('apis_asked'), None)

if FAILS:
    print('FAIL (%d)' % len(FAILS))
    for f in FAILS:
        print('   ' + f)
    sys.exit(1)
print('ok  -- %d checks: both dialects agree, the zip path changes nothing, the census '
      'records which services it asked, and a cut stream is not an answer' % len(RAN))
