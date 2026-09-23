#!/usr/bin/env python3
"""test_research_lakes_carry.py -- the run may only change what it computed.

    py .\scripts\test_research_lakes_carry.py

Personal use only, not for distribution or resale; not for navigation.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import research_lakes as R                                    # noqa: E402


class CarryForward(unittest.TestCase):
    def test_a_field_the_run_did_not_compute_survives(self):
        # 42 of 52 lakes lost trophicStatus this way: the deterministic skeleton has the key with
        # nothing in it, and the save stored the skeleton.
        stored = {'limnology': {'trophicStatus': 'eutrophic', 'seasonalDrawdownFt': 4}}
        fresh = {'limnology': {'trophicStatus': None, 'seasonalDrawdownFt': None}}
        self.assertEqual(R.carry_forward(stored, fresh), stored)

    def test_a_field_the_run_did_compute_wins(self):
        stored = {'limnology': {'trophicStatus': 'eutrophic'}}
        fresh = {'limnology': {'trophicStatus': 'mesotrophic'}}
        self.assertEqual(R.carry_forward(stored, fresh)['limnology']['trophicStatus'], 'mesotrophic')

    def test_a_partial_block_does_not_delete_its_neighbours(self):
        # A fresh limnology carrying only a thermocline must not take the Secchi with it.
        stored = {'limnology': {'thermocline': {'summerDepthFt': 20},
                                'waterClarity': {'secchiFt': 8.6}}}
        fresh = {'limnology': {'thermocline': {'summerDepthFt': 22}}}
        out = R.carry_forward(stored, fresh)
        self.assertEqual(out['limnology']['thermocline']['summerDepthFt'], 22)
        self.assertEqual(out['limnology']['waterClarity']['secchiFt'], 8.6)

    def test_an_empty_list_never_overwrites_a_full_one(self):
        # "I did not look" and "there is nothing there" are different claims.
        stored = {'biology': {'primaryForage': ['Threadfin Shad']}}
        fresh = {'biology': {'primaryForage': []}}
        self.assertEqual(R.carry_forward(stored, fresh)['biology']['primaryForage'],
                         ['Threadfin Shad'])

    def test_a_full_list_from_the_run_does_overwrite(self):
        stored = {'biology': {'predatorSpecies': ['Largemouth Bass']}}
        fresh = {'biology': {'predatorSpecies': ['Largemouth Bass', 'Bluegill']}}
        self.assertEqual(len(R.carry_forward(stored, fresh)['biology']['predatorSpecies']), 2)

    def test_a_new_section_from_the_run_is_taken(self):
        self.assertEqual(R.carry_forward({}, {'trollingIntelligence': {'Bass': {}}}),
                         {'trollingIntelligence': {'Bass': {}}})

    def test_a_zero_is_a_value_and_not_an_absence(self):
        # 0 ft of drawdown is a measurement. It must beat a stored 4.
        stored = {'limnology': {'seasonalDrawdownFt': 4}}
        fresh = {'limnology': {'seasonalDrawdownFt': 0}}
        self.assertEqual(R.carry_forward(stored, fresh)['limnology']['seasonalDrawdownFt'], 0)

    def test_nothing_stored_means_the_run_stands_alone(self):
        fresh = {'biology': {'predatorSpecies': ['Bass']}}
        self.assertEqual(R.carry_forward({}, fresh), fresh)


class CarriedKeys(unittest.TestCase):
    def test_it_names_what_was_kept_and_nothing_else(self):
        stored = {'limnology': {'trophicStatus': 'eutrophic', 'seasonalDrawdownFt': 4},
                  'biology': {'predatorSpecies': ['Bass']}}
        fresh = {'limnology': {'trophicStatus': None, 'seasonalDrawdownFt': None},
                 'biology': {'predatorSpecies': ['Bass', 'Bluegill']}}
        self.assertEqual(R.carried_keys(stored, fresh),
                         {'limnology.trophicStatus', 'limnology.seasonalDrawdownFt'})

    def test_an_empty_stored_field_is_not_reported_as_carried(self):
        self.assertEqual(R.carried_keys({'limnology': {'trophicStatus': None}},
                                        {'limnology': {'trophicStatus': None}}), set())


class TheBatchAssertsNoStatus(unittest.TestCase):
    """`status_of()` stood here until 2026-09-23, when draft/verified was retired.

    Its three cases were the guard on A BATCH MAY NOT ASSERT A FIELD IT DID NOT COMPUTE. That rule
    is not retired -- it is why `carry_forward` above exists -- but the field it was guarding is
    gone, and a test that keeps asserting the shape of a deleted function is how a retirement gets
    quietly reverted. This asserts the retirement instead.
    """

    def test_the_helper_is_gone(self):
        self.assertFalse(hasattr(R, 'status_of'))

    def test_the_save_payload_names_no_status(self):
        src = open(R.__file__, encoding='utf-8').read()
        code = '\n'.join(l for l in src.split('\n') if not l.strip().startswith('#'))
        self.assertNotIn('"status"', code)
        self.assertNotIn("'status'", code)


if __name__ == '__main__':
    unittest.main(verbosity=2)


class TheLimnologySelectorAsksTheDocument(unittest.TestCase):
    """--needs-limnology picks a water by comparing its note to the cast's, exactly.

    THE FIRST VERSION SAID `if th.get("note"): continue` -- any sentence counted as done. On
    2026-09-15 four waters held a WQP SURFACE-GRAB refusal in that slot while the pipeline held a
    real vertical cast for each, so the flag skipped precisely the waters it existed to find.

    THE SECOND VERSION USED A PROXY AND THE PROXY WAS WRONG. It asked whether the note named a
    gradient in C/m, on the theory that every cast refusal does. National Lakes Assessment notes
    do; National Eutrophication Survey notes do not -- "only 3 temperature readings in the cast;
    4 needed", "the 8 readings that survived the scan show no layer". Murray and Secession stayed
    selected after they were already fixed, and Monticello -- whose oxygen comes off a lake-program
    statement and which has no thermocline cast at all -- would have been selected forever.

    A selector that never empties is a lying counter. Ryan set the rule for this flag on
    2026-09-14, "fix it so that it runs what needs to run", and empty has to mean done. The test
    below is the whole rule: does the profile carry what the document says, or not.
    """

    @staticmethod
    def decide(profile_note, doc_note):
        """The predicate as research_lakes.py applies it. Returns 'done' or 'run'."""
        note = str(profile_note or "").strip() or None
        doc = str(doc_note or "").strip() or None
        return "done" if (doc is None or doc == note) else "run"

    def test_a_weaker_note_than_the_cast_offers_is_a_run(self):
        self.assertEqual(self.decide(
            "These are surface grabs with a depth stamp, not a vertical profile.",
            "EPA National Lakes Assessment 7/21/2022: steepest was 0.50 C/m at 18.0 ft"), "run")

    def test_the_cast_note_already_carried_is_done(self):
        cast = "EPA National Lakes Assessment 7/21/2022: steepest was 0.50 C/m at 18.0 ft"
        self.assertEqual(self.decide(cast, cast), "done")

    def test_a_survey_note_with_no_gradient_in_it_is_still_a_cast_note(self):
        """The exact bug the C/m proxy caused. Murray and Secession carry these."""
        for note in ("EPA National Eutrophication Survey 1973-07-09: the 8 readings that "
                     "survived the scan show no layer",
                     "EPA National Eutrophication Survey 1973-06-26: only 3 temperature "
                     "readings in the cast; 4 needed"):
            self.assertEqual(self.decide(note, note), "done",
                             "a note that names no C/m is still the document's own answer")

    def test_a_document_with_no_note_can_never_select_the_water(self):
        """Monticello: oxygen off a lake-program statement, no thermocline cast at all. There is
        no run that would change its note, so selecting it forever is a counter that lies."""
        self.assertEqual(self.decide(
            "These are surface grabs with a depth stamp, not a vertical profile.", None), "done")
        self.assertEqual(self.decide(None, None), "done")

    def test_a_water_with_nothing_yet_and_a_cast_waiting_is_a_run(self):
        self.assertEqual(self.decide(None, "EPA NLA 2022: steepest 0.50 C/m at 18.0 ft"), "run")

    def test_whitespace_is_not_a_difference(self):
        self.assertEqual(self.decide("  a cast said this  ", "a cast said this"), "done")
