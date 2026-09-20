/**
 * launch-reach.js — every landing that can REACH a water, and how far it is BY WATER.
 *
 * `launches.json` in the pack, from Scripts/build_ramp_reach.py: the charted water rasterised at
 * 25 m and walked outward from the water's own channel, so each landing carries the distance a
 * boat travels rather than the one a crow flies.
 *
 * WHY IT EXISTS. Ryan launches at Pack's Landing, which SCDNR files under Lake Marion, and runs
 * a canal beside the railroad into the Congaree — fishing the canal on the way. Nothing in the
 * app could see that: the ramp binding is NAME-FIRST, so a landing filed under "Lake Marion"
 * never reached "Congaree River" however close it sat. And straight-line distance, which is what
 * I reached for first, is wrong in the one direction that matters:
 *
 *     Pack's Landing (Rimini)   straight 2,367 m     by water 1,801 m
 *     Low Falls Landing         straight   330 m     by water   254 m
 *
 * The water route is SHORTER because it follows the canal instead of cutting the swamp.
 *
 * ONE LOADER, TWO DROPDOWNS. This lives here and not in plan-builder.js because the Plan tab and
 * the map tab are filled by different modules, and the first cut put the reach list in only one
 * of them. Ryan, on finding that out: *"Just to confirm they show on both the plan and map
 * tabs?"* — they did not. A module both import cannot drift the way two copies would.
 *
 * ANNOTATED, NOT FILTERED. There is no distance cutoff anywhere in here, by decision: *"If you
 * can have these ramps be both river and lake I do not see the downside"*, and then *"Annotates
 * reads like the better answer"*. The label carries the run and the choice is made in the boat.
 */

import { CF_WORKER_URL } from '../core/state.js';
import { resolveR2Key } from './lake-keys.js';
import { registryLoader } from './registry-loader.js';

// r2Key -> landings[], or null while a fetch is in flight. A water with no launches.json caches
// [] and is never asked again, which is the normal case for most packs.
const CACHE = new Map();

/**
 * The landings for a water, or [] if they are not here yet.
 *
 * Synchronous on purpose: both dropdowns build their options in one pass and neither can await.
 * The first call starts the fetch and returns []; `onReady` fires once it lands so the caller can
 * redraw. A second call in the same tick does NOT start a second fetch — the map is claimed
 * before the request goes out.
 *
 * @param {string} waterbodyName  the picker's own name for the water
 * @param {function} [onReady]    called with the landings when a fetch completes with any
 * @returns {Array} landings, each {name, lat, lon, water_m, straight_m, station_m, listing,
 *                  filed, src}
 */
export function launchReach(waterbodyName, onReady) {
  const key = resolveR2Key(waterbodyName);
  if (!key) return [];
  if (CACHE.has(key)) return CACHE.get(key) || [];
  CACHE.set(key, null);
  (async () => {
    let got = [];
    try {
      const r = await fetch(`${CF_WORKER_URL}/chartpacks/${encodeURIComponent(key)}/launches.json`);
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d && d.landings)) got = collapse(d.landings);
      }
    } catch (_) { /* a pack without one is the normal case, not an error */ }
    CACHE.set(key, got);
    if (got.length && typeof onReady === 'function') onReady(got, waterbodyName, key);
  })();
  return [];
}

/**
 * "Rimini — 1.1 mi by water", or just the name when the landing is ON the water.
 *
 * Under a tenth of a mile is on it: every ramp sits on the bank, so a number there would be
 * measuring the walk down the concrete and not the run out to the fish. Past ten miles the tenth
 * is noise against a day's planning.
 */
export function reachLabel(r) {
  const m = Number(r && r.water_m);
  const nm = (r && r.name) || '(unnamed launch)';
  if (!Number.isFinite(m)) return nm;
  if (m < 160) return nm;
  const mi = m / 1609.34;
  return `${nm} — ${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi by water`;
}

/**
 * THE WORD FOR A LANDING THAT SELLS YOU THE LAUNCH, or '' when nothing says.
 *
 * Ryan, part way through naming the unnamed ones: *"most of these are campgrounds or marinas...
 * almost all of them are pay to play"*. The national water-access layer already knew -- it types
 * 242 of its rows "Semi-Private" against 1,120 "Public" -- and build_ramp_reach.py now carries
 * that word through to `listing` on the landing.
 *
 * ANNOTATED, NOT FILTERED, unlike isClosed() below. A fee is a judgement he makes in the boat --
 * he launches at Blacks Camp -- and the rule in this file is his: *"Annotates reads like the
 * better answer"*. What he cannot do is tell a county park from a campground by reading a name.
 *
 * TAKES THE LIST AND A POSITION rather than one row, because the two dropdowns do not label the
 * reach rows alone. Both build their list from the live state feed first and append the reach
 * landings that are not already in it -- and 73 of the 211 semi-private landings across the 355
 * packs are in BOTH, so a marker that rode only on the appended rows would leave Raysville
 * Marina, Sinclair Marina and Nottely Marina looking like state ramps. Same 40 m as samePlace(),
 * which is the question being asked: is the row on the screen this landing.
 *
 * @param {Array} rows   the reach landings for this water, from launchReach()
 * @returns {string} 'semi-private', or ''
 */
export function listingAt(rows, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  const here = { lat, lon };
  for (const r of rows || []) {
    if (String((r && r.listing) || '') === 'Semi-Private' && samePlace(here, r)) {
      return 'semi-private';
    }
  }
  return '';
}

/**
 * Is this landing already in the list, by position?
 *
 * 0.0004 deg is about 40 m: two feeds' records of one ramp collapse, two real ramps on one lot
 * do not. Position and not name, because the whole reason this file exists is that the same
 * landing carries different names in different feeds.
 */
export function samePlace(a, b) {
  return Number.isFinite(a && a.lat) && Number.isFinite(b && b.lat)
      && Math.abs(a.lat - b.lat) < 0.0004 && Math.abs(a.lon - b.lon) < 0.0004;
}

/**
 * One row per landing, and the row KEEPS THE NAME.
 *
 * Both dropdowns already dropped a second feed's copy of a landing, and both did it the same
 * way: first one wins, skip the rest. The list arrives sorted by water distance, so when an
 * unnamed OSM record is twenty-five metres nearer by water than the named DNR record beside it,
 * the row that survives is the one with no name. Measured across all 63 packs: 311 collapsed
 * groups, and in 31 of them the surviving row was unnamed while a discarded one had a name --
 * "Saluda Shoals Park", "Cannons Creek", "ELWELLS FERRY", "Pitch" at 25 m of water. Ryan reads
 * the dropdown, and "(unnamed launch)" is not a ramp he can find.
 *
 * Done HERE rather than in the two callers because it is one question, and the callers each
 * still guard against duplicating a ramp THEY already placed, which is a different one. The
 * nearest record's distances win, because the nearest water is the true answer for that spot;
 * only the name, and the lists of who files it and where it came from, merge upward.
 */
function collapse(rows) {
  const out = [];
  const union = (a, b) => [...new Set([...(a || []), ...(b || [])])].sort();
  for (const r of rows) {
    if (isClosed(r)) continue;
    const hit = out.find((p) => samePlace(p, r)) || out.find((p) => sameNamedPlace(p, r));
    if (!hit) { out.push({ ...r }); continue; }
    if (r.name && (!hit.name || nameRank(r) < nameRank(hit))) hit.name = r.name;
    // The restrictive word survives the merge, for the reason build_ramp_reach.py spells out:
    // one landing arriving as a state "public water access" row and a national "Semi-Private"
    // row is a marina that the state lists, not a marina that stopped charging.
    if (r.listing && (!hit.listing || r.listing === 'Semi-Private')) hit.listing = r.listing;
    hit.filed = union(hit.filed, r.filed);
    hit.src = union(hit.src, r.src);
  }
  return out;
}

/**
 * Two rows carrying the SAME NAME, close enough that one landing wrote both.
 *
 * Position alone is not enough. Cypress Gardens Boat Landing arrives as three OSM nodes spread
 * over 24 m, C Alex Harvin III Landing as three, Molly Creek Landing and Harry's Fish Camp and
 * Bushy Park Boat Landing as two apiece -- some of them further apart than samePlace's 40 m, so
 * the dropdown listed the same ramp two and three times over. Measured across the 355 packs: 54
 * name groups spread wider than 40 m, 66 rows that are not a second landing.
 *
 * AND THE NAME ALONE IS NOT ENOUGH EITHER, WHICH IS WHY THERE IS STILL A DISTANCE. Google hands
 * back "Boat Ramp" for ramps that have no name of their own, and Richard B. Russell has three of
 * them spread over 29 KILOMETRES. Those are three different ramps that happen to share a label,
 * and merging them would silently delete two launches. 250 m is comfortably past the widest
 * genuine duplicate seen (a 24 m spread, or 120 m at the Wateree's Highway 378 ramp) and nowhere
 * near the generic-name cases, which start at 142 m and run to 29 km -- so it is a gap in the
 * data rather than a number somebody picked.
 *
 * This is also how a correction retires a duplicate: Ryan says *"1 ramp at hwy 378 on the
 * wateree"* where two feeds recorded two, and giving both records the one name in
 * registry/_launch_name_overrides.json merges them here, rather than needing a rule about those
 * two coordinates.
 */
/**
 * WHOSE NAME WINS WHEN TWO NAMED ROWS TURN OUT TO BE ONE LANDING.
 *
 * This went wrong the moment Google filled in the blanks. On the Lower Saluda:
 *
 *     J. B. Barker Boat Landing   osm + places   13,418 m    <- kept, because it was nearer
 *     Hope Ferry                  dnr            13,443 m    <- absorbed, and its name lost
 *
 * The two are 29 m apart, so they are one landing and merging them is right. But the row that
 * happened to be nearer carried GOOGLE'S label for whatever sits closest to that coordinate,
 * and the row it absorbed carried SCDNR'S NAME FOR THE LANDING ITSELF -- which is also what
 * Ryan's own curated list calls it. First-nearest-wins silently renamed Hope Ferry.
 *
 * So the name is taken by provenance, not by arrival order: Ryan, then the state agency, then
 * the national layer or OSM, and Google last. Google is last because it is not naming a landing
 * at all -- it is naming the nearest thing it knows about to a point, which is a different
 * question that usually has the same answer.
 *
 * READ OFF `src`, WHICH IS EXACT HERE RATHER THAN A GUESS. build_ramp_reach.py fills a name from
 * the feeds first, lets Google fill only what is still BLANK, and lets Ryan's overrides
 * overwrite anything. So a row whose src includes `places` has a Google name unless it also has
 * `ryan`, and that is what this reads. If that ordering in access_points() ever changes, this
 * changes with it.
 */
const NAME_SOURCE_ORDER = ['ryan', 'dnr', 'natl', 'osm'];

function nameRank(r) {
  const src = (r && r.src) || [];
  if (src.includes('ryan')) return 0;
  if (src.includes('places')) return NAME_SOURCE_ORDER.length;   // Google filled a blank
  const i = NAME_SOURCE_ORDER.findIndex((s) => src.includes(s));
  return i < 0 ? NAME_SOURCE_ORDER.length : i;
}

function sameNamedPlace(a, b) {
  const an = String((a && a.name) || '').trim().toLowerCase();
  const bn = String((b && b.name) || '').trim().toLowerCase();
  if (!an || an !== bn) return false;
  if (!Number.isFinite(a.lat) || !Number.isFinite(b.lat)) return false;
  const cos = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot((b.lon - a.lon) * 111320 * cos, (b.lat - a.lat) * 110540) <= 250;
}

/**
 * A LANDING THE FEED SAYS HE MAY NOT USE.
 *
 * OSM's `access` tag, carried through by build_ramp_reach.py. `leisure=slipway` covers a private
 * dock ramp behind somebody's house exactly as much as a public landing, which is why Lake
 * Murray and Charleston Harbor were full of unnamed ones sitting at 0 m of water. Measured
 * across all 355 packs: 198 rows not freely public -- 180 private, 14 customers, 2 permit, 2
 * `no`, and one of those named "Abandon Boat Launch" -- against 87 positively public and 1,668
 * with no tag at all.
 *
 * FILTERED, NOT ANNOTATED, AND THAT IS A DELIBERATE EXCEPTION. The rule everywhere else in this
 * file is Ryan's: *"Annotates reads like the better answer"*, and it holds for DISTANCE, which
 * is his judgement to make in the boat. This is not that. "Somebody's driveway" is not a
 * judgement about the day; a row he cannot use is a row he has to rule out every time he reads
 * the list. He chose to drop them.
 *
 * AN ABSENT TAG IS NOT A NO. 1,668 rows say nothing about access and every one of them stays:
 * the tag can only remove a landing it positively rules out, never one it simply has no opinion
 * on. `permissive` and `unknown` stay for the same reason.
 */
function isClosed(r) {
  return ['private', 'customers', 'permit', 'no', 'residents']
    .includes(String((r && r.access) || '').toLowerCase());
}

/**
 * ── RYAN'S OWN NAMES, WHERE THE LIVE FEED GOT THERE FIRST ───────────────────────────────────────
 *
 * `registry/_launch_name_overrides.json` is his corrections, keyed by position, and until now they
 * only ever reached the app through `launches.json` -- the reach list. That is half the landings.
 *
 * The two dropdowns build their list from the LIVE state feed first (access-index.js, the Worker's
 * /ramps and /paddle) and then append the reach landings that feed does not already carry. So an
 * override on a landing the state also files is on the row that gets SKIPPED, and the dropdown
 * keeps the agency's name. Measured on Lake Marion the day it was found: he had said Stumphole
 * Landing, Pack's Landing, Taw Caw Creek Boat Ramp and Taw Caw main lake ramp, and the list still
 * read Calhoun Subdivision, Rimini, Taw Caw Park and Taw Caw Creek -- about 20 of his corrections,
 * every one of them on a landing he actually launches from, which is why the state has it too.
 *
 * SO THE RENAME HAPPENS WHERE THE INDEX IS BUILT, NOT AT EACH LABEL. access-index.js calls
 * primeLaunchNames() once and then renames through ryanName(), so the Plan tab, the map tab, the
 * research engine and Smart Plan all see the same name -- rather than two label sites being
 * patched and the other readers quietly keeping the feed's spelling.
 *
 * NAMES ONLY, NEVER THE DROPS. A `drop: true` in that file retires an OSM slipway node that is not
 * a launch; the access index holds state-agency rows, and deleting one of those because an OSM node
 * ten metres away was dropped would remove a real ramp on the strength of a different record.
 */
// THE SERVED NAME HAS NO LEADING UNDERSCORE. On the drive the file is
// `registry/_launch_name_overrides.json` -- the underscore is that folder's mark for "not a
// per-lake table" -- and upload_garmin_to_r2.py publishes it as `_registry/<name without the
// underscore>.json`, the same as every other object in that prefix. I wrote the disk name here
// and the fetch 404'd silently, which is exactly what registry-loader promises a missing object
// will do: the app worked, the names did not arrive, and nothing said so.
const LAUNCH_NAMES = registryLoader(
  '/chartpacks/_registry/launch_name_overrides.json',
  (b) => b && b.names && typeof b.names === 'object' && b.names,
);

/** Read the overrides once. Safe to call repeatedly; a failure is silence, as in registry-loader. */
export function primeLaunchNames(worker) {
  return LAUNCH_NAMES.prime({ worker: worker || CF_WORKER_URL });
}

/**
 * What HE calls the landing at this position, or '' when he has not said.
 *
 * Same 40 m as samePlace(), because it is the same question: is the row on the screen this landing.
 * An entry carrying `drop` and no `name` is not a rename and is passed over.
 */
export function ryanName(lat, lon) {
  const names = (LAUNCH_NAMES.get() || {}).names;
  if (!names || !Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  for (const key of Object.keys(names)) {
    const rec = names[key];
    if (!rec || !rec.name) continue;
    const parts = String(key).split(',');
    const la = Number(parts[0]);
    const lo = Number(parts[1]);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    if (Math.abs(la - lat) < 0.0004 && Math.abs(lo - lon) < 0.0004) return String(rec.name);
  }
  return '';
}
