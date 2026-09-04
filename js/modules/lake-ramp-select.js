/**
 * Worker-backed Lake / Access dropdowns in the map toolbar.
 *
 * Populates #lakeSelect and #rampSelect from the shared access-index module
 * (data/access-index.js), which pulls from the Cloudflare Worker access-data
 * routes instead of the legacy hard-coded LAKE_DB / TRISTATE_MASTER_RAMPS
 * files.
 *
 * REFACTORED 2026-07-03: the worker-fetch/build/dedupe logic that used to
 * live in this file was pulled out into data/access-index.js so that
 * catch-journal.js's nearest-lake lookup could share the same live index
 * instead of the worker being queried twice.
 */

import { state } from '../core/state.js';
import { loadAccessIndex, registryRecordFor, liveAccessFor } from '../data/access-index.js';
import { loadContourForLake } from './contour-data.js';
import { COASTAL_ZONES, isCoastalKey } from '../data/coastal-zones.js';
import { landOnCoastalZone, focusRamp } from '../utils/viewport-cull.js';
import { coastalNamesByState } from '../data/coastal-zones.js';
import { resolveR2Key } from '../data/lake-keys.js';
import { waterZoneCandidates } from '../data/water-aliases.js';
import { registryStats } from '../data/lake-registry.js';
import { makePredicate } from '../data/water-filter.js';

/**
 * THE BASELINE GATE, ON TOP OF THE BOXES HE TICKS.
 *
 * Ryan: "i dont think we need to display all of those lakes in any of the bars if they have no
 * bathymetry at all... and this needs to apply to waters that we get from dnr and not the registry
 * as well." The filter controls below are what he ASKS for; this is what the bar never shows in
 * the first place. Water with a measured zero for bathymetry, and DNR names the registry cannot
 * identify at all, do not belong in a picker whose whole job is choosing water to fish.
 *
 * KEEP_ALWAYS runs inside the predicate and first, so nothing he fishes can be dropped here.
 */
const mapGate = makePredicate('map', null);

// ── Filter state ─────────────────────────────────────────────────────────
//
// The registry contributes hundreds of lakes the DNR feeds never listed, and a flat
// alphabetical <select> of that size is unusable — you cannot scroll to a 40-acre pond you
// half remember the name of. These filters run over the ALREADY-BUILT index rather than
// re-querying, so toggling is instant.
//
// Defaults are deliberately conservative: everything on, nothing hidden, so the first load
// after this ships looks like a superset of what was there before rather than a surprise.
const filters = {
  state: '',        // '' = all
  size: '',         // '' | 'small' (<200 ac) | 'mid' (200-1000) | 'big' (>1000)
  rampOnly: false,
  wellCharted: false,
};

const SIZE_BANDS = {
  small: [0, 200],
  mid: [200, 1000],
  big: [1000, Infinity],
};

// SC first because that is where Ryan fishes, then the rest of the coverage area in his order.
export const STATE_ORDER = ['SC', 'NC', 'GA', 'TN'];
// Lakes, rivers, coast — within each state. Ryan, 2026-08-08: "i want lakes then rivers then
// coastal for each state... i actually don't like how it is now."
export const TYPE_ORDER = [['lake', 'Lakes'], ['river', 'Rivers'], ['coastal', 'Coast']];

const RIVERISH = /\b(river|creek|branch|run|fork|canal|slough|bayou|prong|swamp)\b/i;

/** SC / NC / GA / TN for any picker entry, registry-backed or not. */
/**
 * What a row READS as, once the heading has said everything it already says.
 *
 * The group is "SC — Coast", so "Winyah Bay / Georgetown, SC (Georgetown Co, SC)" says SC three
 * times. This used to strip only a trailing ", SC", which the county parenthetical defeats --
 * so registry rows kept their county while DNR rows did not, and the same group held two shapes.
 *
 * ONLY THE PARENTHETICAL CARRYING "Co" IS REMOVED, and that is the whole trick. Four Saluda
 * Rivers are told apart by "(2)" and "(Lower Saluda)", the two Lake Robinsons by "(Greer)", and
 * a Cane Creek Lake by "(Union County)" -- none of which is a county abbreviation, and all of
 * which survive. Checked across the whole index: exactly one pair would render identically
 * inside one state group, and it is the Robinson pair that lake_display_names.json renames.
 *
 * This is display only. `opt.value` stays the full name, because that is the key every other
 * module looks the water up by.
 */
export function pickerLabel(name) {
  return String(name || '')
    .replace(/\s*\([^)]*\bCo\b[^)]*\)\s*/i, ' ')
    .replace(/,\s*[A-Z]{2}(?:\/[A-Z]{2})*\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * THE ORDER OF A GROUP IS THE ORDER OF WHAT IT SAYS, NOT THE ORDER IT WAS COLLECTED IN.
 *
 * Ryan, 2026-09-04, on Richard B Russell: "its at the bottom of the SC list not alphabetically
 * where it should have been."
 *
 * The buckets were rendered in PUSH order and never sorted. That was invisible for every water
 * whose name agrees with its registry about which state it is in, and it is exactly wrong for the
 * ones that do not:
 *
 *   access-index.js sorts `lakeNames` with lakeStatePriority(), which reads the state off the
 *   NAME's suffix -- so "Lake Richard Russell, GA" sits in the GA run, after every SC name.
 *
 *   buildLakeSelect() buckets with stateOf(name, rec), which reads the state off the REGISTRY
 *   RECORD -- and richard_b_russell_lake is "Richard B Russell Lake (Abbeville Co, SC/GA)", so
 *   the row lands in SC.
 *
 * Sorted by one notion of state, grouped by another. The row is placed in the right group and
 * arrives after everything already in it: bottom of "SC — Lakes", under a label reading "Lake
 * Richard Russell", which is neither where it belongs nor anywhere a person would look.
 *
 * Sorted on pickerLabel() and not on the raw name, because the label is the string on screen and
 * a list whose visible order does not match its visible text is the same bug wearing a different
 * hat. The raw name breaks ties so the order is stable when two waters read alike.
 *
 * Fixes the class, not the lake: any water whose registry state and name suffix disagree had this,
 * and eleven rows in lake_index carry a two-state suffix.
 */
export function sortForDisplay(names) {
  return [...(names || [])].sort((a, b) =>
    pickerLabel(a).localeCompare(pickerLabel(b), undefined, { numeric: true, sensitivity: 'base' })
    || String(a).localeCompare(String(b)));
}

export function stateOf(lakeName, rec) {
  if (rec?.state) return rec.state;
  // Every DNR name gets a ", SC" suffix from displayLakeName(), and coastal zone names carry
  // one too. That is the only state signal a registry-less entry has, and it is reliable
  // because the feeds are fetched per state.
  const m = /,\s*([A-Z]{2})\s*$/.exec(String(lakeName || ''));
  return m ? m[1] : null;
}

/**
 * lake / river / coastal.
 *
 * `feature_type` is authoritative and comes from the registry — 1,471 lakes, 229 rivers, 22
 * coastal across the index. For an entry with no registry row there is nothing to read, so the
 * NAME is used, and only to decide which heading it sits under. It is a display grouping, not a
 * claim about the water: putting Enoree River under "Lakes / Reservoirs" is the thing being
 * fixed, and guessing from the word "River" is strictly better than that.
 */
export function typeOf(lakeName, rec) {
  if (isCoastalKey(resolveR2Key(lakeName))) return 'coastal';
  if (rec?.featureType) return rec.featureType;
  return RIVERISH.test(String(lakeName || '')) ? 'river' : 'lake';
}

/**
 * True if a picker entry survives the current filters.
 *
 * AN ENTRY THE FILTER CANNOT ANSWER FOR NOW FAILS THAT FILTER. It used to pass everything:
 * `if (!rec) return true`. Ryan, 2026-08-08: "if i choose >1000 acres i still get tiny little
 * mill ponds that do not have contours because they are only being fed by DNR list." Adams Grist
 * Mill Lake, Biggin Creek, Buggy Branch and Horseshoe Creek have no registry row at all, so
 * nothing knows their size — and they were showing under "over 1000 acres" regardless.
 *
 * State and has-ramp ARE answerable without a registry row: the state comes off the name suffix
 * and the ramps are counted from the live access index, which is the same data the Access
 * dropdown under it is built from. Only size and charted are unanswerable, and those are exactly
 * the two that now exclude.
 *
 * This is the second attempt at this bug — see the pass-1 note in access-index.js, which fixed
 * the 641 lakes that HAD a registry row the lookup could not find. What is left after that fix
 * is the genuinely registry-less, and this is what to do about them.
 */
export function passesFilters(lakeName, f = filters) {
  const rec = registryRecordFor(lakeName);

  // The baseline gate runs before anything he ticked — see mapGate above. Coastal zones are
  // appended separately after this loop and never reach here, so they cannot be lost to it.
  if (!mapGate(rec, lakeName)) return false;

  if (f.state && stateOf(lakeName, rec) !== f.state) return false;

  if (!rec) {
    // Nothing knows its acreage or its soundings. Asking for either means asking for something
    // this entry cannot demonstrate.
    if (f.size || f.wellCharted) return false;
    if (f.rampOnly) return liveAccessFor(lakeName).ramps > 0;
    return true;
  }

  if (f.size) {
    const [lo, hi] = SIZE_BANDS[f.size] || [0, Infinity];
    if (!(rec.areaAcres >= lo && rec.areaAcres < hi)) return false;
  }
  // SAME SOURCE AS THE BADGE FIFTEEN LINES BELOW, WHICH IT USED TO CONTRADICT.
  //
  // This read `rec.rampSources` alone — the count baked into lake_access.json on 2026-08-02 —
  // while lakeBadge() right underneath already counted the live index. So ticking "has a ramp"
  // hid 67 waters whose badge, in the same dropdown, said how many ramps they had. Every one of
  // the rivers Ryan asked about was among them: Broad 4, Santee 4, Congaree 3, Wateree 3.
  //
  // rampSources stays as the OR, not as the AND: 63 rows carry a Garmin- or OSM-charted ramp
  // that no state agency feed lists, and losing those would trade one wrong answer for another.
  if (f.rampOnly && !(liveAccessFor(lakeName).ramps || rec.rampSources)) return false;
  // The picker already defaults to shipped lakes, so this box narrows further: only lakes
  // whose soundings cover most of their surface. Median charted fraction across the 434 is
  // 0.59, so a 0.5 cut is roughly the better half.
  if (f.wellCharted && !(rec.charted >= 0.5)) return false;
  return true;
}

/** Short suffix telling you what is known about a lake before you select it. */
function lakeBadge(lakeName) {
  const rec = registryRecordFor(lakeName);

  // Count what the picker ACTUALLY holds for this name, not what the offline access index
  // recorded months ago.
  //
  // `rec.rampSources` comes from lake_access.json, baked at index-build time. Every waterbody
  // whose boundary was cut after that file was last rebuilt has `ramp_sources: 0` -- which is
  // true about the file and false about the world. Congaree River read "no ramp listed" while
  // the Access dropdown directly beneath it listed five, because the SC DNR feed names three
  // ramps on it and /paddle adds more. A badge that contradicts the list under it is worse
  // than no badge: Ryan's rule is that access is a DISPLAYED ATTRIBUTE, and a displayed
  // attribute has to be true.
  //
  // The live index is authoritative because it is the same data the Access dropdown is built
  // from. rampSources stays as the fallback for a lake the feeds do not mention at all.
  //
  // Counted through liveAccessFor() rather than here, so this badge and the has-ramp filter
  // above it and the planner's predicate all get their number from ONE place. This was the
  // only surface reading the live index, and it was reading it with its own inline regex.
  const { points, ramps } = liveAccessFor(lakeName);

  if (!rec && !points) return '';
  const bits = [];
  if (rec?.areaAcres) bits.push(`${Math.round(rec.areaAcres)} ac`);
  if (ramps) bits.push(ramps === 1 ? '1 ramp' : `${ramps} ramps`);
  else if (points) bits.push(points === 1 ? '1 access pt' : `${points} access pts`);
  else if (rec?.rampSources) bits.push(rec.rampSources > 1 ? `${rec.rampSources} ramp srcs` : 'ramp');
  else bits.push('no ramp listed');
  // Say WHICH credential opened it. "Open With Credential" on its own reads like a
  // formality; "Fort Bragg" tells you to bring your ID and check in.
  if (rec?.accessForMe === 'Open With Credential') bits.push(`ID: ${rec.accessVia || 'credential'}`);
  else if (rec?.accessForMe && rec.accessForMe !== 'Open Access') bits.push(rec.accessForMe);
  if (rec?.charted != null && rec.charted > 0) bits.push(`${Math.round(rec.charted * 100)}% charted`);
  return bits.length ? `  — ${bits.join(', ')}` : '';
}

// ── Populate lake dropdown ───────────────────────────────────────────────

async function populateLakeSelect() {
  const lakeSelect = document.getElementById('lakeSelect');
  if (!lakeSelect) return;

  const currentValue = lakeSelect.value;
  const idx = await loadAccessIndex();

  // Preserve the first placeholder option if one already exists, then rebuild
  // the dynamic options so repeated calls cannot append duplicates.
  const placeholder = lakeSelect.querySelector('option[value=""]')?.outerHTML || '<option value="">-- Select lake / waterbody --</option>';
  lakeSelect.innerHTML = placeholder;

  // ── Twelve groups: SC, NC, GA, TN — Lakes, Rivers, Coast within each ──────────────────
  //
  // Was ONE group headed "Lakes / Reservoirs (483)" holding every inland name, plus three
  // coastal groups appended after it. That heading was wrong about its own contents: Catawba
  // River, Congaree River, Edisto River, Great Pee Dee River and Fishing Creek Reservoir are all
  // `feature_type: 'river'` and all sat under it.
  //
  // Coastal zones are folded in here rather than appended by coastal-optgroups.js, because they
  // belong under their state alongside its lakes and rivers. That util still serves the research
  // dropdown, which has not been reworked.
  const buckets = new Map();          // `${state}|${type}` -> string[]
  const put = (state, type, name) => {
    if (!state) return;
    const k = `${state}|${type}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(name);
  };

  const emittedCoastal = new Set();
  idx.lakeNames.forEach((lakeName) => {
    if (!passesFilters(lakeName)) return;
    const rec = registryRecordFor(lakeName);
    const slug = rec?.slug || resolveR2Key(lakeName);
    if (slug && isCoastalKey(slug)) emittedCoastal.add(slug);
    put(stateOf(lakeName, rec), typeOf(lakeName, rec), lakeName);
  });

  // ── COASTAL ZONES, ONCE EACH ────────────────────────────────────────────────────────────
  //
  // The comment that stood here said "coastal zones are not in the access index — the worker
  // only covers inland DNR ramps". That was true when it was written and has not been true for
  // a while: `lake_index.json` carries all 16 `coast_` rows, so the registry merge puts every
  // one of them into `byLake`, and COASTAL_MANUAL_RAMPS adds zone names there directly too.
  //
  // So this loop was adding a SECOND row for every zone, under a different spelling of the same
  // water. Ryan, 2026-08-23: *"A whole bunch of coastal areas are in the picker twice but they
  // all seem to have bathymetry"* -- both rows resolve, because both are the same zone.
  //
  //   registry:      "Winyah Bay / Georgetown, SC (Georgetown Co, SC)"
  //   COASTAL_ZONES: "Winyah Bay / Georgetown, SC"
  //
  // Murrells Inlet and St. Helena Sound have no county in their registry name, so those two
  // were being added twice under a string identical to itself. Matching on the SLUG catches
  // both shapes; matching on the name would have caught only one.
  //
  // The loop stays, because a zone the registry has not shipped still has to be reachable --
  // the tide, oyster and marsh layers hang off it.
  const zoneSlugByName = new Map();
  for (const [slug, z] of Object.entries(COASTAL_ZONES || {})) {
    if (z && z.name) zoneSlugByName.set(z.name, slug);
  }
  const coastal = coastalNamesByState();
  for (const [stateCode, names] of Object.entries(coastal || {})) {
    for (const name of (names || [])) {
      // A zone has no acreage and no registry row, so it answers the same filters a DNR-fed
      // name does — and must not vanish just because the state box is set to its own state.
      if (filters.state && filters.state !== stateCode) continue;
      if (filters.size || filters.wellCharted) continue;
      const slug = zoneSlugByName.get(name);
      if (slug && emittedCoastal.has(slug)) continue;   // already offered under its registry name
      put(stateCode, 'coastal', name);
    }
  }

  let total = 0;
  for (const stateCode of STATE_ORDER) {
    for (const [type, typeLabel] of TYPE_ORDER) {
      const names = buckets.get(`${stateCode}|${type}`);
      if (!names?.length) continue;
      const grp = document.createElement('optgroup');
      grp.label = `${stateCode} — ${typeLabel} (${names.length})`;
      for (const name of sortForDisplay(names)) {
        const opt = document.createElement('option');
        opt.value = name;
        // The group heading already says the state and the county, so both are noise on the row.
        opt.textContent = pickerLabel(name) + lakeBadge(name);
        grp.appendChild(opt);
      }
      lakeSelect.appendChild(grp);
      total += names.length;
    }
  }

  // Anything the state suffix could not place. Better visible under a plain heading than
  // silently dropped -- a name that vanishes from the picker reads as lost data.
  const orphans = [];
  for (const [k, names] of buckets) if (!STATE_ORDER.includes(k.split('|')[0])) orphans.push(...names);
  if (orphans.length) {
    const grp = document.createElement('optgroup');
    grp.label = `Other (${orphans.length})`;
    for (const name of sortForDisplay(orphans)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name + lakeBadge(name);
      grp.appendChild(opt);
    }
    lakeSelect.appendChild(grp);
  }

  if (currentValue && (idx.byLake.has(currentValue) || isCoastalKey(resolveR2Key(currentValue)))) {
    lakeSelect.value = currentValue;
  }
}

// ── Lake change handler ──────────────────────────────────────────────────

function formatAccessLabel(item) {
  const prefix = item.marker ? `${item.marker} ` : '';
  return `${prefix}${item.name}${item.typeLabel ? ` — ${item.typeLabel}` : ''}`;
}

/**
 * Narrow a coastal key using the waterbody's own landings.
 *
 * Eight DNR names span more than one zone. water-aliases.js can only offer a default -- the
 * zone with the most landings -- and for the Wando, which has one ramp in Cape Romain and one
 * in Charleston, that default is decided alphabetically. The Intracoastal Waterway has
 * landings in eight zones and no default is meaningful at all.
 *
 * The access points for the selected name settle it: count how many fall inside each candidate
 * zone's bbox and take the winner. Ties keep the incoming key so the answer stays stable.
 */
function refineCoastalKey(name, key, accessPoints) {
  if (!isCoastalKey(key) || !accessPoints?.length) return key;
  const cands = waterZoneCandidates(name).filter(isCoastalKey);
  if (cands.length < 2) return key;

  let best = key;
  let bestHits = -1;
  for (const slug of cands) {
    const bbox = COASTAL_ZONES[slug]?.bbox;
    if (!bbox) continue;
    const [[south, west], [north, east]] = bbox;
    let hits = 0;
    for (const p of accessPoints) {
      if (p.lat >= south && p.lat <= north && p.lon >= west && p.lon <= east) hits += 1;
    }
    if (hits > bestHits) { bestHits = hits; best = slug; }
  }
  return bestHits > 0 ? best : key;
}

async function onLakeChange(selLakeName) {
  const rampSel = document.getElementById('rampSelect');
  if (rampSel) rampSel.innerHTML = '<option value="">-- Access Points Index --</option>';

  if (!selLakeName) {
    if (rampSel) rampSel.disabled = true;
    return;
  }

  const idx = await loadAccessIndex();
  let accessPoints = idx.byLake.get(selLakeName) || [];

  // Which zone, when the name spans several. Eight DNR names do: there are three North
  // Rivers, two Wando Rivers, and an Intracoastal Waterway with landings in eight zones.
  // water-aliases.js can only offer a default (the zone with the most landings), and for the
  // Wando that default is a coin toss between Cape Romain and Charleston.
  //
  // Here we can do better than a default, because the ramps for THIS name have just been
  // looked up: whichever zone contains most of them is the one being asked about. No new data
  // and no guessing — the landings say where the water is.
  const coastalKey = refineCoastalKey(selLakeName, resolveR2Key(selLakeName), accessPoints);
  const zone = isCoastalKey(coastalKey) ? COASTAL_ZONES[coastalKey] : null;

  // Coastal ramps are pulled from the fish & wildlife API via the worker access index.
  // We fall back to the hardcoded ones if the API results are empty.
  if (zone && accessPoints.length === 0) {
    accessPoints = Object.entries(zone.ramps || {}).map(([name, c]) => ({
      name, lat: c[0], lon: c[1], typeLabel: 'Coastal ramp', marker: '⛵',
      sourcePath: 'coastal-zones', sourceState: zone.state,
    }));
  }

  // Fly the map to the zone bbox when the ZONE itself was selected — a sound is far larger
  // than its handful of ramps. But 158 DNR waterbody names now resolve to a zone as well, and
  // for those the zone box is the wrong frame: picking "Shem Creek" and being shown the whole
  // of Charleston Harbour is not an answer to the question. Those get their own landings,
  // which is exactly where the creek is.
  // FRAME THE WATER, NOT THE LAUNCHES — 2026-08-22.
  //
  // This used to fit the ACCESS POINTS and fall back to the registry bounds only when a lake
  // had none. That is backwards, and it produced two separate complaints on the same day:
  //
  //   ONE ramp   -> setView(ramp, 15). Ferry Lake's only landing is "Lenuds (US17 Bridge)",
  //                 201 m outside its bounds and on the SANTEE. Selecting Ferry Lake put you
  //                 on the river. Ryan: "ferry lake actually zooms to the santee river".
  //   TWO+ ramps -> fitBounds(coords). The five-bucket merge keeps the same physical launch
  //                 once per feed, so 57 lakes have every ramp inside 60 m of each other and
  //                 14 have them at IDENTICAL coordinates. A zero-area box makes Leaflet
  //                 clamp to `maxZoom`, which map-init.js sets to 22. broad_river_3 is 1,629
  //                 acres and mayo_reservoir 2,573, both framed at zoom 22 on load.
  //
  // The right code was already in this file, on the branch that almost never ran. It moves
  // first. A ramp that falls outside the frame is not a bug to hide: Ferry Lake's really is on
  // the Santee, and the nearest published launch to Bates Old River is 1,379 m away on the
  // Congaree. The marker stays on the map; the map just stops chasing it.
  const zoneItself = zone && zone.name === selLakeName;
  const rec = registryRecordFor(selLakeName);
  const b = rec && rec.boundsWSEN;
  const haveBounds = Array.isArray(b) && b.length === 4
    && b.every((v) => typeof v === 'number' && isFinite(v))
    && b[2] > b[0] && b[3] > b[1];

  if (state.MAP_OK && zone && (zoneItself || !accessPoints.length)) {
    landOnCoastalZone(state.MAP, zone);
  } else if (state.MAP_OK && haveBounds) {
    // The registry bounds are the water. 401 of 401 index rows carry a usable box — checked
    // 2026-08-22: none null, none inverted, none under 40 m on a side.
    state.MAP.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [40, 40] });
  } else if (state.MAP_OK && accessPoints.length) {
    // No registry box: a DNR waterbody name 3DHP never matched, or a coastal name. The ramps
    // are all there is. `maxZoom` is NOT an invented number — it is the 15 the single-ramp
    // branch below has always used, so one launch and two launches at the same spot now frame
    // the same way instead of differing by seven zoom levels.
    const coords = accessPoints.map((p) => [p.lat, p.lon]);
    if (coords.length === 1) {
      state.MAP.setView(coords[0], 15);
    } else {
      state.MAP.fitBounds(coords, { padding: [40, 40], maxZoom: 15 });
    }
  } else if (state.MAP_OK && rec) {
    // Neither a box nor a launch. 141 of the 322 accessible lakes have no mapped launch at
    // all; without this the map sits wherever it was and selecting the lake looks broken.
    state.MAP.setView([rec.lat, rec.lon], 14);
  }

  // Sync planLake if not already set
  const planLakeEl = document.getElementById('planLake');
  if (planLakeEl && !planLakeEl.value) {
    planLakeEl.value = selLakeName;
    planLakeEl.dispatchEvent(new Event('change'));
  }

// Load contours for this lake
  loadContourForLake(selLakeName);
  window.loadSupplementalForLake?.(selLakeName);

  // Populate access dropdown
  if (!rampSel) return;
  rampSel.disabled = false;
  if (accessPoints.length) {
    accessPoints.forEach((point) => {
      const opt = document.createElement('option');
      opt.value = point.name;
      opt.textContent = formatAccessLabel(point);
      opt.dataset.coords = `${point.lat},${point.lon}`;
      opt.dataset.type = point.typeLabel || '';
      opt.dataset.source = point.sourcePath || '';
      opt.dataset.state = point.sourceState || '';
      rampSel.appendChild(opt);
    });
  } else {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— no worker access points found —';
    rampSel.appendChild(opt);
  }
}
// ── Ramp / access change handler ─────────────────────────────────────────

function onRampChange(selOpt) {
  if (!selOpt.value || !selOpt.dataset.coords || !state.MAP_OK) return;
  const [lat, lon] = selOpt.dataset.coords.split(',').map(Number);
  focusRamp(state.MAP, lat, lon);
  const planRampEl = document.getElementById('planRamp');
  if (planRampEl) planRampEl.value = selOpt.value;
}

// ── Filter bar ───────────────────────────────────────────────────────────
//
// Injected next to #lakeSelect rather than added to index.html, for the same reason
// injectGarminPanel() builds itself: the toolbar markup is shared and a hand-edited control
// here would have to be kept in sync by hand forever. If #lakeSelect has no parent the bar
// is simply skipped and the dropdown behaves as it always did.

const BAR_ID = 'lakeFilterBar';

function buildFilterBar() {
  const lakeSelect = document.getElementById('lakeSelect');
  if (!lakeSelect || document.getElementById(BAR_ID)) return;
  const host = lakeSelect.parentElement;
  if (!host) return;

  const bar = document.createElement('div');
  bar.id = BAR_ID;
  bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;'
                    + 'margin:4px 0 6px 0;font-size:12px;line-height:1.6;';

  const sel = (id, label, opts) => {
    const s = document.createElement('select');
    s.id = id;
    s.title = label;
    s.style.cssText = 'font-size:12px;padding:1px 4px;';
    for (const [v, t] of opts) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      s.appendChild(o);
    }
    return s;
  };

  const stateSel = sel('lakeFilterState', 'State', [
    ['', 'All states'], ['SC', 'SC'], ['NC', 'NC'], ['GA', 'GA'], ['TN', 'TN'],
  ]);
  const sizeSel = sel('lakeFilterSize', 'Size', [
    ['', 'Any size'], ['small', '< 200 ac'], ['mid', '200–1000 ac'], ['big', '> 1000 ac'],
  ]);

  const check = (id, label, title) => {
    const w = document.createElement('label');
    w.style.cssText = 'display:inline-flex;align-items:center;gap:3px;cursor:pointer;';
    w.title = title;
    const c = document.createElement('input');
    c.type = 'checkbox'; c.id = id;
    w.appendChild(c);
    w.appendChild(document.createTextNode(label));
    return w;
  };

  const rampWrap = check('lakeFilterRamp', 'has ramp',
    'Only lakes with a launch in at least one source. Absence is not evidence — Wee Tee has '
    + 'a ramp Ryan has used that OSM and Garmin both miss.');
  const chartWrap = check('lakeFilterCharted', 'well charted',
    'Only lakes whose soundings cover at least half their surface. The list already shows '
    + 'only lakes that have contours at all.');

  const count = document.createElement('span');
  count.id = 'lakeFilterCount';
  count.style.cssText = 'opacity:.7;margin-left:auto;';

  bar.append(stateSel, sizeSel, rampWrap, chartWrap, count);
  host.insertBefore(bar, lakeSelect);

  const refresh = () => {
    filters.state = stateSel.value;
    filters.size = sizeSel.value;
    filters.rampOnly = document.getElementById('lakeFilterRamp').checked;
    filters.wellCharted = document.getElementById('lakeFilterCharted').checked;
    populateLakeSelect().catch((e) => console.error('[lake-ramp-select] refilter failed:', e));
  };
  stateSel.addEventListener('change', refresh);
  sizeSel.addEventListener('change', refresh);
  bar.querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', refresh));

  loadAccessIndex().then(() => {
    const s = registryStats();
    if (!s.total) {
      // No registry loaded. The filters would silently do NOTHING -- passesFilters() lets
      // every lake through when it has no registry record, which is correct (it protects the
      // DNR lakes) but reads as broken checkboxes. Say so instead of leaving the user to
      // discover it by ticking a box and watching the list not change.
      count.textContent = 'registry not loaded — filters unavailable';
      count.title = 'lake_index.json did not load; check the browser console. The lake list '
                  + 'is running on the DNR feeds alone, exactly as it did before.';
      bar.querySelectorAll('input,select').forEach((el) => {
        if (el === stateSel) return;           // state still works on the DNR names
        el.disabled = true;
        el.title = 'needs lake_index.json';
      });
      stateSel.disabled = true;
      return;
    }
    count.textContent = `${s.shipped} charted of ${s.total}`;
    count.title = `Registry: ${s.total} lakes, ${s.shipped} with Garmin soundings and a `
                + `chartpack, ${s.open} open to the public, ${s.ramps} with a mapped ramp.`;
  }).catch(() => {});
}

// ── Wire everything ──────────────────────────────────────────────────────

function wire() {
  buildFilterBar();
  populateLakeSelect().catch((err) => {
    console.error('[lake-ramp-select] Failed to populate worker-backed lake list:', err);
  });

  document.getElementById('lakeSelect')?.addEventListener('change', (e) => {
    onLakeChange(e.target.value).catch((err) => {
      console.error('[lake-ramp-select] Failed to populate access points:', err);
    });
  });

  document.getElementById('rampSelect')?.addEventListener('change', function () {
    onRampChange(this.options[this.selectedIndex]);
  });
}

wire();
