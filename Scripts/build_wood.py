#!/usr/bin/env python3
"""Put the wood he has gone over into the pack: registry/wood/<slug>.json -> <chartpack>/<slug>/wood.geojson.

Personal use only, not for distribution or resale; not for navigation.

WHY THIS EXISTS. Ryan, 2026-10-31, of the trees his sonar recordings showed: *"we could avoid them
on the trolling passes if we know that are bait would be lower than the object... but if the bait is
running higher than the object as you pointed out fish like to sit right on top of those so that
gives us a target possibly"*. And 2026-11-03: *"i am more thinking for planning purposes... i just
don't want to clutter up the screen with waypoints"*. So the wood goes in the pack, the map draws it
behind a button that is off by default, and the plan says what each piece is to each rod
(js/modules/plan-wood.js). No waypoints.

WHAT IT WRITES. One FeatureCollection per water, one Point per piece, and NOTHING DROPPED: a piece
with no reads (seen only off to the side) keeps its place, with no top. Each piece carries:

    id, kind, what, seen, his_mark     as in the source (null where the source has none)
    reads                              every read, exactly as in the source
    height_ft                          the largest bottom_ft - top_ft among its reads, or null

The top is NOT collapsed to one number here. Reads taken at different lake levels are brought to
today's level by the app, which knows today's level and this script does not (wood.js,
topToday()). The source's `level` block rides on the collection, so the app can say what scale a
read's `below_full_pool_ft` is on -- or that the water has none.

A MALFORMED READ FAILS THE RUN and names the piece: a top with no time, a below_full_pool_ft on a
water whose `level` is null, a top under its own bottom, a kind nobody defined. A file the app half
believes is worse than no file.

    py Scripts\\build_wood.py --registry F:\\TrollMapPipeline\\registry `
       --chartpack F:\\TrollMapPipeline\\chartpack            <- dry run: says what it would write
    py Scripts\\build_wood.py --registry ... --chartpack ... --go
    py Scripts\\build_wood.py --registry ... --chartpack ... --only lake_marion --go

Without --go it writes nothing (the same convention as my_launch.py). Then the upload, which is
his to run:

    py Scripts\\upload_garmin_to_r2.py --root F:\\TrollMapPipeline\\chartpack --layers wood --no-boundaries
"""
import argparse
import json
import os
import sys

KINDS = ('wood', 'low_wood', 'no_height', 'unsure')
NOTE = 'Personal use only, not for distribution or resale; not for navigation.'


class Malformed(ValueError):
    """A source file the app must not be handed. The message names the piece."""


def _num(v):
    return v is None or (isinstance(v, (int, float)) and not isinstance(v, bool))


def check_read(slug, pid, i, r, level):
    """Raise Malformed for a read the app cannot stand on. `i` is the read's place, from 1."""
    where = '%s: piece %s, read %d' % (slug, pid, i)
    if not isinstance(r, dict):
        raise Malformed('%s is not an object' % where)
    for k in ('top_ft', 'bottom_ft', 'level_ft', 'below_full_pool_ft'):
        if not _num(r.get(k)):
            raise Malformed('%s: %s is %r, not a number or null' % (where, k, r.get(k)))
    if r.get('top_ft') is not None and not r.get('at'):
        raise Malformed('%s has a top (%s ft) and no time it was read' % (where, r['top_ft']))
    if level is None and r.get('below_full_pool_ft') is not None:
        raise Malformed('%s carries below_full_pool_ft %s on a water whose level is null: '
                        'there is no scale for it to be on' % (where, r['below_full_pool_ft']))
    if level is None and r.get('level_ft') is not None:
        raise Malformed('%s carries level_ft %s on a water whose level is null' % (where, r['level_ft']))
    top, bottom = r.get('top_ft'), r.get('bottom_ft')
    if top is not None and top < 0:
        raise Malformed('%s has a top of %s ft, above the surface' % (where, top))
    if top is not None and bottom is not None and bottom < top:
        raise Malformed('%s has its top (%s ft) under its bottom (%s ft)' % (where, top, bottom))


def height_ft(reads):
    """The largest bottom - top among the reads that have both, to the tenth they are written to."""
    hs = [r['bottom_ft'] - r['top_ft'] for r in reads
          if r.get('top_ft') is not None and r.get('bottom_ft') is not None]
    return round(max(hs), 1) if hs else None


def feature(slug, p, level):
    pid = p.get('id')
    if not pid:
        raise Malformed('%s: a piece with no id' % slug)
    lat, lon = p.get('lat'), p.get('lon')
    if not (_num(lat) and _num(lon)) or lat is None or lon is None \
            or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise Malformed('%s: piece %s has no position (%r, %r)' % (slug, pid, lat, lon))
    if p.get('kind') not in KINDS:
        raise Malformed('%s: piece %s is of kind %r, not one of %s' % (slug, pid, p.get('kind'),
                                                                       ', '.join(KINDS)))
    reads = p.get('reads') or []
    if not isinstance(reads, list):
        raise Malformed('%s: piece %s has reads that are not a list' % (slug, pid))
    for i, r in enumerate(reads, 1):
        check_read(slug, pid, i, r, level)
    return {
        'type': 'Feature',
        'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
        'properties': {
            'id': pid,
            'kind': p['kind'],
            'what': p.get('what'),
            'seen': p.get('seen'),
            'his_mark': p.get('his_mark'),
            'reads': reads,
            'height_ft': height_ft(reads),
        },
    }


def build(doc, slug=None):
    """The source file as the pack's FeatureCollection. Raises Malformed."""
    slug = slug or doc.get('slug')
    if doc.get('slug') and slug and doc['slug'] != slug:
        raise Malformed('%s: the file says it is %s' % (slug, doc['slug']))
    if 'level' not in doc:
        raise Malformed('%s: no `level` -- null where the water has no gauge, never absent' % slug)
    level = doc['level']
    pieces = doc.get('pieces')
    if not isinstance(pieces, list):
        raise Malformed('%s: no pieces[]' % slug)
    feats, seen = [], set()
    for p in pieces:
        f = feature(slug, p, level)
        pid = f['properties']['id']
        if pid in seen:
            raise Malformed('%s: piece %s is in the file twice' % (slug, pid))
        seen.add(pid)
        feats.append(f)
    return {'type': 'FeatureCollection', '_note': NOTE, 'slug': slug, 'level': level,
            'features': feats}


def by_kind(fc):
    out = {}
    for f in fc['features']:
        k = f['properties']['kind']
        out[k] = out.get(k, 0) + 1
    return out


def dumps(fc):
    return json.dumps(fc, ensure_ascii=False, separators=(',', ':'))


def sources(registry, only=None):
    d = os.path.join(registry, 'wood')
    if not os.path.isdir(d):
        return []
    names = sorted(n for n in os.listdir(d) if n.endswith('.json') and not n.startswith('_'))
    out = [(n[:-5], os.path.join(d, n)) for n in names]
    return [s for s in out if s[0] == only] if only else out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True, help='holds wood/<slug>.json')
    ap.add_argument('--chartpack', required=True, help='holds <slug>/, where wood.geojson goes')
    ap.add_argument('--only', default=None, help='one water, by slug')
    ap.add_argument('--go', action='store_true', help='write; without it nothing is touched')
    a = ap.parse_args(argv)

    todo = sources(a.registry, a.only)
    if not todo:
        print('!! no %s in %s' % ('wood/%s.json' % a.only if a.only else 'wood/*.json', a.registry))
        return 2
    built = []
    for slug, path in todo:
        with open(path, encoding='utf-8') as fh:
            doc = json.load(fh)
        try:
            fc = build(doc, slug)
        except Malformed as e:
            print('!! %s -- nothing written' % e)
            return 2
        pack = os.path.join(a.chartpack, slug)
        if not os.path.isdir(pack):
            print('!! %s: no pack folder at %s -- is the slug right? nothing written' % (slug, pack))
            return 2
        built.append((slug, fc, os.path.join(pack, 'wood.geojson')))

    for slug, fc, out in built:
        kinds = ', '.join('%d %s' % (n, k) for k, n in sorted(by_kind(fc).items()))
        reads = sum(len(f['properties']['reads']) for f in fc['features'])
        print('%s: %d pieces (%s), %d reads %s %s' % (slug, len(fc['features']), kinds, reads,
                                                      '->' if a.go else 'would go to', out))
        if a.go:
            tmp = out + '.tmp'
            with open(tmp, 'w', encoding='utf-8', newline='') as fh:
                fh.write(dumps(fc))
            os.replace(tmp, out)
    if not a.go:
        print('DRY RUN -- nothing written. Add --go to write.')
    else:
        print('wrote %d file(s)' % len(built))
    return 0


if __name__ == '__main__':
    sys.exit(main())
