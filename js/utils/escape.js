/**
 * HTML-escape a string for safe interpolation into innerHTML.
 *
 * The original code uses this everywhere as `esc(...)`. Centralizing it as a
 * module means we only have to remember to escape once per string.
 *
 * @param {*} s — anything stringifiable
 * @returns {string} HTML-safe text (ampersand, <, >, " replaced)
 */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
