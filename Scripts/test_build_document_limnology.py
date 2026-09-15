#!/usr/bin/env python3
r"""test_build_document_limnology.py

    py -m unittest discover -s scripts -p "test_build_document_limnology.py"
    python3 scripts/test_build_document_limnology.py

WHAT IT GUARDS. Two SC DES lake-program statements are real measurements at named stations, and
only one of them may speak for its lake:

    Monticello, B-890   bottom 132.5 ft, water averages  50.9 ft  -> the main basin
    Lake Murray, S-326  bottom  16.7 ft, water averages  42.8 ft  -> the Clouds Creek arm

Writing S-326's `below 3-4 m` into `lake_murray` as the lake's oxygen boundary is the Lake
Wateree 27 ft fabrication with better paperwork. The rule that separates them uses two measured
numbers -- the station's stated bottom against our charted mean -- and no constant typed in.

Personal use only, not for distribution or resale; not for navigation.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_document_limnology import (threshold_mgl, prose_offer, collapse, in_window,
                                      MIN_THERMOCLINE_FT, gather)

MONTICELLO = {'station': 'B-890',
              'quote': 'Bottom water DO concentrations of <2.0 mg/L were observed at the end of '
                       'May and gradually expanded to encompass the water column below 20 m by '
                       'early June.'}
MURRAY = {'station': 'S-326',
          'quote': 'There was a consistent feature of lower dissolved oxygen (<2.5 mg/L) below '
                   '3-4 m for most of the field season suggesting some water column thermal '
                   'stratification (Figure 3).'}
WATEREE = {'station': None,
           'quote': 'The profile collected on 7/30/2019 showed uniform water temperatures of 29C '
                    'from surface to the bottom with DO concentrations of less than 4 mg/L over '
                    'the upper ten meters, then decreasing to hypoxic and anoxic conditions in '
                    'deeper waters.'}


class Threshold(unittest.TestCase):
    def test_the_number_the_sentence_says_the_water_fell_under(self):
        self.assertEqual(threshold_mgl(MONTICELLO['quote']), 2.0)
        self.assertEqual(threshold_mgl(MURRAY['quote']), 2.5)
        self.assertEqual(threshold_mgl(WATEREE['quote']), 4.0)

    def test_a_sentence_with_no_threshold_gives_none(self):
        self.assertIsNone(threshold_mgl('Surface temperatures reached 32.5 C in late July.'))
        self.assertIsNone(threshold_mgl(None))


class WhichStationMaySpeak(unittest.TestCase):
    def test_a_main_basin_station_speaks_for_its_lake(self):
        field, why = prose_offer(MONTICELLO, 132.5, 50.9, 2.0)
        self.assertEqual(field, 'anoxicBelowFt')
        self.assertIsNone(why)

    def test_a_station_shallower_than_the_lakes_mean_does_not(self):
        field, why = prose_offer(MURRAY, 16.7, 42.8, 2.5)
        self.assertIsNone(field)
        self.assertIn('shallow part', why)
        self.assertIn('16.7', why)
        self.assertIn('42.8', why)

    def test_a_station_with_no_printed_bottom_cannot_be_tested(self):
        field, why = prose_offer(WATEREE, None, 18.5, 4.0)
        self.assertIsNone(field)
        self.assertIn('no bottom', why)

    def test_a_water_with_no_mean_depth_of_ours_cannot_be_tested_either(self):
        field, why = prose_offer(MONTICELLO, 132.5, None, 2.0)
        self.assertIsNone(field)
        self.assertIn('no average depth', why)

    # THE THRESHOLD DECIDES THE FIELD, and the two numbers are the Worker's own.
    def test_the_threshold_chooses_which_field_is_filled(self):
        self.assertEqual(prose_offer(MONTICELLO, 132.5, 50.9, 2.0)[0], 'anoxicBelowFt')
        self.assertEqual(prose_offer(MONTICELLO, 132.5, 50.9, 5.0)[0], 'depletionDepthFt')
        self.assertEqual(prose_offer(MONTICELLO, 132.5, 50.9, 4.0)[0], 'depletionDepthFt')

    def test_a_threshold_that_is_neither_is_refused_and_says_so(self):
        field, why = prose_offer(MONTICELLO, 132.5, 50.9, 6.5)
        self.assertIsNone(field)
        self.assertIn('neither', why)

    # A station EXACTLY at the mean has not shown it is in the deep part.
    def test_the_boundary_case_goes_to_refusal(self):
        self.assertIsNone(prose_offer(MONTICELLO, 50.9, 50.9, 2.0)[0])


class CollapseAndWindow(unittest.TestCase):
    # The median, and never a number nobody measured.
    def test_an_even_count_returns_a_measured_value_not_their_mean(self):
        self.assertEqual(collapse([14.8, 57.4]), 57.4)
        self.assertIn(collapse([10.0, 20.0, 30.0]), (20.0,))

    def test_keowee_1973_lands_on_the_late_summer_cast(self):
        self.assertEqual(collapse([17.0, 60.0, 60.0]), 60.0)

    def test_an_undated_cast_is_usable_and_says_it_is_undated(self):
        ok, undated = in_window({'date': '', 'year': '2007'})
        self.assertTrue(ok)
        self.assertIn('no sample date', undated)

    def test_a_winter_cast_is_not_in_the_window(self):
        self.assertFalse(in_window({'date': '2/14/2012'})[0])
        self.assertTrue(in_window({'date': '8/15/2022'})[0])

    def test_the_thermocline_floor_is_the_workers_own(self):
        self.assertEqual(MIN_THERMOCLINE_FT, 6.0)


if __name__ == '__main__':
    unittest.main(verbosity=2)


class TheNoteThatCameWithoutADepth(unittest.TestCase):
    """A cast that measured the column and could not NAME a number still said something.

    `gather` used to `continue` in silence on a null value, so the upstream note -- which
    fetch_nla_limnology.py writes for exactly this case, with the reason AND the depth it saw --
    never reached the served file. Lake Wateree, 2026-09-14:

        nla_limnology.json      thermoclineFt: null
                                thermoclineNote: "...steepest was 0.50 C/m at 18.0 ft..."
        document_limnology.json thermoclineNote: null

    and the app, finding that slot empty, filled it with a WQP surface-grab refusal -- telling the
    model there was no vertical profile for a lake the pipeline holds one for, whose steepest layer
    sat at 18 ft, between the 16 and 20 ft two Wateree guides give for the summer thermocline.
    """

    WATEREE = [('EPA National Lakes Assessment', {
        'date': '7/21/2022', 'year': '2022',
        'thermoclineFt': None,
        'thermoclineNote': 'no layer reaches 1.0 C/m, the classical cutoff -- steepest was '
                           '0.50 C/m at 18.0 ft over a 7.6 m cast.',
        'anoxicBelowFt': 19.7, 'anoxicNote': '0.80 mg/L at 6.0 m',
        'depletionDepthFt': 16.4, 'depletionNote': '2.40 mg/L at 5.0 m'})]

    def test_the_note_survives_a_null_value(self):
        th, note, _ = gather(self.WATEREE, 'thermoclineFt', 'measured vertical profile',
                               'thermoclineNote')
        self.assertIsNone(th, 'no depth is invented')
        self.assertIsNotNone(note, 'and the reason is not thrown away')
        self.assertIn('18.0 ft', note)
        self.assertIn('EPA National Lakes Assessment 7/21/2022', note,
                      'attributed to the cast that said it')

    def test_a_value_still_carries_its_own_note_not_the_refusal(self):
        an, note, _ = gather(self.WATEREE, 'anoxicBelowFt', 'measured vertical profile',
                               'anoxicNote')
        self.assertEqual(an, 19.7)
        self.assertIn('measured vertical profile', note)
        self.assertNotIn('1.0 C/m', note, 'the thermocline refusal is not this field business')

    def test_no_note_field_asked_for_means_no_note_invented(self):
        th, note, _ = gather(self.WATEREE, 'thermoclineFt', 'measured vertical profile')
        self.assertIsNone(th)
        self.assertIsNone(note)

    def test_a_water_with_nothing_measured_at_all_is_still_skipped(self):
        """The notes explain a missing value; they are not a reason to publish a water the casts
        could not measure in any respect."""
        blank = [('EPA National Lakes Assessment',
                  {'year': '2012', 'thermoclineFt': None, 'thermoclineNote': 'only 3 readings',
                   'anoxicBelowFt': None, 'depletionDepthFt': None})]
        th, thn, _ = gather(blank, 'thermoclineFt', 'x', 'thermoclineNote')
        an, _, _ = gather(blank, 'anoxicBelowFt', 'x', 'anoxicNote')
        de, _, _ = gather(blank, 'depletionDepthFt', 'x', 'depletionNote')
        self.assertIsNotNone(thn, 'the note exists')
        self.assertTrue(th is None and an is None and de is None,
                        'and main() drops the row on exactly this test')
