#!/usr/bin/env python3
"""
test_audit_drive_sources.py -- the finder must not report an unread file as read.

Personal use only, not for distribution or resale; not for navigation.

The whole point of audit_drive_sources.py is that a file nothing reads shows up. A false
"referenced" is therefore the only failure that matters: it puts a source back into silence,
which is the exact failure the finder exists to end. Every case below is drawn from a real file
on the drive as of 2026-09-03.

    py test_audit_drive_sources.py
"""

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audit_drive_sources as A  # noqa: E402


# A script that names two of its inputs the way the real ones do: one by full filename, one only
# by the folder it lives in. Both spellings have to count as a reference.
FAKE_SCRIPT = '''
DATA_DIR = Path(r"F:\\\\TrollMapPipeline\\\\oyster_marsh")
SC_OYSTER_FILE = DATA_DIR / "SCDNROyster2015Live.geojson"
SC_ESI_ZIP     = DATA_DIR / "SCarolina_2015_GDB.zip"
def load(zone):
    return f"{zone}/oyster_beds.geojson"

# Named by PATTERN, never by name -- the two real cases that the first version got wrong.
def find_gdbs(nhd_dir):
    return sorted(nhd_dir.glob("**/NHDPLUS_H_*_HU4*_GDB.gdb"))
def ga_access(up):
    return glob.glob(os.path.join(up, "WRD_Water_Access_Points*.geojson"))

# And a pattern so broad that honouring it would mark the whole drive as read.
def every(d):
    return sorted(Path(d).glob("*.geojson"))
'''


def touch(p, size=0):
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, 'wb') as f:
        if size:
            f.seek(size - 1)
            f.write(b'\0')


class DriveAudit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix='auditfix_'))
        r = cls.root
        touch(r / 'Scripts' / 'extract_coastal_habitat.py')
        (r / 'Scripts' / 'extract_coastal_habitat.py').write_text(FAKE_SCRIPT, encoding='utf-8')

        # Read: named outright.
        touch(r / 'oyster_marsh' / 'SCDNROyster2015Live.geojson', 4096)
        # Read: only the FOLDER is named, never this filename.
        touch(r / 'oyster_marsh' / 'Georgia_2015_GDB.zip', 4096)
        # Unread: the three real ones that were sitting on the drive unnoticed.
        touch(r / 'georgia_oyster_reef_2015' / 'georgia_oyster_reef_2015.gpkg', 8192)
        touch(r / 'NOAA_ENC' / 'SC_ENCs.zip', 8192)
        touch(r / 'ArtReef2021.csv', 2048)
        # Unread, and a DIRECTORY that is really one dataset.
        touch(r / 'G-WRAPVectorData2021' / 'G-WRAPData2021.gdb' / 'a00000001.gdbtable', 1024)
        touch(r / 'G-WRAPVectorData2021' / 'G-WRAPData2021.gdb' / 'a00000004.gdbtable', 2048)
        # Pipeline OUTPUT, not an input. Must not be listed as a missed source.
        touch(r / 'registry' / 'lake_index.json', 4096)
        touch(r / 'chartpack' / 'wateree_lake' / 'pois.geojson', 4096)
        # An extension the typed list has never seen.
        touch(r / 'mystery_survey.qqq', 3 * 1024 * 1024)
        # Reached only by a glob. 8.6 GB of these read as unread until the finder learned globs.
        touch(r / 'NHD' / '0304' / 'NHDPLUS_H_0304_HU4_GDB.gdb' / 'a00000001.gdbtable', 512)
        touch(r / 'WRD_Water_Access_Points_-4961998252164543096.geojson', 4096)
        # A geojson nothing names. `*.geojson` IS in the corpus; it must not rescue this file.
        touch(r / 'somebody_elses' / 'random_download.geojson', 4096)
        # Must be suppressed: this tool's own report, and our commit scratch.
        touch(r / 'drive_audit.json', 33 * 1024 * 1024)
        touch(r / '_commit_msg19.txt', 5000)

        cls.corpus, cls.code_files = A.build_corpus(r)
        cls.tokens, cls.globs = cls.corpus
        cls.items, cls.skipped = A.collect(r, include_generated=False)
        for it in cls.items:
            it['referenced_by'] = A.referenced(it, cls.corpus)
        cls.by_name = {i['name']: i for i in cls.items}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def test_the_corpus_is_walked_not_empty(self):
        self.assertEqual(self.code_files, 1)
        self.assertIn('scdnroyster2015live.geojson', self.tokens)

    def test_a_file_named_outright_counts_as_read(self):
        self.assertTrue(self.by_name['SCDNROyster2015Live.geojson']['referenced_by'])

    def test_a_file_reached_only_by_its_folder_counts_as_read(self):
        # Georgia_2015_GDB.zip appears nowhere in the script. Its folder does.
        hit = self.by_name['Georgia_2015_GDB.zip']['referenced_by']
        self.assertEqual(hit, 'oyster_marsh/')

    def test_the_three_that_were_actually_missed_report_as_unread(self):
        for n in ('georgia_oyster_reef_2015.gpkg', 'SC_ENCs.zip', 'ArtReef2021.csv'):
            self.assertIsNone(self.by_name[n]['referenced_by'], f'{n} was wrongly called read')

    def test_a_geodatabase_is_one_item_and_carries_the_whole_size(self):
        gdb = self.by_name['G-WRAPData2021.gdb']
        self.assertEqual(gdb['kind'], 'geodatabase')
        self.assertEqual(gdb['bytes'], 3072)          # both tables, summed
        self.assertIsNone(gdb['referenced_by'])
        # and we did NOT descend into it
        self.assertNotIn('a00000001.gdbtable', self.by_name)

    def test_generated_trees_are_skipped_not_reported_as_missed_sources(self):
        self.assertNotIn('lake_index.json', self.by_name)
        self.assertNotIn('pois.geojson', self.by_name)
        self.assertEqual(sorted(self.skipped),
                         ['chartpack  (pipeline output)', 'registry  (pipeline output)'])

    def test_an_unseen_extension_surfaces_as_a_question(self):
        m = self.by_name['mystery_survey.qqq']
        self.assertEqual(m['kind'], 'unknown_ext')
        self.assertIsNone(m['referenced_by'])

    def test_a_short_common_stem_does_not_match_by_accident(self):
        # 'load' and 'zone' appear in the script; a file called zone.zip must not read as used
        # just because four letters of its name occur somewhere in our code.
        item = {'name': 'zone.zip', 'path': 'somewhere/zone.zip'}
        self.assertIsNone(A.referenced(item, self.corpus))

    def test_exclude_drops_a_top_level_tree(self):
        items, skipped = A.collect(self.root, include_generated=False, exclude=['NOAA_ENC'])
        self.assertNotIn('SC_ENCs.zip', {i['name'] for i in items})
        self.assertIn('NOAA_ENC  (--exclude)', skipped)


    # ---- globs -------------------------------------------------------------------------
    def test_a_geodatabase_named_only_by_a_glob_counts_as_read(self):
        hit = self.by_name['NHDPLUS_H_0304_HU4_GDB.gdb']['referenced_by']
        self.assertTrue(hit, 'the NHD geodatabases are reached by glob and must read as used')
        self.assertIn('*', hit)

    def test_the_ga_access_points_named_only_by_a_glob_count_as_read(self):
        hit = self.by_name['WRD_Water_Access_Points_-4961998252164543096.geojson']['referenced_by']
        self.assertTrue(hit)
        self.assertIn('*', hit)

    def test_a_broad_glob_does_not_mark_the_whole_drive_as_read(self):
        # THE FAILURE THIS FILE EXISTS TO CATCH. `*.geojson` is in the corpus; if it were honoured
        # every geojson on the drive would silently read as used and the report would say nothing.
        self.assertIsNone(self.by_name['random_download.geojson']['referenced_by'])
        self.assertNotIn('*.geojson', self.globs)

    # ---- provenance ---------------------------------------------------------------------
    def test_this_tools_own_report_is_not_a_source(self):
        # The finder's first act must not be to report itself. drive_audit.json is 33 MB.
        self.assertNotIn('drive_audit.json', self.by_name)

    def test_our_own_scratch_is_not_a_source(self):
        self.assertNotIn('_commit_msg19.txt', self.by_name)

    def test_a_file_with_no_download_stream_is_not_called_downloaded(self):
        # Absence of a mark is NOT evidence we made it -- it must never read as "downloaded".
        self.assertFalse(self.by_name['ArtReef2021.csv']['downloaded'])
        self.assertIsNone(self.by_name['ArtReef2021.csv']['from'])

    def test_download_mark_survives_a_platform_without_streams(self):
        # On Linux the ADS open raises OSError; the finder must return None, not blow up.
        self.assertIsNone(A.download_mark(self.root / 'ArtReef2021.csv'))

    def test_a_comment_star_is_not_a_glob(self):
        self.assertFalse([g for g in self.globs if g.strip('*/') == ''])



class SelfReferenceIsNotAReference(unittest.TestCase):
    """The finder must not hide the files it was written to find.

    Ryan noticed from memory on 2026-09-04 that G-WRAPVectorData2021 was missing from a report
    of unread sources. It was missing because this script's own header names it as one of the
    three sources found by hand -- and the corpus walked this script. 592.1 MB reported as read
    on the strength of a docstring that says nobody reads it.
    """

    def test_a_docstring_mention_is_not_a_read(self):
        src = ('"""We should really use SCDNROyster2015Live.geojson one day."""\n'
               'x = 1  # and ArtReef2021.csv too\n')
        out = A.strip_py_commentary(src)
        self.assertNotIn('SCDNROyster2015Live', out)
        self.assertNotIn('ArtReef2021', out)

    def test_an_ordinary_string_literal_survives(self):
        """`SC_OYSTER_FILE = DATA_DIR / 'SCDNROyster2015Live.geojson'` IS a read."""
        src = "SC_OYSTER_FILE = DATA_DIR / 'SCDNROyster2015Live.geojson'\n"
        self.assertIn('SCDNROyster2015Live.geojson', A.strip_py_commentary(src))

    def test_a_function_docstring_goes_and_its_body_stays(self):
        src = ('def f():\n'
               '    """Reads georgia_oyster_reef_2015.gpkg some day."""\n'
               "    return open('DMF_ReefGuide_1.geojson')\n")
        out = A.strip_py_commentary(src)
        self.assertNotIn('georgia_oyster', out)
        self.assertIn('DMF_ReefGuide_1.geojson', out)

    def test_unparseable_python_is_kept_whole_rather_than_lost(self):
        """Losing a reader is worse than keeping a comment. Broken source keeps everything."""
        src = "def (((: 'oyster_beds.geojson'\n"
        self.assertIn('oyster_beds.geojson', A.strip_py_commentary(src))

    def _corpus_with_self_copied_in(self):
        """A scripts/ dir holding this script, its test, and one honest reader."""
        here = Path(A.__file__).resolve()
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        root = Path(d)
        (root / 'scripts').mkdir()
        for name in (here.name, 'test_' + here.name):
            src = here.parent / name
            if src.exists():
                shutil.copy(str(src), str(root / 'scripts' / name))
        (root / 'scripts' / 'reader.py').write_text(
            '"""One day we should read G-WRAPData2021.gdb and ArtReef2021.csv."""\n'
            "SC_OYSTER_FILE = DATA_DIR / 'SCDNROyster2015Live.geojson'\n"
            '# and georgia_oyster_reef_2015.gpkg is on the drive too\n', encoding='utf-8')
        return A.build_corpus(root)

    def test_the_three_it_was_written_to_find_come_back_unread(self):
        """The regression. Both rules at once, and neither alone is enough.

        `reader.py` names all three ONLY in a docstring and a comment (rule 1), while this
        script's header and its test's fixtures name them as ordinary text and string
        literals (rule 2).
        """
        (tokens, _globs), files = self._corpus_with_self_copied_in()
        self.assertEqual(files, 1, 'the corpus read %d files; only reader.py counts' % files)
        for name in ('g-wrapdata2021.gdb', 'artreef2021.csv',
                     'georgia_oyster_reef_2015.gpkg'):
            self.assertNotIn(name, tokens, '%s is hidden again' % name)

    def test_the_honest_read_beside_them_still_counts(self):
        """The danger of rule 1 is stripping the literal that IS the read."""
        (tokens, _globs), _files = self._corpus_with_self_copied_in()
        self.assertIn('scdnroyster2015live.geojson', tokens)

if __name__ == '__main__':
    unittest.main(verbosity=2)
