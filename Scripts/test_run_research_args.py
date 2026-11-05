#!/usr/bin/env python3
r"""test_run_research_args.py -- run_research.ps1 takes its parameters by name only.

    py .\Scripts\test_run_research_args.py

Personal use only, not for distribution or resale; not for navigation.

Ryan, 2026-11-05, typed into PowerShell 5.1 from F:\TrollMapPipeline:

    powershell -ExecutionPolicy Bypass -File ...\run_research.ps1 -Run '--lake "Wateree Lake" --reports-only' -Detach
    No stored key at Lake --reports-only -- run Scripts\save_research_token.ps1 once first.

`powershell -File` hands the new process that string with its inner quotes dropped, so -Run got "--lake Wateree"
and "Lake --reports-only" was bound by position to -KeyFile. The key was where it always was. Parameters are
named-only now, so a stray word stops the script before it reads anything, saying what it could not place.

The script's own param block is copied out and run alone: nothing here reads the key or starts a run. On a machine
without Windows PowerShell only the source check runs.
"""
import os, re, shutil, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'run_research.ps1')
PS = shutil.which('powershell')


def param_block():
    with open(SCRIPT, encoding='utf-8') as fh: src = fh.read()
    m = re.search(r'^\[CmdletBinding\([^)]*\)\]\s*\nparam\((?:.*?\n)*?\)\s*$', src.replace('\r\n', '\n'), re.M)
    return m.group(0) if m else None


def bind(*args):
    """What the param block binds when started the way Ryan starts it: (exit code, output)."""
    d = tempfile.mkdtemp()
    try:
        probe = os.path.join(d, 'probe.ps1')
        with open(probe, 'w', encoding='utf-8') as fh:
            fh.write(param_block() + '\nWrite-Output ("RUN=[{0}] KEYFILE=[{1}]" -f $Run, $KeyFile)\n')
        # Through a PowerShell parent, as typed at his prompt: the parent is what drops the quotes.
        line = "& powershell -NoProfile -ExecutionPolicy Bypass -File '%s' %s" % (probe, ' '.join(args))
        r = subprocess.run([PS, '-NoProfile', '-Command', line], capture_output=True, text=True, timeout=120)
        return r.returncode, r.stdout + r.stderr
    finally:
        shutil.rmtree(d, ignore_errors=True)


class NamedOnly(unittest.TestCase):
    def test_no_default_reads_the_scripts_own_folder(self):
        # With [CmdletBinding()], PowerShell 5.1 leaves $PSScriptRoot empty while it binds the defaults: the first
        # version of this fix put Split-Path $PSScriptRoot there, and every run, -Check included, stopped on it.
        self.assertNotIn('$PSScriptRoot', param_block())

    def test_the_parameters_are_named_only(self):
        block = param_block()
        self.assertIsNotNone(block, 'the param block lost its [CmdletBinding(...)]')
        self.assertIn('PositionalBinding = $false', block)

    @unittest.skipUnless(PS and os.name == 'nt', 'needs Windows PowerShell')
    def test_a_name_with_spaces_unescaped_stops_and_says_why(self):
        code, out = bind("-Run '--lake \"Wateree Lake\" --reports-only'", '-Detach')
        self.assertNotEqual(code, 0)
        self.assertIn('positional parameter', out)
        self.assertNotIn('KEYFILE=[Lake', out, 'a stray word was read as the key file again')

    @unittest.skipUnless(PS and os.name == 'nt', 'needs Windows PowerShell')
    def test_the_two_ways_that_work(self):
        code, out = bind("-Run '--lake wateree_lake --reports-only'", '-Detach')
        self.assertEqual(code, 0, out)
        self.assertIn('RUN=[--lake wateree_lake --reports-only]', out)
        code, out = bind("-Run '--lake \\\"Wateree Lake\\\" --reports-only'", '-Detach')
        self.assertEqual(code, 0, out)
        self.assertIn('RUN=[--lake "Wateree Lake" --reports-only]', out)
        self.assertIn('research_key.dat]', out, 'the key file is the stored one')


if __name__ == '__main__':
    unittest.main()
