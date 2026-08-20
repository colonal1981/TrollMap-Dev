"""test_prune_report.py -- the report prune_r2_objects.py did not write.

Ryan's 6,827-key run reported "failed 10" and kept no file. This proves the three things that
recovery depends on: the failures are all there, the file --list can read it back, and it is
written even when the run was clean.
"""
import importlib.util, os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("pro", os.path.join(HERE, "prune_r2_objects.py"))
pro = importlib.util.module_from_spec(spec); spec.loader.exec_module(pro)


def read_back(path):
    """Exactly what main() does with --list: strip blanks and comments."""
    with open(path, encoding="utf-8-sig") as fh:
        return [l.strip() for l in fh if l.strip() and not l.startswith("#")]


class ReportTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.lst = os.path.join(self.d, "_r2_delete.txt")
        with open(self.lst, "w") as fh:
            fh.write("a/b.json\n")

    def test_every_failure_survives_and_reads_back_as_a_list(self):
        fails = [("lake_%d/contours.geojson" % i, "Error: rate limited") for i in range(10)]
        out = pro.write_report(self.lst, fails, done=6817, skipped=0)
        keys = read_back(out)
        self.assertEqual(len(keys), 10)                       # all ten, not a sample
        self.assertEqual(keys, [k for k, _ in fails])         # in order, unmangled
        for k in keys:                                        # and each is a real object key,
            self.assertIn("/", k)                             # so main()'s own guard passes

    def test_multiline_error_cannot_break_the_format(self):
        out = pro.write_report(self.lst, [("x/y.json", "line one\nline two\n")], 1, 0)
        self.assertEqual(read_back(out), ["x/y.json"])         # the error stays a comment

    def test_written_even_when_nothing_failed(self):
        out = pro.write_report(self.lst, [], done=5, skipped=2)
        self.assertTrue(os.path.exists(out))                   # absent != clean
        self.assertEqual(read_back(out), [])
        with open(out, encoding="utf-8") as fh:
            self.assertIn("0 failed, 5 deleted, 2 already gone", fh.read())

    def test_terse_keeps_the_error_and_drops_the_banner(self):
        """Ryan's ten failures printed the banner and hid the error -- the cut was head-first."""
        out = ('\u26c5\ufe0f wrangler 4.112.0 (update available 4.124.0)\n'
               '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n'
               'Resource location: remote\n'
               'Deleting object "blair_pond/osm-structures.geojson" from bucket "x"...\n\n'
               '\u2718 [ERROR] Internal Server Error [code: 10001]\n')
        t = pro.terse(out)
        self.assertIn('10001', t)                      # the part that names the cause
        self.assertNotIn('wrangler 4.112.0', t)        # not the version banner
        self.assertNotIn('Resource location', t)
        self.assertNotIn('Deleting object', t)

    def test_terse_never_returns_empty_even_if_all_lines_look_like_noise(self):
        self.assertTrue(pro.terse('Deleting object "a/b" from bucket\n'))

    def test_report_sits_beside_the_list_it_came_from(self):
        out = pro.write_report(self.lst, [], 0, 0)
        self.assertEqual(os.path.dirname(out), os.path.dirname(self.lst))


if __name__ == "__main__":
    unittest.main(verbosity=2)
