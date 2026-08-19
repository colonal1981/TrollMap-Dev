#!/usr/bin/env python3
r"""A literal %% only escapes inside a format string. In a plain print() it reaches the screen.

Personal use only, not for distribution or resale; not for navigation.

    py .\test_no_literal_percent.py

WHAT THIS CATCHES

    print('   !! more than 5%% unreachable.')          # prints "5%%"
    print('   vertices %d -> %d (%.0f%%)' % (a, b, c)) # prints "12%"  -- correct

The doubling is a rule about `%` FORMATTING, not about strings. Three of these had shipped:
build_trolling_runs.py printed `5%%` and `38%%` in the one message that explains why a river
looks broken, and id_unclaimed_water.py printed `54%%` in the note that tells you a cover score
was measured against a bounding box. Both messages exist to stop someone drawing the wrong
conclusion, and both had a typo in the number.

Nothing crashes, no test failed, and the only way to notice is to read the output -- which is
why this is a test and not a habit. It parses rather than greps, so a `%%` inside a real format
string is never flagged and a `%%` inside a genuinely plain print always is.
"""
import ast, io, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def offenders(root: Path):
    """(file, line, text) for every plain print() whose string carries a literal %%."""
    out = []
    for fp in sorted(root.glob('*.py')):
        # THIS FILE IS THE ONE EXEMPTION AND IT IS NOT A BLIND SPOT. Its own messages are ABOUT
        # a literal %%, so printing one is the intent rather than a typo -- and a checker that
        # fails on its own error message is a checker nobody keeps. Skipping it by name means a
        # second checker file would still be scanned.
        if fp.name == Path(__file__).name:
            continue
        try:
            tree = ast.parse(io.open(fp, encoding='utf-8', errors='ignore').read())
        except SyntaxError:
            continue                      # not ours to judge; py_compile is that test
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and getattr(node.func, 'id', '') == 'print'):
                continue
            for arg in node.args:
                # '...' % (...) is real formatting; so is an f-string; so is .format(...).
                if isinstance(arg, (ast.BinOp, ast.JoinedStr, ast.Call)):
                    continue
                for sub in ast.walk(arg):
                    if isinstance(sub, ast.Constant) and isinstance(sub.value, str) \
                            and '%%' in sub.value:
                        out.append((fp.name, node.lineno, sub.value.strip()[:70]))
    return out


bad = offenders(HERE)
if bad:
    print('%d plain print() call(s) will put a literal %%%% on screen:' % len(bad))
    for f, ln, t in bad:
        print('   %s:%d  %s' % (f, ln, t))
    print('\nDouble a percent only when the string is the left side of a % operator.')
    sys.exit(1)

# and prove the detector can still see one, or a green run means nothing
probe = ast.parse("print('at 5%% of the total')\nprint('at %.0f%% done' % x)\n")
found = []
for node in ast.walk(probe):
    if isinstance(node, ast.Call) and getattr(node.func, 'id', '') == 'print':
        for arg in node.args:
            if isinstance(arg, (ast.BinOp, ast.JoinedStr, ast.Call)):
                continue
            for sub in ast.walk(arg):
                if isinstance(sub, ast.Constant) and '%%' in str(sub.value):
                    found.append(sub.value)
assert len(found) == 1, 'the detector must flag the plain print and spare the formatted one: %r' % found
print('no plain print() will put a doubled percent on screen -- and the detector still\n'
      'catches a planted one, so a green run is not green by accident')
print('\nOK')
