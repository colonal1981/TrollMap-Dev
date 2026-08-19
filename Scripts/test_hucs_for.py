"""hucs_for(): the binding decides the basin, the table is only a fallback.

This is the whole point of the change, and it is testable without a geodatabase, without
geopandas and without lake_catalog.py -- so it is tested.
"""
import io, json, sys, types, contextlib
from pathlib import Path
import tempfile, os

HERE = Path(__file__).resolve().parent
src = (HERE / 'trollmap_nhd_boundaries.py').read_text(encoding='utf-8')

# The module exits at import time without lake_catalog.py and pulls in geopandas later, so the
# two pieces under test are exec'd on their own. Everything they touch is passed in.
start = src.index('_BINDINGS = None')
end = src.index("\ndef ", src.index('def hucs_for'))
block = src[start:end]

root = Path(tempfile.mkdtemp())
(root / 'registry').mkdir()
(root / 'NHD').mkdir()
(root / 'registry' / '_nhd_bindings.json').write_text(json.dumps({'bindings': {
    'prestwood_lake': {'vpu': '0304'},
    'lake_murray':    {'vpu': '0305'},
    'agreeing_lake':  {'vpu': '0302'},
}}))

ns = {'json': json, 'NHD_DIR': root / 'NHD', 'print': print,
      'SLUG_HUCS': {'prestwood_lake': ['0306'], 'agreeing_lake': ['0302'],
                    'table_only_lake': ['0313'], 'lake_murray': ['0307']}}
exec(block, ns)
hucs_for = ns['hucs_for']

buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    got = hucs_for('prestwood_lake')
assert got == (['0304'], 'binding'), got
assert 'binding puts prestwood_lake in 0304' in buf.getvalue(), \
    'a disagreement has to be said out loud, not silently resolved: %r' % buf.getvalue()

buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    got = hucs_for('agreeing_lake')
assert got == (['0302'], 'binding'), got
assert buf.getvalue() == '', 'agreement is not news: %r' % buf.getvalue()

assert hucs_for('table_only_lake') == (['0313'], 'SLUG_HUCS'), \
    'a slug with no binding still gets the table -- 39 of them have no binding'
assert hucs_for('never_heard_of_it') == ([], 'SLUG_HUCS')

# a missing bindings file must fall back loudly, not crash
ns2 = dict(ns); ns2['NHD_DIR'] = root / 'nope' / 'NHD'
exec(block, ns2)
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    got = ns2['hucs_for']('prestwood_lake')
assert got == (['0306'], 'SLUG_HUCS'), got
assert 'falling back' in buf.getvalue(), buf.getvalue()

print('hucs_for: binding wins, disagreement is printed, no binding falls back to the table,')
print('          and a missing bindings file falls back loudly instead of crashing')
