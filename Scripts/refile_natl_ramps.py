#!/usr/bin/env python3
r"""refile_natl_ramps.py - put the national water-access rows on the water they are actually on.

Personal use only, not for distribution or resale; not for navigation.

    py .\refile_natl_ramps.py --registry "F:\TrollMapPipeline\registry"
    # ... reports, writes nothing. Then --go.

WHAT IS WRONG

`registry/natl_ramps_by_lake.json` is 1,362 rows across 215 slugs and **nothing on the drive
writes it**. Three scripts read it -- build_ramp_reach.py, build_water_names.py and
consolidate_lake_index.py -- and no producer exists, so however it was grouped is however it has
stayed. 40 of its rows are filed on the wrong water while the state feed is 875/875 clean.

The consequence is the same one Ryan hit on Lake Wateree on 2026-09-22: *"on wateree i am seeing
launches that you can't physically get to from wateree"*. A row filed on the wrong water puts a
launch in that water's list and an access badge on its picker entry.

WHAT THIS DOES

Re-files every row against `registry/boundaries/<slug>.geojson` by the SAME rule
make_osm_ramps_by_lake.py uses -- one implementation, in ramp_filing.py, because two answers to
"which water is this ramp on" is the defect this whole week has been about. See
claude/FIVE_SURFACES_FOUR_FEEDS_AND_EIGHTY_FIVE_RAMPS_DELETED_2026-09-22.md.

IDENTITY IS THE POSITION, because the feed gives nothing else. An OSM row has an object id and
this one has `name`, `wb`, `type`, `src`, `lat`, `lon`. Rounded to 5 dp -- 1.1 m -- which is the
same key access_points() in build_ramp_reach.py uses on these very rows, so a row that moves here
is the row that moves there.

THE FILE IS ITS OWN INPUT, and that is not circular the way reading your own output usually is:
the rows carry coordinates and the boundaries carry geometry, so the only thing taken from the
old file is WHERE EACH ROW WAS FILED -- which is exactly what KEEP, MOVE and STAY are about. The
fields come along untouched.
"""
import argparse, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ramp_filing import Filing      # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--margin-m', type=float, default=250.0,
                    help='how far off the water a row may sit, measured to the POLYGON. '
                         'Default 250 m, which is 3.6 m above the largest of 1,212 '
                         'agency-confirmed ramps -- see measure_ramp_water_margin.py. The same '
                         'number make_osm_ramps_by_lake.py uses, and not a second one.')
    ap.add_argument('--keep-drops', action='store_true',
                    help='do NOT apply Ryan\'s "not a launch" answers. Diagnosis only.')
    ap.add_argument('--dry-out',
                    help='on a DRY RUN, write what it WOULD have produced here, so the before '
                         'and after can be diffed row by row without touching the registry. A '
                         'rule that changes which water a ramp is on has to be checked against '
                         'the file it replaces, not against its own summary.')
    ap.add_argument('--go', action='store_true', help='write. Default is a dry run.')
    a = ap.parse_args()

    print('MODE: %s' % ('WRITING' if a.go else 'DRY RUN -- nothing will be changed'))
    filing = Filing(a.registry, margin_m=a.margin_m, keep_drops=a.keep_drops)

    dst = os.path.join(a.registry, 'natl_ramps_by_lake.json')
    old = json.load(open(dst, encoding='utf-8')) if os.path.exists(dst) else {}
    rows_in = sum(len(v or []) for v in old.values())
    print('%d national rows across %d slug(s) in %s'
          % (rows_in, len(old), os.path.basename(dst)))

    def key_of(r):
        try:
            return (round(float(r['lat']), 5), round(float(r['lon']), 5))
        except (KeyError, TypeError, ValueError):
            return None

    prior = Filing.priors(old, key_of)
    print('%d distinct position(s) already filed somewhere' % len(prior))

    # ONE ROW PER POSITION going in, because the same access point is filed on two slugs in this
    # file and both copies are the same record. Fields are merged rather than one copy winning:
    # a name on one and a `wb` on the other are both true of the landing.
    rows = {}
    for slug, recs in old.items():
        for r in (recs or []):
            k = key_of(r)
            if k is None:
                continue
            cur = rows.setdefault(k, {})
            for f, v in r.items():
                if v not in (None, '') and cur.get(f) in (None, ''):
                    cur[f] = v
    print('%d distinct landing(s) after collapsing the duplicate filings' % len(rows))

    out, no_coords = {}, 0
    for k, r in rows.items():
        lat, lon = float(r['lat']), float(r['lon'])
        was = prior.get(k, set()) & filing.offered
        targets, _clause = filing.place(lat, lon, was, name=r.get('name'))
        if targets is None:
            continue
        for t in sorted(targets):
            out.setdefault(t, []).append(dict(r))

    filing.report(len(rows))

    new_rows = sum(len(v) for v in out.values())
    print()
    print('before: %d rows on %d slug(s)' % (rows_in, len(old)))
    print('after : %d rows on %d slug(s)' % (new_rows, len(out)))

    # WHICH ROWS ACTUALLY MOVED, by name, because "40 misfiled" is a number and this is the list.
    before_on = {k: (prior.get(k, set()) & filing.offered) for k in rows}
    after_on = {}
    for slug, recs in out.items():
        for r in recs:
            after_on.setdefault(key_of(r), set()).add(slug)
    moved = [(rows[k].get('name'), sorted(before_on[k]), sorted(after_on.get(k, set())))
             for k in rows
             if before_on[k] and after_on.get(k, set()) and before_on[k] != after_on.get(k, set())]
    print('\n%d landing(s) changed which water they are filed on:' % len(moved))
    for nm, b, aft in sorted(moved, key=lambda t: str(t[0]))[:30]:
        print('    %-30s %s  ->  %s' % (str(nm)[:30], ','.join(b) or '-', ','.join(aft) or '-'))
    if len(moved) > 30:
        print('    ... %d more' % (len(moved) - 30))

    gained = sorted(set(out) - set(old))
    lost = sorted(set(old) - set(out))
    print('\n%d slug(s) gain national rows they never had' % len(gained))
    for s in gained[:12]:
        print('    + %-34s %d row(s)' % (s, len(out[s])))
    print('\n%d slug(s) lose theirs -- no row was within %.0f m of that water and none had a '
          'prior worth keeping' % (len(lost), a.margin_m))
    for s in lost[:12]:
        print('    - %-34s had %d row(s)' % (s, len(old[s])))
    if len(lost) > 12:
        print('    ... %d more' % (len(lost) - 12))

    if a.go:
        # IT KEEPS A COPY, BECAUSE THIS FILE HAS NO PRODUCER. Every other _*.json in the registry
        # can be rebuilt by the script that writes it; nothing on the drive writes this one, so
        # overwriting it without a copy is the only irreversible step in the whole ramp refactor.
        # Dated rather than `.bak`, so a second run does not eat the first copy.
        import datetime
        keep = '%s.before_%s.json' % (dst[:-len('.json')],
                                      datetime.date.today().isoformat())
        if not os.path.exists(keep):
            json.dump(old, open(keep, 'w', encoding='utf-8'), indent=1, sort_keys=True)
            print('\nkept the file it replaces -> %s' % keep)
        json.dump(out, open(dst, 'w', encoding='utf-8'), indent=1, sort_keys=True)
        print('-> %s' % dst)
        print('   re-run build_ramp_reach.py and consolidate_lake_index.py: both read this file')
    else:
        if a.dry_out:
            json.dump(out, open(a.dry_out, 'w', encoding='utf-8'), indent=1, sort_keys=True)
            print('\nwould-be output -> %s' % a.dry_out)
        print('\nDRY RUN -- nothing written. Add --go.')


if __name__ == '__main__':
    main()
