/**
 * coastal-optgroups.js — append the SC / GA / NC coastal zone <optgroup>s to a <select>.
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

/** Order is deliberate: SC first, because that is where Ryan fishes. */
const GROUPS = [['SC', 'SC Coast'], ['GA', 'GA Coast'], ['NC', 'NC Coast']];

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
  for (const [stateCode, label] of GROUPS) {
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
