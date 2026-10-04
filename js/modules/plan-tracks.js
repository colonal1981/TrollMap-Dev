/**
 * plan-tracks.js — a v2 plan, materialised into the tracks and waypoints the export path reads.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS EXISTS
 * ---------------
 * 2026-08-09. Ryan's generated plan described 10.0 miles of trolling across two legs and
 * exported this:
 *
 *     "gpx": { "waypoints": 2, "tracks": 0, "trackPoints": 0, "trackList": [] }
 *
 * The geometry was never missing. `assemblePlan()` puts every metre of it on
 * `plan.legs[].coordinates`, and the whole plan sits on `window._planV2`. Nothing ever copied
 * it anywhere the export could see. `collectPlan()` (plan-builder.js) reads `state.DATA.tracks`
 * and nothing else, and the only writers of that array were on v1's handler, which is not bound.
 * So the plan could not be loaded onto the ECHOMAP and followed, which is the entire point.
 *
 * PLAN_SCHEMA_V2.md says the day is read through `planRoute(plan)` and that "GPX export uses
 * this". That clause is satisfiable by doing nothing, and nothing is what happened. This module
 * is the twenty lines it was missing: one track per leg, in leg order, built from that leg's own
 * coordinates, plus the launch and one waypoint per stop.
 *
 * ONE TRACK PER LEG, NOT ONE FOR THE DAY. `planRoute()` concatenates the day into a single line,
 * which is right for drawing and wrong for the unit: on a 4-inch chartplotter a leg is what you
 * follow, and a leg you can select, hide and follow separately is worth more than one polyline
 * named after the whole morning. `planRoute()` stays the concatenation for anything that wants
 * the day as one line.
 *
 * Names are short on purpose — `L1 · 16.1 ft`, `T2 · transit`. The 93sv truncates, and a name
 * that truncates to "Leg 1 — 5.0 mi · 24 ft li…" tells you nothing at the point you are reading
 * it, which is at 2 mph in the dark.
 *
 * The run-id tagging is the pattern smart-plan-route.js already worked out on 2026-08-09: every
 * track and waypoint from one call carries the same `planRunId`, the id is published on
 * `window._smartPlanRunId`, and `isSmartPlanTrack()` in smart-plan.js refuses to match anything
 * carrying the current one. Without it the cleaner, whose only job is wiping the PREVIOUS run,
 * deletes the run that just finished — which is how v2 built four tracks and shipped zero.
 */

import { state } from '../core/state.js';
import { LEG_COLORS, TRANSIT_COLOR, RETURN_COLOR, loopColor, loopOf } from './plan-to-timeline.js';
import { metresBetween, markLabel } from './plan-candidates.js';
import { todayDepthFt } from '../utils/water-conditions.js';

// ── EVERY DEPTH THAT GOES ON THE UNIT IS TODAY'S ─────────────────────────────────────────────
//
// The numbers below come off Garmin's chart, and every one of them is put on the ECHOMAP to be
// read against the SOUNDER, which reads the water that is there. (The chart was taken to be at
// full pool until 2026-09-27; measured on Wateree it is not. `drawdownFt` is now the lake against
// the chart's own level -- see poolOffsetFt() and js/data/chart-levels.js.) Ryan's 9/27 Murray
// export, with the lake 5.56 ft down: "ledge 47ft" over 41 ft of water, "L1 · 34 ft" over a
// median of 28, and the Contour alarm cue "L1 29-39ft" set around water that was not there -- an
// alarm band the boat would have sat under the whole pass. `drawdownFt` is stamped on each troll
// leg by assemblePlan() from the lake's measured level; where it is absent the chart stands.
const legDrawdown = (leg) => {
  const d = leg && leg.drawdownFt != null ? Number(leg.drawdownFt) : NaN;
  return Number.isFinite(d) && d !== 0 ? d : null;
};
const todayOnLeg = (leg, ft) => todayDepthFt(ft, legDrawdown(leg));

/**
 * The colour a leg draws in, on the map and on its card. One palette, one function, so a line on
 * the water and a card on the screen cannot drift apart.
 *
 * @param {object} leg
 * @param {number} trollOrdinal 0-based count of TROLL legs before this one; ignored for transits
 */
export function legColor(leg, trollOrdinal = 0) {
  if (!leg) return TRANSIT_COLOR;
  if (leg.type === 'transit') return leg.role === 'return' ? RETURN_COLOR : TRANSIT_COLOR;
  return loopColor(leg) || LEG_COLORS[trollOrdinal % LEG_COLORS.length];
}

/**
 * Plan coordinates are [lon, lat] (GeoJSON order, the order every geometry in the packs uses).
 * Everything in `state.DATA` is [lat, lon]. That flip is the single most likely place for this
 * to go quietly wrong — a flipped route still draws, just in Kansas — so it happens here, once.
 */
const toLatLon = (coords) => (coords || []).map(([lon, lat]) => [lat, lon]);

const trim = (s, n) => {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ── WHAT HIS UNIT KEEPS OF A NAME ─────────────────────────────────────────────────────────────
//
// Read off his own ECHOMAP, 2026-09-28. The ADM it exported (28Sep26_Trip\ADMEXPORT.ADM) stores a
// waypoint's name in 10 bytes and its comment in 20, a route's name in 15 and a track's in 20, and
// the GPX it exported beside it agrees: 34 of its 61 waypoint names come back exactly 10 characters
// long -- `S1.1 · doc`, `dock clust`, `obstructio`. The note (<desc>) has no field at all and never
// reaches the unit. So `L3 start 27-37ft` read `L3 start 2` on his screen and `point dry-33ft` read
// `point dry-`: the part he acts on was the part cut off.
//
// Offered the part he acts on first in the ten and the twenty-character comment as a second line,
// he said "sure". What does not fit is spelled out in the comment, and the whole note stays in the
// app.
export const UNIT_CHARS = { name: 10, comment: 20, route: 15, track: 20 };

/** The first candidate that fits in `n` characters; if none does, the last one cut to `n`. */
export function fitUnit(candidates, n) {
  const c = (candidates || []).filter((s) => s != null && s !== '')
    .map((s) => String(s).replace(/\s+/g, ' ').trim());
  if (!c.length) return '';
  return c.find((s) => s.length <= n) ?? c[c.length - 1].slice(0, n).trim();
}

// Shorter words for the same things, tried in order only when the whole word and its depth do not
// fit. The depth is never the part that gives way: it is what he reads against the sounder.
const UNIT_WORDS = {
  point: ['pt'],
  'dock cluster': ['docks'],
  'dock line': ['docks'],
  obstruction: ['obstr'],
  attractor: ['attr'],
  'creek mouth': ['creek'],
  shallow: ['shoal'],
  hazard: ['haz'],
  timber: ['tmbr'],
  'outside bend hole': ['out bend hole', 'out hole', 'hole'],
  'inside bend hole': ['in bend hole', 'in hole', 'hole'],
  'outside bend ledge': ['out bend ledge', 'out ledge', 'ledge'],
  'inside bend ledge': ['in bend ledge', 'in ledge', 'ledge'],
  'outside bank': ['out bank', 'bank'],
  'inside bank': ['in bank', 'bank'],
};
const unitWords = (label) => [label, ...(UNIT_WORDS[label] || [])];

/**
 * A structure's name and comment as the unit keeps them. `depth` is the depth without its unit --
 * `25`, `dry`, `0-34`, `dry-33` -- or null when the chart gives none. The name keeps the depth whole
 * and shortens the word (`pt dry-33`); the comment keeps the word where it fits and says `ft`
 * (`point dry-33ft`).
 */
export function unitLabel(label, depth = null) {
  const words = unitWords(String(label || 'mark'));
  if (depth == null || depth === '') {
    return { name: fitUnit(words, UNIT_CHARS.name), cmt: fitUnit(words, UNIT_CHARS.comment) };
  }
  const d = String(depth);
  const ft = d === 'dry' ? d : `${d}ft`;
  const last = words[words.length - 1];
  const name = fitUnit([
    ...words.map((w) => `${w} ${ft}`),
    ...words.map((w) => `${w} ${d}`),
    `${last.slice(0, Math.max(1, UNIT_CHARS.name - d.length - 1))} ${d}`,
  ], UNIT_CHARS.name);
  return { name, cmt: fitUnit(words.map((w) => `${w} ${ft}`), UNIT_CHARS.comment) };
}

/** `L1 · 16.1 ft` / `T2 · transit`. Readable at a glance on a 4-inch screen. */
export function trackName(leg) {
  if (!leg) return '';
  // The run home is the leg he most needs to find on the unit at 19:00, so it says so rather
  // than being the third thing called "transit".
  if (leg.type === 'transit') return `${leg.id} · ${leg.role === 'return' ? 'home' : 'transit'}`;
  // WHOLE FEET, BECAUSE THE UNIT EATS THE PERIOD. Ryan photographed the route list on the 93sv,
  // 2026-08-26: `L1 · 15.1 ft` renders as `L1 151 FT` -- separator gone, decimal gone, upcased --
  // while `T1 · transit` two rows above it keeps both. A name that reads 151 on the fifteen-foot
  // line is worse than no name at all, and it is read at 2 mph in the dark.
  //
  // Nothing is lost by rounding. `depth_ft` is already a display rounding of `depth_dm`, the
  // authoritative integer -- build_trolling_runs.py: "the contours are metric-derived, so round
  // foot values mostly do not exist... near twelve feet the charted lines are 11.2 ft (34 dm) and
  // 12.1 ft (37 dm) and there is nothing between them." A tenth of a foot was never a real
  // distinction; it was a decimal point standing between him and the right number.
  // SAY WHEN IT IS THE SAME WATER AGAIN. A leg fished back is a separate leg with its own id and
  // its own track, so two rows on the unit would otherwise read `L1 21 FT` / `L2 21 FT` and look
  // like a coincidence of depth rather than a turn at the end of the pass. Even passes run the
  // opposite direction to the first, so "back" is literally what they are; odd ones are the
  // original direction again. Both stay inside the 24 characters the 93sv shows.
  const again = leg.pass > 1 ? (leg.pass % 2 === 0 ? ' back' : ' again') : '';
  return leg.depthFt != null
    ? `${leg.id} · ${Math.round(Number(todayOnLeg(leg, leg.depthFt)))} ft${again}`
    : `${leg.id} · troll${again}`;
}

/** `S1.1 hump`. The id first, because that is what the timeline calls it; the depth is in stopUnit's comment. */
export function stopName(stop, drawdownFt = null) {
  return stopUnit(stop, drawdownFt).name;
}

/**
 * A stop as the unit keeps it: `{ name: 'S1.1 hump', cmt: 'hump 36ft' }`.
 *
 * It was `S1.1 · hump 36ft`, and his unit keeps ten characters of a waypoint's name: on 9/28 his
 * four stops read `S1.1 · doc`, `S3.1 · hol`, `S5.1 · hol`. The id and what to cast at go in the
 * ten; the depth goes in the comment, which keeps twenty.
 */
export function stopUnit(stop, drawdownFt = null) {
  const kind = String(stop.structureType || stop.structure || 'cast').split(',')[0].trim();
  // `Number(null)` IS 0, AND 0 IS FINITE, so a structure with no depth printed as `0ft`.
  // Ryan, 2026-08-26, on `S1.1 \u00b7 dock_cluster 0ft`: "dock clusters are a land object... they
  // probably do not have depth." They do not, and plan-candidates.js already agrees -- it writes
  // `depthFt: null` for anything whose depth did not resolve (`depth > 0 ? ... : null`). The null
  // travelled the whole plan intact and died at this one coercion, one step from the card, where
  // it turned into a claim that the boat can troll a dock in no water.
  const d = stop.depthFt == null ? NaN : Number(todayDepthFt(Number(stop.depthFt), drawdownFt));
  // AND A CHARTED DEPTH THE LAKE HAS DROPPED BELOW IS DRY, SAID AS DRY. See the marks below.
  const depth = Number.isFinite(d) && d > 0 ? `${Math.round(d)}`
    : (Number.isFinite(d) && drawdownFt != null ? 'dry' : null);
  const label = markLabel(kind);
  const id = String(stop.id || 'S');
  return {
    name: fitUnit(unitWords(label).map((w) => `${id} ${w}`), UNIT_CHARS.name),
    cmt: unitLabel(label, depth).cmt,
  };
}


// -- THE CUES, AS LINES THE UNIT CAN MAKE A BOUNDARY FROM ---------------------------------
//
// A waypoint on this unit is scenery. Measured against the whole 172-page manual on 2026-08-26:
// the word "proximity" does not appear in it, no waypoint carries an alarm, and the only
// distance-to-a-place alarm is Arrival, which fires on the ONE destination you are actively
// navigating to. Ryan, who owns it: "they do not work for just random waypoints."
//
// A BOUNDARY IS THE ONLY OBJECT THAT CAN SAY "YOU ARE NEAR A PLACE YOU ARE NOT GOING TO",
// and a hundred of them can be armed at once. It cannot be shipped -- his unit's own export
// contains waypoints, routes and tracks and no boundary at all -- but it can be MADE from a
// route in two taps: Where To > Routes > Edit Route > Save as Boundary. So the app writes the
// route and he converts the ones he wants. His framing, and it is the whole design in six
// words: "so you have trolling tracks and notification boundaries."
//
// WHY A TRIANGLE AND NOT THE LEG ITSELF. Converting closes the shape, and a leg closed end-to-
// start crosses itself on the return chord -- measured on his 8/26 plan, all five legs clean as
// open lines and every one of them gaining exactly one intersection when closed, which is the
// `Conversion failed. A boundary cannot have any intersections.` he hit. A small triangle has
// nothing to cross. Six 12-point rings converted on his unit at radii from 10 m to 100 m, four
// of them sitting on top of a leg, so neither size nor overlapping another object is a rule.
//
// The alarm on a converted object is Warning Dist. only -- all six came back offering no
// Entering/Exiting, because those belong to areas and circles drawn on the map. So the shape
// wants to be SMALL and the warning distance does the work: a 20 m triangle with a 50 yd
// warning is a disc, where a big ring would have been a doughnut.
const CUE_LINE_M = 20;

/**
 * How far a stop can sit from a leg's start before both deserve their own alarm. Two cues firing
 * in the same fifty yards is one cue and one nuisance.
 */
const CUE_FOLD_M = 100;

/**
 * The Contour alarm's half-width, in feet. Ryan, 2026-08-26: "i would probably give at least 5 ft
 * offset because i am hand steering." That is not a taste and not a guess -- it is the width of
 * the error he puts in himself, quoted from the man doing the steering. The same pair of numbers
 * sets `Sonar Setup > Alarms > Contour` (Shallow, Deep) and `Layers > Chart > Depth > Depth
 * Shading`, so one band is heard and seen.
 */
export const HAND_STEER_BAND_FT = 5;

/**
 * A NAME THE UNIT WILL NOT EAT. His route list showed `L1 · 15.1 ft` stored and displayed as
 * `L1  151 FT` -- separator gone, decimal gone, upcased -- while `L2 · 25.9 ft` beside it came
 * through whole. The period is the character that can turn one number into another, so no name
 * built here contains one.
 */
function cueSafe(s) {
  return String(s == null ? '' : s)
    .replace(/\./g, '-')
    .replace(/\u00b7/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

/**
 * The band he sets the Contour alarm and Depth Shading to for one leg -- `10-20ft` -- around
 * TODAY's water, because the alarm reads the sounder. One function for the leg's cue line and its
 * start waypoint, so the two names on the unit cannot give him two bands for one leg.
 */
function legBand(leg) {
  if (!leg || leg.depthFt == null) return null;
  const d = Math.round(Number(todayOnLeg(leg, leg.depthFt)));
  return Number.isFinite(d) ? `${d - HAND_STEER_BAND_FT}-${d + HAND_STEER_BAND_FT}ft` : null;
}

/** A triangle CUE_LINE_M across, centred on the cue. Closed by the unit it has no crossings. */
function cueTriangle(name, lat, lon, cueKind, legId, runId, color = null) {
  const dLat = (CUE_LINE_M / 2) / 111320;
  const dLon = (CUE_LINE_M / 2) / (111320 * Math.cos(lat * Math.PI / 180) || 1);
  return {
    name: cueSafe(name),
    pts: [[lat - dLat, lon - dLon], [lat + dLat, lon], [lat - dLat, lon + dLon]],
    cueKind, legId, planRunId: runId, smartPlan: true,
    // THE LEG'S COLOUR, so the boundary made from this draws like the track it belongs to. Save
    // ADM writes it (adm.js); a route in a GPX carries no colour, so there it goes unused.
    color,
  };
}

/** Each leg's id to the colour its track draws in, counted the way planTracks() counts. */
function legColours(plan) {
  const out = new Map();
  let trollN = 0;
  for (const leg of ((plan && plan.legs) || [])) {
    out.set(leg.id, legColor(leg, leg.type === 'troll' ? trollN : 0));
    if (leg.type === 'troll') trollN += 1;
  }
  return out;
}

/**
 * One cue line per stop, per lure change, and per trolling leg start.
 *
 * DERIVED FROM THE WAYPOINTS, NOT FROM A SECOND WALK OF THE PLAN. planWaypoints() already
 * resolved every one of these positions; walking the plan again would be a second source of the
 * same fact and the two would drift.
 *
 * The leg-start line carries the band in its NAME, because the alarm's job there is to remind him
 * to change a setting and the setting is what he needs to read: `L1 10-20ft`.
 *
 * `depth` cues get no line on purpose. Once the Contour alarm is set the sounder answers them
 * from the actual bottom, which is better than a place the plan guessed at.
 *
 * @param {object} plan
 * @param {Array}  waypoints  the output of planWaypoints()
 * @param {string} [runId]
 */
export function planCueLines(plan, waypoints = [], runId = null) {
  const out = [];
  const colours = legColours(plan);
  const band = new Map();          // waypoint -> the band its name should also carry
  for (const leg of ((plan && plan.legs) || [])) {
    if (leg.type === 'transit' || leg.depthFt == null) continue;
    const co = leg.coordinates || [];
    if (co.length < 2) continue;
    const text = legBand(leg);
    if (!text) continue;
    const near = waypoints.find((w) => w.castingStop && !band.has(w)
      && metresBetween(co[0], [w.lon, w.lat]) <= CUE_FOLD_M);
    if (near) band.set(near, text);
    else out.push(cueTriangle(`${leg.id} ${text}`, co[0][1], co[0][0], 'band', leg.id, runId,
                              colours.get(leg.id) || null));
  }
  for (const w of waypoints) {
    if (!(w.castingStop || w.lureChange)) continue;
    // A FOLDED STOP IS RENAMED, NOT APPENDED TO. `S1-1 hump 12ft 10-20ft` puts two depths in one
    // name and neither of them reads. The band is the half he has to act on -- it is why this
    // alarm exists -- and the stop's own structure and depth are already on the waypoint sitting
    // at the same spot, with the note. So the id identifies it and the band tells him what to do.
    const b = band.get(w);
    const id = cueSafe(w.name).split(' ')[0];
    out.push(cueTriangle(b ? `${id} ${b}` : (w.routeName || w.name), w.lat, w.lon,
                         w.lureChange ? 'change' : 'stop', w.legId || null, runId,
                         colours.get(w.legId) || null));
  }
  return out;
}

/**
 * One track per leg, in leg order. Pure — no state, no window.
 *
 * A leg with fewer than two vertices still produces a track, so the count always matches
 * `plan.legs.length`. A leg with no geometry is a `validatePlan()` problem and belongs on the
 * screen as one, not silently absent from the export.
 */
export function planTracks(plan, runId = null) {
  let trollN = 0;
  return ((plan && plan.legs) || []).map((leg, i) => {
    const t = {
      name: trackName(leg),
      pts: toLatLon(leg.coordinates),
      scoutRoute: true, smartPlan: true, planRunId: runId,
      planStep: leg.type, legRole: leg.role || null, legId: leg.id, legIndex: i,
      // THE COLOUR TRAVELS WITH THE TRACK. renderMap() used to derive one by matching the track
      // NAME against v1's phase names, which no v2 track has, so every leg of every v2 plan drew
      // in the same fallback magenta -- troll, deadhead and the run home indistinguishable.
      color: legColor(leg, leg.type === 'troll' ? trollN : 0),
      dashed: leg.type === 'transit',
      // A loop's way home: dashed on the map, drawn as fishing (it is), in its loop's darker shade.
      loopHome: (loopOf(leg) || {}).half === 'back',
      startM: leg.startM, lengthM: leg.lengthM,
    };
    if (leg.type === 'troll') trollN += 1;
    if (leg.depthFt != null) t.depthFt = leg.depthFt;
    return t;
  });
}

/** The launch, then one waypoint per stop at its own `at`, in the order the boat meets them. */
/**
 * The coordinate at an absolute distance along the day.
 *
 * `plan.changes[].atM` is cumulative metres from the launch, because a change is a thing that
 * happens at a PLACE on the run and PLAN_SCHEMA_V2 refuses to give it a time — Ryan, 2026-08-05:
 * "every time i catch a fish i am going to slow down or stop completely so more like it needs to
 * be a distance from thing not a time to thing." A distance is only useful to a chartplotter as
 * a coordinate, and this is the conversion.
 *
 * Walks the legs in order rather than trusting `startM` alone, so a plan whose legs were
 * reordered after assembly cannot silently place a change on the wrong water.
 */
function pointAtM(plan, atM) {
  if (!Number.isFinite(atM)) return null;
  for (const leg of ((plan && plan.legs) || [])) {
    const co = leg.coordinates || [];
    if (co.length < 2) continue;
    const s0 = leg.startM || 0;
    const len = leg.lengthM || 0;
    if (atM < s0 || atM > s0 + len) continue;
    if (!(len > 0)) return co[0];
    const k = Math.max(0, Math.min(co.length - 1,
                                   Math.round(((atM - s0) / len) * (co.length - 1))));
    return co[k];
  }
  // Past the end of the last leg, or before the first: the nearest end of the day is still a
  // real place, and a change with no coordinate cannot be loaded onto the unit at all.
  const legs = (plan && plan.legs) || [];
  const first = (legs[0] || {}).coordinates || [];
  const last = (legs[legs.length - 1] || {}).coordinates || [];
  if (!first.length) return null;
  return atM <= 0 ? first[0] : (last[last.length - 1] || first[0]);
}

/**
 * The id of the leg a distance along the day falls on, walked the way pointAtM() walks it, or null.
 * A lure change carries it so its boundary can be drawn in its leg's colour.
 */
function legAtM(plan, atM) {
  if (!Number.isFinite(atM)) return null;
  for (const leg of ((plan && plan.legs) || [])) {
    const s0 = leg.startM || 0;
    if (atM >= s0 && atM <= s0 + (leg.lengthM || 0)) return leg.id || null;
  }
  return null;
}// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THE CHARTPLOTTER DRAWS, AND WHY IT WAS ALL ONE ICON
//
// Ryan, 2026-09-18: *"i dont remember any symbols being used on my echomap..."*. He would not:
// every chart mark this file wrote carried `sym: 'Shallow Water'` -- a 25 ft hole and a 1 ft
// sandbar drew the same icon, and in the day he exported it was 80 marks and one exception.
//
// AND `Shallow Water` IS PROBABLY NOT EVEN A SYMBOL THE UNIT HAS. His ECHOMAP UHD2 93sv wrote its
// own GPX of 788 waypoints and used seven symbols, none of them that one, so the string was very
// likely falling through to the default pin on every mark.
//
// THE NAMES BELOW ARE FROM HIS OWN HARDWARE, not from a table on the web -- the handheld symbol
// lists Garmin publishes carry none of this. `Triangle, Red`, `Square, Red`, `Underwater Tree`,
// `Boat Ramp`, `Flag, Green`, `Flag, Red` and `Waypoint` came out of exports he made; `Ledge`,
// `Hump`, `Brush Pile`, `Dock`, `Fish Attractor`, `Rocks`, `Stump`, `Reef`, `Laydown` and
// `Underwater Grass` are ones he read off the picker. The shape-comma-colour form is his unit's,
// and the full grid -- circle, diamond, flag, pin, square, triangle in red, yellow, blue, green --
// is his account of what the picker holds.
//
// A NAME THE UNIT DOES NOT KNOW COSTS NOTHING. It falls back to the default pin, which is what
// every mark draws today, so a wrong guess here is exactly the status quo and a right one is free.
const MARK_SYMBOL = {
  ledge: 'Ledge',
  hump: 'Hump',
  pile: 'Brush Pile',
  timber: 'Underwater Tree',
  dock: 'Dock',
  dock_line: 'Dock',
  dock_cluster: 'Dock',
  attractor: 'Fish Attractor',
  // A HAZARD IS A ROCK OFTEN ENOUGH AND NEVER A FISH. `Rocks` is the only shape in the set that
  // reads as "do not run into this"; where the thing is not rocks the icon is still a warning,
  // which is the half that matters at 2 mph.
  hazard: 'Rocks',
  obstruction: 'Rocks',
  // Shallow is red by definition, not by measurement, so this one does not wait for a depth.
  shallow: 'Triangle, Red',
};

// The kinds with no symbol of their own get a shape, and the shape says WHAT while the colour
// says HOW DEEP -- see markSymbol(). A hole is a diamond because it is the prize; the bends are
// the two halves of one thing so they are the two roundest shapes; a creek mouth is a junction
// and squares read as junctions.
// `markLabel()` no longer renames a cove or a point after a bend, so the two bend keys this table
// carried are gone with it -- a cove was already Circle and a point already Triangle, so no shape on
// the plotter moves. A hole named `outside bend hole` misses on the label and falls through to
// `hole`, which is the Diamond it always was.
const MARK_SHAPE = {
  hole: 'Diamond',
  cove: 'Circle',
  point: 'Triangle',
  creek_mouth: 'Square',
};

// ── DEPTH IS THE COLOUR, BECAUSE DEPTH IS WHAT HE STEERS ON ───────────────────────────────────
//
// The number is already in the waypoint's NAME -- `hole 25ft` -- and a name on a chartplotter is
// read by zooming in on one mark at a time. The colour is read across the whole screen at once.
//
// THE BANDS ARE NOT INVENTED HERE. Six feet is TRANSIT_MIN_DEPTH_FT, the figure Ryan gave on
// 2026-08-30 for how shallow he will cross water he is not fishing -- "i am not portaging the
// kayak over an island" -- and three is where the charted contours stop resolving a channel on
// the rivers he fishes. Twelve is two sixes: deep enough to cross twice over.
const MARK_COLOUR = [[12, 'Blue'], [6, 'Green'], [3, 'Yellow'], [0, 'Red']];

// ── A CHARTED MARK WITH NO CHARTED DEPTH, AND IT IS NOT THE DEFAULT PIN ───────────────────────
//
// Shape is the KIND and colour is the DEPTH, so a mark whose depth the chart does not give has a
// shape and no colour to put it in -- and Garmin has no uncoloured Diamond. Every one of the four
// colours is a depth band, so borrowing one would make `Diamond, Blue` mean both "hole, 12 ft or
// more" and "hole, nobody knows", which is the `0 ft relief` defect wearing a colour.
//
// THIS RETURNED `Waypoint` AND THAT WAS MY INVENTION, NOT A DECISION. Benched on the live app
// 2026-09-18: 43 of the day's 123 waypoints came out as the bare default pin, every one of them a
// mark resolveStructure() could not give a depth. I wrote that up as "a decision about Ryan's symbol
// set" and pinned it in a test, which made my guess look like his call. He had already given the
// whole vocabulary -- "Circles, Diamonds, Flags, Pins, Squares, and Triangles in Red, Yellow, Blue,
// and Green" -- and FLAG IS UNUSED BY THIS FILE. There was a free slot the entire time.
//
// `Flag, Blue`, and the colour does not matter because no depth-coloured mark is a flag: a flag
// cannot be misread as a depth band the way a borrowed Diamond colour would be. It is in his own
// ActiveCaptain export (16 `Flag, Green`, 10 `Flag, Red` of the 41 he sampled), so it renders on his
// unit, and it beats `Waypoint` for the reason these marks exist at all -- the desc says "charted
// position — compare with the sounder", and the mark the chart could not put a number on is the one
// most worth comparing. The KIND is still in the name; `Waypoint` threw away that this was one of
// ours at all, which is the same icon an unclassified user pin gets.
const MARK_UNKNOWN_DEPTH = 'Flag, Blue';

/**
 * The Garmin symbol for one chart mark. `Waypoint` -- the default pin -- only where the KIND is
 * unknown, which is the one case nothing here can say anything about.
 */
export function markSymbol(type, bendSide, depthFt) {
  const named = MARK_SYMBOL[type];
  if (named) return named;
  // The shape is the KIND, so the river form of the label is not asked for here: `outside bend hole`
  // misses and falls through to `hole`'s Diamond, which is the same shape the mark always had.
  const shape = MARK_SHAPE[markLabel(type, bendSide)] || MARK_SHAPE[type];
  if (!shape) return 'Waypoint';
  const d = Number(depthFt);
  if (!Number.isFinite(d) || d <= 0) return MARK_UNKNOWN_DEPTH;
  const band = MARK_COLOUR.find(([floor]) => d >= floor);
  return `${shape}, ${band[1]}`;
}




/**
 * The leg start's comment, the second line on the unit: the two settings he makes there, in twenty
 * characters. `alarm 27-37 shd28-38` where the chart's shading pair differs from today's alarm
 * pair, `alarm & shade 27-37` where they are the same.
 */
function startComment(band, shade) {
  if (!band) return null;
  const b = band.replace(/ft$/, '');
  const s = shade ? shade.replace(/ft$/, '') : b;
  if (s === b) {
    return fitUnit([`alarm & shade ${band}`, `alarm & shade ${b}`, `alarm+shade ${b}`], UNIT_CHARS.comment);
  }
  return fitUnit([`alarm ${b} shade ${s}`, `alarm ${b} shd ${s}`, `alarm ${b} shd${s}`,
                  `alm ${b} shd${s}`, `${b} / ${s}`], UNIT_CHARS.comment);
}

export function planWaypoints(plan, launch = null, runId = null, opts = {}) {
  const out = [];
  if (Array.isArray(launch) && Number.isFinite(launch[0]) && Number.isFinite(launch[1])) {
    out.push({ name: 'Launch', lat: launch[1], lon: launch[0], sym: 'Boat Ramp',
               role: 'launch_ramp', scoutWaypoint: true, planRunId: runId });
  }
  // ── WHERE EACH LEG STARTS AND ENDS, AS A PLACE HE CAN GO TO ─────────────────────────────────
  //
  // Ryan, 2026-09-27: "for navigating a track it only gives you from beginning or end and then
  // draws a line to get to track but doesn't get you to the beginning". Follow Track offers Forward
  // or Backward and nothing else (UHD2 manual, "Browsing for and Navigating a Recorded Track"), and
  // nothing on the unit marked where a leg starts: his 9/28 plan wrote the ramp, four stops and 34
  // structure marks, and the only object at a leg's start was its cue route. A waypoint is what Go
  // To takes him to. Offered this, a date on every name and fewer cue routes, he chose this.
  //
  // `Flag, Green` and `Flag, Red` came out of his own unit's exports (see MARK_SYMBOL), and no other
  // mark in this file is a green or a red flag, so a start and an end read as what they are.
  //
  // THE START CARRIES THE BAND, the same text as the leg's cue line (legBand), because the start is
  // where he sets the Contour alarm and Depth Shading for the leg.
  //
  // ONE END MARK PER PLACE, AND THE PLACE IS EXACT. A leg fished back starts on the very coordinate
  // the one before it ended on, and ends on that one's start. There the start is kept -- `L2 start`
  // says what to do at that spot and `L1 end` would sit on top of it. Equal coordinates, not near
  // ones: no distance is chosen here.
  //
  // BUT EVERY START GETS ITS FLAG, even where starts share a spot. This kept the first mark to claim
  // a spot, which was harmless while only an end could land on a start -- and then the day became
  // loops from the ramp, all of them starting on one coordinate. Ryan's 10/5 Rowland plan (built
  // 10/4): three loops, and the one green flag at their start read `L1 22-32ft`; nothing on the unit
  // but the cue routes said 18-28 for loop 2 or 14-24 for loop 3, which is the one thing a start is
  // there to tell him. *"you can fix the little things you found"*. A start is dropped now only when
  // an earlier start on that spot already carries the same band -- a third pass of one leg, which
  // starts where the first did and is set the same, still gets no second flag.
  const legs = ((plan && plan.legs) || []).filter((leg) => leg.type !== 'transit'
    && Array.isArray(leg.coordinates) && leg.coordinates.length >= 2);
  const sameSpot = (p, q) => p[0] === q[0] && p[1] === q[1];
  const startSpots = legs.map((leg) => leg.coordinates[0]);
  const placed = [];
  const startsPlaced = [];
  for (const leg of legs) {
    const co = leg.coordinates;
    const start = co[0];
    const end = co[co.length - 1];
    const band = legBand(leg);
    // Depth Shading paints the CHART, which has no level offset on the unit, so where the lake is
    // off its chart's level the shading pair is the chart's and only the alarm's is today's.
    const shade = legBand({ ...leg, drawdownFt: null });
    // `L3 27-37ft`, NOT `L3 start 27-37ft`: his unit keeps ten characters, and that read
    // `L3 start 2`. The green flag already says it is a start; the band is what he sets there.
    const startName = band ? fitUnit([cueSafe(`${leg.id} ${band}`), cueSafe(`${leg.id} ${band.replace(/ft$/, '')}`)],
                                     UNIT_CHARS.name)
      : cueSafe(`${leg.id} start`);
    if (!startsPlaced.some((p) => sameSpot(p.at, start) && p.band === band)) {
      startsPlaced.push({ at: start, band });
      placed.push(start);
      out.push({
        name: startName,
        cmt: startComment(band, shade),
        lat: start[1], lon: start[0], sym: 'Flag, Green',
        legStart: true, scoutWaypoint: true, planRunId: runId,
        legId: leg.id, atM: leg.startM || 0,
        tacticalNote: !band ? `start of ${leg.id}`
          : shade && shade !== band
            ? `start of ${leg.id}: Contour alarm ${band}; Depth Shading ${shade} on the chart`
            : `start of ${leg.id}: Contour alarm and Depth Shading ${band}`,
      });
    }
    if (!startSpots.some((p) => sameSpot(p, end)) && !placed.some((p) => sameSpot(p, end))) {
      placed.push(end);
      out.push({
        name: cueSafe(`${leg.id} end`),
        lat: end[1], lon: end[0], sym: 'Flag, Red',
        legEnd: true, scoutWaypoint: true, planRunId: runId,
        legId: leg.id, atM: (leg.startM || 0) + (leg.lengthM || 0),
        tacticalNote: `end of ${leg.id}`,
      });
    }
  }
  for (const leg of ((plan && plan.legs) || [])) {
    for (const s of (leg.stops || [])) {
      const at = Array.isArray(s.at) && s.at.length === 2 ? s.at : null;
      if (!at || !Number.isFinite(at[0]) || !Number.isFinite(at[1])) continue;
      const unit = stopUnit(s, legDrawdown(leg));
      out.push({
        name: unit.name, cmt: unit.cmt, lat: at[1], lon: at[0], sym: 'Fishing Area',
        // A route keeps fifteen, so the stop's cue line has room for the depth too.
        routeName: fitUnit([`${s.id} ${unit.cmt}`, unit.name], UNIT_CHARS.route),
        // `castingStop` is what parsers.js:111 turns into the GPX type CAST and what
        // smart-plan-ui.js filters on, so a stop written here replaces the one it would make
        // rather than sitting beside it.
        castingStop: true, scoutWaypoint: true, planRunId: runId,
        legId: leg.id, stopId: s.id, atM: leg.startM + s.atM,
        // Today's, like the name: the GPX comment is read against the sounder too.
        depth: s.depthFt != null ? todayOnLeg(leg, Number(s.depthFt)) : null,
        chartDepth: s.depthFt ?? null,
        structureType: s.structureType || null,
        tacticalNote: s.why || s.presentation || '',
      });
    }
  }
  // ── EVERY LURE CHANGE, AS A MARK AT THE PLACE IT HAPPENS ─────────────────────────────────
  //
  // Ryan, 2026-08-26: "for the bait changes and other fishing notifications those need to be
  // location based using gps."
  //
  // THIS IS NOT THAT, AND IT IS NOT PRETENDING TO BE. Nothing here alarms. What it fixes is
  // narrower and was true regardless: `plan.changes` has carried `atM` since assemblePlan() was
  // written, and nothing ever turned one into a place. Stops were exported as waypoints, chart
  // marks were exported as waypoints, and the changes — the one cue class he actually asked to be
  // told about — had no waypoint at all. So the spot where the plan says to retie was the one
  // spot on the day that was blank on the chart.
  //
  // WHAT DELIVERY LOOKED LIKE WHEN THIS WAS WRITTEN, so the next session does not re-walk it:
  //   - The phone cannot do it with the app closed. Chrome never shipped background geolocation
  //     for a PWA, a service worker cannot call navigator.geolocation, and the Geofencing API was
  //     abandoned. `watchPosition()` runs only in the foreground; his phone rides in a PFD pocket
  //     with the screen off.
  //   - The ECHOMAP cannot do it either. Its Arrival alarm fires on "a turn or a destination",
  //     which means a route — and Ryan, who owns the unit: "arrival alarms only work on routes
  //     not tracks... they do not work for just random waypoints", and "you can't have a route
  //     and a track displayed at the same time". A route carrying the alarms costs the track
  //     carrying the path. His call, 2026-08-26: "using the echomap for this is not going to
  //     work."
  //
  // Unresolved on purpose. A mark at the place is worth having on its own.
  for (const c of ((plan && plan.changes) || [])) {
    const at = pointAtM(plan, c.atM);
    if (!at || !Number.isFinite(at[0]) || !Number.isFinite(at[1])) continue;
    const rod = String(c.rodId || 'rod').replace(/^rod\s*/i, 'R');
    const to = String(c.to || '').trim();
    out.push({
      // SHORT, AND THE LURE LAST SO TRUNCATION EATS THE LEAST USEFUL END. The 93sv clips a long
      // name, and this is read at 2 mph with wet hands: which rod, then what goes on it. It keeps
      // ten characters (see UNIT_CHARS), so no separator spends two of them; the comment says the
      // whole lure.
      name: fitUnit([`${rod} ${to}`], UNIT_CHARS.name),
      cmt: fitUnit([`${rod} tie on ${to}`, `${rod} ${to}`], UNIT_CHARS.comment),
      routeName: fitUnit([`${rod} ${to}`], UNIT_CHARS.route),
      legId: legAtM(plan, c.atM),
      // NOT `Fish`. His unit's own export used seven symbols and that was not one of them, so it
      // was very likely drawing as the default pin. A blue pin is in the grid he read off the
      // picker, and a bait change is an ACTION rather than a piece of structure -- so it gets the
      // one shape nothing else in this file uses.
      lat: at[1], lon: at[0], sym: 'Pin, Blue',
      lureChange: true, scoutWaypoint: true, planRunId: runId,
      changeId: c.id, atM: c.atM,
      structureType: null,
      tacticalNote: [to ? `tie on ${to}` : null, c.from ? `off ${c.from}` : null,
                     c.cost === 'fluoro' ? 'fluoro leader — retie' : 'snap swap',
                     c.why || null].filter(Boolean).join(' · '),
    });
  }

  // STRUCTURE THE LEGS GO BY, as its own waypoint class.
  //
  // Opt-in, because it is a different job from the stops. A stop is somewhere to fish; these are
  // there to be CHECKED -- Garmin's charted position against what the sounder actually shows,
  // which is the only way the packs' accuracy ever gets measured. On a Wateree leg that is a
  // handful of marks; card-wide it would be thousands, so it is never on by default.
  //
  // `chartMark: true` rather than `castingStop`, so parsers.js does not turn them into CAST
  // waypoints and smart-plan-ui does not list them as places to stop.
  if (opts.marks) {
    // ONE HUMP IS ONE WAYPOINT.
    //
    // A structure sits in the `near[]` of every nested contour that passes it, so the same hump
    // resolves once per mark and each resolution lands a metre or two from the last. Measured on
    // an exported Wateree day: 29 waypoints at 17 real positions, with "hump 10ft" written
    // FIFTEEN times across four spots inside six metres. That is what loads onto the Garmin.
    //
    // castSpots() in plan-water.js already solved this by collapsing on identity rather than on a
    // grid of guesses; this writer never got it. 15 m, by kind — two humps that close are one
    // hump seen twice, and two different kinds at one spot are two real things.
    // CHAINED, NOT MEASURED FROM THE ONE THAT WON. The four spots in the real export span 28 m
    // end to end but sit 9 m apart in a line, so testing each against the emitted point kept two
    // of them. Every position seen joins the chain whether it was emitted or not, which is the
    // single-linkage rule clusterDocks() already uses on the same kind of data.
    const seen = [];
    const seenBefore = (type, lon, lat) => seen.some(([t, x, y]) => t === type
      && Math.hypot((x - lon) * 92000, (y - lat) * 111320) <= 15);
    for (const leg of ((plan && plan.legs) || [])) {
      for (const m of (leg.marks || [])) {
        const at = Array.isArray(m.at) && m.at.length === 2 ? m.at : null;
        if (!at || !Number.isFinite(at[0]) || !Number.isFinite(at[1])) continue;
        // ── A BANK BULGE IS NOT A TROLL-OVER TARGET, SO IT IS NOT A WAYPOINT ──────────────────
        //
        // Ryan, 2026-09-19: *"which of those is something that a fishing report or guide would tell
        // us to fish? which are targets to troll over"*. Answered out of his own researched profile
        // for this water rather than out of an opinion. congaree_river, Largemouth Bass:
        //
        //     summer   structures: ["shoreline", "woody cover", "steep slopes", "deep holes"]
        //     fall     structures: ["shoreline", "deep holes"]
        //
        // Deep holes and steep slopes are the pack's `hole` and `ledge`, and they are what a bait is
        // dragged over. The bulge in the bank is neither: on the inside of a bend it is a point bar
        // he would rather not cross, and on the outside it is slack water fish sit in beside the
        // scour -- a thing to know, not a thing to steer onto. 46 of the 98 waypoints on his
        // 2026-09-19 export were those bulges.
        //
        // THEY ARE NOT DROPPED FROM THE PLAN, only from the plotter. The mark stays on the leg, so
        // describeStructure's "on the outside of the bend" still reaches the model and the leg's own
        // notes can say there is slack water on the outer bank here.
        // A DRIFT LEG IS A RIVER LEG. `runId` is `<slug>:drift:<lane>@<station>` on moving water and
        // nothing of the kind on a lake, so this asks the leg rather than needing a new field. The
        // side is NOT part of the test: 7 of the Congaree's bank features carry no bend side because
        // their reach is straight, and they were still reaching the plotter as "cove".
        const onRiver = /:drift:/.test(String(leg.runId || ''));
        if (onRiver && (m.type === 'cove' || m.type === 'point')) continue;
        const dup = seenBefore(m.type, at[0], at[1]);
        seen.push([m.type, at[0], at[1]]);
        if (dup) continue;
        // The name carries the charted feature's depth where there is one, because the whole
        // point is to stand it next to the sounder and see whether they agree -- so it is the
        // depth the SOUNDER should read: the chart less the lake's drawdown today (see
        // todayOnLeg at the top). The chart's own figure goes in the note. No depth means no
        // number in the name -- an empty field reads as "the chart does not say", a zero would not.
        const dd = legDrawdown(leg);
        const today = Number.isFinite(m.depthFt) ? todayOnLeg(leg, m.depthFt) : null;
        // DRY IS A WORD, NOT A NEGATIVE DEPTH. The chart less the drawdown goes below zero on a
        // feature the lake has dropped off: Ryan's 9/27 Murray GPX carried "point -4ft" and
        // "cove -4ft", charted at 1.4 and 1.6 ft with the lake 5.56 ft down. Kept on the unit --
        // annotate, never filter -- and named for what it is today.
        const dry = dd != null && Number.isFinite(today) && today <= 0;
        // A POINT OR A COVE IS TWO DEPTHS, AND THE MARK SITS ON THE SHALLOW ONE. Ryan, 2026-09-28,
        // on `point 31ft` at 34.37479, -80.72916: "it's sitting on the bank in less than 5 ft of
        // water". The pack's feature there is `shallow_side_ft 0.4, deep_side_ft 34.3,
        // deepest_within_m 39`: the mark is the tip, on the bank, and the number was the deepest
        // water within 39 m of it. So the name gives both ends, tip first, each in today's water,
        // and the note says how far off the tip the deep one is. A feature with no shallow side
        // keeps the one number it has.
        const shallowToday = Number.isFinite(m.shallowFt) ? todayOnLeg(leg, m.shallowFt) : null;
        const tip = shallowToday == null ? null
          : (dd != null && shallowToday <= 0) ? 'dry' : `${Math.max(0, Math.round(shallowToday))}`;
        // The depth as the unit shows it: `dry`, `dry-33`, `0-34`, `25`. unitLabel() puts it in the
        // ten characters whole and shortens the word around it -- `pt dry-33` -- and the comment
        // says `point dry-33ft`.
        const depthText = dry ? 'dry'
          : tip != null && Number.isFinite(today) ? `${tip}-${Math.round(today)}`
          : Number.isFinite(today) ? `${Math.round(today)}` : null;
        const unit = unitLabel(markLabel(m.type, m.side, onRiver), depthText);
        // ONLY WHERE IT IS ONE. `charted` is false when no feature resolved and the pin is the
        // point on the line at that distance, which is not a charted position and must not say it
        // is -- the whole point of the note is that he stands it next to the sounder.
        const where = m.charted === false
          ? 'position along the line \u2014 the chart does not place this one'
          : 'charted position \u2014 compare with the sounder';
        // `dd` is the lake against the level its chart was made at (poolOffsetFt), which is the
        // drawdown only where that level is full pool, so the sentence names the chart's level.
        const lake = dd == null ? ''
          : ` today with the lake ${Math.abs(dd)} ft ${dd > 0 ? 'below' : 'above'} the level its chart was made at`;
        const deepNote = Number.isFinite(m.depthFt)
          ? `${m.depthFt} ft on the chart${dd != null ? `, ${dry ? 'out of the water' : `${today} ft`}${lake}` : ''}`
          : null;
        const tipNote = shallowToday == null ? null
          : `the mark is the tip, ${m.shallowFt} ft on the chart${dd != null
              ? (tip === 'dry' ? ', out of the water today' : `, ${shallowToday} ft today`) : ''}; `
            + `the deep side is ${deepNote || 'not charted'}`
            + (Number.isFinite(m.deepWithinM) ? `, within ${Math.round(m.deepWithinM)} m of the tip` : '');
        out.push({
          name: unit.name, cmt: unit.cmt,
          lat: at[1], lon: at[0], sym: markSymbol(m.type, m.side, today),
          chartMark: true, scoutWaypoint: true, planRunId: runId,
          legId: leg.id, markId: m.id, atM: (leg.startM || 0) + (m.atM || 0),
          depth: today,
          chartDepth: m.depthFt ?? null,
          structureType: m.type || null,
          tacticalNote: tipNote ? `${where}; ${tipNote}`
            : (dd != null && deepNote) ? `${where}; ${deepNote}`
            : where,
        });
      }
    }
  }
  return out;
}

/**
 * Replace this run's tracks and waypoints in `state.DATA`, leaving the user's own loaded GPX
 * alone. Returns what it wrote, so the caller can report it and a test can assert on it.
 *
 * @param {object} plan       from assemblePlan()
 * @param {object} [o]
 * @param {number[]} [o.launch] [lon, lat] of the ramp
 * @param {object} [o.win]    where to publish the run id (the browser passes `window`)
 */
export function materialisePlan(plan, o = {}) {
  const runId = o.runId || `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const win = o.win || (typeof window !== 'undefined' ? window : null);
  if (win) win._smartPlanRunId = runId;

  if (!state.DATA) state.DATA = {};
  if (!Array.isArray(state.DATA.tracks)) state.DATA.tracks = [];
  if (!Array.isArray(state.DATA.waypoints)) state.DATA.waypoints = [];
  if (!Array.isArray(state.DATA.routes)) state.DATA.routes = [];

  const tracks = planTracks(plan, runId);
  const waypoints = planWaypoints(plan, o.launch, runId, { marks: o.marks });
  const cueLines = planCueLines(plan, waypoints, runId);

  // Everything this app generated goes; everything the user loaded stays.
  state.DATA.tracks = [...state.DATA.tracks.filter((t) => !t.scoutRoute && !t.smartPlan), ...tracks];
  state.DATA.waypoints = [...state.DATA.waypoints.filter((w) => !w.scoutWaypoint && !w.castingStop
                                                                && !w.chartMark),
                          ...waypoints];
  // The cue lines are ours the same way the tracks are, so the cleaner treats them the same.
  state.DATA.routes = [...state.DATA.routes.filter((r) => !r.smartPlan), ...cueLines];

  return { runId, tracks: tracks.length, waypoints: waypoints.length,
           cueLines: cueLines.length,
           trackPoints: tracks.reduce((a, t) => a + t.pts.length, 0) };
}
