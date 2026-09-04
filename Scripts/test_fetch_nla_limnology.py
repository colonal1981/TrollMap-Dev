#!/usr/bin/env python3
"""test_fetch_nla_limnology.py -- run with `py .\scripts\test_fetch_nla_limnology.py`.

THE POINT OF THESE TESTS IS THE REFUSALS. Lake Wateree's stored profile carried a thermocline of
27 ft beside a note reading "No specific thermocline depth profile data provided in the source
text", and the same 27 in two oxygen fields, one of them a string. Nothing in the evidence array
supported any of it. A reader that will not say "no" is how that happens.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_nla_limnology as N

M = N.M_TO_FT


def cast(rows):
    """(depth_m, temp_C, do_mgL) triples, in the order the reader takes them."""
    return list(rows)


# A real summer reservoir: warm to 5 m, a hard break at 6-7 m, cold and anoxic below.
STRATIFIED = cast([(0.5, 29.1, 8.4), (2.0, 28.9, 8.1), (4.0, 28.4, 7.6), (5.0, 27.9, 6.9),
                   (6.0, 26.2, 4.8), (7.0, 21.0, 1.9), (9.0, 17.4, 0.6), (12.0, 15.8, 0.2)])

# Wateree's actual WQP shape: every record stamped at one depth. 3,211 of these answer nothing.
SURFACE_GRABS = cast([(1.0, 28.4, 8.2), (1.0, 28.5, 8.3), (1.0, 28.3, 8.1), (1.0, 28.6, 8.4),
                      (1.0, 28.2, 8.0), (1.0, 28.5, 8.2)])

# A shallow lake that genuinely does not stratify -- an ANSWER, not a gap.
WELL_MIXED = cast([(0.5, 26.0, 8.0), (2.0, 25.9, 7.9), (4.0, 25.8, 7.8),
                   (6.0, 25.7, 7.7), (8.0, 25.6, 7.6)])


class TheThermocline(unittest.TestCase):

    def test_a_real_cast_gives_the_break_and_says_where(self):
        ft, note = N.thermocline_from(STRATIFIED)
        self.assertIsNotNone(ft)
        self.assertAlmostEqual(ft, 6.5 * M, places=1)
        self.assertIn('C/m', note)

    def test_SURFACE_GRABS_ARE_REFUSED_however_many_there_are(self):
        """The Wateree case. Six readings, all at 1 m -- MIN_DEPTHS is satisfied and the SPAN is
        not, which is why both guards exist."""
        ft, note = N.thermocline_from(SURFACE_GRABS)
        self.assertIsNone(ft)
        self.assertIn('spans', note)
        self.assertIn('not the column', note)

    def test_a_short_cast_is_refused_and_counted(self):
        ft, note = N.thermocline_from(cast([(0.5, 28.0, 8.0), (2.0, 27.0, 7.0)]))
        self.assertIsNone(ft)
        self.assertIn('2 temperature readings', note)

    def test_A_WELL_MIXED_LAKE_IS_AN_ANSWER_NOT_A_GAP(self):
        ft, note = N.thermocline_from(WELL_MIXED)
        self.assertIsNone(ft)
        self.assertIn('did not stratify', note)
        self.assertIn('C/m', note)          # it says how close it came

    def test_missing_temperatures_do_not_become_zero(self):
        """`Number(null)` is 0 and 0 is a real temperature. Four occurrences of that trap in this
        codebase already."""
        ft, note = N.thermocline_from(cast([(0.5, None, 8.0), (2.0, None, 7.0),
                                            (4.0, None, 6.0), (6.0, None, 5.0)]))
        self.assertIsNone(ft)
        self.assertIn('0 temperature readings', note)

    def test_depths_out_of_order_are_sorted_not_trusted(self):
        shuffled = [STRATIFIED[i] for i in (3, 0, 7, 2, 5, 1, 6, 4)]
        self.assertEqual(N.thermocline_from(shuffled)[0], N.thermocline_from(STRATIFIED)[0])


class TheOxygen(unittest.TestCase):

    def test_anoxic_is_the_SHALLOWEST_crossing_not_the_deepest(self):
        ft, note = N.oxygen_from(STRATIFIED, N.ANOXIC_MGL)
        self.assertAlmostEqual(ft, 7.0 * M, places=1)
        self.assertIn('1.90 mg/L at 7.0 m', note)

    def test_depletion_uses_its_own_threshold(self):
        ft, _ = N.oxygen_from(STRATIFIED, N.DEPLETION_MGL)
        self.assertAlmostEqual(ft, 6.0 * M, places=1)          # 4.8 mg/L at 6 m
        self.assertLess(ft, N.oxygen_from(STRATIFIED, N.ANOXIC_MGL)[0])

    def test_oxygen_that_never_fails_is_reported_as_an_answer(self):
        ft, note = N.oxygen_from(WELL_MIXED, N.ANOXIC_MGL)
        self.assertIsNone(ft)
        self.assertIn('never fell under', note)
        self.assertIn('That is an answer, not a gap', note)


class TheColumnNames(unittest.TestCase):
    """NLA renamed its columns between cycles. A reader that knows one name gets nothing from the
    others while looking exactly like a survey that does not cover our states."""

    def test_finds_the_2007_and_the_2022_spellings(self):
        self.assertEqual(N.pick(['SITE_ID', 'LAT_DD', 'LON_DD'], N.COL['lat']), 'LAT_DD')
        self.assertEqual(N.pick(['UID', 'LAT_DD83', 'LON_DD83'], N.COL['lat']), 'LAT_DD83')

    def test_is_case_and_space_insensitive(self):
        self.assertEqual(N.pick(['Lat DD83'], N.COL['lat']), 'Lat DD83')

    def test_returns_None_rather_than_guessing(self):
        self.assertIsNone(N.pick(['SOMETHING_ELSE'], N.COL['lat']))


class TheNumbers(unittest.TestCase):

    def test_nan_is_not_a_number(self):
        self.assertIsNone(N.num('NaN'))
        self.assertIsNone(N.num(''))
        self.assertIsNone(N.num('.'))
        self.assertEqual(N.num('0'), 0.0)      # zero IS a value

    def test_every_source_names_both_files(self):
        for year, (site, profile) in N.SOURCES.items():
            self.assertTrue(site.startswith('https://www.epa.gov/'), year)
            self.assertTrue(profile.startswith('https://www.epa.gov/'), year)
            self.assertIn('profile', profile.lower(), year)


if __name__ == '__main__':
    unittest.main(verbosity=2)
