"""GARMIN NGSR MAR reader — the auto-guidance safe-water mesh that ships
alongside the GMP tiles on a LakeVu card.

Session B, 2026-08-01.  Personal use only, not for distribution or resale;
not for navigation.

    m = Mar('G4E0F1.MAR')
    for li, L in enumerate(m.layers):
        V = layer_vertices(m, li)          # vertex-ref -> (lon, lat, vtype)
        for ring in cell_rings(m, li):     # MAR_create_polygon, one per node
            ...

File layout
-----------
    u16  header length (83)
    'GARMIN NGSR MAR'
    u16  format (4)      u16 year, u8 mon/day/hh/mm/ss
    u32  map id
    u32 off, u32 rec, u32 len   layer directory      (rec = 124)
    u32 off, u32 rec, u32 len   vertical-adj directory
    u32 off, u32 len, u32 cnt   fprs table
    u32 off, u16 len            signature
    u32 off, u32 len            signature component
    u16  tail

Layer record, 124 bytes = 31 u32
    depth, 2, 6 x (off, recsize, bytelen), (off, len), (off,rec,len) x2,
    vtxOff, vtxLen, tag

    tag bytes = (w0, w1, 6, 3):  w0 = bits for vtx_idx inside a bin,
                                 w1 = bits for bin_idx.
                A vertex reference is the u16  (bin << w0) | idx.

    T1 NODE  8 B   flags u8, u16 adj_start, u16 badj_start, u16 edge_start, 0xff
    T2 VTX   4/5 B dLat (n bits), dLon (n bits), vtype (4 bits)
                   n = (8*recsize - 4)//2 .  NOT the 6 in the tag.
    T3 BIN  12 B   u32 byte offset into T2, i32 lon, i32 lat  (2^28 semicircles)
    T4 ADJ   8 B   u16 nodeA, u16 nodeB, u16 vtxRefA, u16 vtxRefB   (portal)
    T5 BADJ  2 B   u16 index into T4, for the node on the B side
    T6 EDGE  4 B   u16 vtxRefA, u16 vtxRefB                        (free edge)

    depth is in decimetres: 0, 9, 18, 27, 36, 45, 54, 73, 91  =  0..30 ft.

Ring assembly (mar_reader.cpp MAR_create_polygon)
    node i's boundary = its own EDGE range
                      + the portals where it is the A side (T4 via adj_start)
                      + the portals where it is the B side (T4 via T5)
    Those segments join into exactly one closed ring.  704/704, 1683/1683,
    6810/6810 on G4E0F1.
"""
import struct
from collections import defaultdict

SEMI  = 360.0 / (1 << 32)      # vertex arrays
SEMI28 = 360.0 / (1 << 28)     # bin bases and deltas
LREC  = 124


class Mar:
    def __init__(self, path):
        self.path = path
        self.b = b = open(path, 'rb').read()
        self.hdr_len = struct.unpack_from('<H', b, 0)[0]
        if b[2:0x11] != b'GARMIN NGSR MAR':
            raise ValueError('not a MAR file: %r' % b[2:0x11])
        self.fmt  = struct.unpack_from('<H', b, 0x11)[0]
        self.date = (struct.unpack_from('<H', b, 0x13)[0],) + tuple(b[0x15:0x1a])
        self.mapid = struct.unpack_from('<I', b, 0x1a)[0]
        (self.lay_off, self.lay_rec, self.lay_len,
         self.vrt_off, self.vrt_rec, self.vrt_len,
         self.fprs_off, self.fprs_len, self.fprs_cnt) = struct.unpack_from('<9I', b, 0x1e)
        self.sig_off, self.sig_len = struct.unpack_from('<IH', b, 0x42)
        self.sig2_off, self.sig2_len = struct.unpack_from('<II', b, 0x48)
        self.layers = [self._layer(i) for i in range(self.lay_len // LREC)]

    def _layer(self, i):
        u = struct.unpack_from('<31I', self.b, self.lay_off + i * LREC)
        t = [tuple(u[2+3*k:5+3*k]) for k in range(6)]
        L = dict(depth=u[0], tabs=t, vtx=u[28], vtxlen=u[29], tag=u[30],
                 bits=tuple(u[30].to_bytes(4, 'little')), nvtx=u[29] // 8)
        for k, nm in enumerate(('NODE', 'VTX', 'BIN', 'ADJ', 'BADJ', 'EDGE')):
            off, rs, ln = t[k]
            L[nm] = (off, rs, ln, ln // rs if rs else 0)
        return L

    def raw(self, li, nm):
        off, rs, ln, n = self.layers[li][nm]
        return self.b[off:off+ln], rs, n

    def abs_verts(self, li):
        """The layer's plain int32 lon/lat array (2^32 semicircles)."""
        L = self.layers[li]; n = L['nvtx']
        a = struct.unpack_from('<%di' % (2 * n), self.b, L['vtx'])
        return [(a[2*k] * SEMI, a[2*k+1] * SEMI) for k in range(n)]


def _bins(m, li):
    d, _, n = m.raw(li, 'BIN')
    return [struct.unpack_from('<Iii', d, 12 * i) for i in range(n)]


def layer_vertices(m, li):
    """vertex reference -> (lon, lat, vtype).  vtype 0 invalid, 1 regular, 2 edge."""
    L = m.layers[li]; w0 = L['bits'][0]
    t2, rs, n2 = m.raw(li, 'VTX')
    B = _bins(m, li)
    nb = (rs * 8 - 4) // 2
    st = [o // rs for o, _, _ in B]
    cnt = [(st[i+1] - st[i]) if i + 1 < len(B) else n2 - st[i] for i in range(len(B))]
    mask = (1 << nb) - 1
    V = {}
    for b, (o, bx, by) in enumerate(B):
        for i in range(cnt[b]):
            raw = int.from_bytes(t2[o+rs*i:o+rs*(i+1)], 'little')
            V[(b << w0) | i] = ((bx + ((raw >> nb) & mask)) * SEMI28,
                                (by + (raw & mask)) * SEMI28,
                                raw >> (2 * nb))
    return V


def layer_edges(m, li):
    """Free boundary edges: (vtxRefA, vtxRefB). Record size is stated, not assumed -- see
    node_tables() for why that matters."""
    d, rs, n = m.raw(li, 'EDGE')
    h = rs // 2
    return [(int.from_bytes(d[rs*i:rs*i+h], 'little'),
             int.from_bytes(d[rs*i+h:rs*i+rs], 'little')) for i in range(n)]


def node_tables(m, li):
    """NODE / ADJ / BADJ for one layer, at whatever widths the layer declares.

    THE RECORD SIZES ARE STATED IN THE LAYER DESCRIPTOR AND THEY VARY. Garmin narrows or
    widens every column to fit the layer, and the original reader hardcoded the one width it
    had seen (NODE 8, ADJ 8). That works on G4E0F1 and fails on three of Wateree's own four
    tiles: G4E0DB raised IndexError, G4E0F0 closed 697 rings of 34,304.

    NODE = flags u8 + adj + badj + edge + terminator 0xff, each column as wide as its table

        5 B   adj u8,  badj u8,  edge u8       under 256 of everything
        6 B   adj u8,  badj u8,  edge u16      G4E0DB      227 nodes
        8 B   adj u16, badj u16, edge u16      G4E0F1    6,810 nodes
        9 B   adj u16, badj u16, edge u24      G4E0F0   34,304 nodes, 78,717 edges

    ADJ = nodeA + nodeB + vtxRefA + vtxRefB

        6 B   u8,  u8,  u16, u16               under 256 nodes
        8 B   u16, u16, u16, u16               vertex refs inside 16 bits
       10 B   u16, u16, u24, u24               w0+w1 = 19 bits of vertex ref on G4E0F0

    The rule is mechanical: the edge/vertex columns take whatever is left after the fixed
    parts. Each layout is verified the same way -- all three NODE columns monotone
    non-decreasing with each maximum equal to its table length, terminator 0xff on every
    record, and every ADJ vertex reference resolving in the layer's vertex map.

    **nodeB == the node count is a sentinel, not a node.** It means the portal has no cell on
    the far side: the mesh runs off the edge of the tile there. 12 of G4E0F0's 34,913 portals
    carry it, and they are the tile-boundary portals -- the places a neighbouring tile's mesh
    would join on. Read as a node index it walks off the end of the table.
    """
    d, rs, n = m.raw(li, 'NODE')
    # DERIVE THE COLUMN WIDTHS FROM THE TABLES THEY INDEX, not from the record size.
    #
    # The first version mapped rs -> widths by lookup (`1 if rs == 6 else 2`), which handled the
    # 6, 8 and 9 byte forms seen on Wateree's tiles and then died card-wide on
    # `unhandled NODE record size 5`. There is no fixed set to enumerate: Garmin sizes every
    # column to the table it points at, so a layer with under 256 adjacencies AND under 256
    # edges packs the whole record into five bytes.
    #
    # An index into a table of N entries needs one byte when N < 256 and two otherwise -- and
    # the file states N. So ask the tables. The remainder of the record is the edge column,
    # which is the one that can reach three bytes because EDGE is always the largest table
    # (78,717 on G4E0F0 against 34,913 adjacencies).
    n_adj = m.layers[li]['ADJ'][3]
    n_badj = m.layers[li]['BADJ'][3]
    wa = 1 if n_adj < 256 else 2
    wb = 1 if n_badj < 256 else 2
    we = rs - 2 - wa - wb                        # 1 flags byte + 1 terminator
    if we < 1:
        raise ValueError('NODE record size %d cannot hold adj(%d) badj(%d) on layer %d'
                         % (rs, wa, wb, li))
    oa, ob, oe = 1, 1 + wa, 1 + wa + wb
    N = [(d[rs*i],
          int.from_bytes(d[rs*i+oa:rs*i+oa+wa], 'little'),
          int.from_bytes(d[rs*i+ob:rs*i+ob+wb], 'little'),
          int.from_bytes(d[rs*i+oe:rs*i+oe+we], 'little')) for i in range(n)]

    d4, r4, n4 = m.raw(li, 'ADJ')
    wn = 1 if n < 256 else 2                     # node id width, from the NODE count
    wv = (r4 - 2 * wn) // 2                      # vertex refs take the rest, evenly
    if wv < 1 or 2 * wn + 2 * wv != r4:
        raise ValueError('ADJ record size %d does not split as 2x%d node + 2xN vtx on layer %d'
                         % (r4, wn, li))
    o2, o3 = 2 * wn, 2 * wn + wv
    A = [(int.from_bytes(d4[r4*i:r4*i+wn], 'little'),
          int.from_bytes(d4[r4*i+wn:r4*i+2*wn], 'little'),
          int.from_bytes(d4[r4*i+o2:r4*i+o2+wv], 'little'),
          int.from_bytes(d4[r4*i+o3:r4*i+o3+wv], 'little')) for i in range(n4)]

    d5, r5, n5 = m.raw(li, 'BADJ')
    B = [int.from_bytes(d5[r5*i:r5*i+r5], 'little') for i in range(n5)]
    return N, A, B


def cell_rings(m, li):
    """MAR_create_polygon for every node.  -> list of vertex-ref rings (None on failure)."""
    N, A, B = node_tables(m, li)
    E = layer_edges(m, li)
    n, n4, n5, ne = len(N), len(A), len(B), len(E)
    out = []
    for i in range(n):
        e1 = N[i+1][3] if i + 1 < n else ne
        a1 = N[i+1][1] if i + 1 < n else n4
        b1 = N[i+1][2] if i + 1 < n else n5
        segs = list(E[N[i][3]:e1])
        segs += [(A[k][2], A[k][3]) for k in range(N[i][1], a1)]
        segs += [(A[B[k]][2], A[B[k]][3]) for k in range(N[i][2], b1) if B[k] < n4]
        adj = defaultdict(list)
        for k, (a, b) in enumerate(segs):
            adj[a].append(k); adj[b].append(k)
        if len(segs) < 3 or any(len(v) != 2 for v in adj.values()):
            out.append(None); continue                 # "has less than 3 edges"
        used = set(); start = segs[0][0]; cur = start; ring = [cur]
        while True:
            nx = [k for k in adj[cur] if k not in used]
            if not nx: break
            k = nx[0]; used.add(k)
            a, b = segs[k]
            cur = b if a == cur else a
            ring.append(cur)
            if cur == start: break
        out.append(ring if len(used) == len(segs) and ring[0] == ring[-1] else None)
    return out                                          # else "Edges are not joined"


def depth_polygons(m, li):
    """Dissolve the layer's cells.  Needs shapely.  -> shapely geometry."""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    V = layer_vertices(m, li)
    ps = []
    for r in cell_rings(m, li):
        if not r: continue
        p = Polygon([(V[k][0], V[k][1]) for k in r])
        if not p.is_valid: p = p.buffer(0)
        if p.area > 0: ps.append(p)
    return unary_union(ps)


def qa(m):
    """Per-layer closure and edge-length report."""
    import math, statistics as st
    rows = []
    for li, L in enumerate(m.layers):
        V = layer_vertices(m, li); E = layer_edges(m, li); R = cell_rings(m, li)
        bad = sum(1 for r in R if r is None)
        Ls = sorted(math.hypot((V[b][0]-V[a][0]) * 92300, (V[b][1]-V[a][1]) * 111000)
                    for a, b in E if a in V and b in V)
        rows.append(dict(layer=li, depth_dm=L['depth'], depth_ft=round(L['depth'] / 3.048),
                         nodes=len(R), rings=len(R) - bad, unclosed=bad,
                         verts=len(V), edges=len(E),
                         med_edge_m=round(st.median(Ls), 1), max_edge_m=round(Ls[-1], 1),
                         unref_verts=sum(1 for v in V.values() if v[2] == 0)))
    return rows


if __name__ == '__main__':
    import sys, json
    p = sys.argv[1]
    m = Mar(p)
    print(f"{p}  fmt={m.fmt} mapid=0x{m.mapid:08x} built={m.date} layers={len(m.layers)}")
    for r in qa(m):
        print("  L{layer} {depth_dm:3d} dm ({depth_ft:2d} ft)  nodes={nodes:5d} rings={rings:5d} "
              "unclosed={unclosed:3d}  verts={verts:6d} unref={unref_verts:3d} edges={edges:6d}  "
              "edge med {med_edge_m:6.1f} m  max {max_edge_m:7.1f} m".format(**r))
