#!/usr/bin/env python3
"""Tests for sonar_depths.py's reading and its sums (no recording needed).

Personal use only, not for distribution or resale; not for navigation.

The decoding itself was checked end to end on 28Sep26_Trip, 2026-10-01: the clock offsets came out
+56.0, +42.0 and +6.5 s with pings a median 0.4 m off the track, the same as the 9/28 page, and the
bigger marks were thickest in 20-30 ft and thinnest in 8-13 ft, as that page found."""
import importlib.util, json, os, tempfile, unittest
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
_s = importlib.util.spec_from_file_location('sd', os.path.join(HERE, 'sonar_depths.py'))
SD = importlib.util.module_from_spec(_s)
_s.loader.exec_module(SD)

# The shape the app's JSON button writes (trimmed from the 2026-10-02 Marion plan).
PLAN = {
    'meta': {'name': 'Lake Marion - Rowland AM Troll Oct 2', 'date': '2026-10-02'},
    'trolling': {'speciesBandFt': [20, 30], 'legSpeeds': [
        {'legId': 'T1', 'type': 'transit', 'speedMph': 3.5}, {'legId': 'L1', 'type': 'troll', 'speedMph': 2}]},
    'timeline': [
        {'legId': 'T1', 'legType': 'transit', 'rods': []},
        {'legId': 'L1', 'legType': 'troll', 'rods': [
            {'rod': 'R4', 'lure': 'Squarebill Crankbait', 'depth': '2–5'},
            {'rod': 'R5', 'lure': 'A-Rig Medium', 'depth': '9–13'}]}],
    'plan': {'conditions': {'depthBand': {'ft': [20, 30]}}},
    'gpx': {'trackList': [
        {'name': 'T1 · transit', 'pts': [[33.546151, -80.224262], [33.542409, -80.221582]]},
        {'name': 'L1 · 21 ft', 'pts': [[33.542409, -80.221582], [33.530601, -80.221023]]}]},
}

GPX = """<?xml version="1.0"?><gpx>
<trk><name>L3 · 41 ft</name><trkseg><trkpt lat="34.38" lon="-80.73"/><trkpt lat="34.39" lon="-80.74"/></trkseg></trk>
<trk><name>ACTIVE LOG</name><trkseg>
<trkpt lat="34.3803" lon="-80.7311"><ele>1</ele><time>2026-09-28T18:35:00Z</time></trkpt>
<trkpt lat="34.3805" lon="-80.7313"><ele>1</ele><time>2026-09-28T18:35:24Z</time></trkpt>
</trkseg></trk></gpx>"""


class Reading(unittest.TestCase):
    def test_the_plan_gives_its_band_legs_baits_and_transit_speed(self):
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
            json.dump(PLAN, f)
        p = SD.read_plan(f.name)
        os.unlink(f.name)
        self.assertEqual(p['band'], [20, 30])
        self.assertEqual(p['transit'], 3.5)
        self.assertEqual(list(p['legs']), ['L1'])            # a transit is not a leg
        self.assertEqual(p['baits']['L1'], ['R4 Squarebill Crankbait 2–5 ft', 'R5 A-Rig Medium 9–13 ft'])

    def test_the_unit_gpx_gives_its_active_log_and_the_legs_loaded_on_it(self):
        with tempfile.NamedTemporaryFile('w', suffix='.GPX', delete=False, encoding='utf-8') as f:
            f.write(GPX)
        log, legs = SD.read_gpx(f.name)
        os.unlink(f.name)
        self.assertEqual(log.shape, (2, 3))
        self.assertAlmostEqual(log[1, 0] - log[0, 0], 24)
        self.assertEqual(legs['L3']['pts'], [(34.38, -80.73), (34.39, -80.74)])

    def test_the_file_name_gives_the_minute_it_began_in_eastern_time(self):
        t = SD.start_of('28SEP26-1435-01.RSD')
        self.assertEqual(t % 60, 0)
        from datetime import datetime
        self.assertEqual(datetime.fromtimestamp(t, SD.EASTERN).strftime('%Y-%m-%d %H:%M'), '2026-09-28 14:35')


def acc_with(counts_by_layer, km=1.0):
    """An accumulator with `km` of water swept in every layer and the given marks per layer."""
    a = {'dist': np.zeros(len(SD.LAYERS)), 'all': np.zeros(len(SD.LAYERS)), 'big': np.zeros(len(SD.LAYERS))}
    for z0, n in counts_by_layer.items():
        i = int(np.nonzero(SD.LAYERS == z0)[0][0])
        a['all'][i] = a['big'][i] = n
    a['dist'][:16] = km * 1000          # 3.5 to 35.5 ft
    return a


class Sums(unittest.TestCase):
    def test_per_volume_takes_the_cone_out(self):
        # Marks in proportion to depth, as an even spread of fish gives under a widening beam.
        a = acc_with({z: int(round(10 * (z + 1))) for z in SD.LAYERS[:16]})
        rows, rel = SD.table(a, ('all',))
        self.assertTrue(all(abs(r - 1) < 0.06 for r in rel['all']))
        self.assertIn('in the band 1.0', SD.summary(a, 'all', [20, 30]))

    def test_a_band_thick_with_fish_reads_thick_and_the_densest_stretch_is_it(self):
        counts = {z: int(round(10 * (z + 1))) for z in SD.LAYERS[:16]}
        for z in (19.5, 21.5, 23.5, 25.5, 27.5):
            counts[z] *= 3
        s = SD.summary(acc_with(counts), 'all', [20, 30])
        self.assertRegex(s, r'in the band 1\.[6-9]\dx|in the band 2\.\d\dx')
        self.assertIn('the densest 10 ft was 19.5-29.5 ft', s)

    def test_a_few_marks_over_little_water_do_not_make_the_densest_stretch(self):
        counts = {z: int(round(10 * (z + 1))) for z in SD.LAYERS[:16]}
        for z in (19.5, 21.5, 23.5, 25.5, 27.5):
            counts[z] = int(counts[z] * 1.3)
        a = acc_with(counts)
        i = int(np.nonzero(SD.LAYERS == 33.5)[0][0])
        a['dist'][i] = 5                  # 5 m of water...
        a['all'][i] = 2                   # ...and two marks: a huge density on nothing
        self.assertIn('the densest 10 ft was 19.5-29.5 ft', SD.summary(a, 'all', [20, 30]))

    def test_without_a_band_it_says_to_read_the_table(self):
        self.assertIn('no band given', SD.summary(acc_with({21.5: 5}), 'all', None))


if __name__ == '__main__':
    unittest.main()
