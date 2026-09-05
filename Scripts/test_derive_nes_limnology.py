#!/usr/bin/env python3
r"""test_derive_nes_limnology.py -- run with `py .\scripts\test_derive_nes_limnology.py`.

The two things in this file that can do damage:

  the JOIN     bound the wrong lake and a plan gets another water's oxygen. The printed names
               alone bind three of seven papers -- `LAKE WILLIAM C. BOWEN` misses over a full
               stop, `LAKE KEOQWEE` is OCR damage, `LAKE ROBINSON` matches two real waters.
  the GUARD    a cast that lost readings must never say the lake did not stratify. That exact
               sentence is what audit_limnology_gaps.py matches to return `does_not_stratify`,
               which the ledger counts as an ANSWER -- so a bad scan would move Lake Murray from
               "needs a source" to "does not stratify" with a federal citation behind it.
"""
from __future__ import annotations
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import derive_nes_limnology as D

FAILS, RAN = [], []


def check(name, got, want):
    RAN.append(name)
    if got != want:
        FAILS.append('%s: got %r, want %r' % (name, got, want))


# --- the join ---------------------------------------------------------------------------------
# Our index, as it really reads: no full stop in Bowen, and two Robinsons.
BYNAME = {
    'lake william c bowen': {'lake_william_c_bowen'},
    'lake robinson': {'lake_robinson', 'lake_robinson_greer'},
    'lake secession': {'secession_lake'},
    'lake murray': {'lake_murray'},
}
POLY = {                                        # (lat, lon) -> slug, as the boundaries would say
    (35.10694, -82.05556): 'lake_william_c_bowen',
    (34.83306, -82.89028): 'lake_keowee',
    (34.40694, -80.15139): 'lake_robinson',
    (34.04972, -81.21667): 'lake_murray',
}


def at(lat, lon):
    return POLY.get((lat, lon))


def st(lat=None, lon=None):
    return {'lat': lat, 'lon': lon}


slug, how, why = D.bind('LAKE WILLIAM C. BOWEN', [st(35.10694, -82.05556)], BYNAME, at)
check('a full stop does not cost us Bowen', slug, 'lake_william_c_bowen')
check('and the file says how it was bound', 'coordinate' in how, True)

slug, _h, _w = D.bind('LAKE KEOQWEE', [st(34.83306, -82.89028)], BYNAME, at)
check('a name the scan mangled still binds by where it is', slug, 'lake_keowee')

slug, how, _w = D.bind('LAKE ROBINSON', [st(34.40694, -80.15139)], BYNAME, at)
check('two Robinsons are settled by the coordinate', slug, 'lake_robinson')
check('and the name is reported as not having bound', 'did not bind' in how, True)

# Secession's degrees came off the scan as 35 15 35.0 -- North Carolina. The name saves it.
slug, how, _w = D.bind('LAKE SECESSION', [st(35.25972, -82.60833)], BYNAME, at)
check('an unreadable coordinate falls back to the name', slug, 'secession_lake')
check('and says so', 'printed name' in how, True)

# A PAPER IS ABOUT ONE LAKE, SO ITS STATIONS VOTE.
slug, how, _w = D.bind('LAKE MURRAY', [st(34.04972, -81.21667), st(34.04972, -81.21667),
                                       st(35.10694, -82.05556)], BYNAME, at)
check('the majority of stations wins', slug, 'lake_murray')
check('and the count is shown', '2 of 3' in how, True)

# A TIE IS BROKEN BY THE NAME ONLY IF THE NAME PICKS ONE OF THE TIED WATERS.
slug, how, _w = D.bind('LAKE MURRAY', [st(34.04972, -81.21667), st(35.10694, -82.05556)],
                       BYNAME, at)
check('a tie the name can settle is settled', slug, 'lake_murray')
check('and it says the stations disagreed', 'split between' in how, True)

slug, _h, why = D.bind('LAKE SECESSION', [st(34.04972, -81.21667), st(35.10694, -82.05556)],
                       BYNAME, at)
check('a tie the name cannot settle is a refusal', slug, None)
check('and it names all three answers on the table',
      'split evenly' in why and 'secession_lake' in why, True)

# TWO JOINS POINTING AT DIFFERENT WATERS IS NOT A TIE-BREAK, IT IS A STOP.
slug, _h, why = D.bind('LAKE MURRAY', [st(35.10694, -82.05556)], BYNAME, at)
check('coordinate and name disagreeing writes nothing', slug, None)
check('and says which said what', 'the coordinate says lake_william_c_bowen' in why, True)

slug, _h, why = D.bind('NO SUCH LAKE', [st(1.0, 1.0)], BYNAME, at)
check('an unknown water binds to nothing', slug, None)
check('a paper with no station at all still refuses',
      D.bind('NO SUCH LAKE', [], BYNAME, at)[0], None)

# --- the guard --------------------------------------------------------------------------------
STATION = {'station': '450701', 'lat': 34.04972, 'lon': -81.21667, 'station_depth_ft': 183}

# Lake Murray, 9 July 1973, as the scan left it: 29.8 C at 15 ft and 24.2 at 30 ft are gone, so
# what survives grades at 0.66 C/m. With the printed values that interval is 1.22 C/m.
damaged = {'date': '1973-07-09', 'dropped': 4, 'readings': [
    {'depthFt': 0, 'tempC': 30.2}, {'depthFt': 6, 'tempC': 30.1},
    {'depthFt': 30, 'doMgL': 2.6}, {'depthFt': 60, 'tempC': 19.3, 'doMgL': 3.2},
    {'depthFt': 90, 'tempC': 15.9, 'doMgL': 4.5}, {'depthFt': 120, 'tempC': 15.2},
    {'depthFt': 150, 'tempC': 14.8}, {'depthFt': 178, 'doMgL': 2.7}]}
v = D.visit_from(damaged, STATION, 'test')
check('a damaged cast reports no thermocline', v['thermoclineFt'], None)
check('and NEVER says the lake did not stratify', D.NO_STRATIFY_PHRASE in v['thermoclineNote'],
      False)
check('it says what it actually knows', 'were dropped as OCR damage' in v['thermoclineNote'],
      True)
check('and it counts what it lost', v['dropped'], 4)
check('a depth it DID find still travels', v['depletionDepthFt'], 30.0)
check('and the year is on the record', v['year'], '1973')

# An undamaged cast keeps the real refusal -- that sentence is an answer when it is earned.
clean = {'date': '1973-07-09', 'dropped': 0, 'readings': [
    {'depthFt': 0, 'tempC': 20.0, 'doMgL': 9.0}, {'depthFt': 10, 'tempC': 19.9, 'doMgL': 9.0},
    {'depthFt': 20, 'tempC': 19.8, 'doMgL': 8.9}, {'depthFt': 30, 'tempC': 19.7, 'doMgL': 8.8},
    {'depthFt': 40, 'tempC': 19.6, 'doMgL': 8.8}]}
v2 = D.visit_from(clean, STATION, 'test')
check('a clean cast that shows no gradient may say so',
      D.NO_STRATIFY_PHRASE in (v2['thermoclineNote'] or ''), True)
check('and its oxygen refusal is an answer',
      'never fell under' in (v2['anoxicNote'] or ''), True)
check('with no OCR caveat attached',
      'OCR damage' in (v2['anoxicNote'] or ''), False)

# --- the window -------------------------------------------------------------------------------
check('June is summer', D.is_summer('1973-06-25'), True)
check('September is summer', D.is_summer('1973-09-22'), True)
check('March is not', D.is_summer('1973-03-26'), False)
check('November is not', D.is_summer('1973-11-13'), False)

if FAILS:
    print('FAIL (%d)' % len(FAILS))
    for f in FAILS:
        print('   ' + f)
    sys.exit(1)
print('ok  -- %d checks: the coordinate is the join, and a damaged cast never acquits the lake'
      % len(RAN))
