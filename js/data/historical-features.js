/**
 * historical-features.js — the named places a reservoir drowned, for the map's chart text.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * `Scripts/build_gnis_historical.py` writes `registry/gnis_historical.json`: every USGS GNIS
 * historical feature whose point lies INSIDE a lake's or river's own outline -- 538 on 64 waters
 * when it was first built, 2026-09-23. Seven on Wateree: Peays, Mickles and Kingsburys Ferry,
 * Dukes Ford, Aldrichs Shoal, Montgomerys Island, the Wateree Canal. Five old ferries on Murray.
 * Fort Prince George under Keowee. Loyston under Norris.
 *
 * Ryan, choosing how they show: *"always on"*. They ride the chart-names switch that Garmin's
 * creek and cove names already ride, which is on by default -- chart names are furniture, not a
 * POI overlay (supplemental-layers.js says why). No new button.
 *
 * TWO KINDS OF MARK, BY WHAT THE THING WAS. A crossing, a shoal, a bar, an island, a canal, a
 * fort or a town is something that was BUILT or STOOD at a point -- a roadbed, two landings, a
 * rock bar, a foundation -- so it gets a small mark and its name. A drowned lake, swamp, creek,
 * channel or mill pond is an area or a line that GNIS happens to pin to one point; it gets its
 * name only, the way a Garmin place name is drawn.
 *
 * Pure except for the one cached fetch, so the choices can be tested.
 */
import { registryLoader } from './registry-loader.js';

export const HISTORICAL_PATH = '/chartpacks/_registry/gnis_historical.json';

const LOADER = registryLoader(HISTORICAL_PATH,
  (b) => b && b.waters && typeof b.waters === 'object' && !Array.isArray(b.waters) && b.waters);

/** Read the table once. A failure is silence, as registry-loader promises. */
export function primeHistorical(worker) { return LOADER.prime({ worker }); }

/** Exposed for tests. */
export function _resetHistorical() { LOADER.reset(); }

/** The features inside this water's outline, or [] -- never null, never a partial list. */
export function historicalFor(slug, payload = LOADER.get()) {
  const waters = payload && payload.waters;
  const list = waters && slug ? waters[slug] : null;
  return Array.isArray(list)
    ? list.filter((f) => f && f.name && Number.isFinite(f.lat) && Number.isFinite(f.lon))
    : [];
}

const MARKED = new Set(['Crossing', 'Rapids', 'Bar', 'Island', 'Canal', 'Military',
                        'Populated Place', 'Dam', 'Locale', 'Building', 'Mine', 'Bridge']);

/** Does this class get a mark on the map, or its name only? */
export function historicalMarked(cls) { return MARKED.has(String(cls || '')); }

/** What the thing WAS, in words for the popup. GNIS's own class, lower-cased where it reads. */
export function historicalWhat(cls) {
  const c = String(cls || '').trim();
  const words = { 'Crossing': 'Crossing (ford or ferry)', 'Populated Place': 'Town or settlement',
                  'Rapids': 'Shoal or rapids', 'Military': 'Fort', 'Bar': 'Bar' };
  return words[c] || c || 'Historical feature';
}

/** The popup body. Plain text; the caller escapes. */
export function historicalNote(f) {
  return `${historicalWhat(f && f.class)}, historical -- before the lake. `
       + 'Position as USGS recorded it (GNIS, from old topographic maps); it may be approximate.';
}
