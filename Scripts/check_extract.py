#!/usr/bin/env python3
r"""check_extract.py -- a new extract against the last one, tile by tile, before anything is built on it.

Personal use only, not for distribution or resale; not for navigation.

    py F:\TrollMapPipeline\TrollMap-Dev\Scripts\check_extract.py `
       --old F:\TrollMapPipeline\extract_2026-08-21 --new F:\TrollMapPipeline\extract `
       --tiles F:\TrollMapPipeline\outputs\ship_tiles.txt --report F:\TrollMapPipeline\_scratch\check_extract.json

Exit 1 when a tile got worse in a way that means the READER, not Garmin, may have changed what it gets.

WHY. On 2026-11-26 Garmin's 10/23 issue of Marion's basemap tile wrote a 4-byte variant of a point
block the grammar held at 5 bytes. The reader framed 38 sub-blocks wrong (8 on August's tile), and
Marion's flooded timber went 321 -> 47. The extract finished "ok", every step after it ran on it,
and it was found at 8 pm from a screenshot. The reader had counted its own failures the whole time;
nothing compared them with the last extract. This does.

WHAT STOPS THE RUN (per tile, per layer):
  * the reader's own failure counts rose -- points: sub-blocks that missed their stated record
    count, points outside their own subdivision; contours: depth tags off a record boundary;
    lines and areas: rows that do not close. These are the reader saying it did not understand
    part of the file. Rising by a handful is noise between two issues of a tile, so a count
    has to rise by more than 3 AND by more than a tenth of what it was; a percentage by more
    than half a point.
  * a point type or a layer lost more than half of what it had, where it had at least 20 --
    Marion's timber (321 -> 47) is this. Garmin can legitimately thin a tile (it did thin
    Marion, to about half), so this one is a stop to LOOK, and the report says which.
  * a tile that had a layer no longer has it.

What it does not stop on is printed anyway: every layer's count by tile, largest changes first.
"""
from __future__ import annotations
import argparse, gzip, json, os, re, sys
from collections import Counter
from concurrent.futures import ProcessPoolExecutor

NOTE = 'Personal use only, not for distribution or resale; not for navigation.'
FEAT = re.compile(rb'"type":\s*"Feature"[,}]')
COUNT_RISE, COUNT_FRAC, PCT_DROP = 3, 0.10, 0.5
HALF, MIN_FOR_HALF = 0.5, 20


def _open(p):
    return gzip.open(p, 'rb') if p.endswith('.gz') else open(p, 'rb')


def _find(root, layer, tile):
    for ext in ('.geojson.gz', '.geojson', '.json.gz', '.json'):
        p = os.path.join(root, layer, tile + ext)
        if os.path.exists(p):
            return p
    return None


def measure(path, layer):
    """(features, qa, types) for one tile file. Points are read whole (they are small); the big
    layers are counted by streaming, and their qa read off the head, where fc() writes it."""
    if layer == 'pois':
        with _open(path) as f:
            d = json.load(f)
        types = Counter((x.get('properties') or {}).get('poi_type') or '?' for x in d.get('features', []))
        return len(d.get('features', [])), (d.get('properties') or {}).get('qa'), dict(types)
    n, head, tail = 0, b'', b''
    with _open(path) as f:
        while True:
            chunk = f.read(1 << 22)
            if not chunk:
                break
            if len(head) < 8192:
                head += chunk[:8192 - len(head)]
            buf = tail + chunk
            n += len(FEAT.findall(buf)) - len(FEAT.findall(tail))
            tail = buf[-64:]
    qa = None
    i = head.find(b'"qa":')
    if i >= 0:
        j = head.find(b'}', i)
        try:
            qa = json.loads(head[i + 5:j + 1])
        except Exception:
            qa = None
    return n, qa, None


def _job(args):
    root, layer, tile = args
    p = _find(root, layer, tile)
    if not p:
        return (root, layer, tile, None)
    try:
        return (root, layer, tile, measure(p, layer))
    except Exception as e:
        return (root, layer, tile, ('error', '%s: %s' % (type(e).__name__, e), None))


def rose(old, new):
    return old is not None and new is not None and new - old > COUNT_RISE and new - old > COUNT_FRAC * max(old, 1)


def fell_pct(old, new):
    return old is not None and new is not None and old - new > PCT_DROP


def compare(layer, tile, o, n):
    """Lines to stop on, and lines to report, for one tile and layer."""
    stop, note = [], []
    if o is None:
        return stop, note
    if n is None:
        stop.append('%s %s: the old extract has this layer and the new one does not' % (tile, layer))
        return stop, note
    if o[0] == 'error' or n[0] == 'error':
        stop.append('%s %s: could not read (%s)' % (tile, layer, (n if n[0] == 'error' else o)[1]))
        return stop, note
    (no, qo, to), (nn, qn, tn) = o, n
    qo, qn = qo or {}, qn or {}
    for k in ('count_mismatch', 'box_violation', 'out_of_tile', 'arc_missing'):
        if rose(qo.get(k), qn.get(k)):
            stop.append('%s %s: the reader\'s %s rose %s -> %s' % (tile, layer, k, qo.get(k), qn.get(k)))
    for k in ('tag_alignment_pct', 'rows_closing_pct', 'byte_coverage_pct'):
        if fell_pct(qo.get(k), qn.get(k)):
            stop.append('%s %s: the reader\'s %s fell %s -> %s' % (tile, layer, k, qo.get(k), qn.get(k)))
    if qn.get('suspect') and not qo.get('suspect'):
        stop.append('%s %s: the reader marks this tile suspect now and did not before' % (tile, layer))
    if no >= MIN_FOR_HALF and nn < HALF * no:
        stop.append('%s %s: %d -> %d features (lost more than half)' % (tile, layer, no, nn))
    for t in sorted(set(to or {}) | set(tn or {})):
        a, b = (to or {}).get(t, 0), (tn or {}).get(t, 0)
        if a >= MIN_FOR_HALF and b < HALF * a:
            stop.append('%s %s: %s %d -> %d (lost more than half)' % (tile, layer, t, a, b))
    if nn != no:
        note.append((nn - no, '%s %s: %d -> %d features' % (tile, layer, no, nn)))
    return stop, note


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--old', required=True, help='the extract the packs on R2 were built from')
    ap.add_argument('--new', required=True, help='the extract about to be built on')
    ap.add_argument('--layers', default=None, help='comma list; default every layer folder both extracts have')
    ap.add_argument('--tiles', default=None, help='tile ids, comma list or a file one per line (letter optional); '
                                                  'default every tile in the new extract')
    ap.add_argument('--jobs', type=int, default=6)
    ap.add_argument('--report', default=None)
    a = ap.parse_args()
    for r in (a.old, a.new):
        if not os.path.isdir(r):
            sys.exit('not a folder: %s' % r)
    layers = a.layers.split(',') if a.layers else sorted(
        l for l in os.listdir(a.new) if os.path.isdir(os.path.join(a.new, l)) and os.path.isdir(os.path.join(a.old, l)))
    want = None
    if a.tiles:
        src = a.tiles[1:] if a.tiles.startswith('@') else a.tiles
        if os.path.exists(src):
            src = ','.join(l.strip() for l in open(src, encoding='utf-8') if l.strip())
        want = {t.strip().upper()[1:] if t.strip()[:1].isalpha() else t.strip().upper()
                for t in src.split(',') if t.strip()}
    jobs = []
    for layer in layers:
        names = set()
        for r in (a.old, a.new):
            for f in os.listdir(os.path.join(r, layer)):
                if f.startswith('_'):
                    continue
                t = f.split('.')[0]
                if want is None or t[1:].upper() in want:
                    names.add(t)
        for t in sorted(names):
            jobs += [(a.old, layer, t), (a.new, layer, t)]
    print('check_extract: %d layers, %d tile files, old %s, new %s' % (len(layers), len(jobs), a.old, a.new), flush=True)
    got = {}
    with ProcessPoolExecutor(max_workers=a.jobs) as ex:
        for k, (root, layer, tile, m) in enumerate(ex.map(_job, jobs, chunksize=4), 1):
            got[(root, layer, tile)] = m
            if k % 100 == 0:
                print('  %d/%d' % (k, len(jobs)), flush=True)
    stops, notes, totals = [], [], {}
    for layer in layers:
        tiles = sorted({t for (r, l, t) in got if l == layer})
        to = tn = 0
        for t in tiles:
            o, n = got.get((a.old, layer, t)), got.get((a.new, layer, t))
            s, nt = compare(layer, t, o, n)
            stops += s; notes += nt
            to += (o[0] if o and o[0] != 'error' else 0); tn += (n[0] if n and n[0] != 'error' else 0)
        totals[layer] = (to, tn)
    print('\nlayer totals, old -> new:')
    for layer, (to, tn) in totals.items():
        print('   %-14s %9d -> %9d  (%+.1f%%)' % (layer, to, tn, 100.0 * (tn - to) / max(1, to)))
    notes.sort(key=lambda x: x[0])
    print('\nlargest losses (not stops by themselves):')
    for d, s in notes[:15]:
        print('   %s' % s)
    if a.report:
        json.dump({'_note': NOTE, 'old': a.old, 'new': a.new, 'stops': stops,
                   'totals': {k: list(v) for k, v in totals.items()},
                   'changes': [s for _d, s in notes]}, open(a.report, 'w', encoding='utf-8'), indent=1)
    if stops:
        print('\nSTOP -- %d tile/layer(s) got worse. Look before building on this extract:' % len(stops))
        for s in stops:
            print('   %s' % s)
        return 1
    print('\nno tile got worse.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
