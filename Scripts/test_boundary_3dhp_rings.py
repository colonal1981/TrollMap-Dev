"""boundary_from_3dhp.py: does a hole survive the read and reach the GeoJSON.

WHY THIS EXISTS
    The reader returned every ring in one flat list and the writer made each ring its own outer
    ring, so ISLANDS BECAME WATER. Invisible on a lake with no islands, which is why it lived
    from Lake Robinson (2026-08-11) until the Cooper River (2026-08-17): 221 rings, 220 of them
    nested, written as 28,742 acres against 3DHP's own 17,071. The rings were never wrong. The
    nesting was thrown away.

    The GeoPackage is 60 GB on Ryan's drive and cannot be reached from a session, so the WKB
    here is built by hand -- which is better anyway, because it lets the holes be KNOWN rather
    than assumed.
"""
import importlib.util, struct, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('b3', HERE / 'boundary_from_3dhp.py')
b3 = importlib.util.module_from_spec(spec); spec.loader.exec_module(b3)


def ring(pts, dim=2):
    out = struct.pack('<I', len(pts))
    for p in pts:
        out += struct.pack('<' + 'd' * dim, *(list(p) + [0.0] * (dim - len(p)))[:dim])
    return out


def polygon(rings_, dim=2):
    code = 3 + (1000 if dim == 3 else 0)
    return struct.pack('<BI', 1, code) + struct.pack('<I', len(rings_)) + b''.join(
        ring(r, dim) for r in rings_)


def multipolygon(polys, dim=2):
    code = 6 + (1000 if dim == 3 else 0)
    return struct.pack('<BI', 1, code) + struct.pack('<I', len(polys)) + b''.join(
        polygon(p, dim) for p in polys)


SQ = lambda x, y, s: [(x, y), (x + s, y), (x + s, y + s), (x, y + s), (x, y)]
OUTER, HOLE = SQ(0, 0, 1000), SQ(300, 300, 200)
OUTER2, HOLE2 = SQ(5000, 5000, 800), SQ(5200, 5200, 100)

# --- 1. a polygon with a hole keeps the hole -------------------------------------------------
polys, _ = b3.wkb_polygons(polygon([OUTER, HOLE]))
assert len(polys) == 1, polys
assert len(polys[0]) == 2, 'outer + hole, got %d ring(s)' % len(polys[0])
print('a hole survives the read:', len(polys), 'polygon,', len(polys[0]) - 1, 'hole')

# --- 2. a multipolygon keeps each polygon's own holes ----------------------------------------
polys, _ = b3.wkb_polygons(multipolygon([[OUTER, HOLE], [OUTER2, HOLE2]]))
assert len(polys) == 2, polys
assert [len(p) for p in polys] == [2, 2], [len(p) for p in polys]
print('two polygons, one hole each, kept apart:', [len(p) - 1 for p in polys], 'holes')

# --- 3. THE REGRESSION. Islands must not become outer rings. ---------------------------------
# This is exactly what the old writer did, restated so the bug has a name and cannot come back.
old_style = [[r] for p in polys for r in p]
assert len(old_style) == 4, 'the old form promoted every ring to its own polygon'
assert len(polys) == 2, 'the new form keeps two polygons'
print('the old form made %d polygons out of %d; the new one makes %d'
      % (len(old_style), sum(len(p) for p in polys), len(polys)))

# --- 4. wkb_rings still returns the flat list missing_waterbodies.py expects -----------------
flat, _ = b3.wkb_rings(multipolygon([[OUTER, HOLE], [OUTER2, HOLE2]]))
assert len(flat) == 4, 'missing_waterbodies counts vertices off this and must be unaffected'
assert flat == [r for p in polys for r in p], 'the flat view must equal the grouped one flattened'
print('wkb_rings is unchanged for its caller:', len(flat), 'rings flat')

# --- 5. 3D geometry, which is what 3DHP actually stores ---------------------------------------
# Reading two doubles out of a three-double stream walks the offset off the end of every ring
# and lands the result in the Indian Ocean without raising. The dimension logic is load-bearing.
polys3, _ = b3.wkb_polygons(multipolygon([[OUTER, HOLE], [OUTER2, HOLE2]], dim=3), 0)
assert len(polys3) == 2 and [len(p) for p in polys3] == [2, 2], polys3
assert polys3 == polys, 'the Z coordinate must not change the lon/lat that comes out'
print('3D geometry reads identically to 2D:', [len(p) - 1 for p in polys3], 'holes')

# --- 6. the GeoJSON the writer emits is nested, and shapely agrees on the area ----------------
from shapely.geometry import shape
geom = ({'type': 'Polygon', 'coordinates': polys[0]} if len(polys) == 1
        else {'type': 'MultiPolygon', 'coordinates': polys})
g = shape(geom)
old = shape({'type': 'MultiPolygon', 'coordinates': old_style})
assert g.is_valid, 'the emitted geometry must be valid'
# RATIOS, NOT ABSOLUTES. to_wgs84 has already turned these metres into degrees, so the areas
# are ~1e-4 and comparing them against the metre figures asserts nothing -- the first version of
# this test wanted 1,590,000 and got 0.0. The ratio survives the projection; the units do not.
solid = 1000 * 1000 + 800 * 800          # the two outer squares
cut = 200 * 200 + 100 * 100              # the two holes
assert g.area > 0, 'the emitted geometry has no area at all'
assert old.area > g.area, 'the old form must be the LARGER one -- it added the holes'
want = (solid + cut) / (solid - cut)
got = old.area / g.area
assert abs(got - want) < 0.01, \
    'holes subtracted vs added should differ by %.4fx, got %.4fx' % (want, got)
print('holes subtracted vs added differ by %.4fx (want %.4fx) -- a %.1f%% overstatement'
      % (got, want, 100 * (got - 1)))

print('\nall boundary_from_3dhp ring-hierarchy assertions pass')


# ============================================================================================
# main() END TO END, against a real sqlite GeoPackage built here.
#
# THE REASON THIS SECTION EXISTS. The tests above pass on a file whose main() raises
# NameError: name 'polys' is not defined. A three-part patch had its third assertion fail, so
# none of the three were written; the writer was then changed on its own and referred to a
# variable the reader half would have created. Every assertion above still passed, because none
# of them called main(). Ryan ran it and it died on the line after the one I had tested.
#
# That is the second time in one day. The first is recorded in upload_garmin_to_r2.py's
# docstring. A test that exercises the helpers and not the entry point is a test that agrees
# with you about the part you already got right.
# ============================================================================================
import sqlite3, tempfile, io, contextlib, os, json

def gpkg_blob(wkb):
    """A GeoPackage geometry blob: magic, version, flags, srs_id, then WKB. flags=0x01 is
    little-endian with NO envelope, which is what gpkg_wkb's {0: 0} branch expects."""
    return b'GP' + bytes([0, 0x01]) + struct.pack('<i', 6350) + wkb

def make_gpkg(path, wkb, id3dhp='TEST1', areasqkm=1.59):
    con = sqlite3.connect(path)
    con.execute('CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT)')
    con.execute("INSERT INTO gpkg_geometry_columns VALUES ('hydro_3dhp_all_waterbody','shape')")
    con.execute('CREATE TABLE hydro_3dhp_all_waterbody (id3dhp TEXT, gnisid INT, '
                'gnisidlabel TEXT, featuretype INT, areasqkm REAL, shape BLOB)')
    con.execute('INSERT INTO hydro_3dhp_all_waterbody VALUES (?,?,?,?,?,?)',
                (id3dhp, None, None, 3, areasqkm, gpkg_blob(wkb)))
    con.commit(); con.close()

def run_main(argv):
    old = sys.argv
    sys.argv = argv
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            rc = b3.main()
    finally:
        sys.argv = old
    return rc, buf.getvalue()

# ignore_cleanup_errors: belt and braces. main() closes its connection now, but a test that
# leaves a Windows temp file behind should report the assertion result, not a rmtree traceback
# on top of ten passing lines.
with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
    gp = os.path.join(td, 'fake.gpkg')
    out = os.path.join(td, 'boundaries')
    make_gpkg(gp, multipolygon([[OUTER, HOLE], [OUTER2, HOLE2]], dim=3))
    rc, txt = run_main(['x', '--gpkg', gp, '--id', 'TEST1', '--slug', 'test_water',
                        '--name', 'Test Water', '--state', 'SC', '--out-dir', out])
    assert rc == 0, 'main() failed:\n' + txt
    assert 'polygons    2, with 2 hole(s)' in txt, txt
    assert 'rings       4' in txt, txt
    written = json.load(open(os.path.join(out, 'test_water.geojson')))
    geom = written['features'][0]['geometry']
    assert geom['type'] == 'MultiPolygon', geom['type']
    assert [len(p) for p in geom['coordinates']] == [2, 2], \
        'the file on disk must carry the holes: %s' % [len(p) for p in geom['coordinates']]
    from shapely.geometry import shape as _shape
    assert _shape(geom).is_valid
    print('main() end to end: %d polygon(s), holes preserved on disk' % len(geom['coordinates']))

    # a single ring must still come out as a plain Polygon, not a one-element MultiPolygon
    gp2 = os.path.join(td, 'fake2.gpkg'); out2 = os.path.join(td, 'b2')
    make_gpkg(gp2, polygon([OUTER], dim=3), id3dhp='TEST2')
    rc, txt = run_main(['x', '--gpkg', gp2, '--id', 'TEST2', '--slug', 'plain',
                        '--state', 'SC', '--out-dir', out2])
    assert rc == 0, txt
    assert 'polygons    1, with 0 hole(s)' in txt, txt
    g2 = json.load(open(os.path.join(out2, 'plain.geojson')))['features'][0]['geometry']
    assert g2['type'] == 'Polygon', g2['type']
    print('a ringless water is still a plain Polygon')

    # and it must still refuse to overwrite
    rc, txt = run_main(['x', '--gpkg', gp2, '--id', 'TEST2', '--slug', 'plain',
                        '--state', 'SC', '--out-dir', out2])
    assert rc == 1 and 'refusing to overwrite' in txt, txt
    print('refuses to overwrite an existing boundary')

    # THE WINDOWS CHECK. Ten assertions passed and then TemporaryDirectory blew up because
    # main() had left the GeoPackage open. os.remove is the same syscall rmtree makes, so
    # asserting it here fails in the test rather than in the teardown.
    os.remove(gp2)
    print('main() leaves no open handle on the geopackage')

print('\nmain() assertions pass')
