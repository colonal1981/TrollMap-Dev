#!/usr/bin/env python3
r"""ramp_filing.py - WHICH WATER A LANDING IS FILED ON. One rule, every feed.

Personal use only, not for distribution or resale; not for navigation.

This is make_osm_ramps_by_lake.py's rule, lifted out of it on 2026-09-22 so the national
water-access layer can be filed by the SAME rule instead of by a second one. It is not new
machinery and none of its numbers changed in the move.

WHY IT MOVED. `registry/natl_ramps_by_lake.json` has 1,362 rows on 215 slugs and no producer
anywhere on the drive -- nothing writes it, three scripts read it. 40 of its rows are filed on
the wrong water while the state feed is 875/875 clean, and the only tool that could fix that
was welded to `osm_ramps.geojson`'s shape. Two feeds answering "which water is this ramp on"
two different ways is the same defect the app had with five launch surfaces reading four feeds;
see claude/FIVE_SURFACES_FOUR_FEEDS_AND_EIGHTY_FIVE_RAMPS_DELETED_2026-09-22.md.

THE RULE, unchanged. Ryan settled the shape on 2026-09-21 and the margin on 2026-09-22:
*"the 250m is probably ok... my point was to make sure we allow 2 bodies of water to have both
have access to the ramp if the bodies of water are actually connected and fairly nearby."*

    KEEP    a ramp keeps every water it is already filed on that is within the margin
    ADD     every OTHER water within the margin is added -- a landing may be on two, and often is
    MOVE    a prior water is dropped ONLY when the ramp is beyond the margin of it AND inside
            the margin of something else. Demonstrably misfiled, not merely further away.
    NEW     no prior filing at all, and a water inside the margin claims it
    STAY    a ramp near NOTHING keeps what it has. No boundary being close does not make a
            filing wrong.
    DROP    Ryan has said this position is not a launch
    none    no prior filing and no water within the margin

IT MEASURES THE POLYGON, NOT THE BOUNDING BOX, and the margin is a measured ceiling: over 1,212
ramps whose water is confirmed by the agency's own `wb` name, the distance to the drawn edge is
p50 7.2 m, p99 88.6 m, largest 246.4 m. 250 m sits 3.6 m above the worst real case, and 36.1%
are INSIDE the polygon -- which is why containment is the wrong instrument rather than merely a
strict one. measure_ramp_water_margin.py is the run.

IDENTITY IS THE CALLER'S BUSINESS. OSM has an object id, so its prior is keyed by it; the
national feed has nothing but a position, so its prior is keyed by a rounded coordinate. The
rule below never asks what a row IS, only where it is and what it was already filed on.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from water_polygons import WaterPolygons, NearIndex      # noqa: E402


def retired_of(registry):
    """(slugs a merge has retired, note). From the ONE file that records them.

    A RETIRED SLUG IS STILL A FILE IN registry/boundaries/. A merge retires the near-duplicate
    of a lake, so the retired boundary is almost the same shape as the keeper's -- and the ramps
    land on a slug `lake_index.json` does not offer. Measured 2026-08-19, straight after a --go
    run: brinkley_lake took 17 ramps while falls_lake got 0; persimmon_lake 10 against
    hiwassee_lake's 1; tail_race_canal 3 against cooper_river's 9.

    Imported by NAME off sys.path rather than restated here: a second reader of the deletion tab
    drifts from the first, and then both agree with themselves while one is wrong.
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
    index is what this feeds and reading your own output back is how errors persist."""
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
    landing by landing on 2026-09-20 and answered every one; the drops are slipway nodes that
    are a dock, a bank or somebody's driveway.

    SUBTRACTIVE ONLY, on positions he named himself. It touches neither the binding rule nor
    any count that is not his answer.
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


class Filing:
    """The rule, set up once against a registry and then asked about positions.

    Usage is three calls: build it, hand it the priors, then `place()` every row and read the
    clause it fired. `report()` prints the accounting, and the accounting CLOSES -- every row is
    in exactly one bucket. A report whose total does not match the file it read is not a report;
    the first run of this rule left 43 of 3,490 unaccounted because NEW and MOVE were counted
    together.
    """

    def __init__(self, registry, margin_m=250.0, keep_drops=False, quiet=False):
        self.registry = registry
        self.margin_m = float(margin_m)
        self.say = (lambda *a, **k: None) if quiet else print

        gone, gone_note = retired_of(registry)
        if gone_note:
            self.say('!! %s' % gone_note)
        boxes = load_boxes(os.path.join(registry, 'boundaries'), skip=gone)
        self.say('%d registry boundaries (%d retired slug(s) skipped, so a merged-away boundary '
                 'cannot outbid its keeper)' % (len(boxes), len(gone)))

        # ONLY A WATER THE APP OFFERS MAY CLAIM A RAMP, and a boundary FILE is not that.
        #
        # Caught on 2026-09-22 by checking why john_h_kerr_reservoir gained 17 ramps: it is not
        # in lake_index.json at all. registry/boundaries/ holds a file for every water ever cut,
        # and retired_of() only removes the ones a MERGE retired. Filing a ramp on a slug the
        # picker does not offer puts it nowhere a person can reach -- and with an accurate
        # polygon test these off-index slugs win MORE claims than the old bounding box gave
        # them, because they are genuinely near. Ryan, on a run over 1,710 packs when the app
        # offers 355: *"why would we run on those if they aren't in the app."*
        self.offered = set(json.load(open(os.path.join(registry, 'lake_index.json'),
                                          encoding='utf-8')) or {})
        off_index = sorted(set(boxes) - self.offered)
        for sl in off_index:
            boxes.pop(sl, None)
        self.say('%d boundary file(s) are not offered by the app and cannot claim a ramp; %d can'
                 % (len(off_index), len(boxes)))

        self.drops = [] if keep_drops else ryan_drops(registry)
        self.say('%d position(s) Ryan has said are NOT a launch%s'
                 % (len(self.drops), '   [--keep-drops: NOT APPLIED]' if keep_drops else ''))

        self.poly = WaterPolygons(registry, skip=gone)
        self.near = NearIndex({sl: (b[0], b[1], b[2], b[3]) for sl, b in boxes.items()})
        self.kept = self.added = self.moved = self.fresh = self.stayed = self.dropped = 0
        self.unclaimed = []

    @staticmethod
    def priors(existing, key_of):
        """object key -> set(slugs), off whatever is already on disk.

        Keyed by the OBJECT and not by arithmetic, because without it there is no such thing as
        'the water it is filed on' and the rule collapses into whatever today's numbers say --
        which is how the 2026-09-21 rewrite moved landings Ryan had placed by hand.
        """
        prior = {}
        for slug, recs in (existing or {}).items():
            for r in (recs or []):
                k = key_of(r)
                if k is not None:
                    prior.setdefault(k, set()).add(slug)
        return prior

    def is_dropped(self, lat, lon):
        return any(abs(dla - lat) < DROP_DEG and abs(dlo - lon) < DROP_DEG
                   for dla, dlo in self.drops)

    def place(self, lat, lon, was, name=None):
        """(targets, clause). `targets` is None when the row files nowhere.

        `was` is this row's prior filing, ALREADY scoped to the offered waters -- a prior on an
        off-index slug is not a filing worth keeping, and KEEP and STAY have to be scoped the
        same way the claims are or the gate leaks through history.
        """
        if self.is_dropped(lat, lon):
            self.dropped += 1
            return None, 'DROP'
        claims = {}
        for slug in self.near.candidates(lat, lon, self.margin_m):
            d = self.poly.metres(slug, lat, lon)
            if d is not None and d <= self.margin_m:
                claims[slug] = d
        if was & set(claims):
            self.kept += 1
            if set(claims) - was:
                self.added += 1
            return set(claims), 'KEEP'
        if claims:
            # A ramp WITH a prior that shares none of its claims is MISFILED and moves. One with
            # NO prior is simply new to this file and is neither.
            if was:
                self.moved += 1
                return set(claims), 'MOVE'
            self.fresh += 1
            return set(claims), 'NEW'
        if was:
            self.stayed += 1
            return set(was), 'STAY'
        self.unclaimed.append((name, round(lat, 6), round(lon, 6)))
        return None, 'none'

    def report(self, total_in):
        print()
        print('WHICH CLAUSE FIRED')
        print('  KEEP   %5d  kept a prior water that is inside the margin' % self.kept)
        print('  ADD    %5d  of those also gained at least one more water' % self.added)
        print('  MOVE   %5d  beyond every prior water AND inside another -- misfiled' % self.moved)
        print('  NEW    %5d  no prior filing, and a water inside the margin claims it' % self.fresh)
        print('  STAY   %5d  near nothing, keeps what it had' % self.stayed)
        print('  DROP   %5d  Ryan says it is not a launch' % self.dropped)
        print('  none   %5d  no prior filing and no water within %.0f m'
              % (len(self.unclaimed), self.margin_m))
        acct = (self.kept + self.moved + self.fresh + self.stayed + self.dropped
                + len(self.unclaimed))
        print('  ----   %5d  accounted for, of %d in the file%s'
              % (acct, total_in,
                 '' if acct == total_in else '   !! %d UNACCOUNTED' % (total_in - acct)))
        if self.unclaimed:
            named = [u for u in self.unclaimed if u[0]]
            print('  -- NAMED, NOT COUNTED. A count says some went nowhere; the list says which:')
            for nm_, la, lo in named[:12]:
                print('     %-34s %.6f,%.6f' % (str(nm_)[:34], la, lo))
            print('     (%d named, %d unnamed)' % (len(named), len(self.unclaimed) - len(named)))
        return acct
