"""Registry-level tests for find_duplicate_waters.py. Geometry maths lives in test_geomcore.py."""
import importlib.util, sys, json, tempfile, os
from pathlib import Path
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('fdw', HERE/'find_duplicate_waters.py')
fdw = importlib.util.module_from_spec(spec); spec.loader.exec_module(fdw)
def eq(g,w,m): assert g==w, f'{m}: got {g!r} want {w!r}'
ENGINE = os.environ.get('DUPE_ENGINE','shapely')
print('engine under test:', ENGINE)

# --- gnis normalisation must agree with build_water_chain.py
eq(fdw.normalize_gnis('gnis:988007.0'), fdw.normalize_gnis('gnis:988007'), 'float twin collides')
eq(fdw.normalize_gnis('slug:lookout_shoals_lake'), None, 'a slug fallback has no id to collide on')
eq(fdw.normalize_gnis('nhd:123388379'), None, 'nhd id is not a gnis id')
eq(fdw.normalize_gnis('   '), None, 'whitespace')
eq(fdw.normalize_gnis('00991183'), '991183', 'zero padded')

# --- bbox prefilter
A=[0,0,10,10]
eq(fdw.boxes_overlap(A,[0,0,10,10]), 1.0, 'identical boxes')
eq(fdw.boxes_overlap(A,[20,20,30,30]), 0.0, 'disjoint')
eq(fdw.boxes_overlap(A,[2,2,4,4]), 1.0, 'contained -> 100% of the smaller')
eq(round(fdw.boxes_overlap(A,[5,0,15,10]),3), 0.5, 'half')
eq(fdw.boxes_overlap(A,None), 0.0, 'missing bbox')
eq(fdw.boxes_overlap(A,[10,10,20,20]), 0.0, 'corner touch is not overlap')
assert fdw.boxes_overlap([0,0,1,1],[1.05,0,2,1],pad=0.1) > 0, 'pad catches a near miss'

# --- rings_of handles every geojson shape the registry might hold
with tempfile.TemporaryDirectory() as t:
    d=Path(t); ring=[[0,0],[0,1],[1,1],[1,0],[0,0]]
    (d/'a.geojson').write_text(json.dumps({'type':'Polygon','coordinates':[ring]}))
    (d/'b.geojson').write_text(json.dumps({'type':'Feature','properties':{},'geometry':{'type':'Polygon','coordinates':[ring]}}))
    (d/'c.geojson').write_text(json.dumps({'type':'FeatureCollection','features':[
        {'type':'Feature','properties':{},'geometry':{'type':'MultiPolygon','coordinates':[[ring],[ring]]}}]}))
    eq(len(fdw.rings_of(d/'a.geojson')),1,'bare Polygon')
    eq(len(fdw.rings_of(d/'b.geojson')),1,'Feature')
    eq(len(fdw.rings_of(d/'c.geojson')),2,'MultiPolygon inside a FeatureCollection')

# --- end to end on a fake registry carrying BOTH real pairs
with tempfile.TemporaryDirectory() as t:
    root=Path(t); (root/'registry'/'boundaries').mkdir(parents=True)
    def geo(p,ring): (root/'registry'/'boundaries'/f'{p}.geojson').write_text(
        json.dumps({'type':'Feature','properties':{},'geometry':{'type':'Polygon','coordinates':[ring]}}))
    outer=[[0,0],[0,10],[10,10],[10,0],[0,0]]; innr=[[1,1],[1,4],[4,4],[4,1],[1,1]]
    far=[[50,50],[50,55],[55,55],[55,50],[50,50]]
    reg={
      'lookout_shoals_lake':{'bounds_wsen':[0,0,10,10],'area_acres':1551.8,'gnis':'slug:lookout_shoals_lake','charted':0.792,'county':'Catawba','feature_type':'lake'},
      'lake_lookout':{'bounds_wsen':[1,1,4,4],'area_acres':772.2,'gnis':'gnis:999363','charted':0.985,'county':'Iredell','feature_type':'lake'},
      'john_h_moss_lake':{'bounds_wsen':[50,50,55,55],'area_acres':1283.7,'gnis':'gnis:988007.0','charted':0.9625,'county':'Cleveland','feature_type':'lake'},
      'kings_mountain_reservoir':{'bounds_wsen':[50,50,55,55],'area_acres':1283.7,'gnis':'gnis:988007','charted':0.9625,'county':'Cleveland','feature_type':'lake'},
      'somewhere_else':{'bounds_wsen':[200,200,201,201],'area_acres':5.0,'gnis':'gnis:111111','charted':0.5,'county':'X','feature_type':'lake'},
    }
    (root/'registry'/'lake_index.json').write_text(json.dumps(reg))
    geo('lookout_shoals_lake',outer); geo('lake_lookout',innr)
    geo('john_h_moss_lake',far); geo('kings_mountain_reservoir',far)
    geo('somewhere_else',[[200,200],[200,201],[201,201],[201,200],[200,200]])
    out=root/'dupes.json'
    sys.argv=['x','--registry',str(root/'registry'/'lake_index.json'),'--json',str(out),'--engine',ENGINE]
    eq(fdw.main(),0,'runs clean')
    got=json.loads(out.read_text())
    eq(got['engine'],ENGINE,'reports the engine it used')
    eq(list(got['gnis_collisions']),['988007'],'the float twin collides')
    pairs={tuple(sorted((f['a'],f['b']))):f for f in got['geometry_overlaps']}

    assert ('lake_lookout','lookout_shoals_lake') in pairs, 'GEOMETRY FOUND THE PAIR GNIS MISSED'
    lp=pairs[('lake_lookout','lookout_shoals_lake')]
    assert 'PARTIAL TRACE' in lp['verdict'], lp['verdict']
    keep = lp['b'] if lp['verdict'].endswith('keep B') else lp['a']
    eq(keep,'lookout_shoals_lake','names the FULLER polygon as the keeper')

    assert ('john_h_moss_lake','kings_mountain_reservoir') in pairs, 'and still finds the easy one'
    eq(pairs[('john_h_moss_lake','kings_mountain_reservoir')]['verdict'],
       'SAME POLYGON TWICE','identical outlines, the case vertex sampling could not see')

    assert not any('somewhere_else' in (f['a'],f['b']) for f in got['geometry_overlaps']), \
        'a lake on its own must not be paired with anything'
    assert json.loads((root/'registry'/'lake_index.json').read_text())==reg, \
        'THE REGISTRY MUST BE BYTE IDENTICAL AFTERWARDS -- this tool never edits'
print('ALL find_duplicate_waters assertions pass')
