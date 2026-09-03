#!/usr/bin/env python3
"""
test_noaa_current_stations.py -- the binding must not invent a station on a water that has none.

Personal use only, not for distribution or resale; not for navigation.

The match is the whole script; the fetch is four lines of urllib. So the match is what is
tested, with a fixture rather than a live call -- a test that needs NOAA to be up is a test
that fails for reasons that have nothing to do with the code.

    py test_noaa_current_stations.py
"""

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_noaa_current_stations as C  # noqa: E402


def square(cx, cy, half):
    return [[[cx - half, cy - half], [cx + half, cy - half],
             [cx + half, cy + half], [cx - half, cy + half], [cx - half, cy - half]]]


def write_zone(root, slug, cx, cy, half, hole=None):
    polys = square(cx, cy, half)
    if hole:
        polys = [polys[0]] + square(cx, cy, hole)
    p = root / 'registry' / 'boundaries' / f'{slug}.geojson'
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({'type': 'Feature',
                             'geometry': {'type': 'Polygon', 'coordinates': polys}}),
                 encoding='utf-8')


class Binding(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix='curfix_'))
        # Two overlapping zones, the way the real coastal boundaries overlap, plus one far away.
        write_zone(cls.root, 'coast_alpha_sc', -80.00, 32.50, 0.20)
        write_zone(cls.root, 'coast_beta_sc', -80.10, 32.55, 0.20)
        write_zone(cls.root, 'coast_far_ga', -81.50, 31.10, 0.10)
        # A zone shaped like a ring: the middle is land and is NOT the water.
        write_zone(cls.root, 'coast_ring_nc', -78.00, 34.00, 0.30, hole=0.10)
        cls.zones = C.load_zones(cls.root)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def test_every_boundary_on_disk_is_loaded(self):
        self.assertEqual(sorted(self.zones), ['coast_alpha_sc', 'coast_beta_sc',
                                              'coast_far_ga', 'coast_ring_nc'])

    def test_a_station_inside_two_overlapping_zones_is_recorded_in_both(self):
        # The coastal boundaries genuinely overlap -- the Parris Island reef sits inside three.
        # Picking one by iteration order would be inventing an answer.
        s = [{'id': 'SAB0101', 'name': 'Overlap Channel', 'lat': 32.52, 'lng': -80.05}]
        bound, un = C.match_stations(C.station_rows(s), self.zones)
        self.assertEqual([r['id'] for r in bound['coast_alpha_sc']], ['SAB0101'])
        self.assertEqual([r['id'] for r in bound['coast_beta_sc']], ['SAB0101'])
        self.assertEqual(bound['coast_alpha_sc'][0]['matchedBy'], 'inside')
        self.assertEqual(un, [])

    def test_a_station_in_the_hole_is_not_in_the_zone(self):
        # Inside the outer ring, inside the hole. That is land, not water.
        s = [{'id': 'HOLE1', 'name': 'On the island', 'lat': 34.00, 'lng': -78.00}]
        # max_km is generous on purpose: the point must be refused by the RULE, not by being
        # out of range. The zone centre is the island itself, so a centre-distance fallback
        # would score it 0 km and sort it first.
        bound, un = C.match_stations(C.station_rows(s), self.zones, max_km=50.0)
        self.assertEqual(bound['coast_ring_nc'], [])
        self.assertEqual([x['id'] for x in un], ['HOLE1'])

    def test_a_station_just_outside_a_boundary_is_matched_as_near_not_inside(self):
        # A current station sits in a channel, and a channel is often outside the drawn edge.
        s = [{'id': 'NEAR1', 'name': 'Channel mouth', 'lat': 31.11, 'lng': -81.61}]
        bound, un = C.match_stations(C.station_rows(s), self.zones, max_km=15.0)
        self.assertEqual([r['id'] for r in bound['coast_far_ga']], ['NEAR1'])
        self.assertEqual(bound['coast_far_ga'][0]['matchedBy'], 'near')
        self.assertGreater(bound['coast_far_ga'][0]['km'], 0)

    def test_a_distant_station_is_bound_to_nothing(self):
        # THE FAILURE THAT MATTERS. A zone with no current station must report none, not the
        # nearest station in the ocean -- a bound station is read as a fact about that water.
        s = [{'id': 'FARAWAY', 'name': 'Chesapeake Bay Entrance', 'lat': 37.0, 'lng': -76.0}]
        bound, un = C.match_stations(C.station_rows(s), self.zones, max_km=8.0)
        self.assertEqual(sum(len(v) for v in bound.values()), 0)
        self.assertEqual([x['id'] for x in un], ['FARAWAY'])

    def test_near_picks_the_closest_zone_only(self):
        s = [{'id': 'BETWEEN', 'name': 'Between two', 'lat': 32.80, 'lng': -80.05}]
        bound, _ = C.match_stations(C.station_rows(s), self.zones, max_km=60.0)
        claimed = [k for k, v in bound.items() if v]
        self.assertEqual(len(claimed), 1, f'a near match must claim one zone, got {claimed}')

    # ---- reading the station list -----------------------------------------------------------
    def test_both_coordinate_spellings_are_read(self):
        # mdapi says lat/lng; other CO-OPS endpoints say latitude/longitude. A rename must not
        # empty the registry silently.
        rows = C.station_rows([{'id': 'A', 'name': 'a', 'lat': 32.5, 'lng': -80.0},
                               {'id': 'B', 'name': 'b', 'latitude': 32.5, 'longitude': -80.0}])
        self.assertEqual([r['id'] for r in rows], ['A', 'B'])

    def test_the_payload_may_be_wrapped_or_bare(self):
        one = {'id': 'A', 'name': 'a', 'lat': 32.5, 'lng': -80.0}
        self.assertEqual(len(C.station_rows({'stations': [one]})), 1)
        self.assertEqual(len(C.station_rows([one])), 1)

    def test_a_station_with_no_usable_position_is_dropped_not_placed_at_zero(self):
        rows = C.station_rows([{'id': 'BAD', 'name': 'no position'},
                               {'id': 'ALSOBAD', 'lat': 'n/a', 'lng': 'n/a'}])
        self.assertEqual(rows, [])

    def test_two_depth_bins_are_one_station_not_two(self):
        # NOAA's list is 4,430 entries and 2,785 stations. The first real run printed ACT6341
        # at Fort Macon twice, because a station with two current bins arrives as two rows.
        raw = [{'id': 'ACT6341', 'name': 'Fort Macon', 'lat': 34.69967, 'lng': -76.67533,
                'type': 'S', 'currbin': 1, 'depth': 10.0, 'depthType': 'S'},
               {'id': 'ACT6341', 'name': 'Fort Macon', 'lat': 34.69967, 'lng': -76.67533,
                'type': 'S', 'currbin': 2, 'depth': 20.0, 'depthType': 'S'}]
        rows = C.station_rows(raw)
        self.assertEqual(len(rows), 1)
        self.assertEqual([b['bin'] for b in rows[0]['bins']], [1, 2])
        self.assertEqual([b['depth'] for b in rows[0]['bins']], [10.0, 20.0])

    def test_two_stations_sharing_an_id_at_different_places_stay_two(self):
        raw = [{'id': 'X', 'name': 'a', 'lat': 32.0, 'lng': -80.0, 'currbin': 1},
               {'id': 'X', 'name': 'b', 'lat': 33.0, 'lng': -79.0, 'currbin': 1}]
        self.assertEqual(len(C.station_rows(raw)), 2)

    def test_a_station_with_no_bins_still_binds(self):
        rows = C.station_rows([{'id': 'NOBIN', 'name': 'n', 'lat': 32.5, 'lng': -80.0}])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['bins'], [])

    def test_a_row_with_no_id_is_dropped(self):
        self.assertEqual(C.station_rows([{'name': 'nameless', 'lat': 32.5, 'lng': -80.0}]), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
