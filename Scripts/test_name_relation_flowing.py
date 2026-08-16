#!/usr/bin/env python3
"""A creek is not the lake named after it.

Personal use only, not for distribution or resale; not for navigation.

Measured 2026-08-16 against the live registry: "Mayo Ck nr Bethel Hill, NC" bound Mayo Reservoir
through name_relation on the shared token `mayo`. The token is real and the waters are
different -- one is the impoundment, the other is the stream feeding it, and their elevations
have nothing to do with each other.

Third file to need this guard. Worker/reports.js learned it on TWRA's "Norris Tailwater", which
is not Norris Lake. scripts/bind_operator_lakes.py carries the same list for operator feeds.
"""
import importlib.util, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('bwb', os.path.join(HERE, 'build_water_bindings.py'))
M = importlib.util.module_from_spec(spec)
sys.modules['bwb'] = M
try:
    spec.loader.exec_module(M)
except SystemExit:
    pass

FAIL = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        FAIL.append(msg)


def rel(names, gauge, weak=frozenset()):
    return M.name_relation(names, gauge, set(weak))


def main():
    # ── the case that was live and wrong ────────────────────────────────────────────────────
    check(rel(['Mayo Reservoir', 'Mayo Reservoir, NC'], 'Mayo Ck nr Bethel Hill, NC') is None,
          'Mayo Ck does not bind Mayo Reservoir')
    check(rel(['Norris Lake', 'Norris Lake, TN'], 'Norris Tailwater') is None,
          'Norris Tailwater is not Norris Lake')
    check(rel(['Hartwell Lake'], 'Hartwell Tailrace') is None,
          'a tailrace is below the dam, not the lake')

    # ── the impoundment itself still binds ──────────────────────────────────────────────────
    check(rel(['Hartwell Lake', 'Hartwell Lake, SC/GA'], 'Hartwell Lake near Anderson') == 'hartwell',
          'the lake gauge on the lake still binds')
    check(rel(['J. Strom Thurmond Reservoir'], 'Thurmond Basin') == 'thurmond',
          'a project component on the reservoir still binds')

    # ── one-directional on purpose ──────────────────────────────────────────────────────────
    # A lake legitimately called "... Creek Reservoir" keeps its match, because the flowing word
    # is on BOTH sides and is therefore part of its name rather than a claim about what it is.
    check(rel(['Butler Creek Reservoir'], 'BUTLER CREEK RESERVOIR AT FORT GORDON, GA') is not None,
          'a lake whose own name carries "Creek" still matches a creek-named source')
    check(rel(['Beaverdam Creek Lake'], 'Beaverdam Ck Dam') is not None,
          'the abbreviation Ck is caught, and a Creek-named lake survives it')

    # ── the guard does not fire where there is no flowing word ──────────────────────────────
    check(rel(['Lake Murray', 'Lake Murray, SC'], 'Murray Dam') == 'murray',
          'a dam is not flowing water and the match stands')

    # ── and it cannot rescue a match that was never there ───────────────────────────────────
    check(rel(['Secession Lake', 'Lake Secession, SC'], 'ROCKY RIVER NR STARR, SC') is None,
          'no shared token is still no match')

    print('\n%s  %d failure(s)' % ('FAILED' if FAIL else 'ALL PASS', len(FAIL)))
    for f in FAIL:
        print('   - ' + f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
