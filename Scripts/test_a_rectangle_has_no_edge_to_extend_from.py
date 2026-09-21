#!/usr/bin/env python3
"""The annex may not swallow the ocean, and an edge touch may not kill the run.

Personal use only, not for distribution or resale; not for navigation.

2026-09-21. The overnight rebuild of all 354 served packs failed, and two of the three faults
were in code written the day before.

1. A RECTANGLE HAS NO EDGE TO EXTEND FROM.

   build_annex.py's rule is "water Garmin sounded, touching a water we have, claimed by no other
   water, belongs to that water". That is right for a lake, whose outline is a measured bank. A
   coastal zone is not a waterbody -- it is an ENVELOPE drawn over land and water together, and
   make_coastal_boundaries.py emits it as a literal box -- so everything outside the box touches
   it, and the whole Atlantic was annexed:

       coast_hilton_head_sc      1,378,920 ac   IN ONE PIECE
       coast_ace_basin_sc        1,314,109 ac
       coast_santee_delta_sc     1,302,907 ac
       coast_murrells_inlet_sc   1,251,497 ac

   9.4 million acres across 347 waters. coast_hilton_head_sc's depth_areas.geojson came out of
   the rebuild at 275 MB, Hartwell at 274 MB, 283 packs poisoned on disk. Nothing shipped only
   because the upload was the step after the one that crashed.

   Two guards, and the second is not a tuned number -- 1.0 is the identity. A water that takes
   on more than its own area is not being extended to where the soundings end, it is being
   REPLACED by whatever it touched. For scale: the canal is 22 acres against the Congaree's
   10,810, and Marion's entire share was 1,973 against 80,866, which is 2.4%.

2. A GEOMETRYCOLLECTION HAS NO 'coordinates', AND IT WAS THE SECOND TIME.

   `KeyError: 'coordinates'` in trim_geometry killed worker 2 after 81 lakes. An intersection
   along a shared edge returns LineStrings and Points beside the polygon, wrapped in a
   GeometryCollection. The IDENTICAL fault had been found and fixed in clip_to_water() the day
   before, forty lines down the same file, and this function -- which does the same intersection
   for the same reason -- was never looked at.

   So this file tests the behaviour, not the spelling: a real geometry whose intersection with a
   real mask is a polygon plus a bare edge.

(The third fault was Ryan's computer rebooting, which killed workers 1 and 3 with
STATUS_CONTROL_C_EXIT. Not ours, and not testable.)
"""
import importlib.util, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

_s = importlib.util.spec_from_file_location('bcp', os.path.join(HERE, 'build_chartpack.py'))
BCP = importlib.util.module_from_spec(_s); _s.loader.exec_module(BCP)
ANNEX = open(os.path.join(HERE, 'build_annex.py'), encoding='utf-8').read()

FAIL = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        FAIL.append(msg)


class _Mask:
    """Just enough of a mask for trim_geometry's polygon branch."""
    def __init__(self, w, s, e, n):
        self.rings = [[(w, s), (e, s), (e, n), (w, n), (w, s)]]
        self.buffer_deg = 0.0
        self.w, self.s, self.e, self.n = w, s, e, n


def main():
    print('--- a coastal zone may not annex ---')
    check("NO_ANNEX = {s for s in served if s.startswith('coast_')}" in ANNEX,
          'build_annex.py builds NO_ANNEX from the coastal zones')
    check("nslugs[i] not in NO_ANNEX" in ANNEX,
          'and the taker test excludes them, so a box cannot take what merely touches it')

    print('\n--- and only the waters somebody named ---')
    check("ap.add_argument('--only-lakes', required=True," in ANNEX,
          'build_annex.py REFUSES to run without --only-lakes. The rule fixes a hole somebody '
          'has SEEN; run card-wide on nobody\'s report it annexed 9.4 million acres to 347 '
          'waters')
    check('served = {s for s in served if s in want}' in ANNEX,
          'and a water not on the list is left exactly as it was')

    print('\n--- and no water may annex more than itself ---')
    check('if own > 0 and got > own:' in ANNEX,
          'the cap is the water\'s OWN area -- 1.0 is the identity, not a threshold')
    i = ANNEX.find('if own > 0 and got > own:')
    tail = ANNEX[i:i + 260]
    check('refused.append' in tail and 'continue' in tail,
          'and it REFUSES the whole thing rather than trimming it: half of a wrong answer is '
          'still wrong, and a named refusal can be looked at')
    check('REFUSED' in ANNEX and 'look at what it is touching' in ANNEX,
          'a refusal is printed with both numbers, not swallowed')

    print('\n--- an edge touch does not kill the run ---')
    # THE CONTROL HAS TO FIRE, and the first one written here did not: a box overlapping the
    # mask in a sliver intersects as a plain Polygon, so it proved nothing. Checked against
    # shapely directly before trusting it --
    #
    #     sliver overlap   -> Polygon
    #     shared edge only -> LineString
    #     THIS ONE         -> GeometryCollection ['Polygon', 'Polygon', 'LineString']
    #
    # AND IT HAS TO REACH THE CUT BRANCH, which is the second thing the first draft got wrong:
    # trim_geometry keeps a polygon WHOLE when half its vertices are inside, so a shape that is
    # mostly in the mask never intersects anything. The bulk of this one sits west of the mask --
    # 5 of 17 vertices inside, 29% -- with two fingers reaching in and a spur running along the
    # north edge. That is the shape a Garmin band cut at a subdivision seam makes against a bank.
    m = _Mask(-80.60, 33.70, -80.50, 33.80)
    geom = {'type': 'Polygon',
            'coordinates': [[[-80.90, 33.68], [-80.80, 33.68], [-80.80, 33.70], [-80.90, 33.70],
                             [-80.90, 33.72], [-80.55, 33.72], [-80.55, 33.74], [-80.90, 33.74],
                             [-80.90, 33.76], [-80.55, 33.76], [-80.55, 33.78], [-80.90, 33.78],
                             [-80.90, 33.80], [-80.50, 33.80], [-80.50, 33.805],
                             [-80.90, 33.805], [-80.90, 33.68]]]}
    hit = lambda x, y: (-80.60 <= x <= -80.50) and (33.70 <= y <= 33.80)
    try:
        ng, verdict = BCP.trim_geometry(geom, hit, m)
        crashed = None
    except Exception as e:
        ng, verdict, crashed = None, None, '%s: %s' % (e.__class__.__name__, e)
    check(crashed is None,
          'trim_geometry survives an intersection that comes back as a GeometryCollection '
          '(raised %s)' % crashed)
    check(verdict == 'trim',
          'and it reached the CUT branch, which is where the crash was -- a polygon kept whole '
          'never intersects anything and would prove nothing (%r)' % verdict)
    if ng:
        check(ng.get('type') in ('Polygon', 'MultiPolygon'),
              'what it returns is a polygon, never a collection (%r)' % ng.get('type'))
        check('coordinates' in ng, "and it has coordinates, which is the whole of the crash")
        check(ng.get('type') == 'MultiPolygon' and len(ng['coordinates']) == 2,
              'BOTH lobes survive -- the collection is walked, not reduced to its first member '
              '(%r, %d part(s))' % (ng.get('type'), len(ng.get('coordinates') or [])))

    # And the degenerate case beside it: a polygon that shares ONLY an edge intersects as a bare
    # LineString. No area, so no feature, and still no crash.
    edge = {'type': 'Polygon',
            'coordinates': [[[-80.70, 33.70], [-80.60, 33.70], [-80.60, 33.80],
                             [-80.70, 33.80], [-80.70, 33.70]]]}
    try:
        ng2, v2 = BCP.trim_geometry(edge, hit, m)
        crashed2 = None
    except Exception as e:
        ng2, v2, crashed2 = None, None, '%s: %s' % (e.__class__.__name__, e)
    check(crashed2 is None and ng2 is None and v2 == 'drop',
          'a polygon sharing only the bank is dropped as no area, not crashed on '
          '(%r, %r, raised %s)' % (ng2, v2, crashed2))

    print('\n--- the same fault, still fixed in the other function ---')
    check(hasattr(BCP, 'clip_to_water'), 'clip_to_water is still here')
    src = open(os.path.join(HERE, 'build_chartpack.py'), encoding='utf-8').read()
    check(src.count("_gj(left)['coordinates']") == 0,
          "nothing reads _gj(...)['coordinates'] off an un-walked intersection any more -- that "
          "expression IS the bug, in both places it appeared")
    check('_singles(left)' in src,
          '_singles() walks the collection in both, which is the one implementation of this')

    print('\n%s  %d failure(s)' % ('FAILED' if FAIL else 'ALL PASS', len(FAIL)))
    for f in FAIL:
        print('   - ' + f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
