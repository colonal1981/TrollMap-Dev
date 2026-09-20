r"""name_launches_from_places.py - ask Google what the unnamed launches are called.

Personal use only, not for distribution or resale; not for navigation.

    set TROLLMAP_SYNC_TOKEN=...            (Ryan's shell, once, never written down here)
    py .\name_launches_from_places.py --registry "F:\TrollMapPipeline\registry" ^
                                      --chartpack "F:\TrollMapPipeline\chartpack" ^
                                      --waters wateree_lake,lake_marion,...
    # ... reports, writes nothing. Then --go.

WHY THIS EXISTS

1,600 of the 3,757 landing rows across the packs carry no name, every one from OSM, tagged
`leisure=slipway` and nothing else. Ryan: *"planning a trip from 'unnamed launch' doesn't sound
right to me"*, and then: *"i want to try and figure out how to name them at least on the waters
i actually care about... unless you have an automated way to do the looking for me"*.

THE KEY IS NOT HERE AND NEVER WILL BE. `PLACES_API_KEY` lives on the Worker, which is why the
lookup is a Worker route (`Worker/places.js`) and this script only asks it questions. The shared
token that guards that route is read from the environment, so it is not in this file, not in the
command, and not in anything this writes.

WHAT IT WRITES, AND WHY IT IS A REGISTRY FILE RATHER THAN AN EDIT TO THE PACKS

`registry/_place_names.json`, keyed by position to 5 dp. build_ramp_reach.py reads it in
access_points() as one more name source beside dnr, osm and natl -- so a name survives every
rebuild, and the next `--go` does not wipe it. Editing launches.json directly would last until
the next run of the thing that writes launches.json.

NOTHING HERE DECIDES WHETHER A RESULT IS THE LAUNCH. Google is asked what is within 150 m and
the nearest few come back with their distance and their types. The rule applied is stated at
LAUNCH_RE below; everything else is written to the file as a SUGGESTION with `accepted: false`
for a human to read, because a wrong name on a launch is worse than no name -- it sends him to
the wrong place.

--rejudge RE-READS THE ANSWERS ON DISK AND COSTS NOTHING. Every suggestion Google returned is
stored, so the accept rule can be improved and re-applied without a token, a network call or a
cent. It has already been worth it twice: the first rule went on Google's TYPE and refused "Boat
Ramp" at one metre; the second used the type to exclude and dropped Blacks Camp for having a
restaurant in it.
"""
import argparse
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request

WORKER = 'https://trollmap-worker.colonal1981.workers.dev'
BATCH = 25                      # the Worker's own limit per request
CLOSED = ('private', 'customers', 'permit', 'no', 'residents')

# THE NAME IS THE DISCRIMINATOR, NOT THE TYPE, AND THE FIRST RUN PROVED IT.
#
# The first cut of this took a result only if its Google TYPE was one of marina / park /
# campground and so on. It accepted 23 of 152 and refused, on type alone:
#
#     Bates Landing                      0 m    point_of_interest, establishment
#     Boat Ramp                          1 m    point_of_interest, establishment
#     Barrett Boat Ramp                  1 m    point_of_interest, establishment
#     C Alex Harvin III Landing          5 m    point_of_interest, establishment
#     Ebenezer Boat Ramp                 7 m    point_of_interest, establishment
#     Saluda Shoals Boat Launch         10 m    point_of_interest, establishment
#
# Google barely types boat ramps. Almost every real landing in this data comes back as the
# generic `point_of_interest, establishment`, so the type says nothing and the NAME says
# everything -- "Boat Ramp" at one metre is a boat ramp.
#
# So: the name has to read like a launch, and the type is used only to throw OUT the things that
# share the vocabulary without being one. "Potato Creek Landing" is an `american_restaurant` 37 m
# away and is a restaurant called Landing; "Lake Murray Boat Rentals" is a business; "Delta Guide
# Service" is a charter. A bridge is NOT disqualifying, because a bridge is how Ryan's own
# curated list names two of its launches -- "Bates Bridge", "Highway 1 (Camden / USGS gauge)".
# AND THE TYPE IS NOT USED AT ALL, WHICH THE SECOND RUN ALSO PROVED.
#
# Using the type to throw things OUT went wrong in the other direction. A Santee Cooper fish
# camp has a restaurant and a store in it, so Google types it `restaurant, store` -- and the
# second cut dropped Blacks Camp, Hill's Landing RV Park, Hidden Cove Marina and three more, all
# of which are places Ryan launches from. A marina with a grill is still a marina.
#
# So the type is ignored and only the NAME is read, in both directions. A launch is a thing with
# a launch word in its name; a shop is a thing with a shop word in its name.
#
# WORD BOUNDARIES, NOT SUBSTRINGS. Bare 'boat' matched "Better Boating - Irmo", a boat DEALER,
# and it beat "Lake Murray Marina" 27 m away because it happened to be nearer. So 'boat' only
# counts in the phrases that mean a launch, and every other word is matched whole.
LAUNCH_RE = re.compile(
    r'\bboat\s+(ramp|landing|launch|dock|slip)|'
    r'\b(ramps?|landings?|launch|slipway|marina|dock|ferry|camp|campground|access|put[-\s]?in)\b',
    re.I)
# Read first, and it wins: these are businesses that live at the water and are not the launch.
NOT_A_LAUNCH_RE = re.compile(
    r'\b(rentals?|charters?|guide\s+service|tackle|trailhead|restaurant|grill|'
    r'realty|real\s+estate|dealer|marine\s+(sales|service))\b', re.I)

# How close Google's answer has to be before it is the same place rather than a neighbour.
ACCEPT_M = 60


def load_json(p):
    with open(p, encoding='utf-8') as fh:
        return json.load(fh)


def unnamed_points(chartpack, waters):
    """One row per PLACE. A landing is offered on every water it reaches, so dedupe on position."""
    rows = {}
    for slug in waters:
        p = os.path.join(chartpack, slug, 'launches.json')
        if not os.path.isfile(p):
            print('   no pack file for %s' % slug)
            continue
        for r in load_json(p)['landings']:
            if r.get('name') or (r.get('access') or '') in CLOSED:
                continue
            k = (round(r['lat'], 5), round(r['lon'], 5))
            rows.setdefault(k, {'lat': r['lat'], 'lon': r['lon'], 'waters': set()})
            rows[k]['waters'].add(slug)
    return rows


# CLOUDFLARE REFUSES `Python-urllib/3.x` WITH A 403 BEFORE THE WORKER EVER SEES THE REQUEST.
# The same URL in a browser returns 200, which is how this was found and is why the first run of
# this script reported "cannot reach the worker" for a Worker that was up and answering. Any
# ordinary User-Agent is enough; this one says what it is so the log is readable.
UA = 'TrollMapPipeline/1.0 (name_launches_from_places.py)'


def post(url, body, token):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'X-Sync-Token': token, 'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode('utf-8'))


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))


def reads_like_a_launch(r):
    """Does this result's NAME say it is somewhere you put a boat in? The type is not consulted."""
    nm = str(r.get('name') or '')
    if not nm:
        return False
    if NOT_A_LAUNCH_RE.search(nm):
        return False
    return bool(LAUNCH_RE.search(nm))


def pick(results):
    """The one result worth calling this launch, or None with a reason.

    Nearest first, because `rankPreference: DISTANCE` asked for that order, and the first
    result that reads like a launch wins. A closer thing that is not a launch does not veto a
    slightly further thing that is: a ramp 30 m away is still the ramp when there is a shop 20 m
    away with it.
    """
    if not results:
        return None, 'google has nothing within the radius'
    near = [r for r in results if (r.get('m') is not None and r['m'] <= ACCEPT_M)]
    if not near:
        return None, 'nearest is %d m away' % (results[0].get('m') or -1)
    for r in near:
        if reads_like_a_launch(r):
            return r, ''
    return None, 'within %d m but nothing reads like a launch (%s)' % (
        ACCEPT_M, '; '.join('%s [%s]' % (x.get('name'), ','.join((x.get('types') or [])[:2]))
                            for x in near[:2]))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--chartpack', required=True)
    ap.add_argument('--waters', required=True,
                    help='comma list of slugs. There is no "all": every point costs money and '
                         'the budget is Ryan\'s, so the set is always named out loud.')
    ap.add_argument('--worker', default=WORKER)
    ap.add_argument('--go', action='store_true', help='spend; without it nothing is asked')
    ap.add_argument('--rejudge', action='store_true',
                    help='re-apply the accept rule to the answers already on disk and rewrite '
                         'the file. No token, no network, no money: every suggestion Google gave '
                         'is stored, so improving the judgement never costs a second lookup. '
                         'This is what the first bad rule was fixed with.')
    a = ap.parse_args()

    # THE DRY RUN NEEDS NO TOKEN, BECAUSE IT SPENDS NOTHING. Counting the points and reading
    # the budget are both free, and a run that cannot be rehearsed without a secret is a run
    # nobody rehearses.
    token = os.environ.get('TROLLMAP_SYNC_TOKEN')
    if a.go and not token:
        print('TROLLMAP_SYNC_TOKEN is not set in this shell.\n'
              '  set TROLLMAP_SYNC_TOKEN=<the worker token>\n'
              'It is read from the environment on purpose: it is not in this file, not in the\n'
              'command line, and not in anything this writes. Drop --go to rehearse without it.')
        return 2

    waters = [s.strip() for s in a.waters.split(',') if s.strip()]
    rows = unnamed_points(a.chartpack, waters)
    print('waters: %d, distinct unnamed launches: %d' % (len(waters), len(rows)))

    dest = os.path.join(a.registry, '_place_names.json')
    known = {}
    if os.path.isfile(dest):
        known = (load_json(dest).get('places') or {})
        print('already looked up: %d' % len(known))

    if a.rejudge:
        was = sum(1 for r in known.values() if r.get('accepted'))
        changed = []
        for key, r in known.items():
            best, why = pick(r.get('suggestions') or [])
            now_ok, now_nm = bool(best), (best or {}).get('name')
            if now_ok != bool(r.get('accepted')) or now_nm != r.get('name'):
                changed.append((key, r.get('name'), now_nm))
            r['accepted'] = now_ok
            r['name'] = now_nm
            r['m'] = (best or {}).get('m')
            r['why_not'] = '' if best else why
        now = sum(1 for r in known.values() if r.get('accepted'))
        print('\nre-judged %d answers, accepted %d -> %d' % (len(known), was, now))
        for key, before, after in sorted(changed, key=lambda c: str(c[2] or '')):
            print('   %-46s %s' % (after or '(dropped: %s)' % before, key))
        with open(dest, 'w', encoding='utf-8') as fh:
            json.dump({'_note': 'name_launches_from_places.py --rejudge', 'places': known},
                      fh, indent=1)
        print('\nwrote %s -- nothing was asked and nothing was spent' % dest)
        return 0

    todo = [k for k in rows if '%.5f,%.5f' % k not in known]
    print('to ask Google: %d' % len(todo))

    try:
        b = get(a.worker + '/places/name')
        print('worker budget: %s spent %s of %s, key configured=%s'
              % (b.get('month'), b.get('spent'), b.get('ceiling'), b.get('configured')))
        if not b.get('configured'):
            print('!! PLACES_API_KEY is not set on the Worker -- nothing to ask with')
            return 2
    except Exception as e:
        print('!! cannot reach %s (%s)' % (a.worker, e))
        return 2

    if not a.go:
        print('\nDRY RUN -- nothing asked, nothing spent. Add --go.')
        print('   it would cost %d Nearby Search Pro calls (free pool is 5,000 a month)' % len(todo))
        return 0

    found = dict(known)
    asked = accepted = 0
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        body = {'points': [{'lat': rows[k]['lat'], 'lon': rows[k]['lon']} for k in chunk]}
        try:
            res = post(a.worker + '/places/name', body, token)
        except urllib.error.HTTPError as e:
            print('!! %s -- %s' % (e.code, e.read().decode('utf-8', 'replace')[:300]))
            break
        except Exception as e:
            print('!! %s' % e)
            break
        for k, r in zip(chunk, res.get('results') or []):
            asked += 1
            if r.get('error'):
                print('   %.5f,%.5f  %s' % (k[0], k[1], r['error']))
                continue
            best, why = pick(r.get('results') or [])
            rec = {'lat': rows[k]['lat'], 'lon': rows[k]['lon'],
                   'waters': sorted(rows[k]['waters']),
                   'accepted': bool(best),
                   'name': (best or {}).get('name'),
                   'place_id': (best or {}).get('place_id'),
                   'm': (best or {}).get('m'),
                   'why_not': '' if best else why,
                   'suggestions': [{'name': s.get('name'), 'm': s.get('m'),
                                    'types': s.get('types')} for s in (r.get('results') or [])[:3]],
                   'at': r.get('at')}
            found['%.5f,%.5f' % k] = rec
            if best:
                accepted += 1
                print('   %-38s %5d m  %.5f,%.5f' % (best.get('name'), best.get('m') or -1, k[0], k[1]))
        bud = res.get('budget') or {}
        print('-- batch %d/%d, month %s spent %s of %s'
              % (i // BATCH + 1, (len(todo) + BATCH - 1) // BATCH,
                 bud.get('month'), bud.get('spent'), bud.get('ceiling')))
        time.sleep(0.5)

    doc = {'_note': 'name_launches_from_places.py -- Google Nearby Search, keyed to 5 dp. '
                    'build_ramp_reach.py reads accepted names in access_points(). A record with '
                    'accepted=false is a SUGGESTION for a human, never a name.',
           'places': found}
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, indent=1)
    print('\nasked %d, accepted %d, wrote %s (%d total)' % (asked, accepted, dest, len(found)))
    if accepted:
        print('\nSHIP IT -- the names only reach the app through a rebuild:')
        print('  py .\\build_ramp_reach.py --registry ... --extract ... --chartpack ... --all --go')
        print('  py .\\upload_garmin_to_r2.py --root ... --layers launches')
    return 0


if __name__ == '__main__':
    sys.exit(main())
