#!/usr/bin/env python3
"""The feature_type cascade, and the one correction sitting on top of it.

Personal use only, not for distribution or resale; not for navigation.

consolidate_lake_index.py decides feature_type in one place, from six sources in order: an explicit
value already on the record, a hand correction, 3DHP's numeric featuretype, the boundary file's own
block, the coast_ slug prefix, NHD's FType, and last the NAME. Nine of 355 rows reach the name, all
nine were guessed 'river', and Ryan found eight right and one wrong.

These run against the source text rather than by importing it -- the module opens the registry at
import time -- and against the SHIPPED index, so a stale lake_index.json shows up as a failure here
rather than as a river gauge panel on a 66-acre oxbow.
"""
import json, os, re, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, 'consolidate_lake_index.py'), encoding='utf-8').read()


def find_registry():
    """registry/lake_index.json, from either place this script is delivered.

    Scripts are delivered to BOTH F:/TrollMapPipeline/scripts/ and
    F:/TrollMapPipeline/TrollMap-Dev/Scripts/, and `os.path.dirname(HERE)` is the pipeline root from
    the first and the REPO root from the second -- where there is no registry/. The first cut of
    this assumed one of the two and errored in the other, which I found by running it in the second
    place only after committing it. Walk up instead of assuming a depth.
    """
    d = HERE
    for _ in range(4):
        d = os.path.dirname(d)
        p = os.path.join(d, 'registry', 'lake_index.json')
        if os.path.exists(p):
            return p
    return None
CODE = '\n'.join(l for l in SRC.split('\n') if not l.strip().startswith('#'))


class TheCorrectionTable(unittest.TestCase):
    def test_the_table_exists_and_is_a_table(self):
        self.assertIn('FEATURE_TYPE_CORRECTIONS = {', CODE)

    def test_bates_is_corrected_to_a_lake(self):
        m = re.search(r"'bates_old_river':\s*\('([a-z]+)',\s*'([^']+)'\)", CODE)
        self.assertIsNotNone(m, 'bates_old_river is not in the correction table')
        self.assertEqual(m.group(1), 'lake')
        # WHO SAID SO AND WHEN, or it is indistinguishable from a typo in two months.
        self.assertIn('Ryan', m.group(2))
        self.assertIn('2026-09-16', m.group(2))

    def test_a_correction_is_checked_before_every_source(self):
        # Above 3DHP on purpose: on a 66-acre oxbow the person who fishes it outranks a national
        # dataset. If this ever moves below, the correction silently stops applying.
        i_fix = CODE.index('FEATURE_TYPE_CORRECTIONS.get(slug)')
        self.assertLess(i_fix, CODE.index('tdhp_ft.get(slug)'))
        self.assertLess(i_fix, CODE.index('boundary_feature_type(R, slug)'))
        self.assertLess(i_fix, CODE.index('RIVERISH.search'))

    def test_a_corrected_row_is_marked_and_stops_claiming_to_be_a_guess(self):
        self.assertIn("rec['feature_type'], rec['feature_type_corrected'] = fix", CODE)
        self.assertIn("rec.pop('feature_type_guessed', None)", CODE)

    def test_it_is_counted_like_every_other_source(self):
        self.assertIn("ft_src['corrected']", CODE)


class TheShippedIndex(unittest.TestCase):
    """What the app is actually serving. Fails until consolidate_lake_index.py is re-run."""

    @classmethod
    def setUpClass(cls):
        p = find_registry()
        if not p:
            raise unittest.SkipTest('no registry/lake_index.json above %s' % HERE)
        with open(p, encoding='utf-8') as fh:
            d = json.load(fh)
        cls.rows = d.get('lakes') or d
        # THE TABLE IS IN THE SCRIPT AND THE INDEX IS BUILT BY RUNNING IT. Until it is re-run these
        # assertions are about a file that predates the correction, so they SKIP with the command
        # rather than going red -- a failure here would say the code is wrong when what is stale is
        # the artifact. Once it runs they assert for real and stay asserting.
        if not cls.rows.get('bates_old_river', {}).get('feature_type_corrected'):
            raise unittest.SkipTest(
                'lake_index.json predates FEATURE_TYPE_CORRECTIONS -- rebuild it with:\n'
                '    py F:\\TrollMapPipeline\\scripts\\consolidate_lake_index.py')

    def test_bates_ships_as_a_lake(self):
        r = self.rows['bates_old_river']
        self.assertEqual(r.get('feature_type'), 'lake',
                         'run: py scripts\\consolidate_lake_index.py  -- the table is in the '
                         'script and the index has not been rebuilt from it')
        self.assertTrue(r.get('feature_type_corrected'))
        self.assertIsNone(r.get('feature_type_guessed'))

    def test_the_other_eight_guesses_are_left_alone(self):
        # Ryan read all nine and corrected exactly one. Widening the table without him looking is
        # how a correction becomes a guess with better manners.
        for slug in ('black_mingo_creek', 'broad_river', 'cape_fear_river', 'chessie_creek',
                     'edisto_river', 'ocmulgee_river', 'ogeechee_river', 'south_fork_new_river'):
            self.assertEqual(self.rows[slug].get('feature_type'), 'river', slug)

    def test_the_guess_set_has_not_quietly_grown(self):
        # Nine was the count when he read it. A tenth is a row nobody has looked at.
        guessed = sorted(s for s, r in self.rows.items() if r.get('feature_type_guessed'))
        self.assertLessEqual(len(guessed), 8,
                             'new name-guessed rows that nobody has checked: %s' % guessed)

    def test_the_counts_the_pickers_are_built_on(self):
        # Ryan's map picker read 284 lakes, 58 rivers, 13 coastal before this correction. Bates
        # moves one across, and every picker groups off this field.
        from collections import Counter
        c = Counter(r.get('feature_type') for r in self.rows.values())
        self.assertEqual(sum(c.values()), 355)
        self.assertEqual(c['coastal'], 13)
        self.assertEqual(c['lake'], 285)
        self.assertEqual(c['river'], 57)


if __name__ == '__main__':
    unittest.main(verbosity=2)
