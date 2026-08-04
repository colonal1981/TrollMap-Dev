#!/usr/bin/env python3
"""One RGN4 record grammar for every mode.

    type(1)  dx(2 s16)  dy(2 s16)          -- always, 5 bytes  (Session A: head is uniform)
    + label_ref(3)   if type & 1           -- Session B: pool offset = ref * 2
    + 5 bytes        if type & 2
    + 6 bytes        if type & 4

Mode 5/1's measured lengths fall straight out: 0x01 -> 8, 0x03 -> 13, 0x07 -> 19.
Mode 3/26's records are type 0x00 -> 5 bytes and carry NO label at all.
Test: does a payload close EXACTLY under this rule?
"""
import sys
from collections import Counter
import gmapmf_decode_v40 as V
import gmapmf_lines_v50 as L
import gmapmf_labels_v50 as B
from poi_audit import poi_rows
UNIT24=360.0/(1<<24)

# Per-mode constant tail, fitted by exact payload closure over B4E0F1 + B4E0DA + B4E0F0.
# Note 15/0 and 16/11: base for type 0x03 is 13, + tail 7 = 20 bytes, which is exactly the
# record length Session A measured independently by two-pool agreement.
# Chosen by REF-RESOLUTION rate, not by closure -- Session A's rule, and it changes the
# answer: mode 2/7's best-closure tail (2, 96.68%) resolves 0.0% of its refs, so it is wrong.
# ---------------------------------------------------------------------------
# THE SUB-BLOCK HEADER STATES THE RECORD COUNT.  header[12:14] is a u16 count.
# Verified three ways (B, 2026-08-01):
#   * it matches every independently known record length -- 3/26=5, 83/0=34,
#     15/0=16/11=16/9=20 -- with no exceptions;
#   * plen % count == 0 on 100% of sub-blocks in 21 of 26 modes;
#   * on the VARIABLE-length mode 5/1, where an accidental division would not
#     survive, the unified grammar's own record count equals it on 1,448 of
#     1,453 sub-blocks.
# So do not fit a tail.  Read the count, divide, and check.  count_ok() below.
# ---------------------------------------------------------------------------
def sb_count(hdr):
    """Records in this sub-block, per the header."""
    return hdr[12] | hdr[13] << 8

def sb_reclen(hdr, payload):
    """Record length when the sub-block is uniform, else None."""
    n = sb_count(hdr)
    return len(payload) // n if n and len(payload) % n == 0 else None

def count_ok(hdr, payload, recs):
    """The framing test that replaces closure: did we produce the stated number?"""
    return len(recs) == sb_count(hdr)

# Tails DERIVED from the record count, not fitted to closure.
MODE_TAIL = {"15/0":7, "16/11":7, "16/9":7, "16/1":7, "16/0":7, "13/6":7,
             "83/0":21,
             "2/7":19, "2/9":18, "2/10":18, "2/11":17,
             "3/4":0, "3/6":0, "3/8":0, "3/26":0,
             "7/0":0, "7/4":0, "7/12":0, "6/0":0, "5/1":0}
# 12/3 IS NOT A CONSTANT.  49 sub-blocks derive tail 0 and 23 derive tail 7, which is
# exactly why closure argued for 0 and the type-0x00 count argued for 7 -- both criteria
# were right about different sub-blocks.  Use sb_reclen() per sub-block.
MODE_TAIL_VARIES = {"12/3", "5/1", "2/7"}

# Modes 4/1, 4/7, 4/8, 4/10, 4/12 do NOT follow the type bitfield.  Every record is
# 6 bytes: `04 dx(2 s16) dy(2 s16) <class>`, with the class byte constant per mode
# (4/7 -> 0x00, 4/12 -> 0x00, 4/10 -> 0x08, 4/1 -> 0x20, 4/8 -> 0x20).  Type 0x04
# adds ONE byte here, not the six the unified rule predicts.  53 of 53 records land
# inside the subdivision box on the confirmed head; the alternative offset gets 1.
MODE_4X = {"4/1":0x20, "4/7":0x00, "4/8":0x20, "4/10":0x08, "4/12":0x00}
MODE_4X_RECLEN = 6

def walk_4x(b):
    """The 4/x modes.  Returns [(type, dx, dy, class_byte)]."""
    out = []
    for p in range(0, len(b) - 5, MODE_4X_RECLEN):
        out.append((b[p],
                    int.from_bytes(b[p+1:p+3], "little", signed=True),
                    int.from_bytes(b[p+3:p+5], "little", signed=True),
                    b[p+5]))
    return out
#                                              ^^^^^^^^ was 8. Session A's correction,
# reproduced here. Closure and reference resolution BOTH pass for the wrong value --
# tail 8 scores 97.81% closure with 72/72 refs resolving, tail 21 scores 97.61% with the
# same 72/72. Two criteria that had been sufficient all day were not sufficient here.
#
# Three things break the tie, all pointing at 21:
#   * the pool-2 card pointer lands at a consistent +18 on 71 records at tail 21,
#     and on 1 record at tail 8;
#   * tail 8 emits 71 type-0x00 (no-label) records in the named-marina mode, where
#     every record must carry a label. Tail 21 emits none.
#   * 5 + 3 + 5 + 21 = 34, the record length measured independently by two-pool
#     name agreement before the unified grammar was fitted.
#
# GENERAL RULE that falls out: in a mode where every record is expected to be labelled,
# **a type-0x00 record is a framing error**, not a feature. It is a cheaper and sharper
# test than closure and it should be checked on every mode fit.
#
# 15/0, 16/11 and 16/9 hold at tail 7 under all four criteria: 100.00% closure, every
# reference resolving, card pointer at +16 on 90/80/26 records, zero type-0x00.
# 12/3 remains unresolved -- tail 0 gives 85.00% closure and 24/24 refs but 128 type-0x00
# records and no card ever lands; tail 7 gives 23 cards at +16 but 73.21% closure. The
# type-0x00 count argues for 7, closure for 0. Left at 0 rather than quietly picked.
# mode 2/7 (navaids) is NOT covered: 29-byte stride per Session A, but no pool-1 reference
# resolves at any tail (best 1.0%). Its names come from pool 2, the description store.

def reclen(t, tail=0, a1=3, a2=5, a4=6):
    return 5 + (a1 if t & 1 else 0) + (a2 if t & 2 else 0) + (a4 if t & 4 else 0) + tail

def walk(b, mode=None, a1=3, a2=5, a4=6):
    tail = MODE_TAIL.get(mode, 0)
    out=[]; p=0; n=len(b)
    while p < n:
        t=b[p]; ln=reclen(t,tail,a1,a2,a4)
        if p+ln > n: break
        ref = (b[p+5] | b[p+6]<<8 | b[p+7]<<16) if (t & 1) else None
        out.append(dict(type=t, off=p, len=ln,
                        dx=int.from_bytes(b[p+1:p+3],'little',signed=True),
                        dy=int.from_bytes(b[p+3:p+5],'little',signed=True),
                        ref=ref))
        p += ln
    return out, p

def main(path):
    T=V.Tile(path); pr,_=poi_rows(T); pool=B.lbl_pool(path)
    maxbits=max(l['bits'] for l in T.levels if l['count'])
    import struct
    d=open(path,'rb').read(); tre=struct.unpack_from('<I',d,0x19)[0]; tb=d[tre:tre+0x146]
    def s24(bb,q):
        v=bb[q]|bb[q+1]<<8|bb[q+2]<<16; return v-(1<<24) if v&0x800000 else v
    N,E,S,W=[s24(tb,o)*UNIT24 for o in (0x15,0x18,0x1b,0x1e)]
    per=Counter(); cov=Counter(); tot=Counter(); res=Counter(); nref=Counter(); inb=Counter(); npt=Counter()
    types=Counter()
    for i,s,ch in pr:
        if len(ch)<16: continue
        sbs=L.chain(ch,0)
        if sbs is None: continue
        bits=s['bits']; hires=4 if bits==maxbits else 0
        q=360.0/(1<<(bits+hires)); clon,clat=s['lon_raw']*UNIT24, s['lat_raw']*UNIT24
        for hdr,b in sbs:
            m="%d/%d"%(hdr[0],hdr[1]); per[m]+=1; tot[m]+=len(b)
            recs,used=walk(b,m); cov[m]+=used
            for r in recs:
                types[(m,r['type'])]+=1
                x,y=clon+r['dx']*q, clat+r['dy']*q
                npt[m]+=1
                if min(W,E)-.01<=x<=max(W,E)+.01 and min(S,N)-.01<=y<=max(S,N)+.01: inb[m]+=1
                if r['ref'] is not None:
                    nref[m]+=1
                    if B.label(pool,r['ref']): res[m]+=1
    print("\n=== %s : one grammar, all RGN4 modes ==="%path)
    print("  mode      subblk   payload  closure   records  in-bounds   with-ref  ref resolves")
    for m,c in per.most_common(16):
        print("   %-7s  %5d  %8d  %6.2f%%  %8d  %7.1f%%  %8d  %10s"%(
            m,c,tot[m],100*cov[m]/max(1,tot[m]),npt[m],100*inb[m]/max(1,npt[m]),nref[m],
            "%d = %.0f%%"%(res[m],100*res[m]/nref[m]) if nref[m] else "-"))
    T_=sum(tot.values()); C_=sum(cov.values())
    print("  ---- overall closure %d/%d = %.2f%% ; %d records, %.1f%% in bounds, %d refs, %.1f%% resolve"%(
        C_,T_,100*C_/T_,sum(npt.values()),100*sum(inb.values())/max(1,sum(npt.values())),
        sum(nref.values()),100*sum(res.values())/max(1,sum(nref.values()))))
    print("  type bytes seen:",Counter(t for (m,t),c in types.items() for _ in range(c)).most_common(10))
if __name__=='__main__':
    for p in sys.argv[1:]: main(p)
