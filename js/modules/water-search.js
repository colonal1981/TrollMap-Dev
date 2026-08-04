/**
 * water-search.js — search everything TrollMap knows, not everything OpenStreetMap knows.
 *
 * WHY THIS EXISTS
 *
 * The search box called Nominatim:
 *
 *     fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${q}&limit=5`)
 *
 * In an app that holds 1,672 named waterbodies, 22 coastal zones, 158 coastal pointers and
 * 3,051 ramps, typing "Cooper River" asked a global geocoder instead of looking at any of it.
 * Cooper River IS in the data — water-aliases.js maps it to coast_charleston_sc — and the
 * search box was the one place that never checked. Worse, a hit only ever did
 * `MAP.setView(...)`: it panned to a coordinate and left you on an empty map, having selected
 * nothing and loaded no contours.
 *
 * Ryan, 2026-08-04: "that whole picker is dumb, the quick picks are only of lake murray...
 * edge case fixes that get bolted on".
 *
 * WHAT IT SEARCHES, and why each source is needed
 *
 *   registry rows      every name a lake answers to, including legacy_display_names — which
 *                      is how "HB Robinson", "Clarks Hill" and "Dallas Lake" find their water
 *                      after being renamed or merged.
 *   coastal zones      a sound is not a lake and lives in its own table.
 *   coastal pointers   the 158 creek and river names that RESOLVE to a zone but never appear
 *                      in the dropdown. Searching is the only way to reach them.
 *   ramps              3,051 of them, with coordinates as of 2026-08-04. "Hilton Recreation
 *                      Area" is a thing people type, and it should find Lake Murray.
 *
 * SELECTING, NOT PANNING
 *
 * A result sets #lakeSelect and dispatches `change`, which is the path the dropdown already
 * uses — contours, ramps, layers, everything. It does not reimplement selection, because two
 * code paths that both "select a lake" is how this app got here.
 */

import { getLoadedRegistry } from '../data/lake-registry.js';
import { COASTAL_ZONES, COASTAL_SLUGS } from '../data/coastal-zones.js';
import { WATER_TO_R2_KEY } from '../data/water-aliases.js';
import { getLoadedAccessIndex } from '../data/access-index.js';
import { state } from '../core/state.js';

/** Lowercase, strip punctuation, collapse space. Deliberately NOT the fuzzy `_normalize`
 *  in lake-keys.js — that one drops generic words and is why "May River" once resolved to
 *  mayo_lake. Search may be generous; resolution may not. */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

let _cache = null;

/** Rebuild on next search. Called after the registry or access index loads. */
export function invalidateWaterIndex() {
  _cache = null;
}

export function buildWaterIndex() {
  const out = [];
  const seen = new Set();
  const push = (e) => {
    const k = `${e.kind}|${e.selectName}|${e.label}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };

  // 1 — registry lakes and rivers, under every name they answer to
  let list = [];
  try { list = getLoadedRegistry()?.list || []; } catch { list = []; }
  for (const r of list) {
    const names = [r.displayName, r.name, r.legacyDisplayName, ...(r.legacyDisplayNames || [])]
      .filter(Boolean);
    const b = r.boundsWSEN;
    push({
      kind: 'water',
      label: r.displayName,
      sublabel: r.areaAcres ? `${Math.round(r.areaAcres).toLocaleString()} ac` : '',
      selectName: r.displayName,
      terms: names.map(norm),
      altNames: names,
      bounds: Array.isArray(b) && b.length === 4 ? [[b[1], b[0]], [b[3], b[2]]] : null,
      center: Number.isFinite(r.lat) && Number.isFinite(r.lon) ? [r.lat, r.lon] : null,
      rank: r.areaAcres || 0,
    });
  }

  // 2 — coastal zones
  for (const slug of COASTAL_SLUGS) {
    const z = COASTAL_ZONES[slug];
    if (!z) continue;
    const b = z.bbox;   // [s, n, w, e]
    push({
      kind: 'zone',
      label: z.name,
      sublabel: 'coastal zone',
      selectName: z.name,
      terms: [norm(z.name)],
      altNames: [z.name],
      bounds: Array.isArray(b) && b.length === 4 ? [[b[0], b[2]], [b[1], b[3]]] : null,
      center: z.center || null,
      rank: 1e6,          // a sound is big and usually what you meant
    });
  }

  // 3 — coastal pointers: names that resolve to a zone but are not in the dropdown
  for (const [name, key] of Object.entries(WATER_TO_R2_KEY || {})) {
    const z = COASTAL_ZONES[key];
    if (!z) continue;                       // river aliases point at lakes, covered above
    push({
      kind: 'pointer',
      label: name,
      sublabel: `contours from ${z.name}`,
      selectName: z.name,                   // select the zone; it holds the contours
      terms: [norm(name)],
      altNames: [name],
      bounds: null,
      center: z.center || null,
      rank: 10,
    });
  }

  // 4 — ramps, by name, resolving to the water they are on
  let idx = null;
  try { idx = getLoadedAccessIndex(); } catch { idx = null; }
  for (const [lakeName, pts] of (idx?.byLake || new Map())) {
    for (const p of (pts || [])) {
      if (!p?.name || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      push({
        kind: 'ramp',
        label: p.name,
        sublabel: lakeName,
        selectName: lakeName,
        terms: [norm(p.name)],
        altNames: [p.name],
        bounds: null,
        center: [p.lat, p.lon],
        rank: 1,
      });
    }
  }
  return out;
}

/**
 * Ranked matches. Exact beats prefix beats substring, and only then does size break ties —
 * so "Broad River" does not lose to "Broad River Reservoir" just because the latter is bigger.
 */
export function searchWaters(query, limit = 12) {
  const q = norm(query);
  if (!q) return [];
  if (!_cache) _cache = buildWaterIndex();
  const KIND_ORDER = { water: 0, zone: 0, pointer: 1, ramp: 2 };
  const hits = [];
  for (const e of _cache) {
    let best = -1;
    for (const t of e.terms) {
      if (!t) continue;
      const tier = t === q ? 0 : t.startsWith(q) ? 1 : t.includes(q) ? 2 : -1;
      if (tier >= 0 && (best < 0 || tier < best)) best = tier;
    }
    if (best >= 0) hits.push([best, KIND_ORDER[e.kind] ?? 3, -(e.rank || 0), e]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return hits.slice(0, limit).map((h) => h[3]);
}

/**
 * Select the water a result belongs to, through the dropdown the app already drives.
 *
 * Returns true when the picker took it. False means the name is not offered — a pointer whose
 * zone is filtered out, say — and the caller should fall back to moving the map, which is
 * still better than nothing but is NOT a selection and should not be reported as one.
 */
export function selectWater(entry) {
  const sel = document.getElementById('lakeSelect');
  let selected = false;
  if (sel && entry?.selectName) {
    const opt = [...sel.options].find((o) => o.value === entry.selectName);
    if (opt) {
      sel.value = entry.selectName;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      selected = true;
    }
  }
  const map = state?.MAP;
  if (map) {
    // A ramp or a pointer is a POINT inside a much larger water. Selecting the water fits its
    // whole bounds, which puts a 200 m ramp off-screen at the far end of a 40 km reservoir --
    // so for those, move to the point AFTER the selection has fitted the lake.
    if (entry.kind === 'ramp' || entry.kind === 'pointer') {
      if (entry.center) setTimeout(() => map.setView(entry.center, entry.kind === 'ramp' ? 15 : 12), 0);
    } else if (!selected && entry.bounds) {
      map.fitBounds(entry.bounds);
    } else if (!selected && entry.center) {
      map.setView(entry.center, 13);
    }
  }
  return selected;
}
