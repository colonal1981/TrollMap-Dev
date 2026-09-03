#!/usr/bin/env python3
"""
test_ehydro_surveys.py -- an ArcGIS failure must not read as "this water has no surveys".

Personal use only, not for distribution or resale; not for navigation.

ArcGIS answers an error with HTTP 200 and an `error` key in the body. A reader that only
checked the status code would take that as zero features and write "no surveys" into the
registry for a zone the Corps surveys twice a year. That is the failure this file exists for;
the rest is paging and dates.

    py test_ehydro_surveys.py
"""

import json
import shutil
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_ehydro_surveys as E  # noqa: E402


def feature(name, end_ms, district='SAC', job='J1'):
    return {'attributes': {'surveyjobidpk': job, 'sdsfeaturename': name,
                           'usacedistrictcode': district, 'surveydateend': end_ms,
                           'sourcedatalocation': f'https://example.invalid/{job}.zip'}}


class Parsing(unittest.TestCase):
    def test_an_arcgis_error_raises_instead_of_reading_as_empty(self):
        payload = {'error': {'code': 400, 'message': 'Invalid or missing input parameters.'}}
        with self.assertRaises(RuntimeError) as cm:
            E.parse_features(payload)
        self.assertIn('400', str(cm.exception))

    def test_a_real_empty_result_is_empty_not_an_error(self):
        rows, more = E.parse_features({'features': []})
        self.assertEqual(rows, [])
        self.assertFalse(more)

    def test_epoch_milliseconds_become_a_readable_date(self):
        rows, _ = E.parse_features({'features': [feature('AIWW Reach 3', 1717200000000)]})
        self.assertEqual(rows[0]['surveydateend'], '2024-06-01')

    def test_a_missing_date_is_left_alone_not_turned_into_1970(self):
        rows, _ = E.parse_features({'features': [
            {'attributes': {'sdsfeaturename': 'X', 'surveydateend': None}}]})
        self.assertIsNone(rows[0]['surveydateend'])

    def test_the_transfer_limit_flag_is_reported(self):
        _, more = E.parse_features({'features': [feature('A', 0)],
                                    'exceededTransferLimit': True})
        self.assertTrue(more)


class Paging(unittest.TestCase):
    def test_paging_continues_until_the_service_stops_saying_there_is_more(self):
        pages = [
            {'features': [feature(f'R{i}', 1717200000000, job=f'J{i}') for i in range(3)],
             'exceededTransferLimit': True},
            {'features': [feature('R3', 1717200000000, job='J3')]},
        ]
        seen = []

        def fake(url):
            seen.append(url)
            return pages[len(seen) - 1]

        rows = E.surveys_for((-80.2, 32.6, -79.7, 33.1), fetch=fake)
        self.assertEqual(len(rows), 4)
        self.assertEqual(len(seen), 2)
        # the second call must have advanced the offset, or this loops forever
        off = urllib.parse.parse_qs(urllib.parse.urlparse(seen[1]).query)['resultOffset'][0]
        self.assertEqual(off, '3')

    def test_since_filters_by_survey_year(self):
        pages = [{'features': [feature('Old', 946684800000),      # 2000
                               feature('New', 1717200000000)]}]   # 2024
        rows = E.surveys_for((0, 0, 1, 1), since='2020', fetch=lambda u: pages[0])
        self.assertEqual([r['sdsfeaturename'] for r in rows], ['New'])


class QueryUrl(unittest.TestCase):
    def test_the_box_is_sent_as_a_wgs84_envelope(self):
        q = urllib.parse.parse_qs(
            urllib.parse.urlparse(E.query_url((-80.2, 32.6, -79.7, 33.1))).query)
        self.assertEqual(q['geometry'][0], '-80.2,32.6,-79.7,33.1')
        self.assertEqual(q['geometryType'][0], 'esriGeometryEnvelope')
        self.assertEqual(q['inSR'][0], '4326')
        self.assertEqual(q['spatialRel'][0], 'esriSpatialRelIntersects')

    def test_geometry_is_not_requested_back(self):
        q = urllib.parse.parse_qs(
            urllib.parse.urlparse(E.query_url((0, 0, 1, 1))).query)
        self.assertEqual(q['returnGeometry'][0], 'false')

    def test_the_download_path_is_among_the_requested_fields(self):
        # Without sourcedatalocation the row records that a survey exists and gives no way to
        # get it, which is the whole point of the index.
        self.assertIn('sourcedatalocation', E.FIELDS)
        q = urllib.parse.parse_qs(
            urllib.parse.urlparse(E.query_url((0, 0, 1, 1))).query)
        self.assertIn('sourcedatalocation', q['outFields'][0])


class Newest(unittest.TestCase):
    def test_one_row_per_reach_and_it_is_the_latest(self):
        rows, _ = E.parse_features({'features': [
            feature('AIWW Reach 3', 1420070400000, job='OLD'),     # 2015
            feature('AIWW Reach 3', 1717200000000, job='NEW'),     # 2024
            feature('Charleston Entrance', 1717200000000, job='CE'),
        ]})
        best = E.newest_per_channel(rows)
        self.assertEqual(len(best), 2)
        reach = next(r for r in best if r['sdsfeaturename'] == 'AIWW Reach 3')
        self.assertEqual(reach['surveyjobidpk'], 'NEW')

    def test_an_unnamed_reach_is_kept_not_collapsed_into_one(self):
        rows, _ = E.parse_features({'features': [
            feature('', 1717200000000, job='A'), feature('', 1717200000000, job='B')]})
        self.assertEqual(len(E.newest_per_channel(rows)), 2)


class ZoneBoxes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix='ehyfix_'))
        b = cls.root / 'registry' / 'boundaries'
        b.mkdir(parents=True)
        poly = {'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [
            [[-80.2, 32.6], [-79.7, 32.6], [-79.7, 33.1], [-80.2, 33.1], [-80.2, 32.6]]]}}
        for slug in ('coast_charleston_sc', 'black_river', 'wateree_lake', 'unknown_water'):
            (b / f'{slug}.geojson').write_text(json.dumps(poly), encoding='utf-8')
        (cls.root / 'registry' / '_feature_types.json').write_text(json.dumps({
            'black_river': 'river', 'wateree_lake': 'lake'}), encoding='utf-8')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def test_coastal_and_river_are_asked_about_and_lakes_are_not(self):
        got = E.load_zone_boxes(self.root)
        self.assertEqual(sorted(got), ['black_river', 'coast_charleston_sc'])

    def test_an_unclassified_water_is_skipped_not_guessed(self):
        self.assertNotIn('unknown_water', E.load_zone_boxes(self.root))

    def test_the_box_comes_from_the_polygon(self):
        box = E.load_zone_boxes(self.root)['coast_charleston_sc']['bbox']
        self.assertEqual([round(v, 4) for v in box], [-80.2, 32.6, -79.7, 33.1])


if __name__ == '__main__':
    unittest.main(verbosity=2)
