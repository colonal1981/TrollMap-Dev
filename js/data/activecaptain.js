/**
 * activecaptain.js — the ActiveCaptain markers, joined onto each water in the browser.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY HERE AND NOT IN THE PACK
 *
 * merge_ac_pois.py wrote the markers into each pack's pois.geojson, and the chartpack build owns
 * that file and writes it fresh every rebuild -- so every rebuild took them back out. On
 * 2026-11-26, three of the 1,074 packs on the F: drive still had one. Ryan, on hearing it could be
 * kept out of the packs: "yep lets do that".
 *
 * So the markers live in ONE file, `_registry/activecaptain_by_lake.json`, written by
 * Scripts/build_ac_by_lake.py from his newest database and shipped beside lake_index.json. A pack
 * rebuild cannot touch it, and a new database cannot touch a pack. This module is where the two
 * meet, with the rule the pipeline already used.
 *
 * A MISSING FILE IS THE OLD APP. Every reader here answers empty when the file is not in R2 or
 * fails to load, and the map, the picker and the planner go on exactly as before.
 */

import { workerBase, namesALanding } from './lake-registry.js';
import { geoDistanceM } from '../utils/geo.js';

const AC_PATH = '/chartpacks/_registry/activecaptain_by_lake.json';

let _promise = null;
let _doc = null;

export function loadActiveCaptain() {
  if (!_promise) {
    _promise = fetch(`${workerBase()}${AC_PATH}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        _doc = d && d.lakes && typeof d.lakes === 'object' ? d : null;
        if (_doc) {
          console.info(`[activecaptain] ${Object.keys(_doc.lakes).length} waters, markers as of `
                     + `${_doc.markers_as_of || 'unknown'}`);
        }
        return _doc;
      })
      .catch((e) => {
        console.warn('[activecaptain] not loaded, the map carries Garmin and the feeds only:',
                     e?.message || e);
        _doc = null;
        return null;
      });
  }
  return _promise;
}

/** For tests: hand the module a document instead of fetching one. */
export function setActiveCaptainDoc(doc) {
  _doc = doc && doc.lakes ? doc : null;
  _promise = Promise.resolve(_doc);
}

export function activeCaptainAsOf() { return (_doc && _doc.markers_as_of) || null; }

export function acRowsFor(slug, doc = _doc) {
  const rows = doc && doc.lakes && slug ? doc.lakes[slug] : null;
  return Array.isArray(rows) ? rows : [];
}

// ── THE POI LAYER ─────────────────────────────────────────────────────────────────────────────

function acFeature(r) {
  return {
    type: 'Feature',
    properties: {
      name: r.name, poi_type: r.poi_type, ac_poi_type: r.ac_poi_type, ac_id: r.ac_id,
      on_water: !!r.on_water, source: 'ActiveCaptain',
    },
    geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
  };
}

// build_chartpack.py norm(): lower case, letters and digits only.
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

export const SAME_POI_M = 50;

/**
 * Put this water's markers into its pack's POIs, IN PLACE, and say what happened.
 *
 * merge_pois() in build_chartpack.py, the rule the pipeline used and the one Ryan set: SAME NAME
 * AND WITHIN 50 m is the same feature. Name equality is required because Garmin puts a dock, a ramp
 * and a fuel dock inside 50 m of each other at every marina; merging on distance would eat them.
 * On a match the ActiveCaptain record keeps its surveyed position and its name, takes Garmin's
 * extra fields, and a Garmin card that says Ramp beats ActiveCaptain's category.
 *
 * ONE CHANGE FROM THE PYTHON: on_water is either source's yes. merge_pois() let ActiveCaptain's
 * answer win, so a Garmin label on the water could be hidden by a marina office 30 m up the bank.
 * Nothing was on the map before this file that is not on it after.
 *
 * A record the pack already carries -- the three packs merge_ac_pois.py wrote that no rebuild has
 * reached yet -- is skipped by its ac_id, so nothing is drawn twice.
 *
 * @param {object|null} gj   the pack's pois.geojson, or null when the pack has none
 * @returns {{gj: object|null, added: number, merged: number, already: number}}
 */
export function mergeActiveCaptain(gj, slug, doc = _doc) {
  const rows = acRowsFor(slug, doc);
  if (!rows.length) return { gj, added: 0, merged: 0, already: 0 };
  const out = gj && Array.isArray(gj.features) ? gj : { type: 'FeatureCollection', features: [] };
  const have = new Set();
  for (const f of out.features) {
    const id = f && f.properties && f.properties.ac_id;
    if (id !== undefined && id !== null) have.add(Number(id));
  }
  const ac = [];
  let already = 0;
  for (const r of rows) {
    if (have.has(Number(r.ac_id))) { already++; continue; }
    ac.push(acFeature(r));
  }
  const byName = new Map();
  ac.forEach((f, i) => {
    const n = norm(f.properties.name);
    if (!n) return;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(i);
  });
  const keep = [];
  let merged = 0;
  for (const g of out.features) {
    const gp = (g && g.properties) || {};
    const gc = g && g.geometry && g.geometry.coordinates;
    const n = norm(gp.name || gp.card);
    let hit = null;
    if (n && Array.isArray(gc)) {
      for (const i of byName.get(n) || []) {
        const c = ac[i].geometry.coordinates;
        if (geoDistanceM(gc[1], gc[0], c[1], c[0]) <= SAME_POI_M) { hit = ac[i]; break; }
      }
    }
    if (!hit) { keep.push(g); continue; }
    merged++;
    const p = hit.properties;
    const acOnWater = p.on_water;
    for (const [k, v] of Object.entries(gp)) {
      if (k === 'name' || k === 'poi_type' || k in p) continue;
      p[k] = v;
    }
    p.on_water = acOnWater || gp.on_water !== false;
    p.source = 'ActiveCaptain+Garmin';
    if (gp.poi_type === 'boat_ramp') p.poi_type = 'boat_ramp';
  }
  out.features = keep.concat(ac);
  return { gj: out, added: ac.length - merged, merged, already };
}

// ── THE ACCESS INDEX ──────────────────────────────────────────────────────────────────────────

// Has to carry the word `ramp`: liveAccessFor() and accessKinds() in access-index.js classify a
// landing off its label, and a label without one of their words is a point the planner does not
// count as somewhere to launch. ActiveCaptain files these under its own Boat Ramp category.
export const AC_RAMP_LABEL = 'Boat ramp (ActiveCaptain)';

/**
 * This water's ActiveCaptain ramps, in the shape access-index.js adds.
 *
 * ON THE WATER ONLY -- inside the boundary or within its one 22 m cell. A ramp out in the 250 m
 * collar is as likely to be on the next water: a tailrace ramp below a dam sits that close to the
 * lake above it. Measured on the 2026-11-15 database: 564 ramps, 79 of them collar-only.
 */
export function acAccessPointsFor(rec, doc = _doc) {
  if (!rec || !rec.slug) return [];
  const out = [];
  for (const r of acRowsFor(rec.slug, doc)) {
    if (r.poi_type !== 'boat_ramp' || !r.on_water) continue;
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    out.push({
      name: r.name,
      unnamed: !namesALanding(r.name),
      lat: r.lat,
      lon: r.lon,
      typeLabel: AC_RAMP_LABEL,
      marker: '⚓',
      sourcePath: 'activecaptain',
      sourceState: rec.state,
      launch: true,
      meta: { source: 'ActiveCaptain', ac_id: r.ac_id },
    });
  }
  return out;
}
