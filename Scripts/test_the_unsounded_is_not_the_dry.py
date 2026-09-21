#!/usr/bin/env python3
"""C's mode 1/11 may ship as `unsurveyed`, and ONLY cut to the water.

Personal use only, not for distribution or resale; not for navigation.

2026-09-20. 1/11 is the exact complement of the survey -- everywhere a tile has no soundings:

    C4E0F3 (Congaree)   1/11 92.1% of the tile box, depth areas 7.9%, sum 100.0%
    C4E0F1 (Wateree)    1/11 98.4% of the tile box, depth areas 1.6%, sum 100.0%
    overlap on both     0.000%
    MAR 0 ft safe water 100.00% inside the depth areas, 0.00% inside 1/11, both tiles
    contour length      0 m inside an eroded 1/11, against 15,307,711 m on the tile

Ryan worked out the mechanism from ActiveCaptain before any of it was measured: "i think what
garmin does is put land to what they call the boundary... anything that is not sounded is land",
and "our problem is that we use their water but not their land... so our stuff looks off from AC
but i do not want to cover up unsurveyed water".

TWO WAYS TO GET THIS WRONG, AND THIS FILE GUARDS BOTH.

1. SHIPPING IT AS LAND. Done on 2026-09-20 and reverted. Against USGS NHD the patches 1/11
   claims split two ways and nothing inside the Garmin file separates them:

    33.76736,-80.65085  }  inside a 13.559 km2 NHD SwampMarsh -- water, and Ryan's own
    33.76719,-80.65320  }  waypoint 0006 sits in it
    33.779102,-80.631033   inside a 1.144 km2 NHD SwampMarsh -- water
    33.766379,-80.783401   3,774 m from any NHD water -- dry
    33.770161,-80.768648   2,597 m from any NHD water -- dry

   A solid bank over a slough that holds fish is worse than the bare grey it replaces: grey says
   "unknown", land says "do not go", and one of those is a lie. Ryan: "even the app thinks that
   wedge is water... the grey is what the water looks like on the satellite."

2. SHIPPING IT UNCUT. This is the new one, and it is the same mistake wearing the right label.
   3DHP's waterbody polygon is the outside witness that CAN separate dry from unsounded, and
   `1/11 INTERSECT boundary` is by construction water Garmin never sounded. Uncut, or cut only
   to the dilated mask, the layer paints a not-sounded hatch across a 250 m collar of dry land
   -- 64 km2 of it on Wateree's 257 km shoreline. So the cut is not an optimisation, it is the
   entire licence to draw the layer, and clip_to_water must refuse rather than approximate.

3. LETTING IT PICK ITS OWN ZOOM. A complement needs the same operand: a lake sounded at zoom 2
   has no zoom-0 depth areas, so its zoom-0 1/11 covers the whole lake and would be drawn over
   the bands the pack ships. `unsurveyed` follows depth_areas, which is why it is NOT in
   ZOOM_LAYERS.
"""
import importlib.util, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gmapmf_regions_v51 as RG


def _load(name, fn):
    s = importlib.util.spec_from_file_location(name, os.path.join(HERE, fn))
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


BCP = _load('bcp', 'build_chartpack.py')
BAC = _load('bac', 'build_all_chartpacks.py')
EXT = _load('ext', 'trollmap_extract_all.py')

FAIL = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        FAIL.append(msg)


# An area class may go unshipped only for a reason written down here.
UNSHIPPED_ON_PURPOSE = {
    'tile_background': "B's 13/1 alone, now that 1/11 has its own name. It dissolves to 100.0% "
                       "of its tile box with the water included, so it carries nothing the "
                       "water and land layers do not already carry.",
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


def _sq(w, s, e, n):
    return [(w, s), (e, s), (e, n), (w, n), (w, s)]


def _water(shell, holes=()):
    from shapely.geometry import Polygon
    return Polygon(shell, holes)


def _poly(ring):
    return {'type': 'Feature', 'properties': {'layer': 'unsurveyed', 'mode': '1/11'},
            'geometry': {'type': 'Polygon', 'coordinates': [[list(p) for p in ring]]}}


def main():
    print('--- 1/11 has its own name and it is not land ---')
    check(RG.AREA_CLASS.get('1/11') == 'unsurveyed',
          "C's 1/11 is filed as 'unsurveyed' (is %r)" % RG.AREA_CLASS.get('1/11'))
    check(RG.AREA_CLASS.get('1/11') != 'land_fill',
          "C's 1/11 is not land_fill: it holds Ryan's 0006, which is inside a 13.6 km2 NHD "
          "swamp, in the same class as ground 3.8 km from any water")
    check(RG.AREA_CLASS.get('1/11') != RG.AREA_CLASS.get('13/1'),
          "1/11 and 13/1 no longer share a layer -- one is the complement of the survey, the "
          "other is the subdivision box, and a shared name hid that for seven weeks")
    check('land_fill' not in BCP.SHIP, "land_fill is still not shipped -- the basemap has the "
                                      "land, and B's 1/10 is all that is left in it")
    check(RG.AREA_CLASS.get('1/10') == 'land_fill',
          "B's 1/10 is still land_fill (is %r)" % RG.AREA_CLASS.get('1/10'))
    check(RG.AREA_CLASS.get('13/1') == 'tile_background',
          "B's 13/1 is still the background (is %r)" % RG.AREA_CLASS.get('13/1'))

    print('\n--- the whole pipeline can actually carry it ---')
    check('unsurveyed' in EXT.LAYERS and 'unsurveyed' in EXT.AREA_LAYERS,
          'the extractor writes an unsurveyed layer -- decode_areas only writes buckets whose '
          'name it already knows, so a missing name is an empty layer and a clean exit')
    check('unsurveyed' in BCP.SHIP, 'unsurveyed is in SHIP, so packs carry it')
    check(BCP.SHIP.get('unsurveyed', (None,))[0] == 'C',
          'unsurveyed is read from the C tile -- B has no 1/11 at all')

    print('\n--- it may only ship CUT, and only to the water itself ---')
    check('unsurveyed' in BCP.CUT_TO_WATER,
          'unsurveyed is cut to the water, not selected against the dilated mask: the dilated '
          'mask is the lake plus 250 m, which on Wateree is 64 km2 of dry land')
    # Not `is`: the two modules are loaded under separate specs here, so BAC's `from
    # build_chartpack import ...` resolves to a THIRD module object and identity fails for a
    # reason that has nothing to do with the code. The invariant that matters is textual -- the
    # batch builder must not define its own copy -- so read the source and say so.
    _bac_src = open(os.path.join(HERE, 'build_all_chartpacks.py'), encoding='utf-8').read()
    check(BAC.CUT_TO_WATER == BCP.CUT_TO_WATER
          and 'CUT_TO_WATER = ' not in _bac_src,
          'the batch builder IMPORTS CUT_TO_WATER rather than declaring its own -- this repo has '
          'paid three times for one rule living in two files')
    check(hasattr(BCP, 'clip_to_water') and hasattr(BCP, 'load_water'),
          'clip_to_water and load_water exist')
    check(not hasattr(BCP, '_water_geom'),
          '_water_geom is gone: it built the water from mask.rings, which are exteriors only, '
          'and nothing may be left behind that can rebuild that bug')

    # The tile-sized polygon is the ordinary case for this layer, so test that case.
    lake = _sq(-80.60, 33.70, -80.50, 33.80)                  # 0.1 x 0.1 deg of "water"
    tile = _poly(_sq(-81.00, 33.00, -80.00, 34.00))           # 1 x 1 deg of 1/11
    w = _water(lake)
    out, st = BCP.clip_to_water([tile], w)
    check(len(out) == 1 and st.get('cut') == 1,
          'a tile-sized 1/11 polygon is CUT to the lake, not dropped for being mostly outside '
          '(got %d feature(s), stats %r)' % (len(out), dict(st)))
    if out:
        xs = [p[0] for p in out[0]['geometry']['coordinates'][0]]
        ys = [p[1] for p in out[0]['geometry']['coordinates'][0]]
        check(min(xs) >= -80.6001 and max(xs) <= -80.4999
              and min(ys) >= 33.6999 and max(ys) <= 33.8001,
              'the cut result stays inside the water -- no collar, no land (bbox %.4f %.4f '
              '%.4f %.4f)' % (min(xs), min(ys), max(xs), max(ys)))
        check((out[0]['properties'] or {}).get('mode') == '1/11',
              'the cut keeps the properties, so a pack can still be traced to the mode')

    # AN ISLAND IS NOT UNSURVEYED WATER, and this is the defect the first run actually shipped:
    # the water came from mask.rings, which is EXTERIORS ONLY, so every island inside a boundary
    # came out hatched. 349 acres of the Congaree and 2,561 of Lake Marion, which has islands by
    # the hundred. A hatch is drawn, so a hole the raster can ignore is a hole this cannot.
    island = _sq(-80.57, 33.73, -80.53, 33.77)
    holed = _water(lake, [island[::-1]])
    out5, st5 = BCP.clip_to_water([tile], holed)
    from shapely.geometry import shape as _shape
    from shapely.ops import unary_union as _uu
    got = _uu([_shape(f['geometry']) for f in out5])
    check(out5 and got.intersection(_water(island)).area < 1e-12,
          'a 1/11 polygon cut to a water WITH AN ISLAND covers none of the island (%.3e deg2 of '
          'it covered, from %d piece(s))'
          % (got.intersection(_water(island)).area, len(out5)))
    check(abs(got.area - holed.area) < 1e-12,
          'and it covers all the rest of the water -- the hole is the only thing removed '
          '(%.6f deg2 against %.6f)' % (got.area, holed.area))

    far = _poly(_sq(-79.00, 32.00, -78.90, 32.10))
    out2, st2 = BCP.clip_to_water([far], w)
    check(not out2 and st2.get('dropped') == 1,
          '1/11 nowhere near the lake is dropped on the bounding box, without paying for an '
          'intersection (stats %r)' % dict(st2))

    # AN EDGE TOUCH IS NOT AN AREA, and asking it for coordinates is a crash rather than a bad
    # polygon. Garmin cuts 1/11 at subdivision seams, so a piece whose seam lies exactly on the
    # 3DHP bank intersects the water in a LINE. shapely returns that inside a GeometryCollection,
    # which has no 'coordinates' at all: the first cut of clip_to_water died with
    # `KeyError: 'coordinates'` on worker 0 of the first --jobs run, on the real Congaree.
    edge = _poly(_sq(-80.70, 33.70, -80.60, 33.80))    # butts against the lake's west edge
    out4, st4 = BCP.clip_to_water([edge], w)
    check(not out4 and st4.get('dropped') == 1 and not st4.get('failed'),
          'a 1/11 piece that only touches the bank is dropped as no area, not crashed on and '
          'not counted as a cut (stats %r)' % dict(st4))

    out3, st3 = BCP.clip_to_water([tile], None)
    check(not out3 and st3.get('no_shapely') == 1,
          'with no water geometry the layer is ABSENT, never uncut -- an uncut hatch over dry '
          'land is the land_fill mistake with a different label (stats %r)' % dict(st3))

    print('\n--- and it follows depth_areas, not its own zoom ---')
    check('unsurveyed' not in BAC.ZOOM_LAYERS,
          'unsurveyed is not in ZOOM_LAYERS: it takes the level depth_areas kept, because the '
          'complement of a survey is only the complement at the same detail level')
    check('unsurveyed' not in BAC.CORE_ONLY_LAYERS,
          'unsurveyed is not core-only -- it is already cut to the core, so a second test '
          'against it can only remove water the cut just proved was inside')
    check('unsurveyed' not in BAC.LINE_LAYERS, 'unsurveyed is not a line layer')
    check('unsurveyed' not in BAC.CHARTED_LAYERS,
          'unsurveyed never counts towards `charted` -- it is the measure of what is NOT '
          'charted, and adding it would report an unsounded lake as a surveyed one')

    print('\n--- no class may point somewhere nothing reads ---')
    for mode, layer in sorted(RG.AREA_CLASS.items()):
        if layer in BCP.SHIP:
            continue
        check(layer in UNSHIPPED_ON_PURPOSE,
              'mode %s -> %r is unshipped: either ship it or write down why '
              '(this is the exact shape of the 1/11 defect)' % (mode, layer))

    print('\n--- the allow-list stays honest ---')
    named = set(RG.AREA_CLASS.values()) | set(EXT.AREA_LAYERS) | {'unparsed'}
    for layer in sorted(UNSHIPPED_ON_PURPOSE):
        check(layer in named,
              'allow-listed layer %r is still produced by something; drop the entry if it is '
              'not, so the list cannot rot into cover for a real layer' % layer)
        check(len(UNSHIPPED_ON_PURPOSE[layer]) > 40,
              'allow-listed layer %r carries a real reason, not a shrug' % layer)
        check(layer not in BCP.SHIP,
              'allow-listed layer %r is not also in SHIP -- a layer cannot be both excused and '
              'shipped, and leaving the excuse behind is how the next one hides' % layer)

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
