#!/usr/bin/env python3
"""
gen_coastal_zones_js.py — generate js/data/coastal-zones.js from coastal_catalog.py.

coastal_catalog.py is the single source of truth for coastal zone geometry,
tide stations and ramps. The JS app needs the same data, and hand-maintaining
two copies is exactly the kind of drift AGENT_GUIDE.md warns about (see the
lake-keys.js / limnology.js duplication that had to be de-duped).

Run this after editing coastal_catalog.py:

    python3 Scripts/gen_coastal_zones_js.py

test/coastal-zones-parity.test.js fails if the generated file is stale.
"""

import ast
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
CATALOG = os.path.join(HERE, 'coastal_catalog.py')


def _find(rel, siblings=('', 'TrollMap-Dev'), levels=4):
    """Walk up looking for `rel`, trying the app tree as a sibling at each level.

    THE DRIVE HAS TWO COPIES OF THIS SCRIPT and os.path.dirname(HERE) is right in one of them.
    From TrollMap-Dev/Scripts/ it gives TrollMap-Dev/ and js/data/ is there. From scripts/ it
    gives F:\TrollMapPipeline\ and there is no js/ at all -- so --check compared against a
    path that does not exist, read the missing file as an empty string, and reported STALE.

    A plain run from that copy did not write a stray: F:\TrollMapPipeline\js\ does not exist
    either, and open(..., 'w') under a missing parent raises FileNotFoundError rather than
    creating one. Checked, because the first version of this comment claimed a stray WAS created
    and that was a guess. The failure is narrower and stranger than that -- --check lied and a
    write crashed, so the script was unusable from one of its two homes in two different ways.

    00_START_HERE says it: "this is also why path-guessing code breaks: a script that computes
    its own location is right in one copy and wrong in the other."

    Lifted from gen_water_aliases_js.py, which solved this for water-aliases.js and left the
    reason: "Anchored to lake-keys.js rather than computed from REPO, so it lands in the app
    tree from either copy of this script." Two copies of a nine-line helper is not worth a
    shared module; a THIRD would be, and that is the moment to make one.
    """
    parts = rel.split('/')
    here = HERE
    for _ in range(levels):
        for sib in siblings:
            base = os.path.join(here, sib) if sib else here
            cand = os.path.join(base, *parts)
            if os.path.exists(cand):
                return cand
        parent = os.path.dirname(here)
        if parent == here:
            break
        here = parent
    return None


# Anchored to lake-keys.js, a file that exists in the app tree and nowhere else, so the
# generated file lands beside the curated map it complements from either copy of this script.
_LAKE_KEYS = _find('js/data/lake-keys.js')
OUT = (os.path.join(os.path.dirname(_LAKE_KEYS), 'coastal-zones.js') if _LAKE_KEYS
       else os.path.join(REPO, 'js', 'data', 'coastal-zones.js'))

# ── USGS river gauges used as a salinity / freshwater-intrusion proxy ────────
# Source: COASTAL_ARENA_BRIEF.md §3. Discharge parameterCd=00060.
# Zones absent from this map simply have no gauge coverage and skip the
# freshwater intrusion check rather than guessing from an unrelated basin.
USGS_GAUGES = {
    'coast_charleston_sc':      ['02172002', '02172300'],  # Cooper + Ashley
    'coast_winyah_bay_sc':      ['02171700'],              # Santee
    'coast_santee_delta_sc':    ['02171700'],              # Santee
    'coast_savannah_ga':        ['02198500'],              # Savannah
    'coast_ossabaw_st_catherines_ga': ['02198500'],        # Savannah
    'coast_cape_fear_nc':       ['02105769'],              # Cape Fear
    'coast_brunswick_nc':       ['02105769'],              # Cape Fear
}

# Rivers named per gauge, for human-readable SmartPlan warnings.
GAUGE_NAMES = {
    '02172002': 'Cooper River',
    '02172300': 'Ashley River',
    '02171700': 'Santee River',
    '02198500': 'Savannah River',
    '02105769': 'Cape Fear River',
}


def load_catalog():
    """Parse coastal_catalog.py without importing it (no side effects)."""
    with open(CATALOG, 'r', encoding='utf-8') as fh:
        tree = ast.parse(fh.read())
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == 'COASTAL_CATALOG':
                    return ast.literal_eval(node.value)
    raise SystemExit('COASTAL_CATALOG not found in coastal_catalog.py')


def js_literal(value, indent):
    """Render a Python value as compact JS, honouring an indent level."""
    pad = '  ' * indent
    if isinstance(value, dict):
        if not value:
            return '{}'
        inner = ',\n'.join(
            f'{pad}  {json.dumps(k)}: {js_literal(v, indent + 1)}'
            for k, v in value.items()
        )
        return '{\n' + inner + f',\n{pad}}}'
    if isinstance(value, (list, tuple)):
        return '[' + ', '.join(js_literal(v, indent) for v in value) + ']'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if value is None:
        return 'null'
    if isinstance(value, str):
        return json.dumps(value)
    return repr(value)


def build():
    catalog = load_catalog()
    lines = []
    for slug, zone in catalog.items():
        south, north, west, east = zone['bbox']
        lat, lon = zone['center']
        gauges = USGS_GAUGES.get(slug, [])
        entry = {
            'slug': slug,
            'name': zone['name'],
            'state': zone['state'],
            'coastal': True,
            'tideStation': zone['tide_station'],
            # Leaflet order: [[south, west], [north, east]]
            'center': [lat, lon],
            'bbox': [[south, west], [north, east]],
            'priority': zone.get('priority', 8),
            'ramps': {k: list(v) for k, v in zone.get('ramps', {}).items()},
            'usgsGauges': gauges,
            'usgsRivers': [GAUGE_NAMES[g] for g in gauges if g in GAUGE_NAMES],
        }
        lines.append(f'  {json.dumps(slug)}: {js_literal(entry, 1)}')

    body = ',\n'.join(lines)
    return f'''/**
 * coastal-zones.js — SC / GA / NC coastal + tidal zone catalog.
 *
 * GENERATED FILE — DO NOT EDIT BY HAND.
 * Source of truth: Scripts/coastal_catalog.py
 * Regenerate:      python3 Scripts/gen_coastal_zones_js.py
 * Guarded by:      test/coastal-zones-parity.test.js
 *
 * Why generated: the Python catalog already drives the R2 data pipeline
 * (trollmap_pipeline_coastal.py, fetch_osm_coastal.py). Hand-copying it into
 * JS is how lake-keys.js and limnology.js drifted apart — see AGENT_GUIDE.md
 * section 1. One source, one generator, one parity test.
 *
 * Each zone carries:
 *   slug         R2 key prefix, e.g. `${{CF_WORKER_URL}}/chartpacks/{{slug}}/...`
 *   tideStation  NOAA CO-OPS station ID for noaa-tides.js
 *   center       [lat, lon]
 *   bbox         [[south, west], [north, east]] — Leaflet order
 *   ramps        name -> [lat, lon]
 *   usgsGauges   USGS NWIS site IDs for the freshwater-intrusion proxy
 *                (empty array = no gauge coverage, skip the check)
 */

export const COASTAL_ZONES = {{
{body},
}};

/** All coastal slugs. */
export const COASTAL_SLUGS = Object.keys(COASTAL_ZONES);

/**
 * True when an R2 key / zone slug refers to tidal saltwater.
 * All coastal slugs are prefixed `coast_` by the pipeline, so this is a
 * cheap check that does not require the catalog to be loaded.
 */
export function isCoastalKey(key) {{
  return typeof key === 'string' && key.startsWith('coast_');
}}

/** Look up a zone by its slug. Returns null when unknown. */
export function getCoastalZone(slug) {{
  return COASTAL_ZONES[slug] || null;
}}

/** Zones for one state, in catalog order. */
export function coastalZonesByState(stateCode) {{
  const want = String(stateCode || '').toUpperCase();
  return COASTAL_SLUGS
    .filter((slug) => COASTAL_ZONES[slug].state === want)
    .map((slug) => COASTAL_ZONES[slug]);
}}

/** Display names grouped for the lake selector: {{ SC: [...], GA: [...], NC: [...] }} */
export function coastalNamesByState() {{
  const out = {{ SC: [], GA: [], NC: [] }};
  for (const slug of COASTAL_SLUGS) {{
    const zone = COASTAL_ZONES[slug];
    if (out[zone.state]) out[zone.state].push(zone.name);
  }}
  return out;
}}
'''


if __name__ == '__main__':
    text = build()
    if '--check' in sys.argv:
        # MISSING IS NOT STALE. Reading an absent file as '' made it differ from any generated
        # text, so "I cannot find the app tree" and "the file is out of date" printed the same
        # sentence and pointed at the same fix -- regenerate -- which for the first one would
        # have written a stray copy instead of finding the real one.
        if not os.path.exists(OUT):
            print('NOT FOUND: %s' % OUT)
            print('  The app tree was not located from %s. This is a path problem, NOT a stale'
                  ' file --' % HERE)
            print('  a plain run would raise FileNotFoundError rather than regenerate anything.')
            sys.exit(2)
        existing = open(OUT, 'r', encoding='utf-8').read()
        if existing != text:
            print('STALE: %s differs from coastal_catalog.py' % OUT)
            sys.exit(1)
        print('OK: coastal-zones.js is in sync')
        sys.exit(0)
    with open(OUT, 'w', encoding='utf-8') as fh:
        fh.write(text)
    print(f'wrote {OUT}')
