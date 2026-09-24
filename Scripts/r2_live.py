#!/usr/bin/env python3
"""
r2_live.py -- what the bucket actually holds, asked of the bucket rather than of our own notes.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.

WHY THIS EXISTS

`chartpack/_r2_manifest.json` is the uploader's record of what it SENT, keyed on each local
file's size and modification time. On 2026-09-24 it said 1,628 pack files were waiting to go up.
Checked against the live copies, 1,569 of them were byte-for-byte what R2 already served: the
09-21 morning rebuild had re-saved them with the same content and a new timestamp. A timestamp
counts what a run touched, not what it changed -- the same trap as "283 poisoned" on 09-21.

THE CHECK COSTS NO DOWNLOAD

The Worker serves every pack file at /chartpacks/<slug>/<file> with R2's ETag, and answers a
matching If-None-Match with a bodyless 304. R2's ETag for an object put in one piece is the MD5 of
the stored bytes, and r2_gzip.prepared() compresses with mtime=0 and no filename, so the same input
always gzips to the same bytes. Measured 2026-09-24 on six packs: md5(gzip(local)) equalled the
live ETag on every file whose content matched, and differed on the two that did not.

So "is this file already live?" is one conditional GET that returns no body when the answer is yes.

NO CREDENTIALS. Everything here goes through the public Worker route; nothing reads a token.
"""
from __future__ import annotations

import gzip
import hashlib
import io
import shutil
import urllib.error
import urllib.request

from r2_gzip import COMPRESSLEVEL

WORKER = "https://trollmap-worker.colonal1981.workers.dev"
UA = "TrollMap pipeline (r2_live.py)"


def upload_bytes_md5(path, gz: bool = True) -> str:
    """MD5 hex of exactly the bytes the uploader would put in R2 for this file -- the object's
    ETag once it is there. Gzipped the way r2_gzip.prepared() does it: same level, mtime=0."""
    h = hashlib.md5()
    if not gz:
        with open(path, "rb") as fi:
            for chunk in iter(lambda: fi.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=COMPRESSLEVEL, mtime=0) as fo, \
            open(path, "rb") as fi:
        shutil.copyfileobj(fi, fo, length=1 << 20)
    h.update(buf.getvalue())
    return h.hexdigest()


def live_state(key: str, etag: str, worker: str = WORKER, timeout: int = 120):
    """'same' when the live object's ETag is `etag` (a 304, no body sent); 'differs' when the
    bucket holds something else; 'absent' when it holds nothing under that key; None when the
    question could not be asked. A caller must never read None as "unchanged"."""
    req = urllib.request.Request(f"{worker.rstrip('/')}/chartpacks/{key}",
                                 headers={"User-Agent": UA, "If-None-Match": f'"{etag}"'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            # 200: a different object. Leave without reading the body.
            live = (r.headers.get("ETag") or "").strip('"')
            return "same" if live == etag else "differs"
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return "same"
        if e.code == 404:
            return "absent"
        return None
    except Exception:
        return None


def fetch_live(key: str, worker: str = WORKER, timeout: int = 600):
    """(bytes, etag) of the live object as the Worker serves it -- decompressed, the same bytes
    the pack held on the drive when it was uploaded -- or (None, None) when the bucket has none."""
    req = urllib.request.Request(f"{worker.rstrip('/')}/chartpacks/{key}",
                                 headers={"User-Agent": UA, "Accept-Encoding": "identity"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            if (r.headers.get("Content-Encoding") or "").lower() == "gzip":
                body = gzip.decompress(body)
            return body, (r.headers.get("ETag") or "").strip('"')
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, None
        raise
