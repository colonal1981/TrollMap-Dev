"""test_water_graphs_keep_ours.py -- Garmin's mesh is never written over our own water graph.

Personal use only, not for distribution or resale; not for navigation.

    py Scripts\\test_water_graphs_keep_ours.py

The November 2026 rebuild ran build_water_graphs.py --force over every offered water and put
Garmin's two-edges-a-node mesh over 100 of our graphs from the depth areas (bathy_graph.py):
Wateree 115,836 nodes -> 9,023. Ryan: "make sure something is updated with the steps so that this
doesn't happen next quarter". is_ours() tells the two apart from the file itself.
"""
import os, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_water_graphs as W   # noqa: E402


def graph(path, n, per_node):
    """A TMWG v2 file with n nodes in a line and about per_node edges a node (both ends counted)."""
    nodes = [(-80.0 + i * 1e-4, 33.9) for i in range(n)]
    want = int(n * per_node / 2)
    edges, k = [], 1
    while len(edges) < want:
        for i in range(n - k):
            edges.append((i, i + k))
            if len(edges) >= want:
                break
        k += 1
    W.write_graph(path, nodes, edges, [0] * n, 0, 0)


def test_ours_is_told_from_garmins():
    with tempfile.TemporaryDirectory() as d:
        mar, ours, small = (os.path.join(d, x) for x in ('mar.bin', 'ours.bin', 'small.bin'))
        graph(mar, 9023, 2.03)        # Wateree's MAR graph, 11/26: 9,023 nodes, 9,154 edges
        graph(ours, 2000, 7.57)       # Wateree's own graph: 115,836 nodes, 439,178 edges
        graph(small, 44, 3.18)        # ferry_lake, the thinnest of ours: 44 / 70
        assert not W.is_ours(mar)
        assert W.is_ours(ours)
        assert W.is_ours(small)
        assert not W.is_ours(os.path.join(d, 'none.bin'))   # no graph at all is not ours


def test_garmins_widest_is_still_garmins():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, 'g.bin')
        graph(p, 300, 2.81)           # diversion_canal, the most joined MAR graph seen: 300 / 421
        assert not W.is_ours(p)


def test_force_alone_cannot_replace_ours():
    src = open(W.__file__, encoding='utf-8').read()
    assert "if not a.replace_ours and is_ours(" in src, 'the guard is gone from main()'
    assert "'--replace-ours'" in src


if __name__ == '__main__':
    test_ours_is_told_from_garmins()
    test_garmins_widest_is_still_garmins()
    test_force_alone_cannot_replace_ours()
    print('ok: 3 tests')
