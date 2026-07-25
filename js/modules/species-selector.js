/**
 * species-selector.js — swap the Plan tab's target-species checkboxes between
 * freshwater and saltwater depending on the selected waterbody.
 *
 * The checkbox list in index.html was hardcoded to Striped Bass / Hybrid /
 * Largemouth / Catfish / Crappie / White Bass / Bowfin. None of those live in
 * Charleston Harbor, and Red Drum / Speckled Trout / Flounder could not be
 * selected at all — so the coastal species intel and tide scoring had no way
 * to be reached from the UI.
 *
 * Each option is also annotated with its current harvest limit, and closed
 * species are disabled at the checkbox so an out-of-season plan cannot even
 * be requested. runSmartPlan() still hard-blocks server-side; this is the
 * cheaper, clearer first line.
 */

import { resolveR2Key } from '../data/lake-keys.js';
import { COASTAL_ZONES, isCoastalKey } from '../data/coastal-zones.js';
import {
  COASTAL_REGULATIONS,
  checkCoastalRegulations,
  formatCoastalLimit,
} from '../data/coastal-regulations.js';

const FRESHWATER_SPECIES = [
  { value: 'Striped Bass',    label: 'Striped Bass', checked: true },
  { value: 'Hybrid',          label: 'Hybrid' },
  { value: 'Largemouth Bass', label: 'Largemouth' },
  { value: 'Catfish',         label: 'Catfish' },
  { value: 'Crappie',         label: 'Crappie' },
  { value: 'White Bass',      label: 'White Bass' },
  { value: 'Bowfin',          label: 'Bowfin' },
];

const SALTWATER_SPECIES = [
  { value: 'Red Drum (Redfish)',                label: 'Red Drum', checked: true },
  { value: 'Speckled Trout (Spotted Seatrout)', label: 'Speckled Trout' },
  { value: 'Southern Flounder',                 label: 'Flounder' },
  { value: 'Black Drum',                        label: 'Black Drum' },
  { value: 'Sheepshead',                        label: 'Sheepshead' },
];

function currentTripDate() {
  const v = document.getElementById('planDate')?.value;
  return v ? new Date(`${v}T12:00:00`) : new Date();
}

function checkboxHtml({ value, label, checked }, { disabled, title, suffix }) {
  const dim = disabled ? 'opacity:.45;' : '';
  const strike = disabled ? 'text-decoration:line-through;' : '';
  return `<label title="${title || ''}"
      style="display:flex;align-items:center;gap:4px;font-size:12px;${dim}">
    <input type="checkbox" value="${value}"${checked && !disabled ? ' checked' : ''}${disabled ? ' disabled' : ''}>
    <span style="${strike}">${label}</span>${suffix || ''}
  </label>`;
}

/**
 * Rebuild the species list for the selected waterbody.
 * Preserves the user's ticks across a re-render where the species still exist.
 */
export function refreshSpeciesChecks() {
  const box = document.getElementById('planSpeciesChecks');
  if (!box) return;

  const lakeName = document.getElementById('lakeSelect')?.value
    || document.getElementById('planLake')?.value
    || '';
  const key = lakeName ? resolveR2Key(lakeName) : null;
  const coastal = isCoastalKey(key);
  const stateCode = coastal ? COASTAL_ZONES[key]?.state : null;

  const previouslyChecked = new Set(
    [...box.querySelectorAll('input:checked')].map((i) => i.value)
  );
  const mode = coastal ? 'salt' : 'fresh';
  const modeChanged = box.dataset.mode !== mode || box.dataset.state !== (stateCode || '');

  const list = coastal ? SALTWATER_SPECIES : FRESHWATER_SPECIES;
  const date = currentTripDate();

  const html = list.map((spec) => {
    // Freshwater keeps its existing behaviour untouched.
    if (!coastal) {
      const keep = modeChanged ? spec.checked : previouslyChecked.has(spec.value);
      return checkboxHtml({ ...spec, checked: keep }, {});
    }

    const reg = checkCoastalRegulations(stateCode, spec.value, date);
    const limit = formatCoastalLimit(reg.regInfo);
    const closed = !reg.legal;
    const keep = modeChanged ? spec.checked : previouslyChecked.has(spec.value);

    const suffix = closed
      ? '<span style="font-size:10px;color:var(--bad);font-weight:700">CLOSED</span>'
      : (limit ? `<span style="font-size:10px;color:var(--muted)">${limit}</span>` : '');

    return checkboxHtml(
      { ...spec, checked: keep },
      { disabled: closed, title: closed ? reg.reason : (reg.note || ''), suffix }
    );
  }).join('');

  box.innerHTML = html;
  box.dataset.mode = mode;
  box.dataset.state = stateCode || '';

  // Never leave the form with nothing selectable checked.
  if (!box.querySelector('input:checked')) {
    const first = box.querySelector('input:not([disabled])');
    if (first) first.checked = true;
  }

  renderRegNotice(box, coastal, stateCode, date);
}

/** Standing advisory under the list: closures and stale-digest warnings. */
function renderRegNotice(box, coastal, stateCode, date) {
  const id = 'coastalRegNotice';
  document.getElementById(id)?.remove();
  if (!coastal || !stateCode) return;

  const meta = COASTAL_REGULATIONS[stateCode]?._meta;
  const lines = [];

  for (const spec of SALTWATER_SPECIES) {
    const reg = checkCoastalRegulations(stateCode, spec.value, date);
    if (!reg.legal) lines.push(`<b>${spec.label}:</b> ${reg.reason}`);
  }

  // Collect distinct advisories (gear closures, expired digest) once.
  const seen = new Set();
  for (const spec of SALTWATER_SPECIES) {
    for (const w of checkCoastalRegulations(stateCode, spec.value, date).warnings || []) {
      if (!seen.has(w)) { seen.add(w); lines.push(w); }
    }
  }

  if (!lines.length) return;

  const el = document.createElement('div');
  el.id = id;
  el.style.cssText =
    'margin-top:8px;padding:6px 8px;border-left:3px solid var(--warn,#fb8c00);' +
    'background:rgba(251,140,0,.08);font-size:11px;line-height:1.5;color:var(--text)';
  el.innerHTML =
    `<div style="font-weight:700;color:var(--warn,#fb8c00);margin-bottom:2px">` +
    `⚠ ${stateCode} saltwater advisories</div>${lines.join('<br>')}` +
    (meta ? `<div style="margin-top:4px;color:var(--muted)">Source: ${meta.agency} · verify at ${meta.url}</div>` : '');
  box.parentElement?.appendChild(el);
}

function init() {
  const box = document.getElementById('planSpeciesChecks');
  if (!box) { setTimeout(init, 300); return; }

  document.getElementById('lakeSelect')?.addEventListener('change', refreshSpeciesChecks);
  document.getElementById('planLake')?.addEventListener('change', refreshSpeciesChecks);
  // Closures are date-dependent, so re-evaluate when the trip date moves.
  document.getElementById('planDate')?.addEventListener('change', refreshSpeciesChecks);

  refreshSpeciesChecks();
  console.log('[species-selector] module ready');
}

init();

window.refreshSpeciesChecks = refreshSpeciesChecks;
