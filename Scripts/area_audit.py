#!/usr/bin/env python3
"""Same audit, applied to the AREAS region (TRE7 column +0)."""
import sys, re
from collections import Counter
import gmapmf_decode_v40 as V
import gmapmf_lines_v50 as L
def area_rows(T):
    out=[]
    for i,row in enumerate(T.data_rows):
        s=T.subs[T.first_sub+i]
        a=V.u32(row,0); b=V.u32(T.rows[i+1],0)
        if b>a: out.append((i,s,T.rgn2[a:b]))
    return out
BAND=re.compile(rb'\xbc(.)(.)\x02\x10',re.S)      # depth band tag
def main(path):
    T=V.Tile(path)
    ar=area_rows(T); rows=[c for _i,_s,c in ar if len(c)>=16]
    tot=sum(len(r) for r in rows)
    print("\n=== %s AREAS: %d rows, %d bytes ==="%(path,len(rows),tot))
    for bw in (0,1,2,3,4,5):
        n=sum(1 for r in rows if L.chain(r,bw) is not None)
        by=sum(len(r) for r in rows if L.chain(r,bw) is not None)
        if n: print("   bw=%d : %4d/%d rows close (%.2f%% of bytes)"%(bw,n,len(rows),100*by/tot))
    bw,frac=L.detect_bw(rows)
    print("   -> bw=%d, %.1f%% of rows close"%(bw,100*frac))
    # census with the line walker
    modes=Counter(); md=Counter(); pay=recb=0; st=Counter(); rawb=hitb=0
    for r in rows:
        sbs=L.chain(r,bw)
        if sbs is None: st['unchained']+=1; continue
        for hdr,b in sbs:
            m=(hdr[0],hdr[1]); modes[m]+=1; pay+=len(b)
            bands={x.start() for x in BAND.finditer(b)}
            rawb+=len(bands)
            recs,used=L.walk_payload(b)
            recb+=used
            ends={h['gend']+al for h,_d,al,_e in recs}
            hitb+=len(bands&ends)
            for h,dm,al,e in recs:
                md[(m,'d' if dm is not None else 'n')]+=1
                st['depth' if dm is not None else 'nodepth']+=1
            if used<len(b): st['stall']+=1; md[(m,'s')]+=1
    print("   payload %d B, records consume %d (%.2f%%), sub-block stalls %d"%(pay,recb,100*recb/max(1,pay),st['stall']))
    print("   records: depth-tagged %d, other %d, total %d"%(st['depth'],st['nodepth'],st['depth']+st['nodepth']))
    print("   depth-BAND tags `bc .. 02 10`: %d raw, %d at a record boundary (%.1f%%)"%(rawb,hitb,100*hitb/max(1,rawb)))
    print("   modes:  ",[("%d/%d"%m,c) for m,c in modes.most_common(12)])
if __name__=="__main__":
    for p in sys.argv[1:]: main(p)
