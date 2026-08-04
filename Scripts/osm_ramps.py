#!/usr/bin/env python3
"""osm_ramps.py - every boat ramp OSM knows about, from the .pbf files already on the drive.

Personal use only, not for distribution or resale; not for navigation.

    pip install osmium
    py osm_ramps.py --pbf F:\\TrollMapPipeline\\osm_pbf --out F:\\TrollMapPipeline\\osm_ramps.geojson

WHY THIS IS THE ONE THAT SCALES

Every other ramp source we have is an agency publishing its OWN sites, so covering four
states means finding and wiring every agency that owns water:

    SCDNR / GA WRD / NC WRC / TWRA     state wildlife      already wired
    SC Forestry Commission             state forest        NOT wired -- this is where the
                                                           Wee Tee State Forest ramps live
    USFS                               national forest     NOT wired -- Guilliard, Francis Marion
    USACE / TVA / Santee Cooper /      federal + utility   partly inside the SCDNR feed, which
      Duke / Dominion / SCDOT                              carries them in its `owner` field
    counties, municipalities, HOAs     everything else     unenumerable

OSM does not care who owns it. `leisure=slipway` is one tag with nationwide coverage, it
carries `access` / `boat` / `motorboat` / `canoe`, and those tags are the ONLY place in any
of our sources where *public vs private* is written down as data rather than inferred from
which agency's list a site appears on. Ryan already hit this from the other side: Second
Mill's OSM relation carries `boat=private`, `canoe=private`, `motorboat=no`.

WHAT IT WILL NOT DO

OSM is volunteered. Absence is not evidence -- Wee Tee has a ramp Ryan has used and Garmin
draws nothing there, and OSM may be no better. Treat a hit as evidence and a miss as
silence. That is why `access` is emitted verbatim, including when it is absent: an
unsurveyed ramp and a private ramp must not collapse to the same answer.

TAGS COLLECTED, and why each

    leisure=slipway         the standard tag. Node, way or relation.
    waterway=slipway        deprecated but still in the data on older imports.
    service=slipway         on a highway=service -- the ACCESS ROAD down to a ramp. Kept
                            because in rural mapping it is often the only thing tagged.
    amenity=boat_ramp       nonstandard, appears in US imports.

Ways and relations are reduced to the centroid of their node coordinates. A ramp is a few
metres across, so a centroid is the right answer, not a compromise.
"""
import argparse, json, math, os, re, sys
from collections import defaultdict

try:
    import osmium
except ImportError:
    sys.exit('pip install osmium')

RAMP_KEYS = (('leisure', 'slipway'), ('waterway', 'slipway'),
             ('service', 'slipway'), ('amenity', 'boat_ramp'))
KEEP = ('name', 'operator', 'access', 'boat', 'motorboat', 'canoe', 'fee', 'surface',
        'ownership', 'operator:type', 'description', 'website')


def _ramp_tag(tags):
    """Return the matching 'k=v' string, or None. Takes an osmium TagList, not a dict."""
    for k, v in RAMP_KEYS:
        if tags.get(k) == v:
            return '%s=%s' % (k, v)
    return None


class Ramps(osmium.SimpleHandler):
    def __init__(self, state):
        super().__init__()
        self.state = state
        self.out = []
        self.seen = set()

    def _emit(self, osm_id, kind, tags, lon, lat):
        key = (kind, osm_id)
        if key in self.seen:
            return
        self.seen.add(key)
        p = {'osm_type': kind, 'osm_id': osm_id, 'state': self.state}
        for k in KEEP:
            v = tags.get(k)
            if v:
                p[k.replace(':', '_')] = v
        p['tag'] = next(('%s=%s' % (k, v) for k, v in RAMP_KEYS if tags.get(k) == v), None)
        self.out.append({'type': 'Feature', 'properties': p,
                         'geometry': {'type': 'Point',
                                      'coordinates': [round(lon, 7), round(lat, 7)]}})

    # PERFORMANCE, and it matters a lot here.
    #
    # pyosmium calls these back for EVERY object in the file -- roughly 100 million nodes
    # across the four state extracts. The first version of this file ran `dict(n.tags)` at
    # the top of node(), which built and threw away a dict a hundred million times for the
    # ~0.1% of nodes that carry any tag at all, and turned a few-minute job into an hour.
    #
    # `if not o.tags` is a C-level length check on the TagList and rejects the overwhelming
    # majority before Python touches anything. Everything below it runs on a rounding error's
    # worth of objects, so it can be as slow as it likes.
    def node(self, n):
        if not n.tags:
            return
        if _ramp_tag(n.tags) and n.location.valid():
            self._emit(n.id, 'node', dict(n.tags), n.location.lon, n.location.lat)

    def way(self, w):
        if not w.tags or not _ramp_tag(w.tags):
            return
        pts = [(nd.location.lon, nd.location.lat) for nd in w.nodes if nd.location.valid()]
        if not pts:
            return
        self._emit(w.id, 'way', dict(w.tags), sum(p[0] for p in pts) / len(pts),
                   sum(p[1] for p in pts) / len(pts))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--pbf', required=True, help='folder of *.osm.pbf, or one file')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    files = ([a.pbf] if a.pbf.lower().endswith('.pbf')
             else sorted(os.path.join(a.pbf, f) for f in os.listdir(a.pbf)
                         if f.lower().endswith('.pbf')))
    if not files:
        sys.exit('no .pbf in %s' % a.pbf)

    feats = []
    for fp in files:
        state = re.split(r'[-_]\d', os.path.basename(fp))[0]
        h = Ramps(state)
        # locations=True builds the node cache ways need. Sparse array keeps it in RAM;
        # a state-sized extract is fine, a CONUS one is not.
        h.apply_file(fp, locations=True, idx='sparse_mem_array')
        print('%-22s %6d ramps' % (state, len(h.out)))
        feats.extend(h.out)

    json.dump({'type': 'FeatureCollection', 'features': feats},
              open(a.out, 'w', encoding='utf-8'))

    named = sum(1 for f in feats if f['properties'].get('name'))
    acc = defaultdict(int)
    for f in feats:
        acc[f['properties'].get('access') or '(no access tag)'] += 1
    print('\n%d ramps total, %d named (%.0f%%)' % (len(feats), named,
                                                   100 * named / max(1, len(feats))))
    print('access tag:')
    for k, v in sorted(acc.items(), key=lambda kv: -kv[1]):
        print('   %-18s %d' % (k, v))
    print('-> %s' % a.out)


if __name__ == '__main__':
    main()
