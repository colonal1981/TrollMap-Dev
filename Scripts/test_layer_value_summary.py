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
import ast, math, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, 'extract_coastal_habitat.py'), encoding='utf-8').read()

# Lift the function by parsing the file, not by importing it.
_tree = ast.parse(SRC)
_WANT = ['layer_value_summary', 'rarnum_column', 'rows_for_rarnums', 'benthic_class',
         'sliver_threshold_deg2']
_fns = [n for n in _tree.body if isinstance(n, ast.FunctionDef) and n.name in _WANT]
assert len(_fns) == len(_WANT), f'missing from extract_coastal_habitat.py: ' \
    f'{set(_WANT) - {n.name for n in _fns}}'
# benthic_class reads a module-level table, so the assignment is lifted with it — and it has to
# come FIRST, because the function closes over it at call time and the exec namespace is flat.
_WANT_TABLES = ('BENTHIC_SUBELEMENT_FILES', 'MIN_FEATURE_AREA_M2')
_tables = [n for n in _tree.body if isinstance(n, ast.Assign)
           and any(getattr(t, 'id', None) in _WANT_TABLES for t in n.targets)]
assert len(_tables) == len(_WANT_TABLES), 'a module-level constant is gone from the script'
_fns = _tables + _fns
_ns = {'math': math}
exec(compile(ast.Module(body=_fns, type_ignores=[]), '<lifted>', 'exec'), _ns)
summary = _ns['layer_value_summary']
rarnum_column = _ns['rarnum_column']
rows_for_rarnums = _ns['rows_for_rarnums']
benthic_class = _ns['benthic_class']
BENTHIC_SUBELEMENT_FILES = _ns['BENTHIC_SUBELEMENT_FILES']
sliver_threshold_deg2 = _ns['sliver_threshold_deg2']
MIN_FEATURE_AREA_M2 = _ns['MIN_FEATURE_AREA_M2']


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


class RarnumJoin(unittest.TestCase):
    """AN ESI FEATURE CLASS CARRIES GEOMETRY AND A KEY, NOT ATTRIBUTES.

    Measured on the drive 2026-09-15: NC BENTHIC is 9,750 rows of RARNUM, Shape_Length,
    Shape_Area; GA BENTHIC is 1,208 rows of RARNUM, SHAPE_Length, SHAPE_Area. Two of the three
    are geometry measurements. Everything about what the polygon IS lives in BIOFILE, joined on
    RARNUM -- so oyster_beds.geojson has been written for NC and GA with no usable attribute at
    all, and the map labels it "Oyster bed" on our say-so rather than the data's.
    """

    def test_finds_the_key_whatever_its_case(self):
        self.assertEqual(rarnum_column([{'RARNUM': 1}]), 'RARNUM')
        self.assertEqual(rarnum_column([{'rarnum': 1}]), 'rarnum')
        self.assertEqual(rarnum_column([{' RarNum ': 1}]), ' RarNum ')

    def test_a_layer_with_no_key_is_None_not_a_guess(self):
        # Shape_Length is a geometry measurement and Shape_Area is another. Neither identifies
        # anything, and picking one because it is the only column left would be worse than saying
        # there is no key.
        self.assertIsNone(rarnum_column([{'Shape_Length': 1.2, 'Shape_Area': 3.4}]))
        self.assertIsNone(rarnum_column([]))

    def test_the_join_is_on_STRINGS_because_the_types_do_not_match(self):
        # The key arrives as an int from the feature class and can arrive as a float or a string
        # from BIOFILE. 236000023 != 236000023.0 is how a join silently returns nothing, and
        # nothing reads exactly like "this layer has no attributes".
        bio = [{'RARNUM': 236000023.0, 'NAME': 'Oyster Reef'},
               {'RARNUM': '236000025', 'NAME': 'Shell Bottom'},
               {'RARNUM': 999, 'NAME': 'Something Else'}]
        hits = rows_for_rarnums(bio, [236000023, '236000025'])
        self.assertEqual([h['NAME'] for h in hits], ['Oyster Reef', 'Shell Bottom'])

    def test_it_never_matches_everything_by_accident(self):
        bio = [{'RARNUM': 1, 'NAME': 'a'}, {'RARNUM': 2, 'NAME': 'b'}]
        self.assertEqual(rows_for_rarnums(bio, []), [])
        self.assertEqual(rows_for_rarnums(bio, [None, '', '  ']), [])
        self.assertEqual(rows_for_rarnums([], [1]), [])
        # BIOFILE with no key column cannot be joined to, and must not return all of it.
        self.assertEqual(rows_for_rarnums([{'NAME': 'a'}], [1]), [])

    def test_a_null_key_in_BIOFILE_is_skipped_not_matched(self):
        bio = [{'RARNUM': None, 'NAME': 'unset'}, {'RARNUM': 7, 'NAME': 'real'}]
        self.assertEqual([h['NAME'] for h in rows_for_rarnums(bio, [7])], ['real'])


class BenthicRouting(unittest.TestCase):
    """NEITHER BENTHIC LAYER CONTAINS ANY OYSTER, and both were being written to oyster_beds.geojson.

    Measured on the drive 2026-09-15 by resolving every RARNUM through BIOFILE. Georgia: 1,208
    polygons, two keys, SUBELEMENT `hardbottom` for both, NAME "Hardbottom community". North
    Carolina: 9,750 polygons, five keys, four of them SUBELEMENT `sav` -- Loose watermilfoil and
    submerged aquatic vegetation -- and one `hardbottom`, "Rock reef".

    coastal-layers.js draws oyster_beds.geojson with the tooltip "Oyster bed -- redfish on moving
    water". Every NC and GA zone would have shown milfoil as oyster rakes, and since the habitat
    matrix landed the plan would have scored it as oyster too -- 2.0 to 3.5 for every fish in the
    inshore roster. Charleston escaped only because SC has no BENTHIC layer.
    """

    def test_oyster_is_not_one_of_the_destinations(self):
        # The claim in one line. Nothing BENTHIC carries may land in an oyster file.
        self.assertNotIn('oyster_beds.geojson', BENTHIC_SUBELEMENT_FILES.values())

    def test_georgias_hardbottom_goes_to_hard_bottom(self):
        self.assertEqual(benthic_class({'SUBELEMENT': 'hardbottom',
                                        'NAME': 'Hardbottom community'}), 'hard_bottom.geojson')

    def test_north_carolinas_sav_goes_to_sav(self):
        self.assertEqual(benthic_class({'SUBELEMENT': 'sav',
                                        'NAME': 'Loose watermilfoil'}), 'sav.geojson')
        self.assertEqual(benthic_class({'SUBELEMENT': 'sav',
                                        'NAME': 'Submerged aquatic vegetation'}), 'sav.geojson')

    def test_the_subelement_decides_it_not_the_name(self):
        # NC's single hardbottom record is NAME "Rock reef", which contains neither "hard" nor
        # "bottom". A name test would have filed a rock reef as unknown.
        self.assertEqual(benthic_class({'SUBELEMENT': 'hardbottom',
                                        'NAME': 'Rock reef'}), 'hard_bottom.geojson')

    def test_case_and_padding_do_not_change_the_answer(self):
        self.assertEqual(benthic_class({'subelement': ' HardBottom '}), 'hard_bottom.geojson')
        self.assertEqual(benthic_class({' SUBELEMENT ': 'SAV'}), 'sav.geojson')

    def test_AN_UNKNOWN_SUBELEMENT_IS_None_NOT_A_PLAUSIBLE_GUESS(self):
        # The whole defect in one assertion. A subelement nobody has looked at must not be filed
        # somewhere reasonable-looking; that is how milfoil became oyster.
        self.assertIsNone(benthic_class({'SUBELEMENT': 'coral'}))
        self.assertIsNone(benthic_class({'SUBELEMENT': ''}))
        self.assertIsNone(benthic_class({'NAME': 'Oyster Reef'}))   # no SUBELEMENT at all
        self.assertIsNone(benthic_class(None))
        self.assertIsNone(benthic_class({}))


class SliverThreshold(unittest.TestCase):
    """THE CONSTANT THAT EMPTIED EVERY OYSTER LAYER ON THE COAST.

    The filter was `clipped.geometry.area > 0.000001` under a comment reading "Drop tiny slivers
    below 10 sq meters", and geopandas warned on every zone: "Geometry is in a geographic CRS.
    Results from 'area' are likely incorrect." The number was in SQUARE DEGREES and the intent was
    SQUARE METRES -- at this latitude 0.000001 deg² is 10,399 m², two and a half acres, and 1,040x
    the intended floor.

    The 2026-09-15 run uploaded Charleston with ONE oyster bed where the real layer has 24,207,
    Winyah Bay and Murrells Inlet with zero, and every upload overwrote R2.
    """

    CHARLESTON = {'bbox': [32.6, 32.9, -80.1, -79.6]}     # s, n, w, e

    def test_the_floor_is_a_sliver_and_not_a_third_of_the_oyster(self):
        # Measured on Charleston's 24,207 beds: median 19.8 m², and a 10 m² floor -- the number
        # the old comment claimed -- drops 31.7% of them. A 1 m² floor drops 1.3%, which is what a
        # digitising artefact looks like. The repaired comment would still have been wrong.
        self.assertEqual(MIN_FEATURE_AREA_M2, 1.0)

    def test_it_converts_to_square_degrees_not_the_other_way_round(self):
        thr = sliver_threshold_deg2(self.CHARLESTON)
        # 1 m² at 32.75°N is about 9.6e-11 square degrees. (The first draft of this test said
        # 9.6e-10 and went red by a factor of ten — the same unit slip, one decade smaller, which
        # is a fair demonstration of why the production constant is derived and not typed.)
        self.assertLess(thr, 1e-9)
        self.assertGreater(thr, 1e-11)
        # And it is nowhere near the constant that caused this.
        self.assertLess(thr, 0.000001 / 1000)

    def test_a_real_oyster_rake_survives_it(self):
        thr = sliver_threshold_deg2(self.CHARLESTON)
        m2_per_deg2 = 111132.0 * 111320.0 * math.cos(math.radians(32.75))
        for area_m2 in (2.0, 19.8, 30.0, 246.0):        # p50 and p90 of the real layer
            self.assertGreater(area_m2 / m2_per_deg2, thr, f'{area_m2} m² must survive')
        # ...and a sub-metre artefact does not.
        self.assertLess(0.5 / m2_per_deg2, thr)

    def test_the_SAME_area_is_a_different_number_of_degrees_north_and_south(self):
        # A degree of longitude shrinks with the cosine of latitude, which is exactly why a
        # threshold typed in degrees cannot mean what its comment says across thirteen zones.
        north = sliver_threshold_deg2({'bbox': [33.6, 33.8, -79.0, -78.8]})   # Winyah Bay
        south = sliver_threshold_deg2({'bbox': [30.7, 31.0, -81.5, -81.3]})   # Cumberland
        self.assertNotEqual(north, south)
        self.assertGreater(north, south)      # less metres per degree up north -> more degrees

    def test_it_reads_the_bbox_the_way_the_rest_of_the_script_does(self):
        # zone_bbox_polygon unpacks `s, n, w, e = zone['bbox']`. Reading it as w,s,e,n here would
        # put Charleston's latitude at -80 and the threshold would be quietly wrong everywhere.
        flat = sliver_threshold_deg2({'bbox': [0.0, 0.0, -80.0, -79.0]})       # equator
        chs = sliver_threshold_deg2(self.CHARLESTON)
        self.assertLess(flat, chs)            # cos(0)=1 -> most metres per degree -> smallest


if __name__ == '__main__':
    unittest.main(verbosity=2)
