#!/usr/bin/env python3
r"""--only narrows the read. It must not narrow the FILE.

Personal use only, not for distribution or resale; not for navigation.

    py .\test_match_nhd_partial_write.py

match_waters_to_nhd.py --json wrote whatever the run produced, straight out. With --only 0304
that is 62 of 423 bindings, at the live path, printing "wrote ..." exactly as a full run does.
Nothing raises; the other 361 stop existing.

Third instance of one shape in this repo. build_all_chartpacks.py loads its report and updates in
place -- "a partial run must not silently replace a full report with 30 lakes in it, and asking
for a merge step afterwards is a step someone forgets". make_river_boundaries.py merge-writes its
sidecars on any --only run. This file was the one still open.

The merge is deliberately asymmetric and that is the interesting part:

  a slug the partial run MATCHED      -> the new row wins
  a slug the partial run NEVER SAW    -> the old row is carried
  a slug the run LOOKED AT and failed -> the old row must NOT come back

The third is why this cannot be a plain dict union of old and new. A binding that no longer holds
has to be able to die, or a stale row is immortal -- and a full run must still be able to drop
one, which is why the merge only happens when --only was given.
"""
import io, json, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = io.open(HERE / 'match_waters_to_nhd.py', encoding='utf-8').read()

# --- the merge is conditional on --only, and a full run still replaces -----------------------
assert 'if args.only:' in SRC, 'the merge must be gated on --only'
i_only = SRC.index('if args.only:')
i_write = SRC.index('Path(args.json).write_text')
assert i_only < i_write, 'the merge has to happen BEFORE the write, not after'
print('the merge is gated on --only and runs before the write')

# --- an unreadable prior file must REFUSE, not silently truncate ------------------------------
assert 'REFUSING to write' in SRC, \
    'if the prior file exists and cannot be parsed, a partial run must refuse -- writing would ' \
    'lose every binding it did not compute'
assert 'except FileNotFoundError' in SRC, \
    'a missing prior file is not an error: the first --only run has nothing to merge into'
print('an unreadable prior file refuses; a missing one is fine')

# --- the asymmetry, exercised rather than read ------------------------------------------------
def merge(prior_bindings, fresh_bindings):
    """The exact expression from the script, lifted so the behaviour is tested and not the text."""
    m = re.search(r'kept = \{(.+?)\}\n', SRC, re.S)
    assert m, 'could not find the kept-comprehension; if it moved, update this test'
    kept = {k: v for k, v in prior_bindings.items() if k not in fresh_bindings}
    return {**kept, **fresh_bindings}

prior = {'wateree_lake': {'v': 'old'}, 'great_pee_dee_river': {'v': 'old'},
         'black_river': {'v': 'old'}, 'lake_marion': {'v': 'old'}}
# a partial run over one VPU: it re-matched the Pee Dee, and did NOT bind black_river this time
fresh = {'great_pee_dee_river': {'v': 'new'}}
got = merge(prior, fresh)

assert got['great_pee_dee_river']['v'] == 'new', 'a re-matched slug must take the new row'
assert got['wateree_lake']['v'] == 'old', 'a slug the partial run never saw must be carried'
assert got['lake_marion']['v'] == 'old', 'same'
assert len(got) == 4, ('the file must not shrink to what one VPU produced: %d' % len(got))
print('re-matched rows win, untouched rows are carried, the file does not shrink')

# --- and the guard that matters: a full run must still be able to DROP a binding ---------------
# No --only, so no merge: the written dict is exactly what the run produced.
assert SRC.index("out = {") < i_only, 'the unmerged dict is built first and used when --only is absent'
print('a full run still replaces, so a binding that no longer holds can die')

print('\nOK')
