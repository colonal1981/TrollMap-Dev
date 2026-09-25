r"""registry_here.py -- the one place a python test asks whether the registry is on this machine.

Personal use only, not for distribution or resale; not for navigation.

`registry/` is pipeline OUTPUT. It sits beside the checkout on Ryan's machine and a cloud checkout
has none of it. A test that reads it used to exit non-zero there, and every cloud session had to
sort "that is just the registry" from a real failure by hand. Now such a test is gated with

    @unittest.skipUnless(registry_has('lake_index.json'), why_missing('lake_index.json'))

and is REPORTED AS SKIPPED, with the file it reads in the reason. It is never passed silently.

WHERE IT LOOKS. Scripts are delivered to BOTH F:/TrollMapPipeline/scripts/ and
F:/TrollMapPipeline/TrollMap-Dev/Scripts/ (see test_feature_type_corrections.find_registry). From the
first, the folder above this one is the pipeline root and holds registry/. From the second it is the
repo root, and the registry is ../registry beside it. That is the rule the registry tests already
used, one copy per file; this is it once. test_registry_here.py fails if lake_index.json is on disk
and this module says it is not.
"""
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_UP1 = os.path.dirname(_HERE)

# The pipeline root when this file sits in <pipeline>/scripts/, else the folder the repo sits in.
ROOT = _UP1 if os.path.isdir(os.path.join(_UP1, 'registry')) else os.path.dirname(_UP1)
REGISTRY = os.path.join(ROOT, 'registry')


def registry_path(name):
    """The absolute path of one registry file."""
    return os.path.join(REGISTRY, name)


def registry_is_here():
    """True when the registry folder exists on this machine."""
    return os.path.isdir(REGISTRY)


def registry_has(*names):
    """True when every one of these registry files is on this machine."""
    return all(os.path.exists(registry_path(n)) for n in names)


def why_missing(*names):
    """The skip reason for a test that reads these registry files."""
    if not registry_is_here():
        return '../registry is not here: this test reads %s' % ', '.join(names)
    absent = [n for n in names if not os.path.exists(registry_path(n))]
    return '../registry has no %s: this test reads it' % ', '.join(absent or names)
