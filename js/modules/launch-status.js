/**
 * launch-status.js -- is the launch open, by Google's listing, said on the plan.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-10-01: *"I think we talked about having smartplan use my google maps api key to
 * check for ramp closures... did that get done?"* It had not. The only closure the app knew about
 * was typed by hand into the Cooper's ramp list, which he had ruled out on 2026-09-20: *"hand
 * writing in that it is closed will go stale with no way of updating it without changing code"*.
 *
 * The Worker asks Google for the launch at the ramp's position and whether Google lists it as
 * open -- see `POST /places/status` in Worker/places.js, which also says which result counts as
 * the launch and why the answer is kept for the day. This file only asks, and turns the answer
 * into one sentence for the plan.
 *
 * ANNOTATED, NEVER REFUSED. A launch Google lists as closed goes in the plan's warnings, beside
 * the fog and the wind, because it is something he has to act on before he drives. Everything
 * else -- listed as operating, no listing at all, the check not running -- goes with the things
 * the app settled, so a plan always says whether the check ran and what it found. And nothing here
 * can stop a plan: a failure is a sentence.
 *
 * IT IS GOOGLE'S WORD, AND THE SENTENCE SAYS SO, with the name Google uses, how far from the ramp
 * that listing is pinned, and the day it was read.
 */

import { workerHeaders } from '../utils/worker-auth.js';

/**
 * Ask the Worker about the launch at [lon, lat].
 * @returns {Promise<object|null>} the Worker's answer, `{error}` when it could not be had, or
 *          null when there is no position to ask about.
 */
export async function askLaunchStatus({ worker, lonLat, fetchImpl } = {}) {
  // NUMBER(NULL) IS 0, and a launch with no position would be asked about at 0, 0 -- the trap this
  // codebase has hit three times. A coordinate that is not a number is not a coordinate.
  const pick = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) ? Number(v) : NaN;
  const lon = Array.isArray(lonLat) ? pick(lonLat[0]) : NaN;
  const lat = Array.isArray(lonLat) ? pick(lonLat[1]) : NaN;
  if (!worker || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const f = fetchImpl || globalThis.fetch;
  try {
    const r = await f(`${worker}/places/status`, {
      method: 'POST', headers: workerHeaders(), body: JSON.stringify({ lat, lon }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.error) return { error: (j && j.error) || `the Worker answered ${r.status}` };
    return j;
  } catch (e) {
    return { error: (e && e.message) || 'the Worker could not be reached' };
  }
}

const CLOSED = {
  CLOSED_TEMPORARILY: 'temporarily closed',
  CLOSED_PERMANENTLY: 'permanently closed',
};

/**
 * One sentence for the plan, in the place it belongs.
 * @returns {{warning: string|null, decision: string|null}}
 */
export function launchStatusNote(res, rampName) {
  const at = rampName ? `"${rampName}"` : 'this launch';
  if (!res) return { warning: null, decision: null };
  if (res.error) {
    return { warning: null, decision: `The closure check for ${at} did not run: ${res.error}.` };
  }
  const when = res.day ? ` (checked ${res.day})` : '';
  const L = res.launch;
  if (!L) {
    return { warning: null,
             decision: `Google has no listing for ${at}, so whether it is open could not be `
                     + `checked${when}${res.why ? ` -- ${res.why}` : ''}.` };
  }
  const away = Number.isFinite(L.m) ? ` (${L.m} m from the ramp)` : '';
  const who = `Google lists ${L.name || 'the launch here'}${away}`;
  if (CLOSED[L.status]) return { warning: `${who} as ${CLOSED[L.status]}${when}.`, decision: null };
  if (L.status === 'OPERATIONAL') {
    return { warning: null, decision: `${who} as operating, with no closure listed${when}.` };
  }
  return { warning: null, decision: `${who} with no open or closed status${when}.` };
}
