#!/usr/bin/env python3
"""C's mode 1/11 must never be shipped as land.

2026-09-20. `AREA_CLASS["1/11"]` reads "tile_background" with a note calling it C's background.
It is not a background -- it is the exact complement of the survey, which is a different and
more dangerous thing, because it LOOKS like a land layer:

    C4E0F3 (Congaree)   1/11 92.1% of the tile box, depth areas 7.9%, sum 100.0%
    C4E0F1 (Wateree)    1/11 98.4% of the tile box, depth areas 1.6%, sum 100.0%
    overlap on both     0.000%
    MAR 0 ft safe water 100.00% inside the depth areas, 0.00% inside 1/11, both tiles

Every one of those numbers is consistent with "this is the land", and on that reading it was
reclassed to land_fill and put in SHIP. USGS NHD says otherwise. The patches 1/11 claims split
two ways, and nothing inside the Garmin file distinguishes them:

    33.76736,-80.65085  }  inside a 13.559 km2 NHD SwampMarsh -- water, and Ryan's own
    33.76719,-80.65320  }  waypoint 0006 sits in it
    33.779102,-80.631033   inside a 1.144 km2 NHD SwampMarsh -- water
    33.766379,-80.783401   3,774 m from any NHD water -- dry
    33.770161,-80.768648   2,597 m from any NHD water -- dry

So the class means "Garmin did not sound here", not "there is ground here". Drawing it as land
would put a solid bank over a slough that holds fish, which is worse than the bare grey it
causes today: grey says "unknown", land says "do not go", and one of those is a lie.

Ryan, who fishes it: "even the app thinks that wedge is water... the grey is what the water
looks like on the satellite."

The second guard is the one that would have caught the original defect on its own: an area
class may only name a layer build_chartpack ships, unless it is on a written allow-list with a
reason. `tile_background` was never written by the extractor and never shipped, so filing
anything there is filing it in the bin -- which is fine for a background and not fine for
anything else.
"""
import importlib.util, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gmapmf_regions_v51 as RG

_s = importlib.util.spec_from_file_location('bcp', os.path.join(HERE, 'build_chartpack.py'))
BCP = importlib.util.module_from_spec(_s); _s.loader.exec_module(BCP)

FAIL = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        FAIL.append(msg)


# An area class may go unshipped only for a reason written down here.
UNSHIPPED_ON_PURPOSE = {
    'tile_background': "B's 13/1 dissolves to 100.0% of its tile box with the water included, "
                       "so it carries nothing the water and land layers do not already carry. "
                       "C's 1/11 is parked here too, not because it is a background but "
                       "because it cannot tell dry ground from unsurveyed water and must not "
                       "be drawn as either until something outside the tile can.",
    'land_fill':       "B's 1/10, genuine land -- a subdivision box with the water cut out. "
                       "Not shipped because TrollMap draws over a Leaflet basemap that already "
                       "has the land, in street or satellite, so a second copy costs R2 bytes "
                       "and renders nothing new. C's 1/11 must never join it here.",
    'areas_other':     "modes whose geometry is not verified; emitted so a count change is "
                       "visible, never mixed into a layer that is drawn",
    'areas':           "the unclassed remainder that carries a band but no recognised mode; "
                       "kept whole so a mode moving between products shows up as a count "
                       "change rather than a hole",
    'unparsed':        "records the area walker could not read at all",
}


def main():
    print('--- 1/11 is not land ---')
    check(RG.AREA_CLASS.get('1/11') != 'land_fill',
          "C's 1/11 is not filed as land_fill: it holds Ryan's 0006, which is inside a 13.6 km2 "
          "NHD swamp, in the same class as ground 3.8 km from any water")
    check('land_fill' not in BCP.SHIP,
          'land_fill is not shipped while 1/11 is the only thing C puts in it')
    check(RG.AREA_CLASS.get('1/10') == 'land_fill',
          "B's 1/10 is still land_fill -- that one really is a box with the water cut out "
          "(is %r)" % RG.AREA_CLASS.get('1/10'))
    check(RG.AREA_CLASS.get('13/1') == 'tile_background',
          "B's 13/1 is still the background (is %r)" % RG.AREA_CLASS.get('13/1'))

    print('\n--- no class may point somewhere nothing reads ---')
    for mode, layer in sorted(RG.AREA_CLASS.items()):
        if layer in BCP.SHIP:
            continue
        check(layer in UNSHIPPED_ON_PURPOSE,
              'mode %s -> %r is unshipped: either ship it or write down why '
              '(this is the exact shape of the 1/11 defect)' % (mode, layer))

    print('\n--- the allow-list stays honest ---')
    # The authority on which layers exist is the extractor's own list, not AREA_CLASS alone:
    # `areas` and `unparsed` are assigned inside decode_areas, never through the mode map.
    _e = importlib.util.spec_from_file_location('ext', os.path.join(HERE, 'trollmap_extract_all.py'))
    EXT = importlib.util.module_from_spec(_e); _e.loader.exec_module(EXT)
    named = set(RG.AREA_CLASS.values()) | set(EXT.AREA_LAYERS) | {'unparsed'}
    for layer in sorted(UNSHIPPED_ON_PURPOSE):
        check(layer in named,
              'allow-listed layer %r is still produced by something; drop the entry if it is '
              'not, so the list cannot rot into cover for a real layer' % layer)
        check(len(UNSHIPPED_ON_PURPOSE[layer]) > 40,
              'allow-listed layer %r carries a real reason, not a shrug' % layer)

    print('\n--- a shipped area layer must be reachable from a class ---')
    from_class = set(RG.AREA_CLASS.values())
    for layer in sorted(BCP.SHIP):
        if layer in ('depth_areas', 'contours', 'hydrography', 'shoreline', 'pois'):
            continue                      # line classes and the banded layer, not area classes
        check(layer in from_class,
              'shipped area layer %r is named by some mode in AREA_CLASS' % layer)

    print('\n%s  %d failure(s)' % ('FAILED' if FAIL else 'ALL PASS', len(FAIL)))
    for f in FAIL:
        print('   - ' + f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
