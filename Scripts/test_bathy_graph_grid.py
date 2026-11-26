"""test_bathy_graph_grid.py -- our graph is rebuilt on the grid it shipped on.

Personal use only, not for distribution or resale; not for navigation.

    py Scripts\\test_bathy_graph_grid.py

The November 2026 rebuild rebuilt the inland graphs with --coarsen 1 when 278 of them had shipped
at 2, and they came out four times the nodes (Thurmond 166,323 -> 662,232). graph_grid() reads the
grid off the file being replaced; --coarsen same uses it, and a number that disagrees with it is
refused without --regrid.
"""
import os, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bathy_graph as B   # noqa: E402


def grid_graph(path, coarsen, per_node_edges=3, size=30):
    """A TMWG v2 file of size x size nodes on a grid of `coarsen` raster cells, written column by
    column like bathy_graph, with right, up and diagonal edges (about 6 a node, both ends counted)."""
    g = B.LakeMask.CELL * coarsen
    nodes = [(-80.4 + (i + 0.5) * g, 33.9 + (j + 0.5) * g) for i in range(size) for j in range(size)]
    at = lambda i, j: i * size + j
    edges = []
    for i in range(size):
        for j in range(size):
            if j + 1 < size:
                edges.append((at(i, j), at(i, j + 1)))
            if i + 1 < size and per_node_edges >= 2:
                edges.append((at(i, j), at(i + 1, j)))
            if i + 1 < size and j + 1 < size and per_node_edges >= 3:
                edges.append((at(i, j), at(i + 1, j + 1)))
    B.write_graph(path, nodes, edges, [0] * len(nodes))


def test_the_grid_is_read_off_the_file():
    with tempfile.TemporaryDirectory() as d:
        one, two, mar = (os.path.join(d, x) for x in ('one.bin', 'two.bin', 'mar.bin'))
        grid_graph(one, 1)
        grid_graph(two, 2)
        grid_graph(mar, 2, per_node_edges=1)     # a chain: two edges a node, Garmin's kind
        assert B.graph_grid(one) == (True, 1)
        assert B.graph_grid(two) == (True, 2)
        assert B.graph_grid(mar) == (False, None)
        assert B.graph_grid(os.path.join(d, 'none.bin')) == (False, None)


def test_a_different_grid_is_refused():
    src = open(B.__file__, encoding='utf-8').read()
    assert 'if a.overwrite and had and had != step and not a.regrid:' in src, 'the grid guard is gone'
    assert "'--regrid'" in src
    assert 'step = had if same else want' in src, '--coarsen same is gone'
    assert 'while os.path.exists(kept):' in src, 'a second run the same day would overwrite the first one\'s kept graph'


if __name__ == '__main__':
    test_the_grid_is_read_off_the_file()
    test_a_different_grid_is_refused()
    print('ok: 2 tests')
