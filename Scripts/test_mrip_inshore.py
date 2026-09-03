#!/usr/bin/env python3
"""
test_mrip_inshore.py -- the rule must reproduce the roster a person already validated.

Personal use only, not for distribution or resale; not for navigation.

SC_INSHORE_ROSTER is five species Ryan named off SCDNR's own snapshots, and it is the only
known-good answer this project has. A rule that cannot return it has no business producing
Georgia's, which nobody can check by eye.

So there are two layers here:

  the RULE      driven with fixtures. Caught and managed is a target; caught and unmanaged is
                bycatch; managed and never seen is reported; a genus row is neither.
  the ANSWER    read off registry/mrip_inshore.json when it has been built, and asserted to
                contain all five. Skipped when the file is absent, because a unit test must not
                need 100 MB of survey CSVs to run -- but NOT silently: it says it skipped.

    py test_mrip_inshore.py
"""

import json
import os
import sys
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_mrip_inshore as M  # noqa: E402

# The five Ryan named. The calibration target.
SC_FLOOR = ['RED DRUM', 'SPOTTED SEATROUT', 'SOUTHERN FLOUNDER', 'BLACK DRUM', 'SHEEPSHEAD']


def managed(*names):
    """A book's species set, expanded the way managed_species() expands it."""
    out = set()
    for n in names:
        for alt in M.species_alternates(n):
            k = M.norm_species(alt)
            if len(k) > 3:
                out.add(k)
    return out


class TheRule(unittest.TestCase):
    def test_caught_and_managed_is_a_target(self):
        counts = Counter({'RED DRUM': 900})
        roster, bycatch, _ = M.build_roster(counts, managed('Red Drum'))
        self.assertEqual([r['name'] for r in roster], ['RED DRUM'])
        self.assertEqual(bycatch, [])

    def test_caught_and_unmanaged_is_bycatch_not_a_target(self):
        # A toadfish is a real catch and is not a plan. It IS named to species, so it is
        # reported as bycatch rather than dropped -- an angler who keeps hooking them is being
        # told something about the bottom.
        counts = Counter({'OYSTER TOADFISH': 1293})
        roster, bycatch, _ = M.build_roster(counts, managed('Red Drum'))
        self.assertEqual(roster, [])
        self.assertEqual([b['name'] for b in bycatch], ['OYSTER TOADFISH'])

    def test_a_family_row_is_dropped_from_both_piles_not_called_bycatch(self):
        # 'STINGRAY FAMILY' is 1,536 intercepts in Georgia and it is not a fish, it is a shrug.
        # Reporting it as bycatch would be reporting an unidentified row as a finding.
        counts = Counter({'STINGRAY FAMILY': 1536})
        roster, bycatch, _ = M.build_roster(counts, managed('Red Drum'))
        self.assertEqual(roster, [])
        self.assertEqual(bycatch, [])

    def test_bycatch_below_the_floor_is_not_reported_as_a_pattern(self):
        counts = Counter({'RARE THING': 3})
        _, bycatch, _ = M.build_roster(counts, set(), min_intercepts=50)
        self.assertEqual(bycatch, [])

    def test_a_managed_species_never_seen_inland_is_reported(self):
        # Usually offshore. Worth seeing rather than silently absent.
        counts = Counter({'RED DRUM': 900})
        _, _, unseen = M.build_roster(counts, managed('Red Drum', 'Blue Marlin'))
        self.assertTrue(any('marlin' in u for u in unseen))

    def test_a_genus_row_is_neither_a_target_nor_bycatch(self):
        # LEFTEYE FLOUNDER GENUS is a real flounder nobody identified. Counting it as a species
        # would put it third on South Carolina's list.
        for name in ('LEFTEYE FLOUNDER GENUS', 'UNIDENTIFIED SHARKS',
                     'STINGRAY FAMILY', 'OTHER FISH'):
            self.assertTrue(M.is_unidentified(name), name)
        counts = Counter({'LEFTEYE FLOUNDER GENUS': 3913})
        roster, bycatch, _ = M.build_roster(counts, managed('Southern Flounder'))
        self.assertEqual(roster, [])
        self.assertEqual(bycatch, [])

    def test_the_roster_is_ranked_by_how_often_it_was_actually_caught(self):
        counts = Counter({'SHEEPSHEAD': 100, 'RED DRUM': 900, 'BLACK DRUM': 500})
        roster, _, _ = M.build_roster(
            counts, managed('Red Drum', 'Black Drum', 'Sheepshead'))
        self.assertEqual([r['name'] for r in roster],
                         ['RED DRUM', 'BLACK DRUM', 'SHEEPSHEAD'])


class Names(unittest.TestCase):
    def test_a_book_that_writes_the_aliases_inline_still_matches(self):
        # THE BUG THREE STATES SIDE BY SIDE FOUND. Georgia's book says
        # 'Red drum (Channel bass, Spottail bass, Redfish)**B' and maps it to
        # 'Red Drum (Redfish)'. Normalised whole that is `reddrumredfish`, which never meets
        # MRIP's `reddrum` -- so RED DRUM came out as bycatch IN GEORGIA. South Carolina hid it
        # because its book writes plain 'Red Drum'.
        counts = Counter({'RED DRUM': 4866})
        roster, bycatch, _ = M.build_roster(counts, managed('Red Drum (Redfish)'))
        self.assertEqual([r['name'] for r in roster], ['RED DRUM'])
        self.assertEqual(bycatch, [])

    def test_the_bracketed_half_matches_too(self):
        counts = Counter({'REDFISH': 10})
        roster, _, _ = M.build_roster(counts, managed('Red Drum (Redfish)'))
        self.assertEqual([r['name'] for r in roster], ['REDFISH'])

    def test_whiting_and_southern_kingfish_are_one_fish(self):
        counts = Counter({'SOUTHERN KINGFISH': 1058})
        roster, _, _ = M.build_roster(counts, managed('Whiting (Southern Kingfish)'))
        self.assertEqual([r['name'] for r in roster], ['SOUTHERN KINGFISH'])

    def test_a_short_fragment_cannot_match_by_accident(self):
        # 'Bass' as a book row must not make every fish with those letters a target.
        counts = Counter({'BONNETHEAD': 1954})
        roster, bycatch, _ = M.build_roster(counts, managed('Bass'))
        self.assertEqual(roster, [])
        self.assertEqual([b['name'] for b in bycatch], ['BONNETHEAD'])


class TheAnswer(unittest.TestCase):
    """Calibration against the roster a person validated. Skipped, loudly, when unbuilt."""

    @classmethod
    def setUpClass(cls):
        cls.path = None
        d = Path(__file__).resolve().parent
        for _ in range(4):
            p = d / 'registry' / 'mrip_inshore.json'
            if p.exists():
                cls.path = p
                break
            d = d.parent
        cls.data = json.loads(cls.path.read_text(encoding='utf-8')) if cls.path else None

    def test_south_carolina_returns_the_five_that_were_validated_by_hand(self):
        if not self.data:
            self.skipTest('registry/mrip_inshore.json not built -- run build_mrip_inshore.py. '
                          'THE CALIBRATION IS NOT BEING CHECKED.')
        roster = self.data['states']['SC']['roster']
        missing = [s for s in SC_FLOOR if s not in roster]
        self.assertEqual(missing, [], f'the rule lost {missing} from a roster Ryan validated')

    def test_georgia_returns_the_same_five(self):
        if not self.data:
            self.skipTest('registry/mrip_inshore.json not built')
        roster = self.data['states']['GA']['roster']
        missing = [s for s in SC_FLOOR if s not in roster]
        self.assertEqual(missing, [], f'Georgia is missing {missing}')

    def test_an_unsampled_wave_is_not_a_zero(self):
        if not self.data:
            self.skipTest('registry/mrip_inshore.json not built')
        sc = self.data['states']['SC']
        first = sc['species'][sc['roster'][0]]
        self.assertEqual(first['byWave']['1'], {'sampled': False},
                         'MRIP does not sample Jan-Feb in SC; a 0 there is a claim nobody made')

    def test_every_roster_species_carries_its_seasons(self):
        if not self.data:
            self.skipTest('registry/mrip_inshore.json not built')
        for st, rec in self.data['states'].items():
            for name in rec['roster']:
                self.assertIn('byWave', rec['species'][name], f'{st} {name}')
                self.assertEqual(len(rec['species'][name]['byWave']), 6, f'{st} {name}')


if __name__ == '__main__':
    unittest.main(verbosity=2)
