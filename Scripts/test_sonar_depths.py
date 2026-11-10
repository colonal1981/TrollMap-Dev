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


def gpx_on(day, n, name='ACTIVE LOG'):
    pts = ''.join(f'<trkpt lat="34.38" lon="-80.73"><time>{day}T15:{i // 60:02d}:{i % 60:02d}Z</time></trkpt>'
                  for i in range(n))
    return f'<?xml version="1.0"?><gpx><trk><name>{name}</name><trkseg>{pts}</trkseg></trk></gpx>'


class WhichGpx(unittest.TestCase):
    """11/9: his 11/9 folder had 09NOV2026.GPX, no EXPORT in the name, and the script read no track from it."""
    def folder(self, files):
        d = tempfile.mkdtemp()
        for name, text in files.items():
            with open(os.path.join(d, name), 'w', encoding='utf-8') as fh:
                fh.write(text)
        return d

    def test_a_gpx_without_export_in_its_name_is_read_when_it_has_the_days_track(self):
        d = self.folder({'09NOV2026.GPX': gpx_on('2026-11-09', 30), 'old.GPX': gpx_on('2026-10-31', 90)})
        g, why, log, _ = SD.pick_gpx(d, [os.path.join(d, '09NOV26-0901-01.RSD')])
        self.assertEqual(os.path.basename(g), '09NOV2026.GPX')
        self.assertIn('most track points', why)
        self.assertEqual(len(log), 30)

    def test_export_still_wins(self):
        d = self.folder({'09NOV2026.GPX': gpx_on('2026-11-09', 90), 'EXPORT.GPX': gpx_on('2026-11-09', 10)})
        g, why, _, _ = SD.pick_gpx(d, [os.path.join(d, '09NOV26-0901-01.RSD')])
        self.assertEqual(os.path.basename(g), 'EXPORT.GPX')

    def test_none_on_the_day_is_said(self):
        d = self.folder({'old.GPX': gpx_on('2026-10-31', 20)})
        g, why, log, _ = SD.pick_gpx(d, [os.path.join(d, '09NOV26-0901-01.RSD')])
        self.assertIsNone(g)
        self.assertIn("recordings' days", why)
        self.assertEqual(len(log), 0)


class EasternTime(unittest.TestCase):
    def test_november_is_est_and_september_edt_without_a_tz_database(self):
        from datetime import datetime, timezone
        was = SD.EASTERN
        try:
            SD.EASTERN = SD.USEastern()
            t = SD.start_of('09NOV26-0901-01.RSD')
            self.assertEqual(datetime.fromtimestamp(t, timezone.utc).strftime('%H:%M'), '14:01')
            self.assertEqual(datetime.fromtimestamp(t, SD.EASTERN).tzname(), 'EST')
            t = SD.start_of('28SEP26-1435-01.RSD')
            self.assertEqual(datetime.fromtimestamp(t, timezone.utc).strftime('%H:%M'), '18:35')
            self.assertEqual(datetime.fromtimestamp(t, SD.EASTERN).tzname(), 'EDT')
        finally:
            SD.EASTERN = was


def water(n_pings=1200, depth=40.0, seed=1):
    """A column as column() returns it: log10 samples on a 0.1 ft axis, speckled water and a bright bottom."""
    rng = np.random.default_rng(seed)
    Z = np.arange(0, depth + 3, 0.1) + 0.05
    S = rng.gamma(2.0, 20.0, (n_pings, len(Z)))
    S[:, (Z > depth - 0.3) & (Z < depth + 1.0)] = 4000.0
    S[:, Z > depth + 1.0] = 600.0
    D = np.full(n_pings, depth)
    t = np.arange(n_pings) * 0.2                  # 5 pings a second: two 2-minute stretches
    return Z, S, D, t


def as_column(S):
    return np.log10(np.clip(S, 1, None)).astype(np.float16)


class ScreenMarks(unittest.TestCase):
    def test_a_bright_arch_is_a_mark_and_a_solid_one(self):
        Z, S, D, t = water()
        zz = (Z > 28.5) & (Z < 30.0)
        S[100:130, zz] = 3000.0                   # a fish at 29 ft, 30 pings
        marks, valid, used = SD.screen_marks(Z, as_column(S), D, t)
        self.assertEqual(used, 2)
        fish = [m for m in marks if 27 < m[1] < 31 and 95 <= m[0] <= 135]
        self.assertEqual(len(fish), 1, marks[:5])
        _, z, pk, npg, tall = fish[0]
        self.assertGreaterEqual(pk, SD.SOLID_PEAK)
        self.assertGreaterEqual(npg, SD.SOLID_PINGS)
        self.assertLessEqual(tall, 2.0)

    def test_the_speckle_and_a_dim_smear_are_not_marks_and_a_wall_is_too_tall(self):
        Z, S, D, t = water()
        S[200:240, (Z > 15) & (Z < 16)] = 60.0    # under the water's 95th percentile
        S[400:420, (Z > 10) & (Z < 25)] = 3000.0  # 15 ft tall: a thermocline or clutter, not a fish
        marks, _, _ = SD.screen_marks(Z, as_column(S), D, t)
        self.assertFalse([m for m in marks if 195 <= m[0] <= 245 and 14 < m[1] < 17])
        self.assertFalse([m for m in marks if 395 <= m[0] <= 425 and m[4] > SD.MAX_TALL_FT])

    def test_nothing_within_two_feet_of_the_bottom(self):
        Z, S, D, t = water()
        S[300:330, (Z > 38.5) & (Z < 39.5)] = 3000.0
        marks, _, _ = SD.screen_marks(Z, as_column(S), D, t)
        self.assertFalse([m for m in marks if m[1] > 38.0])

    def test_where_they_sat_says_depth_and_height_off_the_bottom(self):
        s = SD.where_they_sat(np.r_[np.full(10, 29.0), np.full(10, 31.0)], np.r_[np.full(15, 6.0), np.full(5, 12.0)])
        self.assertIn('depth 29/30/31 ft', s)
        self.assertIn('off the bottom 6/6/8 ft', s)
        self.assertIn('75% within 6 ft of the bottom', s)
        self.assertIn('too few', SD.where_they_sat([20.0], [5.0]))


if __name__ == '__main__':
    unittest.main()
