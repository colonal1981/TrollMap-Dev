#!/usr/bin/env python3
r"""build_data_map.py -- where every fact about a water actually lives. FOR CLAUDE, NOT FOR RYAN.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\build_data_map.py --registry "F:\TrollMapPipeline\registry" --repo "F:\TrollMapPipeline\TrollMap-Dev"

Writes registry\_data_map.json -- generated, leading underscore, never uploaded, never hand-edited.

WHY THIS EXISTS, AND IT IS NOT A NICE-TO-HAVE

On 2026-09-03 a session was asked a simple question -- how many waters have a species list -- and
got it wrong FOUR TIMES IN A ROW, each time by looking in a place that was not where the answer
lived:

  said 5 of 13 coastal zones have species     missed SC_INSHORE_ROSTER, which is applied in
                                              Worker/research/deterministic.js and lives in no file
  said the GA zones get nothing from ramps    the species were there, under `meta.species`, one
                                              level below the key that was searched for
  said 182 of 355 waters have species         the ramp feeds carry them for 110 waters and were
                                              not counted at all; the real figure was 216
  said Lake Greenwood has no species          its stored research profile has had Largemouth Bass
                                              since version 17

Ryan, after the third: *"holy crap you need to draw yourself a map in the form of a json... the
where the hell the data is gathered from and used for JSON... for claude not for ryan."*

Every one of those was the same mistake -- reasoning about where a fact SHOULD be instead of
reading where it IS. A model cannot grep its way out of that, because the failure is not knowing
that a fifth place exists. So this file enumerates the places.

WHAT IT MAPS, WHICH IS FIVE KINDS OF PLACE AND NOT ONE

  1. registry/*.json           28 files hold data keyed by our slug, and the container sits at a
                               DIFFERENT PATH in nearly every one: `rows`, `waters`, `lakes`,
                               `zones`, `bindings`, `by_lake`, `slug_to_r2_key`, or the bare root.
  2. the leaf path inside      `meta.species` is not `species`. The whole record shape is walked
                               and reported, so no one has to guess how deep a field sits.
  3. runtime writers           floors applied when a profile is built, which no file holds:
                               SC_INSHORE_ROSTER, the advisory floor, the regulations floor.
  4. stored research profiles  R2 `lakes/<id>.json`, read through the Worker's /research/get.
                               This is what the CARD shows, and it is the union of everything
                               above plus whatever research found.
  5. js/data/*.js constants    tables the Worker imports directly, like ga-access-species.js.

DERIVED, NOT TYPED. Every entry is discovered by reading the files and grepping the repo, so a
new source appears here the run after it is added. A hand-written map of a moving pipeline is
wrong within a week and worse than nothing, because it is believed.
"""

from __future__ import annotations
import argparse, datetime, json, os, re, subprocess, sys

OUT_NAME = '_data_map.json'
SKIP_PREFIX = '_'                      # generated/review files describe nothing new
MAX_BYTES = 60_000_000
CODE_DIRS = ('Scripts', 'Worker', 'js', 'test')

# A field worth indexing by name -- the question "where does X live" is only ever asked about
# things the app reasons with. Discovered leaves are matched against these as whole words.
FACTS = ('species', 'predatorSpecies', 'ramps', 'gauge', 'usgs', 'full_pool', 'elevation',
         'attractors', 'advisory', 'do_not_eat', 'regulations', 'rules', 'tide', 'county',
         'area_acres', 'centroid', 'bounds', 'charted', 'stocking', 'forage')


def norm_leaf(p):
    return re.sub(r'\[\d+\]', '[]', p)


def walk(o, path='', depth=0, out=None, cap=400):
    """Every leaf path in a record, with an example value. `meta.species` is why this exists."""
    if out is None:
        out = {}
    if len(out) >= cap or depth > 6:
        return out
    if isinstance(o, dict):
        for k, v in o.items():
            walk(v, '%s.%s' % (path, k) if path else k, depth + 1, out, cap)
    elif isinstance(o, list):
        if o:
            walk(o[0], path + '[]', depth + 1, out, cap)
        else:
            out.setdefault(path + '[]', '(empty list)')
    else:
        if path and path not in out:
            v = o if not isinstance(o, str) else (o[:70] + ('...' if len(o) > 70 else ''))
            out[path] = v
    return out


def at_path(rec, leaf):
    """Every value found at a walked leaf path, following `[]` into lists. [] when absent."""
    cur = [rec]
    for part in leaf.split('.'):
        nxt = []
        name, lists = part, 0
        while name.endswith('[]'):
            name, lists = name[:-2], lists + 1
        for c in cur:
            # AN EMPTY NAME MEANS THE CONTAINER IS THE LIST. Half the ramp feeds are keyed
            # slug -> [records], so their leaves start with `[]` and there is no key to look up.
            # Requiring one reported dnr_ramps_by_lake.json as holding species for ZERO waters
            # when it holds them for a hundred.
            if not name:
                v = c
            elif isinstance(c, dict):
                v = c.get(name)
            else:
                v = None
            if v is None:
                continue
            layer = [v]
            for _ in range(lists):
                layer = [x for it in layer if isinstance(it, list) for x in it]
            nxt += layer
        cur = nxt
        if not cur:
            return []
    return [c for c in cur if c not in (None, '', [], {})]


def count_waters_with(container, leaf, slugs):
    """HOW MANY WATERS ACTUALLY HAVE A VALUE HERE -- the number every miscount needed.

    `covers_shipped_waters` on the file says how many waters the file mentions. That is NOT how
    many have the field: dnr_ramps_by_lake.json mentions 181 waters and only some of their ramp
    records carry `meta.species`. Reporting the file count as if it were the field count is how
    "182 of 355 have species" got published when the answer was 216.
    """
    return len(waters_with(container, leaf, slugs))


def waters_with(container, leaf, slugs):
    """The same question as a SET, because the union across places is the only honest total.

    Counting each place separately and adding gives a number bigger than the index. Counting one
    place gives a number smaller than the app. Only the union of the slug sets is the answer, so
    the set is the primitive here and the count is a view of it.
    """
    out = set()
    for slug, rec in container.items():
        if slug not in slugs:
            continue
        try:
            if at_path(rec, leaf):
                out.add(slug)
        except Exception:
            pass
    return out


PROFILE_DIRNAME = '_research_profiles'
COUNTY_TAIL = re.compile(r'\s*\([^)]*\bCo\b[^)]*\)\s*$', re.I)


def name_index(IDX):
    """Every name the index knows for a water -- county-stamped and bare -> {slug}."""
    out = {}
    for s, r in IDX.items():
        for n in [r.get('display_name'), r.get('name')] + list(r.get('legacy_display_names') or []):
            if not n:
                continue
            for k in (str(n).strip().lower(), COUNTY_TAIL.sub('', str(n)).strip().lower()):
                out.setdefault(k, set()).add(s)
    return out


def stored_profiles(reg, slugs, IDX):
    """THE FIFTH PLACE, READ. Returns (section, {slug: [species]}).

    Until mirror_research_profiles.py existed this section could only DESCRIBE R2 and stamped
    itself `not_countable_offline`. That hole is what let "192 of 355 waters have species" be
    published an hour after "Parr Shoals has ten species in its profile".

    BOUND BY THE NAME THE PROFILE CALLS ITSELF, NOT BY ITS STORAGE ID. `lakeName` is written into
    the document by the run that made it; the id is whatever the water was filed under the day
    version 1 was written. Parr Shoals Reservoir's profile lives at `parr_reservoir_sc`, and
    Lake Sidney Lanier's at `lake_lanier_ga`. A binding on the id would miss every legacy key.

    WHAT IT REFUSES TO GUESS. A profile whose lakeName matches no index name is listed in
    `unbound`, not attached to the nearest water. Two profiles binding to one slug are listed in
    `two_profiles_one_water`, not silently merged -- which of them the app serves depends on
    resolveResearchStorageId and cannot be answered from the drive.
    """
    d = os.path.join(reg, PROFILE_DIRNAME)
    if not os.path.isdir(d):
        return {'mirror': 'registry/%s/  -- NOT PRESENT. Run mirror_research_profiles.py.'
                          % PROFILE_DIRNAME,
                'not_countable_offline': True}, {}
    byname = name_index(IDX)
    got, unbound, unsourced, dupes = {}, [], [], {}
    files = [f for f in sorted(os.listdir(d)) if f.endswith('.json') and not f.startswith('_')]
    for f in files:
        try:
            prof = json.load(open(os.path.join(d, f), encoding='utf-8'))
        except Exception as exc:
            unbound.append({'file': f, 'lakeName': None, 'why': type(exc).__name__})
            continue
        raw = str(prof.get('lakeName') or '').strip().lower()
        cands = byname.get(raw) or byname.get(COUNTY_TAIL.sub('', raw).strip()) or set()
        species = [x for x in ((prof.get('biology') or {}).get('predatorSpecies') or []) if x]
        # NO SOURCE OF ANY KIND behind the biology: no per-field evidence, no source list, no
        # extracted facts. Three of eighty on 2026-09-04, and Parr Shoals is one of them.
        ev = ((prof.get('evidence') or {}).get('biology') or {})
        if species and not ev and not (prof.get('sources') or []) \
                and not (prof.get('_extractedFactsCount') or 0):
            unsourced.append({'file': f, 'lakeName': prof.get('lakeName'),
                              'species': len(species),
                              'confidence': ((prof.get('confidence') or {})
                                             .get('biology') or {}).get('reason')})
        if len(cands) == 1:
            slug = next(iter(cands))
            if slug in got:
                dupes.setdefault(slug, []).append(f)
            else:
                got[slug] = species
                dupes.setdefault(slug, []).append(f)
        else:
            unbound.append({'file': f, 'lakeName': prof.get('lakeName'),
                            'why': 'ambiguous: %s' % sorted(cands) if cands
                                   else 'no index name matches'})
    return {
        'where': 'R2 bucket R2_TROLLMAP_CHARTPACKS, key lakes/<researchStorageId>.json',
        'read_via': 'GET <worker>/research/get?lake=<display name>  (or /lakes/<id>)',
        'written_by': 'Worker/research/storage.js, from research_lakes.py runs',
        'mirror': 'registry/%s/<researchStorageId>.json -- mirror_research_profiles.py, and '
                  'research_lakes.py writes one on every save' % PROFILE_DIRNAME,
        'mirrored': len(files),
        'bound_to_a_shipped_water': len(got),
        'carrying_predator_species': sum(1 for v in got.values() if v),
        'unbound': unbound,
        'two_profiles_one_water': {k: v for k, v in dupes.items() if len(v) > 1},
        'no_source_behind_the_biology': unsourced,
        'why_it_matters': 'This is the union the CARD shows: every floor above, plus what '
                          'research found. A water can be blank in every registry file and '
                          'still have species here -- and a species here can have NOTHING '
                          'behind it, which no registry file can ever be.',
    }, got


def find_slug_container(o, slugs, path='', depth=0, best=None):
    """The path to the dict keyed by OUR slugs. It is at a different depth in nearly every file."""
    if best is None:
        best = []
    if depth > 4:
        return best
    if isinstance(o, dict):
        hit = len(set(list(o)[:600]) & slugs)
        if hit >= 3:
            best.append((hit, path or '.', o))
        else:
            for k, v in list(o.items())[:60]:
                if isinstance(v, (dict, list)):
                    find_slug_container(v, slugs, '%s.%s' % (path, k) if path else k,
                                        depth + 1, best)
    elif isinstance(o, list) and o and isinstance(o[0], dict):
        find_slug_container(o[0], slugs, path + '[]', depth + 1, best)
    return best


_CODE = {}


def load_code(repo, dirs=CODE_DIRS):
    """Every source file read ONCE, into {relative path: text}.

    Written this way because the first version shelled out to grep per file per directory --
    about 320 subprocesses -- and did not finish inside the two-minute budget. The repo is a few
    megabytes; reading it once and matching in memory takes under a second and gives the same
    answer.
    """
    if _CODE:
        return _CODE
    for d in dirs:
        root = os.path.join(repo, d)
        if not os.path.isdir(root):
            continue
        for base, dirnames, files in os.walk(root):
            dirnames[:] = [x for x in dirnames if x not in ('__pycache__', 'node_modules')]
            for fn in files:
                if not fn.endswith(('.py', '.js', '.mjs', '.json', '.md')):
                    continue
                p = os.path.join(base, fn)
                if os.path.getsize(p) > 4_000_000:
                    continue
                try:
                    _CODE[os.path.relpath(p, repo).replace('\\', '/')] = open(
                        p, encoding='utf-8', errors='ignore').read()
                except Exception:
                    pass
    return _CODE


def grep(repo, needle, dirs=CODE_DIRS):
    """Files that mention a string. Plain and literal -- this is a map, not a call graph."""
    code = load_code(repo)
    only = tuple(d + '/' for d in dirs) if dirs != CODE_DIRS else None
    return sorted(p for p, txt in code.items()
                  if needle in txt and (only is None or p.startswith(only)))


# A profile field written in code rather than read from a file. THE CLASS OF THING THAT WAS
# MISSED TWICE: `profile.biology.predatorSpecies = ...` in deterministic.js is where the SC
# inshore floor enters, and no amount of reading registry/*.json will ever show it.
ASSIGN = re.compile(r'profile\.([A-Za-z_]+)\.([A-Za-z_]+)\s*=')


def runtime_writers(repo):
    out = {}
    root = os.path.join(repo, 'Worker')
    for base, _dirs, files in os.walk(root):
        for f in sorted(files):
            if not f.endswith('.js'):
                continue
            p = os.path.join(base, f)
            rel = os.path.relpath(p, repo).replace('\\', '/')
            try:
                lines = open(p, encoding='utf-8').read().splitlines()
            except Exception:
                continue
            for i, line in enumerate(lines, 1):
                m = ASSIGN.search(line)
                if not m:
                    continue
                field = '%s.%s' % (m.group(1), m.group(2))
                # WHAT IT IS WRITTEN FROM, which is the only useful part. Reading the right
                # of the `=` alone gave `uniqueResearchSpecies` seven times -- the wrapper every
                # one of them passes through, and never the source. The statement runs on for a
                # few lines, so the SCREAMING_CASE constant that actually names the floor --
                # SC_INSHORE_ROSTER, the advisory rec, the regs rows -- is usually below it.
                stmt = ' '.join(lines[i - 1:i + 3])
                consts = [n for n in re.findall(r'\b[A-Z][A-Z0-9_]{4,}\b', stmt)]
                calls = [n for n in re.findall(r'\b([a-z][A-Za-z0-9]{3,})\(', stmt)
                         if n not in ('uniqueResearchSpecies', 'map', 'filter', 'flatMap')]
                out.setdefault(field, []).append({
                    'file': rel, 'line': i,
                    'from': (consts + calls)[:4] or None,
                    'code': line.strip()[:120],
                })
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--repo', required=True, help='the TrollMap-Dev checkout')
    ap.add_argument('--out', default=None)
    a = ap.parse_args()
    reg, repo = a.registry, a.repo
    out_fp = a.out or os.path.join(reg, OUT_NAME)

    idx_path = os.path.join(reg, 'lake_index.json')
    if not os.path.exists(idx_path):
        raise SystemExit('no lake_index.json in %s -- run consolidate_lake_index.py first' % reg)
    IDX = {k: v for k, v in json.load(open(idx_path, encoding='utf-8')).items()
           if isinstance(v, dict)}
    slugs = set(IDX)
    print('index: %d shipped waters' % len(slugs))

    files, facts, unread, fact_slugs = {}, {}, [], {}
    for f in sorted(os.listdir(reg)):
        if not f.endswith('.json') or f.startswith(SKIP_PREFIX):
            continue
        p = os.path.join(reg, f)
        if os.path.getsize(p) > MAX_BYTES:
            unread.append({'file': f, 'why': 'over the size cap'})
            continue
        try:
            d = json.load(open(p, encoding='utf-8'))
        except Exception as exc:
            unread.append({'file': f, 'why': type(exc).__name__})
            continue
        found = sorted(find_slug_container(d, slugs), reverse=True)
        entry = {
            'kb': round(os.path.getsize(p) / 1024),
            'top_level_keys': sorted(d)[:14] if isinstance(d, dict) else '(list)',
            'built_by': grep(repo, f, ('Scripts',)),
            'read_by': grep(repo, f),
        }
        if found:
            hit, path, container = found[0]
            # EVERY RECORD IS NOT THE SAME SHAPE, and sampling one is the exact mistake this
            # file exists to stop. `meta.species` is present on some ramp records and absent on
            # others, so a one-record sample reported four of the five ramp feeds as carrying no
            # species at all. Up to 40 records are walked and their leaves unioned.
            shape = {}
            for v in list(container.values())[:40]:
                if v:
                    for k, ex in walk(v).items():
                        shape.setdefault(norm_leaf(k), ex)
            entry.update({
                'keyed_by': 'our slug',
                'container_path': path,
                'covers_shipped_waters': len(set(container) & slugs),
                'record_shape': shape,
            })
            for leaf in shape:
                last = leaf.split('.')[-1].replace('[]', '')
                for fact in FACTS:
                    if last.lower() == fact.lower():
                        prefix = '' if path == '.' else path + '.'
                        here = waters_with(container, leaf, slugs)
                        fact_slugs.setdefault(fact, set()).update(here)
                        facts.setdefault(fact, []).append({
                            'file': f,
                            'path': '%s<slug>.%s' % (prefix, leaf),
                            'waters_with_a_value_here': len(here),
                            'file_mentions_waters': entry['covers_shipped_waters'],
                        })
        else:
            entry['keyed_by'] = 'not by our slug'
        files[f] = entry

    profiles, profile_species = stored_profiles(reg, slugs, IDX)
    if profile_species:
        carrying = {k for k, v in profile_species.items() if v}
        facts.setdefault('species', []).append({
            'file': '%s/<researchStorageId>.json' % PROFILE_DIRNAME,
            'path': 'biology.predatorSpecies[]',
            'waters_with_a_value_here': len(carrying),
            'file_mentions_waters': len(profile_species),
        })
        fact_slugs.setdefault('species', set()).update(carrying)

    doc = {
        '_note': 'GENERATED by build_data_map.py -- do not hand-edit, do not upload. A map of '
                 'where every fact about a water lives, written for a model that has just been '
                 'wrong four times about exactly that. Personal use only, not for distribution '
                 'or resale; not for navigation.',
        'generated': datetime.date.today().isoformat(),
        'read_this_first': [
            'A fact about a water lives in one of FIVE kinds of place, not one.',
            '1. registry/*.json -- see `slug_keyed_files`. The container is at a DIFFERENT path '
            'in nearly every file, and the field is often nested (meta.species, not species).',
            '2. `fact_index` -- ask it "where does species live" before writing any count.',
            '3. `runtime_writers` -- floors applied while a profile is built, held in NO file. '
            'SC_INSHORE_ROSTER is the one that got missed.',
            '4. `stored_profiles` -- R2 lakes/<id>.json, what the CARD actually shows. MIRRORED onto the drive by mirror_research_profiles.py, so it is readable here; if `mirrored` is absent the mirror has not been run and any count is short.',
            '5. `js_data_tables` -- constants the Worker imports directly.',
            'COUNTING ANY OF THESE ALONE GIVES A WRONG ANSWER. Say which places a count covers.',
        ],
        'slug_keyed_files': {k: v for k, v in files.items() if v.get('keyed_by') == 'our slug'},
        'other_registry_files': {k: v for k, v in files.items() if v.get('keyed_by') != 'our slug'},
        'fact_index': {k: sorted(v, key=lambda x: -x['waters_with_a_value_here'])
                       for k, v in sorted(facts.items())},
        'union_of_places': {
            'note': 'THE ONLY HONEST TOTAL. Each place below is a subset; adding them '
                    'double-counts and reading one alone under-counts. Covers registry files '
                    'plus mirrored profiles -- NOT the runtime writers, which hold no file, so '
                    'a coastal zone fed only by SC_INSHORE_ROSTER is missing from these.',
            'shipped_waters': len(slugs),
            'waters_with': {k: len(v) for k, v in sorted(fact_slugs.items())},
        },
        'runtime_writers': runtime_writers(repo),
        'stored_profiles': profiles,
        'js_data_tables': {f: {'read_by': grep(repo, f)}
                           for f in sorted(os.listdir(os.path.join(repo, 'js', 'data')))
                           if f.endswith('.js')} if os.path.isdir(os.path.join(repo, 'js', 'data')) else {},
        'unreadable': unread,
    }

    n_sk = len(doc['slug_keyed_files'])
    print('slug-keyed registry files: %d' % n_sk)
    print('facts indexed: %s' % ', '.join('%s(%d)' % (k, len(v))
                                          for k, v in doc['fact_index'].items()))
    print('runtime writers: %d profile field(s) written in Worker code'
          % len(doc['runtime_writers']))
    if unread:
        print('!! %d registry file(s) could not be read: %s'
              % (len(unread), ', '.join(x['file'] for x in unread[:6])))
    with open(out_fp, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write('\n')
    print('-> %s   (%.0f KB)' % (out_fp, os.path.getsize(out_fp) / 1024))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
