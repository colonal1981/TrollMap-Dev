#!/usr/bin/env python3
"""The fitter reads the water graph it is handed, and a fitted pass gets its own reach.

2026-09-26, the Murray re-fit: 44 fitted structure passes within a mile of Hilton carried no
`routable` at all. fit_pack() had been calling NodeIndex(path) and main_component(nodes, edges)
-- the wrong argument to each -- inside a bare `except`, so every pack read as "no graph" and no
fitted pass was ever given its own reach. graph_index() makes the calls build_trolling_runs.py
and reflag_routable.py make, and says so when a graph cannot be read.

Personal use only, not for distribution or resale; not for navigation.
"""
import importlib.util, os, struct, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('ftr', HERE / 'fit_trolling_runs.py')
ftr = importlib.util.module_from_spec(spec); spec.loader.exec_module(ftr)
from build_trolling_runs import MAGIC  # noqa: E402


def write_graph(path, nodes, edges):
    with open(path, 'wb') as fh:
        fh.write(MAGIC)
        fh.write(struct.pack('<BBHII', 2, 0, 0, len(nodes), len(edges)))
        for x, y in nodes:
            fh.write(struct.pack('<ii', round(x * 1e7), round(y * 1e7)))
        for a, b in edges:
            fh.write(struct.pack('<II', a, b))
        fh.write(bytes([9] * len(nodes)))


def main():
    d = tempfile.mkdtemp()
    g = os.path.join(d, 'water_graph.bin')
    # Two pieces: a chain of four (the lake) and a pair on its own (a pond the boat cannot reach).
    nodes = [(-81.30 + i * 0.001, 34.07) for i in range(4)] + [(-81.20, 34.10), (-81.201, 34.10)]
    write_graph(g, nodes, [(0, 1), (1, 2), (2, 3), (4, 5)])

    idx, main = ftr.graph_index(g, 'test')
    assert idx is not None, 'a readable graph gives an index'
    assert main == {0, 1, 2, 3}, 'the main component is the lake, not the pond: %r' % (main,)
    j, dist = idx.nearest((-81.2988, 34.07))
    assert j == 1 and dist < 60, 'nearest node is found by position: %r %r' % (j, dist)

    assert ftr.graph_index(os.path.join(d, 'nope.bin')) == (None, None), 'no file, no graph'
    bad = os.path.join(d, 'bad.bin')
    open(bad, 'wb').write(b'nothing like a graph')
    assert ftr.graph_index(bad) == (None, None), 'a wrong header reads as no graph, quietly'
    print('test_fit_reads_its_graph: all checks passed')


if __name__ == '__main__':
    main()
