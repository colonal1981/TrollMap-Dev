#!/usr/bin/env python3
"""
test_enc_seabed.py -- the bottom must not be reclassified on the way in.

Personal use only, not for distribution or resale; not for navigation.

GDAL is not importable here, so the chart read is not tested; everything that decides WHAT a
feature means is, because that is where a wrong answer would be silent. Three failures matter:

  1. Reading an update file as a cell. `.001`..`.006` are updates to a base `.000`, applied by
     GDAL when it opens the base. Treating them as cells reads the same water several times.
  2. Taking the wrong NATSUR code. S-57 orders them by prevalence, so 'sand over rock' is sand.
     Picking the hardest or the softest would move a fish onto bottom it does not want.
  3. Emitting a substrate key the weights file has never heard of, which reaches the ranker as
     a class nothing scores.

    py test_enc_seabed.py
"""

import json
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_enc_seabed as S  # noqa: E402


class Cells(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp(prefix='encfix_'))
        cls.zip = cls.dir / 'SC_ENCs.zip'
        with zipfile.ZipFile(cls.zip, 'w') as z:
            z.writestr('ENC_ROOT/US5SC10M/US5SC10M.000', b'x')   # harbour
            z.writestr('ENC_ROOT/US5SC10M/US5SC10M.001', b'x')   # an UPDATE, not a cell
            z.writestr('ENC_ROOT/US5SC10M/US5SC10M.002', b'x')
            z.writestr('ENC_ROOT/US4SC20M/US4SC20M.000', b'x')   # approach
            z.writestr('ENC_ROOT/US3GA10M/US3GA10M.000', b'x')   # coastal, too coarse
            z.writestr('ENC_ROOT/US1GC09M/US1GC09M.000', b'x')   # overview
            z.writestr('ENC_ROOT/US5SC10M/US5SC10A.TXT', b'notes')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_update_files_are_not_counted_as_cells(self):
        got = S.cells_in_zip(str(self.zip), min_band=4)
        self.assertTrue(all(p.lower().endswith('.000') for p, _ in got))
        self.assertEqual(len(got), 2)

    def test_bands_below_the_floor_are_left_out(self):
        got = {S.band_of(p.rsplit('/', 1)[-1]) for p, _ in S.cells_in_zip(str(self.zip), 4)}
        self.assertEqual(got, {4, 5})
        got5 = {b for _, b in S.cells_in_zip(str(self.zip), 5)}
        self.assertEqual(got5, {5})

    def test_the_path_is_readable_through_vsizip_without_unpacking(self):
        p = S.cells_in_zip(str(self.zip), 5)[0][0]
        self.assertTrue(p.startswith('/vsizip/'))
        self.assertIn('.zip/ENC_ROOT/', p)

    def test_a_txt_file_is_not_a_cell(self):
        self.assertNotIn('TXT', ' '.join(p for p, _ in S.cells_in_zip(str(self.zip), 1)).upper())

    def test_band_of_a_non_us_cell_is_unknown(self):
        self.assertIsNone(S.band_of('GB5X01SW.000'))


class Natsur(unittest.TestCase):
    def test_the_first_code_wins_because_s57_orders_by_prevalence(self):
        # 'sand over rock' is sand. Taking the hardest would put a fish on rock it is not on.
        key, names = S.substrate_of('4,9')
        self.assertEqual(key, 'fine')
        self.assertEqual(names, ['sand', 'rock'])
        key, _ = S.substrate_of('9,4')
        self.assertEqual(key, 'hard')

    def test_an_integer_and_a_string_mean_the_same_thing(self):
        self.assertEqual(S.substrate_of(17)[0], 'shell')
        self.assertEqual(S.substrate_of('17')[0], 'shell')

    def test_space_separated_lists_parse(self):
        self.assertEqual(S.substrate_of('1 4')[0], 'fine')

    def test_nothing_coded_is_no_substrate_not_a_guess(self):
        for v in (None, '', 'n/a', '  '):
            self.assertEqual(S.substrate_of(v), (None, []))

    def test_a_code_we_do_not_map_is_ignored_rather_than_bucketed(self):
        # 10 (unknown/other in some editions) has no entry; it must not become 'fine' by default.
        self.assertEqual(S.substrate_of('10'), (None, []))
        self.assertEqual(S.substrate_of('10,17')[0], 'shell')

    def test_a_list_valued_attribute_is_read_not_stringified(self):
        # THE BUG THE FIRST REAL RUN FOUND. S-57 list attributes come back from geopandas as a
        # numpy array; str() turned array([1, 4]) into "[1 4]" and it parsed to nothing, so
        # 574 features in ACE Basin scored no substrate and the only sign was a dash.
        class FakeArray(list):
            def tolist(self):
                return list(self)
        self.assertEqual(S.substrate_of(FakeArray([1, 4]))[0], 'fine')
        self.assertEqual(S.substrate_of([9, 4])[0], 'hard')
        self.assertEqual(S.substrate_of((17,))[0], 'shell')

    def test_a_bracketed_string_still_parses(self):
        self.assertEqual(S.substrate_of('[1 4]')[0], 'fine')
        self.assertEqual(S.substrate_of('[17]')[0], 'shell')

    def test_nan_is_not_a_code(self):
        # pandas fills a missing numeric column with NaN, which IS a float, so the int/float
        # branch caught it and int(nan) raised. It killed the run before a single cell was read.
        nan = float('nan')
        self.assertEqual(S.natsur_codes(nan), [])
        self.assertEqual(S.substrate_of(nan), (None, []))
        self.assertIsNone(S.first_code(nan))
        self.assertEqual(S.natsur_codes([nan, 17]), [17])

    def test_infinity_is_not_a_code(self):
        self.assertEqual(S.natsur_codes(float('inf')), [])

    def test_a_bool_is_not_a_code(self):
        self.assertEqual(S.substrate_of(True), (None, []))

    def test_every_class_the_matrix_ranks_is_reachable(self):
        keys = {k for _, k in S.NATSUR.values()}
        for expected in ('fine', 'coarse', 'hard', 'shell'):
            self.assertIn(expected, keys)


class ShoreConstruction(unittest.TestCase):
    def test_a_pier_and_a_riprap_wall_are_not_the_same_place(self):
        # Both are SLCONS. One is a place to fish from and one is a hard edge to fish along;
        # dropping CATSLC would make them one undifferentiated blob.
        self.assertEqual(S.CATSLC[4], 'pier')
        self.assertEqual(S.CATSLC[8], 'rip_rap')

    def test_the_category_code_is_read_from_a_list_too(self):
        class FakeArray(list):
            def tolist(self):
                return list(self)
        self.assertEqual(S.first_code(FakeArray([8])), 8)
        self.assertEqual(S.first_code('4'), 4)
        self.assertIsNone(S.first_code(None))

    def test_the_layers_we_take_include_the_ones_the_ranker_can_score(self):
        # These four map onto weights the app already has: dock_piling, bridge, and the hard
        # edge the habitat matrix ranks High for sheepshead and black drum.
        for layer in ('SLCONS', 'PILPNT', 'BRIDGE', 'SNDWAV'):
            self.assertIn(layer, S.LAYERS)

    def test_turbulence_is_taken_because_nothing_else_marks_moving_water(self):
        self.assertEqual(S.LAYERS.get('WATTUR'), 'turbulence')


class Restricted(unittest.TestCase):
    def test_the_restriction_not_the_category_is_what_gets_decoded(self):
        # RESTRN is the operative field: entry prohibited and no anchoring are different days.
        self.assertEqual(S.RESTRN[7], 'entry_prohibited')
        self.assertEqual(S.RESTRN[3], 'fishing_prohibited')
        self.assertEqual(S.RESTRN[1], 'anchoring_prohibited')

    def test_catrea_is_not_decoded_on_purpose(self):
        # A table typed from memory that labels a military zone as a swimming area is worse
        # than no label. There must be no CATREA lookup in this module.
        self.assertFalse(hasattr(S, 'CATREA'))

    def test_only_the_restrictions_that_change_our_day_are_flagged(self):
        self.assertIn('entry_prohibited', S.MATTERS_TO_US)
        self.assertIn('fishing_prohibited', S.MATTERS_TO_US)
        # A ship's rule is not our rule.
        self.assertNotIn('trawling_prohibited', S.MATTERS_TO_US)
        self.assertNotIn('discharging_prohibited', S.MATTERS_TO_US)

    def test_a_restriction_list_is_read_like_any_other_coded_list(self):
        class FakeArray(list):
            def tolist(self):
                return list(self)
        codes = S.natsur_codes(FakeArray([7, 1]))
        self.assertEqual([S.RESTRN[c] for c in codes],
                         ['entry_prohibited', 'anchoring_prohibited'])

    def test_a_no_go_zone_keeps_its_edges(self):
        # Everything else reduces to a point because that is what structureIndex() consumes.
        # A boundary reduced to its centre tells you nothing about where the line runs.
        self.assertEqual(S.KEEP_GEOMETRY, {'RESARE', 'UNSARE'})
        for layer in S.KEEP_GEOMETRY:
            self.assertIn(layer, S.LAYERS)

    def test_an_unknown_restriction_code_is_labelled_not_dropped(self):
        codes = S.natsur_codes('99')
        self.assertEqual([S.RESTRN.get(c, f'restrn_{c}') for c in codes], ['restrn_99'])


class Serialising(unittest.TestCase):
    def test_an_array_attribute_becomes_a_list(self):
        # NATQUA as an ndarray crashed json.dump AFTER an hour of chart reading.
        class FakeArray(list):
            def tolist(self):
                return list(self)
        self.assertEqual(S.jsonable(FakeArray([1, 2])), [1, 2])

    def test_scalars_pass_through(self):
        for v in (None, 'x', 1, 1.5, True):
            self.assertEqual(S.jsonable(v), v)

    def test_anything_else_becomes_a_string_rather_than_raising(self):
        self.assertIsInstance(S.jsonable(object()), str)

    def test_the_result_survives_json_dump(self):
        class FakeArray(list):
            def tolist(self):
                return list(self)
        json.dumps({'NATQUA': S.jsonable(FakeArray([1, 4]))})


class LayerListing(unittest.TestCase):
    def test_pyogrios_name_and_geometry_pairs_reduce_to_names(self):
        # pyogrio returns an Nx2 array of (name, geometry_type). fiona and ogr return names.
        # The caller must not have to know which library geopandas chose.
        class FakeArray(list):
            def tolist(self):
                return list(self)
        pairs = FakeArray([['SBDARE', 'Point'], ['WRECKS', 'Point']])
        self.assertEqual(S.layer_names(pairs), ['SBDARE', 'WRECKS'])

    def test_a_plain_name_list_passes_through(self):
        self.assertEqual(S.layer_names(['SBDARE', 'DEPARE']), ['SBDARE', 'DEPARE'])

    def test_tuples_work_too(self):
        self.assertEqual(S.layer_names([('SBDARE', 'Point')]), ['SBDARE'])


class Vocabulary(unittest.TestCase):
    def test_the_substrate_keys_are_checked_against_the_weights_file(self):
        root = Path(tempfile.mkdtemp(prefix='encvoc_'))
        try:
            (root / 'registry').mkdir(parents=True)
            (root / 'registry' / 'species_habitat_weights.json').write_text(json.dumps({
                'species': {'Red Drum (Redfish)': {
                    'substrates': {'adult': {'fine': 3.5, 'shell': 2.0}}}}}), encoding='utf-8')
            self.assertEqual(S.weights_substrate_keys(root), {'fine', 'shell'})
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_a_missing_weights_file_is_empty_not_an_exception(self):
        self.assertEqual(S.weights_substrate_keys(Path(tempfile.gettempdir()) / 'nope'), set())


class Summary(unittest.TestCase):
    def test_counts_are_per_key_and_per_named_surface(self):
        feats = [{'substrate': 'fine', 'surfaces': ['sand', 'mud']},
                 {'substrate': 'fine', 'surfaces': ['sand']},
                 {'substrate': None, 'surfaces': []}]
        keys, names = S.summarise(feats)
        self.assertEqual(keys, {'fine': 2})
        self.assertEqual(names['sand'], 2)
        self.assertEqual(names['mud'], 1)


class ZoneBinding(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix='enczone_'))
        b = cls.root / 'registry' / 'boundaries'
        b.mkdir(parents=True)
        poly = {'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [
            [[-80.2, 32.6], [-79.7, 32.6], [-79.7, 33.1], [-80.2, 33.1], [-80.2, 32.6]]]}}
        (b / 'coast_charleston_sc.geojson').write_text(json.dumps(poly), encoding='utf-8')
        (b / 'wateree_lake.geojson').write_text(json.dumps(poly), encoding='utf-8')
        cls.zones = S.load_zones(cls.root)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def test_only_coastal_boundaries_are_loaded(self):
        self.assertEqual(sorted(self.zones), ['coast_charleston_sc'])

    def test_a_point_outside_every_zone_is_bound_to_nothing(self):
        self.assertEqual(S.zones_containing(-70.0, 40.0, self.zones), [])

    def test_a_point_inside_is_bound(self):
        self.assertEqual(S.zones_containing(-80.0, 32.8, self.zones), ['coast_charleston_sc'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
