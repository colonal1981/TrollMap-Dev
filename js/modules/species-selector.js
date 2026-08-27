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
import { matchSpeciesKeys } from './plan-inputs.js';

// -------------------------------------------------------------------------------------------
// THE CATALOGUE IS A FLOOR, NOT THE LIST.
//
// Ryan asked four times for the fish that were missing: no sunfish were selectable at all, no
// perch, and no saltwater species beyond the five the coastal regulation table happens to hold —
// while every coastal zone is a selectable waterbody. A third of what he fishes could not be
// asked for.
//
// The list is driven by the waterbody in two steps, in this order:
//
//   1. WHICH CATALOGUE — `isCoastalKey(resolveR2Key(name))` picks saltwater or freshwater. This
//      is what stops an inland lake offering tarpon and a sound offering crappie.
//   2. WHAT THIS WATER ACTUALLY HOLDS — the lake's researched profile names its own species in
//      `trollingIntelligence`, and anything it names that the catalogue does not carry is added
//      below (`researchedExtras`). Wateree's own briefing lists Bluegill, Redear, Redbreast,
//      Warmouth and White Perch with seasonal bands; nothing read it.
//
// The profile is only in memory once the research tab has loaded that lake, and most lakes have
// never been researched, so it CANNOT be the only source — a selector that empties itself on an
// unresearched lake is worse than one hardcoded array. Hence: catalogue as the floor, research
// as the extension.
//
// `value` is the string that reaches the plan and it must stay stable: plan-builder.js:503
// restores a saved plan by matching these exact strings against the checkboxes, so renaming a
// value silently unticks that species on every plan already saved. Labels are free to change.
// -------------------------------------------------------------------------------------------

const FRESHWATER_GROUPS = [
  { label: 'Gamefish', species: [
    { value: 'Striped Bass',    label: 'Striped Bass', checked: true },
    { value: 'Hybrid',          label: 'Hybrid' },
    { value: 'Largemouth Bass', label: 'Largemouth' },
    { value: 'White Bass',      label: 'White Bass' },
    { value: 'Bowfin',          label: 'Bowfin' },
  ] },
  { label: 'Catfish', species: [
    { value: 'Catfish',         label: 'Catfish' },
  ] },
  { label: 'Panfish', species: [
    { value: 'Crappie',         label: 'Crappie' },
    { value: 'White Perch',     label: 'White Perch' },
    { value: 'Yellow Perch',    label: 'Yellow Perch' },
  ] },
  // Ryan: "they can be their own category" — a group is fine, one checkbox for the group is not.
  { label: 'Sunfish', species: [
    { value: 'Bluegill',                     label: 'Bluegill' },
    { value: 'Redear Sunfish (Shellcracker)', label: 'Redear / Shellcracker' },
    { value: 'Redbreast Sunfish',            label: 'Redbreast' },
    { value: 'Warmouth',                     label: 'Warmouth' },
    { value: 'Green Sunfish',                label: 'Green Sunfish' },
    { value: 'Pumpkinseed',                  label: 'Pumpkinseed' },
  ] },
];

const SALTWATER_GROUPS = [
  { label: 'Inshore', species: [
    { value: 'Red Drum (Redfish)',                label: 'Red Drum', checked: true },
    { value: 'Speckled Trout (Spotted Seatrout)', label: 'Speckled Trout' },
    { value: 'Southern Flounder',                 label: 'Flounder' },
    { value: 'Sheepshead',                        label: 'Sheepshead' },
    { value: 'Black Drum',                        label: 'Black Drum' },
    { value: 'Bluefish',                          label: 'Bluefish' },
    { value: 'Ladyfish',                          label: 'Ladyfish' },
  ] },
  { label: 'Nearshore / migratory', species: [
    { value: 'Tarpon',                            label: 'Tarpon' },
    { value: 'Cobia',                             label: 'Cobia' },
    { value: 'Spanish Mackerel',                  label: 'Spanish Mackerel' },
  ] },
];

/** Every catalogue entry for a waterbody type, flattened. */
function flatten(groups) {
  return groups.flatMap((g) => g.species);
}

/**
 * Species this lake's research names that the catalogue does not already carry.
 *
 * Keys come from an LLM, so they are matched the same loose way `depthBandFor()` matches them —
 * `matchSpeciesKeys`, exact then containment either way — against both the catalogue values and
 * their labels. Anything that finds a home is a duplicate and is dropped; anything left is a
 * fish this water holds and the app could not ask for.
 */
export function researchedExtras(profile, groups) {
  const ti = profile && profile.trollingIntelligence;
  if (!ti || typeof ti !== 'object') return [];

  const known = {};
  for (const s of flatten(groups)) { known[s.value] = true; known[s.label] = true; }

  const out = [];
  const seen = new Set();
  for (const raw of Object.keys(ti)) {
    const name = String(raw || '').trim();
    // A heading, a sentence or an empty key is not a species. Anything longer than this is
    // prose the fisheries agent put where a species name belongs.
    if (!name || name.length > 40) continue;
    if (matchSpeciesKeys(known, name).length) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ value: name, label: name, researched: true });
  }
  return out;
}

/**
 * The groups to show for a waterbody. Pure — no DOM, no globals — so it can be tested.
 *
 * @param {string|null} key      the R2 key, e.g. 'wateree_lake' or 'coast_winyah_bay_sc'
 * @param {object|null} profile  the researched profile, or null when there is none
 */
export function speciesGroupsFor(key, profile) {
  const groups = (isCoastalKey(key) ? SALTWATER_GROUPS : FRESHWATER_GROUPS)
    .map((g) => ({ label: g.label, species: g.species.map((s) => ({ ...s })) }));

  const extras = researchedExtras(profile, groups);
  if (extras.length) groups.push({ label: 'Named by this lake\u2019s research', species: extras });
  return groups;
}

function currentTripDate() {
  const v = document.getElementById('planDate')?.value;
  return v ? new Date(`${v}T12:00:00`) : new Date();
}

/**
 * A full-width heading inside the flex row, so a group breaks the line without needing the
 * container in index.html to change shape.
 */
function groupHeadingHtml(label) {
  return `<div style="flex:0 0 100%;margin:6px 0 -4px;font-size:10px;font-weight:700;
      letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">${label}</div>`;
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

  // The lake's own researched species, when the research tab has loaded it. Absent is normal.
  let profile = null;
  try { profile = window.getResearchedProfile?.(lakeName) || null; }
  catch (e) { console.warn('[species-selector] researched cache threw', e.message); }

  const groups = speciesGroupsFor(key, profile);
  const date = currentTripDate();

  const html = groups.map((group) => {
    const rows = group.species.map((spec) => {
      // Freshwater keeps its existing behaviour untouched.
      if (!coastal) {
        const keep = modeChanged ? spec.checked : previouslyChecked.has(spec.value);
        return checkboxHtml({ ...spec, checked: keep }, {});
      }

      const reg = checkCoastalRegulations(stateCode, spec.value, date);
      // THE DIGEST WINS THE LABEL. `limits` is this year's book, read off the same fetch the
      // conditions strip already made; `regInfo` is the hand-typed floor and only answers when
      // nobody has primed the digest yet. Showing the floor while the book is in memory is how
      // the app displays a number it has already been told is out of date.
      const limit = formatCoastalLimit(reg.limits || reg.regInfo);
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
    return groupHeadingHtml(group.label) + rows;
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

  const saltwater = flatten(SALTWATER_GROUPS);

  for (const spec of saltwater) {
    const reg = checkCoastalRegulations(stateCode, spec.value, date);
    if (!reg.legal) lines.push(`<b>${spec.label}:</b> ${reg.reason}`);
  }

  // Collect distinct advisories (gear closures, expired digest) once.
  const seen = new Set();
  for (const spec of saltwater) {
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

// The catalogue and `speciesGroupsFor()` are pure and worth testing, but everything below the
// exports touches `document` at module scope. Guarded the same way smart-plan-v2-wiring.js:333
// guards its own, so the module can be imported in node without a DOM.
if (typeof document !== 'undefined') init();
if (typeof window !== 'undefined') window.refreshSpeciesChecks = refreshSpeciesChecks;
