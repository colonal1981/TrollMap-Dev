#!/usr/bin/env python3
r"""gen_water_aliases_js.py - generate js/data/water-aliases.js from the river cutter's output.

Personal use only, not for distribution or resale; not for navigation.

    python3 Scripts/gen_water_aliases_js.py            # write
    python3 Scripts/gen_water_aliases_js.py --check    # exit 1 if the JS is stale

WHY THIS EXISTS

make_river_boundaries.py writes two files next to the boundaries:

    _coastal_pointers.json   158 DNR waterbody names whose water belongs to a coastal zone
    _river_aliases.json       12 names that are a second name for a river that has a boundary

Both had ZERO readers. Nothing in js/, Worker/ or Scripts/ referenced either one, so every
name in them fell through to `resolveR2Key`'s fuzzy pass -- and measured on 2026-08-04, that
pass did not merely fail. It answered, wrongly, 26 times:

    Waccamaw River   (Conway, SC)   -> lake_waccamaw          a different lake, in NC
    May River        (Bluffton, SC) -> mayo_lake              NC, ~400 km away
    South Creek      (Pamlico, NC)  -> south_holston_lake     Tennessee
    Black Creek      (Pee Dee, SC)  -> lake_blackshear        Georgia
    Russ Creek       (SC)           -> lake_thurmond_russell

Pass 4 prefers the longest canonical key contained in the normalised name and has no notion
of distance or state, so "May River" contains "mayo". Failing to resolve is survivable --
nothing loads. Resolving to Georgia contours over a South Carolina creek is not, and nothing
in the UI says so.

The names themselves were never the problem: access-index.js keys `byLake` by the DNR
waterbody name off the worker's /ramps feed, so all 170 are already in the picker with their
own ramps. The only missing link was name -> chartpack key.

ONE NAME, SEVERAL WATERS

Eight base names cover more than one zone -- there are three North Rivers, two Wando Rivers,
and an Intracoastal Waterway with landings in eight zones. The cutter disambiguates those as
"North River (2)", but the picker shows the DNR name without a suffix, so the suffixed form is
unreachable by name alone.

So this emits both: the exact name for anything that carries a suffix, and a candidate LIST
for the base name, ordered by how many landings each zone has. `resolveWaterKey` takes the
first, which is the most-landings zone and a deterministic answer rather than a guess between
states. lake-ramp-select.js narrows it further using the ramps it has already looked up --
which is exact, and is the only thing that makes the Intracoastal answerable at all.

INPUTS

Default to `<repo>/../lake_boundaries`, which is where the pipeline writes them
(F:\TrollMapPipeline\lake_boundaries next to F:\TrollMapPipeline\TrollMap-Dev-main). When the
inputs are absent this exits 0 and leaves the JS alone, so a checkout without the pipeline
beside it is not a failure.
"""
import argparse, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
OUT = os.path.join(REPO, 'js', 'data', 'water-aliases.js')
DEFAULT_DIR = os.path.join(os.path.dirname(REPO), 'lake_boundaries')

SUFFIX = re.compile(r'\s\(\d+\)$')

HEADER = '''/**
 * water-aliases.js — DNR waterbody name → chartpack key.
 *
 * GENERATED FILE — DO NOT EDIT BY HAND.
 * Source of truth: lake_boundaries/_coastal_pointers.json + _river_aliases.json,
 *                  written by scripts/make_river_boundaries.py
 * Regenerate:      python3 Scripts/gen_water_aliases_js.py
 * Guarded by:      test/water-aliases.test.js
 *
 * Every name here reaches the picker from the worker's /ramps feed (access-index.js keys
 * byLake by the DNR waterbody name), so they were always selectable — they just had no
 * chartpack behind them. Without this table they fall through to resolveR2Key's fuzzy pass,
 * which on 2026-08-04 answered WRONGLY for 26 of them: "May River" in Bluffton SC resolved
 * to Mayo Lake in North Carolina, "Black Creek" on the Pee Dee to Lake Blackshear in Georgia.
 * A silent wrong answer is worse than no answer, which is why this is consulted BEFORE the
 * fuzzy pass and why the test asserts every key here actually exists.
 *
 *   WATER_TO_R2_KEY         exact display name → key. Coastal names give a coast_* zone
 *                           slug, which is already the chartpack prefix; alias names give the
 *                           slug of the river that owns the water.
 *   WATER_ZONE_CANDIDATES   base name (no "(2)" suffix) → every zone that name has landings
 *                           in, most landings first. Eight names need this; the Intracoastal
 *                           Waterway has eight zones to itself.
 */

'''

FOOTER = '''
/** Chartpack key for a waterbody name, or null. Exact match first, then the base name. */
export function resolveWaterKey(name) {
  if (!name || typeof name !== 'string') return null;
  const n = name.trim();
  if (!n) return null;
  if (WATER_TO_R2_KEY[n]) return WATER_TO_R2_KEY[n];
  const stripped = n.replace(/,\\s*[A-Z]{2}(\\/[A-Z]{2})*$/i, '').trim();
  if (stripped !== n && WATER_TO_R2_KEY[stripped]) return WATER_TO_R2_KEY[stripped];
  const cands = WATER_ZONE_CANDIDATES[n] || WATER_ZONE_CANDIDATES[stripped];
  return (cands && cands[0]) || null;
}

/**
 * Every zone a name has landings in. lake-ramp-select.js uses this to pick the zone the
 * selected waterbody's own access points actually sit in, which is what makes "Intracoastal
 * Waterway" open the right 30 km of it rather than whichever zone happens to be first.
 */
export function waterZoneCandidates(name) {
  if (!name || typeof name !== 'string') return [];
  const n = name.trim();
  const stripped = n.replace(/,\\s*[A-Z]{2}(\\/[A-Z]{2})*$/i, '').trim();
  return WATER_ZONE_CANDIDATES[n] || WATER_ZONE_CANDIDATES[stripped]
      || (WATER_TO_R2_KEY[n] ? [WATER_TO_R2_KEY[n]] : []);
}
'''


def river_names(bdir):
    """Names that got a river boundary of their own.

    A DNR name can have landings on both sides of the salt line -- the Altamaha has 16
    freshwater ramps and a couple in the sound -- so the cutter writes it a river boundary AND
    a coastal pointer. The river wins: it is a real clipped polygon over the water most of its
    landings are on, and the estuary is covered by the coastal pack anyway. Emitting the
    pointer too would mean this table disagreed with the registry about the same name.
    """
    import glob
    out = set()
    for fp in glob.glob(os.path.join(bdir, '*_river.geojson')):
        try:
            gj = json.load(open(fp, encoding='utf-8'))
            for f in (gj.get('features') or []):
                nm = (f.get('properties') or {}).get('name')
                if nm:
                    out.add(nm)
        except Exception:
            continue
    return out


def build(pointers, aliases, owns_river=frozenset()):
    exact, groups = {}, {}
    for rec in pointers.values():
        name, zone = rec.get('name'), rec.get('zone')
        if not name or not zone:
            continue                      # an orphan pointer has no zone; it stays unresolved
        if name in owns_river:
            continue                      # the registry answers for this one
        exact[name] = zone
        base = SUFFIX.sub('', name)
        groups.setdefault(base, []).append((int(rec.get('ramps') or 0), zone))

    cands = {}
    for base, rows in groups.items():
        # Most landings first, then the zone slug, so a re-run cannot reshuffle the default.
        ordered, seen = [], set()
        for _n, zone in sorted(rows, key=lambda t: (-t[0], t[1])):
            if zone not in seen:
                seen.add(zone)
                ordered.append(zone)
        if len(ordered) > 1 or base not in exact:
            cands[base] = ordered

    for rec in aliases.values():
        name, target = rec.get('name'), rec.get('alias_of')
        if name and target:
            exact.setdefault(name, target)

    return exact, cands


def render(exact, cands):
    out = [HEADER, 'export const WATER_TO_R2_KEY = {\n']
    for name in sorted(exact):
        out.append('  %s: %s,\n' % (json.dumps(name), json.dumps(exact[name])))
    out.append('};\n\nexport const WATER_ZONE_CANDIDATES = {\n')
    for base in sorted(cands):
        out.append('  %s: %s,\n' % (json.dumps(base), json.dumps(cands[base])))
    out.append('};\n')
    out.append(FOOTER)
    return ''.join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dir', default=DEFAULT_DIR, help='folder holding the two JSON files')
    ap.add_argument('--check', action='store_true', help='exit 1 if the JS is stale')
    a = ap.parse_args()

    fp_p = os.path.join(a.dir, '_coastal_pointers.json')
    fp_a = os.path.join(a.dir, '_river_aliases.json')
    if not os.path.exists(fp_p) and not os.path.exists(fp_a):
        # Not an error. A checkout without the pipeline beside it cannot regenerate, and
        # failing here would turn "you do not have the data" into "the build is broken".
        print('no _coastal_pointers.json / _river_aliases.json in %s -- nothing to do' % a.dir)
        return 0

    pointers = json.load(open(fp_p, encoding='utf-8')) if os.path.exists(fp_p) else {}
    aliases = json.load(open(fp_a, encoding='utf-8')) if os.path.exists(fp_a) else {}
    text = render(*build(pointers, aliases, river_names(a.dir)))

    if a.check:
        current = open(OUT, encoding='utf-8').read() if os.path.exists(OUT) else ''
        if current != text:
            print('water-aliases.js is stale -- run python3 Scripts/gen_water_aliases_js.py')
            return 1
        print('water-aliases.js is up to date')
        return 0

    with open(OUT, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    print('-> %s  (%d pointers, %d aliases, %d names deferred to their river boundary)'
          % (OUT, len(pointers), len(aliases), len(river_names(a.dir) & {r.get('name') for r in pointers.values()})))
    return 0


if __name__ == '__main__':
    sys.exit(main())
