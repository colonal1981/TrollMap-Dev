#!/usr/bin/env python3
"""
test_ga_fish_advisories.py -- the parser must read the shapes the book actually prints.

Personal use only, not for distribution or resale; not for navigation.

    py test_ga_fish_advisories.py

EVERY STRING BELOW IS VERBATIM FROM THE 2023 FCG BOOKLET, page numbers included. That is the
point: the first version of the South Carolina parser was written against a summarising reader's
rendering of the field rather than the bytes, and it would have failed on all 114 features. These
came out of pdfplumber reading the file on disk, so what is asserted here is what the parser will
actually be handed.

The four things that go wrong when a booklet is read as if it were a table:

    the heading is not one line     Georgia prints a river once and its reaches underneath
    the heading is not always above one table's ruling starts a line high and eats it
    the species column is not all species     the footnotes are printed inside it
    a name is not a name            'Bass Spp. *', 'Blue Catfish <32"', 'Redbreast & Green Sunfish'
"""

import importlib.util
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('ga', HERE / 'parse_ga_fish_advisories.py')
M = importlib.util.module_from_spec(spec)
sys.modules['ga'] = M
spec.loader.exec_module(M)


class TheHeading(unittest.TestCase):
    def test_the_basin_is_the_shortest_one_that_ends_the_line(self):
        # p17. The leftmost match is "Lake Ocmulgee River Basin", which leaves the water called
        # "Jackson" -- and Jackson binds to nothing while Jackson Lake is a water we ship.
        self.assertEqual(M.split_basin('Jackson Lake Ocmulgee River Basin'),
                         ('Jackson Lake', 'Ocmulgee River Basin'))
        self.assertEqual(M.split_basin('Savannah River (Fort Howard) Savannah River Basin'),
                         ('Savannah River (Fort Howard)', 'Savannah River Basin'))
        self.assertEqual(M.split_basin('Lake Mayers (City of Baxley) Altamaha River Basin'),
                         ('Lake Mayers (City of Baxley)', 'Altamaha River Basin'))

    def test_river_basin_alone_is_not_a_basin(self):
        # p40, the swallowed heading. Taking the rightmost match blindly gives "River Basin" and
        # leaves the water called "Tallulah River Savannah".
        self.assertEqual(M.split_basin('Tallulah River Savannah River Basin'),
                         ('Tallulah River', 'Savannah River Basin'))

    def test_a_basin_that_is_not_named_after_a_river(self):
        # p44. "St. Mary's Basin" has no River in it and the closing bracket case (p19) carries
        # text after the word Basin.
        self.assertEqual(M.split_basin("Cumberland Sound St. Mary's Basin"),
                         ('Cumberland Sound', "St. Mary's Basin"))
        self.assertEqual(
            M.split_basin('Lake Seminole Chattahoochee/Flint River Basin (Apalachicola)'),
            ('Lake Seminole', 'Chattahoochee/Flint River Basin (Apalachicola)'))

    def test_no_basin_is_not_a_failure(self):
        self.assertEqual(M.split_basin('Wassaw Sound'), ('Wassaw Sound', None))
        self.assertEqual(M.split_basin(''), ('', None))

    def test_the_first_bold_line_names_the_water_and_the_rest_is_the_reach(self):
        # p27. Reading one line gets "(Buford Dam to Morgan Falls Dam)", which names no water.
        self.assertEqual(M.water_and_reach(['Chattahoochee River',
                                            '(Buford Dam to Morgan Falls Dam)']),
                         ('Chattahoochee River', '(Buford Dam to Morgan Falls Dam)'))

    def test_a_colon_subtitle_belongs_to_the_reach(self):
        # p16 and p30. "Lake Hartwell: Tugaloo Arm" is Hartwell; "Coosa River: Special Striped
        # Bass" is the Coosa. Left joined, neither binds.
        self.assertEqual(M.water_and_reach(['Lake Hartwell: Tugaloo Arm']),
                         ('Lake Hartwell', 'Tugaloo Arm'))
        self.assertEqual(
            M.water_and_reach(['Coosa River: Special Striped Bass',
                               '(River mile Zero in Rome to Stateline/Lake Weiss)']),
            ('Coosa River',
             'Special Striped Bass (River mile Zero in Rome to Stateline/Lake Weiss)'))

    def test_the_lake_hartwell_main_body_heading(self):
        # p16, and it matters more than any other heading in the book: this is the table that
        # says DO NOT EAT to striped and hybrid bass in all three size classes.
        self.assertEqual(
            M.water_and_reach(['Lake Hartwell:', 'Main Body, D.S. Andersonville IS. GA/SC Listing']),
            ('Lake Hartwell', 'Main Body, D.S. Andersonville IS. GA/SC Listing'))


class TheSpeciesColumn(unittest.TestCase):
    def test_a_size_qualifier_is_not_part_of_the_name(self):
        # p30, p33, p38, p40. "1 meal/month on a striped bass over 26 inches" is not a statement
        # about every striped bass in the river, and 'Striped Bass 26" and greater in length' is
        # not a fish.
        self.assertEqual(M.clean_species('Blue Catfish <32”'), (['Blue Catfish'], '<32”'))
        self.assertEqual(M.clean_species('Flathead Catfish 16-30”'),
                         (['Flathead Catfish'], '16-30”'))
        self.assertEqual(M.clean_species('Striped Bass 26” and greater in length'),
                         (['Striped Bass'], '26” and greater in length'))
        self.assertEqual(M.clean_species('Striped Bass >22"'), (['Striped Bass'], '>22"'))

    def test_a_footnote_marker_comes_off_either_end(self):
        # p14, p20, p33. The same fish appears as three different strings across the book.
        for published in ('Largemouth Bass*', 'Largemouth Bass *', 'Largemouth Bass'):
            self.assertEqual(M.clean_species(published), (['Largemouth Bass'], None))

    def test_spp_is_a_plural_marker_and_not_a_name(self):
        # Twenty rows say "Catfish Spp." for the group SC writes as "Catfish (all species)".
        self.assertEqual(M.clean_species('Catfish Spp.'), (['Catfish'], None))
        self.assertEqual(M.clean_species('Sunfish Spp.'), (['Sunfish'], None))
        self.assertEqual(M.clean_species('Bass Spp. *'), (['Bass'], None))

    def test_an_ampersand_shares_the_group_word_with_both_halves(self):
        # p29 Proctor Creek, and p16 Hartwell's Tugaloo Arm. Left joined these are one fish each,
        # and neither of the two is a fish that exists.
        self.assertEqual(M.clean_species('Redbreast & Green Sunfish'),
                         (['Redbreast Sunfish', 'Green Sunfish'], None))
        self.assertEqual(M.clean_species('Yellow & Brown Bullhead'),
                         (['Yellow Bullhead', 'Brown Bullhead'], None))
        self.assertEqual(M.clean_species('Hybrid & Striped Bass'),
                         (['Hybrid Bass', 'Striped Bass'], None))

    def test_the_book_naming_the_members_of_its_own_group(self):
        # p27, the Chattahoochee striped bass special advisory.
        self.assertEqual(
            M.clean_species('Black Bass Sp. (Largemouth, Smallmouth, Shoal, Spotted)'),
            (['Largemouth Bass', 'Smallmouth Bass', 'Shoal Bass', 'Spotted Bass'], None))

    def test_a_comma_list_of_single_words_is_a_list(self):
        # p45 through p48, on eight estuary tables, every one of them a DO NOT EAT.
        self.assertEqual(M.clean_species('Clams, Mussels, Oysters'),
                         (['Clams', 'Mussels', 'Oysters'], None))

    def test_a_parenthetical_that_is_not_a_list_is_left_alone(self):
        # p41, Okefenokee. 'Flier (sunfish)' is one fish with its group named after it.
        self.assertEqual(M.clean_species('Flier (sunfish)'), (['Flier (sunfish)'], None))

    def test_the_footnotes_the_book_prints_inside_the_species_column(self):
        # THE WHOLE REASON is_prose EXISTS. Every one of these arrived in cell zero of a row.
        for line in (
            '*Only Largemouth Bass greater than 14 inches may be kept.',
            '* Only Largemouth Bass greater than 14 inches may be kept.',
            '*See also “Coosa River: Special Striped Bass”',
            '*Bass: Largemouth & Shoal',
            'NOTE: One population of striped bass migrates annually between West Point Lake '
            'and Morgan Falls Dam. Sampled population represents this stretch of river and lake.',
            'Main Body. Guidance issued with South Carolina DHEC '
            '(https//scdhec.gov/lake-Hartwell-fish-consumption-advisory)',
            'Specific consumption guidelines have not been issued for the radionuclides '
            'cesium-137 & strontium-90, in the Savannah River (Burke/Screven Counties), adjacent '
            'to the Savannah River Site (SRS).',
        ):
            self.assertTrue(M.is_prose(line), line[:40])

    def test_a_fish_is_not_prose(self):
        for line in ('Largemouth Bass', 'Largemouth Bass *', 'Bass Spp. *',
                     'Clams, Mussels, Oysters', 'Striped Bass 26” and greater in length',
                     'Black Bass Sp. (Largemouth, Smallmouth, Shoal, Spotted)'):
            self.assertFalse(M.is_prose(line), line[:40])


class TheTruncationsTheBookPrints(unittest.TestCase):
    def test_stripped_bass_is_corrected_only_on_the_row_it_was_checked_against(self):
        fix = M.correction_for('Lake Allatoona', 'Stripped Bass')
        self.assertEqual(fix['species'], ['Striped Bass'])
        self.assertIsNone(M.correction_for('Lake Burton', 'Stripped Bass'))
        self.assertIsNone(M.correction_for('Lake Allatoona', 'Striped Bass'))

    def test_hartwells_hybrid_strip_bass_becomes_two_fish(self):
        # It is the strongest warning in the book about a fish Ryan targets, and left as
        # published it is a species called "Hybrid Strip Bass" that nothing can match.
        fix = M.correction_for('Lake Hartwell', 'Hybrid/Strip Bass')
        self.assertEqual(fix['species'], ['Hybrid Bass', 'Striped Bass'])


class TheCounties(unittest.TestCase):
    def test_a_slash_names_two_counties_and_used_to_lose_one(self):
        self.assertEqual(M.counties_in('Ocmulgee River (Butts/Monroe Counties)'),
                         {'butts', 'monroe'})
        self.assertEqual(M.counties_in('South River (DeKalb/Rockdale County)'),
                         {'dekalb', 'rockdale'})
        self.assertEqual(M.counties_in('Mud Creek (Near Lula, Hall County)'), {'hall'})
        self.assertEqual(M.counties_in('Wassaw Sound'), set())

    def test_our_stamp_writes_co_where_the_book_writes_county(self):
        self.assertEqual(M.our_counties('Mud Creek (Hall Co, GA)'), {'hall'})
        self.assertEqual(M.our_counties('Hartwell Lake (Anderson Co, SC/GA)'), {'anderson'})
        self.assertEqual(M.our_counties('Lake Robinson (Greer) (Greenville Co, SC)'),
                         {'greenville'})

    def test_the_county_stamp_is_not_part_of_the_name(self):
        # Leaving it in made the COUNTY a name token: the book's "Evans County PFA" then agreed
        # with Sands Pond and Glissons Millpond, two unrelated waters that sit in Evans County.
        self.assertEqual(M.our_name('Sands Pond (Evans Co, GA)'), 'Sands Pond')
        self.assertEqual(M.our_name('Hartwell Lake (Anderson Co, SC/GA)'), 'Hartwell Lake')
        self.assertEqual(M.our_name('Lake Robinson (Greer) (Greenville Co, SC)'),
                         'Lake Robinson (Greer)')


class TheNameGate(unittest.TestCase):
    def test_a_generic_word_is_not_agreement(self):
        self.assertEqual(M.name_agrees('Lake Robinson', 'Lake Wateree (Kershaw Co, SC)'), set())
        self.assertEqual(M.name_agrees('Big Creek', 'Little Creek (Aiken Co, SC)'), set())
        self.assertEqual(M.name_agrees('Hamburg Millpond', 'Keas Old Millpond'), set())

    def test_a_place_parenthetical_is_not_a_name(self):
        # 'Mud Creek (Near Powder Springs, Cobb County)' agreed with two unrelated waters on the
        # word `springs`, which is the book saying where it tested and not what it tested.
        self.assertEqual(M.name_for_tokens('Mud Creek (Near Powder Springs, Cobb County)'),
                         'Mud Creek')
        self.assertEqual(M.name_for_tokens('Ocmulgee River (Butts/Monroe Counties)'),
                         'Ocmulgee River')

    def test_a_parenthetical_that_names_another_water_stays(self):
        self.assertEqual(M.name_for_tokens('Black Shoals Lake (Randy Poynter Lake)'),
                         'Black Shoals Lake (Randy Poynter Lake)')
        self.assertEqual(M.name_for_tokens('Paradise PFA (Lake Bobben)'),
                         'Paradise PFA (Lake Bobben)')


class TheKindOfWater(unittest.TestCase):
    def test_a_river_advisory_is_not_about_a_lake(self):
        # 'Ocmulgee River (Wilcox/Dodge/Ben Hill/Telfair Counties)' reached Little Ocmulgee Lake,
        # 60 km away, because the river also runs through Telfair County.
        self.assertEqual(M.primary_kind('Ocmulgee River'), 'flowing')
        self.assertEqual(M.primary_kind('Little Ocmulgee State Park Lake (Gum Creek Swamp)'),
                         'still')
        self.assertEqual(M.primary_kind('Altamaha Sound'), 'coastal')

    def test_the_registry_answers_before_the_words_do(self):
        # `coast_savannah_ga` is called "Savannah River / Savannah, GA". Reading the words makes
        # the Savannah ESTUARY advisory conflict with the only zone it could be about.
        self.assertEqual(M.water_kinds({'feature_type': 'coastal'}, 'Savannah River / Savannah, GA'),
                         {'coastal'})
        self.assertEqual(M.water_kinds({'feature_type': 'river'}, 'Ocmulgee River'), {'flowing'})
        self.assertEqual(M.water_kinds({}, 'Sapelo Sound / Altamaha River'),
                         {'coastal', 'flowing'})


INDEX = {
    'ocmulgee_river': {'display_name': 'Ocmulgee River (Twiggs Co, GA)', 'state': 'GA',
                       'feature_type': 'river'},
    'little_ocmulgee_lake': {'display_name': 'Little Ocmulgee Lake (Telfair Co, GA)',
                             'state': 'GA', 'feature_type': 'lake'},
    'chattahoochee_river': {'display_name': 'Chattahoochee River (Fulton Co, GA)', 'state': 'GA',
                            'feature_type': 'river'},
    'chattahoochee_river_4': {'display_name': 'Chattahoochee River (4) (White Co, GA)',
                              'state': 'GA', 'feature_type': 'river'},
    'hartwell_lake': {'display_name': 'Hartwell Lake (Anderson Co, SC/GA)', 'state': 'SC',
                      'feature_type': 'lake'},
    'lake_wateree': {'display_name': 'Lake Wateree (Kershaw Co, SC)', 'state': 'SC',
                     'feature_type': 'lake'},
    'lake_paradise_2': {'display_name': 'Lake Paradise (Berrien Co, GA)', 'state': 'GA',
                        'feature_type': 'lake'},
    'lake_bobben': {'display_name': 'Lake Bobben (Berrien Co, GA)', 'state': 'GA',
                    'feature_type': 'lake'},
    'tugaloo_lake': {'display_name': 'Tugaloo Lake (Rabun Co, SC/GA)', 'state': 'SC',
                     'feature_type': 'lake'},
}


class TheBinder(unittest.TestCase):
    def setUp(self):
        self.c = M.ga_waters(INDEX)

    def test_a_border_water_is_a_candidate_even_though_its_state_says_sc(self):
        # The hole that lost Lake Wylie and J. Strom Thurmond on the first South Carolina run.
        self.assertIn('hartwell_lake', self.c)
        self.assertIn('tugaloo_lake', self.c)
        self.assertNotIn('lake_wateree', self.c)

    def test_the_river_binds_to_the_river_and_not_to_the_lake_that_shares_its_name(self):
        hits, why = M.bind('Ocmulgee River (Wilcox/Dodge/Ben Hill/Telfair Counties)', '', self.c)
        self.assertEqual([h['slug'] for h in hits], ['ocmulgee_river'])

    def test_and_the_lake_binds_to_the_lake(self):
        hits, why = M.bind('Little Ocmulgee State Park Lake (Gum Creek Swamp)', '', self.c)
        self.assertEqual([h['slug'] for h in hits], ['little_ocmulgee_lake'])

    def test_ONE_RIVER_IN_TWO_PIECES_BINDS_TO_BOTH(self):
        # Ryan settled this on the South Carolina run, looking at the map: "i can clearly see
        # that the saluda river is both stretches." The app ships the Chattahoochee as two
        # segments and the book advises it a reach at a time.
        hits, why = M.bind('Chattahoochee River', '(Buford Dam to Morgan Falls Dam)', self.c)
        self.assertEqual(sorted(h['slug'] for h in hits),
                         ['chattahoochee_river', 'chattahoochee_river_4'])
        self.assertIn('pieces', why)

    def test_the_parenthetical_names_the_pond_and_the_head_names_the_area(self):
        hits, why = M.bind('Paradise PFA (Lake Bobben)', '', self.c)
        self.assertEqual([h['slug'] for h in hits], ['lake_bobben'])

    def test_AMBIGUITY_IS_FLAGGED_AND_NEVER_GUESSED(self):
        # Ryan: "if there is ambiguity flag it and then i will look at it." Two ponds in the same
        # fishing area, and the book's heading names neither of them on its own.
        hits, why = M.bind('Paradise PFA', '', dict(
            self.c, lake_patrick={'display_name': 'Lake Patrick (Berrien Co, GA)',
                                  'state': 'GA', 'feature_type': 'lake'}))
        self.assertEqual([h['slug'] for h in hits], ['lake_paradise_2'])
        hits, why = M.bind('Little Ocmulgee', '', dict(
            self.c, little_ocmulgee_pond={'display_name': 'Little Ocmulgee Pond (Wheeler Co, GA)',
                                          'state': 'GA', 'feature_type': 'lake'}))
        self.assertEqual(hits, [])
        self.assertIn('more than one', why)

    def test_a_pfa_pond_does_not_reach_the_lake_that_shares_the_basin_name(self):
        # 'Ocmulgee PFA Lake' is in Bleckley County; Little Ocmulgee Lake is 60 km away in
        # Telfair. They agree on the river both are named after and on nothing else.
        hits, why = M.bind('Ocmulgee PFA Lake', '', self.c)
        self.assertEqual(hits, [])
        self.assertIn('little', why)

    def test_a_binding_checked_by_hand_and_refused_stays_refused(self):
        # Goat Rock Lake is on the Chattahoochee below Columbus; Rock Eagle Lake is a 4-H lake in
        # Putnam County with its own table. They share the word "rock".
        c = dict(self.c, rock_eagle_lake={'display_name': 'Rock Eagle Lake (Putnam Co, GA)',
                                          'state': 'GA', 'feature_type': 'lake'})
        hits, why = M.bind('Goat Rock Lake', '', c)
        self.assertEqual(hits, [])
        self.assertIn('checked by hand', why)
        # and it still binds from its own heading
        hits, _ = M.bind('Rock Eagle Lake', '', c)
        self.assertEqual([h['slug'] for h in hits], ['rock_eagle_lake'])

    def test_nothing_matching_says_so_differently_from_ambiguity(self):
        hits, why = M.bind('Ebenezer Creek', '', self.c)
        self.assertEqual(hits, [])
        self.assertNotIn('more than one', why)

    def test_a_kind_rejection_says_it_was_a_kind_rejection(self):
        # Otherwise "no water shares a distinctive name token" is printed about a water whose
        # name matched three times, which is a misleading review file.
        hits, why = M.bind('Ocmulgee Sound', '', self.c)
        self.assertEqual(hits, [])
        self.assertIn('coastal', why)


class TheNamesTheIndexAlreadyKnew(unittest.TestCase):
    """The alias list on our own rows, which the binder used to throw away.

    Ryan, on the two waters the first run reported as spelled one letter differently: *"search up
    the alternate spellings... if they resolve to real lakes with those incorrect spellings then
    we will leave them out... if those alternate lakes do not exist in georgia then we include
    them."* Neither does. The proof was already on disk in `legacy_display_names`, one GNIS id
    each, and no alias string in the 99 Georgia-associated rows names two different slugs.
    """

    TUGALOO = {'display_name': 'Tugaloo Lake (Rabun Co, SC/GA)', 'name': 'Tugaloo Lake',
               'state': 'SC', 'feature_type': 'lake',
               'legacy_display_names': ['Tugaloo Lake, SC/GA', 'Tugalo', 'Tugalo Lake',
                                        'Chattooga River - Lake Tugalo', 'Lake Tugalo, SC/GA']}
    VARNER = {'display_name': 'Lower Williams Lake (Newton Co, GA)', 'state': 'GA',
              'feature_type': 'lake',
              'legacy_display_names': ['Cornish Creek - Lake Varner', 'Lake Varner, GA']}

    def test_the_water_chain_prefix_and_the_state_suffix_come_off(self):
        # "Little Ogeechee River - Hamburg Mill Pond West" would otherwise make that pond a
        # candidate for every Ogeechee River advisory in the book.
        self.assertEqual(
            M.our_names({'display_name': 'Hamburgh Millpond (Washington Co, GA)',
                         'legacy_display_names': ['Little Ogeechee River - Hamburg Mill Pond West',
                                                  'Hamburgh Millpond, GA']}),
            ['Hamburgh Millpond', 'Hamburg Mill Pond West'])

    def test_lake_tugalo_is_tugaloo_lake(self):
        hits, why = M.bind('Lake Tugalo', '', {'tugaloo_lake': self.TUGALOO})
        self.assertEqual([h['slug'] for h in hits], ['tugaloo_lake'])
        self.assertEqual(why, 'the name matches exactly')

    def test_lake_varner_is_lower_williams_lake(self):
        hits, _ = M.bind('Lake Varner (Cornish Creek Reservoir, Newton County)', '',
                         {'lower_williams_lake': self.VARNER})
        self.assertEqual([h['slug'] for h in hits], ['lower_williams_lake'])

    def test_an_alias_still_has_to_agree_on_the_qualifier(self):
        # The gate that keeps the North Oconee off the Oconee is not weakened by reading aliases.
        hits, why = M.bind('Ocmulgee River', '', {'x': {
            'display_name': 'Little Ocmulgee River (Wheeler Co, GA)', 'state': 'GA',
            'feature_type': 'river',
            'legacy_display_names': ['Little Ocmulgee Creek']}})
        self.assertEqual(hits, [])
        self.assertIn('north/south/little/upper', why)

    def test_a_binding_checked_by_hand_and_accepted_is_taken(self):
        hits, _ = M.bind('Hamburg Millpond (Hamburg State Park)', '', {'hamburgh_millpond': {
            'display_name': 'Hamburgh Millpond (Washington Co, GA)', 'state': 'GA',
            'feature_type': 'lake'}})
        self.assertEqual([h['slug'] for h in hits], ['hamburgh_millpond'])
        self.assertTrue(M.binding_accepted('Hamburg Millpond (Hamburg State Park)',
                                           'hamburgh_millpond')['why'])
        self.assertIsNone(M.binding_accepted('Hamburg Millpond (Hamburg State Park)', 'seed_lake'))


class TheSpellingReport(unittest.TestCase):
    def test_one_letter_and_a_swapped_word_is_reported_not_bound(self):
        # The book writes "Lake Tugalo" and we ship "Tugaloo Lake". Nothing binds on this.
        self.assertEqual(M.near_spellings('Lake Tugalo', M.ga_waters(INDEX)),
                         ['Tugaloo Lake (Rabun Co, SC/GA)'])

    def test_a_water_that_is_simply_not_ours_is_not_reported(self):
        self.assertEqual(M.near_spellings('Lake Allatoona', M.ga_waters(INDEX)), [])

    def test_the_comparison_itself(self):
        self.assertTrue(M.one_letter_apart('hamburg', 'hamburgh'))
        self.assertTrue(M.one_letter_apart('tugalo', 'tugaloo'))
        self.assertFalse(M.one_letter_apart('burton', 'burton'))
        self.assertFalse(M.one_letter_apart('oconee', 'ocmulgee'))


class TheRows(unittest.TestCase):
    LAKE = {'page': 16, 'shape': 'lake',
            'header': ['Species', 'Less than 12"', '12" - 16"', 'Over 16"', 'Chemical'],
            'names': ['Lake Hartwell:', 'Main Body'], 'basin': 'Savannah River Basin',
            'rows': [['Hybrid/Strip Bass', 'Do Not Eat', 'Do Not Eat', 'Do Not Eat', 'PCBs'],
                     ['Largemouth Bass', '1 meal/month', '', '1 meal/month', 'PCBs'],
                     ['Main Body. Guidance issued with South Carolina DHEC '
                      '(https//scdhec.gov/lake-Hartwell-fish-consumption-advisory)',
                      '', '', '', '']]}

    STREAM = {'page': 33, 'shape': 'stream',
              'header': ['Species', 'Site Tested', 'Recommendation', 'Chemical'],
              'names': ['Patsiliga Creek (Downstream of Beaver Creek)'],
              'basin': 'Flint River Basin',
              'rows': [['Bass Spp. *', 'Taylor County', '1 meal/month', 'Mercury'],
                       ['*Bass: Largemouth & Shoal', '', '', '']]}

    def test_a_size_class_row_becomes_one_record_per_class_that_carries_advice(self):
        species, notes, unread = M.parse_block(self.LAKE, 'Lake Hartwell')
        lmb = [s for s in species if s['species'] == 'Largemouth Bass']
        self.assertEqual([s['size'] for s in lmb], ['Less than 12"', 'Over 16"'])
        self.assertEqual(unread, [])

    def test_the_correction_fires_and_says_so_on_every_record_it_made(self):
        species, _, _ = M.parse_block(self.LAKE, 'Lake Hartwell')
        striped = [s for s in species if s['species'] == 'Striped Bass']
        self.assertEqual(len(striped), 3)                 # one per size class
        self.assertTrue(all(s['corrected'] for s in striped))
        self.assertTrue(all(M.do_not_eat(s['advice']) for s in striped))

    def test_the_guidance_sentence_is_a_note_and_not_a_fish(self):
        _, notes, _ = M.parse_block(self.LAKE, 'Lake Hartwell')
        self.assertEqual(len(notes), 1)
        self.assertIn('South Carolina DHEC', notes[0])

    def test_a_stream_row_keeps_the_site_the_state_tested(self):
        species, notes, unread = M.parse_block(self.STREAM, 'Patsiliga Creek')
        self.assertEqual([(s['species'], s['site']) for s in species],
                         [('Bass', 'Taylor County')])
        self.assertEqual(species[0]['chemical'], 'Mercury')
        self.assertEqual(unread, [])

    def test_the_footnote_that_defines_the_group_is_kept_as_a_note(self):
        _, notes, _ = M.parse_block(self.STREAM, 'Patsiliga Creek')
        self.assertEqual(notes, ['*Bass: Largemouth & Shoal'])

    def test_a_table_whose_shape_is_unknown_reports_its_rows_rather_than_dropping_them(self):
        block = {'page': 49, 'shape': None, 'header': ['Size Range (Fork Length = FL)',
                                                       'Recommendation'],
                 'names': ['King Mackerel'], 'basin': None,
                 'rows': [['24 to 33 inches', 'No Restrictions']]}
        species, notes, unread = M.parse_block(block, 'King Mackerel')
        self.assertEqual(species, [])
        self.assertEqual(unread, ['24 to 33 inches'])

    def test_a_scope_is_not_a_fish(self):
        block = dict(self.STREAM, rows=[['All Other Fish', 'Ga. Hwy 1', 'No Restrictions', '']])
        species, notes, _ = M.parse_block(block, 'Patsiliga Creek')
        self.assertEqual(species, [])
        self.assertEqual(notes, ['All Other Fish: No Restrictions'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
