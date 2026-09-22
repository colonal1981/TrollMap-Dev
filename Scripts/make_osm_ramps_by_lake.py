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
import argparse, json, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from water_polygons import WaterPolygons, NearIndex      # noqa: E402


def retired_of(registry):
    """(slugs a merge has retired, note). From the ONE file that records them.

    A RETIRED SLUG IS STILL A FILE IN registry/boundaries/, AND THIS SCRIPT AWARDS A RAMP TO
    THE SMALLEST CLAIMANT. A merge retires the near-duplicate of a lake, so the retired
    boundary is almost the same shape as the keeper's and is frequently the SMALLER of the
    two -- which means it wins, and the ramps land on a slug `lake_index.json` does not offer.

    Measured 2026-08-19, straight after a --go run:

        brinkley_lake      17 ramps   falls_lake got 0
        persimmon_lake     10          hiwassee_lake got 1
        tail_race_canal     3          cooper_river got 9
        wilson_dam          1          santee_river got 4

    falls_lake is a shipped lake that came out of that run with no OSM ramps at all.

    Imported by NAME off sys.path rather than restated here, and for the reason
    verify_registry_r2.py gives at its own copy of this import: a second reader of the
    deletion tab drifts from the first, and then both agree with themselves while one is
    wrong. upload_garmin_to_r2 does `from r2_gzip import prepared` at module level, so the
    script's own directory has to be on sys.path before the import.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    try:
        import upload_garmin_to_r2 as ug
        fn = getattr(ug, 'retired_slugs', None)
        if fn is None:
            return set(), ('upload_garmin_to_r2.py has no retired_slugs() -- retired slugs are '
                           'NOT being filtered, and a merged-away slug can take ramps off its '
                           'keeper')
        return fn(registry)
    except Exception as exc:
        return set(), ('could not import retired_slugs from upload_garmin_to_r2.py (%s: %s) -- '
                       'retired slugs are NOT being filtered, and a merged-away slug can take '
                       'ramps off its keeper' % (type(exc).__name__, exc))


def load_boxes(bdir, skip=()):
    """slug -> (W, S, E, N, area_deg2). Read from the boundary, not the index, because the
    index is what this file feeds and reading your own output back is how errors persist."""
    out = {}
    skip = set(skip or ())
    for fn in os.listdir(bdir):
        if not fn.endswith('.geojson'):
            continue
        slug = fn[:-len('.geojson')]
        if slug in skip:
            continue
        try:
            gj = json.load(open(os.path.join(bdir, fn), encoding='utf-8'))
        except Exception:
            continue
        lo_x = lo_y = float('inf')
        hi_x = hi_y = float('-inf')

        def eat(c):
            nonlocal lo_x, lo_y, hi_x, hi_y
            if not c:
                return
            if isinstance(c[0], (int, float)):
                x, y = c[0], c[1]
                lo_x = min(lo_x, x); hi_x = max(hi_x, x)
                lo_y = min(lo_y, y); hi_y = max(hi_y, y)
                return
            for s in c:
                eat(s)

        for f in (gj.get('features') or []):
            eat((f.get('geometry') or {}).get('coordinates'))
        if lo_x == float('inf'):
            continue
        out[slug] = (lo_x, lo_y, hi_x, hi_y, (hi_x - lo_x) * (hi_y - lo_y))
    return out


def ryan_drops(registry):
    """The positions Ryan has said are NOT a launch, from his own roll call.

    `registry/_launch_name_overrides.json` carries his answers: names for the landings he
    recognised and `drop: true` for the ones that are not launches at all. He worked the card
    landing by landing on 2026-09-20 and answered every one; the drops are OSM slipway nodes
    that are a dock, a bank or somebody's driveway.

    THIS IS THE RIGHT PLACE FOR THEM AND access-index.js IS NOT. ryanName() there deliberately
    reads NAMES ONLY, because the access index also holds state-agency rows, and deleting one of
    those because an OSM node ten metres away was dropped would remove a real ramp on the
    strength of a different record. Every row HERE is an OSM node, so a drop is about the row it
    is on.

    UNTIL NOW NOTHING APPLIED THEM, so every run of this script put all of them back. That is
    the whole of this change -- it is SUBTRACTIVE ONLY, on positions he named himself, and it
    touches neither the binding rule nor any count that is not his answer.
    """
    fp = os.path.join(registry, '_launch_name_overrides.json')
    if not os.path.exists(fp):
        return []
    names = (json.load(open(fp, encoding='utf-8')) or {}).get('names') or {}
    out = []
    for key, rec in names.items():
        if not isinstance(rec, dict) or not rec.get('drop'):
            continue
        parts = str(key).split(',')
        try:
            out.append((float(parts[0]), float(parts[1])))
        except (ValueError, IndexError):
            continue
    return out


# Same 40 m as ryanName() and sameLanding() in access-index.js, because it is the same
# question: is the row in front of me this landing. Not a new number.
DROP_DEG = 0.0004


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
    bdir = os.path.join(a.registry, 'boundaries')
    gone, gone_note = retired_of(a.registry)
    if gone_note:
        print('!! %s' % gone_note)
    boxes = load_boxes(bdir, skip=gone)
    print('%d registry boundaries (%d retired slug(s) skipped, so a merged-away boundary '
          'cannot outbid its keeper)' % (len(boxes), len(gone)))

    drops = [] if a.keep_drops else ryan_drops(a.registry)
    print('%d position(s) Ryan has said are NOT a launch%s'
          % (len(drops), '   [--keep-drops: NOT APPLIED]' if a.keep_drops else ''))

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
    prior = {}
    for slug, recs in (old or {}).items():
        for r in (recs or []):
            k = (r.get('osm_type'), r.get('osm_id'))
            if k != (None, None):
                prior.setdefault(k, set()).add(slug)
    print('%d OSM object(s) already filed somewhere, across %d lake(s)'
          % (len(prior), len(old or {})))

    # ONLY A WATER THE APP OFFERS MAY CLAIM A RAMP, and a boundary FILE is not that.
    #
    # Caught on 2026-09-22 by checking why john_h_kerr_reservoir gained 17 ramps: it is not in
    # lake_index.json at all. `load_boxes` walks registry/boundaries/, which holds a file for
    # every water ever cut, and retired_of() only removes the ones a MERGE retired. Filing a
    # ramp on a slug the picker does not offer puts it nowhere a person can reach and inflates
    # no badge, so it is silent -- and with an accurate polygon test these off-index slugs win
    # MORE claims than the old bounding box ever gave them, because they are genuinely near.
    #
    # This is the same gate the 2026-09-17 sweep lesson is about: anything walking the registry
    # scopes to lake_index.json. Ryan, on a run over 1,710 packs when the app offers 355: *"why
    # would we run on those if they aren't in the app."*
    offered = set(json.load(open(os.path.join(a.registry, 'lake_index.json'),
                                 encoding='utf-8')) or {})
    off_index = sorted(set(boxes) - offered)
    for sl in off_index:
        boxes.pop(sl, None)
    print('%d boundary file(s) are not offered by the app and cannot claim a ramp; %d can'
          % (len(off_index), len(boxes)))

    poly = WaterPolygons(a.registry, skip=gone)
    near = NearIndex({sl: (b[0], b[1], b[2], b[3]) for sl, b in boxes.items()})

    out = {}
    dropped = kept = added = moved = stayed = fresh = 0
    unclaimed = []
    for i, f in enumerate(feats, 1):
        if i % 500 == 0:
            print('  %d/%d ramps' % (i, len(feats)), flush=True)
        c = (f.get('geometry') or {}).get('coordinates') or []
        if len(c) < 2:
            continue
        lon, lat = c[0], c[1]
        if any(abs(dla - lat) < DROP_DEG and abs(dlo - lon) < DROP_DEG
               for dla, dlo in drops):
            dropped += 1
            continue
        p = f.get('properties') or {}
        key = (p.get('osm_type'), p.get('osm_id'))
        # A PRIOR ON AN OFF-INDEX SLUG IS NOT A FILING WORTH KEEPING. The previous run could
        # award one, so KEEP and STAY have to be scoped the same way the claims are or the
        # gate leaks through history.
        was = prior.get(key, set()) & offered

        claims = {}
        for slug in near.candidates(lat, lon, a.margin_m):
            d = poly.metres(slug, lat, lon)
            if d is not None and d <= a.margin_m:
                claims[slug] = d

        # KEEP / ADD / MOVE / STAY, in that order, each counted on its own so the run says which
        # rule fired rather than only what the total became.
        if was & set(claims):
            targets = set(claims)
            kept += 1
            if set(claims) - was:
                added += 1
        elif claims:
            targets = set(claims)
            # A ramp WITH a prior that shares none of its claims is MISFILED and moves. One
            # with NO prior is simply new to this file and is neither -- counting them
            # together is how 43 of 3,490 went unaccounted for in the first run of this rule,
            # and a report whose total does not close is not a report.
            if was:
                moved += 1
            else:
                fresh += 1
        elif was:
            targets = set(was)
            stayed += 1
        else:
            unclaimed.append((p.get('name'), round(lat, 6), round(lon, 6)))
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

    print()
    print('WHICH CLAUSE FIRED')
    print('  KEEP   %5d  kept a prior water that is inside the margin' % kept)
    print('  ADD    %5d  of those also gained at least one more water' % added)
    print('  MOVE   %5d  beyond every prior water AND inside another -- misfiled' % moved)
    print('  NEW    %5d  no prior filing, and a water inside the margin claims it' % fresh)
    print('  STAY   %5d  near nothing, keeps what it had' % stayed)
    print('  DROP   %5d  Ryan says it is not a launch' % dropped)
    print('  none   %5d  no prior filing and no water within %.0f m'
          % (len(unclaimed), a.margin_m))
    acct = kept + moved + fresh + stayed + dropped + len(unclaimed)
    print('  ----   %5d  accounted for, of %d in the file%s'
          % (acct, len(feats),
             '' if acct == len(feats) else '   !! %d UNACCOUNTED' % (len(feats) - acct)))
    if unclaimed:
        named = [u for u in unclaimed if u[0]]
        print('  -- NAMED, NOT COUNTED. A count says some went nowhere; the list says which:')
        for nm_, la, lo in named[:12]:
            print('     %-34s %.6f,%.6f' % (nm_[:34], la, lo))
        print('     (%d named, %d unnamed)' % (len(named), len(unclaimed) - len(named)))

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
          'his own answer' % (new_recs, len(out), len(unclaimed), dropped))
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
