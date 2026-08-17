import importlib.util, sys, json, tempfile
from pathlib import Path
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('fdw', HERE / 'find_duplicate_waters.py')
fdw = importlib.util.module_from_spec(spec); spec.loader.exec_module(fdw)
def eq(g,w,m): assert g==w, f'{m}: got {g!r} want {w!r}'

# --- gnis normalisation must agree with build_water_chain.py
eq(fdw.normalize_gnis('gnis:988007.0'), fdw.normalize_gnis('gnis:988007'), 'float twin')
eq(fdw.normalize_gnis('slug:lookout_shoals_lake'), None, 'slug fallback has no id to collide on')
eq(fdw.normalize_gnis('   '), None, 'whitespace')

# --- bbox prefilter
A=[0,0,10,10]
eq(fdw.boxes_overlap(A, [0,0,10,10]), 1.0, 'identical boxes')
eq(fdw.boxes_overlap(A, [20,20,30,30]), 0.0, 'disjoint')
eq(fdw.boxes_overlap(A, [2,2,4,4]), 1.0, 'contained -> 100% of the smaller')
eq(round(fdw.boxes_overlap(A, [5,0,15,10]),3), 0.5, 'half')
eq(fdw.boxes_overlap(A, None), 0.0, 'missing bbox')
eq(fdw.boxes_overlap(A, [10,10,20,20]), 0.0, 'corner touch is not overlap')
assert fdw.boxes_overlap([0,0,1,1], [1.05,0,2,1], pad=0.1) > 0, 'pad catches a near miss'

# --- ray casting, including a hole (Garmin draws shoreline as a hole; NHD has islands)
sq = [[0,0],[0,10],[10,10],[10,0],[0,0]]
hole = [[4,4],[4,6],[6,6],[6,4],[4,4]]
assert fdw.point_in_polys(5,1,[[sq]]), 'inside'
assert not fdw.point_in_polys(20,20,[[sq]]), 'outside'
assert not fdw.point_in_polys(5,5,[[sq,hole]]), 'a point in a hole is NOT in the polygon'
assert fdw.point_in_polys(1,1,[[sq,hole]]), 'still inside away from the hole'

# --- containment direction is what tells you which entry to keep
full  = [[[[0,0],[0,10],[10,10],[10,0],[0,0]]]]
part  = [[[[1,1],[1,4],[4,4],[4,1],[1,1]]]]        # wholly inside `full`
p_in_f,_ = fdw.containment(part, full); f_in_p,_ = fdw.containment(full, part)
assert p_in_f == 100.0, f'partial trace sits inside the full one, got {p_in_f}'
assert f_in_p < 40, f'the full one does NOT sit inside the partial, got {f_in_p}'
eq(fdw.verdict(p_in_f, f_in_p, 0.09, 0.30), 'A IS A PARTIAL TRACE OF B -- keep B', 'lake_lookout shape')
eq(fdw.verdict(f_in_p, p_in_f, 0.09, 0.30), 'B IS A PARTIAL TRACE OF A -- keep A', 'mirrored')
# the case containment alone gets wrong: identical outlines score ~50/50, not 100/100
eq(fdw.verdict(48.7, 50.5, 1.0, 0.0), 'SAME POLYGON TWICE', 'REAL moss/kings mountain numbers')
eq(fdw.verdict(40.0, 40.0, 1.0, 0.0), 'SAME POLYGON TWICE', 'two identical squares')
eq(fdw.verdict(5.0, 5.0, 0.2, 0.5), 'touching only, probably distinct', 'neighbours')
eq(fdw.verdict(50.0, 50.0, 0.5, 0.0), 'heavy overlap, look at it', 'concentric but half the size')

# --- shoelace area and centroid
a, cx, cy = fdw.area_centroid([[[[0,0],[0,10],[10,10],[10,0],[0,0]]]])
eq(round(a,6), 100.0, 'square area'); eq((round(cx,6),round(cy,6)), (5.0,5.0), 'square centroid')
ah, _, _ = fdw.area_centroid([[[[0,0],[0,10],[10,10],[10,0],[0,0]], [[4,4],[4,6],[6,6],[6,4],[4,4]]]])
eq(round(ah,6), 96.0, 'HOLE IS SUBTRACTED, not added')
rev, _, _ = fdw.area_centroid([[[[0,0],[10,0],[10,10],[0,10],[0,0]]]])
eq(round(rev,6), 100.0, 'winding order does not change the area')
eq(fdw.area_centroid([]), (0.0, None, None), 'empty geometry')
eq(fdw.containment([], full), (0.0, 0), 'empty geometry does not divide by zero')

# --- sampling must not change the verdict on a huge ring (Lake Marion is ~80k vertices)
import math
big = [[[[5+4*math.cos(t/2000*2*math.pi), 5+4*math.sin(t/2000*2*math.pi)] for t in range(2001)]]]
inb,used = fdw.containment(big, full)
assert used <= 1300, f'sampled down, used {used}'
assert inb == 100.0, f'a circle inside the square is still inside after sampling, got {inb}'

# --- end to end on a fake registry carrying BOTH real pairs
with tempfile.TemporaryDirectory() as t:
    root = Path(t); (root/'registry'/'boundaries').mkdir(parents=True)
    def geo(p, ring): (root/'registry'/'boundaries'/f'{p}.geojson').write_text(
        json.dumps({'type':'Feature','properties':{},'geometry':{'type':'Polygon','coordinates':[ring]}}))
    outer=[[0,0],[0,10],[10,10],[10,0],[0,0]]; innr=[[1,1],[1,4],[4,4],[4,1],[1,1]]
    far=[[50,50],[50,55],[55,55],[55,50],[50,50]]
    reg = {
      'lookout_shoals_lake':{'bounds_wsen':[0,0,10,10],'area_acres':1551.8,'gnis':'slug:lookout_shoals_lake','charted':0.792,'county':'Catawba'},
      'lake_lookout':{'bounds_wsen':[1,1,4,4],'area_acres':772.2,'gnis':'gnis:999363','charted':0.985,'county':'Iredell'},
      'john_h_moss_lake':{'bounds_wsen':[50,50,55,55],'area_acres':1283.7,'gnis':'gnis:988007.0','charted':0.9625,'county':'Cleveland'},
      'kings_mountain_reservoir':{'bounds_wsen':[50,50,55,55],'area_acres':1283.7,'gnis':'gnis:988007','charted':0.9625,'county':'Cleveland'},
      'somewhere_else':{'bounds_wsen':[200,200,201,201],'area_acres':5.0,'gnis':'gnis:111111','charted':0.5,'county':'X'},
    }
    (root/'registry'/'lake_index.json').write_text(json.dumps(reg))
    geo('lookout_shoals_lake',outer); geo('lake_lookout',innr)
    geo('john_h_moss_lake',far); geo('kings_mountain_reservoir',far)
    geo('somewhere_else',[[200,200],[200,201],[201,201],[201,200],[200,200]])
    out = root/'dupes.json'
    sys.argv = ['x','--registry',str(root/'registry'/'lake_index.json'),'--json',str(out)]
    eq(fdw.main(), 0, 'runs clean')
    got = json.loads(out.read_text())
    eq(list(got['gnis_collisions']), ['988007'], 'the float twin collides')
    pairs = {tuple(sorted((f['a'],f['b']))): f for f in got['geometry_overlaps']}
    assert ('lake_lookout','lookout_shoals_lake') in pairs, 'GEOMETRY FOUND THE PAIR GNIS MISSED'
    lp = pairs[('lake_lookout','lookout_shoals_lake')]
    assert 'PARTIAL TRACE' in lp['verdict'], lp['verdict']
    keep = lp['b'] if lp['verdict'].endswith('keep B') else lp['a']
    eq(keep, 'lookout_shoals_lake', 'names the FULLER polygon as the keeper')
    assert ('john_h_moss_lake','kings_mountain_reservoir') in pairs, 'and still finds the easy one'
    eq(pairs[('john_h_moss_lake','kings_mountain_reservoir')]['verdict'],'SAME POLYGON TWICE','moss')
    assert not any('somewhere_else' in (f['a'],f['b']) for f in got['geometry_overlaps']), \
        'a lake on its own must not be paired with anything'
    assert json.loads((root/'registry'/'lake_index.json').read_text()) == reg, \
        'THE REGISTRY MUST BE BYTE IDENTICAL AFTERWARDS -- this tool never edits'
print('ALL find_duplicate_waters assertions pass')
