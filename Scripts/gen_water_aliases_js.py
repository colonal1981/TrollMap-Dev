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
# Sibling of lake_boundaries. This is what the INSTALL wrote, i.e. what the app can actually
# load -- see river_names() for why the difference matters.
DEFAULT_REGISTRY = os.path.join(os.path.dirname(REPO), 'registry', 'boundaries')
DEFAULT_INDEX = os.path.join(os.path.dirname(REPO), 'registry', 'lake_index.json')
DEFAULT_LAKE_KEYS = os.path.join(REPO, 'js', 'data', 'lake-keys.js')

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


def river_names(bdir, regdir=None):
    """Names that got a river boundary of their own AND actually shipped it.

    A DNR name can have landings on both sides of the salt line -- the Altamaha has 16
    freshwater ramps and a couple in the sound -- so the cutter writes it a river boundary AND
    a coastal pointer. The river wins: it is a real clipped polygon over the water most of its
    landings are on, and the estuary is covered by the coastal pack anyway. Emitting the
    pointer too would mean this table disagreed with the registry about the same name.

    BOTH SIGNALS, NEVER EITHER ALONE. This used to read lake_boundaries/ and stop there -- what
    the CUTTER WROTE. install_registry_boundary.py then applies its own floors, so the two sets
    diverge, and a name in the gap gets its pointer suppressed in favour of a river that does
    not exist anywhere the app can see.

    Ashley River, 2026-08-05, is the case. Its landings split 3 salt / 2 fresh on the SC
    statutory line (Section 50-5-80), so the cutter correctly wrote both a coastal pointer to
    coast_charleston_sc and a small freshwater polygon. That polygon came out at 0.05 km2 -- 12
    acres -- and the install dropped it. The deferral then fired on the file alone and removed
    the pointer too, so a name with three SCDNR landings on Charleston Harbor resolved to
    nothing at all. Neither half of that is visible from the app: the picker offers the name and
    the map stays empty.

    The premise in the paragraph above is "a REAL clipped polygon". registry/boundaries/ is
    where that becomes true, so it is what gets asked.
    """
    import glob
    named = {}
    for fp in glob.glob(os.path.join(bdir, '*_river.geojson')):
        try:
            gj = json.load(open(fp, encoding='utf-8'))
            for f in (gj.get('features') or []):
                nm = (f.get('properties') or {}).get('name')
                if nm:
                    named.setdefault(nm, set()).add(
                        os.path.basename(fp)[:-len('_river.geojson')])
        except Exception:
            continue
    if not regdir or not os.path.isdir(regdir):
        # No registry to check against -- a checkout without the pipeline beside it. Keep the
        # old behaviour rather than inventing pointers, and say which one ran.
        print('note: no registry/boundaries at %s -- deferring on the cut files alone, which '
              'over-defers for any river the install rejected' % regdir, file=sys.stderr)
        return set(named)
    shipped = {f[:-len('.geojson')] for f in os.listdir(regdir) if f.endswith('.geojson')}
    return {nm for nm, slugs in named.items() if slugs & shipped}


def already_answered(index_path, lake_keys_path):
    """name.lower() -> slug, for every name something EARLIER than pass 3.5 resolves.

    WHY A TABLE OF NAMES THIS FILE MUST NOT TOUCH

    The cutter decides ownership from ramp landings, so a lake whose landings sit on a river
    polygon comes back as "owns no water" and gets aliased to that river. For a creek with no
    pack of its own that is exactly right -- it is the whole point of the alias table. For a
    lake that HAS a pack it is a hijack, and on 2026-08-05 there were eight of them:

        Lake Wylie        -> catawba_river_2         (its own pack is lake_wylie)
        Norris Reservoir  -> powell_river            (norris_lake)
        Weiss Lake        -> coosa_river             (weiss_lake)
        Lake Seminole     -> flint_river             (lake_seminole)
        Bull Sluice Lake  -> chattahoochee_river_3   (bull_sluice_lake)
        Lake Mattamuskeet -> coast_pamlico_sound_nc  (lake_mattamuskeet)
        Lake Mayer        -> coast_savannah_ga       (lake_mayer)
        Wee Tee Lake      -> coast_santee_delta_sc   (wee_tee_lake_sc)

    Every one of those is a real impoundment on or beside the water it got aliased to, which is
    why the cutter is not wrong to associate them -- it is wrong to REPLACE them.

    resolveR2Key was supposed to make this impossible: passes 1-3 consult the curated map before
    pass 3.5 reads this table. But pass 3 strips a state suffix from the INCOMING name, not from
    the map's keys, so "Lake Wylie" never reaches the curated entry "Lake Wylie, SC/NC" and falls
    straight through to the alias. Pass 0 covers it at runtime once access-index.js has
    registered the registry, and did not in the test harness -- so whether Lake Wylie loaded
    Lake Wylie depended on load order.

    A generated table should not need the resolver to defend against it. Names something else
    already answers are dropped here, and the resolver's pass order stops mattering.

    Both sources are needed: seven of the eight are registry display names, and "Norris
    Reservoir" exists only in the curated map.
    """
    out = {}
    try:
        idx = json.load(open(index_path, encoding='utf-8'))
        for slug, v in (idx.items() if isinstance(idx, dict) else []):
            names = [v.get('display_name'), v.get('name'), v.get('legacy_display_name')]
            names += (v.get('legacy_display_names') or [])
            for nm in names:
                if nm:
                    out.setdefault(nm.strip().lower(), slug)
    except Exception as exc:
        print('note: no usable %s (%s) -- shadow check falls back to the curated map alone'
              % (index_path, type(exc).__name__), file=sys.stderr)

    try:
        src = open(lake_keys_path, encoding='utf-8').read()
        blk = src.split('LAKE_NAME_TO_R2_KEY = {', 1)[1].split('\n};', 1)[0]
        pairs = re.findall(r"^\s*'([^']+)':\s*'([^']+)'", blk, re.M)
        # A regex over JS is fragile by nature, so it declares itself rather than degrading:
        # this map has had ~200 entries since it was written, and a handful means the shape
        # changed and the shadow check has quietly stopped protecting anything.
        if len(pairs) < 50:
            raise ValueError('parsed only %d entries from LAKE_NAME_TO_R2_KEY' % len(pairs))
        for nm, slug in pairs:
            out.setdefault(nm.strip().lower(), slug)
            bare = re.sub(r',\s*[A-Za-z/]{2,5}$', '', nm).strip().lower()
            out.setdefault(bare, slug)     # pass 3 cannot reach this form; see the docstring
    except Exception as exc:
        print('note: could not read %s (%s: %s) -- shadow check is registry-only'
              % (lake_keys_path, type(exc).__name__, exc), file=sys.stderr)
    return out


def build(pointers, aliases, owns_river=frozenset(), answered=None):
    exact, groups = {}, {}
    answered = answered or {}
    shadowed = []
    for rec in pointers.values():
        name, zone = rec.get('name'), rec.get('zone')
        if not name or not zone:
            continue                      # an orphan pointer has no zone; it stays unresolved
        if name in owns_river:
            continue                      # the registry answers for this one
        prior = answered.get(name.strip().lower())
        if prior and prior != zone:
            shadowed.append((name, zone, prior))
            continue                      # see already_answered()
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
        if not name or not target:
            continue
        prior = answered.get(name.strip().lower())
        if prior and prior != target:
            shadowed.append((name, target, prior))
            continue                      # see already_answered()
        exact.setdefault(name, target)

    if shadowed:
        print('  %d name(s) dropped -- something earlier already answers them:' % len(shadowed),
              file=sys.stderr)
        for nm, would, prior in sorted(shadowed):
            print('     %-28s cutter said %-26s registry/curated says %s'
                  % (nm, would, prior), file=sys.stderr)

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
    ap.add_argument('--index', default=DEFAULT_INDEX,
                    help='registry/lake_index.json -- names the registry already answers')
    ap.add_argument('--lake-keys', default=DEFAULT_LAKE_KEYS,
                    help='js/data/lake-keys.js -- names the curated map already answers')
    ap.add_argument('--registry-boundaries', default=DEFAULT_REGISTRY,
                    help='registry/boundaries -- a river only outranks its coastal pointer if '
                         'its boundary actually installed. See river_names().')
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
    owns = river_names(a.dir, a.registry_boundaries)
    answered = already_answered(a.index, a.lake_keys)
    text = render(*build(pointers, aliases, owns, answered))

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
          % (OUT, len(pointers), len(aliases), len(owns & {r.get('name') for r in pointers.values()})))
    return 0


if __name__ == '__main__':
    sys.exit(main())
