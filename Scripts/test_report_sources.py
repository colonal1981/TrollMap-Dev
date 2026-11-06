#!/usr/bin/env python3
r"""test_report_sources.py -- the four sources Ryan picked on 11/6 read what they should, and nothing else.

    py .\Scripts\test_report_sources.py

Personal use only, not for distribution or resale; not for navigation.

Georgia DNR's weekly blog, Santee Cooper Country's monthly pages, the tournament reports (Bassmaster, MLF) and the
Lake Murray video captions. Small texts written here; nothing is fetched.
"""
import os, sys, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import report_contract as K                                     # noqa: E402
import report_ga as G                                           # noqa: E402
import report_scc as SC                                         # noqa: E402
import report_tourney as TN                                     # noqa: E402
import report_yt as Y                                           # noqa: E402

GA_POST = '\n'.join([
    '# CENTRAL GEORGIA', '#### RESERVOIR REPORT', 'CLARKS HILL LAKE',
    "CLARKS HILL IS DOWN 6.7 FEET, 50’S – Anglers targeting stripers and hybrids have been finding more consistency "
    "lately, particularly around the Little River area.",
    'Crappie are also being reported this week, although depths are still a little all over the place from 2 to 30 feet '
    'of water.',
    'Riley Hale covers this at https://www.wrdw.com/2026/02/16/csra-anglers/ and more.',
    'LAKE OCONEE', 'Striped Bass: The striped bass bite has been strong on Oconee with swimbaits in open water.',
    '# NORTH GEORGIA', 'LAKE HARTWELL',
    "Lake Hartwell (Courtesy of Ken Sturdivant, The Southern Fishing Report and GA WRD) — LAKE HARTWELL IS DOWN 7.4 FEET, "
    "40’S — Bass fishing is fair. Fish any rip rap in the Seneca River with a Shad Rap on long casts and slow retrieves.",
    'LAKE LANIER', 'Lake Lanier crappie fishing is good, suspended 5 to 8 feet deep near main creek channels.'])


class Georgia(unittest.TestCase):
    rec = {'url': 'https://georgiawildlife.blog/2026/02/27/georgia-fishing-report-february-27-2026/',
           'slug': 'georgia-fishing-report-february-27-2026', 'title': 'Georgia Fishing Report', 'published': '2026-02-27',
           'text': GA_POST}

    def test_only_the_three_lakes_and_only_their_sections(self):
        sec = G.sections(GA_POST)
        self.assertEqual(set(sec), {'j_strom_thurmond_reservoir', 'hartwell_lake'})
        self.assertFalse(any('Oconee' in l or 'Lanier' in l for ls in sec.values() for l in ls))

    def test_the_weekly_temperature_and_the_fish(self):
        st = G.statements(self.rec, {'hartwell_lake'})
        self.assertTrue(st)
        self.assertEqual({s['water_temp_f_said'] for s in st}, {45})
        self.assertIn('Ken Sturdivant', st[0]['who'])
        self.assertTrue(all(s['source'] == 'GA-WRD' and s['waters'] == ['hartwell_lake'] for s in st))
        th = G.statements(self.rec, {'j_strom_thurmond_reservoir'})
        self.assertEqual({s['water_temp_f_said'] for s in th}, {55})
        self.assertFalse(any('wrdw.com' in s['text'] for s in th), 'a link line is not a report')
        self.assertTrue(any('crappie' in s['species'] for s in th))

    def test_a_post_url(self):
        self.assertTrue(G.POST.search(self.rec['url']))
        self.assertFalse(G.POST.search('https://georgiawildlife.blog/2026/02/27/turkey-season-opens/'))


class SanteeCooperCountry(unittest.TestCase):
    def test_the_month_with_and_without_a_year(self):
        self.assertEqual(SC.month_of({'slug': 'fishing-reports-dec25'}), '2025-12')
        self.assertEqual(SC.month_of({'slug': 'fishing-reports-march2026'}), '2026-03')
        self.assertEqual(SC.month_of({'slug': 'fishing-reports-april', 'sitemap_lastmod': '2025-04-03T10:00:00'}), '2025-04')
        self.assertEqual(SC.month_of({'slug': 'fishing-reports-dec', 'sitemap_lastmod': '2025-01-04'}), '2024-12')
        self.assertIsNone(SC.month_of({'slug': 'fishing-reports'}))
        self.assertEqual(SC.month_of({'slug': 'fishing-reports', 'sitemap_lastmod': '2026-10-07T17:07:28+00:00'}), '2026-10')

    def test_every_fish_under_its_heading_and_the_lake_it_names(self):
        rec = {'url': 'https://www.santeecoopercountry.org/fishing-reports-dec25/', 'slug': 'fishing-reports-dec25',
               'text': 'Provided by Captain Joe Dennis\nStriper\nSeason is open!\nThe stripers are deep this time of year '
                       'in 40-50 foot. Cast quarter ounce buck tails under the gulls.\nCrappie & Bream\nLook for shallower '
                       'brush 15-20 ft on lake Marion for the crappie, with jigs or minnows.'}
        mo = SC.statements(rec, 'lake_moultrie'); ma = SC.statements(rec, 'lake_marion')
        self.assertEqual([s['species'] for s in mo], [['striped bass']])
        self.assertEqual([s['species'] for s in ma], [['striped bass'], ['crappie', 'bream']])
        self.assertEqual(ma[1]['waters'], ['lake_marion'])
        self.assertEqual(mo[0]['water_from'], 'system')
        self.assertEqual(ma[0]['who'], ['Joe Dennis'])

    def test_no_facebook_post(self):
        rec = {'url': 'x', 'slug': 'fishing-reports-nov-2026-facebook', 'text': 'Striper\nStripers are deep in 30-45 ft.'}
        self.assertEqual(SC.statements(rec, 'lake_marion'), [])


class Tournaments(unittest.TestCase):
    def test_which_articles(self):
        self.assertTrue(TN.wanted('https://www.bassmaster.com/news/top-5-patterns-of-the-hartwell-classic/'))
        self.assertTrue(TN.wanted('https://majorleaguefishing.com/series/2018-04-09-top-10-patterns-from-santee-cooper/'))
        self.assertFalse(TN.wanted('https://www.bassmaster.com/elite/slideshow/top-lures-of-lake-murray-2026/'), 'no text')
        self.assertEqual(TN.waters_of('https://majorleaguefishing.com/series/2018-04-09-top-10-patterns-from-santee-cooper/'),
                         ['lake_marion', 'lake_moultrie'])
        self.assertFalse(TN.wanted('https://www.bassmaster.com/news/kevin-murray-wins-again/'), 'a man named Murray')
        self.assertFalse(TN.wanted('https://www.bassmaster.com/tag/hartwell/'))
        self.assertFalse(TN.wanted('https://www.bassmaster.com/news/hartwell-boat-ramp-closures/'))

    def test_the_usable_paragraphs_only(self):
        rec = {'url': 'https://www.bassmaster.com/news/top-5-patterns-of-the-hartwell-classic/', 'site': 'bassmaster.com',
               'published': '2018-03-20T10:00:00Z', 'title': 'Top 5 patterns',
               'text': 'Hartwell was 15 feet low for the Classic.\n'
                       'Jordan Lee won with 50 pounds, 7 ounces, his second title in a row on Hartwell.\n'
                       'Lee caught most of his fish on a Strike King swimbait slow-rolled over brush in 30 feet on main '
                       'lake points.\n'
                       'Crappie came up on a jig for some of them too, around the docks in 10 feet.'}
        st = TN.statements(rec, 'hartwell_lake')
        self.assertEqual([s['species'] for s in st], [['black bass'], ['crappie']])
        self.assertEqual({s['source'] for s in st}, {'BASS'})
        self.assertEqual(TN.statements(rec, 'lake_murray'), [])
        rec2 = dict(rec, text='Hartwell once.\nLee caught most of his fish on a swimbait in 30 feet on main lake points.')
        self.assertEqual(TN.statements(rec2, 'hartwell_lake'), [], 'the text must name the water twice')


class MurrayVideos(unittest.TestCase):
    rec = {'video_id': 'test', 'url': 'https://www.youtube.com/watch?v=test', 'title': 'Lake Murray June 2026 Fishing Report',
           'text': "What's up guys. Captain Chip Bragg here on stripers. The stripers are down 30 to 40 feet on the main "
                   "channel early in the morning. We are pulling free lines over them. Now largemouth. The largemouth "
                   "are on main lake points with a topwater bait first thing."}

    def test_runs_of_the_talk_with_their_fish(self):
        st = Y.statements(self.rec, 'lake_murray')
        self.assertEqual([s['species'] for s in st], [['striped bass'], ['largemouth bass']])
        self.assertTrue(all(s['text'] in self.rec['text'] for s in st), 'verbatim')
        self.assertEqual(st[0]['date'], '2026-06')
        self.assertEqual(Y.statements(self.rec, 'lake_wylie'), [])

    def test_captions_without_punctuation(self):
        words = ('the stripers are on the points in 25 feet ' * 20).strip()
        st = Y.statements(dict(self.rec, text=words), 'lake_murray')
        self.assertTrue(st and all(s['text'] in words for s in st))

    def test_the_channels_own_words_are_not_a_report(self):
        t = self.rec['text'] + ' Make sure you subscribe to the channel, the stripers are on the points in 25 feet.'
        self.assertFalse(any('subscribe' in s['text'] for s in Y.statements(dict(self.rec, text=t), 'lake_murray')))

    def test_a_title_with_no_year_is_dated_by_the_list(self):
        self.assertEqual(Y.month_of({'video_id': 'NTGCpYlNlRs', 'title': 'May Fishing Report'}), '2025-05')


class TheContractKnowsThem(unittest.TestCase):
    def test_sources(self):
        for k in ('GA-WRD', 'BASS', 'MLF', 'SCC', 'YT-BigFishBlanch'): self.assertIn(k, K.SOURCES)


if __name__ == '__main__':
    unittest.main()
