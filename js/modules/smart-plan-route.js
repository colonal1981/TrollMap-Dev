/**
 * smart-plan-route.js — turn SmartPlan's intent into geometry the Worker built.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHAT THIS REPLACES, AND WHY
 *
 * SmartPlan used to build its own route in the browser: stitchContourFragments() joined contour
 * pieces, walkContourForWaypoints() walked the result dropping a waypoint every 150 ft, and
 * buildScoutRoutes() connected those waypoints with straight lines and added a sine wave so the
 * result looked like trolling passes.
 *
 * Ryan's three complaints were all one cause -- it had a list of points and no model of the
 * water:
 *
 *   "with the i-boating contours it wouldn't actually follow a contour"
 *     i-Boating's longest continuous run was 1.68 km, so there was nothing to follow. Garmin's
 *     12.1 ft line on Wateree stitches to 45.34 km, and build_trolling_runs.py has already done
 *     that stitching offline against the real geometry.
 *
 *   "we couldn't get it to figure out how to leave us in the right position for the next leg"
 *     Every leg now begins at the node the previous leg ended on. That is a type constraint in
 *     the router, not a repair -- the old behaviour is unrepresentable.
 *
 *   "it would reset back to no where near where it left off and then draw a connecting route
 *    over land"
 *     Connections are shortest paths over the MAR navigation graph, so they cannot cross land
 *     by construction, and the whole plan is re-validated at the end.
 *
 * So this module sends INTENT and receives GEOMETRY. It computes nothing about where the boat
 * goes. The straight-line-between-waypoints code it replaces is why a connecting line went
 * wherever a straight line went.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No scoring, no ranking, no "best" leg. `has` and `relief` are FILTERS. Ryan, 2026-08-06:
 * "depends on the species, time of year, lake forage... like this isn't something a script can
 * solve." Which water is worth fishing lives in the app's trollingIntelligence and in the
 * model's read of the day; this file only asks the question the model formed.
 *
 * IT FAILS LOUDLY. There is no fallback to the old in-browser walker: falling back would mean
 * keeping the thing being removed, and a plan drawn over land is worse than no plan. When the
 * route service cannot answer, the reason is returned and the caller says so.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { resolveR2Key } from '../data/lake-keys.js';

const FT_PER_M = 3.28084;
const PLAN_TIMEOUT_MS = 15000;

/**
 * Ask the Worker for a plan. Returns { ok, plan } or { ok: false, reason }.
 *
 * `bands` are SmartPlan's depth phases as the model chose them; `budgetsFt[i]` is how far the
 * angler can actually fish in phase i, which the caller already computes from trip duration and
 * pass speed.
 */
export async function requestPlan({ lakeName, bands, rampLat, rampLon, rangeMiles, budgetsFt }) {
  const slug = resolveR2Key(lakeName);
  if (!slug) return { ok: false, reason: `no chartpack for "${lakeName}"` };
  if (!Number.isFinite(rampLat) || !Number.isFinite(rampLon)) {
    return { ok: false, reason: 'no launch point — pick an access point first' };
  }

  const legs = [];
  (bands || []).forEach((b, i) => {
    const lo = Number(b.depthMin), hi = Number(b.depthMax);
    if (!Number.isFinite(lo) && !Number.isFinite(hi)) return;
    // A single depth, because the router asks the pack for the NEAREST CHARTED line. Garmin's
    // contours are metric-derived -- near twelve feet the charted lines are 11.2 and 12.1 with
    // nothing between -- so a request for "12" is answered with 12.1 and says so. Sending a
    // band and hoping something falls inside it is how the old code found nothing.
    const mid = Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2
              : (Number.isFinite(lo) ? lo : hi);
    const ft = Math.round(mid * 10) / 10;
    const budget = Number(budgetsFt?.[i]);
    const length_m = Math.round((Number.isFinite(budget) && budget > 0 ? budget : 6560) / FT_PER_M);
    legs.push({ depth_ft: ft, length_m });
  });
  if (!legs.length) return { ok: false, reason: 'no usable depth bands in the plan' };

  const body = {
    launch: [rampLon, rampLat],
    legs,
    return_to_launch: true,
    // Range is one-way; the trip is out and back, and the router counts every metre it moves.
    max_total_m: Math.round((Number(rangeMiles) || 5) * 1609.34 * 2),
  };

  let res, plan;
  try {
    res = await fetch(`${CF_WORKER_URL}/water/${encodeURIComponent(slug)}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout?.(PLAN_TIMEOUT_MS),
    });
    plan = await res.json();
  } catch (err) {
    return { ok: false, reason: `route service unreachable: ${err.message}` };
  }
  if (!res.ok) {
    // 404 means this pack has no trolling_runs or no water_graph -- a real and common state
    // while the upload catches up, and worth distinguishing from a bad request.
    return { ok: false, status: res.status, reason: plan?.error || `plan failed (${res.status})`, plan };
  }
  return { ok: true, slug, plan };
}

/**
 * Put a returned plan into state.DATA as tracks and waypoints.
 *
 * Coordinates come back [lon, lat] (GeoJSON order) and everything in state.DATA is [lat, lon].
 * That flip is the single most likely place for this to go quietly wrong, so it happens here,
 * once, and nowhere else.
 */
export function renderPlan(plan, { rampLat, rampLon } = {}) {
  // Every track and waypoint this call creates is stamped with the SAME id, and the id is
  // published so the cleaner can tell THIS run's output from a previous one's.
  //
  // 2026-08-09: without it, SmartPlan built four tracks on every run and shipped zero. renderPlan
  // tags its tracks `smartPlan: true`; isSmartPlanTrack() in smart-plan.js matches that exact
  // flag; so clearExistingSmartPlanTracks(), whose job is wiping the PREVIOUS run, could not tell
  // the two apart and deleted what had just been built. The console said "2 troll, 2 transit"
  // and the GPX said `"tracks": 0`. Reordering the calls would also fix it and would be one
  // refactor away from breaking again -- an id cannot be undone by call order.
  const runId = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (typeof window !== 'undefined') window._smartPlanRunId = runId;

  if (!state.DATA) state.DATA = {};
  if (!Array.isArray(state.DATA.waypoints)) state.DATA.waypoints = [];
  if (!Array.isArray(state.DATA.tracks)) state.DATA.tracks = [];
  state.DATA.waypoints = state.DATA.waypoints.filter((w) => !w.scoutWaypoint);
  state.DATA.tracks = state.DATA.tracks.filter((t) => !t.scoutRoute);

  if (Number.isFinite(rampLat) && Number.isFinite(rampLon)) {
    state.DATA.waypoints.push({ name: 'Launch', lat: rampLat, lon: rampLon,
                                sym: 'Boat Ramp', role: 'launch_ramp', scoutWaypoint: true });
  }

  let trollN = 0, transitN = 0;
  for (const step of plan.steps || []) {
    const pts = (step.coordinates || []).map(([lon, lat]) => [lat, lon]);
    if (pts.length < 2) continue;

    if (step.type === 'troll') {
      trollN += 1;
      const ft = step.depth_ft;
      const bits = [`Leg ${step.leg}`, `${ft} ft`];
      if (step.relief) bits.push(String(step.relief).replace(/_/g, ' '));
      if (step.closed) bits.push('ring');
      state.DATA.tracks.push({
        name: `${bits.join(' · ')} — ${(step.length_m / 1000).toFixed(1)} km`,
        pts, scoutRoute: true, smartPlan: true, planRunId: runId, planStep: 'troll',
        phase: step.leg, depthFt: ft,
      });
      // One waypoint at the head of each leg, so the existing GPX export and the plan timeline
      // still have something to hang off. The ROUTE is the track; these are labels, not the
      // geometry, which is the inversion this whole rebuild is about.
      state.DATA.waypoints.push({
        name: `Leg${step.leg} ${ft}ft`, lat: pts[0][0], lon: pts[0][1],
        sym: 'Fishing Area', scoutWaypoint: true, planRunId: runId, phase: step.leg, depth: ft,
      });
    } else {
      transitN += 1;
      state.DATA.tracks.push({
        name: step.to === 'launch' ? 'Return to launch' : `Transit ${transitN}`,
        pts, scoutRoute: true, smartPlan: true, planRunId: runId, planStep: 'transit',
      });
    }
  }
  return { trollN, transitN, waypoints: state.DATA.waypoints.filter((w) => w.scoutWaypoint).length };
}

/** One line a human can read, for the plan output and the console. */
export function describePlan(plan) {
  const km = (m) => (m / 1000).toFixed(1);
  const v = plan.validation || {};
  const bits = [
    `${plan.legs} leg(s)`,
    `${km(plan.fishing_m)} km fishing of ${km(plan.total_m)} km total`,
    plan.fishing_fraction != null ? `${Math.round(plan.fishing_fraction * 100)}% fishing` : null,
    plan.valid ? 'every point over charted water' : 'NOT VALID — see notes',
    v.points_checked ? `${v.points_checked} points checked, ${v.off_water} off water` : null,
    v.worst_seam_m != null ? `worst seam ${v.worst_seam_m} m` : null,
  ].filter(Boolean);
  return bits.join(' · ');
}
