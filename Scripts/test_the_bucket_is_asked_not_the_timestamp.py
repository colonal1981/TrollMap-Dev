#!/usr/bin/env python3
"""test_the_bucket_is_asked_not_the_timestamp.py

Personal use only, not for distribution or resale; not for navigation.

On 2026-09-24 the uploader's manifest said 1,628 pack files were waiting to upload, because it keys
off size and modification time. 1,569 of them were byte-for-byte what R2 already served. These test
the two things built from that: r2_live.py, which asks the bucket (md5 of the exact upload bytes,
sent as If-None-Match), and download_pack_from_r2.py, the first way back from R2 to the drive.

    py Scripts\\test_the_bucket_is_asked_not_the_timestamp.py
"""
import gzip
import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r2_live  # noqa: E402
from r2_gzip import prepared  # noqa: E402
import download_pack_from_r2 as dl  # noqa: E402

BODY = json.dumps({"type": "FeatureCollection", "features": [{"id": i} for i in range(500)]}).encode()


def test_the_etag_is_the_upload_bytes_and_ignores_the_timestamp():
    with tempfile.TemporaryDirectory() as t:
        a, b = Path(t, 'a.geojson'), Path(t, 'b.geojson')
        a.write_bytes(BODY)
        b.write_bytes(BODY)
        os.utime(b, (time.time() - 86400 * 30, time.time() - 86400 * 30))
        assert r2_live.upload_bytes_md5(a) == r2_live.upload_bytes_md5(b), 'same bytes, new mtime'
        # And it is the md5 of exactly what prepared() hands wrangler -- the object's ETag.
        import hashlib
        with prepared(a, True) as (src, _extra):
            assert r2_live.upload_bytes_md5(a) == hashlib.md5(Path(src).read_bytes()).hexdigest()
        b.write_bytes(BODY + b' ')
        assert r2_live.upload_bytes_md5(a) != r2_live.upload_bytes_md5(b), 'one byte changes it'


def _pack(t):
    root = Path(t, 'chartpack')
    (root / 'lake_x').mkdir(parents=True)
    for n in ('contours.geojson', 'depth_areas.geojson', 'waterbody.geojson', 'pois.geojson'):
        (root / 'lake_x' / n).write_bytes(BODY + n.encode())
    return root


def test_the_report_says_same_differs_not_live_and_unknown():
    with tempfile.TemporaryDirectory() as t:
        root = _pack(t)
        states = {'lake_x/contours.geojson': 'same', 'lake_x/depth_areas.geojson': 'differs',
                  'lake_x/waterbody.geojson': 'absent', 'lake_x/pois.geojson': None}
        rows = dl.plan(root, 'lake_x', None, 'w', live_state=lambda k, e, w: states[k])
        got = {n: s for n, s, _ in rows}
        assert got == {'contours.geojson': 'SAME', 'depth_areas.geojson': 'DIFFERS',
                       'waterbody.geojson': 'NOT LIVE', 'pois.geojson': 'UNKNOWN'}, got
        rows = dl.plan(root, 'lake_x', ['nope.geojson'], 'w', live_state=lambda *a: 'same')
        assert rows[0][1] == 'NOT ON DRIVE'


def test_restore_moves_the_drive_copy_aside_and_records_what_is_now_there():
    with tempfile.TemporaryDirectory() as t:
        root = _pack(t)
        live = b'{"type":"FeatureCollection","features":[{"id":"the live one"}]}'
        manifest = {'lake_x/depth_areas.geojson': {'size': 1, 'mtime': 1, 'gzip': True}}
        aside = dl.restore(root, 'lake_x', 'depth_areas.geojson', manifest, 'w', '2026-09-24',
                           fetch=lambda k, w: (live, 'etag'))
        assert aside == Path(t, '_to_delete', 'packs_replaced_2026-09-24', 'lake_x', 'depth_areas.geojson')
        assert aside.read_bytes() == BODY + b'depth_areas.geojson', 'the drive copy is kept, not deleted'
        assert (root / 'lake_x' / 'depth_areas.geojson').read_bytes() == live
        m = manifest['lake_x/depth_areas.geojson']
        assert m['size'] == len(live) and m['etag'] == r2_live.upload_bytes_md5(root / 'lake_x' / 'depth_areas.geojson')
        assert m['mtime'] == int((root / 'lake_x' / 'depth_areas.geojson').stat().st_mtime)


def test_nothing_is_touched_when_the_bucket_has_nothing():
    with tempfile.TemporaryDirectory() as t:
        root = _pack(t)
        manifest = {}
        assert dl.restore(root, 'lake_x', 'waterbody.geojson', manifest, 'w', 'd',
                          fetch=lambda k, w: (None, None)) is None
        assert (root / 'lake_x' / 'waterbody.geojson').read_bytes() == BODY + b'waterbody.geojson'
        assert manifest == {}
        assert not Path(t, '_to_delete').exists()


def test_the_uploader_asks_the_bucket_before_it_pushes():
    src = Path(__file__).with_name('upload_garmin_to_r2.py').read_text(encoding='utf-8')
    assert 'r2_live.live_state(k, m)' in src
    assert '"--no-live-check"' in src
    assert 'if state == "same":' in src


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print('ok ', name)
