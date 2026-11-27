"""test_rgn4_block2_len.py -- a point record's type&2 block is as long as it says it is.

Personal use only, not for distribution or resale; not for navigation.

    py Scripts\\test_rgn4_block2_len.py

The bytes are Marion's (B4E0F3): two mode-5/1 sub-blocks from Garmin's 2026-10-23 issue, where the
type&2 block is `81 05 xx xx` (4 bytes), and one from the August issue, where it is `81 07 xx xx xx`
(5). The fixed 5 framed the first two wrong and Marion's timber went 321 -> 47. And check_extract.py,
which would have stopped that run at the extract, stops on exactly that tile.
"""
import gzip, json, os, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rgn4_grammar as G  # noqa: E402
import check_extract as C  # noqa: E402

NOV_2 = bytes.fromhex('012b0092fe1a0900037d014cffa9080081050305')                  # stated 2 records
NOV_3 = bytes.fromhex('01d6019f01b8080003980044fda908008105030503500323fe79060081050305')  # stated 3
AUG_1 = bytes.fromhex('03fa05f3fdcb08008107210811')                                # one 13-byte record


def test_the_block_states_its_length():
    for b, n in ((NOV_2, 2), (NOV_3, 3), (AUG_1, 1)):
        recs, used = G.walk(b, '5/1')
        assert used == len(b) and len(recs) == n, (b.hex(), len(recs), used)
    recs, _ = G.walk(NOV_3, '5/1')
    assert [r['len'] for r in recs] == [8, 12, 12]
    assert recs[1]['ref'] == 0x0008a9                       # "Flooded Timber" in the November pool


def test_an_unrecognised_block_keeps_five():
    assert G.block2_len(bytes.fromhex('e00900000000'), 0) == 5
    assert G.block2_len(bytes.fromhex('8106'), 0) == 5      # even L is not the length form
    assert G.block2_len(bytes.fromhex('8107aabbcc'), 0) == 5
    assert G.block2_len(bytes.fromhex('8105aabb'), 0) == 4


def _pois(path, timber, mismatch, box):
    feats = [{'type': 'Feature', 'properties': {'poi_type': 'flooded_timber'},
              'geometry': {'type': 'Point', 'coordinates': [-80.46, 33.52]}}] * timber
    doc = {'type': 'FeatureCollection', 'properties': {'qa': {'count_mismatch': mismatch, 'box_violation': box}},
           'features': feats}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, 'wt', encoding='utf-8') as f:
        json.dump(doc, f)


def test_the_check_stops_on_marions_morning():
    with tempfile.TemporaryDirectory() as d:
        old, new = os.path.join(d, 'old', 'pois', 'B4E0F3.geojson.gz'), os.path.join(d, 'new', 'pois', 'B4E0F3.geojson.gz')
        _pois(old, 321, 8, 74)
        _pois(new, 47, 38, 57)
        stop, _ = C.compare('pois', 'B4E0F3', C.measure(old, 'pois'), C.measure(new, 'pois'))
        assert any('count_mismatch rose 8 -> 38' in s for s in stop), stop
        assert any('flooded_timber 321 -> 47' in s for s in stop), stop
        _pois(new, 344, 0, 0)                                # the fixed reader on August's tile
        stop, _ = C.compare('pois', 'B4E0F3', C.measure(old, 'pois'), C.measure(new, 'pois'))
        assert stop == [], stop


if __name__ == '__main__':
    test_the_block_states_its_length()
    test_an_unrecognised_block_keeps_five()
    test_the_check_stops_on_marions_morning()
    print('ok: 3 tests')
