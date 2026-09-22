#!/usr/bin/env python3
r"""make_osm_ramps_by_lake.py - group OSM boat ramps onto lakes, WITH their coordinates.

Personal use only, not for distribution or resale; not for navigation.

    py .\make_osm_ramps_by_lake.py --registry "F:\TrollMapPipeline\registry" `
       --ramps "F:\TrollMapPipeline\osm_ramps.geojson"
    # ... reports, writes nothing. Then --go.

WHAT WAS WRONG

`registry/osm_ramps_by_lake.json` held 1,413 ramp records across 210 lakes and **not one of
them had a coordinate**:

    "dawhoo_lake": [ { "name": null, "access": null, "tag": "leisure=slipway" } ]

`osm_ramps.py` is not the culprit -- it writes proper GeoJSON Points, and `osm_ramps.geojson`
still has all 3,550 of them with coordinates. Whatever grouped them by lake kept `name`,
`access` and `tag` and dropped the geometry, and that step was never checked in.

The consequence reaches the user directly. `ramp_sources` counts those records, so the lake
carries an access badge; the map has no point to draw, so the ramp layer renders nothing.
Ryan on Dawhoo Lake: *"dropdown says there is one ramp via OSM, i click the ramp button
nothing shows up"*. 71 lakes had ONLY coordinate-less ramps, so their badge was pure fiction.

WHAT THIS DOES

Re-groups `osm_ramps.geojson` against `registry/boundaries/<slug>.geojson`, keeping the point.

THE RULE, and every clause of it is measured. Ryan settled the shape on 2026-09-21 and the
margin on 2026-09-22: *"the 250m is probably ok... my point was to make sure we allow 2 bodies
of water to have both have access to the ramp if the bodies of water are actually connected and
fairly nearby."*

    KEEP    a ramp keeps every water it is already filed on that is within the margin
    ADD     every OTHER water within the margin is added -- a landing may be on two, and often is
    MOVE    a prior water is dropped ONLY when the ramp is beyond the margin of it AND inside
            the margin of something else. Demonstrably misfiled, not merely further away.
    STAY    a ramp near NOTHING keeps what it has. No boundary being close does not make a
            filing wrong.

IT MEASURES THE POLYGON, NOT THE BOUNDING BOX. The box was the old test and on a sinuous river
it is not the river: the Congaree's is a 68 x 69 km rectangle holding the Wateree and the Saluda.
130 of 1,762 OSM rows sat more than 300 m from the water they were filed on, 76 of those over
5 km, worst 55 km, every one on a river. Smallest-box-wins was backwards for the same reason --
a river has an enormous box and a narrow body, so it lost every contest to a farm pond inside it.

THE MARGIN IS A MEASURED CEILING. Over 1,212 ramps whose water is confirmed by the agency's own
`wb` name -- two independent sources, and no distance used to establish the pairing -- the
distance to the water's drawn edge is p50 7.2 m, p99 88.6 m, and the largest is 246.4 m. 250 m
sits 3.6 m above the worst real case. 36.1% are INSIDE the polygon, which is why containment is
the wrong instrument rather than merely a strict one. measure_ramp_water_margin.py is the run.

AND A WRONG SECOND BINDING COSTS NOTHING, which is what makes a generous margin safe: this
margin decides FILING, while build_ramp_reach.py decides CONNECTION by flooding the charted
water, and the label carries the run -- "Low Falls - 0.2 mi by water". Two ponds 200 m apart
across land can both claim a ramp and the reach says which one a boat can actually use.

It reports how many lakes gain a real ramp, how many lose a fictional one, and what changed
in total, because "your access badge is now correct" is only trustworthy with the number of
badges that were wrong beside it.
"""
import argparse, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# THE RULE ITSELF LIVES IN ramp_filing.py FROM 2026-09-22, so the national water-access layer
# can be filed by the SAME one rather than by a second answer to the same question.
# retired_of(), load_boxes(), ryan_drops(), DROP_DEG and the KEEP/ADD/MOVE/NEW/STAY/none clause
# machine moved there verbatim. This script's dry output is byte-identical across the move,
# which is the only way to know a refactor of a FILING rule did not refile anything.
from ramp_filing import Filing      # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--ramps', required=True, help='osm_ramps.geojson from osm_ramps.py')
    ap.add_argument('--margin-m', type=float, default=250.0,
                    help='how far off the water a ramp may sit, measured to the POLYGON. '
                         'Default 250 m, which is 3.6 m above the largest of 1,212 '
                         'agency-confirmed ramps -- see measure_ramp_water_margin.py. Not '
                         'a picked number.')
    ap.add_argument('--keep-drops', action='store_true',
                    help='do NOT apply Ryan\'s "not a launch" answers. Diagnosis only.')
    ap.add_argument('--dry-out',
                    help='on a DRY RUN, also write what it WOULD have produced here, so the before and after can be diffed object by object without touching the registry. A rule that changes which water a ramp is on has to be checked against the file it replaces, not '
                         'against its own summary.')
    ap.add_argument('--go', action='store_true', help='write. Default is a dry run.')
    a = ap.parse_args()

    print('MODE: %s' % ('WRITING' if a.go else 'DRY RUN -- nothing will be changed'))
    filing = Filing(a.registry, margin_m=a.margin_m, keep_drops=a.keep_drops)
    gj = json.load(open(a.ramps, encoding='utf-8'))
    feats = gj.get('features') or []
    print('%d OSM ramps in %s' % (len(feats), os.path.basename(a.ramps)))

    dst = os.path.join(a.registry, 'osm_ramps_by_lake.json')
    old = {}
    if os.path.exists(dst):
        try:
            old = json.load(open(dst, encoding='utf-8'))
        except Exception:
            old = {}

    # WHAT A RAMP IS ALREADY FILED ON, keyed by the OSM OBJECT and not by position, because a
    # position is a float and an id is an identity. This is what KEEP and MOVE are about: without
    # it there is no such thing as 'the water it is filed on', and the rule collapses into whatever
    # today's arithmetic says -- which is how the 2026-09-21 rewrite moved landings Ryan had placed
    # by hand.
    prior = Filing.priors(old, lambda r: (r.get('osm_type'), r.get('osm_id'))
                          if (r.get('osm_type'), r.get('osm_id')) != (None, None) else None)
    print('%d OSM object(s) already filed somewhere, across %d lake(s)'
          % (len(prior), len(old or {})))

    out = {}
    for i, f in enumerate(feats, 1):
        if i % 500 == 0:
            print('  %d/%d ramps' % (i, len(feats)), flush=True)
        c = (f.get('geometry') or {}).get('coordinates') or []
        if len(c) < 2:
            continue
        lon, lat = c[0], c[1]
        p = f.get('properties') or {}
        key = (p.get('osm_type'), p.get('osm_id'))
        # A PRIOR ON AN OFF-INDEX SLUG IS NOT A FILING WORTH KEEPING, so KEEP and STAY are
        # scoped the same way the claims are or the gate leaks through history.
        was = prior.get(key, set()) & filing.offered
        targets, _clause = filing.place(lat, lon, was, name=p.get('name'))
        if targets is None:
            continue

        rec = {
            'name': p.get('name'),
            'access': p.get('access'),
            'tag': p.get('tag'),
            'osm_type': p.get('osm_type'),
            'osm_id': p.get('osm_id'),
            'lat': round(lat, 7),
            'lon': round(lon, 7),
        }
        for t in sorted(targets):
            out.setdefault(t, []).append(dict(rec))
    filing.report(len(feats))

    on = {}
    for slug, recs in out.items():
        for r in recs:
            on.setdefault((r['osm_type'], r['osm_id']), set()).add(slug)
    on_multi = sum(1 for v in on.values() if len(v) > 1)
    print()
    print('%d of %d filed objects are on MORE THAN ONE water -- the additive case'
          % (on_multi, len(on)))
    old_lakes = set(old)
    new_lakes = set(out)
    old_recs = sum(len(v) for v in old.values())
    new_recs = sum(len(v) for v in out.values())
    old_with = sum(1 for v in old.values() for r in v if isinstance(r.get('lat'), (int, float)))

    print('\n%d ramp records across %d lakes, %d object(s) claimed by nothing, %d dropped on '
          'his own answer' % (new_recs, len(out), len(filing.unclaimed), filing.dropped))
    print('before: %d records on %d lakes, %d had coordinates'
          % (old_recs, len(old_lakes), old_with))
    print('after : %d records on %d lakes, %d have coordinates' % (new_recs, len(out), new_recs))
    gained = sorted(new_lakes - old_lakes)
    lost = sorted(old_lakes - new_lakes)
    print('\n%d lakes gain ramps they never had' % len(gained))
    for s in gained[:12]:
        print('    + %-34s %d ramp(s)' % (s, len(out[s])))
    if len(gained) > 12:
        print('    ... %d more' % (len(gained) - 12))
    print('\n%d lakes LOSE their ramps -- those records had no coordinates and no ramp was '
          'ever within %.0f m of the water' % (len(lost), a.margin_m))
    for s in lost[:12]:
        print('    - %-34s had %d fictional record(s)' % (s, len(old[s])))
    if len(lost) > 12:
        print('    ... %d more' % (len(lost) - 12))

    if a.go:
        json.dump(out, open(dst, 'w', encoding='utf-8'), indent=1)
        print('\n-> %s' % dst)
        print('   re-run consolidate_lake_index.py so lake_index.json picks the ramps up')
    else:
        if a.dry_out:
            json.dump(out, open(a.dry_out, 'w', encoding='utf-8'), indent=1, sort_keys=True)
            print('\nwould-be output -> %s' % a.dry_out)
        print('\nDRY RUN -- nothing written. Add --go.')


if __name__ == '__main__':
    main()
