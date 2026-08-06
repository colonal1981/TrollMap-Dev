#!/usr/bin/env python3
"""mar_route.py - turn a MAR layer into a navigable-water routing graph and route on it.

Personal use only, not for distribution or resale; NOT FOR NAVIGATION.

WHY THIS EXISTS

MAR's dissolved safe-water polygons are 93-97% the RGN2 depth bands TrollMap already ships, so
as a display layer they are redundant (see MAR_INTO_THE_PIPELINE_2026-08-06.md). The part that
is NOT redundant is underneath them: `ADJ` is a table of portals between adjacent water cells,
which is a routing graph over water that no other source in the project provides.

    ADJ record = (nodeA, nodeB, vtxRefA, vtxRefB)

nodeA and nodeB are the two cells; vtxRefA/vtxRefB are the two ends of the wall they share. So
the graph is stated outright -- one undirected edge per ADJ record, and the portal segment comes
with it, which is what a funnel/string-pull needs to turn a cell path into a real line.
"""
import sys, math, heapq
from collections import defaultdict
from gmapmf_mar_v1 import Mar, layer_vertices, cell_rings, node_tables

def metres(a, b):
    mx = 111320.0 * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((b[0] - a[0]) * mx, (b[1] - a[1]) * 110540.0)

def build(m, li):
    """-> centroids[node], graph{node:[(other, cost, portal)]}, rings, V"""
    V = layer_vertices(m, li)
    rings = cell_rings(m, li)
    N, A, B = node_tables(m, li)
    cent = []
    for r in rings:
        if not r:
            cent.append(None); continue
        pts = [V[x][:2] for x in r if x in V]
        cent.append((sum(p[0] for p in pts)/len(pts), sum(p[1] for p in pts)/len(pts))
                    if pts else None)
    g = defaultdict(list)
    portals = 0
    for (na, nb, va, vb) in A:
        if na >= len(cent) or nb >= len(cent): continue
        if cent[na] is None or cent[nb] is None: continue
        if va not in V or vb not in V: continue
        w = metres(cent[na], cent[nb])
        mid = ((V[va][0] + V[vb][0]) / 2, (V[va][1] + V[vb][1]) / 2)
        g[na].append((nb, w, mid)); g[nb].append((na, w, mid))
        portals += 1
    return cent, g, rings, V, portals

def components(g, n):
    seen = set(); comps = []
    for s in range(n):
        if s in seen or s not in g: continue
        stack = [s]; seen.add(s); c = 0
        while stack:
            u = stack.pop(); c += 1
            for v, _w, _p in g[u]:
                if v not in seen: seen.add(v); stack.append(v)
        comps.append(c)
    return sorted(comps, reverse=True)

def nearest(cent, pt):
    best, bi = 1e18, None
    for i, c in enumerate(cent):
        if c is None: continue
        d = metres(pt, c)
        if d < best: best, bi = d, i
    return bi, best

def route(g, cent, s, t):
    """Dijkstra over cell centroids. Returns (metres, [node...], [portal midpoints])."""
    dist = {s: 0.0}; prev = {}; pq = [(0.0, s)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == t: break
        if d > dist.get(u, 1e18): continue
        for v, w, mid in g[u]:
            nd = d + w
            if nd < dist.get(v, 1e18):
                dist[v] = nd; prev[v] = (u, mid); heapq.heappush(pq, (nd, v))
    if t not in dist: return None, None, None
    path = [t]; mids = []
    while path[-1] != s:
        u, mid = prev[path[-1]]; mids.append(mid); path.append(u)
    path.reverse(); mids.reverse()
    return dist[t], path, mids
