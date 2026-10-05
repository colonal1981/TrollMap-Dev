#!/usr/bin/env python3
"""Add a launch of his own -- one no feed lists -- to registry/_launch_name_overrides.json.

Personal use only, not for distribution or resale; not for navigation.

WHY THIS EXISTS. Ryan, 2026-10-05, of where he puts in on Bates Old River: *"where i launched is a
kayak style launch its just a dirt rd down to the lake and you launch from the end of it"*. No
state feed, OSM or the national water-access layer has anything within 600 m of it, so the water
had no launch at all, and a water with no launch cannot be planned from. The overrides file could
name a landing or drop one; it could not say "there is one here". build_ramp_reach.py now reads an
`add` entry as exactly that, and this writes one -- with a backup of the file first, because it is
his record and the registry is not in git.

    py Scripts\\my_launch.py --registry F:\\TrollMapPipeline\\registry `
       --lat 33.78543 --lon -80.63566 --water bates_old_river `
       --name "Dirt road kayak launch" --why "Ryan, 2026-10-05: ..." `
       --backup F:\\TrollMapPipeline\\_to_delete --go

Without --go it prints the entry and touches nothing. The landing then reaches the app the same
way every other one does: build_ramp_reach.py measures it into the pack's launches.json.
"""
import argparse
import datetime
import json
import os
import shutil
import sys


def key_of(lat, lon):
    """The file's key: 'lat,lon' to 5 dp, the same 1.1 m key every landing source collapses on."""
    return '%.5f,%.5f' % (lat, lon)


def known_water(registry, slug):
    """A water the registry knows -- offered by the app, or with a boundary on file."""
    p = os.path.join(registry, 'lake_index.json')
    if os.path.isfile(p):
        with open(p, encoding='utf-8') as fh:
            if slug in json.load(fh):
                return True
    return os.path.isfile(os.path.join(registry, 'boundaries', slug + '.geojson'))


def entry(name, water, why):
    return {'add': True, 'name': name, 'water': water, 'why': why,
            'replaces': '(no landing on any feed)'}


def add(doc, lat, lon, name, water, why):
    """Put the entry in `doc`. Returns (key, what happened): 'added', 'same' or 'taken'."""
    names = doc.setdefault('names', {})
    k = key_of(lat, lon)
    new = entry(name, water, why)
    if k in names:
        return k, ('same' if names[k] == new else 'taken')
    names[k] = new
    return k, 'added'


def dumps(doc):
    # The file's own layout -- indent 1, ASCII, no trailing newline -- so the diff is the entry.
    return json.dumps(doc, indent=1, ensure_ascii=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--file', default=None,
                    help='the overrides file; default registry/_launch_name_overrides.json')
    ap.add_argument('--lat', type=float, required=True)
    ap.add_argument('--lon', type=float, required=True)
    ap.add_argument('--water', required=True, help='the slug of the water it launches onto')
    ap.add_argument('--name', required=True, help='what the dropdown will say')
    ap.add_argument('--why', required=True, help='who said so and when')
    ap.add_argument('--backup', default=None,
                    help='folder the old file is copied to before writing (required with --go)')
    ap.add_argument('--go', action='store_true', help='write; without it nothing is touched')
    a = ap.parse_args(argv)

    if not (-90 <= a.lat <= 90 and -180 <= a.lon <= 180):
        print('!! %s,%s is not a position' % (a.lat, a.lon))
        return 2
    if not known_water(a.registry, a.water):
        print('!! %s is not a water the registry knows (lake_index.json or boundaries/)' % a.water)
        return 2
    path = a.file or os.path.join(a.registry, '_launch_name_overrides.json')
    doc = {'names': {}}
    if os.path.isfile(path):
        with open(path, encoding='utf-8') as fh:
            doc = json.load(fh)
    k, what = add(doc, a.lat, a.lon, a.name, a.water, a.why)
    print('%s  %s' % (k, json.dumps(doc['names'][k], ensure_ascii=False)))
    if what == 'same':
        print('already in %s -- nothing to do' % path)
        return 0
    if what == 'taken':
        print('!! %s already has an entry at %s and it is not this one -- edit it by hand' % (path, k))
        return 2
    if not a.go:
        print('DRY RUN -- nothing written. Add --go (and --backup) to write %s' % path)
        return 0
    if os.path.isfile(path):
        if not a.backup:
            print('!! --backup is required: this is his record and the registry is not in git')
            return 2
        os.makedirs(a.backup, exist_ok=True)
        stamp = datetime.datetime.now().strftime('%Y-%m-%d_%H%M%S')
        dst = os.path.join(a.backup, '_launch_name_overrides_before_%s_%s.json' % (a.water, stamp))
        shutil.copy2(path, dst)
        print('backed up to %s' % dst)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='') as fh:
        fh.write(dumps(doc))
    os.replace(tmp, path)
    print('wrote %s (%d entries)' % (path, len(doc['names'])))
    return 0


if __name__ == '__main__':
    sys.exit(main())
