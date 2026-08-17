import importlib.util, sys, json, tempfile, io, contextlib
from pathlib import Path
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('mdw', HERE/'merge_duplicate_waters.py')
mdw = importlib.util.module_from_spec(spec); spec.loader.exec_module(mdw)
def eq(g,w,m): assert g==w, f'{m}: got {g!r} want {w!r}'

# --- present(): 0 and False are values; None, '', [] and {} are not.
assert mdw.present(0) and mdw.present(False) and mdw.present(0.0), '0 IS a value'
assert not mdw.present(None) and not mdw.present('') and not mdw.present('   ')
assert not mdw.present([]) and not mdw.present({})
assert mdw.present([1]) and mdw.present({'a':1}) and mdw.present('x')

# --- the live case: the keeper has NO ramps, the retiree has one
keeper = {'name':'John H. Moss Lake','display_name':'John H. Moss Lake (Cleveland Co, NC)',
          'legacy_display_names':['John H. Moss Lake, NC'],'gnis':'gnis:988007.0',
          'area_acres':1283.7,'charted':0.9625,'pack_mb':10.18,'ramps':{},'ramp_sources':0,
          'access_for_me':None,'usgs':{'site':'0215329875'}}
retiree = {'name':'Kings Mountain Reservoir','display_name':'Kings Mountain Reservoir (Cleveland Co, NC)',
           'legacy_display_names':['Kings Mountain Reservoir, NC'],'gnis':'gnis:988007',
           'area_acres':1283.7,'charted':0.9625,'pack_mb':10.18,
           'ramps':{'osm_1':{'name':'ramp'}},'ramp_sources':1,
           'access_for_me':'Unknown','usgs':{'site':'0215329875'}}
m, notes = mdw.merge_entry(keeper, retiree, 'john_h_moss_lake', 'kings_mountain_reservoir',
                           gnis='gnis:988007')
eq(m['name'],'John H. Moss Lake','keeper name survives')
eq(m['gnis'],'gnis:988007','the CLEAN id, decided per pair, not the .0 one')
eq(len(m['ramps']),1,'THE OSM RAMP CROSSES OVER -- the keeper had none')
eq(m['ramp_sources'],1,'ramp_sources recounted from the merged dict')
eq(m['access_for_me'],'Unknown','a null field takes the retiree value')
assert 'Kings Mountain Reservoir (Cleveland Co, NC)' in m['legacy_display_names'], \
    'the old name must stay searchable'
assert 'Kings Mountain Reservoir, NC' in m['legacy_display_names'], 'and its legacy spelling'
eq(m['merged_from'],['kings_mountain_reservoir'],'provenance recorded')
eq(keeper['ramps'],{},'INPUTS MUST NOT BE MUTATED')
eq(retiree['ramps'],{'osm_1':{'name':'ramp'}},'nor the retiree')

# --- geometry fields must NOT come from the retiree: we are keeping the keeper's polygon
k2 = {'name':'Falls Lake','area_acres':9529.6,'charted':0.9054,'pack_mb':5.0,
      'bounds_wsen':[1,1,2,2],'centroid':[1.5,1.5],'gnis':'slug:falls_lake','ramps':{}}
r2 = {'name':'Brinkley Lake','area_acres':12956.0,'charted':0.8548,'pack_mb':9.9,
      'bounds_wsen':[0,0,3,3],'centroid':[1.5,1.6],'gnis':'gnis:1000009','ramps':{}}
m2, n2 = mdw.merge_entry(k2, r2, 'falls_lake', 'brinkley_lake', gnis=None)
eq(m2['area_acres'],9529.6,'keeper acreage')
eq(m2['bounds_wsen'],[1,1,2,2],'keeper bounds')
eq(m2['charted'],0.9054,'keeper charted')
# THE ONE THAT MATTERS: gnis:1000009 belongs to a different real feature.
eq(m2['gnis'],'slug:falls_lake',
   'THE RETIRING ID MUST NOT BE INHERITED -- it names a different feature')
assert any('deliberately NOT inherited' in x for x in n2), 'and the refusal must be stated'
assert 'Brinkley Lake' in m2['legacy_display_names'], 'still searchable by the old name'

# --- end to end, including refusals and that nothing is deleted without --write
with tempfile.TemporaryDirectory() as t:
    root=Path(t); (root/'registry').mkdir()
    reg={'falls_lake':dict(k2),'brinkley_lake':dict(r2),
         'john_h_moss_lake':dict(keeper),'kings_mountain_reservoir':dict(retiree),
         'lonely_lake':{'name':'Lonely','gnis':'gnis:1','ramps':{}}}
    (root/'registry'/'lake_index.json').write_text(json.dumps(reg))
    (root/'registry'/'_nhd_bindings.json').write_text(json.dumps({'bindings':{
        'falls_lake':{'permanent_identifier':'31426065','vpu':'0302','nhd_gnis_name':'Brinkley Lake'}}}))
    dec=[{'keep':'falls_lake','retire':'brinkley_lake','gnis':None,'reason':'NHD mis-names it'},
         {'keep':'john_h_moss_lake','retire':'kings_mountain_reservoir','gnis':'gnis:988007'},
         {'keep':'falls_lake','retire':'does_not_exist'},
         {'keep':'lonely_lake','retire':'lonely_lake'}]
    dp=root/'dec.json'; dp.write_text(json.dumps(dec))

    def run(extra=()):
        sys.argv=['x','--registry',str(root/'registry'/'lake_index.json'),
                  '--decisions',str(dp),*extra]
        buf=io.StringIO()
        with contextlib.redirect_stdout(buf): rc=mdw.main()
        return rc, buf.getvalue()

    rc,text = run()
    eq(rc,0,'runs clean')
    assert '2 merged, 2 refused' in text, text[-400:]
    assert 'DRY RUN' in text, 'must not write by default'
    eq(json.loads((root/'registry'/'lake_index.json').read_text()), reg,
       'A DRY RUN MUST LEAVE lake_index.json BYTE IDENTICAL')
    assert 'NOTHING IN R2 WAS TOUCHED' in text, 'R2 is only listed'
    assert '31426065' in text, 'the NHD binding is carried onto the keeper'

    rc,text = run(('--write',))
    after=json.loads((root/'registry'/'lake_index.json').read_text())
    assert 'brinkley_lake' not in after and 'kings_mountain_reservoir' not in after, 'retired'
    assert 'falls_lake' in after and 'john_h_moss_lake' in after, 'keepers survive'
    eq(len(after),3,'5 waters became 3')
    eq(after['falls_lake']['gnis'],'slug:falls_lake','still refuses the borrowed id')
    eq(after['falls_lake']['nhd_permanent_identifier'],'31426065','bound by discovered key')
    eq(len(after['john_h_moss_lake']['ramps']),1,'ramp survived the write')
    assert (root/'registry'/'lake_index.json.bak').exists(), 'a backup MUST be made'
    eq(json.loads((root/'registry'/'lake_index.json.bak').read_text()), reg, 'backup is the original')
    tab=json.loads((root/'registry'/'_deletion_tab.json').read_text())['retired']
    eq(sorted(x['slug'] for x in tab), ['brinkley_lake','kings_mountain_reservoir'], 'tab')
    assert all(x.get('pack_mb') is not None for x in tab), 'pack size recorded for the R2 pass'

    # rerunning must not double-count the tab
    rc,text = run(('--write',))
    tab2=json.loads((root/'registry'/'_deletion_tab.json').read_text())['retired']
    eq(len(tab2),2,'a second run must not duplicate tab entries')
print('ALL merge_duplicate_waters assertions pass')
