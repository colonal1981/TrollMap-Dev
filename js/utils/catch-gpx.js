/**
 * catch-gpx.js -- his catches as GPX waypoints, one water at a time.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-10-04: "i want a gpx export of my catch history by body of water", then "just waypoints
 * of each caught fish". One waypoint per fish he caught on the water picked: each fish once (two photos
 * of one fish are one catch, oneFishEach()), only with a position, and -- where the water's boundary
 * could be read -- not a pin that sits off it (his rule, 10/4: "if it is showing off water it should be
 * filtered from the app").
 *
 * WHAT HIS UNIT KEEPS (plan-tracks.js, UNIT_CHARS, read off his ECHOMAP 2026-09-28): a waypoint's name in
 * 10 characters and its comment in 20; the <desc> never reaches the unit, so everything goes there too
 * for anything else that reads the file. No period in a name: the unit dropped them and turned
 * `15.1 ft` into `151 FT`. So the name is the species and a number in the order he caught them on this
 * water (`STR 07`), unique so the unit cannot merge two fish into one, and the comment is when and how
 * long (`1/25/25 12:58P 22in`).
 */
import { esc } from './escape.js';
import { hasPosition, oneFishEach } from './catch-pins.js';
import { resolveR2Key } from '../data/lake-keys.js';

const NAME_CHARS = 10, COMMENT_CHARS = 20;

// Short names for the species he logs, three letters so a number always fits beside them. Anything
// else takes its first three letters.
const CODES = [
  [/striped bass|striper/i, 'STR'], [/hybrid/i, 'HYB'], [/white bass/i, 'WB'], [/largemouth/i, 'LMB'],
  [/smallmouth/i, 'SMB'], [/spotted/i, 'SPB'], [/crappie/i, 'CRP'], [/catfish|cat\b/i, 'CAT'],
  [/bluegill|bream|redear|shellcracker|sunfish|warmouth|pumpkinseed/i, 'BRM'], [/bowfin/i, 'BOW'],
  [/pickerel/i, 'PKL'], [/perch/i, 'PER'], [/red ?drum|redfish/i, 'RED'], [/trout/i, 'TRT'],
  [/flounder/i, 'FLD'],
];
export function speciesCode(species) {
  const s = String(species || '').trim();
  for (const [re, code] of CODES) if (re.test(s)) return code;
  return (s.replace(/[^A-Za-z]/g, '').slice(0, 3) || 'FSH').toUpperCase();
}

/** The water a catch is filed under: the app's own key for it, or the name as written. */
export function waterKeyOf(c) {
  const name = String((c && c.lake) || '').trim();
  if (!name) return null;
  let key = null;
  try { key = resolveR2Key(name); } catch (_) { key = null; }
  return key || `name:${name.toLowerCase()}`;
}

/**
 * The waters he has caught fish on, with a position, each fish once: [{key, name, n}], the most fish
 * first. Spellings of one water that the app resolves to one key are one entry, under the spelling
 * used most.
 */
export function catchWaters(catches) {
  const by = new Map();
  for (const c of oneFishEach(catches || [])) {
    if (!hasPosition(c)) continue;
    const key = waterKeyOf(c);
    if (!key) continue;
    const e = by.get(key) || { key, names: new Map(), n: 0 };
    e.n++;
    const nm = String(c.lake).trim();
    e.names.set(nm, (e.names.get(nm) || 0) + 1);
    by.set(key, e);
  }
  return [...by.values()]
    .map((e) => ({ key: e.key, n: e.n, name: [...e.names.entries()].sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

/** "1:15 PM" -> minutes after midnight, or null. */
function minutesOf(t) {
  const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp])?/);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (!m[3] && Number(m[1]) >= 12) h = Number(m[1]);
  if (m[3] && /p/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2]);
}

/** The catch's moment in UTC, from its local date and time on the water (America/New_York), or null. */
export function catchIsoUtc(c, timeZone = 'America/New_York') {
  const d = String((c && c.date) || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const mins = minutesOf(c && c.time);
  if (!d || mins == null) return null;
  const asUtc = Date.UTC(+d[1], +d[2] - 1, +d[3], Math.floor(mins / 60), mins % 60);
  // The zone's offset at that moment, read back from Intl; one correction pass settles it.
  const offsetAt = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
    const g = (t) => Number(parts.find((p) => p.type === t).value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - ms;
  };
  let ms = asUtc - offsetAt(asUtc);
  ms = asUtc - offsetAt(ms);
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const shortDate = (iso) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${+m[2]}/${+m[3]}/${m[1].slice(2)}` : '';
};
const shortTime = (t) => String(t || '').trim().replace(/\s*([AP])M$/i, (_, ap) => ap.toUpperCase());
const compass = (deg) => (deg == null ? null
  : ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]);

/** What the journal holds about one fish that bears on fishing it, in words, for the <desc>. */
function describe(c) {
  const bits = [];
  const len = num(c.length);
  bits.push([c.species || 'Fish', len != null ? `${len} in` : null].filter(Boolean).join(', '));
  bits.push([c.date, c.time].filter(Boolean).join(' '));
  if (c.lure) bits.push(c.lure);
  const depth = num(c.depth);
  if (depth != null) bits.push(`${depth} ft (${c.depthSource === 'sounder_at_waypoint' ? 'his sounder at the bite' : 'the chart at the photo'})`);
  if (num(c.waterTempF) != null) bits.push(`water ${num(c.waterTempF)} F`);
  const w = c.weather;
  if (w) {
    const then = [num(w.tempF) != null ? `air ${num(w.tempF)} F` : null,
      num(w.cloudPct) != null ? `${num(w.cloudPct)}% cloud` : null,
      num(w.windMph) != null ? `wind ${num(w.windMph)} mph${compass(num(w.windDir)) ? ` from ${compass(num(w.windDir))}` : ''}` : null,
      num(w.pressureHpa) != null ? `${num(w.pressureHpa)} hPa` : null, w.moonPhase || null].filter(Boolean);
    if (then.length) bits.push(`then: ${then.join(', ')}`);
  }
  // Not the notes: on most catches they are the photo model's working on the length ("Tail tip reaches just
  // short of the printed 23..."), which the journal card shows, and which says nothing on a waypoint.
  return bits.filter(Boolean).join('; ');
}

/**
 * The GPX of one water's catches.
 *
 * @param {object[]} catches  the journal (all of it; this picks the water's)
 * @param {object}   o
 * @param {string}   o.key        catchWaters()'s key for the water
 * @param {string}   [o.name]     the water's name, for the file's <name>
 * @param {function} [o.offWater] (catch) => true for a pin that is off this water; left out and counted
 * @returns {{ gpx: string, n: number, offWater: number }}
 */
export function catchesGpx(catches, o = {}) {
  const fish = oneFishEach(catches || [])
    .filter((c) => hasPosition(c) && waterKeyOf(c) === o.key);
  let offWater = 0;
  const kept = [];
  for (const c of fish) {
    if (typeof o.offWater === 'function' && o.offWater(c)) { offWater++; continue; }
    kept.push(c);
  }
  // In the order he caught them, so the numbers run with the dates.
  const when = (c) => `${c.date || '9999'}T${String(minutesOf(c.time) ?? 9999).padStart(4, '0')}`;
  kept.sort((a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0));
  const perCode = new Map(), counts = new Map();
  for (const c of kept) { const k = speciesCode(c.species); counts.set(k, (counts.get(k) || 0) + 1); }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="TrollMap GPX Studio — Catch History"',
    '  xmlns="http://www.topografix.com/GPX/1/1"',
    '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
    `  <metadata><name>${esc(`${o.name || 'Catches'} — catch history`)}</name></metadata>`,
  ];
  for (const c of kept) {
    const code = speciesCode(c.species);
    const i = (perCode.get(code) || 0) + 1;
    perCode.set(code, i);
    const width = Math.max(2, String(counts.get(code)).length);
    const name = `${code} ${String(i).padStart(width, '0')}`.slice(0, NAME_CHARS);
    const len = num(c.length);
    const cmt = [shortDate(c.date), shortTime(c.time), len != null ? `${Math.round(len)}in` : null]
      .filter(Boolean).join(' ').replace(/\./g, '-').slice(0, COMMENT_CHARS);
    const t = catchIsoUtc(c);
    lines.push(`  <wpt lat="${parseFloat(c.lat).toFixed(7)}" lon="${parseFloat(c.lon).toFixed(7)}">`);
    if (t) lines.push(`    <time>${t}</time>`);
    lines.push(`    <name>${esc(name)}</name>`);
    if (cmt) lines.push(`    <cmt>${esc(cmt)}</cmt>`);
    lines.push(`    <desc>${esc(describe(c))}</desc>`, '    <sym>Fish</sym>', '    <type>CATCH</type>', '  </wpt>');
  }
  lines.push('</gpx>', '');
  return { gpx: lines.join('\n'), n: kept.length, offWater };
}
