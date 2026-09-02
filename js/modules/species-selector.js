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

// THE ROSTER IS IN R2, NOT ONLY IN THE RESEARCH TAB'S MEMORY.
//
// `window.getResearchedProfile()` reads a cache the research tab fills when a person opens a lake
// on it, so on a cold load it answers null for every water -- and a selector that filters on that
// shows the whole catalogue everywhere, which is the opposite of filtering. loadResearchedProfile()
// is the loader Pick Water already uses: cache first, then /research/get, which resolves the water
// against every spelling the store holds. Two readers of the same question is how they drift, so
// this is the same one.
//
// One attempt per water per page load. A null answer is cached as null so a lake with no profile is
// not re-fetched on every re-render.
//
// IMPORTED LAZILY, AND THAT IS NOT A STYLE CHOICE. smart-plan-v2-wiring.js reaches `window` through
// its own import graph, and species-selector.test.js runs in plain node with no DOM -- a static
// import here fails the whole suite with "window is not defined" before a single assertion runs.
// The loader is only ever wanted on the DOM path, which is the same path that has a window.
const _profileByLake = new Map();

// THE CATALOGUE IS THE BOOKS' OWN SPECIES ROWS.
//
// It was fifteen fish chosen from memory, and `registry/species_map.json` had been measuring the
// cost of that for a week: across the four digests, 148 regulation rules name a fish the form
// could not express, so not one of them could ever fire. Nine were black bass -- SMALLMOUTH BASS
// is a separate DATED window on Cherokee, Norris and Douglas, and the angler could not say they
// were fishing for one.
//
// Ryan, 2026-09-02: "if it is a species in the regs that is fishable from a kayak then go ahead and
// add it... meaning nothing saltwater that is not inshore... this way we don't have to have this
// conversation again." So the rule, not the list: EVERY SPECIES THE FOUR BOOKS NAME AS A ROW OF ITS
// OWN becomes a checkbox, except
//   - a band heading rather than a fish   (ALL OTHER WARMWATER GAME FISHES, INSHORE FINFISH)
//   - one the book forbids keeping        (TN Alligator Gar and Shovelnose Sturgeon, NC STURGEON)
//   - not a fish                          (NC BLUE CRABS)
//   - saltwater the book pages offshore   (SC p51 OFFSHORE FINFISH and everything after it --
//                                          snapper-grouper, tunas, billfish, sharks)
// and the rough fish Ryan struck by hand the same day: American Eel, Paddlefish, Skipjack and river
// Herring, Hickory Shad, Grass Carp, Mullet and Saltwater Catfish. Those stay declared in
// no_home_in_the_form WITH THE REASON, rather than becoming boxes nobody would tick.
//
// SC pages its own saltwater table INSHORE FINFISH (p50) and then OFFSHORE FINFISH (p51). That is
// where the inshore line comes from -- it is the book's line, not ours.
//
// `covers` names the canonical research species a GROUP box stands for, and exists only for the
// five boxes that are groups rather than species. It is what lets a lake whose roster says "Black
// Crappie" reveal the Crappie box. Every other value is its own canonical name.
//
// `value` is the string that reaches the plan and it must stay stable: plan-builder.js:503 restores
// a saved plan by matching these exact strings against the checkboxes, so renaming a value silently
// unticks that species on every plan already saved. Labels and grouping are free to change.

const FRESHWATER_GROUPS = [
  // TWRA prints the definition inside the regulation: "Black Bass (includes Largemouth, Smallmouth,
  // Spotted, Alabama, Coosa and all hybrids)". SC p31 and NC p31 then give Smallmouth, Spotted and
  // Alabama rows of their own, and GA p64 names Shoal Bass.
  { label: 'Black bass', species: [
    { value: 'Largemouth Bass', label: 'Largemouth' },
    { value: 'Smallmouth Bass', label: 'Smallmouth' },
    { value: 'Spotted Bass',    label: 'Spotted' },
    { value: 'Alabama Bass',    label: 'Alabama' },
    { value: 'Redeye Bass',     label: 'Redeye · Coosa · Bartram’s' },
    { value: 'Shoal Bass',      label: 'Shoal' },
  ] },
  { label: 'Temperate bass', species: [
    { value: 'Striped Bass', label: 'Striped Bass', checked: true },
    { value: 'Hybrid',       label: 'Hybrid',     covers: ['White Bass / Hybrid'] },
    { value: 'White Bass',   label: 'White Bass', covers: ['White Bass / Hybrid'] },
    { value: 'Yellow Bass',  label: 'Yellow Bass' },
    { value: 'White Perch',  label: 'White Perch' },
  ] },
  { label: 'Walleye & perch', species: [
    { value: 'Walleye',      label: 'Walleye' },
    { value: 'Sauger',       label: 'Sauger' },
    { value: 'Yellow Perch', label: 'Yellow Perch' },
  ] },
  { label: 'Pike & pickerel', species: [
    { value: 'Muskellunge',     label: 'Muskellunge' },
    { value: 'Northern Pike',   label: 'Northern Pike' },
    { value: 'Chain Pickerel',  label: 'Chain Pickerel' },
    { value: 'Redfin Pickerel', label: 'Redfin Pickerel' },
  ] },
  { label: 'Panfish', species: [
    { value: 'Crappie',      label: 'Crappie', covers: ['Black Crappie', 'White Crappie'] },
    { value: 'Rock Bass',    label: 'Rock Bass' },
    { value: 'Roanoke Bass', label: 'Roanoke Bass' },
    { value: 'Shadow Bass',  label: 'Shadow Bass' },
  ] },
  // Ryan: "they can be their own category" -- a group is fine, one checkbox for the group is not.
  // Flier and Spotted Sunfish join it because SC p30 and NC p32 both name them inside the bream
  // band, which is the only reason that band was PARTLY mapped instead of mapped.
  { label: 'Sunfish', species: [
    { value: 'Bluegill',                      label: 'Bluegill' },
    { value: 'Redear Sunfish (Shellcracker)', label: 'Redear / Shellcracker' },
    { value: 'Redbreast Sunfish',             label: 'Redbreast' },
    { value: 'Warmouth',                      label: 'Warmouth' },
    { value: 'Green Sunfish',                 label: 'Green Sunfish' },
    { value: 'Pumpkinseed',                   label: 'Pumpkinseed' },
    { value: 'Flier',                         label: 'Flier' },
    { value: 'Spotted Sunfish',               label: 'Spotted Sunfish' },
  ] },
  // Every book regulates catfish as one group -- SC p30 names Blue Catfish alone, NC p43 writes
  // "CATFISH (BLUE, CHANNEL, & FLATHEAD)" -- so one box, and `covers` carries the species.
  { label: 'Catfish', species: [
    { value: 'Catfish', label: 'Catfish',
      covers: ['Blue Catfish', 'Channel Catfish', 'Flathead Catfish', 'White Catfish', 'Bullhead'] },
  ] },
  // Same shape: TN writes "Trout (all trout species combined)" and GA just "Trout", and both then
  // name Lake Trout (TN p17) and Kokanee Salmon (NC p33) as rows of their own.
  { label: 'Trout', species: [
    { value: 'Trout',          label: 'Trout',
      covers: ['Rainbow Trout', 'Brown Trout', 'Brook Trout'] },
    { value: 'Lake Trout',     label: 'Lake Trout' },
    { value: 'Kokanee Salmon', label: 'Kokanee Salmon' },
  ] },
  // AMERICAN AND HICKORY SHAD ARE NOT HERE, AND THE BOOKS DO NAME THEM -- SC p50, NC p33 "SHAD
  // (AMERICAN AND HICKORY)", GA p65 "Shad". This codebase already classifies both as FORAGE, in
  // NON_GAME_SPECIES in Worker/research/facts-util.js, so uniqueResearchSpecies() strips them
  // before a roster is written and the filter below could never reveal the box on any water. A
  // checkbox that cannot appear is worse than an honest gap. Ryan struck Hickory Shad by hand the
  // same day; American Shad follows it, and both stay declared in no_home_in_the_form. Making shad
  // a target is a one-line change to NON_GAME_SPECIES, and it is a decision, not an oversight.
  { label: 'Other', species: [
    { value: 'Bowfin', label: 'Bowfin' },
  ] },
];

const SALTWATER_GROUPS = [
  // SC's INSHORE FINFISH page, p50, plus the same fish where NC p43-44 and GA p84 name them.
  { label: 'Inshore', species: [
    { value: 'Red Drum (Redfish)',                label: 'Red Drum', checked: true },
    { value: 'Speckled Trout (Spotted Seatrout)', label: 'Speckled Trout' },
    { value: 'Southern Flounder',                 label: 'Flounder' },
    { value: 'Sheepshead',                        label: 'Sheepshead' },
    { value: 'Black Drum',                        label: 'Black Drum' },
    { value: 'Bluefish',                          label: 'Bluefish' },
    { value: 'Ladyfish',                          label: 'Ladyfish' },
    { value: 'Weakfish (Gray Trout)',             label: 'Weakfish' },
    { value: 'Tripletail',                        label: 'Tripletail' },
    { value: 'Atlantic Croaker',                  label: 'Croaker' },
    { value: 'Spot',                              label: 'Spot' },
    { value: 'Whiting (Southern Kingfish)',       label: 'Whiting' },
    { value: 'Florida Pompano',                   label: 'Pompano' },
  ] },
  { label: 'Nearshore / migratory', species: [
    { value: 'Tarpon',                            label: 'Tarpon' },
    { value: 'Cobia',                             label: 'Cobia' },
    { value: 'Spanish Mackerel',                  label: 'Spanish Mackerel' },
  ] },
  // SC prints these on the INSHORE page too, because they are caught in the rivers and the bays.
  // GA's book carries a "Striped bass (Savannah River)" row that until now resolved to nothing at
  // all -- one of only four phrases in four books that did.
  { label: 'Into the rivers', species: [
    { value: 'Striped Bass', label: 'Striped Bass' },
    { value: 'Hybrid',       label: 'Hybrid',     covers: ['White Bass / Hybrid'] },
    { value: 'White Bass',   label: 'White Bass', covers: ['White Bass / Hybrid'] },
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

/** The app's own species normalisation -- normalizeResearchName() in Worker/research/facts-util.js. */
function normSpecies(s) {
  return String(s || '').toLowerCase().replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

/**
 * The canonical species THIS water is known to hold.
 *
 * `biology.predatorSpecies` is the deterministic roster -- the state ramp record, the agency lake
 * page, NC WRC's species file and the regulations species floor -- and it is folded through
 * canonicalizeResearchSpecies() before it is written, so these are already the app's own names. The
 * trollingIntelligence keys are added on top because a fisheries run can name a fish the roster
 * missed.
 *
 * EMPTY MEANS "NO OPINION", NOT "NO FISH". Most of the 454 waters have never been researched, and a
 * selector that empties itself on one of those is worse than one that shows too much.
 */
function heldByWater(profile) {
  const bio = (profile && profile.biology) || {};
  const roster = Array.isArray(bio.predatorSpecies) ? bio.predatorSpecies : [];
  const ti = (profile && profile.trollingIntelligence) || {};
  const out = new Set();
  for (const n of [...roster, ...Object.keys(ti)]) {
    const k = normSpecies(n);
    if (k && k.length < 40) out.add(k);
  }
  return out;
}

/**
 * The groups to show for a waterbody. Pure — no DOM, no globals — so it can be tested.
 *
 * FILTERED TO WHAT THE WATER HOLDS, once the water has told us. The catalogue is 36 freshwater
 * species and showing all of them on a lake that holds nine is a worse form than the fifteen it
 * replaced. Ryan, 2026-09-02, choosing this over showing everything: "hopefully a research run on
 * those 4 will fix the issue... and only 4 would then show all the fish instead of 64."
 *
 * Three things are never filtered away: a species the angler has already ticked, the default tick,
 * and anything the research names that the catalogue does not carry.
 *
 * @param {string|null} key      the R2 key, e.g. 'wateree_lake' or 'coast_winyah_bay_sc'
 * @param {object|null} profile  the researched profile, or null when there is none
 * @param {string[]}    keep     values currently ticked, which survive the filter
 */
export function speciesGroupsFor(key, profile, keep = []) {
  const all = (isCoastalKey(key) ? SALTWATER_GROUPS : FRESHWATER_GROUPS)
    .map((g) => ({ label: g.label, species: g.species.map((s) => ({ ...s })) }));

  const held = heldByWater(profile);
  const ticked = new Set(Array.isArray(keep) ? keep.map(String) : []);
  let groups = all;
  if (held.size) {
    const wanted = (s) => s.checked || ticked.has(s.value)
      || held.has(normSpecies(s.value))
      || (s.covers || []).some((c) => held.has(normSpecies(c)));
    groups = all
      .map((g) => ({ label: g.label, species: g.species.filter(wanted) }))
      .filter((g) => g.species.length);
  }

  // Measured against the WHOLE catalogue, not the filtered view -- otherwise a species the filter
  // just removed reappears below it as though the research had discovered something new.
  const extras = researchedExtras(profile, all);
  if (extras.length) groups.push({ label: 'Named by this lake’s research', species: extras });
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

  // The lake's own species, from the research tab's cache if it is open, else from R2 below.
  let profile = null;
  try { profile = window.getResearchedProfile?.(lakeName) || null; }
  catch (e) { console.warn('[species-selector] researched cache threw', e.message); }
  if (!profile && lakeName) profile = _profileByLake.get(lakeName) || null;
  if (!profile && lakeName && !_profileByLake.has(lakeName)) {
    _profileByLake.set(lakeName, null);
    import('./smart-plan-v2-wiring.js')
      .then((m) => m.loadResearchedProfile(lakeName))
      .then((p) => {
        if (!p || !p.biology) return;
        _profileByLake.set(lakeName, p);
        refreshSpeciesChecks();
      })
      .catch((e) => console.warn('[species-selector] roster load failed', e.message));
  }

  // The ticks travel through the filter: a species the angler asked for is never hidden by it.
  const groups = speciesGroupsFor(key, profile, [...previouslyChecked]);
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
