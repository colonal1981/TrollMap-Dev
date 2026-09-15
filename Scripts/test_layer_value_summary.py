"""test_layer_value_summary.py -- the thing that decides what a layer CONTAINS, tested without a
geodatabase.

extract_coastal_habitat.py writes an entire BENTHIC layer to oyster_beds.geojson, and the map
draws that file with the tooltip "Oyster bed -- redfish on moving water". The branch was written
for North Carolina, whose BENTHIC is shell bottom. Georgia has a BENTHIC layer too and nobody has
looked at what is in it. layer_value_summary() is how we look; this is how we know it looks
correctly.

Importing the script would drag in geopandas, which is not installed everywhere this runs, so the
one function is lifted out of the source and executed on its own. It is pure -- list of dicts in,
list of strings out -- precisely so that is possible.

    python3 test_layer_value_summary.py
"""
import ast, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, 'extract_coastal_habitat.py'), encoding='utf-8').read()

# Lift the function by parsing the file, not by importing it.
_tree = ast.parse(SRC)
_fn = next((n for n in _tree.body
            if isinstance(n, ast.FunctionDef) and n.name == 'layer_value_summary'), None)
assert _fn is not None, 'layer_value_summary is gone from extract_coastal_habitat.py'
_ns = {}
exec(compile(ast.Module(body=[_fn], type_ignores=[]), '<lifted>', 'exec'), _ns)
summary = _ns['layer_value_summary']


class Summary(unittest.TestCase):
    def test_empty_is_said_not_crashed(self):
        self.assertEqual(summary([]), ['    (no rows)'])

    def test_counts_rows_and_columns(self):
        out = summary([{'ESI': '10', 'TYPE': 'marsh'}, {'ESI': '9', 'TYPE': 'marsh'}])
        self.assertIn('2 rows, 2 columns', out[0])

    def test_orders_by_count_then_name(self):
        rows = [{'HAB': 'shell'}] * 3 + [{'HAB': 'mud'}] * 5 + [{'HAB': 'sand'}] * 5
        line = next(l for l in summary(rows) if l.strip().startswith('HAB:'))
        # mud and sand tie at 5; the tie breaks alphabetically so the output is stable run to run.
        self.assertTrue(line.index('mud=5') < line.index('sand=5') < line.index('shell=3'))

    def test_an_id_column_is_named_and_skipped(self):
        # A column with a distinct value per row teaches nothing and would print thousands of
        # lines. objectid and fid are exactly this in every ESI geodatabase.
        rows = [{'objectid': i} for i in range(200)]
        line = next(l for l in summary(rows) if 'objectid' in l)
        self.assertIn('looks like an id, skipped', line)
        self.assertIn('200 distinct values', line)

    def test_a_classification_column_is_NOT_skipped_however_many_rows(self):
        # The whole point. 200,000 rows of four habitat classes must still print the four.
        rows = [{'HABITAT': c} for c in ('SHELL', 'MUD', 'SAND', 'SAV')] * 50000
        line = next(l for l in summary(rows) if 'HABITAT' in l)
        self.assertNotIn('skipped', line)
        for c in ('SHELL', 'MUD', 'SAND', 'SAV'):
            self.assertIn(f'{c}=50,000', line)

    def test_an_all_empty_column_says_so_rather_than_vanishing(self):
        # A column that exists and is never filled is a fact about the layer. Dropping it silently
        # is how "this layer has no habitat field" becomes indistinguishable from "we did not look".
        out = summary([{'ESI': '10', 'NOTE': None}, {'ESI': '9', 'NOTE': ''}])
        self.assertIn('      NOTE: (all empty)', out)

    def test_every_column_in_ANY_row_is_reported(self):
        # Rows from a GDB are not guaranteed to carry the same keys. Reading columns off the first
        # row alone would hide a field that only some features have.
        out = summary([{'A': 1}, {'B': 2}])
        self.assertTrue(any('A:' in l for l in out))
        self.assertTrue(any('B:' in l for l in out))

    def test_the_top_list_is_capped_and_says_how_much_was_cut(self):
        rows = [{'C': f'v{i}'} for i in range(40)]
        line = next(l for l in summary(rows, top=5, max_values_per_col=100) if 'C:' in l)
        self.assertIn('+35 more', line)


if __name__ == '__main__':
    unittest.main(verbosity=2)
