#!/usr/bin/env python3
"""render_pack.py - draw a chartpack window to a PNG and LOOK at it.

Personal use only, not for distribution or resale; not for navigation.

    py Scripts\\render_pack.py -81.0330 33.9330 -81.0120 33.9500 congaree_river out.png
                                 W        S        E        N     slug          png

WHY THIS EXISTS, 2026-09-21. Ryan spent a day saying "same holes" while every measurement I ran
said the river was 97% covered. Both were true and neither was the answer. What ended it was one
coordinate from him and this: the pack files drawn straight to an image -- bands in blue, the
unsurveyed layer hatched in red, the 3DHP boundary in black -- with no app, no cache and no
basemap in the way. Four minutes, and the two different things wearing the same hatch were
obvious on sight: a rim where 3DHP draws the bank wider than the water, and a 600 m sliver up
the middle of the channel with soundings either side of it.

REACH FOR THIS FIRST when he says the map is wrong, not last. A percentage cannot show you that
two layers are the same colour, and it cannot show you that a strip is in the middle of the
channel rather than on the bank.

It reads the pack on disk, so it says what was BUILT. If that disagrees with his screen the
difference is the upload or the browser cache, and that is worth knowing on its own -- see
CACHE_SCHEMA in js/modules/supplemental-layers.js for how long that went unnoticed.
"""
import json,sys,os
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon as MPoly
from shapely.geometry import shape,box
def rd(p):
    with open(p,encoding='utf-8') as fh: return json.load(fh).get('features') or []
W,S,E,N=[float(x) for x in sys.argv[1:5]]
slug=sys.argv[5]; out=sys.argv[6]
V=box(W,S,E,N)
fig,ax=plt.subplots(figsize=(13,10),dpi=110)
ax.set_facecolor('#e8e4dc')
def draw(path,fc,ec,lw,alpha,label,zo):
    if not os.path.exists(path): return 0
    n=0
    for f in rd(path):
        try: g=shape(f['geometry'])
        except Exception: continue
        if g.is_empty: continue
        b=g.bounds
        if b[2]<W or b[0]>E or b[3]<S or b[1]>N: continue
        try: gg=(g if g.is_valid else g.buffer(0)).intersection(V)
        except Exception: continue
        if gg.is_empty: continue
        for q in (gg.geoms if hasattr(gg,'geoms') else [gg]):
            if q.geom_type!='Polygon' or q.is_empty: continue
            ax.add_patch(MPoly(list(q.exterior.coords),closed=True,facecolor=fc,edgecolor=ec,
                               linewidth=lw,alpha=alpha,zorder=zo,label=label if n==0 else None))
            n+=1
    return n
nb=draw('chartpack/%s/depth_areas.geojson'%slug,'#4a90d9','#2a5a8a',0.25,0.75,'depth bands',2)
nu=draw('chartpack/%s/unsurveyed.geojson'%slug,'none','#b03030',0.9,1.0,'unsurveyed (outline)',4)
# hatch the unsurveyed so it reads like the app
if os.path.exists('chartpack/%s/unsurveyed.geojson'%slug):
    for f in rd('chartpack/%s/unsurveyed.geojson'%slug):
        try: g=shape(f['geometry'])
        except Exception: continue
        try: gg=(g if g.is_valid else g.buffer(0)).intersection(V)
        except Exception: continue
        if gg.is_empty: continue
        for q in (gg.geoms if hasattr(gg,'geoms') else [gg]):
            if q.geom_type!='Polygon': continue
            ax.add_patch(MPoly(list(q.exterior.coords),closed=True,facecolor='none',
                               edgecolor='#b03030',hatch='///',linewidth=0,zorder=3))
bp='registry/boundaries/%s.geojson'%slug
nbd=0
for f in (rd(bp) if os.path.exists(bp) else []):
    try: g=shape(f['geometry'])
    except Exception: continue
    gg=g.intersection(V)
    if gg.is_empty: continue
    for q in (gg.geoms if hasattr(gg,'geoms') else [gg]):
        if q.geom_type!='Polygon': continue
        ax.add_patch(MPoly(list(q.exterior.coords),closed=True,facecolor='none',
                           edgecolor='#111111',linewidth=1.6,zorder=6)); nbd+=1
ax.set_xlim(W,E); ax.set_ylim(S,N); ax.set_aspect(1/0.83)
ax.set_title('%s  blue=depth bands(%d)  red hatch=unsurveyed(%d)  black=3DHP boundary(%d)'%(slug,nb,nu,nbd),fontsize=10)
plt.tight_layout(); plt.savefig(out); print('wrote',out,nb,nu,nbd)
