import importlib.util, sys, math, time
from pathlib import Path
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('gc', HERE/'geomcore.py')
gc = importlib.util.module_from_spec(spec); spec.loader.exec_module(gc)
def eq(g,w,m): assert g==w, f'{m}: got {g!r} want {w!r}'
def near(g,w,tol,m): assert abs(g-w)<=tol, f'{m}: got {g} want ~{w}'

sq   = [[[[0,0],[0,10],[10,10],[10,0],[0,0]]]]
sq2  = [[[[0,0],[0,10],[10,10],[10,0],[0,0]]]]          # identical
part = [[[[1,1],[1,4],[4,4],[4,1],[1,1]]]]              # wholly inside sq, 9/100 of the area
half = [[[[5,0],[5,10],[15,10],[15,0],[5,0]]]]          # overlaps sq by half
away = [[[[50,50],[50,55],[55,55],[55,50],[50,50]]]]
hole = [[[[0,0],[0,10],[10,10],[10,0],[0,0]], [[4,4],[4,6],[6,6],[6,4],[4,4]]]]

ENGINES = [e for e in ('shapely','numpy','python') if gc.pick_engine(e)[0]==e]
print('engines under test:', ENGINES)
assert 'shapely' in ENGINES and 'numpy' in ENGINES, 'need both to compare them'

for eng in ENGINES:
    def M(a,b): return gc.measure(eng,a,b,sample=2000)
    # THE CASE VERTEX SAMPLING CANNOT SEE: two copies of one outline.
    a,b,r,s,_,_ = M(sq,sq2)
    lab,dup = gc.verdict(a,b,r,0.0)
    assert dup and 'SAME OUTLINE TWICE' in lab, f'[{eng}] identical polygons: {lab}'
    if eng=='shapely':
        near(a,100.0,0.01,'[shapely] identical is exactly 100%')
        near(b,100.0,0.01,'[shapely] both ways')
    # partial trace: the small one is wholly inside, the big one mostly is not
    a,b,r,s,_,_ = M(part,sq)
    assert a>=99, f'[{eng}] partial sits inside the full one, got {a}'
    assert b<40, f'[{eng}] the full one does not sit inside the partial, got {b}'
    lab,dup = gc.verdict(a,b,r,0.30)
    assert not dup, f'[{eng}] 9%-of-the-area containment is NOT identity: {lab}'
    near(r,0.09,0.01,f'[{eng}] area ratio 9/100')
    # half overlap
    a,b,r,s,_,_ = M(sq,half)
    near(a,50.0,3.0,f'[{eng}] half overlap measured as area, not boundary')
    lab,dup = gc.verdict(a,b,r,0.2)
    assert dup and 'HEAVY PARTIAL' in lab, f'[{eng}] half: {lab}'
    # disjoint
    a,b,r,s,_,_ = M(sq,away)
    eq((round(a),round(b)),(0,0), f'[{eng}] disjoint')
    eq(gc.verdict(a,b,r,9.9)[0],'touching only, probably distinct', f'[{eng}] disjoint verdict')
    # holes are subtracted, not added
    ah,_,_ = gc.area_centroid(hole)
    eq(round(ah,6),96.0,'hole subtracted')
    if eng=='shapely':
        _,_,_,_,area_h,_ = gc.overlap_shapely(hole,sq)
        near(area_h,96.0,0.01,'[shapely] hole subtracted too')
        # a point inside the hole is outside the polygon -> intersection with the hole is empty
        hb=[[[[4.4,4.4],[4.4,5.6],[5.6,5.6],[5.6,4.4],[4.4,4.4]]]]
        a,b,_,_,_,_ = gc.overlap_shapely(hb,hole)
        near(a,0.0,0.01,'[shapely] a patch inside the hole overlaps the polygon not at all')
    # empty / degenerate must not raise
    eq(gc.measure(eng,[],sq)[0],0.0,f'[{eng}] empty a')
    eq(gc.measure(eng,sq,[])[0],0.0,f'[{eng}] empty b')
    eq(gc.measure(eng,[[[[0,0],[1,1]]]],sq)[0],0.0,f'[{eng}] degenerate ring ignored')

# --- the two engines must not disagree about what is a duplicate
import random
random.seed(7)
disagree=0
for t in range(30):
    ox,oy = random.uniform(-3,12), random.uniform(-3,12)
    sz = random.uniform(1,12)
    other=[[[[ox,oy],[ox,oy+sz],[ox+sz,oy+sz],[ox+sz,oy],[ox,oy]]]]
    sa,sb,sr,ss,_,_ = gc.measure('shapely',sq,other,sample=4000)
    na,nb,nr,ns,_,_ = gc.measure('numpy',  sq,other,sample=4000)
    if gc.verdict(sa,sb,sr,0.5)[0] != gc.verdict(na,nb,nr,0.5)[0]: disagree+=1
assert disagree==0, f'engines disagreed on {disagree}/30 random overlaps'
print(f'engines agree on {30-disagree}/30 random overlaps')

# --- speed, on a polygon the size of Ryan's biggest file
N=60000
big=[[[ [5+4.5*math.cos(i/N*2*math.pi), 5+4.5*math.sin(i/N*2*math.pi)] for i in range(N)]]]
for eng in ('shapely','numpy'):
    t0=time.time(); gc.measure(eng,big,sq,sample=400); dt=time.time()-t0
    print(f'  {eng:8} {N} vertices vs a square: {dt:.2f}s')
    assert dt < 20, f'{eng} too slow: {dt}s'
print('ALL geomcore assertions pass')

# --- the labels that were dangerously wrong on the real 454-water run --------------------
# greenfield_lake (75 ac) wholly inside coast_cape_fear_nc (195,154 ac). Containment is TRUE
# and "keep the coastal one, drop the lake" is garbage. Scale decides, not containment.
lab, dup = gc.verdict(0.0, 100.0, 0.0004, 0.4, same_type=False)
assert not dup, 'a 75-acre lake inside a coastal region is NOT a duplicate'
assert 'containment, not identity' in lab, lab
lab, dup = gc.verdict(0.1, 100.0, 0.0009, 0.5, same_type=False)   # mosquito_creek / santee delta
assert not dup, 'creek inside a coastal region is not a duplicate'
# lake_blalock (lake) vs pacolet_river (river): the river runs through the lake
lab, dup = gc.verdict(28.1, 96.7, 0.291, 0.10, same_type=False)
assert not dup, 'a river running through a lake is not a duplicate'
assert 'DIFFERENT FEATURE TYPES' in lab, lab
# french_broad_river vs pigeon_river: same kind, but 7x apart in size
lab, dup = gc.verdict(14.2, 100.0, 0.142, 0.3, same_type=True)
assert not dup, 'a tributary inside a much larger river polygon is containment'

# --- and the ones that ARE worth acting on
lab, dup = gc.verdict(100.0, 100.0, 1.0, 0.0, same_type=True)
assert dup and 'SAME OUTLINE TWICE' in lab, lab            # moss / kings mountain
lab, dup = gc.verdict(87.6, 100.0, 0.876, 0.05, same_type=True)
assert dup, 'hiwassee / persimmon: same kind, comparable size, one inside the other'
lab, dup = gc.verdict(73.4, 99.8, 0.735, 0.05, same_type=True)
assert dup, 'brinkley / falls'
lab, dup = gc.verdict(49.7, 100.0, 0.498, 0.08, same_type=True)
assert dup, 'lookout shoals / lake lookout'
lab, dup = gc.verdict(42.4, 49.7, 0.853, 0.1, same_type=True)
assert dup and 'HEAVY PARTIAL' in lab, 'two coastal regions overlapping half their area'
lab, dup = gc.verdict(32.8, 77.6, 0.423, 0.2, same_type=True)
assert not dup, 'broad / first broad meet at a confluence, neither contains the other'

# --- the size gate is the whole point: same numbers, different scale, different answer
_, dup_small = gc.verdict(5.0, 100.0, 0.05, 0.3, same_type=True)
_, dup_big   = gc.verdict(95.0, 100.0, 0.95, 0.02, same_type=True)
assert not dup_small and dup_big, 'containment implies identity only at comparable size'
print('relationship-vs-duplicate assertions pass')
