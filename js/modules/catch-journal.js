/**
 * catch-journal.js — TrollMap Catch Center
 *
 * Drop-in replacement for js/modules/catch-journal.js.
 * Adds:
 *   - CSV import into a human review queue
 *   - support for old v2 recovered CSVs and newer v3 sorter CSVs
 *   - large local photo preview via local helper server
 *   - verified species/length fields before approving to journal
 *   - export of cleaned candidates CSV
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { getLoadedRegistry, lakeRecordFor, workerBase } from '../data/lake-registry.js';
import { describeCatchDepth, ON_CONTOUR_MI } from '../utils/catch-depth.js';
import { loadAccessIndex, nearestLakeByAccessPoint } from '../data/access-index.js';
import { TACKLE_INVENTORY } from '../data/tackle-inventory.js';
import { get as dbGet, tryPut } from '../utils/db.js';

import { callGlobal } from '../utils/call-global.js';
import { solunarFor } from '../utils/solunar.js';
import { parseGPX } from '../utils/parsers.js';
import { distMiFromCoords } from '../utils/geo.js';
import { groupPhotosByWaypoint, fishAtMark, waypointReadings, localIso, fmtGap } from '../utils/catch-waypoints.js';
import { marksToAsk, markRecord, saveMark, loadMarks, MARK_LABELS } from './garmin-marks.js';
import { claudeBridgeStatus, claudeLook } from './claude-bridge.js';
import { SORT_PX, MEASURE_PX, jsonOf, sortPrompt, photoLabel, boardsOf, measurePrompt, aiFromMeasure } from '../utils/claude-fish-id.js';
import { flattenJournal } from '../utils/journal-merge.js';
import { catchWaters, catchesGpx } from '../utils/catch-gpx.js';
import { pinOffItsWater } from '../utils/catch-pins.js';
const DEFAULT_HELPER = 'http://127.0.0.1:8787';
const QUEUE_DB_KEY = 'catch_import_queue';
const CATCHES_DB_KEY = 'catches';

function getCatches() { return state.CATCHES || (state.CATCHES = []); }
function setCatches(arr) { state.CATCHES = arr || []; }
function getQueue() { return state.CATCH_IMPORT_QUEUE || (state.CATCH_IMPORT_QUEUE = []); }
function setQueue(arr) { state.CATCH_IMPORT_QUEUE = arr || []; }

let selectedQueueId = null;
let currentSubtab = 'review';
// WHAT THE LAST CSV IMPORT DID WITH ITS ROWS. Ryan, 2026-10-03, importing the catch history rebuilt
// the night before (catches_approved_2026-10-03.csv): "when it goes to the review queue it says
// there to import a csv first". Every one of its 157 rows says review_status=imported, so the import
// sends them straight to the Journal -- by design -- and then it switched to the Review Queue anyway,
// which was empty and told him to import a CSV. The status line that said where they went was on the
// Import tab, out of sight. So the summary is kept, the import opens the tab its rows went to, and
// an empty queue says what the last import did instead of asking for one.
let lastCsvImport = null;
// THE LAST DROP'S MARKS STILL TO LABEL, AND ITS STATUS LINE, kept here because the drop ends by
// re-rendering the Import tab -- which rebuilt the status line empty, so the "Added N catches"
// line vanished as it was written. Item 40, 2026-10-02.
let pendingMarks = [];
let nightlyNote = '';
const localPhotoUrls = new Map(); // filename(lower) -> object URL from folder picker
const localPhotoFiles = new Map();

const SPECIES = [
  '', 'Striped Bass', 'White Bass / Hybrid', 'Largemouth Bass', 'Spotted Bass', 'Smallmouth Bass',
  'Crappie', 'Black Crappie', 'White Crappie', 'Catfish', 'Blue Catfish', 'Channel Catfish', 'Flathead Catfish',
  'Bowfin', 'Chain Pickerel', 'Bluegill', 'Sunfish (Panfish)', 'Redear Sunfish (Shellcracker)',
  'Yellow Perch', 'Gar', 'Longnose Gar', 'Red Drum (Redfish)', 'Speckled Trout (Spotted Seatrout)',
  'Flounder', 'American Shad', 'Other Fish', 'Not Fish'
];

function parseBool(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'y'].includes(s);
}
function cleanSpecies(s) {
  s = String(s || '').trim();
  const map = {
    'White Bass/Hybrid': 'White Bass / Hybrid',
    'Hybrid': 'White Bass / Hybrid',
    'Striper': 'Striped Bass',
    'Black Bass': 'Largemouth Bass',
    'Bowfin (Mudfish)': 'Bowfin',
    'Mudfish': 'Bowfin',
    'Bowfin Mudfish': 'Bowfin',
    'Black Crappie': 'Crappie',
    'White Crappie': 'Crappie',
    'Red Drum (Redfish)': 'Red Drum (Redfish)',
    'Speckled Trout (Spotted Seatrout)': 'Speckled Trout (Spotted Seatrout)',
    'Sunfish': 'Sunfish (Panfish)',
    // FIX (2026-07-03): Shad was dropped from SPECIES at some point — 2
    // existing catches logged under the plain 'Shad' string were left
    // orphaned. Restored as 'American Shad' to match SCDNR's own
    // terminology; this mapping normalizes any pre-existing rows.
    'Shad': 'American Shad',
    'No Fish': 'Not Fish',
    'None': ''
  };
  return map[s] || s;
}
function inferSpeciesFromNotes(species, notes) {
  const raw = cleanSpecies(species);
  if (raw && !['other fish', 'unknown', 'not fish', 'no fish'].includes(raw.toLowerCase())) {
    return { species: raw, flag: '' };
  }
  const n = String(notes || '').toLowerCase();
  const patterns = [
    ['Striped Bass', /\b(striped bass|striper)\b/],
    ['Largemouth Bass', /\b(largemouth|large mouth|black bass)\b/],
    ['Smallmouth Bass', /\bsmallmouth\b/],
    ['Spotted Bass', /\bspotted bass\b/],
    ['Crappie', /\b(crappie|black crappie|white crappie)\b/],
    ['Catfish', /\b(catfish|blue cat|channel cat|flathead|barbels)\b/],
    ['Bowfin', /\b(bowfin|mudfish)\b/],
    ['Chain Pickerel', /\b(chain pickerel|pickerel)\b/],
    ['Bluegill', /\bbluegill\b/],
    ['Sunfish (Panfish)', /\b(sunfish|panfish|shellcracker|redear|redbreast)\b/],
    ['Gar', /\bgar\b/],
    ['Yellow Perch', /\byellow perch\b/],
    ['White Bass / Hybrid', /\b(white bass|hybrid)\b/],
    ['Red Drum (Redfish)', /\b(redfish|red drum)\b/],
    ['Speckled Trout (Spotted Seatrout)', /\b(speckled trout|spotted seatrout)\b/],
    ['Flounder', /\bflounder\b/]
  ];
  for (const [sp, re] of patterns) if (re.test(n)) return { species: sp, flag: 'inferred_from_notes' };
  return { species: raw, flag: '' };
}
function stableId(obj) {
  const key = [obj.sha256, obj.filename, obj.datetime, obj.sourcePath].filter(Boolean).join('|');
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'cq_' + (h >>> 0).toString(16);
}
function splitDateTime(dt) {
  dt = String(dt || '').trim();
  if (!dt) return { date: '', time: '' };
  if (dt.includes('T')) {
    const [d, t] = dt.split('T');
    return { date: d, time: (t || '').slice(0, 8) };
  }
  if (dt.includes(' ')) {
    const [d, t] = dt.split(' ');
    return { date: d.replaceAll(':', '-'), time: (t || '').slice(0, 8) };
  }
  return { date: dt.slice(0, 10), time: '' };
}
function displayTime(t) {
  t = String(t || '').trim();
  if (!t) return '';
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return t;
  let h = +m[1]; const min = m[2]; const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${min} ${ap}`;
}

// The phase name is solunarFor()'s, since 2026-09-25; this had its own Julian-day phase with
// different cut points. Longitude does not move the phase, so 0 is passed for it.
function moonPhaseLabel(isoDate) {
  return solunarFor(String(isoDate || '').slice(0, 10), 0, 0).phaseName;
}

function itemIsoDateTime(item) {
  if (item?.datetime) return String(item.datetime).replace(' ', 'T');
  if (item?.date) return `${item.date}T${item.time || '12:00:00'}`;
  return '';
}

async function fetchHistoricalWeatherForItem(item) {
  const lat = parseFloat(item?.lat), lon = parseFloat(item?.lon);
  const iso = itemIsoDateTime(item);
  if (!isFinite(lat) || !isFinite(lon) || !iso) return null;
  const dateOnly = iso.slice(0, 10);
  let hour = parseInt((iso.split('T')[1] || '12:00').slice(0, 2), 10);
  if (!isFinite(hour) || hour < 0 || hour > 23) hour = 12;
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${dateOnly}&end_date=${dateOnly}&hourly=temperature_2m,surface_pressure,cloudcover,windspeed_10m,winddirection_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Open-Meteo ${resp.status}`);
  const data = await resp.json();
  const h = data.hourly || {};
  return {
    tempF: h.temperature_2m?.[hour] != null ? Math.round(h.temperature_2m[hour] * 10) / 10 : null,
    pressureHpa: h.surface_pressure?.[hour] != null ? Math.round(h.surface_pressure[hour]) : null,
    cloudPct: h.cloudcover?.[hour] ?? null,
    windMph: h.windspeed_10m?.[hour] != null ? Math.round(h.windspeed_10m[hour] * 10) / 10 : null,
    windDir: h.winddirection_10m?.[hour] ?? null,
    moonPhase: moonPhaseLabel(iso),
    source: 'open-meteo-archive',
    fetchedAt: new Date().toISOString()
  };
}

function nearestLakeAndContour(latRaw, lonRaw) {
  const lat = parseFloat(latRaw), lon = parseFloat(lonRaw);
  const out = { lake: '', depth: '', depthBand: '', contourDistanceMi: null, chart: null };
  if (!isFinite(lat) || !isFinite(lon)) return out;

  // Lake name: prefer the worker-backed access index (hundreds of real
  // DNR-known waterbodies, matched by distance to an actual access point)
  // over the curated LAKE_DB (~40 lakes, matched by distance to a guessed
  // centroid within a flat 20mi fallback radius). Falls back to LAKE_DB
  // only if the access index has nothing within range — e.g. before the
  // worker fetch has resolved, or the worker is briefly unreachable.
  try {
    const accessMatch = nearestLakeByAccessPoint(lat, lon, 2.0);
    if (accessMatch.lake) {
      out.lake = accessMatch.lake;
      out.lakeSource = 'access-index';
      out.lakeMatchDistanceMi = accessMatch.distanceMi;
    } else {
      // Nearest-centroid fallback, now over the whole registry rather than 50 curated
      // lakes. Same 20-mile rule; a far larger haystack, so an imported catch on a small
      // impoundment resolves instead of falling through to nothing.
      const db = Object.fromEntries(getLoadedRegistry().list.map(r => [r.displayName, r]));
      let bestName = '', bestDist = Infinity;
      for (const [name, info] of Object.entries(db)) {
        if (!Number.isFinite(info?.lat)) continue;
        const cLat = info.lat;
        const cLon = info.lon;
        if (!isFinite(cLat) || !isFinite(cLon)) continue;
        const d = Math.hypot((lat - cLat) * 69, (lon - cLon) * 69 * Math.cos(lat * Math.PI / 180));
        const radius = info.radiusMi || info.radius || 20;
        if (d < bestDist && d <= radius) { bestDist = d; bestName = name; }
      }
      if (bestName) {
        out.lake = bestName;
        out.lakeSource = 'lake-db-fallback';
        out.lakeMatchDistanceMi = bestDist;
      }
    }
  } catch (err) {
    // Best-effort enrichment: the catch is still saved, it just has no lake name on it.
    // Worth a line anyway -- a catch with no lake is the thing Ryan notices weeks later in
    // the journal, and "nothing was thrown" is not the same as "no lake was near".
    console.warn('[catch-journal] nearest-lake lookup failed:', err);
  }

  // ── AND THE CHART HAS TO BE THIS WATER'S CHART ──────────────────────────────────────────────
  //
  // `state.ACTIVE_CONTOUR` is whatever pack is loaded in the app RIGHT NOW. It has nothing to do
  // with where the catch is, and a whole journal can be imported in one sitting with one water
  // selected -- so every fish in it gets its depth off that one chart.
  //
  // MEASURED ON RYAN'S OWN 157 CATCHES, after he said *"santee river is charted..."*. It is. All
  // five of the lookups that reached past a tenth of a mile match LAKE MARION's nearest contour
  // and not the water the fish was in:
  //
  //                              journal said   marion chart   the right chart
  //     shad, Santee River        0.24 mi        0.234 mi       0.001 mi  (santee_river)
  //     catfish, borrow pit       0.17 mi        0.001 mi       -- across a levee from Marion
  //
  // The shad is the proof: the Santee pack has a contour 1.6 m from that fish and the app read a
  // chart a quarter mile away, because Lake Marion was the pack on screen.
  //
  // SO THE LOOKUP IS REFUSED RATHER THAN APPROXIMATED. A depth off the wrong water is not a worse
  // depth, it is a different water's depth, and nothing downstream can tell the two apart. The
  // catch still saves, with no depth and a flag saying why -- which is the same shape as the two
  // failures above it.
  //
  // `ACTIVE_CONTOUR_KEY` is the pack slug: contour-data.js fetches `/chartpacks/${r2Key}/`. A
  // locally imported file sets it to a FILENAME, which resolves to no registry row, and that is
  // treated as unconfirmed -- the safe answer, not a guess at what the file was.
  const chartSlug = String(state.ACTIVE_CONTOUR_KEY || '').split('/')[0];
  const waterSlug = out.lake ? ((lakeRecordFor(out.lake) || {}).slug || '') : '';
  out.chart = chartSlug || null;
  if (!chartSlug || !waterSlug || chartSlug !== waterSlug) {
    out.chartMismatch = { chart: chartSlug || null, water: waterSlug || null };
    return out;
  }

  // Nearest loaded contour from TrollMap contour layer.
  try {
    const contourData = state.ACTIVE_CONTOUR;
    const features = contourData?.smart?.features || contourData?.raw?.features || [];
    if (!features.length) return out;
    const cosLat = Math.cos(lat * Math.PI / 180);
    const boxDeg = 1 / 69; // 1 mile prefilter
    let closestDepth = null, closestDist = Infinity;
    const candidates = features.filter(feat => {
      const b = feat.bbox;
      if (!b) return true;
      return b[0] - boxDeg <= lon && lon <= b[2] + boxDeg && b[1] - boxDeg <= lat && lat <= b[3] + boxDeg;
    });
    for (const feat of candidates) {
      const depth = feat.properties?.depth ?? feat.properties?.DEPTH ?? feat.properties?.depth_ft ?? feat.properties?.Depth;
      if (depth == null || depth === '') continue;
      const geom = feat.geometry;
      const coords = geom?.coordinates;
      if (!coords) continue;
      let lines = [];
      if (geom.type === 'LineString') lines = [coords];
      else if (geom.type === 'MultiLineString') lines = coords;
      else if (geom.type === 'Polygon') lines = coords;
      else if (geom.type === 'MultiPolygon') lines = coords.flat(1);
      else continue;
      for (const line of lines) {
        for (const pt of line) {
          if (!Array.isArray(pt) || pt.length < 2) continue;
          const cLon = Number(pt[0]), cLat = Number(pt[1]);
          if (!isFinite(cLat) || !isFinite(cLon)) continue;
          const d = Math.hypot((lat - cLat) * 69, (lon - cLon) * 69 * cosLat);
          if (d < closestDist) { closestDist = d; closestDepth = depth; }
        }
      }
    }
    if (closestDepth != null && closestDist <= 1.0) {
      out.depth = String(closestDepth);
      out.contourDistanceMi = closestDist;
      // This used to read `< 0.25 ? 'near' : 'near'` -- both arms said the same word, so a
      // contour a quarter mile off the fix read exactly like one 0.11 mi off it. ON_CONTOUR_MI
      // is the line that matters: past it the number stops describing this spot.
      const relation = closestDist < ON_CONTOUR_MI ? 'on' : closestDist < 0.25 ? 'near' : 'off';
      // THE CHART IS NAMED IN THE NOTE, because the note is the only field that survives
      // exportJournalCsv() and a number whose source cannot be named is not checkable.
      out.depthBand = `~${closestDepth}ft contour (${relation}, ${closestDist.toFixed(2)} mi`
                    + `${out.chart ? `, ${out.chart} chart` : ''})`;
    }
  } catch (err) {
    // Same shape as the lake lookup above: the catch saves without a depth band rather than
    // failing. Reported because a journal full of blank depths looks like missing contours
    // when it may be a thrown error on every single row.
    console.warn('[catch-journal] nearest-contour depth lookup failed:', err);
  }
  return out;
}

function enrichItemFromGps(item) {
  if (!item) return item;
  const spatial = nearestLakeAndContour(item.lat, item.lon);
  if (!item.lake && spatial.lake) item.lake = spatial.lake;
  // A DEPTH HIS SOUNDER MEASURED AT THE MARK IS NOT LOOKED UP AGAIN. The catch drop takes it from
  // the Garmin waypoint he drops at the bite. A contour band written beside it would make
  // describeCatchDepth() call a sonar reading "charted" -- the band and the flag below are what
  // mark a depth as a lookup -- so the lake is filled in and the depth is left alone.
  if (item.depthSource === 'sounder_at_waypoint' && item.depth) return item;
  // A contour 0.27 mi away is not this spot's depth, so it does not get to BE the catch's
  // depth. The band below still records what was found and how far off it was, which is the
  // information; `depth` is a claim, and that claim needs the fix to be on the contour.
  if (!item.depth && spatial.depth
      && Number.isFinite(spatial.contourDistanceMi) && spatial.contourDistanceMi <= ON_CONTOUR_MI) {
    item.depth = spatial.depth;
  }
  if (spatial.depthBand) {
    item.structure = { depthBand: spatial.depthBand, contourDistanceMi: spatial.contourDistanceMi,
                       chart: spatial.chart || null };
    const note = `Depth lookup: ${spatial.depthBand}`;
    if (!String(item.ai?.notes || '').includes('Depth lookup:')) {
      item.ai.notes = [item.ai?.notes || '', note].filter(Boolean).join(' | ');
    }
    if (!item.reviewFlags.includes('depth_from_contours')) item.reviewFlags.push('depth_from_contours');
  } else if (spatial.chartMismatch) {
    // Distinct from depth_not_found: the chart was never asked, so this says nothing about
    // whether the water is charted -- only that the chart on screen was a different water's.
    if (!item.reviewFlags.includes('depth_chart_not_this_water')) {
      item.reviewFlags.push('depth_chart_not_this_water');
    }
  } else if (item.lat && item.lon && !item.reviewFlags.includes('depth_not_found')) {
    item.reviewFlags.push('depth_not_found');
  }
  return item;
}

function normalizeCsvRow(row, importedFrom = 'csv') {
  const filename = row.filename || row.file || row.name || '';
  const datetime = row.master_datetime || row.datetime || row.datetime_v3 || row.datetime_v2 || row.date_time || row.timestamp || '';
  const { date, time } = splitDateTime(datetime);
  const notes = row.master_notes || row.notes || row.stage2_notes || row.ai_notes || '';
  const rawSpecies = cleanSpecies(row.master_species || row.verified_species || row.species || row.stage2_species || row.ai_species || row.stage1_species || '');
  const inferred = inferSpeciesFromNotes(rawSpecies, notes);

  const masterFishPresent = Object.prototype.hasOwnProperty.call(row, 'master_has_fish') && String(row.master_has_fish || '').trim() !== '';
  const hasFishFieldPresent = Object.prototype.hasOwnProperty.call(row, 'has_fish') && String(row.has_fish || '').trim() !== '';
  const stage1FishFieldPresent = Object.prototype.hasOwnProperty.call(row, 'stage1_fish') && String(row.stage1_fish || '').trim() !== '';
  const finalSpecies = cleanSpecies(row.master_species || row.verified_species || row.species || row.stage2_species || row.ai_species || '');
  const finalSpeciesSaysFish = !!finalSpecies && !['not fish', 'no fish', 'error', 'none', 'unknown'].includes(finalSpecies.toLowerCase());
  
  let hasFish = false;
  if (masterFishPresent) hasFish = parseBool(row.master_has_fish);
  else if (hasFishFieldPresent) hasFish = parseBool(row.has_fish);
  else if (stage1FishFieldPresent) hasFish = parseBool(row.stage1_fish) || finalSpeciesSaysFish;
  else hasFish = finalSpeciesSaysFish;

  const onBoard = parseBool(row.master_on_bump_board || row.on_bump_board || row.on_bump_board_v3 || row.on_bump_board_v2);
  const aiLen = String(row.master_length_inches || row.length_inches || row.length_inches_v3 || row.length_inches_v2 || row.ai_length || row.aiLength || '').trim();
  const conf = row.master_confidence || row.confidence || row.stage2_confidence || row.stage1_confidence || '';
  const flags = [];
  if (!hasFish) flags.push('not_fish_or_rejected');
  if (onBoard) flags.push('verify_board_length_from_photo');
  if (onBoard && !aiLen) flags.push('board_missing_length');
  if (!inferred.species || ['Other Fish', 'Unknown'].includes(inferred.species)) flags.push('species_needs_review');
  if (inferred.flag) flags.push(inferred.flag);
  if (String(conf).toLowerCase().includes('low')) flags.push('low_confidence');
  if (rawSpecies !== inferred.species && inferred.species) flags.push('species_normalized');

  const item = {
    id: '',
    status: hasFish ? 'pending' : 'rejected_candidate',
    reviewFlags: [...new Set(flags)],
    filename,
    sourcePath: row.source_path || row.path || row.local_path || '',
    sha256: row.sha256 || '',
    datetime, date, time,
    lat: row.master_lat || row.lat || row.lat_v3 || row.lat_v2 || '', lon: row.master_lon || row.lon || row.lon_v3 || row.lon_v2 || '', lake: row.lake || '', depth: row.depth || '',
    ai: {
      hasFish, onBoard,
      species: rawSpecies,
      inferredSpecies: inferred.species,
      length: aiLen,
      confidence: conf,
      model: row.source_model || row.stage2_model || row.model || 'master_catalog',
      notes
    },
    verified: {
      hasFish,
      onBoard,
      species: row.verified_species || inferred.species || rawSpecies || '',
      length: row.verified_length_inches || row.verified_length || (onBoard ? aiLen : ''),
      lengthVerified: parseBool(row.length_verified) || !!(onBoard && aiLen),
      reviewed: false
    },
    weather: null,
    structure: null,
    importedFrom,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    raw: row
  };
  item.id = row.id || stableId(item);
  return item;
}

/**
 * The journal as it goes to the cloud: everything except the photographs.
 *
 * D1 REFUSED THE WHOLE JOURNAL, EVERY TIME, FOR MONTHS.
 *
 *     sync error: catch/catches insert failed at 10819.5 KB payload:
 *     D1_ERROR: string or blob too big: SQLITE_TOOBIG
 *
 * Two things made that one error. The journal is pushed as a SINGLE row -- every catch there has
 * ever been, under the id `catches` -- and each catch carries `photoDataUrl`, a base64 JPEG,
 * which is about a third larger than the file it came from. A few dozen fish photographs is ten
 * megabytes and D1 will not take it, so nothing synced at all: not the photos, not the fish, not
 * the lure, not the date. Every catch since this started is local-only and looks synced.
 *
 * A PHOTOGRAPH IS NOT A DATABASE ROW. `STORE_BY_TYPE` in cloud-sync.js already says the same
 * thing about the other big thing this app holds -- "charts live in R2 -- excluded from D1 sync"
 * -- and a fish photo is the same kind of object for the same reason. Stripped here, the journal
 * is the text of the catch: species, length, lure, where, when, and which photo it belongs to.
 * `photoName` survives, so the image is still findable on the device that has it, and the record
 * that matters crosses to the phone.
 *
 * WHAT THIS DOES NOT DO is put the photos anywhere. They stay on whichever device shot them
 * until they go to R2 like the charts, and that is a separate piece of work rather than something
 * to smuggle into a bug fix.
 */
function catchesForSync() {
  return getCatches().map((c) => {
    if (!c || typeof c !== 'object') return c;
    const { photoDataUrl, lurePhotoDataUrl, thumbDataUrl, ...rest } = c;
    // Said out loud on the record, so a phone showing no picture is explained rather than broken.
    return (photoDataUrl || lurePhotoDataUrl || thumbDataUrl)
      ? { ...rest, photoOnDevice: true } : rest;
  });
}

async function saveCatches() {
  // The single most costly thing this app can lose. A catch is logged once, on the water,
  // often with the phone about to go in a dry bag -- there is no second chance to re-enter it
  // and no way to notice it is gone until you look for it weeks later.
  await tryPut('journal', { name: CATCHES_DB_KEY, data: getCatches() }, 'catch journal');
  // Sync to cloud so catches are available across devices
  // Absent is fine (cloud-sync may not have loaded); throwing is not -- it means the catch
  // saved locally and never left the device, which looks identical to a synced one.
  callGlobal('pushItemOnSave', 'catch', CATCHES_DB_KEY,
             { name: CATCHES_DB_KEY, data: catchesForSync() });
}
async function saveQueue() {
  // The queue is what replays catches to the cloud once there is signal again. Losing it
  // silently means the catches stay local forever and look synced.
  await tryPut('journal', { name: QUEUE_DB_KEY, data: getQueue() }, 'catch sync queue');
}
export async function loadCatches() {
  try {
    const r = await dbGet('journal', CATCHES_DB_KEY);
    if (r) {
      // A JOURNAL THAT HOLDS COPIES OF ITSELF IS REPAIRED ON LOAD. cloud-sync's pull appended every
      // pulled `catch/catches` record as one more catch until 2026-10-03 (504 blank rows in Ryan's
      // journal). The copies come out; a catch that was only inside one -- logged on another device
      // and never merged -- stays, once. See journal-merge.js.
      const fixed = flattenJournal(r.data || []);
      setCatches(fixed.catches);
      if (fixed.records || fixed.dropped) {
        console.warn(`[catch-journal] repaired the journal: ${fixed.records} cop${fixed.records === 1 ? 'y' : 'ies'} of `
          + `the journal removed, ${fixed.recovered} catch(es) found only inside them kept, ${fixed.dropped} empty `
          + `entr${fixed.dropped === 1 ? 'y' : 'ies'} removed; ${fixed.catches.length} catches.`);
        state.JOURNAL_REPAIR = { ...fixed, catches: undefined, at: new Date().toISOString(), kept: fixed.catches.length };
        await saveCatches();
      }
    }
    const q = await dbGet('journal', QUEUE_DB_KEY);
    if (q) setQueue(q.data || []);
    // His labelled Garmin marks, for the plan's `yourHistory` (garmin-marks.js). Never throws.
    state.GARMIN_MARKS = await loadMarks();
  } catch (err) {
    // NOT best-effort. Swallowing here renders an empty journal that looks like "no catches
    // yet" rather than "your catches could not be read", which is the difference between a
    // quiet morning and thinking you lost the lot.
    console.error('[catch-journal] could not load saved catches:', err);
  }
  renderCatchCenter();
}

function helperBase() {
  return document.getElementById('catchHelperUrl')?.value?.trim() || localStorage.getItem('trollmapCatchHelperUrl') || DEFAULT_HELPER;
}
function baseName(p) {
  return String(p || '').split(/[\\/]/).pop().toLowerCase();
}
function imageUrl(item) {
  if (!item) return '';
  if (item.photoDataUrl) return item.photoDataUrl; // live nightly upload — stored directly, no folder needed
  const keys = [item.filename, baseName(item.sourcePath)].map(x => String(x || '').toLowerCase()).filter(Boolean);
  for (const key of keys) if (localPhotoUrls.has(key)) return localPhotoUrls.get(key);
  // Do NOT fall back to http://localhost from an HTTPS GitHub Pages app; Chrome blocks it as mixed content.
  // If no folder-picked file matches, show a no-photo warning instead of causing console spam.
  return '';
}
function thumbUrl(item) { return imageUrl(item); }

function catchPanelHost() {
  const panel = document.querySelector('#panel-catch .pad');
  return panel || document.getElementById('panel-catch');
}

export function renderCatchLog() { renderJournalOnly(); }

function renderCatchCenter() {
  const host = catchPanelHost();
  if (!host) return;
  host.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <h3 style="margin:0">🐟 Catch Center</h3>
        <div class="muted">AI candidates → human verified journal</div>
      </div>
      <div class="subtabs" style="margin-top:10px">
        <button data-catchsub="journal">📓 Journal</button>
        <button data-catchsub="import">📥 Import CSV</button>
        <button data-catchsub="review">✅ Review Queue</button>
        <button data-catchsub="analytics">📊 Analytics</button>
      </div>
      <div id="catchCenterBody"></div>
    </div>`;
  host.querySelectorAll('[data-catchsub]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.catchsub === currentSubtab);
    btn.addEventListener('click', () => { currentSubtab = btn.dataset.catchsub; renderCatchCenter(); });
  });
  renderCatchSubtab();
}

function renderCatchSubtab() {
  const body = document.getElementById('catchCenterBody');
  if (!body) return;
  if (currentSubtab === 'journal') renderJournalOnly(body);
  else if (currentSubtab === 'import') renderImport(body);
  else if (currentSubtab === 'analytics') renderAnalytics(body);
  else renderReview(body);
}

async function recheckJournalLakes(body = document.getElementById('catchCenterBody')) {
  const status = body?.querySelector('#journalRecheckStatus');
  const catches = getCatches();
  if (!catches.length) { if (status) status.textContent = 'No confirmed catches to check.'; return; }

  if (status) status.textContent = 'Loading lake database…';
  try {
    await loadAccessIndex();
  } catch (err) {
    // access-index.js logs its own initial failure once, but that happens at import time and
    // this is a user-initiated batch. Say so here too: everything below still runs, it just
    // falls back to LAKE_DB and produces worse lake names, which is invisible otherwise.
    console.warn('[catch-journal] lake index unavailable, using the curated fallback list:', err);
  }

  let filled = 0, changed = 0, noGps = 0, stillBlank = 0;
  catches.forEach((c) => {
    if (!c.lat || !c.lon) { noGps++; return; }
    const spatial = nearestLakeAndContour(c.lat, c.lon);
    if (!spatial.lake) { stillBlank++; return; }
    if (!c.lake) {
      // Was blank — fill it in. This is the main case: catches imported
      // before a lake existed in LAKE_DB / the access index / the SCDNR
      // State Lakes supplement now resolve correctly.
      c.lake = spatial.lake;
      c.lakeSource = spatial.lakeSource;
      c.lakeMatchDistanceMi = spatial.lakeMatchDistanceMi;
      filled++;
    } else if (c.lake !== spatial.lake) {
      // Already had a value that disagrees with the current best match.
      // Deliberately NOT overwritten — a manually-entered or previously
      // correct lake name shouldn't be silently replaced. Flagged instead
      // so it can be reviewed.
      if (!c.reviewFlags) c.reviewFlags = [];
      if (!c.reviewFlags.includes('lake_mismatch_on_recheck')) {
        c.reviewFlags.push('lake_mismatch_on_recheck');
      }
      c.lakeRecheckSuggestion = spatial.lake;
      changed++;
    }
  });

  await saveCatches();
  renderJournalOnly(body);
  const newStatus = body?.querySelector('#journalRecheckStatus');
  if (newStatus) {
    newStatus.textContent =
      `Filled in ${filled} blank lake${filled === 1 ? '' : 's'}.` +
      (changed ? ` ${changed} existing entr${changed === 1 ? 'y' : 'ies'} disagreed with the current match — flagged for review, not overwritten.` : '') +
      (stillBlank ? ` ${stillBlank} still unmatched (no known lake within range).` : '') +
      (noGps ? ` ${noGps} skipped (no GPS on the catch).` : '');
  }
}

function renderJournalOnly(body = document.getElementById('catchCenterBody')) {
  const catches = getCatches();
  if (!body) return;
  body.innerHTML = `
    <div class="row">
      <button id="manualCatchBtn" class="primary small">+ Manual Catch</button>
      <button id="exportJournalBtn" class="small">⬇ Export Journal CSV</button>
      <button id="recheckLakesBtn" class="small">📍 Re-check Lakes (GPS)</button>
      <button id="deleteAllJournalBtn" class="warn small">🗑 Delete ALL Journal Catches</button>
      <span class="muted">${catches.length} confirmed catches</span>
    </div>
    <div class="row" style="margin-top:4px">
      <select id="catchGpxWater" class="small">${catchWaters(catches).map((w) =>
        `<option value="${esc(w.key)}">${esc(w.name)} (${w.n})</option>`).join('')}</select>
      <button id="exportCatchGpxBtn" class="small">⬇ GPX of this water's catches</button>
      <span id="catchGpxStatus" class="muted" style="font-size:12px"></span>
    </div>
    <div id="journalRecheckStatus" class="muted" style="margin:4px 0;font-size:12px"></div>
    <div id="catchLogList"></div>
    <datalist id="catchWaterNames">${catchWaterNames(catches).map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>`;
  const list = body.querySelector('#catchLogList');
  if (!catches.length) {
    list.innerHTML = '<p class="muted">No confirmed catches yet. Import CSV rows into the review queue, then approve them.</p>';
  } else {
    list.innerHTML = catches.map((c, i) => `
      <div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12px">
        <span style="font-size:18px">🐟</span>
        <div style="flex:1;min-width:0">
          <div><b>${esc(c.species || 'Fish')}</b>${c.length ? ` · ${esc(c.length)}"` : ''} · ${esc(c.date || '')} ${esc(c.time || '')} · ${esc(c.lake || '')} <button data-editlake="${i}" class="small" title="Change the water this fish is filed under" style="padding:0 5px">✎</button>${c.reviewFlags?.includes('lake_mismatch_on_recheck') ? ` <span style="color:#e0a030">⚠ suggested: ${esc(c.lakeRecheckSuggestion || '')}</span>` : ''}</div>
          <div class="muted">${c.depth ? `Depth: ${esc(describeCatchDepth(c).text)}` : ''}${c.waterTempF != null ? ` · Water ${esc(c.waterTempF)} °F` : ''}${c.sourceFile ? ` · ${esc(c.sourceFile)}` : ''}${c.verification?.length ? ` · length: ${esc(c.verification.length)}` : ''}</div>
          ${c.notes ? `<div style="margin-top:2px">${esc(c.notes)}</div>` : ''}
        </div>
        <button data-delcatch="${i}" class="small">🗑</button>
      </div>`).join('');
  }
  body.querySelector('#manualCatchBtn')?.addEventListener('click', () => addManualCatch());
  body.querySelector('#exportJournalBtn')?.addEventListener('click', exportJournalCsv);
  body.querySelector('#exportCatchGpxBtn')?.addEventListener('click', () => exportCatchGpx(body));
  body.querySelectorAll('[data-editlake]').forEach((btn) => btn.addEventListener('click', () => editCatchWater(body, +btn.dataset.editlake, btn)));
  body.querySelector('#recheckLakesBtn')?.addEventListener('click', () => recheckJournalLakes(body));
  body.querySelector('#deleteAllJournalBtn')?.addEventListener('click', async () => {
    const n = getCatches().length;
    if (!n) return;
    if (!confirm(`Delete ALL ${n} confirmed journal catches? This does not delete the review queue or photos.`)) return;
    setCatches([]);
    await saveCatches();
    renderJournalOnly(body);
  });
  body.querySelectorAll('[data-delcatch]').forEach(btn => btn.addEventListener('click', async () => {
    getCatches().splice(+btn.dataset.delcatch, 1);
    await saveCatches(); renderJournalOnly(body);
  }));
}

function renderImport(body) {
  body.innerHTML = `
    <div class="card" style="margin:0 0 12px 0;border-color:var(--accent)">
      <h3>🌙 Nightly Catch Upload — live AI ID, no offline script needed</h3>
      <p class="muted">Drop the day's photos <b>and the Garmin's GPX export</b> together. Each waypoint you marked at a bite becomes one catch: the first photo after it is the <b>lure shot</b>, the second is the <b>fish-on-board shot</b>, and the position, depth and water temperature come from the waypoint. Several fish at one waypoint (a double on an A-rig) is fine: with more than two photos after a mark, every board shot there is its own fish at that mark. Claude on this PC (the plan bridge window) reads the species and length off each board shot, and at a several-fish mark first says which photos are on the board; when it is not running, Gemini reads the board shot instead. You pick the lure yourself while looking at the lure shot. Without a GPX, photos taken within 90 seconds of each other are paired the same way, lure first (🔄 swap in review if it guessed wrong).</p>
      <div class="filebox" id="nightlyDropBox">Drop the photos and the .gpx here, or click to choose (select them all at once)</div>
      <input id="nightlyPhotoInput" type="file" accept="image/*,.gpx" multiple class="hidden">
      <div id="nightlyUploadStatus" class="muted" style="margin-top:8px">${esc(nightlyNote)}</div>
      <div id="nightlyMarks">${marksCardHtml()}</div>
    </div>
    <div class="grid" style="grid-template-columns:minmax(280px,1fr) minmax(280px,1fr);gap:12px">
      <div class="card" style="margin:0">
        <h3>📥 Import sorter CSV</h3>
        <p class="muted">Supports recovered v2 CSVs from 2023–2025 and the newer v3 2026 CSV.</p>
        <div class="filebox" id="csvDropBox">Drop CSV here or click to choose</div>
        <input id="catchCsvInput" type="file" accept=".csv" multiple class="hidden">
        <label style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="boardOnlyImport" checked> board fish only / skip handheld fish</label>
        <label style="display:flex;gap:6px;align-items:center;margin-top:4px"><input type="checkbox" id="importRejectedRows"> include not-fish/rejected rows in queue</label>
        <label style="display:flex;gap:6px;align-items:center;margin-top:4px"><input type="checkbox" id="replaceQueueOnImport"> replace current queue</label>
        <div id="csvImportStatus" class="muted" style="margin-top:8px"></div>
      </div>
      <div class="card" style="margin:0">
        <h3>🖼 Photo folder for review</h3>
        <p class="muted">Recommended: choose the same Google Photos year folder as the CSV. TrollMap will match by filename and show large photos without localhost/mixed-content issues.</p>
        <button id="pickPhotoFolderBtn" class="primary small">📂 Select Photo Folder</button>
        <input id="catchPhotoFolderInput" type="file" webkitdirectory directory multiple class="hidden">
        <label style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="filterPhotosByCsv" checked> only import photos listed in CSV/queue (recommended for root Takeout folders)</label>
        <div id="photoFolderStatus" class="muted" style="margin-top:8px">No folder selected.</div>
        <hr style="border:0;border-top:1px solid var(--line);margin:12px 0">
        <h3>🖥 Optional local helper</h3>
        <p class="muted">Only needed if you do not use folder picker. HTTPS GitHub Pages may block HTTP helper images.</p>
        <label>Helper URL</label>
        <input id="catchHelperUrl" value="${esc(localStorage.getItem('trollmapCatchHelperUrl') || DEFAULT_HELPER)}" style="width:100%">
        <div class="row" style="margin-top:8px"><button id="saveHelperUrlBtn" class="small">Save URL</button><button id="testHelperBtn" class="small">Test</button></div>
        <div id="helperStatus" class="muted"></div>
      </div>
    </div>`;
  const nightlyInput = body.querySelector('#nightlyPhotoInput');
  const nightlyBox = body.querySelector('#nightlyDropBox');
  nightlyBox.addEventListener('click', () => nightlyInput.click());
  nightlyBox.addEventListener('dragover', e => { e.preventDefault(); nightlyBox.classList.add('ok'); });
  nightlyBox.addEventListener('dragleave', () => nightlyBox.classList.remove('ok'));
  nightlyBox.addEventListener('drop', e => {
    e.preventDefault(); nightlyBox.classList.remove('ok');
    handleNightlyPhotoUpload([...e.dataTransfer.files].filter(f => f.type.startsWith('image/') || isGpxFile(f)), body);
  });
  nightlyInput.addEventListener('change', e => handleNightlyPhotoUpload([...e.target.files], body));
  wireMarks(body.querySelector('#nightlyMarks'));
  const input = body.querySelector('#catchCsvInput');
  const box = body.querySelector('#csvDropBox');
  box.addEventListener('click', () => input.click());
  box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('ok'); });
  box.addEventListener('dragleave', () => box.classList.remove('ok'));
  box.addEventListener('drop', e => {
    e.preventDefault(); box.classList.remove('ok');
    importCsvFiles([...e.dataTransfer.files].filter(f => f.name.toLowerCase().endsWith('.csv')));
  });
  input.addEventListener('change', e => importCsvFiles([...e.target.files]));
  body.querySelector('#pickPhotoFolderBtn')?.addEventListener('click', () => body.querySelector('#catchPhotoFolderInput')?.click());
  body.querySelector('#catchPhotoFolderInput')?.addEventListener('change', e => indexPhotoFolder([...e.target.files], body));
  body.querySelector('#saveHelperUrlBtn')?.addEventListener('click', () => {
    localStorage.setItem('trollmapCatchHelperUrl', body.querySelector('#catchHelperUrl').value.trim() || DEFAULT_HELPER);
    body.querySelector('#helperStatus').textContent = 'Saved.';
  });
  body.querySelector('#testHelperBtn')?.addEventListener('click', testHelper);
}

function renderReview(body) {
  const queue = getQueue();
  if (!selectedQueueId && queue.length) selectedQueueId = queue.find(q => q.status === 'pending')?.id || queue[0].id;
  const selected = queue.find(q => q.id === selectedQueueId) || null;
  const counts = {
    total: queue.length,
    pending: queue.filter(q => q.status === 'pending').length,
    approved: queue.filter(q => q.status === 'approved' || q.status === 'imported').length,
    rejected: queue.filter(q => String(q.status).includes('reject')).length,
    board: queue.filter(q => q.verified?.onBoard || q.ai?.onBoard).length
  };
  body.innerHTML = `
    <div class="row">
      <button id="reviewPendingBtn" class="small">Pending ${counts.pending}</button>
      <button id="exportQueueBtn" class="small">⬇ Export Cleaned CSV</button>
      <button id="enrichQueueBtn" class="small">🌦 Check Missing History</button>
      <button id="approveAllPendingBtn" class="small primary">✅ Approve All Pending</button>
      <button id="clearImportedBtn" class="small">Clear imported/approved</button>
      <button id="clearQueueBtn" class="warn small">🗑 Clear Queue</button>
      <span class="muted">Total ${counts.total} · Board ${counts.board} · Approved ${counts.approved} · Rejected ${counts.rejected}</span>
    </div>
    <div id="queueEnrichStatus" class="muted" style="margin:4px 0 8px"></div>
    <div style="display:grid;grid-template-columns:320px minmax(500px,1fr);gap:12px;align-items:start">
      <div class="card" style="margin:0;max-height:72vh;overflow:auto;padding:8px" id="queueList"></div>
      <div class="card" style="margin:0" id="queueDetail"></div>
    </div>`;
  renderQueueList(body.querySelector('#queueList'), queue);
  renderQueueDetail(body.querySelector('#queueDetail'), selected);
  body.querySelector('#exportQueueBtn')?.addEventListener('click', exportQueueCsv);
  body.querySelector('#enrichQueueBtn')?.addEventListener('click', () => enrichMissingHistoricalData(body));
  body.querySelector('#reviewPendingBtn')?.addEventListener('click', () => { selectedQueueId = queue.find(q => q.status === 'pending')?.id || selectedQueueId; renderReview(body); });
  body.querySelector('#approveAllPendingBtn')?.addEventListener('click', async () => {
    const pending = getQueue().filter(q => q.status === 'pending');
    if (!pending.length) return;
    if (!confirm(`Approve all ${pending.length} pending catches to journal?`)) return;
    for (const q of pending) await approveQueueItem(q);
    await saveCatches(); await saveQueue();
    renderCatchSubtab();
  });
  body.querySelector('#clearImportedBtn')?.addEventListener('click', async () => {
    setQueue(getQueue().filter(q => !['approved', 'imported'].includes(q.status)));
    await saveQueue(); renderReview(body);
  });
  body.querySelector('#clearQueueBtn')?.addEventListener('click', async () => {
    const n = getQueue().length;
    if (!n) return;
    if (!confirm(`Clear ALL ${n} review queue item(s)? This does not delete confirmed journal catches or photos.`)) return;
    setQueue([]); selectedQueueId = null;
    await saveQueue(); renderReview(body);
  });
}

function renderQueueList(el, queue) {
  if (!queue.length) {
    el.innerHTML = lastCsvImport
      ? `<p class="muted">The queue is empty. The last import (${esc(lastCsvImport.files.join(', '))}): ${esc(csvImportSummary(lastCsvImport))}</p>`
      : '<p class="muted">No queue yet. Import a CSV first.</p>';
    return;
  }
  el.innerHTML = queue.map(q => {
    const sp = q.verified?.species || q.ai?.inferredSpecies || q.ai?.species || 'Fish';
    const len = q.verified?.length || q.ai?.length || '';
    const active = q.id === selectedQueueId;
    const flag = q.reviewFlags?.includes('verify_board_length_from_photo') ? '📏' : q.verified?.hasFish ? '🐟' : '🚫';
    const statusColor = q.status === 'pending' ? 'var(--warn)' : q.status === 'imported' || q.status === 'approved' ? 'var(--accent2)' : 'var(--bad)';
    return `<div data-qid="${esc(q.id)}" style="cursor:pointer;padding:8px;border:1px solid ${active ? 'var(--accent)' : 'var(--line)'};border-radius:8px;margin-bottom:6px;background:${active ? 'rgba(0,229,255,.08)' : 'var(--panel2)'}">
      <div style="display:flex;justify-content:space-between;gap:8px"><b>${flag} ${esc(sp)}</b><span style="color:${statusColor};font-size:11px">${esc(q.status)}</span></div>
      <div class="muted">${esc(q.filename)}${len ? ` · ${esc(len)}"` : ''}</div>
      <div class="muted">${esc(q.date || '')} ${esc(displayTime(q.time))}</div>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-qid]').forEach(row => row.addEventListener('click', () => { selectedQueueId = row.dataset.qid; renderCatchSubtab(); }));
}
function speciesOptions(current) {
  const all = SPECIES.includes(current) ? SPECIES : [current, ...SPECIES];
  return all.map(s => `<option value="${esc(s)}" ${s === current ? 'selected' : ''}>${esc(s || '— select —')}</option>`).join('');
}
function renderQueueDetail(el, q) {
  if (!q) { el.innerHTML = '<p class="muted">Select a queue item.</p>'; return; }
  const img = imageUrl(q);
  const lureImg = q.lurePhotoDataUrl || '';
  const flags = q.reviewFlags || [];
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
      <div><h3 style="margin:0 0 4px">${esc(q.filename)}</h3><div class="muted">${esc(q.datetime || '')} · ${esc(q.sourcePath || 'no source path')}</div></div>
      <div class="row"><button id="prevQueueBtn" class="small">←</button><button id="nextQueueBtn" class="small">→</button></div>
    </div>
    <div style="display:flex;gap:10px;align-items:flex-start;margin:10px 0">
      ${img ? `<div style="flex:1;background:#050b12;border:1px solid var(--line);border-radius:10px;padding:8px;text-align:center"><img id="reviewPhoto" src="${esc(img)}" style="max-width:100%;max-height:72vh;border-radius:8px;object-fit:contain" onerror="this.insertAdjacentHTML('afterend','<div class=&quot;warnbox&quot;>Image failed to load from selected folder.</div>');this.style.display='none';"></div>` : `<div class="warnbox" style="flex:1">No matching local photo selected. Go to Import CSV → Select Photo Folder for this year. Looking for: ${esc(q.filename || baseName(q.sourcePath) || 'unknown')}</div>`}
      ${lureImg ? `<div style="width:160px;flex-shrink:0;background:#050b12;border:1px solid var(--line);border-radius:10px;padding:8px;text-align:center">
        <div class="muted" style="font-size:11px;margin-bottom:4px">🎣 Lure photo</div>
        <img id="lurePhoto" src="${esc(lureImg)}" style="max-width:100%;max-height:200px;border-radius:6px;object-fit:contain;cursor:zoom-in">
        <button id="swapPhotosBtn" class="small" style="width:100%;margin-top:6px" title="If TrollMap guessed fish/lure backwards for this catch, swap them">🔄 Swap fish/lure</button>
      </div>` : ''}
    </div>
    <div class="grid" style="grid-template-columns:repeat(4,minmax(120px,1fr));gap:8px">
      <div><label>Verified species</label><select id="rvSpecies">${speciesOptions(q.verified?.species || '')}</select></div>
      <div><label>Verified length in</label><input id="rvLength" value="${esc(q.verified?.length || '')}" placeholder="look at photo"></div>
      <div><label>AI length</label><input value="${esc(q.ai?.length || '')}" readonly></div>
      <div><label>Confidence</label><input value="${esc(q.ai?.confidence || '')}" readonly></div>
      <div><label>Date</label><input id="rvDate" value="${esc(q.date || '')}"></div>
      <div><label>Time</label><input id="rvTime" value="${esc(q.time || '')}"></div>
      <div><label>Lake</label><input id="rvLake" value="${esc(q.lake || '')}"></div>
      <div><label>Depth ft${q.depthSource === 'sounder_at_waypoint' ? ' (sonar, at the waypoint)' : ''}</label><input id="rvDepth" value="${esc(q.depth || '')}"></div>
      <div><label>Water °F</label><input id="rvWaterTemp" value="${esc(q.waterTempF ?? '')}"></div>
      <div><label>Latitude</label><input id="rvLat" value="${esc(q.lat || '')}"></div>
      <div><label>Longitude</label><input id="rvLon" value="${esc(q.lon || '')}"></div>
      <div><label>Has fish</label><select id="rvHasFish"><option value="true" ${q.verified?.hasFish ? 'selected' : ''}>Yes</option><option value="false" ${!q.verified?.hasFish ? 'selected' : ''}>No</option></select></div>
      <div><label>On board</label><select id="rvOnBoard"><option value="true" ${q.verified?.onBoard ? 'selected' : ''}>Yes</option><option value="false" ${!q.verified?.onBoard ? 'selected' : ''}>No</option></select></div>
      <div><label>Lure ${lureImg ? '' : '(no paired photo — type freely)'}</label>${lureOptions(q.lure || '')}</div>
    </div>
    <div style="margin-top:8px"><label>Notes</label><textarea id="rvNotes" rows="4">${esc(q.ai?.notes || '')}</textarea></div>
    <div class="muted" style="margin-top:6px">AI species: ${esc(q.ai?.species || '')}${q.ai?.inferredSpecies && q.ai.inferredSpecies !== q.ai.species ? ` → ${esc(q.ai.inferredSpecies)}` : ''} · Model: ${esc(q.ai?.model || '')} · Flags: ${esc(flags.join(', ') || 'none')}</div>
    ${q.weather ? `<div class="okbox" style="font-size:12px">🌦 ${q.weather.tempF ?? '?'}°F · Wind ${q.weather.windMph ?? '?'}mph · ${q.weather.cloudPct ?? '?'}% cloud · ${q.weather.pressureHpa ?? '?'} hPa · ${esc(q.weather.moonPhase || '')}</div>` : `<div class="warnbox" style="font-size:12px">Historical weather/moon not loaded yet. Use “Check Missing History”.</div>`}
    <div class="row" style="margin-top:10px">
      <button id="saveQueueEditsBtn" class="small">💾 Save edits</button>
      <button id="approveCatchBtn" class="primary small">✅ Approve to Journal</button>
      <button id="rejectCatchBtn" class="warn small">🚫 Reject</button>
      <button id="markPendingBtn" class="small">↩ Pending</button>
    </div>`;
  el.querySelector('#saveQueueEditsBtn')?.addEventListener('click', async () => { applyDetailEdits(q); await saveQueue(); renderCatchSubtab(); });
  setTimeout(attachPhotoZoom, 100);
  el.querySelector('#lurePhoto')?.addEventListener('click', () => zoomPhoto(lureImg));
  el.querySelector('#swapPhotosBtn')?.addEventListener('click', async () => {
    // Swap: the "fish" photo becomes the lure reference, and vice versa.
    // AI results/species stay attached to whichever slot is now the fish
    // photo is ambiguous after a swap (we never re-ran AI on the other
    // photo), so clear AI fields and flag for manual re-entry rather than
    // showing stale species/length that may not match the new fish photo.
    const oldFish = q.photoDataUrl, oldFishFilename = q.filename;
    q.photoDataUrl = q.lurePhotoDataUrl;
    q.filename = q.lureFilename || q.filename;
    q.lurePhotoDataUrl = oldFish;
    q.lureFilename = oldFishFilename;
    q.ai = { species: '', length: '', confidence: '', notes: 'Swapped fish/lure — AI was run on the other photo, re-verify species/length manually.', model: '' };
    if (!q.reviewFlags) q.reviewFlags = [];
    if (!q.reviewFlags.includes('photos_swapped')) q.reviewFlags.push('photos_swapped');
    await saveQueue();
    renderCatchSubtab();
  });
  el.querySelector('#approveCatchBtn')?.addEventListener('click', async () => { applyDetailEdits(q); await approveQueueItem(q); moveNext(); renderCatchSubtab(); });
  el.querySelector('#rejectCatchBtn')?.addEventListener('click', async () => { q.status = 'rejected'; q.updatedAt = new Date().toISOString(); await saveQueue(); moveNext(); renderCatchSubtab(); });
  el.querySelector('#markPendingBtn')?.addEventListener('click', async () => { q.status = 'pending'; q.updatedAt = new Date().toISOString(); await saveQueue(); renderCatchSubtab(); });
  el.querySelector('#prevQueueBtn')?.addEventListener('click', () => { moveRelative(-1); renderCatchSubtab(); });
  el.querySelector('#nextQueueBtn')?.addEventListener('click', () => { moveRelative(1); renderCatchSubtab(); });
}
/**
 * THE LURES THE JOURNAL OFFERS ARE THE LURES THE PLANS USE.
 *
 * Ryan, 2026-10-03: "the lure list in the catch journal... where does that list come from as i do
 * not see all of the possibilities in there?" It came from `LURE_PRESETS` in spread-builder.js, 38
 * names typed for the old spread builder, while every plan picks from TACKLE_INVENTORY -- 65 lures,
 * so the lipless baits, the blade bait, the 5" flutter spoon, the P-Line and SPRO jigs, the flukes,
 * the speedworms and the plastics were never offered. A catch's lure is the one thing that says
 * which bait in a plan actually caught, so it has to be spelled the way the plan spells it.
 *
 * Same filter the planners use (`trollable || castable`, smart-plan-v2-wiring.js and
 * plan-water-ui.js), which is what leaves the inline trolling weights out: they are in the box,
 * but nothing is caught on one. Still a free-text box: a lure not in the inventory can be typed.
 */
export function journalLureNames() {
  return TACKLE_INVENTORY.filter((l) => l.trollable || l.castable).map((l) => l.name);
}
function lureOptions(current) {
  const options = journalLureNames().map((l) => `<option value="${esc(l)}">`).join('');
  return `<input id="rvLure" list="rvLureList" value="${esc(current)}" placeholder="type or pick lure"><datalist id="rvLureList">${options}</datalist>`;
}
function applyDetailEdits(q) {
  q.verified = q.verified || {};
  q.verified.species = document.getElementById('rvSpecies')?.value || '';
  q.verified.length = document.getElementById('rvLength')?.value || '';
  q.verified.lengthVerified = !!q.verified.length && !!q.verified.onBoard;
  q.verified.hasFish = document.getElementById('rvHasFish')?.value === 'true';
  q.verified.onBoard = document.getElementById('rvOnBoard')?.value === 'true';
  q.date = document.getElementById('rvDate')?.value || '';
  q.time = document.getElementById('rvTime')?.value || '';
  q.lake = document.getElementById('rvLake')?.value || '';
  q.depth = document.getElementById('rvDepth')?.value || '';
  // Blank is "no reading", not 0 -- 32 °F water is a temperature, an empty box is not.
  const waterTemp = String(document.getElementById('rvWaterTemp')?.value ?? '').trim();
  q.waterTempF = waterTemp !== '' && Number.isFinite(Number(waterTemp)) ? Number(waterTemp) : null;
  q.lat = document.getElementById('rvLat')?.value || '';
  q.lon = document.getElementById('rvLon')?.value || '';
  q.lure = document.getElementById('rvLure')?.value || '';
  q.ai.notes = document.getElementById('rvNotes')?.value || '';
  q.verified.reviewed = true;
  q.updatedAt = new Date().toISOString();
}
function queueIndex() { return Math.max(0, getQueue().findIndex(q => q.id === selectedQueueId)); }
function moveRelative(delta) {
  const q = getQueue(); if (!q.length) return;
  const ix = queueIndex(); selectedQueueId = q[Math.max(0, Math.min(q.length - 1, ix + delta))]?.id || selectedQueueId;
}
function moveNext() {
  const q = getQueue();
  const next = q.find(x => x.status === 'pending' && x.id !== selectedQueueId);
  if (next) selectedQueueId = next.id; else moveRelative(1);
}

async function approveQueueItem(q) {
  if (!q.verified?.hasFish) { q.status = 'rejected'; await saveQueue(); return; }
  const catches = getCatches();
  const sourceFile = q.filename;
  const existingIx = catches.findIndex(c => c.sourceFile === sourceFile && sourceFile);
  const entry = {
    species: q.verified.species || q.ai?.inferredSpecies || q.ai?.species || '',
    length: q.verified.length || q.ai?.length || '',
    depth: q.depth || '',
    // FIX (2026-07-03): this was hardcoded to '' unconditionally, silently
    // discarding any lure tag on every single approval — the root cause of
    // the lure field always being blank on approved catches, going back to
    // whenever this line was first written.
    // NO LEAD. It was written as "" on every catch and nothing ever filled it, and there is no exact way
    // to know how much line was out when a fish bit. Ryan, 10/4: "stop gathering it unless you know an
    // exact way to know how much line is in the water".
    lure: q.lure || '',
    time: displayTime(q.time),
    date: q.date || '',
    lake: q.lake || '',
    lat: q.lat || '', lon: q.lon || '',
    // From the Garmin waypoint he marks at the bite (2026-09-27): the sounder's water temperature,
    // where the depth came from, and the mark itself, so the position can always be traced.
    waterTempF: q.waterTempF ?? null,
    depthSource: q.depthSource || null,
    waypoint: q.waypoint || null,
    notes: q.ai?.notes || '',
    weather: q.weather || null,
    structure: q.structure || null,
    sourceFile,
    // HOW THE LENGTH WAS READ, the one part of the review the card shows ("length: human-visual").
    //
    // NOT GATHERED, Ryan 2026-10-05: *"Catch fields that aren't used and shouldn't be used should
    // disappear if they do not help the app"*. Gone from a saved catch: `importedFrom` and `sourcePath`
    // (the import path and the photo's folder on his PC -- the review queue still uses both to find a
    // photo, a confirmed catch never did), `data_generation`, `trollmap_tags` (the photo model's tags),
    // and from `verification` everything but `length`: reviewed, species, onBoard, sourceModel,
    // approvedAt, length_source, board_detected, data_quality. Nothing shown to him or sent to a plan
    // read any of them. Catches saved before keep what they carry; nothing reads it.
    verification: { length: q.verified.length ? 'human-visual' : 'ai-unverified' },
  };
  if (existingIx >= 0) catches[existingIx] = entry; else catches.unshift(entry);
  q.status = 'imported'; q.updatedAt = new Date().toISOString();
  await saveCatches(); await saveQueue();
}


async function enrichMissingHistoricalData(body = document.getElementById('catchCenterBody')) {
  const status = body?.querySelector('#queueEnrichStatus') || document.getElementById('queueEnrichStatus');
  const queue = getQueue();
  if (!queue.length) { if (status) status.textContent = 'No queue items to check.'; return; }
  // Make sure the worker-backed lake index has resolved at least once before
  // running lake lookups on a batch, so early items in the batch don't get
  // pushed into the LAKE_DB fallback just because the fetch hadn't finished.
  try {
    await loadAccessIndex();
  } catch (err) {
    // access-index.js logs its own initial failure once, but that happens at import time and
    // this is a user-initiated batch. Say so here too: everything below still runs, it just
    // falls back to LAKE_DB and produces worse lake names, which is invisible otherwise.
    console.warn('[catch-journal] lake index unavailable, using the curated fallback list:', err);
  }
  let depthUpdated = 0, weatherUpdated = 0, failed = 0;
  const targets = queue.filter(q => q.status !== 'rejected' && q.status !== 'rejected_candidate');
  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    if (status) status.textContent = `Checking historical data ${i + 1}/${targets.length}: ${item.filename}`;
    const beforeDepth = item.depth;
    enrichItemFromGps(item);
    if (!beforeDepth && item.depth) depthUpdated++;
    if (!item.weather && item.lat && item.lon && (item.datetime || item.date)) {
      try {
        item.weather = await fetchHistoricalWeatherForItem(item);
        if (item.weather) {
          weatherUpdated++;
          if (!item.reviewFlags.includes('weather_from_archive')) item.reviewFlags.push('weather_from_archive');
        }
        // avoid hammering Open-Meteo
        await new Promise(r => setTimeout(r, 250));
      } catch (e) {
        failed++;
        if (!item.reviewFlags.includes('weather_lookup_failed')) item.reviewFlags.push('weather_lookup_failed');
      }
    } else if (!item.weather && (item.datetime || item.date)) {
      if (!item.reviewFlags.includes('weather_missing_gps')) item.reviewFlags.push('weather_missing_gps');
    }
    item.updatedAt = new Date().toISOString();
  }
  await saveQueue();
  if (status) {
    status.textContent = `✓ Historical check complete: depth filled ${depthUpdated}, weather/moon filled ${weatherUpdated}${failed ? `, weather failures ${failed}` : ''}.`;
    status.style.color = 'var(--accent2)';
  }
  renderCatchSubtab();
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') { field += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { row.push(field); field = ''; }
    else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => String(x).trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field); if (row.some(x => String(x).trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim().replace(/^\uFEFF/, ''));
  return rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}
async function importCsvFiles(files) {
  const status = document.getElementById('csvImportStatus');
  const includeRejected = document.getElementById('importRejectedRows')?.checked;
  const boardOnly = document.getElementById('boardOnlyImport')?.checked !== false; // default true
  const replace = document.getElementById('replaceQueueOnImport')?.checked;
  if (replace) setQueue([]);
  // Same reasoning as enrichMissingHistoricalData: make sure the worker-backed
  // lake index has resolved at least once before running lookups on rows
  // that are about to be enriched from GPS.
  try {
    await loadAccessIndex();
  } catch (err) {
    // access-index.js logs its own initial failure once, but that happens at import time and
    // this is a user-initiated batch. Say so here too: everything below still runs, it just
    // falls back to LAKE_DB and produces worse lake names, which is invisible otherwise.
    console.warn('[catch-journal] lake index unavailable, using the curated fallback list:', err);
  }
  let added = 0, skipped = 0, skippedHandheld = 0;
  let autoApproved = 0;
  for (const file of files) {
    const text = await file.text();
    const rows = parseCsv(text);
    for (const row of rows) {
      const item = enrichItemFromGps(normalizeCsvRow(row, file.name));
      // Auto-approve rows already marked as imported in the CSV — skip review queue
      if (row.review_status === 'imported') {
        if (!getCatches().some(c => c.sourceFile === item.filename && item.filename)) {
          item.status = 'imported';
          item.verified.reviewed = true;
          await approveQueueItem(item);
          autoApproved++;
        } else { skipped++; }
        continue;
      }
      if (!includeRejected && !item.verified.hasFish) { skipped++; continue; }
      if (boardOnly && !item.verified.onBoard) { skippedHandheld++; continue; }
      if (getQueue().some(q => q.id === item.id)) { skipped++; continue; }
      getQueue().push(item); added++;
    }
  }
  await saveQueue();
  lastCsvImport = { files: files.map(f => f.name), added, autoApproved, skipped, skippedHandheld };
  if (status) status.textContent = csvImportSummary(lastCsvImport);
  // THE TAB THE ROWS WENT TO: the queue when any went there, the Journal when they all went straight
  // in, and this tab -- with the line above -- when nothing went anywhere.
  currentSubtab = added ? 'review' : autoApproved ? 'journal' : 'import';
  selectedQueueId = getQueue().find(q => q.status === 'pending')?.id || getQueue()[0]?.id || null;
  setTimeout(renderCatchCenter, 700);
}

/** One line on where an import's rows went, for the Import tab and for an empty Review Queue. */
export function csvImportSummary(r) {
  if (!r) return '';
  const parts = [];
  if (r.autoApproved) parts.push(`${r.autoApproved} row${r.autoApproved === 1 ? ' was' : 's were'} already marked imported and went straight to the Journal`);
  if (r.added) parts.push(`${r.added} added to the review queue`);
  if (r.skipped) parts.push(`${r.skipped} skipped — already in the journal or the queue, or not a fish`);
  if (r.skippedHandheld) parts.push(`${r.skippedHandheld} handheld fish skipped (untick "board fish only" to bring them in)`);
  return parts.length ? `${parts.join('; ')}.` : 'No rows were read from that file.';
}
function indexPhotoFolder(files, body) {
  let count = 0;
  let skippedFilter = 0;
  const filterActive = document.getElementById('filterPhotosByCsv')?.checked !== false;
  const q = getQueue();
  const c = getCatches();
  const allowedKeys = new Set();
  if (filterActive && (q.length > 0 || c.length > 0)) {
    [...q, ...c].forEach(item => {
      if (item.filename) allowedKeys.add(String(item.filename).trim().toLowerCase());
      if (item.sourcePath) allowedKeys.add(String(baseName(item.sourcePath)).trim().toLowerCase());
    });
  }

  const imageRe = /\.(jpe?g|png|webp|gif|bmp)$/i;
  for (const f of files) {
    if (!imageRe.test(f.name)) continue;
    const key = f.name.toLowerCase();
    if (allowedKeys.size > 0 && !allowedKeys.has(key)) {
      skippedFilter++;
      continue;
    }
    if (localPhotoUrls.has(key)) URL.revokeObjectURL(localPhotoUrls.get(key));
    localPhotoFiles.set(key, f);
    localPhotoUrls.set(key, URL.createObjectURL(f));
    count++;
  }
  const status = body?.querySelector('#photoFolderStatus') || document.getElementById('photoFolderStatus');
  const matched = q.filter(item => {
    const keys = [item.filename, baseName(item.sourcePath)].map(x => String(x || '').toLowerCase()).filter(Boolean);
    return keys.some(k => localPhotoUrls.has(k));
  }).length;
  if (status) {
    const filterMsg = skippedFilter ? ` (filtered out ${skippedFilter.toLocaleString()} non-CSV photos)` : '';
    status.textContent = `Indexed ${count.toLocaleString()} image(s)${filterMsg}. Matched ${matched}/${q.length} current queue item(s).`;
    status.style.color = matched || !q.length ? 'var(--accent2)' : 'var(--warn)';
  }
  renderCatchSubtab();
}

async function testHelper() {
  const out = document.getElementById('helperStatus');
  const url = helperBase().replace(/\/$/, '') + '/health';
  try {
    const r = await fetch(url); const j = await r.json();
    out.textContent = j.ok ? `✓ Helper online (${j.name || 'TrollMap helper'})` : 'Helper responded but not OK';
    out.style.color = j.ok ? 'var(--accent2)' : 'var(--warn)';
  } catch (e) { out.textContent = `Not reachable: ${e.message}`; out.style.color = 'var(--bad)'; }
}

function csvEscape(v) {
  v = String(v ?? '');
  return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}
function downloadCsv(name, rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const text = [headers.join(','), ...rows.map(r => headers.map(h => csvEscape(r[h])).join(','))].join('\n');
  const blob = new Blob([text], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportQueueCsv() {
  const rows = getQueue().map(q => ({
    review_status: q.status, review_flags: (q.reviewFlags || []).join('|'), filename: q.filename,
    datetime: q.datetime, date: q.date, time: q.time, lat: q.lat, lon: q.lon, lake: q.lake, depth: q.depth,
    water_temp_f: q.waterTempF ?? '',
    has_fish: q.verified?.hasFish, on_bump_board: q.verified?.onBoard,
    species: q.verified?.species || q.ai?.inferredSpecies || q.ai?.species,
    verified_length_inches: q.verified?.length || '', ai_length_inches: q.ai?.length || '',
    length_verified: !!q.verified?.length,
    confidence: q.ai?.confidence || '', source_model: q.ai?.model || '', notes: q.ai?.notes || '',
    tempF: q.weather?.tempF ?? '', windMph: q.weather?.windMph ?? '', windDir: q.weather?.windDir ?? '', cloudPct: q.weather?.cloudPct ?? '', pressureHpa: q.weather?.pressureHpa ?? '', moonPhase: q.weather?.moonPhase || '',
    sha256: q.sha256 || '', source_path: q.sourcePath || '', imported_from: q.importedFrom || ''
  }));
  downloadCsv('trollmap_catch_review_queue_cleaned.csv', rows);
}
/**
 * HIS CATCHES ON ONE WATER, AS GPX WAYPOINTS. Ryan, 10/4: "i want a gpx export of my catch history by body
 * of water", "just waypoints of each caught fish". The water's boundary is read so a pin off it is left
 * out, the way the map leaves it off; where none can be read (a water with no pack, or a river), every
 * pin filed under it goes, and the line says so. See catch-gpx.js.
 */
/**
 * THE WATER A FISH IS FILED UNDER, PUT RIGHT BY HIM.
 *
 * Ryan, 2026-10-04, going down the catch GPX picker: "South East Park Pond - this is a miss
 * marking... i dont know where that is", and "great falls are probably mis markings too and should
 * be wateree as i have never been on great falls". The import names a catch's water after the
 * nearest access point within two miles (nearestLakeAndContour), so a photo whose phone fix was off,
 * or one taken near somebody else's ramp, comes in filed under a water he never fished. Re-check
 * Lakes flags a disagreement and deliberately overwrites nothing, and nothing else in the app could
 * change a confirmed catch's water -- the card offered a delete and nothing more.
 *
 * So the card's water can be changed: ✎, type or pick, Save. The names offered are every water the
 * registry knows and every name already in his journal; anything else he types is kept as typed
 * (a private pond the app does not chart is still where he caught it). Saving clears the re-check
 * flag, since he has now answered it, and changes nothing but the name -- the pin stays where the
 * phone put it, and the map's own off-the-water rule still judges it against the water he named.
 */
function catchWaterNames(catches) {
  const names = new Set();
  for (const c of catches || []) { const n = String((c && c.lake) || '').trim(); if (n) names.add(n); }
  for (const r of (getLoadedRegistry()?.list || [])) if (r.displayName) names.add(r.displayName);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function editCatchWater(body, i, btn) {
  const c = getCatches()[i];
  if (!c || !btn || btn.disabled) return;
  btn.disabled = true;
  const box = document.createElement('div');
  box.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:4px';
  box.innerHTML = `<input list="catchWaterNames" value="${esc(c.lake || '')}" style="flex:1;min-width:0" aria-label="Water this fish was caught on">`
    + '<button class="primary small">Save</button><button class="small">Cancel</button>';
  btn.parentElement.after(box);
  const [input, save, cancel] = [box.querySelector('input'), ...box.querySelectorAll('button')];
  input.focus();
  input.select();
  cancel.addEventListener('click', () => { box.remove(); btn.disabled = false; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); if (e.key === 'Escape') cancel.click(); });
  save.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name || name === c.lake) { box.remove(); btn.disabled = false; return; }
    c.lake = name;
    if (Array.isArray(c.reviewFlags)) c.reviewFlags = c.reviewFlags.filter((f) => f !== 'lake_mismatch_on_recheck');
    delete c.lakeRecheckSuggestion;
    await saveCatches();
    renderJournalOnly(body);
  });
}

async function exportCatchGpx(body) {
  const sel = body.querySelector('#catchGpxWater');
  const status = body.querySelector('#catchGpxStatus');
  const key = sel?.value;
  if (!key) { if (status) status.textContent = 'No catches with a position to export.'; return; }
  const name = (sel.selectedOptions[0]?.textContent || key).replace(/\s*\(\d+\)$/, '');
  if (status) status.textContent = 'Reading the water…';
  let offWater = null, checked = false;
  if (!key.startsWith('name:')) {
    try {
      const [{ packFetcher }, { waterTest }, { CF_WORKER_URL }, { resolveR2Key }] = await Promise.all([
        import('./smart-plan-v2.js'), import('./river-drifts.js'), import('../core/state.js'), import('../data/lake-keys.js')]);
      const bd = await packFetcher(CF_WORKER_URL)(`/${key}/boundary.geojson`);
      const inside = bd ? waterTest(bd) : null;
      if (inside) {
        checked = true;
        offWater = (c) => pinOffItsWater(c, { key, keyOf: resolveR2Key, inside });
      }
    } catch (_) { /* no boundary: every pin goes, and the line says so */ }
  }
  const r = catchesGpx(getCatches(), { key, name, offWater });
  const blob = new Blob([r.gpx], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `catches_${name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  if (status) {
    status.textContent = `${r.n} fish exported`
      + (checked ? (r.offWater ? `; ${r.offWater} left out for a pin off the water.` : '.')
                 : '; this water\'s boundary could not be read, so no pin was checked against it.');
  }
}

function exportJournalCsv() {
  const rows = getCatches().map(c => ({
    species: c.species, length: c.length, date: c.date, time: c.time, lake: c.lake, depth: c.depth,
    waterTempF: c.waterTempF ?? '',
    lat: c.lat, lon: c.lon, lure: c.lure, notes: c.notes,
    tempF: c.weather?.tempF ?? '', windMph: c.weather?.windMph ?? '', windDir: c.weather?.windDir ?? '', cloudPct: c.weather?.cloudPct ?? '', pressureHpa: c.weather?.pressureHpa ?? '', moonPhase: c.weather?.moonPhase || '',
    sourceFile: c.sourceFile, lengthVerification: c.verification?.length || ''
  }));
  downloadCsv('trollmap_catch_journal.csv', rows);
}

function renderAnalytics(body) {
  const catches = getCatches();
  const queue = getQueue();
  const bySpecies = {};
  catches.forEach(c => { const s = c.species || 'Unknown'; bySpecies[s] = (bySpecies[s] || 0) + 1; });
  body.innerHTML = `
    <div class="grid" style="grid-template-columns:repeat(4,1fr);gap:8px">
      <div class="card"><div class="muted">Confirmed</div><div class="big">${catches.length}</div></div>
      <div class="card"><div class="muted">Queue</div><div class="big">${queue.length}</div></div>
      <div class="card"><div class="muted">Pending</div><div class="big">${queue.filter(q => q.status === 'pending').length}</div></div>
      <div class="card"><div class="muted">Board queue</div><div class="big">${queue.filter(q => q.verified?.onBoard || q.ai?.onBoard).length}</div></div>
    </div>
    <div class="card"><h3>Species</h3>${Object.entries(bySpecies).sort((a,b)=>b[1]-a[1]).map(([s,n]) => `<div>${esc(s)}: <b>${n}</b></div>`).join('') || '<p class="muted">No catches yet.</p>'}</div>`;
}
async function addManualCatch() {
  const species = prompt('Species?'); if (species === null) return;
  const length = prompt('Length inches?') || '';
  getCatches().unshift({ species, length, date: new Date().toISOString().slice(0,10), time: new Date().toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit'}), notes: '' });
  await saveCatches(); renderCatchSubtab();
}

// Legacy buttons may exist before render override; wire defensively.
// ── Nightly Catch Upload — live multi-photo intake with lure/fish pairing ────
// Ryan's process (2026-09-27): mark a waypoint on the Garmin when the fish bites, land it, shoot
// the LURE photo (fish with the lure in its mouth), unhook, then shoot the FISH-ON-BOARD photo.
// The board photo is the one sent to AI; the lure photo never is -- he picks the lure himself
// while looking at it, which is free and just as fast.
//
// WITH A GPX IN THE DROP, the waypoints anchor the catches (js/utils/catch-waypoints.js): one
// catch per marked waypoint, first photo after it = lure, second = board, and the position, depth
// and water temperature are the Garmin's, not the phone's.
//
// WITHOUT ONE, photos are grouped by EXIF time: a cluster of exactly 2 taken within PAIR_WINDOW_S
// of each other is a pair, EARLIER = LURE, LATER = BOARD. Anything else (1, or 3+) is treated as
// individual fish photos rather than guessing at a grouping. The window is the old one and it is
// not his number -- his second 9/27 bowfin took 112 s to unhook and would have split -- which is
// why the waypoint is the way in.
const PAIR_WINDOW_S = 90;

function isGpxFile(f) {
  return /\.gpx$/i.test(String(f?.name || ''));
}

// Load exif-js ourselves — don't depend on catch_importer.js having already
// injected it, since module load order isn't guaranteed.
if (!document.querySelector('script[src*="exif-js"]')) {
  const exifScript = document.createElement('script');
  exifScript.src = 'https://cdn.jsdelivr.net/npm/exif-js';
  document.head.appendChild(exifScript);
}

function ensureExifLoaded() {
  return new Promise((resolve) => {
    if (window.EXIF) return resolve();
    const check = setInterval(() => {
      if (window.EXIF) { clearInterval(check); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(check); resolve(); }, 5000); // give up after 5s, proceed without EXIF
  });
}

function extractExif(file) {
  return new Promise((resolve) => {
    if (!window.EXIF) return resolve({ file, timestamp: null, isoDatetime: null, lat: null, lon: null });
    window.EXIF.getData(file, function () {
      let lat = null, lon = null;
      const rawLat = window.EXIF.getTag(this, 'GPSLatitude');
      const rawLon = window.EXIF.getTag(this, 'GPSLongitude');
      const latRef = window.EXIF.getTag(this, 'GPSLatitudeRef');
      const lonRef = window.EXIF.getTag(this, 'GPSLongitudeRef');
      if (rawLat && rawLon) {
        lat = rawLat[0] + rawLat[1] / 60 + rawLat[2] / 3600;
        lon = rawLon[0] + rawLon[1] / 60 + rawLon[2] / 3600;
        if (latRef === 'S') lat = -lat;
        if (lonRef === 'W') lon = -lon;
      }
      const dateStr = window.EXIF.getTag(this, 'DateTimeOriginal'); // "YYYY:MM:DD HH:MM:SS"
      let isoDatetime = null, timestamp = null;
      if (dateStr) {
        const parts = dateStr.split(' ');
        if (parts.length === 2) {
          isoDatetime = `${parts[0].replace(/:/g, '-')}T${parts[1]}`;
          timestamp = new Date(isoDatetime).getTime() / 1000;
        }
      }
      if (timestamp == null) timestamp = file.lastModified / 1000; // fallback: file mtime
      resolve({ file, timestamp, isoDatetime, lat, lon });
    });
  });
}

// Group photos into clusters by timestamp proximity. Returns array of
// arrays (each inner array is a cluster of photos taken within
// PAIR_WINDOW_S of the previous one).
function clusterByTimestamp(items) {
  const sorted = [...items].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const clusters = [];
  for (const item of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && item.timestamp != null && last[last.length - 1].timestamp != null
        && (item.timestamp - last[last.length - 1].timestamp) <= PAIR_WINDOW_S) {
      last.push(item);
    } else {
      clusters.push([item]);
    }
  }
  return clusters;
}

function fileToDataUrl(file, maxPx = 1024) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(''); };
    img.src = url;
  });
}

// Why a photo with a GPX in the drop did not land on a waypoint -- said on the row, never dropped.
const UNANCHORED_NOTE = {
  no_photo_time: () => 'This photo has no time on it, so it could not be matched to a waypoint.',
  no_waypoint_before: () => 'No waypoint in the GPX was marked before this photo.',
  waypoint_other_day: (w) => `The last waypoint before this photo, ${w?.name || '(unnamed)'}, was marked on another day (${localIso(w.epochS).slice(0, 10)}).`,
};

async function handleNightlyPhotoUpload(files, body) {
  const status = body?.querySelector('#nightlyUploadStatus') || document.getElementById('nightlyUploadStatus');
  if (!files.length) return;
  const gpxFiles = files.filter(isGpxFile);
  const photoFiles = files.filter(f => !isGpxFile(f));
  if (!photoFiles.length && !gpxFiles.length) {
    if (status) status.textContent = 'Nothing to read in that drop. Drop the photos and the GPX together.';
    return;
  }

  const waypoints = [];
  const gpxUnread = [];
  for (const g of gpxFiles) {
    try {
      waypoints.push(...parseGPX(await g.text()).waypoints.map(w => ({ ...w, file: g.name })));
    } catch (err) {
      // Said in the status line: a GPX that did not read means every catch below fell back to
      // the phone's position, and that must not look like the waypoints were used.
      gpxUnread.push(g.name);
      console.warn('[catch-journal] could not read GPX', g.name, err);
    }
  }

  // A GPX WITH NO PHOTOS IS A DAY WITH NO FISH, and its marks are still worth having: a missed
  // bite is exactly the mark with no photos after it. It used to be refused here.
  if (!photoFiles.length) {
    const n = await collectMarks(waypoints, []);
    nightlyNote = 'No photos in that drop, so no catches. '
      + (n ? `${n} mark(s) of yours to label below.` : 'No marks of yours in it that are not already labelled or a catch.')
      + (gpxUnread.length ? ` Could not read ${gpxUnread.join(', ')}.` : '');
    renderCatchSubtab();
    return;
  }
  if (status) status.textContent = `Reading ${photoFiles.length} photo(s)${gpxFiles.length ? ` and ${gpxFiles.length} GPX` : ''}...`;
  await ensureExifLoaded();

  const withExif = await Promise.all(photoFiles.map(extractExif));
  const grouped = groupPhotosByWaypoint(withExif, waypoints);

  // CLAUDE ON THIS PC IDENTIFIES EVERY FISH, AND GEMINI ONLY WHEN IT IS NOT THERE (2026-10-08, his
  // "All fish to claude"): the plan bridge's /look, asked the sorter's questions
  // (js/utils/claude-fish-id.js). A usage limit stops the asking for the rest of the drop.
  if (status) status.textContent = 'Looking for Claude on this PC...';
  let claude = (await claudeBridgeStatus()).up;
  let claudeWhy = claude ? '' : 'Claude was not running on this PC';
  const offClaude = (e) => { if (e && e.usageLimit) { claude = false; claudeWhy = "Claude's usage limit is reached"; } };

  // One plan per catch: which photo goes to the fish ID, which is the lure, and the waypoint.
  // A mark with more than two photos is several fish (fishAtMark()): Claude is asked which of them
  // are on the board -- order cannot say, and Gemini called his rig shots "on the board" because the
  // board was in the frame -- and each board shot is one fish.
  const plans = [];
  for (const c of grouped.catches) {
    if (!c.several) {
      plans.push({ board: c.board, lure: c.lure, waypoint: c.waypoint, several: false,
                   flags: c.onePhoto ? ['one_photo_at_waypoint'] : [], notes: [] });
      continue;
    }
    const w = c.waypoint;
    let onBoard = null;
    if (claude) {
      if (status) status.textContent = `Waypoint ${w.name || ''}: ${c.photos.length} photos, asking Claude on this PC which are on the board...`;
      try {
        onBoard = await claudeBoards(c.photos, localIso(w.epochS).slice(0, 10));
      } catch (e) {
        offClaude(e);
        if (claude) claudeWhy = `Claude could not sort them (${e.message})`;
        console.warn('[catch-journal] Claude sort failed:', e.message);
      }
    }
    const fish = onBoard ? fishAtMark(c.photos, (p) => onBoard.has(p)) : null;
    const shared = `${fish ? fish.length : c.photos.length} at waypoint ${w.name || '(unnamed)'}`;
    if (fish) {
      fish.forEach((f, k) => plans.push({
        board: f.board, lure: f.lure, waypoint: w, several: true,
        flags: ['several_fish_at_waypoint'],
        notes: [`Fish ${k + 1} of ${shared}, from ${c.photos.length} photos. If one of them bit somewhere else, it was not marked: correct its position.`],
      }));
    } else {
      // Not sorted, or no board shot among them. Nothing is dropped: every photo is a row at the
      // mark, and the ones that are not a fish are rejected in review.
      const why = onBoard ? 'Claude saw no fish on the bump board in any of them'
        : `${claudeWhy}, so which of them are board shots was not decided`;
      c.photos.forEach((p) => plans.push({
        board: p, lure: null, waypoint: w, several: true,
        flags: ['several_at_waypoint_no_board'],
        notes: [`One of ${c.photos.length} photos at waypoint ${w.name || '(unnamed)'}; ${why}. Reject the ones that are not a fish.`],
      }));
    }
  }
  // Everything not under a waypoint: paired by time as before, lure first. With a GPX in the
  // drop each one says why it had no waypoint; without one there is nothing to explain.
  const why = new Map(grouped.unanchored.map(u => [u.photo, u]));
  for (const cluster of clusterByTimestamp(grouped.unanchored.map(u => u.photo))) {
    const isPair = cluster.length === 2;
    for (const board of (isPair ? [cluster[1]] : cluster)) {
      const u = why.get(board);
      plans.push({
        board, lure: isPair ? cluster[0] : null, waypoint: null,
        flags: gpxFiles.length ? [u.reason] : [],
        notes: gpxFiles.length ? [UNANCHORED_NOTE[u.reason](u.waypoint)] : [],
      });
    }
  }

  let created = 0, aiCalled = 0, aiFailed = 0, byClaude = 0;
  const queue = getQueue();

  for (let i = 0; i < plans.length; i++) {
    const { board, lure, waypoint: w, flags, notes } = plans[i];
    if (status) status.textContent = `Processing catch ${i + 1} of ${plans.length}...`;

    const [photoDataUrl, lureDataUrl] = await Promise.all([
      fileToDataUrl(board.file, 1024),
      lure ? fileToDataUrl(lure.file, 640) : Promise.resolve(''),
    ]);

    // THE TIME IS THE BITE when there is a waypoint; the photos come minutes after it. Declared
    // before the AI call that sends its date -- it used to sit below it, which is a ReferenceError
    // (temporal dead zone) caught by the try, so every nightly catch read "AI call failed".
    const dt = w ? localIso(w.epochS) : (board.isoDatetime || localIso(board.timestamp));
    const { date, time } = splitDateTime(dt.replace('T', ' '));
    const readings = waypointReadings(w);
    const lat = w ? w.lat : (board.lat ?? '');
    const lon = w ? w.lon : (board.lon ?? '');

    if (w) {
      const got = [readings.depthFt != null ? `depth ${readings.depthFt} ft` : '',
                   readings.waterTempF != null ? `water ${readings.waterTempF} °F` : ''].filter(Boolean);
      notes.unshift(`Garmin waypoint ${w.name || '(unnamed)'} at ${displayTime(dt.slice(11))}: position${got.length ? `, ${got.join(', ')}` : ''} from the sounder.`
        + (lure ? ` Lure photo ${fmtGap(lure.timestamp - w.epochS)} after it,` : '')
        + ` board photo ${fmtGap(board.timestamp - w.epochS)} after it.`
        + (Number.isFinite(board.lat) && Number.isFinite(board.lon)
          ? ` The phone put the board photo ${distMiFromCoords(board.lat, board.lon, w.lat, w.lon).toFixed(2)} mi from the waypoint.`
          : ''));
    }

    let ai = null;
    if (claude) {
      if (status) status.textContent = `Catch ${i + 1} of ${plans.length}: asking Claude on this PC for the species and length...`;
      try {
        // A several-fish mark's rig shot holds more than this fish, so only the board shot goes.
        ai = await claudeMeasure(board, plans[i].several ? null : lure,
                                 { day: date, time: dt.slice(11, 16), lat: w ? w.lat : board.lat, lon: w ? w.lon : board.lon });
        byClaude++;
      } catch (e) {
        offClaude(e);
        notes.push(`Claude on this PC did not answer (${e.message}), so Gemini read this one.`);
        console.warn('[catch-journal] Claude ID failed:', e.message);
      }
    }
    if (!ai) try {
      ai = await identifyFishWithGemini(board.file, {
        lake: document.getElementById('planLake')?.value || '',
        date,
        lat: w ? w.lat : board.lat,
        lon: w ? w.lon : board.lon,
      });
    } catch (e) {
      console.warn('[catch-journal] Nightly AI ID failed:', e.message);
    }
    // identifyFishWithGemini() returns null on failure rather than throwing, so the count is
    // taken off the answer -- counting the call as "ran" hid every failure behind a success.
    if (ai) aiCalled++; else aiFailed++;

    const item = {
      id: `nightly_${board.timestamp}_${Math.random().toString(36).slice(2, 8)}`,
      filename: board.file.name,
      sourcePath: '',
      datetime: dt, date, time,
      lat, lon,
      lake: '',
      depth: readings.depthFt != null ? String(readings.depthFt) : '',
      // Measured by his sounder at the mark, not looked up off a chart; enrichItemFromGps()
      // leaves it alone because of this.
      depthSource: readings.depthFt != null ? 'sounder_at_waypoint' : '',
      waterTempF: readings.waterTempF,
      waypoint: w ? { name: w.name, time: w.time, lat: w.lat, lon: w.lon,
                      depthM: w.depthM, tempC: w.tempC, file: w.file } : null,
      photoDataUrl,
      lurePhotoDataUrl: lureDataUrl,
      lureFilename: lure?.file?.name || '',
      lure: '', // filled in manually during review — never sent to AI
      // Claude (claudeMeasure(), in the same shape) or /identify-catch-v2 (falling back to
      // /identify-catch) answers with has_fish, on_bump_board, species, length and confidence.
      // Claude's species list is the app's (SPECIES); the Worker's includes Bowfin -- with a
      // freshwater eyespot rule so a bowfin is not called a red drum -- plus gar, pickerel, bream,
      // shad and the saltwater fish. Species is still human-reviewed.
      ai: ai ? {
        species: ai.species || '', length: ai.lengthInches ?? '', confidence: ai.confidence || '',
        notes: [ai.notes || '', ...notes].filter(Boolean).join(' | '),
        model: ai.model || 'Gemini 2.5-flash v13 (SC trolling taxonomy)',
        inferredSpecies: ai.species || '',
        // v2 extended fields — stored on the item, displayed in review, ignored by old code safely
        has_fish: ai.has_fish ?? true,
        on_bump_board: ai.on_bump_board ?? true,
        length_source: ai.length_source || '',
        board_detected: !!ai.board_detected,
        board_type: ai.board_type || '',
        measurement_confidence: ai.measurement_confidence || ai.confidence || '',
        species_confidence: ai.species_confidence ?? null,
        alt_species: ai.alt_species || [],
        id_features: ai.id_features || [],
        data_quality: ai.data_quality || null,
        trollmap_tags: ai.trollmap_tags || [],
      } : {
        species: '', length: '', confidence: '', model: '',
        notes: ['AI call failed — enter manually.', ...notes].join(' | '),
      },
      verified: {
        species: ai?.species || '', length: ai?.lengthInches ?? '',
        // Default true: the board shot is a landed fish by definition of this workflow.
        // Corrected in review if wrong.
        hasFish: true, onBoard: true,
        reviewed: false,
      },
      weather: null,
      reviewFlags: [...(ai === null ? ['ai_call_failed'] : []), ...flags],
      status: 'pending',
      importedFrom: 'nightly_upload',
      updatedAt: new Date().toISOString(),
    };
    queue.unshift(item);
    created++;
  }

  setQueue(queue);
  await saveQueue();
  const toLabel = gpxFiles.length ? await collectMarks(waypoints, grouped.catches.map(c => c.waypoint)) : 0;
  if (status) {
    // Counted off the plans, not the marks: one mark can carry several fish.
    const onMarks = plans.filter(p => p.waypoint).length;
    status.textContent = `✓ Added ${created} catch(es) to review queue. AI ID ran on ${aiCalled}${aiFailed ? ` (${aiFailed} failed — check flagged items)` : ''}`
      + (byClaude === aiCalled ? (aiCalled ? ', all by Claude on this PC.' : '.')
        : `: ${byClaude} by Claude on this PC, ${aiCalled - byClaude} by Gemini (${claudeWhy || 'Claude did not answer for those'}).`)
      + (gpxFiles.length
        ? ` ${onMarks} on a Garmin waypoint${created > onMarks ? `, ${created - onMarks} without one (flagged)` : ''}.`
          + (grouped.loaded ? ` ${grouped.loaded} waypoints in the GPX share one timestamp, so they were loaded onto the unit, not marked, and were not used.` : '')
        : '')
      + (gpxUnread.length ? ` Could not read ${gpxUnread.join(', ')}.` : '')
      + (toLabel ? ` ${toLabel} mark(s) with no photos after them to label below.` : '')
      + ' Review below.';
    nightlyNote = status.textContent;
  }
  renderCatchSubtab();
}

// ── His marks with no photos after them (item 40) ──────────────────────────────────────────────
// What each one was is his to say: "Ask me at upload". See garmin-marks.js.

async function collectMarks(waypoints, withPhotos) {
  const known = state.GARMIN_MARKS && state.GARMIN_MARKS.length ? state.GARMIN_MARKS : await loadMarks();
  pendingMarks = marksToAsk(waypoints, { withPhotos, journal: [...getCatches(), ...getQueue()], known });
  return pendingMarks.length;
}

function marksCardHtml() {
  if (!pendingMarks.length) return '';
  const rows = pendingMarks.map((w, i) => {
    const r = waypointReadings(w);
    const when = localIso(w.epochS);
    const read = [r.depthFt != null ? `${r.depthFt} ft` : '', r.waterTempF != null ? `${r.waterTempF} °F` : '']
      .filter(Boolean).join(', ');
    return `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px solid var(--line)">
      <div style="flex:1 1 220px"><b>${esc(w.name || '(unnamed)')}</b> · ${esc(when.slice(0, 10))} ${esc(displayTime(when.slice(11)))}${read ? ` · ${esc(read)}` : ''}
        <div class="muted" style="font-size:11px">${Number(w.lat).toFixed(5)}, ${Number(w.lon).toFixed(5)}${w.file ? ` · ${esc(w.file)}` : ''}</div></div>
      <div class="row" style="gap:4px;flex-wrap:wrap">${MARK_LABELS.map(l =>
        `<button class="small" data-mark="${i}" data-label="${l.id}">${esc(l.text)}</button>`).join('')}</div>
    </div>`;
  }).join('');
  return `<div class="card" style="margin:10px 0 0 0">
    <h3 style="margin:0 0 4px 0">📍 Your marks with no photos after them</h3>
    <p class="muted" style="margin:0 0 6px 0">Waypoints you marked on the water that are not a catch. Say what each one was: a missed bite, fish on sonar or a hazard goes to the plan beside your catches. Skip is remembered too, so a mark is only asked about once.</p>
    ${rows}
    ${pendingMarks.length > 1 ? '<div style="margin-top:8px"><button class="small" data-mark-skip-rest>Skip the rest</button></div>' : ''}
  </div>`;
}

async function labelMark(w, label) {
  const rec = markRecord(w, label);
  if (!rec || !(await saveMark(rec))) return false;
  state.GARMIN_MARKS = [...(state.GARMIN_MARKS || []).filter(m => m.id !== rec.id), rec];
  return true;
}

function wireMarks(host) {
  if (!host) return;
  host.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-mark-skip-rest')) {
      for (const w of [...pendingMarks]) if (await labelMark(w, 'skip')) pendingMarks = pendingMarks.filter(x => x !== w);
    } else if (b.dataset.mark != null) {
      const w = pendingMarks[Number(b.dataset.mark)];
      if (w && await labelMark(w, b.dataset.label)) pendingMarks = pendingMarks.filter(x => x !== w);
    } else return;
    host.innerHTML = marksCardHtml();
  });
}

// ── Claude on this PC: which photos at a mark are on the board, and each fish (2026-10-08) ─────
const FISH_SPECIES = () => SPECIES.filter(s => s && s !== 'Not Fish');
const jpegFor = async (file, px) => blobToBase64(await resizeForGemini(file, px));

/** The photos of a several-fish mark that Claude puts on the bump board, as a Set. Throws on failure. */
async function claudeBoards(photos, day) {
  const images = [];
  for (let i = 0; i < photos.length; i++) {
    images.push({ label: photoLabel(i + 1, localIso(photos[i].timestamp).slice(11, 19)),
                  data: await jpegFor(photos[i].file, SORT_PX) });
  }
  const { text } = await claudeLook(sortPrompt(photos.length, day, FISH_SPECIES()), images);
  const on = boardsOf(jsonOf(text), photos.length);
  return new Set(photos.filter((_, i) => on.has(i + 1)));
}

/** One fish's species and length from Claude, in the review queue's `ai` shape. Throws on failure. */
async function claudeMeasure(board, lure, { day, time, lat, lon }) {
  const images = [{ label: 'Photo A (the board shot)', data: await jpegFor(board.file, MEASURE_PX) }];
  if (lure) images.push({ label: 'Photo B (same fish)', data: await jpegFor(lure.file, SORT_PX) });
  const { text, model } = await claudeLook(measurePrompt({ day, time, lat, lon, species: FISH_SPECIES() }), images);
  return aiFromMeasure(jsonOf(text), model, FISH_SPECIES());
}

// ── Gemini fish identification (for single photo drop) ───────────────────────
async function resizeForGemini(imgFile, maxPx = 1344) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(imgFile);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => resolve(blob || imgFile), 'image/jpeg', 0.88);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(imgFile); };
    img.src = url;
  });
}

// ── helper: blob → base64 ─────────────────────────────────────────────────────
async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// Context-aware Gemini ID — sends lake/date/GPS/species_hint to /identify-catch-v2.
// Falls back to the legacy binary endpoint if v2 fails.
async function identifyFishWithGemini(imgFile, context = {}) {
  const WORKER_URL = workerBase();
  try {
    const resized = await resizeForGemini(imgFile, 1344);
    const b64 = await blobToBase64(resized);

    const lakeEl = document.getElementById('planLake');
    const ctx = {
      lake: context.lake || lakeEl?.value || '',
      date: context.date || new Date().toISOString().slice(0, 10),
      lat: context.lat ?? null,
      lon: context.lon ?? null,
      species_hint: context.species_hint || SPECIES.filter(s => s && s !== 'Not Fish'),
      trolling_session: true,
      assume_board: true, // nightly upload workflow is always board photos
      ...context
    };

    // Try v2 JSON endpoint first
    const resp = await fetch(`${WORKER_URL}/identify-catch-v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: b64, mime_type: 'image/jpeg', context: ctx })
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data.success && data.analysis) {
        const a = data.analysis;
        // Ensure back-compat fields exist
        a.species = a.species || 'Other Fish';
        a.lengthInches = a.lengthInches ?? a.length_inches ?? null;
        a.confidence = a.confidence || (a.species_confidence >= 0.85 ? 'high' : a.species_confidence >= 0.6 ? 'medium' : 'low');
        return a;
      }
    }

    // Fallback → legacy binary endpoint
    const resp2 = await fetch(`${WORKER_URL}/identify-catch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg', 'X-Image-Type': 'image/jpeg',
        'X-Lake': ctx.lake || '', 'X-Date': ctx.date || '',
        'X-Lat': ctx.lat != null ? String(ctx.lat) : '',
        'X-Lon': ctx.lon != null ? String(ctx.lon) : '',
        'X-Species-Hint': (ctx.species_hint || []).join(','),
        'X-Assume-Board': 'true'
      },
      body: resized
    });
    if (!resp2.ok) throw new Error(`Worker ${resp2.status}`);
    const data2 = await resp2.json();
    if (!data2.success) throw new Error(data2.error || 'Unknown');
    return data2.analysis;

  } catch (e) {
    console.warn('[catch-journal] Gemini ID failed:', e.message);
    return null;
  }
}

// ── Photo zoom overlay ────────────────────────────────────────────────────────
function initPhotoZoom() {
  if (document.getElementById('photoZoomOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'photoZoomOverlay';
  overlay.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.92);cursor:zoom-out;align-items:center;justify-content:center;';
  overlay.innerHTML = '<img id="photoZoomImg" style="max-width:96vw;max-height:96vh;object-fit:contain;border-radius:8px;">';
  overlay.addEventListener('click', () => { overlay.style.display = 'none'; });
  document.body.appendChild(overlay);
}

function zoomPhoto(src) {
  initPhotoZoom();
  const overlay = document.getElementById('photoZoomOverlay');
  const img = document.getElementById('photoZoomImg');
  img.src = src;
  overlay.style.display = 'flex';
}

// Add zoom to review photo after render
function attachPhotoZoom() {
  const photo = document.getElementById('reviewPhoto');
  if (photo && !photo._zoomWired) {
    photo._zoomWired = true;
    photo.style.cursor = 'zoom-in';
    photo.title = 'Click to zoom';
    photo.addEventListener('click', () => zoomPhoto(photo.src));
  }
}

function wireButtons() {
  renderCatchCenter();
  // Attach zoom after render
  setTimeout(attachPhotoZoom, 500);
}

// Marks labelled on another device arrive through the cloud pull (type `mark`, garmin-marks.js).
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('trollmap:data-synced', async () => { state.GARMIN_MARKS = await loadMarks(); });
}

wireButtons();
