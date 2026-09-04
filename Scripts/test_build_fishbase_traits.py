#!/usr/bin/env python3
r"""test_build_fishbase_traits.py -- run it with `py .\scripts\test_build_fishbase_traits.py`.

The page text in these fixtures is VERBATIM from fishbase.se, read on 2026-09-04 for Micropterus
salmoides, Dorosoma petenense and Etheostoma olmstedi. What is synthetic is only the table soup
around it -- label in one <td>, value in the next, across a </tr><tr> boundary -- because that
soup is exactly what parse() has to bridge and a fixture that put the label and its value in one
string would test nothing.
"""
import csv
import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_fishbase_traits as FB


def page(title, classif, env, size, trophic, biology='', extra=''):
    """A FishBase summary page's shape: cells, entities, and a <script> to be thrown away."""
    return f"""<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<title>{title}</title></head><body>
<script>var junk = "Trophic level (Ref. 9) 9.9 se; based on lies."; </script>
<div class="sheader2">Classification / Names</div>
<span>Actinopterygii (ray-finned fishes) &gt; {classif}</span>
<div class="sheader2">Environment:&nbsp;milieu&nbsp;/&nbsp;climate zone&nbsp;/&nbsp;depth range&nbsp;/&nbsp;distribution range&nbsp;
<span class="slabel2">Ecology</span></div>
<div class="smallSpace"></div><span>{env}</span>
<div class="sheader2">Distribution</div><span>North America: widely introduced.</span>
<div class="sheader2">Size / Weight / Age</div><div>{size}</div>
<div class="sheader2">Short description</div><span>Dorsal spines (total): 9.</span>
<div class="sheader2">Biology</div><div>{biology}</div>
<div class="sheader2">Life cycle and mating behavior</div><div>Oviparous.</div>
<table><tr><td class="smallSpace">&nbsp;</td></tr>
<tr><td><div class="smallSpace">Trophic level&nbsp;
<span class="slabel2">(Ref.&nbsp;<a href="/manual/x.htm">69278</a>)</span></div></td>
</tr><tr><td><div class="smallSpace">{trophic}</div></td></tr></table>
{extra}
<div class="sheader2">Tools</div><a href="/TrophicEco/FoodItemsList.php">Food items</a>
</body></html>"""


BASS = page(
    'Micropterus salmoides, Largemouth black bass : fisheries, aquaculture, gamefish',
    'Centrarchiformes (Basses) &gt; Centrarchidae (Sunfishes)',
    'Freshwater; benthopelagic; pH range: 7.0 - 7.5; dH range: 10 - ?; depth range 0 - 6 m '
    '(Ref. 1998). Subtropical; 10&deg;C - 32&deg;C (Ref. 12741); 46&deg;N - 24&deg;N, '
    '125&deg;W - 65&deg;W (Ref. 89798)',
    'Max length : 97.0 cm TL male/unsexed; (Ref. 86798); common length : 40.0 cm TL '
    'male/unsexed; (Ref. 556); max. published weight: 10.1 kg (Ref. 4699); max. reported age: '
    '23 years (Ref. 46974)',
    '3.8 &plusmn;0.4 se; based on diet studies.',
    'Adults inhabit clear vegetated lakes, ponds and swamps. Feed mainly on fish and larger '
    'invertebrates such as crayfish. They are also known to eat marine and brackish prey where '
    'ranges overlap. Young feed on plankton.')

SHAD = page(
    'Dorosoma petenense, Threadfin shad : fisheries, bait',
    'Clupeiformes (Herrings) &gt; Dorosomatidae (Gizzard shads)',
    'Marine; freshwater; brackish; pelagic-neritic; anadromous (Ref. 138280); depth range 0 - '
    '15 m (Ref. 39049). Subtropical; 20&deg;C - 30&deg;C (Ref. 115833); 42&deg;N - 15&deg;N',
    'Max length : 33.0 cm TL male/unsexed; (Ref. 96339)',
    '2.8 &plusmn;0.1 se; based on diet studies.',
    'Filter-feeders, but not entirely herbivorous since recorded food items include copepods, '
    'cladocerans and fish fry. Also feed on organic material of sand and detritus bottoms.')

DARTER = page(
    'Etheostoma olmstedi, Tessellated darter',
    'Perciformes (Perch-likes) &gt; Percidae (Perches)',
    'Freshwater; benthopelagic. Temperate; 10&deg;C - 24&deg;C (Ref. 12468); 47&deg;N - 29&deg;N',
    'Max length : 11.0 cm TL male/unsexed; (Ref. 5723); common length : 5.1 cm TL male/unsexed; '
    '(Ref. 12193); max. reported age: 4 years (Ref. 12193)',
    '2.9 &plusmn;0.36 se; based on food items.',
    'Occurs over sand and gravel. Feeds on aquatic insect larvae.')

NO_TROPHIC = page(
    'Moxostoma ugidatli, Sicklefin redhorse',
    'Cypriniformes (Carps) &gt; Catostomidae (Suckers)',
    'Freshwater; demersal. Temperate',
    'Max length : 66.0 cm TL male/unsexed; (Ref. 130000)',
    '')

WEIRD = page(
    'Notropis petersoni, Coastal shiner',
    'Cypriniformes (Carps) &gt; Leuciscidae (Minnows)',
    'Freshwater; brackish; demersal. Subtropical',
    'Max length : 7.4 cm SL male/unsexed; (Ref. 7335); max. published weight: 500 g '
    '(Ref. 7335); max. reported age: 3 years (Ref. 7335)',
    '2.5 +/- 0.2 se; based on size and trophs of closest relatives.')


class Parse(unittest.TestCase):

    def test_trophic_bridges_the_cell_boundary(self):
        """The label and its value are in different <td>s. That is the whole difficulty."""
        r = FB.parse(BASS)
        self.assertEqual(r['trophic_level'], 3.8)
        self.assertEqual(r['trophic_se'], 0.4)
        self.assertEqual(r['trophic_basis'], 'diet studies')
        self.assertEqual(r['trophic_ref'], 69278)

    def test_two_decimal_se_and_estimated_basis(self):
        r = FB.parse(DARTER)
        self.assertEqual((r['trophic_level'], r['trophic_se']), (2.9, 0.36))
        self.assertEqual(r['trophic_basis'], 'food items')

    def test_plus_slash_minus_spelling(self):
        r = FB.parse(WEIRD)
        self.assertEqual((r['trophic_level'], r['trophic_se']), (2.5, 0.2))
        self.assertTrue(r['trophic_basis'].startswith('size and trophs'))

    def test_script_text_is_thrown_away(self):
        """Every fixture carries a <script> claiming trophic level 9.9. None may be read."""
        for name, fixture in (('bass', BASS), ('shad', SHAD), ('none', NO_TROPHIC)):
            with self.subTest(name):
                self.assertNotEqual(FB.parse(fixture).get('trophic_level'), 9.9)

    def test_absent_trophic_level_is_absent_not_zero(self):
        r = FB.parse(NO_TROPHIC)
        self.assertNotIn('trophic_level', r)
        self.assertEqual(r['max_length_cm'], 66.0)

    def test_sizes(self):
        r = FB.parse(BASS)
        self.assertEqual(r['max_length_cm'], 97.0)
        self.assertEqual(r['length_type'], 'TL')
        self.assertEqual(r['common_length_cm'], 40.0)
        self.assertEqual(r['max_weight_kg'], 10.1)
        self.assertEqual(r['max_age_years'], 23.0)

    def test_grams_become_kilograms(self):
        self.assertEqual(FB.parse(WEIRD)['max_weight_kg'], 0.5)

    def test_common_length_is_not_read_as_max_length(self):
        """`common length : 5.1 cm` sits after `Max length : 11.0 cm` on the same line."""
        r = FB.parse(DARTER)
        self.assertEqual(r['max_length_cm'], 11.0)
        self.assertEqual(r['common_length_cm'], 5.1)

    def test_milieu_and_migration(self):
        r = FB.parse(SHAD)
        self.assertEqual(r['milieu'], ['marine', 'freshwater', 'brackish'])
        self.assertEqual(r['water_column'], 'pelagic-neritic')
        self.assertEqual(r['migration'], 'anadromous')
        self.assertEqual((r['depth_min_m'], r['depth_max_m']), (0.0, 15.0))
        self.assertEqual(r['climate'], 'Subtropical')
        self.assertEqual((r['temp_min_c'], r['temp_max_c']), (20.0, 30.0))

    def test_the_biology_paragraph_does_not_set_the_milieu(self):
        """The bass page says `marine and brackish prey` under Biology. It is a FRESHWATER fish.

        This is the reason the environment is read from after its own heading and not from the
        whole page -- reading it globally reports a fish's prey's habitat as the fish's own.
        """
        r = FB.parse(BASS)
        self.assertEqual(r['milieu'], ['freshwater'])
        self.assertIn('marine', r['feeds_on'])

    def test_the_environment_string_starts_at_the_value_not_the_heading(self):
        """The first run of this script stored `/ depth range / distribution range Ecology
        Freshwater; benthopelagic` on every record. The heading is not the answer."""
        for name, fixture, head in (('bass', BASS, 'Freshwater; benthopelagic'),
                                    ('shad', SHAD, 'Marine; freshwater; brackish')):
            with self.subTest(name):
                env = FB.parse(fixture)['environment']
                self.assertTrue(env.startswith(head), env[:70])
                for word in ('depth range /', 'distribution range', 'Ecology', 'milieu'):
                    self.assertNotIn(word, env)

    def test_a_shortened_heading_still_yields_the_value(self):
        """Belt and braces: if FishBase drops half its own heading, the leftovers are trimmed."""
        short = SHAD.replace('&nbsp;/&nbsp;depth range&nbsp;/&nbsp;distribution range&nbsp;\n'
                             '<span class="slabel2">Ecology</span>', '')
        self.assertNotEqual(short, SHAD)
        self.assertTrue(FB.parse(short)['environment'].startswith('Marine; freshwater'))

    def test_the_environment_still_ends_before_the_next_section(self):
        env = FB.parse(BASS)['environment']
        self.assertNotIn('widely introduced', env)
        self.assertIn('46', env)

    def test_no_depth_range_leaves_no_depth(self):
        r = FB.parse(DARTER)
        self.assertNotIn('depth_min_m', r)
        self.assertEqual(r['climate'], 'Temperate')

    def test_feeding_sentences_only(self):
        r = FB.parse(SHAD)
        self.assertIn('copepods', r['feeds_on'])
        self.assertNotIn('Oviparous', r['feeds_on'])

    def test_classification_and_common_name(self):
        r = FB.parse(SHAD)
        self.assertEqual((r['order'], r['family']), ('Clupeiformes', 'Dorosomatidae'))
        self.assertEqual(r['common'], 'Threadfin shad')

    def test_empty_fields_are_dropped_not_stored_as_none(self):
        for k, v in FB.parse(NO_TROPHIC).items():
            self.assertNotIn(v, (None, '', []), '%s came through empty' % k)

    def test_the_canary_expectations_match_the_bass_page(self):
        """If the canary's own numbers drift from the page, the guard is worthless."""
        self.assertEqual(FB.CANARY[0], 'Micropterus salmoides')
        self.assertEqual(FB.canary_ok(FB.parse(BASS)), [])

    def test_the_canary_catches_a_broken_parse(self):
        self.assertTrue(FB.canary_ok({}))
        self.assertTrue(FB.canary_ok({'trophic_level': 3.8, 'max_length_cm': 97.0,
                                      'milieu': ['marine']}))


class Encoding(unittest.TestCase):

    def test_cp1252_bytes_under_a_utf8_declaration(self):
        """The fixture SAYS utf-8 and is served cp1252. Believing it corrupts every record."""
        body = BASS.replace('&deg;', '°').encode('cp1252')
        text = FB.decode(body)
        self.assertNotIn('\ufffd', text)
        r = FB.parse(text)
        self.assertEqual((r['temp_min_c'], r['temp_max_c']), (10.0, 32.0))

    def test_a_damaged_degree_sign_still_yields_the_range(self):
        """Belt and braces: even if the decode had to give up, the numbers are still read."""
        r = FB.parse(BASS.replace('&deg;', '\ufffd'))
        self.assertEqual((r['temp_min_c'], r['temp_max_c']), (10.0, 32.0))

    def test_the_degree_matcher_does_not_invent_a_range(self):
        r = FB.parse(BASS.replace('10&deg;C - 32&deg;C', 'no temperature given'))
        self.assertNotIn('temp_min_c', r)

    def test_meta_charset_is_believed(self):
        self.assertIn('Largemouth', FB.decode(BASS.encode('utf-8')))


class Nearest(unittest.TestCase):
    """The five stale spellings measured out of species_traits.json on 2026-09-04."""

    ACCEPTED = {'Ictalurus punctatus', 'Ictalurus furcatus', 'Micropterus dolomieu',
                'Micropterus salmoides', 'Oncorhynchus mykiss', 'Pylodictis olivaris',
                'Sander vitreus', 'Sander canadensis', 'Salvelinus fontinalis',
                'Etheostoma olmstedi', 'Dorosoma petenense', 'Dorosoma cepedianum'}

    def test_the_five_the_agencies_spell_differently(self):
        for stale, want in (('Ictalurus punctatu', 'Ictalurus punctatus'),
                            ('Micropterus dolomieui', 'Micropterus dolomieu'),
                            ('Oncorhyncus mykiss', 'Oncorhynchus mykiss'),
                            ('Pylodictus olivaris', 'Pylodictis olivaris'),
                            ('Sander vitreum', 'Sander vitreus')):
            with self.subTest(stale):
                self.assertEqual(FB.nearest(stale, self.ACCEPTED), want)

    def test_a_replaced_genus_is_refused_not_guessed(self):
        """`Stizostedion vitreum` IS walleye and IS `Sander vitreus`. No string says so."""
        self.assertIsNone(FB.nearest('Stizostedion vitreum', self.ACCEPTED))

    def test_an_accepted_name_never_takes_this_path(self):
        self.assertIsNone(FB.nearest('Sander vitreus', self.ACCEPTED))
        self.assertIsNone(FB.nearest('Etheostoma olmstedi', self.ACCEPTED))

    def test_an_unrelated_name_matches_nothing(self):
        for name in ('Cynoscion nebulosus', 'Sciaenops ocellatus', 'Lepomis macrochirus'):
            with self.subTest(name):
                self.assertIsNone(FB.nearest(name, self.ACCEPTED))

    def test_a_tie_is_refused(self):
        """Two accepted names equally close is not a resolution, it is a coin toss."""
        self.assertIsNone(FB.nearest('Sander vitreuz', {'Sander vitreus', 'Sander vitreux'}))


CAT = page(
    'Ictalurus punctatus, Channel catfish : fisheries, aquaculture',
    'Siluriformes (Catfish) &gt; Ictaluridae (North American catfishes)',
    'Freshwater; brackish; demersal; potamodromous (Ref. 51243); depth range 0 - 15 m. '
    'Temperate; 0&deg;C - 30&deg;C',
    'Max length : 132 cm TL male/unsexed; (Ref. 5723); max. published weight: 26.3 kg',
    '3.6 &plusmn;0.1 se; based on diet studies.',
    'Feeds on insects, molluscs, crustaceans and fish.')

PAGES = {'Micropterus-salmoides': BASS, 'Dorosoma-petenense': SHAD,
         'Etheostoma-olmstedi': DARTER, 'Notropis-petersoni': WEIRD,
         'Moxostoma-ugidatli': NO_TROPHIC, 'Ictalurus-punctatus': CAT}


class Run(unittest.TestCase):
    """main() end to end with the network replaced -- the write, the resume and the canary."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.reg = os.path.join(self.dir, 'registry')
        os.makedirs(self.reg)
        rows = [('Centrarchiformes', 'Centrarchidae', 'Micropterus salmoides',
                 'Largemouth black bass', 'native'),
                ('Clupeiformes', 'Dorosomatidae', 'Dorosoma petenense', 'Threadfin shad',
                 'introduced'),
                ('Perciformes', 'Percidae', 'Etheostoma olmstedi', 'Tessellated darter',
                 'native'),
                ('Cypriniformes', 'Leuciscidae', 'Notropis petersoni', 'Coastal shiner',
                 'native'),
                ('Cypriniformes', 'Catostomidae', 'Moxostoma ugidatli', 'Sicklefin redhorse',
                 'endemic'),
                ('Siluriformes', 'Ictaluridae', 'Ictalurus punctatus', 'Channel catfish',
                 'native')]
        with open(os.path.join(self.dir, 'SC_Fishbase_SE_Full.csv'), 'w', newline='',
                  encoding='utf-8-sig') as fh:
            w = csv.writer(fh)
            w.writerow(['Order', 'Family', 'Species', 'FishBase name', 'Occurrence',
                        'Name(s) in Territory'])
            for r in rows:
                w.writerow(list(r) + [''])
        with open(os.path.join(self.reg, 'species_traits.json'), 'w', encoding='utf-8') as fh:
            json.dump({'species': {
                'Channel Catfish': [{'state': 'SC', 'scientific': 'Ictalurus punctatu'}],
                'Red Drum (Redfish)': [{'state': 'SC', 'scientific': 'Sciaenops ocellatus'}],
                'Hybrid Bass': [{'state': 'SC', 'scientific': 'Morone saxatilis X chrysops'}],
            }}, fh)
        self.calls = []
        self.real_fetch = FB.fetch
        FB.fetch = self.fake_fetch
        self.argv = sys.argv

    def tearDown(self):
        FB.fetch = self.real_fetch
        sys.argv = self.argv
        shutil.rmtree(self.dir, ignore_errors=True)

    def fake_fetch(self, url, timeout=30):
        name = url.rsplit('/', 1)[-1][:-5]
        self.calls.append(name)
        if name not in PAGES:
            raise urllib.error.HTTPError(url, 404, 'Not Found', {}, None)
        return PAGES[name].encode('utf-8'), 200

    def go(self, *extra):
        sys.argv = ['x', '--registry', self.reg, '--delay', '0'] + list(extra)
        cwd = os.getcwd()
        os.chdir(self.dir)
        try:
            return FB.main()
        finally:
            os.chdir(cwd)

    def out(self):
        with open(os.path.join(self.reg, FB.OUT), encoding='utf-8') as fh:
            return json.load(fh)

    def test_dry_run_writes_nothing_and_fetches_nothing(self):
        self.go()
        self.assertEqual(self.calls, [])
        self.assertFalse(os.path.exists(os.path.join(self.reg, FB.OUT)))

    def test_go_writes_the_species_it_could_read(self):
        self.go('--go')
        doc = self.out()
        self.assertIn('Dorosoma petenense', doc['species'])
        self.assertEqual(doc['species']['Dorosoma petenense']['trophic_level'], 2.8)
        self.assertEqual(doc['species']['Dorosoma petenense']['states'], ['SC'])
        self.assertEqual(doc['species']['Dorosoma petenense']['occurrence'], 'introduced')
        self.assertEqual(doc['species_count'], len(doc['species']))

    def test_the_canary_is_fetched_before_anything_else(self):
        self.go('--go')
        self.assertEqual(self.calls[0], 'Micropterus-salmoides')

    def test_a_404_lands_in_unresolved_by_name_not_in_species(self):
        self.go('--go')
        doc = self.out()
        self.assertIn('Sciaenops ocellatus', doc['unresolved'])
        self.assertEqual(doc['unresolved']['Sciaenops ocellatus']['reason'], 'HTTP 404')
        self.assertNotIn('Sciaenops ocellatus', doc['species'])

    def test_a_hybrid_is_never_fetched(self):
        self.go('--go')
        self.assertFalse([c for c in self.calls if 'Morone' in c])

    def test_the_stale_binomial_carries_the_app_name_to_the_accepted_one(self):
        self.go('--go')
        rec = self.out()['species']['Ictalurus punctatus']
        self.assertEqual(rec['app_names'], ['Channel Catfish'])
        self.assertEqual(rec['resolved_from'], ['Ictalurus punctatu'])
        self.assertNotIn('Ictalurus-punctatu', self.calls)

    def test_a_page_with_no_trophic_level_but_a_size_is_still_kept(self):
        self.go('--go')
        rec = self.out()['species']['Moxostoma ugidatli']
        self.assertEqual(rec['max_length_cm'], 66.0)
        self.assertNotIn('trophic_level', rec)

    def test_a_second_run_refetches_nothing(self):
        self.go('--go')
        first = len(self.calls)
        self.calls = []
        self.go('--go')
        self.assertEqual(self.calls, [], 'resume re-fetched %d of %d' % (len(self.calls), first))

    def test_the_canary_page_is_not_fetched_twice(self):
        self.go('--go')
        self.assertEqual(self.calls.count('Micropterus-salmoides'), 1)
        self.assertEqual(self.out()['species']['Micropterus salmoides']['trophic_level'], 3.8)

    def test_a_settled_404_is_not_asked_about_again(self):
        self.go('--go')
        self.assertIn('Sciaenops ocellatus', self.out()['unresolved'])
        self.calls = []
        self.go('--go')
        self.assertNotIn('Sciaenops-ocellatus', self.calls)

    def test_an_empty_page_is_settled_not_transient(self):
        """Esox americanus, from the real run: a page that answered and holds nothing.

        The reason string is `page fetched, no trophic level and no max length`, so a PERMANENT
        pattern anchored at position 0 never matched it and the species was re-asked forever.
        """
        for reason, want in (('HTTP 404', True),
                             ('HTTP 410', True),
                             ('page fetched, no trophic level and no max length', True),
                             ('timed out', False),
                             ('HTTP 503', False),
                             ('<urlopen error [Errno -2]>', False)):
            with self.subTest(reason):
                self.assertEqual(FB.settled({'reason': reason}), want)
        self.assertFalse(FB.settled(None))
        self.assertFalse(FB.settled({}))

    def test_an_empty_page_is_not_refetched_next_run(self):
        self.go('--go')
        self.assertIn('Moxostoma ugidatli', self.out()['species'])
        PAGES['Moxostoma-ugidatli'] = '<html><title>Nothing here</title></html>'
        try:
            self.go('--go', '--refresh')
            self.assertIn('Moxostoma ugidatli', self.out()['unresolved'])
            self.calls = []
            self.go('--go')
            self.assertNotIn('Moxostoma-ugidatli', self.calls)
        finally:
            PAGES['Moxostoma-ugidatli'] = NO_TROPHIC

    def test_a_timeout_is_asked_about_again(self):
        """Nothing was learned from a timeout. A 404 is an answer; this is not."""
        real = self.fake_fetch

        def flaky(url, timeout=30):
            if 'Dorosoma' in url:
                self.calls.append(url.rsplit('/', 1)[-1][:-5])
                raise urllib.error.URLError('timed out')
            return real(url, timeout)

        FB.fetch = flaky
        self.go('--go')
        FB.fetch = real
        self.assertIn('Dorosoma petenense', self.out()['unresolved'])
        self.calls = []
        self.go('--go')
        self.assertIn('Dorosoma-petenense', self.calls)
        self.assertEqual(self.out()['species']['Dorosoma petenense']['trophic_level'], 2.8)
        self.assertNotIn('Dorosoma petenense', self.out()['unresolved'])

    def test_refresh_refetches_everything(self):
        self.go('--go')
        self.calls = []
        self.go('--go', '--refresh')
        self.assertTrue(len(self.calls) > 1)

    def test_limit_bounds_the_fetches_and_still_writes(self):
        """N in the loop plus the canary, which is one page and is stored like any other."""
        self.go('--go', '--limit', '2')
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(len(self.out()['species']), 3)

    def test_a_broken_canary_stops_before_the_run(self):
        """The guard is the whole reason 800 empty records cannot be written."""
        PAGES['Micropterus-salmoides'] = '<html><title>Nope</title>no fish here</html>'
        try:
            with self.assertRaises(SystemExit):
                self.go('--go')
        finally:
            PAGES['Micropterus-salmoides'] = BASS
        self.assertEqual(self.calls, ['Micropterus-salmoides'])
        self.assertFalse(os.path.exists(os.path.join(self.reg, FB.OUT)))


class WorkList(unittest.TestCase):

    def test_slug(self):
        self.assertEqual(FB.slug('Dorosoma petenense'), 'Dorosoma-petenense')

    def test_url(self):
        self.assertEqual(FB.BASE % FB.slug('Micropterus salmoides'),
                         'https://www.fishbase.se/summary/Micropterus-salmoides.html')


if __name__ == '__main__':
    unittest.main(verbosity=2)
