/**
 * coastal-optgroups.js — append one coastal-zone <optgroup> per state to a <select>.
 *
 * This existed twice, byte for byte apart from the variable holding the select element:
 * lake-ramp-select.js:116 and lake-research-ui.js:192. Both build the same three groups from
 * the same `coastalNamesByState()` call and strip the same trailing state suffix off the
 * label. Two copies of a list-building loop is how the picker and the research dropdown drift
 * apart — one gains a zone or changes a label and the other quietly does not.
 *
 * The worker access index only covers inland DNR boat ramps, so without these groups the
 * coastal zones are unreachable from either dropdown and none of the tide / oyster / marsh
 * layers can be loaded.
 */
import { coastalNamesByState } from '../data/coastal-zones.js';

// ── THE STATES COME FROM THE CATALOG, NOT FROM A LIST TYPED HERE ────────────────────────────────
//
// This was `[['SC', 'SC Coast'], ['GA', 'GA Coast'], ['NC', 'NC Coast']]` and NC coastal was cut
// from the app on 2026-09-01 (a4bfd02) and finished on 2026-09-03 (a46f558). Ryan, on the second:
// "But keep NC coastal cut... i do not want it back in". The catalog has held SC and GA only ever
// since -- 13 zones, 9 and 4 -- and this line still asked for an NC group, which survived only
// because the loop skips a state with no zones. A dead entry nothing can see is how NC comes back.
//
// The same typed-list mistake is what a46f558 fixed one file over: coastalNamesByState()'s buckets
// used to be a literal `{ SC: [], GA: [], NC: [] }`, and when NC left the catalog somebody hand
// edited the generated file instead, so the generator said 16 zones and the app said 13. Those
// buckets are DERIVED now, and so is this. A state the catalog declares gets a group; a state it
// does not cannot be asked for.
//
// ORDER is the only thing still stated, because it is a preference and not data: SC first, because
// that is where Ryan fishes. Anything the catalog declares that is not named here follows, in the
// catalog's own order, so a new coast appears in the dropdown without an edit rather than being
// silently dropped.
const STATE_ORDER = ['SC', 'GA'];
const groupsFor = (byState) => {
  const states = Object.keys(byState).filter((st) => byState[st] && byState[st].length);
  const first = STATE_ORDER.filter((st) => states.includes(st));
  return [...first, ...states.filter((st) => !first.includes(st))]
    .map((st) => [st, `${st} Coast`]);
};

/**
 * @param {HTMLSelectElement} select  the element to append to
 * @param {(name: string) => string} [labelFor]  option text; defaults to the zone name with
 *        its trailing ", SC" stripped, since the group heading already says the state
 * @returns {number} how many options were added
 */
export function appendCoastalOptgroups(select, labelFor) {
  if (!select) return 0;
  const byState = coastalNamesByState();
  const text = labelFor || ((name) => name.replace(/,\s*[A-Z]{2}$/, ''));
  let added = 0;
  for (const [stateCode, label] of groupsFor(byState)) {
    const names = byState[stateCode];
    if (!names?.length) continue;
    const grp = document.createElement('optgroup');
    grp.label = label;
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = text(name);
      grp.appendChild(opt);
      added += 1;
    }
    select.appendChild(grp);
  }
  return added;
}
