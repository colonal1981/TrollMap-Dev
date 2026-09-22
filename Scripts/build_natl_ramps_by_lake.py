#!/usr/bin/env python3
r"""build_natl_ramps_by_lake.py - the national water-access layer, from its actual source.

Personal use only, not for distribution or resale; not for navigation.

    py .\build_natl_ramps_by_lake.py --registry "F:\TrollMapPipeline\registry" `
       --source "F:\TrollMapPipeline\_reference\Boatramps_United_States_final_20230104.csv"
    # ... reports, writes nothing. Then --go.

IT HAD A PRODUCER AND I SAID IT DID NOT. That was wrong and Ryan caught it: *"i am confused how
the producer just vanished... but ok... weird"*. `make_natl_ramps_by_lake.py` was written on
2026-09-21 and PARKED at 00:59 on 2026-09-22 in
`_to_delete/rejected_water_binding_2026-09-22/`, because it bound ramps the way he had rejected
twice -- straight-line distance to a boundary, nearest-wins, and landings MOVED off the water
they are filed under. Its `WHY_THESE_ARE_HERE.md` says what a replacement owes:

    "Any replacement must keep the guard and must implement the agreed shape: KEEP the water it
     is filed on, ADD any other within the margin, MOVE only when it is beyond the margin of
     where it is filed AND inside the margin of something else, and leave a ramp near nothing
     alone."

That is exactly ramp_filing.py, so this script is that replacement. The guard is
`retired_of()`, which the rejected rewrite had deleted on the reasoning that with a real
distance "there is nothing to break" -- and which is why `brinkley_lake` took 17 ramps on
2026-08-19 while `falls_lake`, a shipped lake, came out with none.

MY SEARCH ONLY COVERED `TrollMap-Dev/Scripts/`. The producer was one folder over. The claim
"written by nothing" is retracted; what was true is that nothing SHIPPED could rebuild it.

WHAT THE SOURCE IS. USGS, "Boat ramp locations in the United States of America", published
2023-01-31, **data collected May 2022**. A one-off research product: no revision, no newer
edition, no update pending, checked 2026-09-21. So it is the only edition there will ever be and
it is also the STALEST access source in the app by three years -- the state agency feeds behind
`dnr_ramps_by_lake.json` refresh live. Worth knowing when the two disagree about a name: the
agency is current.

    registry/_natl_boatramps_20230104.csv     24,781 rows with coordinates, all 52 states
    columns  OID_, DataSource, State, County, Latitude, Longitude,
             AccessName, OriginalWB, Type, HUC12, HUC12_Name

Read out of the registry and not out of a downloads folder, so the producer has an input that
does not move. `_reference/Boatramps_United_States_final_20230104.csv` is the same bytes.

NO STATE FILTER, ON PURPOSE, and this is the parked producer's reasoning kept: 2,186 of the
24,781 rows are in SC/NC/GA/TN, but a ramp in Virginia on John H Kerr Reservoir is access to a
water this app offers. Geometry decides, and a point far from every boundary costs nothing.

THAT THE JSON CAME FROM THIS CSV was established separately, by matching the two. Of the 1,272
distinct positions in the JSON:
`_reference/Boatramps_United_States_final_20230104.csv` -- 24,786 rows, all 50 states, dated
2023-01-04. Of the 1,272 distinct positions in the JSON:

    1,143  are in the CSV at 1.1 m
      129  are not, and EVERY ONE of them is within 60 m of a CSV row -- most within 0.5 m
        0  have no CSV row within 60 m

and on the 1,226 rows that matched: `wb` == `OriginalWB` 1,226 of 1,226, `src` == `DataSource`
1,226 of 1,226, `name` == `AccessName` 1,225 of 1,226. The sub-metre offsets are a rounding
artifact of whatever wrote the JSON, not a hand correction. So every row in that file came from
this CSV, and the file is fully reconstructable.

    AccessName -> name     OriginalWB -> wb     Type -> type     DataSource -> src

NOT THE ARCGIS FEED. Ryan asked whether `services3.arcgis.com/PWXNAH2YKmZY7lBq/.../
Boat_Launch_Sites` was the source. It is not -- that is TWRA's Tennessee layer, 678 features,
and it is what `Worker/core/ramp-sources.js` and `build_dnr_ramps_by_lake.py` use for the `dnr`
bucket. It appears INSIDE this CSV only because the CSV credits its contributors: 518 of the
old JSON's rows carry `src: Tennessee Wildlife Resources Agency`.

THE FILING RULE IS ramp_filing.py's, the same one make_osm_ramps_by_lake.py uses -- not
water_binding.py, which is parked with the rejected producer. This script also replaces
refile_natl_ramps.py, which could only re-file the JSON against itself.

THE PRIOR IS MATCHED BY DISTANCE, NOT BY KEY, because of those 129 sub-metre offsets: a 5 dp
key would call them new rows and MOVE would never fire on them. 11 m is sameLanding()'s own
position gate in js/data/access-index.js -- the same question, so the same number.
"""
import argparse, csv, io, json, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ramp_filing import Filing      # noqa: E402

CSV_NAME = '_natl_boatramps_20230104.csv'

# Same 11 m as SAME_PLACE_M in js/data/access-index.js. Not a new number.
PRIOR_M = 11.0
GRID_DEG = 0.002


def _metres(la1, lo1, la2, lo2):
    k = math.cos(math.radians((la1 + la2) / 2.0))
    return math.hypot((lo2 - lo1) * k * 111320.0, (la2 - la1) * 110540.0)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--source', default=None,
                    help='override the source CSV. Default <registry>/%s, which is where it '
                         'lives so the producer has an input that does not move. Columns '
                         'AccessName, OriginalWB, Type, DataSource, Latitude, Longitude.'
                         % CSV_NAME)
    ap.add_argument('--margin-m', type=float, default=250.0,
                    help='how far off the water a row may sit, measured to the POLYGON. The '
                         'same 250 m make_osm_ramps_by_lake.py uses, and not a second number: '
                         'it is 3.6 m above the largest of 1,212 agency-confirmed ramps, see '
                         'measure_ramp_water_margin.py.')
    ap.add_argument('--keep-drops', action='store_true',
                    help='do NOT apply Ryan\'s "not a launch" answers. Diagnosis only.')
    ap.add_argument('--dry-out', help='on a DRY RUN, write what it WOULD produce here, so the '
                                      'before and after can be diffed row by row.')
    ap.add_argument('--go', action='store_true', help='write. Default is a dry run.')
    a = ap.parse_args()

    print('MODE: %s' % ('WRITING' if a.go else 'DRY RUN -- nothing will be changed'))
    filing = Filing(a.registry, margin_m=a.margin_m, keep_drops=a.keep_drops)

    # ── the source ────────────────────────────────────────────────────────────
    source = a.source or os.path.join(a.registry, CSV_NAME)
    if not os.path.exists(source):
        sys.exit('no source CSV at %s' % source)
    rows = []
    with io.open(source, encoding='utf-8-sig', newline='') as fh:
        for r in csv.DictReader(fh):
            try:
                la = float(r['Latitude']); lo = float(r['Longitude'])
            except (KeyError, TypeError, ValueError):
                continue
            rows.append({'name': (r.get('AccessName') or '').strip() or None,
                         'wb': (r.get('OriginalWB') or '').strip() or None,
                         'type': (r.get('Type') or '').strip() or None,
                         'src': (r.get('DataSource') or '').strip() or None,
                         'lat': la, 'lon': lo})
    print('%d rows with coordinates in %s' % (len(rows), os.path.basename(source)))

    # ── the prior, matched by DISTANCE ────────────────────────────────────────
    dst = os.path.join(a.registry, 'natl_ramps_by_lake.json')
    old = json.load(open(dst, encoding='utf-8')) if os.path.exists(dst) else {}
    grid = {}
    for slug, recs in (old or {}).items():
        for r in (recs or []):
            try:
                la = float(r['lat']); lo = float(r['lon'])
            except (KeyError, TypeError, ValueError):
                continue
            grid.setdefault((int(la // GRID_DEG), int(lo // GRID_DEG)), []).append((la, lo, slug))
    print('%d row(s) on %d slug(s) already filed' % (sum(len(v or []) for v in old.values()),
                                                     len(old)))

    def prior_for(la, lo):
        gx, gy = int(la // GRID_DEG), int(lo // GRID_DEG)
        out = set()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for pla, plo, slug in grid.get((gx + dx, gy + dy), ()):
                    if _metres(la, lo, pla, plo) <= PRIOR_M:
                        out.add(slug)
        return out

    out, matched_prior = {}, 0
    for r in rows:
        was = prior_for(r['lat'], r['lon']) & filing.offered
        if was:
            matched_prior += 1
        targets, _clause = filing.place(r['lat'], r['lon'], was, name=r.get('name'))
        if targets is None:
            continue
        for t in sorted(targets):
            out.setdefault(t, []).append(dict(r))
    print('%d source row(s) matched a prior filing on an offered water within %.0f m'
          % (matched_prior, PRIOR_M))

    filing.report(len(rows))

    new_rows = sum(len(v) for v in out.values())
    print()
    print('before: %d rows on %d slug(s)' % (sum(len(v or []) for v in old.values()), len(old)))
    print('after : %d rows on %d slug(s)' % (new_rows, len(out)))
    gained = sorted(set(out) - set(old))
    lost = sorted(set(old) - set(out))
    print('\n%d slug(s) gain rows they never had' % len(gained))
    for s in gained[:12]:
        print('    + %-34s %d row(s)' % (s, len(out[s])))
    if len(gained) > 12:
        print('    ... %d more' % (len(gained) - 12))
    print('\n%d slug(s) lose theirs' % len(lost))
    for s in lost[:12]:
        print('    - %-34s had %d row(s)' % (s, len(old[s])))
    if len(lost) > 12:
        print('    ... %d more' % (len(lost) - 12))

    if a.go:
        json.dump(out, open(dst, 'w', encoding='utf-8'), indent=1, sort_keys=True)
        print('\n-> %s' % dst)
        print('   re-run build_ramp_reach.py and consolidate_lake_index.py: both read this file')
    else:
        if a.dry_out:
            json.dump(out, open(a.dry_out, 'w', encoding='utf-8'), indent=1, sort_keys=True)
            print('\nwould-be output -> %s' % a.dry_out)
        print('\nDRY RUN -- nothing written. Add --go.')


if __name__ == '__main__':
    main()
