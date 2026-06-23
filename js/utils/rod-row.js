/**
 * Build a single rod-spread row with sensible defaults.
 *
 * The original app initializes the rod spread with six rods on app load.
 * Centralizing the row builder keeps the row schema in one place and
 * makes it easy to add a new column later.
 *
 * @param {Object} [opts]
 * @param {string} [opts.side]       — "Port" | "Starboard" | "Center"
 * @param {string} [opts.position]   — "Bow" | "Mid" | "Stern"
 * @param {string} [opts.reel]       — reel/line description
 * @param {string} [opts.lure]       — lure/bait
 * @param {string} [opts.color]      — color
 * @param {string|number} [opts.depth] — depth in ft
 * @param {string|number} [opts.lead]  — lead length in ft
 * @param {string} [opts.notes]      — notes
 * @returns {Object} rod row
 */
export function newRodRow(opts = {}) {
  return {
    side:     opts.side     ?? '',
    position: opts.position ?? '',
    reel:     opts.reel     ?? '',
    lure:     opts.lure     ?? '',
    color:    opts.color    ?? '',
    depth:    opts.depth    ?? '',
    lead:     opts.lead     ?? '',
    notes:    opts.notes    ?? '',
  };
}
