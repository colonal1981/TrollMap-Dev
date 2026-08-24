#!/usr/bin/env python3
r"""audit_research_fields.py -- which research profile fields does anything actually USE?

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\audit_research_fields.py --repo F:\TrollMapPipeline\TrollMap-Dev ^
       --profiles F:\TrollMapPipeline\outputs\profiles\*.json

WHY THIS EXISTS

Ryan, 2026-08-24: *"if it isn't used anywhere at all why chase it, why bug fix it... hell why even
have the field in the first place... why waste time and a research pass on something that has no
use"*.

A research profile carries 428 distinct leaf paths. Every one of them is a slot in an extraction
schema, most are named in some agent's `targetFields`, and each of those is a thing an LLM was
asked to go and find -- a query, a fetch, a token budget, and a value that can be wrong. The
question is not whether a field is *nice*; it is whether anything downstream reads it.

`identity.normalPoolFt` is the case that started it. Traced by hand 2026-08-24: two reads, both
dead ends -- one renders a row on the research card, one puts DUKE'S OWN baseline value into the
identity prompt, never the extracted one. Every plan-side pool number comes from
`/conditions` `chart_datum.full_pool_ft` instead. So a wrong value there (Lake Norman saved
`1.5`, which is that profile's own turbidity reading) is visible and inert. Six of 23 non-null
pool elevations were wrong and not one of them had an evidence entry.

WHAT IT DOES NOT CLAIM

A grep knows names, not reachability. Three ways a field can be alive without being named here:

  * reached inside an object -- `summary.text` is handed to the model whole by researchIntel(),
    so it is dead by name and alive by inclusion
  * reached by a computed path -- `profile[key]` in a loop over a field list
  * reached by spread -- `{...identity}` into a prompt

So the verdict for a field with no hits is NO READER FOUND, never "unused". Every path with a
computed-access risk is flagged. Read the file:line and decide; do not cut from the count alone.
"""
import argparse, glob, io, json, os, re, sys, time
import urllib.request
from collections import defaultdict

WORKER = 'https://trollmap-worker.colonal1981.workers.dev'
UA = 'TrollMap/1.0 (personal use)'


def get_json(url, timeout=45):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as fh:
        return json.loads(fh.read().decode('utf-8-sig'))


def fetch_profiles(worker, cache_fp, sleep=0.25, refresh=False):
    """Every saved profile, from R2 through the Worker.

    THE PROFILES ARE NOT ON THE DRIVE. They live in R2 and the only door is /research/get, so
    the field set has to be read from the live store or this audit is measuring whatever
    happened to be exported by hand.

    EVERY READ IS CACHE-BUSTED. `JSON_HEADERS` sets no Cache-Control, so /research/get can and
    does serve a copy a month old with nothing in the response admitting it -- that cost this
    project two wrong conclusions about a Lake Norman rerun. A unique parameter per request is
    the only thing that makes a version number mean anything.

    The result is cached locally so a re-run costs nothing and a failure part-way through does
    not lose the profiles already read.
    """
    cache = {}
    if os.path.exists(cache_fp) and not refresh:
        try:
            cache = json.load(io.open(cache_fp, encoding='utf-8'))
        except Exception as exc:
            print('  !! profile cache unreadable (%s) -- refetching' % str(exc)[:60])
    stamp = str(int(time.time()))
    listing = get_json('%s/research/list?cachebust=aud%s' % (worker, stamp))
    ids = [x.get('id') for x in (listing.get('lakes') or []) if x.get('id')]
    print('/research/list: %d profile(s)' % len(ids))
    got = []
    for i, lid in enumerate(ids, 1):
        if lid in cache:
            got.append(cache[lid]); continue
        try:
            doc = get_json('%s/research/get?lake=%s&cachebust=aud%s%d' % (worker, lid, stamp, i))
            cache[lid] = doc.get('profile') if isinstance(doc.get('profile'), dict) else doc
            got.append(cache[lid])
        except Exception as exc:
            print('   !! %s failed: %s' % (lid, str(exc)[:70]))
        if i % 20 == 0:
            print('   [%d/%d]' % (i, len(ids)))
            json.dump(cache, io.open(cache_fp, 'w', encoding='utf-8'), indent=1)
        time.sleep(sleep)
    json.dump(cache, io.open(cache_fp, 'w', encoding='utf-8'), indent=1)
    print('profiles read: %d (cache: %s)' % (len(got), cache_fp))
    return got

# Files that DEFINE the shape rather than consume it. A hit here is not a consumer.
SCHEMA_FILES = ('worker/research/agents.js', 'worker/research/extract.js',
                'worker/research/facts-util.js', 'worker/research/coastal-agents.js',
                'worker/research/storage.js')
# Files that RENDER. A hit here means a person can see it; nothing acts on it.
UI_FILES = ('js/modules/lake-research-ui.js',)
# The engine assembles and saves the profile: hits here are writes unless they are clearly not.
WRITER_FILES = ('js/modules/lake-research-engine.js',)

# A field is reached by a computed path if any of these appear anywhere -- once true, EVERY field
# under that root is potentially alive without being named.
# Leaves whose name is an ordinary word and therefore collides across the tree. For these the
# parent segment must appear on the same line before a hit counts.
GENERIC_LEAVES = {
    'notes', 'note', 'name', 'names', 'color', 'colour', 'typical', 'cover', 'value', 'values',
    'source', 'sources', 'count', 'type', 'types', 'label', 'url', 'quote', 'method', 'text',
    'state', 'county', 'strength', 'status', 'details', 'summary', 'description', 'ok',
    'spring', 'summer', 'fall', 'winter', 'depth', 'size', 'level', 'ramps', 'hazards',
}

# The short names the code binds these sections to. `buildFactualSummary` opens with
#   const id = profile.identity; const bio = profile.biology;
#   const lim = profile.limnology; const hab = profile.habitat;
# so demanding the literal parent word made `hab.cover` invisible and reported a field the
# summary sentence is built from as having no reader.
PARENT_ALIASES = {
    'identity': ('identity', 'id', '_id'),
    'biology': ('biology', 'bio'),
    'forage': ('forage', 'bio', 'biology'),
    'limnology': ('limnology', 'lim'),
    'habitat': ('habitat', 'hab'),
    'navigation': ('navigation', 'nav'),
    'regulations': ('regulations', 'regs', 'reg'),
    'summary': ('summary', 'sum'),
}

COMPUTED = (
    re.compile(r'\bprofile\s*\[\s*(?:key|k|f|field|path)\b'),
    re.compile(r'\bid\s*\[\s*(?:key|k|f|field)\b'),
    re.compile(r'\.\.\.\s*(?:identity|profile|agentSections|sections)\b'),
    re.compile(r'JSON\.stringify\(\s*(?:profile|identity|agentSections)\b'),
)


def leaves(node, prefix='', out=None, depth=0):
    if out is None:
        out = set()
    if isinstance(node, dict):
        if not node:
            out.add(prefix)
        for k, v in node.items():
            leaves(v, f'{prefix}.{k}' if prefix else k, out, depth + 1)
    elif isinstance(node, list):
        out.add(prefix)
        if node and isinstance(node[0], dict) and depth < 3:
            for k, v in node[0].items():
                leaves(v, f'{prefix}[].{k}', out, depth + 1)
    else:
        out.add(prefix)
    return out


def child_keys(node, prefix='', out=None, depth=0):
    """path -> the set of child keys seen at that path in ONE profile."""
    if out is None:
        out = {}
    if isinstance(node, dict):
        out.setdefault(prefix, set()).update(node.keys())
        for k, v in node.items():
            child_keys(v, f'{prefix}.{k}' if prefix else k, out, depth + 1)
    elif isinstance(node, list) and node and isinstance(node[0], dict) and depth < 3:
        child_keys(node[0], prefix + '[]', out, depth + 1)
    return out


DATA_KEY = re.compile(r'^[A-Z]|[ /]')


def open_keyed(profiles):
    """Paths whose children are DATA rather than schema, decided by the SHAPE of the key.

    A COUNT OF DATA KEYS IS NOT A COUNT OF FIELDS. Run against 63 profiles the enumerator
    reported 984 paths with no reader, and most were values --
    `trollingIntelligence.<species>.<season>.<field>`, `spawnTiming.spotted bass`,
    `regulations.creelLimits.American Eel`. No grep finds a consumer for a key that exists on
    one lake, and counting them as dead schema buries the real dead weight.

    The first rule tried here was "profiles disagree about this object's children". It flagged
    `biology` itself, because some profiles carry `forageSpatial` and some do not -- an OPTIONAL
    FIELD is not a data map, and collapsing there would have erased every field beneath it.

    So the test is the key, not the corpus: a schema key is a camelCase identifier, a data key
    is a proper noun. `speciesBehavior` is schema; `Largemouth Bass` is a fish. No threshold,
    nothing to tune, and it keeps working when a lake turns up with a species nobody has seen.
    """
    out = set()
    for prof in profiles:
        for path, keys in child_keys(prof).items():
            if any(DATA_KEY.search(k) for k in keys):
                out.add(path)
    return out


def collapse(path, open_paths):
    """`trollingIntelligence.Largemouth Bass.summer.preferredDepth` -> `trollingIntelligence.*.summer.preferredDepth`"""
    # Look the parent up in the ORIGINAL path, not the partly-collapsed one. Consulting the
    # mutated list left `speciesAbundance.*.*. lanceolata complex` uncollapsed, because by then
    # its parent read `...*.*` and no such path was ever seen in a profile.
    segs = path.split('.')
    out = list(segs)
    for i in range(len(segs) - 1, 0, -1):
        if '.'.join(segs[:i]) in open_paths:
            out[i] = '*'
    return '.'.join(out)


def target_fields(repo):
    """Every dotted path any agent is told to go and find.

    AGENT_DEFINITIONS lives in the CLIENT engine, not in the Worker's agents.js -- the first
    version of this script looked in the Worker, matched nothing, and printed
    `targetFields declared: 0`, which reads exactly like "nothing is being hunted". A check that
    cannot see reports nothing, and nothing reads like a clean pass.
    """
    p = os.path.join(repo, 'js', 'modules', 'lake-research-engine.js')
    if not os.path.exists(p):
        return {}
    src = io.open(p, encoding='utf-8', errors='replace').read()
    out = {}
    blk = re.search(r'const AGENT_DEFINITIONS\s*=\s*\{([\s\S]*?)\n\};', src)
    body = blk.group(1) if blk else src
    agent = '?'
    for line in body.split('\n'):
        m = re.match(r"\s*([a-zA-Z_]+):\s*\{\s*$", line)
        if m:
            agent = m.group(1)
            continue
        m = re.search(r"targetFields:\s*\[([^\]]*)\]", line)
        if m:
            for f in re.findall(r"'([^']+)'", m.group(1)):
                out.setdefault(f, []).append(agent)
    if not out:
        raise SystemExit('FATAL: no targetFields parsed from %s -- the shape moved. Fix this '
                         'rather than reporting an empty cut list.' % p)
    return out


def source_files(repo):
    files = []
    for sub in ('js', 'Worker'):
        for root, _dirs, names in os.walk(os.path.join(repo, sub)):
            if 'node_modules' in root:
                continue
            for n in names:
                if n.endswith(('.js', '.mjs')):
                    files.append(os.path.join(root, n))
    idx = os.path.join(repo, 'index.html')
    if os.path.exists(idx):
        files.append(idx)
    return files


# A line that is part of a JSON schema template, a null-initialiser or a field-name list is
# DECLARING the field. A line that interpolates it into a template literal, compares it, or
# renders it is USING it. agents.js does both, dozens of lines apart, which is why this decides
# per LINE: classifying that whole file as "schema" hid `bathyMeta.bathymetryBandCount` going
# into the identity prompt and reported a live field as dead.
DECLARING = (
    re.compile(r':\s*(null|\[\]|\{\})\s*,?\s*$'),        # "field": null,
    re.compile(r"""^\s*['"]?[a-zA-Z_]+['"]?\s*:\s*['"]?<"""),  # "field": <number|null>
    re.compile(r'^\s*//'),                                    # a comment
    re.compile(r'targetFields:'),
)
USING = (
    re.compile(r'\$\{'),          # interpolated into a prompt or a template
    re.compile(r'\bif\s*\('),
    re.compile(r'[!=]==?'),
    re.compile(r'\.(map|filter|join|forEach|reduce|some|every|includes|length)\b'),
    re.compile(r'\bpush\('),
)


def classify_line(rel, line):
    r = rel.replace('\\', '/').lower()
    for rx in DECLARING:
        if rx.search(line):
            return 'schema'
    is_using = any(rx.search(line) for rx in USING)
    for s in UI_FILES:
        if r.endswith(s):
            return 'ui' if is_using else 'schema'
    for s in WRITER_FILES:
        if r.endswith(s):
            return 'writer'
    for s in SCHEMA_FILES:
        if r.endswith(s):
            return 'other' if is_using else 'schema'
    # ANY OTHER FILE IS A CONSUMER. A hit here used to need a `USING` pattern to count, and
    # `plan-inputs.js` reads two dozen fields through a local helper called `put(...)` -- not
    # `push(`, not an if, not a comparison. Every one of those fell through to "writer", so
    # researchIntel(), the function that assembles the SmartPlan prompt, was invisible to this
    # audit and its fields were reported as having no reader. Ryan caught it by asking whether
    # the plan gets them by another route.
    #
    # Only the files that genuinely build and save the profile can write it. Everything else
    # that names a field is reading one.
    return 'other'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True)
    ap.add_argument('--profiles', nargs='+',
                    help='saved research profile JSON files; globs allowed. Omit to read them '
                         'from R2 through the Worker, which is where they actually live.')
    ap.add_argument('--worker', default=WORKER, help='Worker base URL for --profiles-less runs')
    ap.add_argument('--profile-cache', help='default <repo>/../registry/_research_profiles_cache.json')
    ap.add_argument('--refresh-profiles', action='store_true', help='ignore the profile cache')
    ap.add_argument('--out', help='default <repo>/../registry/_research_field_consumers.json')
    ap.add_argument('--show', type=int, default=25, help='how many rows to print per section')
    a = ap.parse_args()

    paths = set()
    prof_files = []
    if a.profiles:
        docs = []
        for pat in a.profiles:
            for f in glob.glob(pat):
                prof_files.append(f)
                doc = json.load(io.open(f, encoding='utf-8'))
                docs.append(doc.get('profile') if isinstance(doc.get('profile'), dict) else doc)
        if docs:
            opens = open_keyed(docs)
            raw = set()
            for d in docs:
                raw |= leaves(d)
            paths |= {collapse(p, opens) for p in raw}
            print('data-keyed maps collapsed: %d path(s) -> %d' % (len(raw), len(paths)))
        if not prof_files:
            raise SystemExit('FATAL: --profiles matched no files (%s). A run with no profiles '
                             'measures only the 62 declared targetFields and silently reports '
                             'zero dead weight.' % ', '.join(a.profiles))
    else:
        cache_fp = a.profile_cache or os.path.join(
            os.path.dirname(a.repo.rstrip('\\/')), 'registry', '_research_profiles_cache.json')
        os.makedirs(os.path.dirname(cache_fp), exist_ok=True)
        profs = fetch_profiles(a.worker, cache_fp, refresh=a.refresh_profiles)
        prof_files = ['r2'] * len(profs)
        opens = open_keyed(profs)
        raw = set()
        for prof in profs:
            raw |= leaves(prof)
        paths |= {collapse(p, opens) for p in raw}
        print('data-keyed maps collapsed: %d path(s) -> %d' % (len(raw), len(paths)))
    tf = target_fields(a.repo)
    paths |= set(tf)
    # Anything under these is machinery, not a research finding.
    paths = {p for p in paths if not p.split('.')[0] in
             ('evidence', 'confidence', 'metadata', 'researchLog', 'sources', 'fieldStatus')}
    print('profiles read: %d   leaf paths: %d   targetFields declared: %d'
          % (len(prof_files), len(paths), len(tf)))

    files = source_files(a.repo)
    print('source files searched: %d' % len(files))
    blobs = []
    computed_risk = []
    for f in files:
        try:
            txt = io.open(f, encoding='utf-8', errors='replace').read()
        except OSError:
            continue
        rel = os.path.relpath(f, a.repo)
        blobs.append((rel, txt.split('\n')))
        for rx in COMPUTED:
            if rx.search(txt):
                computed_risk.append(rel)
                break

    hits = defaultdict(lambda: defaultdict(list))
    for p in paths:
        leaf = p.split('.')[-1].split('[')[0]
        if not leaf or len(leaf) < 3:
            continue
        # MATCH THE LEAF, BUT DEMAND THE PARENT WHEN THE LEAF IS A COMMON WORD.
        #
        # Two failed attempts are why this is shaped like this. Matching the bare leaf collided
        # with every unrelated `notes:` in 144 files and called 315 of 348 paths consumed.
        # Matching the dotted tail `identity.maxDepthFt` then found almost nothing, because the
        # code aliases the object -- `const id = profile.identity` -- so the literal string never
        # appears and a live field read as dead.
        #
        # So: the leaf with a leading dot or in quotes, which survives any alias; and for a leaf
        # that is an ordinary English word, the parent segment must also appear on the same line.
        segs = [x for x in p.replace('[]', '').split('.') if x]
        leaf_s = segs[-1]
        parent = segs[-2] if len(segs) > 1 else None
        pats = [re.compile(r'\.%s\b' % re.escape(leaf_s)),
                re.compile(r"""['"]%s['"]""" % re.escape(leaf_s))]
        need_parent = parent and leaf_s.lower() in GENERIC_LEAVES
        alts = PARENT_ALIASES.get(parent, (parent,)) if parent else ()
        # CASE-INSENSITIVE, because the parent word often appears in the label rather than the
        # path: `if (p.hazards) lines.push(`Navigation hazards: ...`)` reads navigation.hazards
        # and the only occurrence of the parent on that line is capitalised prose.
        prx = (re.compile(r'\b(?:%s)\b' % '|'.join(re.escape(x) for x in alts), re.I)
               if parent else None)
        for rel, lines in blobs:
            for i, line in enumerate(lines, 1):
                if not any(rx.search(line) for rx in pats):
                    continue
                if need_parent and not prx.search(line):
                    continue
                hits[p][classify_line(rel, line)].append('%s:%d' % (rel, i))

    consumed, ui_only, dead = [], [], []
    for p in sorted(paths):
        h = hits.get(p) or {}
        if h.get('other'):
            consumed.append(p)
        elif h.get('ui'):
            ui_only.append(p)
        else:
            dead.append(p)

    print()
    print('CONSUMED (a file outside the schema, the writer and the UI reads it): %d' % len(consumed))
    print('DISPLAY ONLY (renders on the research card, nothing acts on it):      %d' % len(ui_only))
    print('NO READER FOUND (not even displayed):                                %d' % len(dead))

    hunted_dead = sorted(p for p in dead + ui_only if p in tf)
    print()
    print('THE CUT LIST -- fields an agent is told to go and find, that nothing acts on: %d' % len(hunted_dead))
    for p in hunted_dead:
        print('   %-44s hunted by: %s   %s' % (p, ','.join(tf[p]),
              'displayed' if p in ui_only else 'NO READER'))

    print()
    print('NO READER FOUND, not in any targetFields (dead weight in the schema): %d' % len(
        [p for p in dead if p not in tf]))
    for p in [p for p in dead if p not in tf][:a.show]:
        print('   %s' % p)
    if len([p for p in dead if p not in tf]) > a.show:
        print('   ... %d more' % (len([p for p in dead if p not in tf]) - a.show))

    print()
    print('COMPUTED-ACCESS RISK -- files that reach fields by variable, spread or whole-object')
    print('stringify. A field can be alive in one of these without ever being named: %d file(s)'
          % len(set(computed_risk)))
    for r in sorted(set(computed_risk)):
        print('   %s' % r)

    out_fp = a.out or os.path.join(os.path.dirname(a.repo.rstrip('\\/')), 'registry',
                                   '_research_field_consumers.json')
    body = {'generated_from': [os.path.basename(f) for f in prof_files],
            'repo': os.path.basename(a.repo.rstrip('\\/')),
            'note': 'A grep knows names, not reachability. NO READER FOUND is not "unused" -- '
                    'see the computed_access_risk list. Built by audit_research_fields.py.',
            'computed_access_risk': sorted(set(computed_risk)),
            'fields': {p: {'verdict': ('consumed' if p in consumed else
                                       'display_only' if p in ui_only else 'no_reader_found'),
                           'hunted_by': tf.get(p) or [],
                           'read_by': (hits.get(p) or {}).get('other', [])[:8],
                           'rendered_by': (hits.get(p) or {}).get('ui', [])[:4]}
                       for p in sorted(paths)}}
    os.makedirs(os.path.dirname(out_fp), exist_ok=True)
    json.dump(body, io.open(out_fp, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    print()
    print('-> %s' % out_fp)
    return 0


if __name__ == '__main__':
    sys.exit(main())
