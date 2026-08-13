#!/usr/bin/env python3
r"""pack_stamp.py - one place that answers "does this pack need rebuilding?"

Personal use only, not for distribution or resale; not for navigation.

    from pack_stamp import is_current, record

    if not force and is_current(pack, 'structure.geojson', INPUTS, params):
        return 'current'
    ...
    record(pack, 'structure.geojson', INPUTS, params)

WHY THIS EXISTS

Ryan, 2026-08-13: *"make the scripts so that they know if they need to rerun or not... meaning
if something changed or not"*.

`00_START_HERE` has said "compare mtimes of an output and its inputs before concluding a rebuild
is needed" since 2026-08-12, and nothing enforced it. A card-wide pass recomputed 543 packs of
trolling runs that were already current, because a work list confused a destroyed REPORT with
destroyed DATA and the only way to be sure was to rebuild everything.

WHY A SIDECAR AND NOT A FIELD IN THE OUTPUT

`build_trolling_runs.py` first carried its stamp inside its own GeoJSON, which is tidy -- delete
the output and the stamp goes with it. `water_graph.bin` cannot do that; it is a packed binary
with no room for a JSON blob. Four builders needed the same answer and two of them write text
while one writes bytes, so the stamp lives beside them all in `<pack>/_stamps.json`, keyed by
output filename.

The one hazard a sidecar introduces is a stamp outliving the file it describes -- delete
structure.geojson by hand and the stamp still claims it is current. `is_current()` checks that
the output EXISTS before it believes anything, which closes that.

THE SETTINGS ARE PART OF THE KEY

Not just input mtimes. `--chord-m 400` and `--chord-m 0` produce different trolling runs from
byte-identical contours; `--relief-m` does the same to water features. An mtime-only check calls
the second run unnecessary and goes on serving the first one's answer, which is precisely how a
stale contour file survived a rebuild on 2026-08-06 and shipped.

Anything unreadable, missing or unrecognised means REBUILD. This module never guesses in the
direction of doing less work.
"""
import json, os

STAMPS = '_stamps.json'


def _read(pack):
    try:
        with open(os.path.join(pack, STAMPS), encoding='utf-8') as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def stamp(pack, inputs, params):
    """The identity of a build: its settings, and every input's size and mtime.

    An input that does not exist is recorded as absent rather than skipped, because "the pack
    gained a depth_areas.geojson since last time" has to read as a change.
    """
    out = {'params': [_plain(p) for p in params], 'inputs': {}}
    for f in inputs:
        p = os.path.join(pack, f) if not os.path.isabs(f) else f
        if os.path.exists(p):
            st = os.stat(p)
            out['inputs'][f] = [st.st_size, int(st.st_mtime)]
        else:
            out['inputs'][f] = None
    return out


def _plain(v):
    """argparse values only. A tuple and a list must not read as different settings."""
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    return v


def is_current(pack, output, inputs, params):
    """True only when `output` exists AND was built from exactly these inputs and settings."""
    if not os.path.exists(os.path.join(pack, output)):
        return False                       # the stamp can outlive the file; the file decides
    prev = _read(pack).get(output)
    return bool(prev) and prev == stamp(pack, inputs, params)


def record(pack, output, inputs, params):
    """Write this pack's stamp for `output`, keeping the other builders' entries.

    Atomic, because a half-written _stamps.json reads as unreadable, which means every builder
    rebuilds every pack -- expensive, but never wrong, which is the correct way round.
    """
    d = _read(pack)
    d[output] = stamp(pack, inputs, params)
    tmp = os.path.join(pack, STAMPS + '.tmp')
    try:
        with open(tmp, 'w', encoding='utf-8') as fh:
            json.dump(d, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, os.path.join(pack, STAMPS))
    except OSError:
        pass                               # a stamp that cannot be written costs time, not data
