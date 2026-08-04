#!/usr/bin/env python3
"""RGN4 (points) with chain-by-closure, and hunt for the LBL pool reference."""
import sys, struct
from collections import Counter
import gmapmf_decode_v40 as V
import gmapmf_lines_v50 as L
def u16(b,p): return struct.unpack_from('<H',b,p)[0]
def u32(b,p): return struct.unpack_from('<I',b,p)[0]
def poi_rows(T):
    if T.t7s < 12: return [],None
    d=T.data; rgn=T.rgn
    r4o,r4l=u32(rgn,0x55),u32(rgn,0x59)
    if not r4l: return [],None
    r4=d[r4o:r4o+r4l]
    out=[]
    for i,row in enumerate(T.data_rows):
        s=T.subs[T.first_sub+i]
        a=u32(row,8); b=u32(T.rows[i+1],8)
        if b>a: out.append((i,s,r4[a:b]))
    return out,r4
def pool_of(path):
    d=open(path,'rb').read()
    lbl=u32(d[:0x3d],0x21); h=d[lbl:lbl+u16(d,lbl)]
    ps,pl=u32(h,0x15),u32(h,0x19)
    return d[ps:ps+pl]
def strat(pool,off):
    if not (0<=off<len(pool)): return None
    e=pool.find(b'\0',off)
    if e<0: return None
    try: return pool[off:e].decode('utf-8')
    except: return None
def main(path):
    T=V.Tile(path); pr,r4=poi_rows(T)
    if not pr: print("%s: no RGN4"%path); return
    rows=[c for _i,_s,c in pr if len(c)>=16]
    tot=sum(len(r) for r in rows)
    print("\n=== %s POINTS: %d rows, %d bytes ==="%(path,len(rows),tot))
    for bw in (0,1,2,3,4):
        n=sum(1 for r in rows if L.chain(r,bw) is not None)
        if n: print("   bw=%d : %d/%d rows close"%(bw,n,len(rows)))
    bw,frac=L.detect_bw(rows)
    print("   -> bw=%d (%.1f%% of rows)"%(bw,100*frac))
    pool=pool_of(path)
    modes=Counter(); pay=0; samples=[]
    for r in rows:
        sbs=L.chain(r,bw)
        if sbs is None: continue
        for hdr,b in sbs:
            m=(hdr[0],hdr[1]); modes[m]+=1; pay+=len(b)
            if len(samples)<6 and len(b)>40: samples.append((m,hdr.hex(' '),b[:80]))
    print("   sub-blocks %d, payload %d B"%(sum(modes.values()),pay))
    print("   modes:",[("%d/%d"%m,c) for m,c in modes.most_common(12)])
    for m,h,b in samples:
        print("\n   mode %s hdr=%s"%(str(m),h))
        for k in range(0,len(b),16): print("      %s"%" ".join("%02x"%x for x in b[k:k+16]))
    # pool boundary offsets
    bnd={0}|{i+1 for i,c in enumerate(pool) if c==0}
    print("\n   pool %d B, %d string starts"%(len(pool),len(bnd)))
if __name__=="__main__":
    for p in sys.argv[1:]: main(p)
