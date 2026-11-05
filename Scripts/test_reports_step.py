#!/usr/bin/env python3
r"""test_reports_step.py -- the reports step reads a water's reports, keeps to the contract, and stays in SC.

    py .\Scripts\test_reports_step.py

Personal use only, not for distribution or resale; not for navigation.

A two-lake registry and a cache of one Sumter Item story and two AHQ posts, written here, so the test needs nothing
from the drive and fetches nothing.
"""
import copy, gzip, json, os, shutil, sys, tempfile, unittest, urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reports_step as R                                      # noqa: E402
import report_contract as K                                   # noqa: E402

REGISTRY = {
    'wateree_lake': {'slug': 'wateree_lake', 'name': 'Wateree Lake', 'state': 'SC', 'states': ['SC'],
                     'display_name': 'Wateree Lake (Kershaw Co, SC)', 'feature_type': 'lake',
                     'legacy_display_names': ['Wateree Lake, SC', 'Lake Wateree', 'Lake Wateree, SC']},
    'wateree_river': {'slug': 'wateree_river', 'name': 'Wateree River', 'state': 'SC', 'states': ['SC'],
                      'display_name': 'Wateree River (Richland Co, SC)', 'feature_type': 'river',
                      'legacy_display_names': ['Wateree River, SC']},
    'lake_murray': {'slug': 'lake_murray', 'name': 'Lake Murray', 'state': 'SC', 'states': ['SC'],
                    'display_name': 'Lake Murray (Lexington Co, SC)', 'feature_type': 'lake',
                    'legacy_display_names': ['Lake Murray, SC']},
    'lake_russell': {'slug': 'lake_russell', 'name': 'Lake Russell', 'state': 'GA', 'states': ['GA'],
                     'display_name': 'Lake Russell (Habersham Co, GA)', 'feature_type': 'lake',
                     'legacy_display_names': ['Lake Russell, GA']},
}
ITEM = {'url': 'https://www.theitem.com/stories/fishing-report,1', 'title': 'FISHING REPORT',
        'published': 'Sat, 29 Oct 2005 20:00:00 -0400', 'listed': '', 'chars': 400,
        'text': 'LAKE WATEREE: Largemouth Bass: Fair, using plastic worms along docks. Striped Bass: Good, trolling '
                'Stretch-25s on points in 20 feet of water. Crappie: Good, minnows over brush in 15 feet.\n'
                'LAKE MURRAY: Striped Bass: Excellent, free-lining herring off the dam. Catfish: Fair, cut bait.'}
POST = ('AHQ INSIDER Lake Wateree (SC) 2023 Week 11 Fishing Report - Updated March 16\n by Jay\n March 16\n'
        ' Lake Wateree is at 97% of full pool and morning surface water temperatures are in the low 60s.\n'
        ' The crappie are moving shallow on Wateree, and tournament angler Will Hinson reports that fish are on brush in '
        '8-12 feet of water.\n'
        ' Minnows and jigs are both working around the bridges.\n'
        ' Will Hinson with a fat Wateree crappie\n')
AHQ_URL = 'https://www.anglersheadquarters.com/blogs/ahq-report/ahq-insider-lake-wateree-sc-2023-week-11-fishing-report-updated-march-16'
TEASER_URL = 'https://www.anglersheadquarters.com/blogs/ahq-report/ahq-insider-lake-wateree-sc-2023-week-12-fishing-report-updated-march-23'


def _write(path, obj):
    with open(path, 'w') as fh: json.dump(obj, fh)


class ReportsStep(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = tempfile.mkdtemp()
        reg = os.path.join(cls.d, 'registry'); os.makedirs(reg)
        _write(os.path.join(reg, 'lake_index.json'), REGISTRY)
        _write(os.path.join(reg, 'lake_aliases.json'), {'Lake Wateree': 'wateree_lake'})
        cache = os.path.join(cls.d, 'reports_sources')
        for sub in ('item', 'scdnr', 'scdnr_wb', 'ahq'): os.makedirs(os.path.join(cache, sub))
        _write(os.path.join(cache, 'item', '1.json'), ITEM)
        slug = AHQ_URL.rsplit('/', 1)[1]
        _write(os.path.join(cache, 'ahq', slug + '.json'),
               {'url': AHQ_URL, 'slug': slug, 'title': 'AHQ INSIDER Lake Wateree (SC) 2023 Week 11 Fishing Report',
                'published': None, 'chars': len(POST), 'members_only_teaser': False, 'text': POST})
        tslug = TEASER_URL.rsplit('/', 1)[1]
        _write(os.path.join(cache, 'ahq', tslug + '.json'),
               {'url': TEASER_URL, 'slug': tslug, 'title': None, 'published': None, 'chars': 40,
                'members_only_teaser': True, 'text': 'Exclusive Content... Read more'})
        with open(os.path.join(cache, 'ahq_articles.txt'), 'w') as fh: fh.write(AHQ_URL + '\n' + TEASER_URL + '\n')
        cls.reg, cls.cache, cls.out = reg, cache, os.path.join(cls.d, 'out')
        cls.res = R.run('wateree_lake', reg, cache, cls.out, dry_run=True, fetch=False, log=lambda *a: None)
        cls.kept = []
        if cls.res.get('kept'):
            with open(cls.res['kept']) as fh: cls.kept = json.load(fh)['statements']

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.d, ignore_errors=True)

    def test_the_water_and_only_the_water(self):
        self.assertTrue(self.res['ok'], self.res.get('error'))
        self.assertTrue(self.kept)
        self.assertTrue(all('wateree_lake' in s['water'] for s in self.kept))
        self.assertFalse(any('free-lining herring off the dam' in s['text'] for s in self.kept), 'that is Lake Murray')

    def test_the_column_by_its_labels(self):
        st = [s for s in self.kept if s['source'] == 'Item' and s['species'] == ['striped bass']]
        self.assertEqual(len(st), 1)
        self.assertEqual(st[0]['rating'], 'good')
        self.assertEqual(st[0]['date'], '2005-10-29')
        self.assertEqual([d['ft'] for d in st[0]['depths']], [[20]])

    def test_ahq_by_its_address_and_its_paragraphs(self):
        a = [s for s in self.kept if s['source'] == 'AHQ']
        self.assertEqual({s['date'] for s in a}, {'2023-03-16'})
        self.assertEqual([s['about'] for s in a], ['named', 'continued'], 'the caption is not a report')
        self.assertTrue(all(s['species'] == ['crappie'] for s in a))
        self.assertEqual(a[0]['water_temp_f_said'], 62)
        self.assertEqual(self.res['ahq_posts_listed'], 2)

    def test_a_lake_page_is_not_the_river(self):
        self.assertFalse(any('wateree_river' in s['water'] for s in self.kept))

    def test_every_statement_keeps_to_the_contract(self):
        texts = K.source_texts(self.cache)
        for s in self.kept:
            self.assertEqual(K.check(s, set(REGISTRY), texts), [], s['text'][:60])

    def test_a_water_outside_sc_is_skipped_and_says_why(self):
        r = R.run('lake_russell', self.reg, self.cache, self.out, dry_run=True, fetch=False, log=lambda *a: None)
        self.assertTrue(r['ok'])
        self.assertIn('SC', r['skipped'])
        self.assertFalse(os.path.exists(os.path.join(self.out, 'lake_russell')))

    def test_names_find_the_water(self):
        self.assertEqual(R.find_slug(REGISTRY, 'Lake Wateree, SC'), 'wateree_lake')
        self.assertEqual(R.find_slug(REGISTRY, 'Wateree Lake (Kershaw Co, SC)'), 'wateree_lake')
        self.assertEqual(R.find_slug(REGISTRY, 'lake_murray'), 'lake_murray')
        self.assertIsNone(R.find_slug(REGISTRY, 'Nowhere Lake'))

    def _save(self, worker, token='a-test-value'):
        """A save with the Worker stood in for by `worker(url, data, headers) -> (status, body)`."""
        sent, real = [], R._post
        def fake(url, data, headers, timeout=180):
            sent.append((url, data, headers)); return worker(url, data, headers)
        R._post = fake
        old = os.environ.get('TROLLMAP_SYNC_TOKEN')
        if token is None: os.environ.pop('TROLLMAP_SYNC_TOKEN', None)
        else: os.environ['TROLLMAP_SYNC_TOKEN'] = token
        try:
            r = R.run('wateree_lake', self.reg, self.cache, os.path.join(self.d, 'out_save'), dry_run=False,
                      fetch=False, log=lambda *a: None)
        finally:
            R._post = real
            if old is None: os.environ.pop('TROLLMAP_SYNC_TOKEN', None)
            else: os.environ['TROLLMAP_SYNC_TOKEN'] = old
        return r, sent

    def test_the_save_sends_the_checked_file_gzipped_beside_the_profile(self):
        kept = lambda url, data, headers: (200, json.dumps({'ok': True, 'bytes': len(data),
                                                             'key': 'lake_packages/lake_wateree_sc/reports.json'}).encode())
        r, sent = self._save(kept)
        self.assertTrue(r['ok'], r.get('error'))
        self.assertEqual(r['saved'], 'lake_packages/lake_wateree_sc/reports.json')
        self.assertEqual(len(sent), 1)
        url, data, headers = sent[0]
        path, q = url.split('?', 1)
        self.assertTrue(path.endswith('/research/save-reports'))
        q = dict(urllib.parse.parse_qsl(q))
        self.assertEqual(q, {'lake': 'Wateree Lake (Kershaw Co, SC)', 'water': 'wateree_lake',
                             'statements': str(len(self.kept))})
        self.assertEqual(headers['X-Sync-Token'], 'a-test-value')
        self.assertEqual(headers['Content-Type'], 'application/gzip')
        doc = json.loads(gzip.decompress(data))
        self.assertEqual(doc['water'], 'wateree_lake')
        self.assertEqual([s['id'] for s in doc['statements']], [s['id'] for s in self.kept], 'the dry run\'s file')
        self.assertEqual(r['bytes'], len(data))
        self.assertFalse(os.path.exists(os.path.join(self.d, 'out_save')), 'a save keeps no second copy here')

    def test_no_key_no_save_and_it_says_where_the_key_comes_from(self):
        r, sent = self._save(lambda *a: (200, b'{}'), token=None)
        self.assertFalse(r['ok'])
        self.assertIn('run_research.ps1', r['error'])
        self.assertEqual(sent, [])

    def test_the_worker_refusing_or_keeping_less_is_a_failure(self):
        r, _ = self._save(lambda *a: (404, json.dumps({'ok': False, 'error': 'no research profile for X'}).encode()))
        self.assertFalse(r['ok']); self.assertIn('no research profile', r['error']); self.assertNotIn('saved', r)
        r, _ = self._save(lambda url, data, h: (200, json.dumps({'ok': True, 'bytes': len(data) - 1, 'key': 'k'}).encode()))
        self.assertFalse(r['ok']); self.assertIn('bytes of the', r['error'])
        r, _ = self._save(lambda *a: (502, b'<html>bad gateway</html>'))
        self.assertFalse(r['ok']); self.assertIn('502', r['error'])

    def test_one_broken_statement_and_nothing_is_sent(self):
        real = R.K.check
        R.K.check = lambda s, slugs, texts: ['not word for word'] if s['source'] == 'AHQ' else []
        try:
            r, sent = self._save(lambda *a: (200, b'{"ok": true}'))
        finally:
            R.K.check = real
        self.assertFalse(r['ok']); self.assertIn('break the contract', r['error']); self.assertEqual(sent, [])

    def test_the_key_is_never_in_what_is_reported(self):
        r, _ = self._save(lambda *a: (401, b'{"error":"unauthorized"}'), token='secret-looking-value')
        self.assertNotIn('secret-looking-value', json.dumps(r, default=str))

    def test_new_posts_come_from_the_article_sitemaps(self):
        index = ('<sitemapindex><sitemap><loc>https://x/sitemap_blogs_1.xml</loc></sitemap>'
                 '<sitemap><loc>https://x/sitemap_articles_1.xml</loc></sitemap></sitemapindex>')
        arts = '<urlset><url><loc>%s</loc></url><url><loc>https://x/blogs/ahq-report/new-post</loc></url></urlset>' % AHQ_URL
        got, pause = [], R.PAUSE_S
        R._get, real = (lambda u, timeout=60: got.append(u) or (index if u.endswith('sitemap.xml') else arts)), R._get
        R.PAUSE_S = 0
        d = tempfile.mkdtemp()
        try:
            with open(os.path.join(d, 'ahq_articles.txt'), 'w') as fh: fh.write(AHQ_URL + '\n')
            urls, new = R.ahq_post_urls(d, refresh=True, log=lambda *a: None)
        finally:
            R._get, R.PAUSE_S = real, pause
            shutil.rmtree(d, ignore_errors=True)
        self.assertEqual(new, 1)
        self.assertIn('https://x/blogs/ahq-report/new-post', urls)
        self.assertFalse(any('sitemap_blogs' in u for u in got), 'the blogs map lists blogs, not posts')

    def test_a_paragraph_in_two_posts_keeps_its_first_date(self):
        # AHQ re-uses a week's paragraphs the next week. Week 11 is read first (its address sorts first) but week 9
        # wrote them, so week 9's date and address are the ones kept, and week 11 is counted as a copy.
        d = tempfile.mkdtemp(); cache = os.path.join(d, 'reports_sources'); os.makedirs(os.path.join(cache, 'ahq'))
        early = AHQ_URL.replace('week-11', 'week-9').replace('march-16', 'march-2')
        early_text = POST.replace('Week 11', 'Week 9').replace('Updated March 16', 'Updated March 2').replace(
            '\n March 16\n', '\n March 2\n')
        for url, text in ((AHQ_URL, POST), (early, early_text)):
            slug = url.rsplit('/', 1)[1]
            _write(os.path.join(cache, 'ahq', slug + '.json'),
                   {'url': url, 'slug': slug, 'title': text.split(' - ')[0], 'published': None, 'chars': len(text),
                    'members_only_teaser': False, 'text': text})
        with open(os.path.join(cache, 'ahq_articles.txt'), 'w') as fh: fh.write(AHQ_URL + '\n' + early + '\n')
        r = R.run('wateree_lake', self.reg, cache, os.path.join(d, 'out'), dry_run=True, fetch=False, log=lambda *a: None)
        self.assertTrue(r['ok'], r.get('error'))
        with open(r['kept']) as fh: kept = json.load(fh)['statements']
        shutil.rmtree(d, ignore_errors=True)
        self.assertEqual(len(kept), 2)
        self.assertEqual({(s['date'], s['url'], s['copies']) for s in kept}, {('2023-03-02', early, 1)})

    def test_one_line_said_of_two_lakes_is_kept_for_each_and_a_reprint_once(self):
        # The Item's short lines are said of many lakes word for word. Lake Murray comes first in the story, and
        # Wateree's line is not Murray's; next week's reprint of Wateree's line is a later date of the same one.
        d = tempfile.mkdtemp(); cache = os.path.join(d, 'reports_sources'); os.makedirs(os.path.join(cache, 'item'))
        line = 'Catfish: Good, using nightcrawlers on the bottom.'
        for n, day in ((1, 'Sat, 05 Nov 2005'), (2, 'Sat, 12 Nov 2005')):
            text = ('LAKE MURRAY: ' + line + '\n' if n == 1 else '') + 'LAKE WATEREE: ' + line
            _write(os.path.join(cache, 'item', '%d.json' % n),
                   {'url': 'https://www.theitem.com/stories/fishing-report,%d' % n, 'title': 'FISHING REPORT',
                    'published': day + ' 20:00:00 -0400', 'listed': '', 'chars': len(text), 'text': text})
        r = R.run('wateree_lake', self.reg, cache, os.path.join(d, 'out'), dry_run=True, fetch=False, log=lambda *a: None)
        self.assertTrue(r['ok'], r.get('error'))
        with open(r['kept']) as fh: kept = json.load(fh)['statements']
        shutil.rmtree(d, ignore_errors=True)
        self.assertEqual([(s['water'], s['date'], s['repeated'], s['copies']) for s in kept],
                         [(['wateree_lake'], '2005-11-05', ['2005-11-12'], 1)])

    def test_a_page_that_prints_one_report_under_two_lakes(self):
        # SCDNR's page of 2010-08-04 printed Lake Greenwood's paragraphs under Lake Wateree too. The paragraph that
        # names Murray stays Murray's; the one that names neither goes to neither; the stock line stays with both.
        d = tempfile.mkdtemp(); cache = os.path.join(d, 'reports_sources'); os.makedirs(os.path.join(cache, 'item'))
        cat = ('Catfish: Good. Captain Bob Smith reports that the bite on Murray has been strong, with channel catfish '
               'in the 3-7 pound range coming on cut bait in 20 feet of water.')
        crp = ('Crappie: Fair. Sportsman\'s Friend reports that crappie have moved deep. The best bet is fishing around '
               'brush in 20 feet of water with minnows.')
        brm = 'Bream: Good, using crickets around the banks.'
        text = 'LAKE MURRAY: ' + cat + '\n' + crp + '\n' + brm + '\nLAKE WATEREE: ' + cat + '\n' + crp + '\n' + brm
        _write(os.path.join(cache, 'item', '1.json'),
               {'url': 'https://www.theitem.com/stories/fishing-report,1', 'title': 'FISHING REPORT',
                'published': 'Sat, 07 Aug 2010 20:00:00 -0400', 'listed': '', 'chars': len(text), 'text': text})
        r = R.run('wateree_lake', self.reg, cache, os.path.join(d, 'out'), dry_run=True, fetch=False, log=lambda *a: None)
        self.assertTrue(r['ok'], r.get('error'))
        with open(r['kept']) as fh: kept = json.load(fh)['statements']
        m = R.run('lake_murray', self.reg, cache, os.path.join(d, 'out'), dry_run=True, fetch=False, log=lambda *a: None)
        with open(m['kept']) as fh: murray = json.load(fh)['statements']
        shutil.rmtree(d, ignore_errors=True)
        self.assertEqual([s['species'] for s in kept], [['bream']])
        self.assertEqual(sorted(s['species'][0] for s in murray), ['bream', 'catfish'])
        self.assertEqual(r['one_page_two_waters'], 3)

    def test_a_ton_of_crappie_is_crappie_and_strips_of_bream_are_bait(self):
        import report_column as C
        got = C.parts('While veteran tournament angler Will Hinson had been finding a ton of crappie on the lower end, '
                      'the wind kept him there.\nThe catfish are biting on strips of bream in 20 feet of water.')
        self.assertEqual([(p[0], p[4]) for p in got], [(['crappie'], 'named'), (['catfish'], 'named')])
        self.assertEqual(C.species_in('Speaking of stripers, the fish are not schooling.'), ['striped bass'])

    def test_the_check_refuses_what_it_should(self):
        texts = K.source_texts(self.cache); slugs = set(REGISTRY)
        good = self.kept[0]
        def refused(change, why):
            s = copy.deepcopy(good); change(s)
            s['id'] = K.make_id(s['source'], s['url'], s['date'], s['text'])
            self.assertTrue(any(why in x for x in K.check(s, slugs, texts)), why)
        refused(lambda s: s.update(era='the 2018 slot'), 'worked out at plan time')
        refused(lambda s: s.update(lakes=['wateree_lake']), 'worked out at plan time')
        refused(lambda s: s.update(text=s['text'] + ' And they are biting everywhere.'), 'not word for word')
        refused(lambda s: s.update(text='Lake Wateree is at 96.6% of full pool. Exclusive Content... Read more'),
                'page wrapping')
        refused(lambda s: s.update(species=['sturgeon']), 'species')
        refused(lambda s: s.update(water=['lake_nowhere']), 'not in the registry')
        refused(lambda s: s.update(water=[], water_from='named'), 'disagree')
        refused(lambda s: s.update(date='2026-13'), 'date')
        refused(lambda s: s.update(source='Fishbrain'), 'not in the table')


if __name__ == '__main__':
    unittest.main()
