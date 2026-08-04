#!/usr/bin/env python3
"""gmapmf_decode_v40.py — firmware-exact GMAPMF depth-contour decoder (B and C tiles).

Personal use only, not for distribution or resale; not for navigation.

Every rule below is read from the EchoMAP firmware disassembly, not fitted:
  * arc store   : index blocks of 8192 B, header {u32 A, u32 B}; W = (B & 3) + 1 BYTES PER SCALAR;
                  2*W bytes per point; 2045 ways per block; geometry base = n_blocks*8192 + A;
                  way k at A + 2*W*prefix_sum(counts[:k]).            (FUN_03f0a330 / FUN_03f0a664)
  * deltas      : BLOCKED lanes - first N scalars are lane X, next N are lane Y; zigzag;
                  shifted left by 32-(bits+hires); accumulated from the previous point.
                                                                      (FUN_03f0a0e0 / FUN_03f0852c)
  * reverse bit : walk the way's deltas backwards, subtracting.        (FUN_03f08264)
  * anchor      : first record coordinate shares a lane with the first delta lane.
                                                                      (FUN_03f0abc0 / FUN_03f0c9c0)
  * hires       : ctx+0x220 = (flags>>11)&7 on the MOST DETAILED level only, 0 elsewhere.
                  quantum = 360 / 2^(bits + hires).                    (FUN_03f06c80 / FUN_03f0abc0)
  * key base    : variable-width field at the head of each chunk, width = ctx[0x354],
                  value -> ctx[0x358], added to every selector id.  C uses 2 bytes, B uses 3.
                  Recover the width from the sentinel: `00 80 7f` sits at lead+9.  (FUN_03f0c9c0)
  * records     : depth records end with `91 05 06 <depth_dm> 09 7a 00 00 00`.
                  opcode bit0=1 is the line path (skip); bit2=1 (all of B) appends 1-2
                  trailing attribute bytes after the selector list - ignore them.

Usage:
    python gmapmf_decode_v40.py C4E0F1.GMP --out contours.geojson [--level 0]
"""


import argparse, json, math, struct
from collections import Counter
try:
    import zstandard as zstd
except ImportError:
    raise SystemExit("pip install zstandard")

UNIT24 = 360.0 / (1 << 24)
SHUFFLE = (0xB,0xC,0xA,0x0,0x8,0xF,0x2,0x1,0x6,0x4,0x9,0x3,0xD,0x5,0x7,0xE)
TAG  = bytes.fromhex("910506")
SENT = bytes.fromhex("00807f")
WAYS_PER_BLOCK = 2045
INDEX_BLOCK    = 8192
BASE = ""

def u16(b,p): return struct.unpack_from('<H',b,p)[0]
def u24(b,p): return b[p]|b[p+1]<<8|b[p+2]<<16
def s24(b,p):
    v=u24(b,p); return v-(1<<24) if v&0x800000 else v
def u32(b,p): return struct.unpack_from('<I',b,p)[0]
def unlock(src,key):
    ks=SHUFFLE[((key>>24)+(key>>16)+(key>>8)+key)&0xF]; out=bytearray(); ring=16
    for v in src:
        up=(v>>4)-ks-(key>>ring)-SHUFFLE[(key>>ring)&0xF]; ring=ring-4 if ring else 16
        lo=v-ks-(key>>ring)-SHUFFLE[(key>>ring)&0xF];      ring=ring-4 if ring else 16
        out.append(((up<<4)&0xF0)|(lo&0x0F))
    return bytes(out)
class Tile:
    def __init__(self,path):
        d=open(path,'rb').read(); self.data=d
        root=d[:0x3D]; tre_at=u32(root,0x19); rgn_at=u32(root,0x1D)
        tre=d[tre_at:tre_at+0x146]; rgn=d[rgn_at:rgn_at+0x7D]
        self.tre,self.rgn=tre,rgn
        t1,t1l=u32(tre,0x21),u32(tre,0x25); t2,t2l=u32(tre,0x29),u32(tre,0x2D)
        self.t7,self.t7l,self.t7s=u32(tre,0x7C),u32(tre,0x80),u16(tre,0x84)
        lv=d[t1:t1+t1l]
        if tre[0x0D]&0x80: lv=unlock(lv,u32(tre,0xAA))
        self.levels=[dict(zoom=lv[p]&0xF,inherited=bool(lv[p]&0x80),bits=lv[p+1],count=u16(lv,p+2))
                     for p in range(0,len(lv),4)]
        tre2=d[t2:t2+t2l]; subs=[]; cur=0
        # TRE2 stride is 16 bytes, minus 2 on the MOST DETAILED level. That level is the one
        # with the largest `bits` -- it is 24 on B and C tiles but 17 on A (overview) tiles,
        # so testing `bits == 24` walks A's table off the end.
        _maxbits=max((L['bits'] for L in self.levels if L['count']), default=24)
        for li,L in enumerate(self.levels):
            sz=14 if L['bits']==_maxbits else 16
            for r in range(L['count']):
                pk=u32(tre2,cur)
                subs.append(dict(si=len(subs),level=li,zoom=L['zoom'],bits=L['bits'],
                    shift24=24-L['bits'],rec=sz,flags=(pk>>28)&0xF,rgn_off=pk&0x0FFFFFFF,
                    lon_raw=s24(tre2,cur+4),lat_raw=s24(tre2,cur+7),
                    width=u16(tre2,cur+10)&0x7FFF,height=u16(tre2,cur+12),
                    end_chain=bool(u16(tre2,cur+10)&0x8000),
                    next_index=u16(tre2,cur+14) if sz==16 else None))
                cur+=sz
        self.subs=subs; self.tre2_pad=tre2[cur:]
        t7=d[self.t7:self.t7+self.t7l]
        rows=[t7[p:p+self.t7s] for p in range(0,len(t7),self.t7s)]
        r2l,r3l=u32(rgn,0x21),u32(rgn,0x3D)
        term = bool(rows and u32(rows[-1],0)==r2l and u32(rows[-1],4)==r3l)
        self.rows=rows; self.data_rows=rows[:-1] if term else rows
        self.first_sub=len(subs)-len(self.data_rows)
        self.rgn3=d[u32(rgn,0x39):u32(rgn,0x39)+r3l]
        self.rgn2=d[u32(rgn,0x1D):u32(rgn,0x1D)+r2l]
    def chunks(self):
        for i,row in enumerate(self.data_rows):
            s=self.subs[self.first_sub+i]
            a=u32(row,4); b=u32(self.rows[i+1],4)
            yield i,s,self.rgn3[a:b]

def zz(v): return (v>>1) ^ -(v&1)

class ArcStore:
    def __init__(self, path, verbose=True):
        p=path; f=open(p,'rb')
        f.seek(0); root=f.read(0x3D); rgn_off=u32(root,0x1D)
        f.seek(rgn_off); rgn=f.read(0x7D)
        r1=u32(rgn,0x15); r2=u32(rgn,0x1D)
        f.seek(r1); raw=f.read(r2-r1)
        self.raw=raw
        M=b'\x28\xB5\x2F\xFD'; ds=8192
        zd=zstd.ZstdCompressionDict(raw[:ds])
        pos=[]; c=ds
        while True:
            i=raw.find(M,c)
            if i<0: break
            pos.append(i); c=i+1
        ts=len(raw)-4*len(pos)
        # verify frame offset table
        offs=[u32(raw,ts+4*i) for i in range(len(pos))]
        self.table_ok = ([ds+v for v in offs]==pos)
        dc=zstd.ZstdDecompressor(dict_data=zd)
        self.frames=[dc.decompress(raw[s:(pos[i+1] if i+1<len(pos) else ts)],max_output_size=32*1024*1024)
                     for i,s in enumerate(pos)]
        # Index blocks are leading 8192-byte frames whose last u32 is 0 and B&~3 == 0. That
        # test alone is a GUESS -- a geometry frame can satisfy it. On C49BB2 it claims 3
        # blocks and the third has base 16,777,216, which is not a base at all; the tile then
        # decodes with 8.4-million-unit deltas and emits 3,249 km segments.
        #
        # So validate instead of guessing: a candidate count is right only if every block
        # chains (base[i+1] == base[i] + 2*W*sum(counts[i])) AND the last one ends exactly on
        # the geometry size. Take the largest count that satisfies both.
        cand=[]
        for fr in self.frames:
            if len(fr)!=8192: break
            v=struct.unpack('<2048I',fr)
            if (v[1]>>2)!=0 or v[-1]!=0: break
            cand.append(v)
        def _chains(bl):
            if not bl: return False
            geom=sum(len(f) for f in self.frames[len(bl):])
            for i,v in enumerate(bl):
                W=(v[1]&3)+1
                nxt=v[0]+2*W*sum(v[2:2047])
                exp=bl[i+1][0] if i+1<len(bl) else geom
                if nxt!=exp: return False
            return True
        n=len(cand)
        while n>0 and not _chains(cand[:n]): n-=1
        if n==0: n=len(cand)                      # nothing validates: keep the old behaviour
        self.blocks=cand[:n]
        self.geom=b''.join(self.frames[len(self.blocks):])
        self.KPB=2045
        self.pre=[]
        for v in self.blocks:
            p_=[0]
            for c_ in v[2:2047]: p_.append(p_[-1]+c_)
            self.pre.append(p_)
        self.nkeys=len(self.blocks)*self.KPB
        # Health, computed once and EXPOSED rather than only printed. `table_ok` verifies the
        # zstd frame-offset table against the discovered frame positions; `chain_ok` verifies
        # every index block chains and the last ends exactly on the geometry size. Both were
        # previously computed and then ignored -- the chain check printed "BROKEN" on C49BB2
        # and the decode proceeded anyway, emitting 3,249 km segments.
        self.chain_ok=True
        for i,v in enumerate(self.blocks):
            W=(v[1]&3)+1
            nxt=v[0]+2*W*sum(v[2:2047])
            exp=self.blocks[i+1][0] if i+1<len(self.blocks) else len(self.geom)
            if nxt!=exp: self.chain_ok=False; break
        self.healthy = bool(self.table_ok and self.chain_ok)
        if verbose: self.report(p.split('/')[-1])
    def report(self,tile):
        print(f"--- {tile}: raw arc-store {len(self.raw)} B, frames {len(self.frames)}, "
              f"frame-offset-table verified: {self.table_ok}")
        print(f"    index blocks {len(self.blocks)}  geometry {len(self.geom)} B  keys {self.nkeys}")
        ok=True; msgs=[]
        for i,v in enumerate(self.blocks):
            W=(v[1]&3)+1; tot=self.pre[i][-1]
            nxt = v[0] + 2*W*tot
            expect = self.blocks[i+1][0] if i+1<len(self.blocks) else None
            if expect is None:
                msgs.append(f"    last block ends at {nxt} vs geometry {len(self.geom)}  "
                            f"{'EXACT' if nxt==len(self.geom) else 'MISMATCH diff=%d'%(nxt-len(self.geom))}")
            elif nxt!=expect:
                ok=False; msgs.append(f"    CHAIN BREAK at block {i}: {nxt} != {expect}")
        print("    chaining:", "all blocks chain exactly" if ok else "BROKEN")
        for m in msgs: print(m)
        from collections import Counter
        print("    W distribution:",dict(Counter((v[1]&3)+1 for v in self.blocks)))
    def way(self,key):
        b,l=divmod(key,self.KPB)
        if b>=len(self.blocks): return None
        v=self.blocks[b]; W=(v[1]&3)+1; n=v[2+l]
        if n==0: return None
        off=v[0]+2*W*self.pre[b][l]; need=2*n*W
        if off+need>len(self.geom): return None
        d=self.geom[off:off+need]
        sc=[int.from_bytes(d[i*W:(i+1)*W],'little') for i in range(2*n)]
        return W,[(zz(a),zz(bb)) for a,bb in zip(sc[:n],sc[n:])]

# ---------------------------------------------------------------------------
# ARC-KEY BASE, corrected 2026-07-31 (Session B)
#
# The original rule searched each chunk for the 3-byte sentinel `00 80 7f` and fell back to
# carrying the previous chunk's base when it was not found. That sentinel is only ONE of
# several markers (00 00 7d / 00 00 05 / 00 80 07 / 00 80 1b also occur), so the search
# missed most chunks -- 186 of 969 on C4E0F1's RGN3 -- and silently carried a stale base.
#
# A TRE7 row is a chain of sub-blocks: [optional base, w bytes] + a 15-byte header whose
# [2:4] is the payload length, then that many bytes of records. Measured on B4E0F1 and
# C4E0F1, both sections: the FIRST sub-block of a row always restates the base and it always
# equals int(row[0:w]) (2,678 rows, 0 exceptions); NO later sub-block ever restates it
# (2,700 later sub-blocks, 0 exceptions). So the base is per ROW.
# (An earlier Session B note claimed it was per sub-block and that v43 was wrong to use one
#  per row. RETRACTED -- v43's rule was right.)
#
# Effect, identical feature counts, pure placement: selector references resolving to no arc
# fall 58 -> 36 on C4E0F1 and 859 -> 769 on B4E0F1.
# ---------------------------------------------------------------------------
FIXED_HDR = 15
_MARKER_OK = lambda b: len(b) == 3 and b[0] == 0x00 and b[1] in (0x00, 0x80)

def _chain_cover(ch, w):
    """Bytes of `ch` consumed by walking the sub-block chain with a w-byte base."""
    p = 0
    while p < len(ch):
        h = p + w
        if h + FIXED_HDR > len(ch): break
        if not _MARKER_OK(ch[h+9:h+12]) or ch[h+14] != 0: break
        plen = u16(ch, h+2)
        if plen == 0 or h + FIXED_HDR + plen > len(ch): break
        p = h + FIXED_HDR + plen
    return p

def detect_base_width(rows):
    """Base field width for this tile/section: whichever value chains furthest."""
    best = (0.0, 2)
    for w in (3, 2, 4):
        tot = cov = 0
        for ch in rows:
            if len(ch) < FIXED_HDR + 2: continue
            tot += len(ch); cov += _chain_cover(ch, w)
        if tot and cov / tot > best[0]: best = (cov / tot, w)
    return best[1], best[0]

TAG2 = bytes.fromhex("110506")          # non-final depth tag; TAG (910506) is the final one

def _leb128(buf, p):
    """LEB128 varint -> (value, nbytes) or (None, 0)."""
    v = shift = n = 0
    while p + n < len(buf) and n < 5:
        c = buf[p + n]; v |= (c & 0x7F) << shift; n += 1
        if not c & 0x80: return v, n
        shift += 7
    return None, 0

def row_payloads(ch, bw):
    """Yield each sub-block's PAYLOAD slice from one TRE7 row.

    A row is a chain of sub-blocks: [base, bw bytes] + a 15-byte header whose [2:4] is the
    payload length, then that many bytes of records. Splitting records over the whole row
    instead hands the next sub-block's HEADER to parse_head as if it were geometry -- on
    C4E0F1 that is 216 of the 519 failures, and one of them is byte-for-byte the constant
    `00 08 63 d6 02 00 80 42` that Arena measured as (attr_mask, width_table) for mode (3,8).

    Anything the chain cannot account for is yielded as one final slice, so a row whose
    framing we do not fully understand still gets decoded rather than dropped.
    """
    p = 0; out = []
    while p < len(ch):
        h = p + bw
        if h + FIXED_HDR > len(ch): break
        if not _MARKER_OK(ch[h+9:h+12]) or ch[h+14] != 0: break
        plen = u16(ch, h+2)
        if plen == 0 or h + FIXED_HDR + plen > len(ch): break
        out.append(ch[h+FIXED_HDR:h+FIXED_HDR+plen])
        p = h + FIXED_HDR + plen
    if p < len(ch):
        out.append(ch[p:])          # unchained remainder -- never drop bytes
    return out

def split_records(buf):
    """Split a chunk into (geometry, depth_dm) depth records.

    Two fixes over the original, both worth ~30% of C's records between them:

    * BOTH tag forms count. The original matched only `91 05 06` (final) and silently ignored
      `11 05 06` (non-final). On C4E0F1 the raw census is 9,936 final + 2,193 non-final =
      12,129; matching one form caps recovery at ~76%.
    * The trailer is `09 <LEB128> 00 00`, not a fixed `09 7A 00 00 00` (Session A's finding).
      The varint is 122 in most records, which is why the hardcoded form worked at all.

    Result on C4E0F1: 9,202 -> 12,125 records, matching gmapmf_arc_contours_v47 exactly and
    the raw tag census to within 4.
    """
    out=[];cur=0;p=0
    n=len(buf)
    while p+4<=n:
        t=buf[p:p+3]
        if t==TAG and p+9<=n and buf[p+4]==9:
            # Trailer is `09` + a FIXED u32 whose value varies. Reading it as a LEB128 with a
            # trailing `00 00` guard works only while the value is small enough that bytes 2-3
            # are zero -- on C49E94 the value is 195,380 (`34 fd 02 00`) and the guard rejects
            # all 42,979 of its records, decoding an 8.5 MB tile to nothing. Values observed:
            #   C4E0F1  122 / 9,177 / 180,734 / 170,718     C49E94  195,380
            #   C4B40C  212,160
            # The first three were recovered independently from RGN2 attributes and match the
            # u32 reading exactly.
            out.append((buf[cur:p],buf[p+3])); cur=p+9; p=cur; continue
        elif t==TAG2:
            # NON-FINAL record: 4 bytes, `11 05 06 <dm>`, and NO trailer. Requiring the
            # trailer on this form is what capped recovery at 9,865 of 12,129 tags.
            out.append((buf[cur:p],buf[p+3])); cur=p+4; p=cur; continue
        p+=1
    return out
def parse_head(g):
    if not g: return None
    op=g[0]
    if op&1: return None                      # bit0=1 -> line path, not the polygon/UnpackWays path
    cw=(op>>6)+1; sw=((op>>4)&3)+1; nw=((op>>3)&1)+1
    need=1+2*cw+nw
    if len(g)<need: return None
    def sv(p,w):
        v=int.from_bytes(g[p:p+w],'little'); m=1<<(8*w-1)
        return (v^m)-m
    cnt=int.from_bytes(g[1+2*cw:1+2*cw+nw],'little')
    end=need+cnt*sw
    if end>len(g) or cnt==0: return None
    sels=[int.from_bytes(g[need+i*sw:need+(i+1)*sw],'little') for i in range(sw and cnt)]
    return dict(op=op,cw=cw,sw=sw,x=sv(1,cw),y=sv(1+cw,cw),cnt=cnt,sels=sels,extra=len(g)-end)


def decode_tile(T, A, maxbits, want_level=None):
    """Decode every depth record in the tile. Returns (geojson features, stats)."""
    feats, st, carry = [], Counter(), 0
    rows = [ch for _i, _s, ch in T.chunks()]
    bw, frac = detect_base_width(rows)
    st["base_width"] = bw
    # relative score used to CHOOSE the width, not a health metric -- _chain_cover stops at
    # the first break and does not resync, so it under-reports coverage.
    st["base_width_score"] = round(100 * frac, 1)
    for i, s, ch in T.chunks():
        if len(ch) < 16:
            continue
        # arc key base: read it from the head of every row (see detect_base_width).
        carry = int.from_bytes(ch[:bw], "little")
        st["base_read_w%d" % bw] += 1
        base = carry
        bits = s["bits"]
        if want_level is not None and (24 - bits) != want_level:
            continue
        hires = 4 if bits == maxbits else 0      # firmware: ctx+0x220, most-detailed level only
        q = 360.0 / (1 << (bits + hires))
        clon, clat = s["lon_raw"] * UNIT24, s["lat_raw"] * UNIT24
        for g, dm in [r for pay in row_payloads(ch, bw) for r in split_records(pay)]:
            h = parse_head(g)
            if h is None:
                st["head_fail"] += 1
                continue
            st["records"] += 1
            mask = (1 << (8 * h["sw"] - 1)) - 1
            dbit = 1 << (8 * h["sw"] - 1)
            lon, lat = clon + h["x"] * q, clat + h["y"] * q
            pts = [(lon, lat)]
            for sraw in h["sels"]:
                key = (sraw & mask) + base
                w = A.way(key)
                if w is None:
                    st["arc_missing"] += 1
                    continue
                seq = w[1]
                if sraw & dbit:                              # direction bit: walk backwards
                    seq = [(-dx, -dy) for dx, dy in reversed(seq)]
                for dx, dy in seq:
                    lon += dx * q; lat += dy * q
                    pts.append((lon, lat))
            if len(pts) < 2:
                st["stub"] += 1
                continue
            feats.append({"type": "Feature",
                          "properties": {"depth_dm": dm, "depth_ft": round(dm / 3.048, 1),
                                         "subdivision": s["si"], "tre7_index": i,
                                         "bits": bits, "zoom": 24 - bits,
                                         "arc_key_base": base, "n_selectors": h["cnt"]},
                          "geometry": {"type": "LineString",
                                       "coordinates": [[round(x, 7), round(y, 7)] for x, y in pts]}})
    return feats, st


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--out", required=True)
    ap.add_argument("--level", type=int, default=None,
                    help="zoom level to export (0 = most detailed). Default: all levels.")
    args = ap.parse_args()
    T = Tile(args.file)
    A = ArcStore(args.file, verbose=True)
    maxbits = max(L["bits"] for L in T.levels if L["count"])
    feats, st = decode_tile(T, A, maxbits, args.level)
    out = {"type": "FeatureCollection",
           "properties": {"version": "GMAPMF-FIRMWARE-EXACT-v40-2026-07-31",
                          "source": args.file, "most_detailed_bits": maxbits,
                          "stats": dict(st),
                          "note": "Personal use only, not for distribution or resale; not for navigation."},
           "features": feats}
    with open(args.out, "w") as fh:
        json.dump(out, fh)
    print(f"{len(feats)} features -> {args.out}")
    print("  stats:", dict(st))

if __name__ == "__main__":
    main()
