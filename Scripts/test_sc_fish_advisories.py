#!/usr/bin/env python3
"""
test_sc_fish_advisories.py -- the parser must read the water Ryan checked by hand.

Personal use only, not for distribution or resale; not for navigation.

Lake H.B. Robinson is the calibration target because it is the water this source was found for
and the only one whose full advisory has been read by a person. Both renderings below are real:
the first is how the map popup laid it out, the second is how a summarising reader rendered the
same attribute. NOTHING HERE KNOWS WHICH ONE THE SERVER ACTUALLY SENDS -- the sandbox has no
network -- so the parser must read both and the run must say what it could not read.

    py test_sc_fish_advisories.py
"""

import importlib.util
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('fsa', HERE / 'fetch_sc_fish_advisories.py')
M = importlib.util.module_from_spec(spec)
sys.modules['fsa'] = M
spec.loader.exec_module(M)

# THE REAL BYTES, pulled from the service 2026-09-03 and pasted verbatim. Ryan asked the question
# that got them -- "why does the map view show the full species list but the api doesn't? the map
# is pulled from the api?" -- and the answer was that the API always had all six and the reader in
# front of me had dropped one. The field is HTML. The parser was written against a paraphrase of
# it and would have failed on all 114 features.
RAW_HTML = (
    '<strong>Bass- Largemouth</strong><ul style="list-style: none; margin: 0;">'
    '<li>One meal per month</ul>'
    '<strong>Bluegill</strong><ul style="list-style: none; margin: 0;">'
    '<li>One meal per week</ul>'
    '<strong>Bowfin (Mudfish)</strong><ul style="list-style: none; margin: 0;">'
    '<li>DO NOT EAT ANY</ul>'
    '<strong>Chain Pickerel</strong><ul style="list-style: none; margin: 0;">'
    '<li>One meal per week</ul>'
    '<strong>Sunfish- Redear</strong><ul style="list-style: none; margin: 0;">'
    '<li>No Restrictions</ul>'
    '<strong>Warmouth</strong><ul style="list-style: none; margin: 0;">'
    '<li>One meal per week</ul>')

# The same water as the map popup laid it out. Kept as a fallback shape, not the real one.
POPUP = """Bass- Largemouth
One meal per month
Bluegill
One meal per week
Bowfin (Mudfish)
DO NOT EAT ANY
Chain Pickerel
One meal per week
Sunfish- Redear
No Restrictions
Warmouth
One meal per week"""

# The same field as a colon/semicolon string.
INLINE = ('Bass- Largemouth: One meal per month; Bluegill: One meal per week; '
          'Bowfin (Mudfish): DO NOT EAT ANY; Chain Pickerel: One meal per week; '
          'Sunfish- Redear: No Restrictions; Warmouth: One meal per week')

EXPECTED = [
    ('Largemouth Bass', 'One meal per month'),
    ('Bluegill', 'One meal per week'),
    ('Bowfin (Mudfish)', 'DO NOT EAT ANY'),
    ('Chain Pickerel', 'One meal per week'),
    ('Redear Sunfish', 'No Restrictions'),
    ('Warmouth', 'One meal per week'),
]


class TheNames(unittest.TestCase):
    def test_the_inverted_form_is_turned_back_into_a_fish(self):
        # 'Bass- Largemouth' is how a table is SORTED, not how a fish is called.
        self.assertEqual(M.uninvert('Bass- Largemouth'), 'Largemouth Bass')
        self.assertEqual(M.uninvert('Sunfish- Redear'), 'Redear Sunfish')
        self.assertEqual(M.uninvert('Crappie- Black'), 'Black Crappie')
        self.assertEqual(M.uninvert('Bass- Spotted'), 'Spotted Bass')

    def test_a_parenthetical_is_left_alone(self):
        # species_alternates() already expands 'Bowfin (Mudfish)' into both halves; splitting it
        # here would be a second normaliser doing the same job slightly differently.
        self.assertEqual(M.uninvert('Bowfin (Mudfish)'), 'Bowfin (Mudfish)')
        self.assertEqual(M.uninvert('Warmouth'), 'Warmouth')

    def test_a_hyphen_inside_a_name_is_not_an_inversion(self):
        self.assertEqual(M.uninvert('Bluegill'), 'Bluegill')
        self.assertEqual(M.uninvert(''), '')
        self.assertEqual(M.uninvert(None), '')


class TheRestrictionText(unittest.TestCase):
    def test_THE_REAL_HTML_READS_ALL_SIX(self):
        # The calibration target. Six species, in publication order, off the actual bytes.
        pairs, unparsed, notes = M.parse_restrictions(RAW_HTML)
        self.assertEqual([(p['species'], p['advice']) for p in pairs], EXPECTED)
        self.assertEqual(unparsed, [])
        self.assertEqual(notes, [])

    def test_an_advice_phrase_with_no_species_is_not_a_fish(self):
        # 'J. Robinson Lake' publishes exactly this and nothing else. A species called
        # "No Restrictions" would be a fish that does not exist, handed to a plan.
        pairs, unparsed, notes = M.parse_restrictions('<strong>No Restrictions</strong>')
        self.assertEqual(pairs, [])
        self.assertEqual(notes, ['No Restrictions'])
        self.assertEqual(unparsed, [])

    def test_the_popup_shape_reads_all_six(self):
        pairs, unparsed, _ = M.parse_restrictions(POPUP)
        self.assertEqual([(p['species'], p['advice']) for p in pairs], EXPECTED)
        self.assertEqual(unparsed, [])

    def test_the_inline_shape_reads_the_same_six(self):
        pairs, unparsed, _ = M.parse_restrictions(INLINE)
        self.assertEqual([(p['species'], p['advice']) for p in pairs], EXPECTED)
        self.assertEqual(unparsed, [])

    def test_what_was_published_is_kept_beside_what_we_call_it(self):
        # The state's own words have to survive, or nothing can be checked against the page.
        pairs, _, _ = M.parse_restrictions(RAW_HTML)
        by = {p['species']: p['published_as'] for p in pairs}
        self.assertEqual(by['Largemouth Bass'], 'Bass- Largemouth')
        self.assertEqual(by['Redear Sunfish'], 'Sunfish- Redear')

    def test_text_the_parser_cannot_read_is_returned_not_dropped(self):
        # THE WHOLE POINT. A line nobody anticipated must show up in the run, not vanish.
        pairs, unparsed, _ = M.parse_restrictions(
            'Bluegill\nOne meal per week\nsome sentence the state added later')
        self.assertEqual([p['species'] for p in pairs], ['Bluegill'])
        self.assertEqual(unparsed, ['some sentence the state added later'])

    def test_empty_is_empty_and_never_a_throw(self):
        for v in (None, '', '   '):
            self.assertEqual(M.parse_restrictions(v), ([], [], []))

    def test_do_not_eat_is_its_own_question(self):
        self.assertTrue(M.do_not_eat('DO NOT EAT ANY'))
        self.assertTrue(M.do_not_eat('Do not eat any'))
        self.assertFalse(M.do_not_eat('One meal per week'))
        self.assertFalse(M.do_not_eat('No Restrictions'))
        self.assertFalse(M.do_not_eat(None))

    def test_no_restrictions_is_still_a_species_that_is_present(self):
        # A fish with no restriction is a fish the state sampled HERE. Dropping it because the
        # advice is boring would throw away the presence fact, which is the point of the source.
        pairs, _, _ = M.parse_restrictions(RAW_HTML)
        self.assertIn('Redear Sunfish', [p['species'] for p in pairs])


class TheNameGate(unittest.TestCase):
    def test_a_generic_word_is_not_agreement(self):
        # 'Lake' identifies nothing. This is the gate that stops an advisory landing on the
        # wrong water, and it is the same rule the ATTAINS binder and the Duke alert matcher use.
        self.assertEqual(M.name_agrees('Lake Robinson', 'Lake Wateree (Kershaw Co, SC)'), set())
        self.assertEqual(M.name_agrees('Big Creek', 'Little Creek (Aiken Co, SC)'), set())

    def test_a_real_name_agrees(self):
        self.assertIn('robinson',
                      M.name_agrees('Lake H.B. Robinson', 'Lake Robinson (Chesterfield Co, SC)'))
        self.assertIn('jocassee',
                      M.name_agrees('Lake Jocassee', 'Lake Jocassee (Oconee Co, SC)'))

    def test_the_two_lake_robinsons_both_agree_on_the_name(self):
        # WHICH IS WHY GEOMETRY IS NOT OPTIONAL. Both SC Lake Robinsons share `robinson`; only
        # one of them is 61 km from Sumter and only one of them the polygon overlaps. The name
        # gate cannot separate these two and is not asked to.
        a = M.name_agrees('Lake H.B. Robinson', 'Lake Robinson (Chesterfield Co, SC)')
        b = M.name_agrees('Lake H.B. Robinson', 'Lake Robinson (Greer) (Greenville Co, SC)')
        self.assertTrue(a and b)


def cw(x, y, d):
    """A clockwise ring -- how ArcGIS writes an EXTERIOR."""
    return [[x, y], [x, y + d], [x + d, y + d], [x + d, y], [x, y]]


def ccw(x, y, d):
    """A counter-clockwise ring -- how ArcGIS writes a HOLE."""
    return [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]


class TheRingShape(unittest.TestCase):
    """THE BUG THIS CLASS EXISTS FOR: the first version returned a FLAT list of rings.

    geomcore._shapely_geom() reads `p[0]` as the exterior and `p[1:]` as holes, so a flat list
    made `p[0]` a single coordinate pair, `len(p[0]) < 4` was true for every feature, and the
    binder reported "advisory polygon did not build" on all of them -- a total failure that
    looked like a data problem. Caught by driving the binder with a fixture before handing the
    script over, which is the only reason it was caught at all.
    """

    def test_a_clockwise_ring_is_one_polygon(self):
        self.assertEqual(len(M.arcgis_polygons({'rings': [cw(-80.2, 34.4, 0.1)]})), 1)

    def test_a_counter_clockwise_ring_after_it_is_a_hole_in_it(self):
        p = M.arcgis_polygons({'rings': [cw(-80.2, 34.4, 0.1), ccw(-80.18, 34.42, 0.02)]})
        self.assertEqual(len(p), 1)
        self.assertEqual(len(p[0]), 2, 'exterior plus one hole')

    def test_two_clockwise_rings_are_two_polygons(self):
        p = M.arcgis_polygons({'rings': [cw(-80.2, 34.4, 0.1), cw(-80.0, 34.4, 0.1)]})
        self.assertEqual(len(p), 2)

    def test_all_one_winding_still_returns_something(self):
        # A producer that ignores the convention must not silently cost us the water.
        p = M.arcgis_polygons({'rings': [ccw(-80.2, 34.4, 0.1), ccw(-80.18, 34.42, 0.02)]})
        self.assertEqual(len(p), 1)
        self.assertEqual(len(p[0][0]), 5, 'the largest ring is the exterior')

    def test_junk_geometry_is_empty_not_a_throw(self):
        for g in (None, {}, {'rings': []}, {'rings': [[[1, 2]]]}):
            self.assertEqual(M.arcgis_polygons(g), [])


class TheBinding(unittest.TestCase):
    """GEOMETRY IS WHAT SEPARATES THE TWO LAKE ROBINSONS. The name cannot."""

    def _run(self, advisory_ring):
        import json
        import os
        import tempfile
        try:
            import shapely  # noqa: F401
        except ImportError:
            self.skipTest('shapely not installed -- THE BINDER IS NOT BEING CHECKED')
        with tempfile.TemporaryDirectory() as td:
            bd = os.path.join(td, 'boundaries')
            os.makedirs(bd)
            for slug, x, y in (('lake_robinson', -80.2, 34.4),
                               ('lake_robinson_greer', -82.4, 34.9)):
                json.dump({'type': 'Feature', 'properties': {},
                           'geometry': {'type': 'Polygon', 'coordinates': [ccw(x, y, 0.1)]}},
                          open(os.path.join(bd, slug + '.geojson'), 'w'))
            index = {
                'lake_robinson': {'state': 'SC',
                                  'display_name': 'Lake Robinson (Chesterfield Co, SC)'},
                'lake_robinson_greer': {'state': 'SC',
                                        'display_name': 'Lake Robinson (Greer) (Greenville Co, SC)'},
                'lake_norman': {'state': 'NC', 'display_name': 'Lake Norman (Iredell Co, NC)'},
            }
            feats = [{'attributes': {
                'NAME': 'Lake H.B. Robinson', 'ADVISORY': 'Mercury', 'Basin': 'PeeDee',
                'TYPE': 'Lake/Pond',
                'Waterbody_URL': RAW_HTML},
                'geometry': {'rings': [advisory_ring]}}]
            return M.build({'2': feats, '3': []}, index, bd)

    def test_it_lands_on_the_lake_the_polygon_overlaps(self):
        out = self._run(cw(-80.19, 34.41, 0.05))
        self.assertEqual(list(out['waters']), ['lake_robinson'])
        rec = out['waters']['lake_robinson']
        self.assertEqual([s['species'] for s in rec['species']],
                         [e[0] for e in EXPECTED])
        self.assertEqual(rec['do_not_eat'], ['Bowfin (Mudfish)'])
        self.assertEqual(rec['advisories'][0]['confidence'], 'name+geom')
        self.assertEqual(rec['advisories'][0]['matched_on']['tokens'], ['robinson'])

    def test_a_polygon_over_neither_binds_to_neither(self):
        # Name alone would have matched both Robinsons. Geometry refuses.
        out = self._run(cw(-79.0, 33.0, 0.05))
        self.assertEqual(out['waters'], {})
        self.assertEqual(len(out['unbound']), 1)

    def test_the_record_says_it_is_a_floor_and_not_a_roster(self):
        out = self._run(cw(-80.19, 34.41, 0.05))
        self.assertIn('PRESENCE FLOOR', out['waters']['lake_robinson']['basis'])


# The roster the qualifier rule checks against, as species_traits.json supplies it.
ROSTER = M.load_roster(str(HERE.parent / 'registry')) or {
    'largemouthbass', 'stripedbass', 'bowfin', 'blackcrappie', 'channelcatfish',
    'bluecatfish', 'chainpickerel', 'warmouth', 'bluegill', 'redearsunfish',
}


class WhatTheFirstRunGotWrong(unittest.TestCase):
    """Ryan, reading the first output: "ummmm some of this looks to be misleading maybe".

    Every case here is a line off that run. He was right about all of them.
    """

    def test_a_bowfin_is_not_a_bass(self):
        # Lake Wateree publishes `Bass- Bowfin`. The state filed a bowfin under the bass
        # heading, and the inversion faithfully produced "Bowfin Bass" -- a fish that does not
        # exist -- and put it in the output. When the inverted form is not on the roster and the
        # qualifier alone IS, the qualifier is the fish.
        self.assertEqual(M.uninvert('Bass- Bowfin', ROSTER), 'Bowfin')
        self.assertEqual(M.uninvert('Bass- Largemouth', ROSTER), 'Largemouth Bass')
        self.assertEqual(M.uninvert('Catfish- Blue', ROSTER), 'Blue Catfish')

    def test_a_name_fragment_is_not_a_name(self):
        # The roster carries 'White Bass / Hybrid'. Split on the slash it puts a bare 'Hybrid'
        # into the known set, and `Bass- Striped/Hybrid` on Hartwell then came out as the
        # species "Hybrid". load_roster() does not split slashes for exactly this reason.
        self.assertNotIn('hybrid', ROSTER)
        self.assertEqual(M.species_names('Bass- Striped/Hybrid', ROSTER),
                         ['Striped Bass', 'Hybrid Bass'])

    def test_a_slash_is_two_fish(self):
        self.assertEqual(M.species_names('Bass- Largemouth', ROSTER), ['Largemouth Bass'])

    def test_all_other_fish_is_a_scope_not_a_fish(self):
        # Langley Pond ends with `All Other Fish`, Hartwell with `All Species of Fish`. Both
        # reached the first run's species lists.
        html = ('<strong>Bass- Largemouth</strong><ul><li>DO NOT EAT ANY</ul>'
                '<strong>All Other Fish</strong><ul><li>One meal per week</ul>')
        pairs, unparsed, notes = M.parse_restrictions(html, ROSTER)
        self.assertEqual([p['species'] for p in pairs], ['Largemouth Bass'])
        self.assertEqual(notes, ['All Other Fish: One meal per week'])
        self.assertEqual(unparsed, [])

    def test_a_size_qualifier_is_not_part_of_the_name(self):
        # Hartwell-GA publishes `Bass- Largemouth less than 16 inches`. Inverted whole that is
        # "Largemouth less than 16 inches Bass".
        html = ('<strong>Bass- Largemouth less than 16 inches</strong>'
                '<ul><li>One meal per week</ul>')
        pairs, _, _ = M.parse_restrictions(html, ROSTER)
        self.assertEqual(pairs[0]['species'], 'Largemouth Bass')
        self.assertEqual(pairs[0]['size'], 'less than 16 inches')
        self.assertEqual(pairs[0]['published_as'], 'Bass- Largemouth less than 16 inches')

    def test_no_advisory_is_a_cleared_water_not_a_parse_failure(self):
        # Eighteen waters carry ADVISORY 'No Advisory' and this body. The state sampled them and
        # found nothing to warn about. The first run printed "(no species parsed)" for each,
        # which reads as the parser breaking.
        pairs, unparsed, notes = M.parse_restrictions('<strong>No Restrictions</strong>', ROSTER)
        self.assertEqual(pairs, [])
        self.assertEqual(unparsed, [])
        self.assertEqual(notes, ['No Restrictions'])


class WhichWatersAnAdvisoryIsAbout(unittest.TestCase):
    """Ryan, looking at the map: "i can clearly see that the saluda river is both stretches".

    choose() used to return ONE water and call the rest ambiguous. An advisory reach can span
    several of our slugs, and the polygon already says which -- that is what the map draws.
    It also sorted on `overlap_frac_of_ours`, which is near useless: 23 of 60 clean matches sit
    under 1% of our water because a river boundary is long and an advisory is a buffer along
    part of it. `advisory_inside_ours` is the number that discriminates -- real matches measured
    5.5%-96.2%, incidental ones 0.0%.
    """

    def _h(self, slug, tokens, inside):
        return {'slug': slug, 'tokens': list(tokens),
                'overlap_frac_of_ours': 0.005, 'advisory_inside_ours': inside}

    def test_a_reach_that_spans_two_of_our_slugs_binds_to_both(self):
        idx = {'saluda_river_2': {'display_name': 'Saluda River (2) (Newberry Co, SC)'},
               'saluda_river_lower_saluda':
                   {'display_name': 'Saluda River (Lower Saluda) (Lexington Co, SC)'}}
        picks, why = choose_('Saluda River',
                             [self._h('saluda_river_2', ('saluda',), 0.604),
                              self._h('saluda_river_lower_saluda', ('saluda',), 0.329)], idx)
        self.assertEqual(sorted(p['slug'] for p in picks),
                         ['saluda_river_2', 'saluda_river_lower_saluda'])
        self.assertIn('covered', why)

    def test_a_candidate_the_advisory_barely_touches_is_not_a_candidate(self):
        # great_pee_dee_river shares `pee` and `dee` with "Little Pee Dee River" and 0.0% of
        # the polygon. wateree_lake does the same for "Wateree River".
        idx = {'little_pee_dee_river': {'display_name': 'Little Pee Dee River (Horry Co, SC)'},
               'great_pee_dee_river': {'display_name': 'Great Pee Dee River (Florence Co, SC)'}}
        picks, _ = choose_('Little Pee Dee River',
                           [self._h('little_pee_dee_river', ('pee', 'dee'), 0.467),
                            self._h('great_pee_dee_river', ('pee', 'dee'), 0.0)], idx)
        self.assertEqual([p['slug'] for p in picks], ['little_pee_dee_river'])

    def test_containment_is_not_identity(self):
        # Our Black River boundary contains 85% of the Black Mingo Creek advisory, because the
        # creek runs into it. The creek's name is the better one and takes it alone.
        idx = {'black_mingo_creek': {'display_name': 'Black Mingo Creek (Georgetown Co, SC)'},
               'black_river': {'display_name': 'Black River (Williamsburg Co, SC)'}}
        picks, why = choose_('Black Mingo Creek',
                             [self._h('black_mingo_creek', ('black', 'mingo'), 0.585),
                              self._h('black_river', ('black',), 0.851)], idx)
        self.assertEqual([p['slug'] for p in picks], ['black_mingo_creek'])
        self.assertEqual(why, 'most shared tokens')

    def test_a_more_specific_name_is_a_different_water(self):
        # "Broad River" is not the First Broad, and the county parenthetical is ours, not the
        # water's, so it is stripped before this is asked.
        idx = {'broad_river': {'display_name': 'Broad River (Cherokee Co, NC)'},
               'broad_river_2': {'display_name': 'Broad River (2) (Union Co, SC)'},
               'first_broad_river': {'display_name': 'First Broad River (Cleveland Co, NC)'}}
        picks, why = choose_('Broad River',
                             [self._h('broad_river', ('broad',), 0.285),
                              self._h('broad_river_2', ('broad',), 0.329),
                              self._h('first_broad_river', ('broad',), 0.147)], idx)
        self.assertEqual(sorted(p['slug'] for p in picks), ['broad_river', 'broad_river_2'])
        self.assertEqual(why, 'the others name a more specific water')

    def test_nothing_covered_is_nothing_bound(self):
        idx = {'a_lake': {'display_name': 'A Lake (X Co, SC)'}}
        picks, why = choose_('A Lake', [self._h('a_lake', ('alake',), 0.0)], idx)
        self.assertEqual(picks, [])
        self.assertIn('barely touches', why)


def choose_(name, hits, idx):
    return M.choose(name, hits, idx)


class TheTwoCorrectedRows(unittest.TestCase):
    """`Bass- Bowfin` on Lake Wateree is the map layer being wrong, and two other DES products
    say so: the live per-water page and the 2020 statewide table both list Black Crappie, Blue
    Catfish, Channel Catfish, Largemouth Bass, Striped Bass and WHITE BASS, with no bowfin at
    all. No reading of the string reaches that -- the heading says Bass, the qualifier says
    Bowfin, the fish is White Bass -- so it is a recorded correction carrying its evidence.
    """

    WATEREE = ('<strong>Bass- Largemouth</strong><ul><li>One meal per month</ul>'
               '<strong>Bass- Striped</strong><ul><li>One meal per month</ul>'
               '<strong>Bass- Bowfin</strong><ul><li>One meal per month</ul>'
               '<strong>Catfish- Blue</strong><ul><li>One meal per month</ul>'
               '<strong>Catfish- Channel</strong><ul><li>One meal per month</ul>'
               '<strong>Crappie- Black</strong><ul><li>One meal per week</ul>')

    def test_lake_wateree_reads_white_bass(self):
        pairs, _, _ = M.parse_restrictions(self.WATEREE, ROSTER, 'Lake Wateree')
        self.assertEqual([p['species'] for p in pairs],
                         ['Largemouth Bass', 'Striped Bass', 'White Bass',
                          'Blue Catfish', 'Channel Catfish', 'Black Crappie'])
        fixed = [p for p in pairs if p.get('corrected')]
        self.assertEqual(len(fixed), 1)
        self.assertIn('White Bass', fixed[0]['corrected'])
        self.assertEqual(fixed[0]['published_as'], 'Bass- Bowfin')

    def test_neither_bowfin_nor_bowfin_bass_survives(self):
        names = [p['species'] for p in M.parse_restrictions(self.WATEREE, ROSTER, 'Lake Wateree')[0]]
        self.assertNotIn('Bowfin', names)
        self.assertNotIn('Bowfin Bass', names)

    def test_a_correction_only_fires_on_the_row_it_was_checked_against(self):
        # Keyed on (water, published string). Another water publishing the same text has not
        # been checked and must not be silently rewritten.
        pairs, _, _ = M.parse_restrictions(
            '<strong>Bass- Bowfin</strong><ul><li>One meal per month</ul>', ROSTER, 'Some Creek')
        self.assertIsNone(pairs[0].get('corrected'))
        self.assertTrue(pairs[0].get('suspect'), 'an unchecked mismatch must still be flagged')

    def test_the_pumpkinseed_row_is_recorded_as_fine_not_as_a_fix(self):
        # A pumpkinseed IS a sunfish. Recorded so the only rows left flagged are NEW ones.
        pairs, _, _ = M.parse_restrictions(
            '<strong>Sunfish- Pumpkinseed</strong><ul><li>No Restrictions</ul>',
            ROSTER, 'Sampit River')
        self.assertEqual(pairs[0]['species'], 'Pumpkinseed')
        self.assertIn('IS a sunfish', pairs[0]['corrected'])

    def test_every_correction_carries_its_evidence_and_a_date(self):
        for key, fix in M.PUBLISHED_CORRECTIONS.items():
            self.assertTrue(fix.get('species'), key)
            self.assertTrue(fix.get('checked'), key)
            self.assertGreater(len(fix.get('why') or ''), 80,
                               '%s: a correction without its reasoning is a hand edit' % (key,))


if __name__ == '__main__':
    unittest.main(verbosity=2)
