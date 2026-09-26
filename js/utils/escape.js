/**
 * HTML-escape a string for safe interpolation into innerHTML.
 *
 * The original code uses this everywhere as `esc(...)`. Centralizing it as a
 * module means we only have to remember to escape once per string.
 *
 * @param {*} s — anything stringifiable
 * @returns {string} HTML-safe text (ampersand, <, >, " and ' replaced)
 *
 * The apostrophe since 2026-09-25, when the private copies in conditions-strip.js and
 * plan-water-ui.js (which escaped it) were folded into this one: a value in a single-quoted
 * attribute is safe too.
 */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
