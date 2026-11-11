/**
 * lure-choices.js -- the <option>s for a catch's lure: every lure in the tackle box, the fish's own selected.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * A SELECT, NOT A TYPE-AHEAD LIST. The journal card's lure ✎ first opened an <input list> on the fish's own lure, and a
 * browser filters that list by what is already in the box: opened on "A-Rig – four 3/4oz heads, 1oz middle (~5.6oz)" it
 * offered that one lure and nothing else. Ryan, 2026-11-10: "the lure change is there but the dropdown doesn't have the
 * lures to choose from". A <select> shows every lure whatever is selected, the way the species ✎ always has. A lure typed
 * at review that is not in the tackle box is kept as the first choice, so opening the ✎ never loses it.
 */
import { esc } from './escape.js';

/**
 * @param {string} current     the lure the catch has now ('' when none)
 * @param {string[]} names     the tackle box's lure names (journalLureNames())
 * @returns {string} option elements
 */
export function lureChoices(current, names) {
  const cur = String(current || '').trim();
  const all = Array.isArray(names) ? names : [];
  const list = cur && !all.includes(cur) ? [cur, ...all] : all;
  return (cur ? '' : '<option value="" selected>— pick the lure —</option>')
    + list.map((n) => `<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${esc(n)}</option>`).join('');
}
