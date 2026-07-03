/**
 * Build a single rod-spread row with sensible defaults.
 *
 * Central row schema for the entire app (spread table + plan save/load + preview).
 *
 * IMPORTANT FIXES:
 * - Added `rod` (rod model) — was missing, causing "rods do not stay selected".
 * - Added A-Rig trailer fields: `trailerSize`, `arigWeight`, `jigWeight`.
 *   These were being dropped on every loadPlanIntoForm() and saved-spread load.
 * - Added future-proof copy of any extra keys the UI may set.
 *
 * @param {Object} [opts]
 * @returns {Object} complete rod row
 */
export function newRodRow(opts = {}) {
  const row = {
    side:     opts.side     ?? '',
    position: opts.position ?? '',
    // FIX (2026-07-03): this was silently changed from a real default to ''
    // during the split into modules. The original monolithic app (Index.html,
    // pre-refactor) always defaulted every new rod row to this exact rod —
    // it's why "the Rod Architecture column used to fill in" and then
    // stopped. Restored verbatim from the old ROD_PRESETS[0] / newRodRow()
    // default. This angler only ever had two actual rods in the whole
    // system (both Ugly Stik Lite Pro spinning rods, 6'6" and 7', both
    // Medium Mod-Fast) — there was never a rich per-technique rod catalog,
    // so don't reintroduce fabricated technique-based rod picks elsewhere.
    rod:      opts.rod      ?? '6\'6" M Mod-Fast Spinning (Ugly Stik Lite Pro)',     // ← critical: "Rod" column selection
    reel:     opts.reel     ?? '',
    lure:     opts.lure     ?? '',
    color:    opts.color    ?? '',
    depth:    opts.depth    ?? '',
    lead:     opts.lead     ?? '',
    notes:    opts.notes    ?? '',

    // A-Rig / umbrella rig specific (the main reported bug)
    trailerSize: opts.trailerSize ?? '',   // e.g. "4.6\" swimbait"
    arigWeight:  opts.arigWeight  ?? '',   // e.g. "~2.65oz Framework"
    jigWeight:   opts.jigWeight   ?? '',   // e.g. "3/16oz × 5 (Uniform)"
  };

  // Preserve anything else the spread-builder or saved data may have added
  for (const k in opts) {
    if (!(k in row)) row[k] = opts[k];
  }
  return row;
}
