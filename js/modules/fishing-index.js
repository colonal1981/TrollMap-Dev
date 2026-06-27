// fishing-index.js — Fisherman-friendly overlay on top of SCDNR data
// Imports from the canonical ramp database and adds fisherman-friendly
// groupings (e.g. "the Cooper" instead of "Tail Race Canal + Cooper River").

import { TRISTATE_MASTER_RAMPS } from "../data/ramps.js";

/**
 * trollmap_fishing_index.js — Fisherman-friendly overlay on top of SCDNR data
 *
 * The SCDNR LAUNCHES blob in index.html is biologically/hydrologically accurate
 * (e.g., William Dennis Landing is filed under "Tail Race Canal" because that's
 * what the water-body officially is) but that organization makes ramps hard to
 * find from a fisherman's perspective ("I want to fish the Cooper" → would never
 * think to look under "Tail Race Canal").
 *
 * This module is a NON-DESTRUCTIVE overlay. It doesn't modify the SCDNR data
 * at all — it just provides:
 *   1. FISHING_SYSTEMS — fisherman-named groups that pull ramps from MANY SCDNR keys
 *   2. SCDNR_OVERRIDES — corrections for the few entries that are actively wrong
 *   3. window.getFishingRamps(systemName) — returns the merged ramp list
 *
 * Scoped to waterbodies within ~2.5-3 hr drive of Sumter, SC (where the user
 * lives). NC waterbodies (ALL-CAPS keys in SCDNR data) are not currently
 * remapped because they're outside the target use range and the casing
 * convention actually disambiguates them correctly from SC entries with the
 * same name.
 *
 * Add to index.html with:   <script src="trollmap_fishing_index.js"><\/script>
 * Load BEFORE any code that wants to use window.getFishingRamps().
 */
(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────
   * 1. FISHING SYSTEMS — fisherman's grouping of SCDNR waterbody keys
   *    Each system pulls ramps from multiple SCDNR keys and merges them.
   *    Geographic ordering hints (when relevant) help dropdowns make sense.
   * ───────────────────────────────────────────────────────────────── */
  const FISHING_SYSTEMS = {

    // ═══ Cooper River system (Pinopolis tailrace → Charleston Harbor) ═══
    // SCDNR splits this into 5+ separate waterbody keys because each is
    // technically a distinct hydrological feature. From the angler's POV
    // it's all "the Cooper" — including the tailrace where you fish shad.
    "Cooper River system (Pinopolis tailrace → Charleston Harbor)": {
      scdnrKeys: [
        "Tail Race Canal",          // William Dennis (your shad spot)
        "Wadboo Creek",             // Rembert C Dennis
        "Goose Creek",              // John R Bettis
        "Back River",               // Bushy Park Fresh
        "Cooper River",             // proper river — Bushy Park Salt, Huger, Hendricks
      ],
      // Optional human-readable annotation for each ramp by SCDNR key
      annotations: {
        "Tail Race Canal":     "Pinopolis tailrace (great shad in season)",
        "Wadboo Creek":        "Cooper tributary",
        "Goose Creek":         "Cooper tributary",
        "Back River":          "Parallel waterway, Bushy Park area",
        "Cooper River":        "Main Cooper",
      },
      // Specific per-ramp notes (overlaid on the SCDNR ramp name)
      rampNotes: {
        "William Dennis": "⚠ Temporarily closed for renovations 2026; reopening pending.",
      },
      defaultMapCenter: [33.10, -79.92, 11],
    },

    // ═══ Lake Marion (incl. upper-pool sub-pools) ═══
    // Pool D / Pool L / Mays Lake are biological sub-areas of upper Marion.
    "Lake Marion (full lake)": {
      scdnrKeys: [
        "Lake Marion",
        "Pool D",
        "Pool L",
        "Mays Lake",
      ],
      annotations: {
        "Lake Marion": "Main lake",
        "Pool D":      "Upper Marion sub-pool",
        "Pool L":      "Upper Marion sub-pool",
        "Mays Lake":   "Upper Marion sub-pool",
      },
      defaultMapCenter: [33.55, -80.30, 11],
    },

    // ═══ Lake Monticello (incl. subimpoundment) ═══
    "Lake Monticello (full)": {
      scdnrKeys: [
        "Lake Monticello",
        "Monticello Recreation Lake",
      ],
      annotations: {
        "Lake Monticello":             "Main lake",
        "Monticello Recreation Lake":  "Recreation subimpoundment",
      },
      defaultMapCenter: [34.35, -81.30, 12],
    },

    // ═══ Murrells Inlet / ICW (overlapping water) ═══
    "Murrells Inlet / ICW": {
      scdnrKeys: [
        "Murrells Inlet",
        "Intracoastal Waterway",   // ICW passes right through Murrells
      ],
      annotations: {
        "Murrells Inlet":          "Inlet proper",
        "Intracoastal Waterway":   "ICW segment",
      },
      defaultMapCenter: [33.55, -79.05, 12],
    },

    // ═══ Charleston Harbor tidal creek complex ═══
    // A bunch of small creeks all flow into Charleston Harbor. Filed as
    // separate SCDNR keys; from a fisherman's perspective they're "the
    // Charleston inshore" you might pick from in one place.
    "Charleston Harbor tidal creeks": {
      scdnrKeys: [
        "Ashley River",
        "Wando River",
        "Stono River",
        "Folly River",
        "Wappoo Creek",
        "Elliot Cut",
        "Shem Creek",
        "Rantowles Creek",
      ],
      defaultMapCenter: [32.78, -79.95, 11],
    },
  };

  /* ─────────────────────────────────────────────────────────────────
   * 2. SCDNR_OVERRIDES — corrections for entries that are actively wrong
   *    Only used when an SCDNR entry has a real bug (name collision or
   *    coordinate error). DOES NOT modify the original data, just provides
   *    a sanitized view via getCorrectedRamps().
   * ───────────────────────────────────────────────────────────────── */
  const SCDNR_OVERRIDES = {

    // "Broad River" contains 2 entries that aren't on the inland Broad above
    // Columbia: one is the coastal Broad near Beaufort, one is in Georgia.
    "Broad River": {
      excludeRampNames: [
        "Broad River",           // [32.39, -80.78] = coastal Broad near Beaufort, DIFFERENT RIVER
        "Broad River (SR17)",    // [33.97, -82.77] = GA river entirely
      ],
      note: "Entries excluded: coastal Broad near Beaufort and a GA river that share the name. Use the dedicated 'Broad River (Beaufort coastal)' system if you need that one.",
    },

    // "Lake Russell" contains 3 different lakes named Russell:
    //   (a) the big Russell on the Savannah River (14 ramps at ~34.1°N)
    //   (b) "Lake Russell" near Cornelia GA (different lake entirely)
    //   (c) "Paradise PFA - Lake Russell" in south GA
    "Lake Russell": {
      excludeRampNames: [
        "Lake Russell",                  // [34.49, -83.49] — DIFFERENT Lake Russell in GA
        "Paradise PFA - Lake Russell",   // [31.39, -83.36] — DIFFERENT lake in south GA
      ],
      note: "Two entries excluded: a different Lake Russell in north GA and a Paradise PFA Lake Russell in south GA. The 14 remaining ramps are the actual Lake Russell on the Savannah River.",
    },

    // "Lake Robinson" — two distinct lakes:
    //   (a) J. Verne Smith Park at [34.99, -82.29] — Greenville County
    //   (b) "Lake Robinson" at [34.47, -80.16] — Darlington County
    // These really are two different SC lakes. We split them.
    "Lake Robinson": {
      // Both are legit but at very different locations — annotate by ramp
      rampNotes: {
        "J. Verne Smith Park": "Greenville County Lake Robinson",
        "Lake Robinson":       "Darlington County Lake Robinson",
      },
      note: "Two different SC lakes both named Lake Robinson. Annotations distinguish them.",
    },
  };

  /* ─────────────────────────────────────────────────────────────────
   * 3. Public API
   * ───────────────────────────────────────────────────────────────── */

  // Pull the SCDNR LAUNCHES blob from the host page's globals.
  // In your index.html the actual variable is `TRISTATE_MASTER_RAMPS` (a
  // top-level const at line 1163). Top-level `const` in a <script> tag is
  // NOT automatically attached to `window` (unlike `var`), so we look in
  // a few places and degrade gracefully if it's not exposed.
  function getScdnrLaunches() {
    if (typeof window === 'undefined') return null;
    // Most likely globals (in priority order):
    return window.TRISTATE_MASTER_RAMPS    // your actual variable name
        || window.LAUNCHES_DB
        || window.LAUNCHES
        || window.SC_LAUNCHES
        || (typeof TRISTATE_MASTER_RAMPS !== 'undefined' ? TRISTATE_MASTER_RAMPS : null)
        || null;
  }

  // Flatten SCDNR's two-level structure: { state: { waterbody: { ramp: [lat,lon] } } }
  // into one big map keyed by waterbody name → [{name, lat, lon}, ...]
  function flattenLaunches(launches) {
    const out = {};
    if (!launches) return out;
    // Could be either {state: {wb: {ramp}}} or {wb: {ramp}} — handle both
    for (const k of Object.keys(launches)) {
      const v = launches[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        // Is this a state container or a waterbody?
        const firstVal = Object.values(v)[0];
        if (firstVal && typeof firstVal === 'object' && !Array.isArray(firstVal)
            && !Array.isArray(Object.values(firstVal)[0])) {
          // Two-level: state → waterbody
          for (const [wbName, ramps] of Object.entries(v)) {
            mergeWaterbody(out, wbName, ramps);
          }
        } else {
          // One-level: waterbody → ramps
          mergeWaterbody(out, k, v);
        }
      }
    }
    return out;
  }

  function mergeWaterbody(out, name, ramps) {
    if (!out[name]) out[name] = [];
    for (const [rampName, coords] of Object.entries(ramps)) {
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const [lat, lon] = coords;
      if (!isFinite(lat) || !isFinite(lon)) continue;
      // Dedupe by name
      if (!out[name].some(r => r.name === rampName)) {
        out[name].push({ name: rampName, lat: +lat, lon: +lon });
      }
    }
  }

  // Apply SCDNR_OVERRIDES to a waterbody's ramps before returning them.
  function applyOverrides(wbName, ramps) {
    const ov = SCDNR_OVERRIDES[wbName];
    if (!ov) return ramps.map(r => ({ ...r }));
    let filtered = ramps;
    if (Array.isArray(ov.excludeRampNames)) {
      filtered = filtered.filter(r => !ov.excludeRampNames.includes(r.name));
    }
    return filtered.map(r => {
      const note = ov.rampNotes?.[r.name];
      return note ? { ...r, note } : { ...r };
    });
  }

  // Get all ramps for a given fishing system (or raw SCDNR key if no system matches).
  function getFishingRamps(systemOrKeyName) {
    const launches = flattenLaunches(getScdnrLaunches());

    // 1. Is it a fishing system?
    const sys = FISHING_SYSTEMS[systemOrKeyName];
    if (sys) {
      const merged = [];
      for (const scdnrKey of sys.scdnrKeys) {
        const ramps = applyOverrides(scdnrKey, launches[scdnrKey] || []);
        for (const r of ramps) {
          // Attach context: which SCDNR waterbody this came from + any annotation
          const item = { ...r, _scdnrKey: scdnrKey };
          if (sys.annotations?.[scdnrKey]) item._annotation = sys.annotations[scdnrKey];
          if (sys.rampNotes?.[r.name]) item.note = sys.rampNotes[r.name];
          merged.push(item);
        }
      }
      return merged;
    }

    // 2. Fall back to direct SCDNR waterbody name (with overrides applied)
    if (launches[systemOrKeyName]) {
      return applyOverrides(systemOrKeyName, launches[systemOrKeyName]);
    }

    // 3. Nothing found
    return [];
  }

  // List all the fishing systems + their member SCDNR keys (for UI dropdowns)
  function listFishingSystems() {
    return Object.entries(FISHING_SYSTEMS).map(([name, def]) => ({
      name,
      scdnrKeys: def.scdnrKeys,
      defaultMapCenter: def.defaultMapCenter,
    }));
  }

  // Get the notes/warnings attached to a fishing system or waterbody.
  function getSystemNote(name) {
    return FISHING_SYSTEMS[name]?.note || SCDNR_OVERRIDES[name]?.note || null;
  }

  // Expose
  window.TrollMapFishingIndex = {
    FISHING_SYSTEMS,
    SCDNR_OVERRIDES,
    getFishingRamps,
    listFishingSystems,
    getSystemNote,
    // For debugging / sanity checks:
    _flattenLaunches: flattenLaunches,
    _getScdnrLaunches: getScdnrLaunches,
  };
  // Convenience global
  window.getFishingRamps = getFishingRamps;

  console.log('[trollmap_fishing_index] loaded — ' + Object.keys(FISHING_SYSTEMS).length
    + ' fishing systems, ' + Object.keys(SCDNR_OVERRIDES).length + ' SCDNR overrides');
})();
