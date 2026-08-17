"""Drives match_waters_to_nhd.py against a REAL geodatabase read by REAL pyogrio.

Three bugs in build_water_chain.py reached Ryan's machine because its fake pyogrio was easier to
satisfy than the real one -- it returned lists where pyogrio returns numpy arrays, and always
returned the columns asked for where pyogrio drops missing ones silently. So this suite fakes
nothing: it writes an actual GeoPackage and reads it back through pyogrio.
"""
import importlib.util, sys, json, tempfile, io, contextlib
from pathlib import Path
import numpy as np, shapely
from shapely.geometry import Polygon
from pyogrio.raw import write

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('mwn', HERE / 'match_waters_to_nhd.py')
mwn = importlib.util.module_from_spec(spec); spec.loader.exec_module(mwn)
def eq(g, w, m): assert g == w, f'{m}: got {g!r} want {w!r}'

# --- gnis normalisation must agree with the other two tools
eq(mwn.normalize_gnis('gnis:988007.0'), mwn.normalize_gnis('gnis:988007'), 'float twin')
eq(mwn.normalize_gnis('slug:hiwassee_lake'), None, 'slug fallback')
eq(mwn.normalize_gnis('   '), None, 'whitespace')

hiw  = Polygon([(0,0),(0,10),(10,10),(10,0)])
chat = Polygon([(0,12),(0,16),(4,16),(4,12)])
far  = Polygon([(50,50),(50,52),(52,52),(52,50)])
tiny = Polygon([(3,3),(3,3.2),(3.2,3.2),(3.2,3)])      # too small a share to bind

def build(root, spell=str):
    (root/'registry'/'boundaries').mkdir(parents=True)
    (root/'nhd').mkdir()
    bigger = Polygon([(30,30),(30,40),(38,40),(38,30)])   # larger than the registry outline
    polys  = [hiw, chat, far, bigger]
    pids   = ['wb_hiwassee','wb_chatuge','wb_far','wb_bigger']
    gnisid = ['1016964','1012001','999','888']  # 1016964 "Persimmon Lake" ON THE BIG BODY
    gnisnm = ['Persimmon Lake','Chatuge Lake','Somewhere Else','Big Lake']
    write(str(root/'nhd'/'NHDPLUS_H_0602_HU4_20220418_GDB.gpkg'),
          geometry=shapely.to_wkb(np.array(polys, dtype=object)),
          field_data=[np.array(pids,dtype=object), np.array(gnisid,dtype=object),
                      np.array(gnisnm,dtype=object), np.array([40.0,16.0,4.0,80.0]),
                      np.array([390,390,390,390])],
          fields=[spell('Permanent_Identifier'), spell('GNIS_ID'), spell('GNIS_Name'),
                  spell('AreaSqKm'), spell('FType')],
          layer='NHDWaterbody', geometry_type='Polygon', crs='EPSG:4326', driver='GPKG')
    # A RIVER lives in NHDArea, split into pieces that share one GNIS id. Reading only
    # NHDWaterbody left 59 of 90 rivers and all 16 coastal waters unbound on the real data.
    riv = [Polygon([(0,20),(0,21),(6,21),(6,20)]), Polygon([(6,20),(6,21),(12,21),(12,20)]),
           Polygon([(12,20),(12,21),(18,21),(18,20)]),
           # a second lobe of the big lake, carrying NO GNIS id, so the dissolve cannot find it
           Polygon([(11,1),(11,9),(14,9),(14,1)])]
    write(str(root/'nhd'/'NHDPLUS_H_0602_HU4_20220418_GDB.gpkg'),
          geometry=shapely.to_wkb(np.array(riv, dtype=object)),
          field_data=[np.array(['ar1','ar2','ar3','lobe2'],dtype=object),
                      np.array(['1234567','1234567','1234567',''],dtype=object),
                      np.array(['Little Pee Dee River']*3+[''],dtype=object),
                      np.array([2.0,2.0,2.0,16.0]), np.array([460,460,460,390])],
          fields=[spell('Permanent_Identifier'), spell('GNIS_ID'), spell('GNIS_Name'),
                  spell('AreaSqKm'), spell('FType')],
          layer='NHDArea', geometry_type='Polygon', crs='EPSG:4326', driver='GPKG',
          append=True)
    def geo(slug, poly):
        json.dump({'type':'Feature','properties':{},
                   'geometry':{'type':'Polygon','coordinates':[list(poly.exterior.coords)]}},
                  open(root/'registry'/'boundaries'/f'{slug}.geojson','w'))
    reg = {
      'persimmon_lake': {'gnis':'gnis:1016964','area_acres':5914.5,'bounds_wsen':[0,0,10,10]},
      'hiwassee_lake':  {'gnis':'slug:hiwassee_lake','area_acres':6755.8,'bounds_wsen':[-1,-1,15,11]},
      'chatuge_lake':   {'gnis':'gnis:1012001','area_acres':6364.4,'bounds_wsen':[0,12,4,16]},
      'wrong_id_water': {'gnis':'gnis:777','area_acres':4.0,'bounds_wsen':[50,50,52,52]},
      'a_speck':        {'gnis':'slug:a_speck','area_acres':0.1,'bounds_wsen':[3,3,3.2,3.2]},
      'small_outline_big_lake': {'gnis':'slug:small_outline_big_lake','area_acres':9529.6,
                                 'bounds_wsen':[30,30,36,40]},
      'no_polygon':     {'gnis':'gnis:5','area_acres':1.0,'bounds_wsen':[0,0,1,1]},
      'little_pee_dee_river': {'gnis':'slug:little_pee_dee_river','area_acres':1740.6,
                               'bounds_wsen':[0,20,18,21]},
    }
    geo('persimmon_lake', hiw)
    geo('hiwassee_lake', Polygon([(-0.5,-0.5),(-0.5,10.5),(14.5,10.5),(14.5,-0.5)]))
    geo('chatuge_lake', chat)
    geo('wrong_id_water', far)
    geo('a_speck', tiny)
    # registry outline covers only part of the NHD polygon -- NHD is the bigger one here
    geo('small_outline_big_lake', Polygon([(30,30),(30,40),(36,40),(36,30)]))
    # the registry river spans all three NHDArea pieces; no single piece would clear the gate
    geo('little_pee_dee_river', Polygon([(0,20),(0,21),(18,21),(18,20)]))
    json.dump(reg, open(root/'registry'/'lake_index.json','w'))
    return reg

def run(root, extra=()):
    out = root/'bindings.json'
    sys.argv = ['x', '--registry', str(root/'registry'/'lake_index.json'),
                '--gdb', str(root/'nhd'/'NHDPLUS_H_0602_HU4_20220418_GDB.gpkg'),
                '--json', str(out), *extra]
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = mwn.main()
    return rc, json.loads(out.read_text()), buf.getvalue()

for label, spell in (('exact', str), ('upper', str.upper), ('lower', str.lower)):
    with tempfile.TemporaryDirectory() as t:
        root = Path(t); reg = build(root, spell)
        rc, got, text = run(root)
        eq(rc, 0, f'[{label}] runs clean')

        # THE HEADLINE: two registry slugs on one NHD waterbody. This is the duplicate detector
        # that needs neither a name nor an id, and it is what the GNIS check could not see.
        key = '0602/wb_hiwassee'
        assert key in got['conflicts'], f'[{label}] conflict not found: {got["conflicts"]}'
        eq(sorted(got['conflicts'][key]), ['hiwassee_lake','persimmon_lake'],
           f'[{label}] both slugs claim the Hiwassee body')

        # a water with NO gnis id gets placed on geometry alone -- the 150-water gap
        assert 'hiwassee_lake' in got['bindings'], f'[{label}] id-less water not bound'
        eq(got['bindings']['hiwassee_lake']['permanent_identifier'], 'wb_hiwassee', 'bound right')
        eq(got['bindings']['hiwassee_lake']['registry_gnis'], 'slug:hiwassee_lake', 'still id-less')

        # NHD's own name and id travel with the binding, so a wrong name is visible
        eq(got['bindings']['persimmon_lake']['nhd_gnis_name'], 'Persimmon Lake', 'nhd name kept')
        eq(got['bindings']['persimmon_lake']['nhd_gnis_id'], '1016964', 'nhd id kept')

        # id says one waterbody, ground says another
        eq(got['id_disputes'], ['wrong_id_water'], f'[{label}] id dispute')

        # A RIVER binds only if NHDArea is read AND its pieces are dissolved first: each single
        # piece is a third of the registry outline and would fail the size gate on its own.
        assert 'little_pee_dee_river' in got['bindings'], \
            f'[{label}] river unbound -- NHDArea not read or pieces not dissolved'
        _r = got['bindings']['little_pee_dee_river']
        eq(_r['nhd_layer'], 'NHDArea', f'[{label}] came from the river layer')
        eq(_r['nhd_pieces'], 3, f'[{label}] all three pieces dissolved into one water')
        eq(_r['nhd_gnis_name'], 'Little Pee Dee River', f'[{label}] name carried through')
        assert _r['pct_of_registry_polygon'] > 90, f'[{label}] dissolved cover: {_r}'
        eq(_r['nhd_ftype'], 460, f'[{label}] FType 460 StreamRiver')

        # NHD splits a big lake across polygons that do not share a GNIS id, so the single best
        # group understates it. hartwell_lake measured 33,596 ac against a registry 54,072 and a
        # real ~56,000: the registry was right and the measurement was wrong.
        _h = got['bindings']['hiwassee_lake']
        assert _h['nhd_union_pieces'] >= 2, \
            f'[{label}] both lobes should union: {_h["nhd_union_pieces"]}'
        assert _h['nhd_union_acres'] > _h['nhd_acres'], \
            f'[{label}] union must exceed the single best group: {_h}'
        # ...but the union must NOT drive the binding, or a lake whose outline covers the next
        # lake downstream swallows it -- the cheoah/calderwood confusion.
        eq(_h['nhd_pieces'], 1, f'[{label}] binding still the single best group')
        # both coverage figures are geometric, so no declared-area basis can creep in
        assert _h['union_covers_pct_of_registry'] is not None, 'coverage reported'
        assert _h['registry_covers_pct_of_union'] > 90, \
            f'[{label}] both lobes lie inside the outline: {_h}'

        # A polygon LARGER than the registry outline must still be in its own union. The first
        # cut required 90% containment, so lake_marion's main body was excluded and the union
        # came back 2,677 acres against a single best polygon of 91,472.
        _big = got['bindings']['small_outline_big_lake']
        assert _big['nhd_union_acres'] >= _big['nhd_acres'], \
            f'[{label}] UNION MUST CONTAIN ITS OWN BEST MATCH: {_big}'
        assert _big['union_covers_pct_of_registry'] > 95, \
            f'[{label}] the outline is entirely water: {_big}'
        assert _big['registry_covers_pct_of_union'] < 80, \
            f'[{label}] and it misses a fifth of the lake: {_big}'

        # A 0.1-acre speck lying WHOLLY INSIDE the reservoir is 100% contained and is not it.
        # Same lesson as greenfield_lake inside the Cape Fear coastal region.
        assert 'a_speck' not in got['bindings'], \
            f'[{label}] CONTAINMENT IS NOT IDENTITY: {got["bindings"].get("a_speck")}'
        assert 'a_speck' in got['unbound'] and 'no_polygon' in got['unbound'], 'unbound listed'

        # never edits
        assert json.loads((root/'registry'/'lake_index.json').read_text()) == reg, \
            'lake_index.json MUST be byte identical afterwards'
    print(f'[{label}] assertions pass')

# --- a genuinely missing column refuses and says what the layer has, rather than KeyError
with tempfile.TemporaryDirectory() as t:
    root = Path(t); build(root)
    write(str(root/'nhd'/'NHDPLUS_H_0602_HU4_20220418_GDB.gpkg'),
          geometry=shapely.to_wkb(np.array([hiw], dtype=object)),
          field_data=[np.array(['wb_hiwassee'],dtype=object)],
          fields=['Permanent_Identifier'], layer='NHDWaterbody',
          geometry_type='Polygon', crs='EPSG:4326', driver='GPKG', append=False)
    rc, got, text = run(root)
    eq(rc, 0, 'a bad layer must not crash the run')
    assert 'REFUSED' in text and 'GNIS_ID' in text, text[-400:]
    assert 'it does have' in text, 'must say what the layer actually holds'
    eq(got['bindings'], {}, 'nothing bound from a refused layer')
print('missing-column refusal assertions pass')

# --- min-overlap is honoured
with tempfile.TemporaryDirectory() as t:
    root = Path(t); build(root)
    rc, got, _ = run(root, extra=('--min-overlap', '99.9', '--min-area-ratio', '0.1'))
    assert 'hiwassee_lake' not in got['bindings'], 'a 99.9% floor must reject the loose match'
    assert 'persimmon_lake' in got['bindings'], 'an exact match still clears 99.9%'
print('min-overlap assertions pass')
print('ALL match_waters_to_nhd assertions pass')
