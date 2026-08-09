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
import { LEG_COLORS, TRANSIT_COLOR, RETURN_COLOR } from './plan-to-timeline.js';

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
  return LEG_COLORS[trollOrdinal % LEG_COLORS.length];
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

/** `L1 · 16.1 ft` / `T2 · transit`. Readable at a glance on a 4-inch screen. */
export function trackName(leg) {
  if (!leg) return '';
  // The run home is the leg he most needs to find on the unit at 19:00, so it says so rather
  // than being the third thing called "transit".
  if (leg.type === 'transit') return `${leg.id} · ${leg.role === 'return' ? 'home' : 'transit'}`;
  return leg.depthFt != null ? `${leg.id} · ${leg.depthFt} ft` : `${leg.id} · troll`;
}

/** `S1.1 · hump 14ft`. The id first, because that is what the timeline calls it. */
export function stopName(stop) {
  const what = String(stop.structureType || stop.structure || 'cast').split(',')[0];
  const ft = Number.isFinite(Number(stop.depthFt)) ? ` ${Math.round(Number(stop.depthFt))}ft` : '';
  return trim(`${stop.id} · ${what}${ft}`, 24);
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
      startM: leg.startM, lengthM: leg.lengthM,
    };
    if (leg.type === 'troll') trollN += 1;
    if (leg.depthFt != null) t.depthFt = leg.depthFt;
    return t;
  });
}

/** The launch, then one waypoint per stop at its own `at`, in the order the boat meets them. */
export function planWaypoints(plan, launch = null, runId = null) {
  const out = [];
  if (Array.isArray(launch) && Number.isFinite(launch[0]) && Number.isFinite(launch[1])) {
    out.push({ name: 'Launch', lat: launch[1], lon: launch[0], sym: 'Boat Ramp',
               role: 'launch_ramp', scoutWaypoint: true, planRunId: runId });
  }
  for (const leg of ((plan && plan.legs) || [])) {
    for (const s of (leg.stops || [])) {
      const at = Array.isArray(s.at) && s.at.length === 2 ? s.at : null;
      if (!at || !Number.isFinite(at[0]) || !Number.isFinite(at[1])) continue;
      out.push({
        name: stopName(s), lat: at[1], lon: at[0], sym: 'Fishing Area',
        // `castingStop` is what parsers.js:111 turns into the GPX type CAST and what
        // smart-plan-ui.js filters on, so a stop written here replaces the one it would make
        // rather than sitting beside it.
        castingStop: true, scoutWaypoint: true, planRunId: runId,
        legId: leg.id, stopId: s.id, atM: leg.startM + s.atM,
        depth: s.depthFt ?? null,
        structureType: s.structureType || null,
        tacticalNote: s.why || s.presentation || '',
      });
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

  const tracks = planTracks(plan, runId);
  const waypoints = planWaypoints(plan, o.launch, runId);

  // Everything this app generated goes; everything the user loaded stays.
  state.DATA.tracks = [...state.DATA.tracks.filter((t) => !t.scoutRoute && !t.smartPlan), ...tracks];
  state.DATA.waypoints = [...state.DATA.waypoints.filter((w) => !w.scoutWaypoint && !w.castingStop),
                          ...waypoints];

  return { runId, tracks: tracks.length, waypoints: waypoints.length,
           trackPoints: tracks.reduce((a, t) => a + t.pts.length, 0) };
}
