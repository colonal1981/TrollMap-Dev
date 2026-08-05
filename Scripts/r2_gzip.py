#!/usr/bin/env python3
"""
r2_gzip.py — one place that decides how a file gets compressed on its way into R2.

Three scripts push JSON to the chartpacks bucket: upload_garmin_to_r2.py (the lake and river
packs), upload_to_r2_coastal.py (the coastal zones) and upload_boundaries_to_r2.py. Each built
its own `node wrangler r2 object put` command line. When gzip went from off to on on 2026-08-05
that was three edits, and the whole point of a shared bucket is that an object's encoding cannot
depend on which script happened to write it -- the Worker reads them all through the same
r2Body()/r2Text() pair.

USE IT LIKE THIS

    from r2_gzip import prepared

    with prepared(local_path, gz=True) as (src, extra_args):
        cmd = ['node', WRANGLER_JS, 'r2', 'object', 'put', f'{BUCKET}/{key}',
               '--file', str(src), '--content-type', 'application/json',
               '--remote', *extra_args]
        subprocess.run(cmd, ...)

The temp file is removed on the way out of the block, including when the upload raises. The old
per-script version cleaned up in a `finally` that three scripts had to each get right; one of
them left `.gz` files in %TEMP% on any exception path.

WHY THE FILENAME IS SCRUBBED

gzip writes the source filename into the header as its FNAME field. That is how the 2026-08-01
double-compression bug was finally identified -- `curl --compressed` printed binary containing
`r2up_<pid>_<hash>`, which could only have come from the INNER layer. Useful once, but it means
a local path rides along inside every object in the bucket. `mtime=0` with an explicit fileobj
writes neither a name nor a timestamp, which also makes the output byte-identical run to run, so
a re-upload of unchanged input produces an unchanged object.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import gzip
import os
import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path

COMPRESSLEVEL = 6  # 9 is ~2% smaller on this data and roughly 3x the CPU; not worth it


@contextmanager
def prepared(local_path, gz: bool):
    """Yield (path_to_upload, extra_wrangler_args). Cleans up the temp file on exit."""
    src = Path(local_path)
    if not gz:
        yield src, []
        return
    fd, tmp_name = tempfile.mkstemp(suffix=".gz", prefix="r2up_")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as raw, \
                gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=COMPRESSLEVEL, mtime=0) as fo, \
                open(src, "rb") as fi:
            shutil.copyfileobj(fi, fo, length=1 << 20)
        yield tmp, ["--content-encoding", "gzip"]
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def ratio(local_path) -> tuple[int, int]:
    """(raw_bytes, gzipped_bytes) for one file, without writing anything. For audits."""
    src = Path(local_path)
    raw = src.stat().st_size
    n = 0
    import io
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=COMPRESSLEVEL, mtime=0) as fo, \
            open(src, "rb") as fi:
        shutil.copyfileobj(fi, fo, length=1 << 20)
    n = buf.tell()
    return raw, n
