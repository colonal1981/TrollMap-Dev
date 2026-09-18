#!/usr/bin/env python3
"""When verify_registry_r2.py is allowed to say the bucket matches the disk.

2026-09-18. Ryan ran the uploader (191 objects, 0 failed) and then, from `C:\\Users\\Ryan`:

    py F:\\TrollMapPipeline\\scripts\\verify_registry_r2.py

`--registry` defaulted to `./registry`, which under that shell meant `C:\\Users\\Ryan\\registry`
-- a directory that does not exist. So every row found no local file, every verdict read
`served; NO LOCAL COPY to compare`, and the footer printed

    All 20 registry objects are published and match the local files.

and exited 0. Twenty fetches, nought comparisons, and an assurance. The file's own docstring
says three sessions in a row trusted an artefact that had not answered the question; this made
itself the fourth.

Two causes, and either one alone reproduces it, so both are pinned here:

    the registry directory was ASSUMED off the shell's working directory, not FOUND
    `NO LOCAL COPY` was not counted as anything -- it was neither a pass nor a problem

The green sentence is the thing under test. It may only be printed when every object in FILES
was fetched, compared against a real local file, and matched. Anything else is exit 1.

Run: py .\\scripts\\test_verify_registry_green.py

Personal use only, not for distribution or resale; not for navigation.
"""
import contextlib, io, json, os, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import verify_registry_r2 as V                                  # noqa: E402

GREEN = 'match the local files'
# Two rows, both 'raw', so the uploader's slim functions are out of the picture. What is being
# tested is the bookkeeping between the fetch and the footer, not any projection.
FILES = [('lake_index.json', 'lake_index.json', 'raw', 'lake-registry.js fetches this on load'),
         ('water_bindings.json', 'water_bindings.json', 'raw', 'conditions.js answers off this')]


def eq(g, w, m):
    assert g == w, f'{m}: got {g!r} want {w!r}'


def run(argv, cwd, files=FILES, serve=None):
    """main() with argv and a working directory, and the network replaced by `serve`.

    `serve(url) -> obj` stands in for the Worker; None means 404. Nothing here touches R2 --
    a test that needs the bucket up is a test that gets skipped.
    """
    was, argv0, files0, fetch0 = os.getcwd(), sys.argv, V.FILES, V.fetch
    os.chdir(cwd)
    sys.argv = ['verify_registry_r2.py'] + argv
    V.FILES = files
    if serve is not None:
        V.fetch = lambda url, t: ((serve(url), 123, None) if serve(url) is not None
                                  else (None, 0, '404 NOT IN THE BUCKET'))
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            rc = V.main()
    finally:
        os.chdir(was)
        sys.argv, V.FILES, V.fetch = argv0, files0, fetch0
    return rc, buf.getvalue()


def registry(root, **files):
    """A registry dir under `root`. lake_index.json is what makes a directory a registry."""
    reg = Path(root) / 'registry'
    reg.mkdir(parents=True, exist_ok=True)
    for name, obj in files.items():
        (reg / (name + '.json')).write_text(json.dumps(obj), encoding='utf-8')
    return reg


# --- THE DEFECT: served, nothing to compare, and it is NOT a pass -----------------------------
# This is the 2026-09-18 run in miniature. lake_index.json is on disk and matches; nothing on
# disk answers for water_bindings.json. One row verified is not twenty, and is not a green.
with tempfile.TemporaryDirectory() as t:
    reg = registry(t, lake_index={'a': 1})
    rc, out = run(['--registry', str(reg)], t,
                  serve=lambda u: {'a': 1} if 'lake_index' in u else {'z': 9})
    eq(rc, 1, 'a row that could not be compared is exit 1')
    assert GREEN not in out, 'and it must NOT say the bucket matches the disk'
    assert 'PUBLISHED BUT NOT COMPARED' in out, 'it says what it did not do'
    assert 'water_bindings.json' in out, 'and names the object it did not do it to'
    assert 'OK -- current' in out, 'the row it COULD compare is still reported as current'

# --- the green is still reachable, and is counted over what was compared ----------------------
with tempfile.TemporaryDirectory() as t:
    reg = registry(t, lake_index={'a': 1}, water_bindings={'z': 9})
    rc, out = run(['--registry', str(reg)], t,
                  serve=lambda u: {'a': 1} if 'lake_index' in u else {'z': 9})
    eq(rc, 0, 'every object fetched, compared and current is exit 0')
    assert 'All 2 registry objects are published and %s.' % GREEN in out, \
        'and says so with a count, not a spelled-out number'

    # Formatting is not staleness. The wire is gzipped and the disk is indented; canon() is the
    # whole reason this script compares objects instead of bytes.
    (reg / 'water_bindings.json').write_text('{\n  "z" :  9\n}\n', encoding='utf-8')
    rc, _ = run(['--registry', str(reg)], t,
                serve=lambda u: {'a': 1} if 'lake_index' in u else {'z': 9})
    eq(rc, 0, 'whitespace and key order do not make an object stale')

# --- a real difference is still caught -------------------------------------------------------
with tempfile.TemporaryDirectory() as t:
    reg = registry(t, lake_index={'a': 1}, water_bindings={'z': 10})
    rc, out = run(['--registry', str(reg)], t,
                  serve=lambda u: {'a': 1} if 'lake_index' in u else {'z': 9})
    eq(rc, 1, 'a bucket that differs from disk is exit 1')
    assert 'STALE' in out, 'and says stale'

    rc, out = run(['--registry', str(reg)], t, serve=lambda u: None)
    eq(rc, 1, 'a 404 is exit 1')
    assert 'PROBLEM(S)' in out and 'NOT IN THE BUCKET' in out, 'and is a problem, not an unknown'

# --- the registry is FOUND, and the output says which one it found ----------------------------
# Printing the absolute path is not decoration. The 2026-09-18 output DID print
# `registry C:\\Users\\Ryan\\registry` and it read as a detail because the footer was green.
with tempfile.TemporaryDirectory() as t:
    reg = registry(t, lake_index={'a': 1}, water_bindings={'z': 9})
    rc, out = run([], t, serve=lambda u: {'a': 1} if 'lake_index' in u else {'z': 9})
    eq(rc, 0, 'a registry beside the working directory is found without the flag')
    assert 'beside the working directory' in out, 'and the header says which candidate won'
    assert str(reg) in out, 'by absolute path'

# --- nowhere to look is a hard stop, not a comparison against nothing -------------------------
#
# resolve_registry() IS CALLED DIRECTLY HERE, not through main(), and that is deliberate. Driven
# through main() this case asserted "no registry was found" while standing in a temp directory on
# the machine that HAS one: the last candidate is the pipeline root, `F:\TrollMapPipeline\registry`
# was found exactly as designed, and the test failed on its own premise rather than on the code.
# A test that only passes on a checkout with no pipeline beside it is a test that fails on the one
# machine this runs on.
with tempfile.TemporaryDirectory() as t:
    island = Path(t) / 'a' / 'b' / 'c'                  # nothing named registry at any depth
    island.mkdir(parents=True)
    was = os.getcwd()
    os.chdir(island)
    try:
        found, tried = V.resolve_registry(None, str(island))
    finally:
        os.chdir(was)
    eq(found, None, 'no candidate holds a registry, so none is returned')
    eq(len(tried), 3, 'and every place it looked is reported')
    assert all('registry' in line for line in tried), 'by path'

# ... and main() stops on that before it fetches anything.
with tempfile.TemporaryDirectory() as t:
    real, V.resolve_registry = V.resolve_registry, lambda e, h: (None, ['-- nowhere/registry'])
    try:
        rc, out = run([], t, serve=lambda u: {'a': 1})
    finally:
        V.resolve_registry = real
    eq(rc, 1, 'no registry anywhere is exit 1')
    assert 'NO REGISTRY DIRECTORY' in out, 'and says so first'
    assert GREEN not in out, 'and never says the bucket matches anything'
    assert 'worker   ' not in out, 'and does not fetch twenty objects it cannot use'
    assert 'nowhere/registry' in out, 'and lists the places it looked'

# --- a path given explicitly is not silently replaced by one that works -----------------------
with tempfile.TemporaryDirectory() as t:
    registry(t, lake_index={'a': 1}, water_bindings={'z': 9})       # a good one beside the cwd
    # The good one must NOT rescue the bad path. This is the case where a fall-back would be a
    # bug: he named a directory, and being quietly given a different one is how a green gets
    # printed about a disk he did not mean.
    rc, out = run(['--registry', str(Path(t) / 'typo')], t, serve=lambda u: {'a': 1})
    eq(rc, 1, 'a --registry that does not exist is a failure, not a hint')
    assert str(Path(t) / 'typo') in out, 'and the wrong path is named'

    # An empty directory called `registry` is not a registry. Accepting one is how a fresh
    # checkout gets a green from a folder holding nothing.
    hollow = Path(t) / 'hollow' / 'registry'
    hollow.mkdir(parents=True)
    rc, out = run(['--registry', str(hollow)], t, serve=lambda u: {'a': 1})
    eq(rc, 1, 'a registry with no lake_index.json is not a registry')
    assert 'holds no lake_index.json' in out, 'and it says what was missing'

# --- every object the uploader publishes is on the list --------------------------------------
# The docstring records this drift three times: the uploader learned to ship a file, this list
# did not, and the footer counted a green over a bucket that could have been missing it.
import upload_garmin_to_r2 as ug                                    # noqa: E402
_named = {name for name, _l, _k, _w in V.FILES}
for _p in getattr(ug, 'PASSTHROUGH_REGISTRIES', {}):
    assert _p in _named, f'the uploader publishes {_p} and the checker does not name it'

print('ALL verify_registry_r2 footer assertions pass')
print('the green sentence needs every object fetched, compared and current -- '
      'a registry it could not find, or could not read, is exit 1')
