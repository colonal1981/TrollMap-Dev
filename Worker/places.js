/**
 * places.js - what Google calls the thing at a coordinate, for launches nobody named.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS EXISTS
 *
 * 1,600 of the 3,757 landing rows across the packs have no name, and every one of them comes
 * from OSM, tagged `leisure=slipway` with nothing else. Ryan, reading the ramp dropdown:
 * *"planning a trip from 'unnamed launch' doesn't sound right to me"*, and then, on the waters
 * he actually fishes: *"i want to try and figure out how to name them... give me a list with
 * gps coords for each launch and i will go do some looking unless you have an automated way to
 * do the looking for me"*.
 *
 * This is the automated way. 152 distinct unnamed launches on his waters; Nearby Search takes a
 * coordinate and says what is there.
 *
 * THE KEY LIVES HERE AND ONLY HERE. `env.PLACES_API_KEY` is Ryan's, set by Ryan, and is the
 * reason the lookup is a Worker route rather than a line in a pipeline script: the pipeline runs
 * on his desktop and would have to hold the key to make the call. It does not, and will not.
 *
 * WHAT IT COSTS, MEASURED BEFORE IT WAS WRITTEN
 *
 * Google retired the universal $200 credit in March 2025 for a per-SKU monthly allowance:
 * Essentials 10,000 a month, Pro 5,000, Enterprise 1,000, each an independent pool. The field
 * mask below asks for `places.displayName` and `places.types`, which are Pro fields, so every
 * call here bills Nearby Search Pro. 152 calls is 3% of one month's free pool.
 *
 * ONE HIGHER-TIER FIELD UPGRADES THE WHOLE RESPONSE. Adding `rating` or `regularOpeningHours`
 * -- both Enterprise -- would bill every one of these calls at Enterprise rates. The field mask
 * is the price. Do not add to it without re-reading which tier the field belongs to.
 *
 * THREE THINGS STOP THIS SPENDING MONEY, AND THEY ARE DELIBERATELY REDUNDANT
 *
 *   1. Ryan's own quota caps in the Google Cloud console -- SearchNearbyRequest per day 200,
 *      and every SKU this project does not call set to 0. That is the only stop GOOGLE enforces
 *      and it is the one that matters.
 *   2. PLACES_BUDGET below: a monthly counter in KV, refused past the ceiling.
 *   3. The cache. A place_id never changes and neither does a landing's position, so an answer
 *      is kept forever and a re-run of the whole sweep costs nothing at all.
 *
 * A MISSING COUNTER MEANS THE MONTH HAS NOT STARTED, NOT THAT THE BUDGET IS BLOWN -- and, just
 * as carefully, not that it is empty either. research/clients.js carries a note about the
 * Firecrawl budget reading a missing key as zero and silently disabling itself; the mirror of
 * that mistake here would be reading a missing key as "spent" and silently disabling the sweep.
 * Missing starts a fresh month at zero spent, which is both the truth and the safe direction,
 * because the console cap is the real backstop.
 *
 * WHAT IT DOES NOT DO. It does not decide whether a result IS the launch. It returns what
 * Google has within the radius, nearest first, with the distance and the types, and the
 * pipeline writes them into a registry file a human reads. A slipway 140 m from a restaurant is
 * not that restaurant, and nothing here pretends to know the difference.
 */

import { CORS, JSON_HEADERS, isAuthorized } from './worker-core.js';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';

/** Pro-tier fields only. See the note above before adding to this. */
const FIELD_MASK = 'places.id,places.displayName,places.location,places.types';

const RADIUS_M = 150;          // a launch's Google place can sit a car park away from the ramp
const MAX_RESULTS = 5;
const MAX_POINTS = 25;         // per request, so one call cannot spend a day's quota
const BUDGET_KEY = 'places:spent';
const PLACES_BUDGET = 1000;    // a fifth of the Pro free pool, per calendar month

/**
 * ── IS THE LAUNCH OPEN. `POST /places/status` ───────────────────────────────────────────────
 *
 * Ryan, 2026-10-01: *"I think we talked about having smartplan use my google maps api key to
 * check for ramp closures... did that get done?"* It had not. It was designed on 2026-09-20 and
 * never built, and the only closure the app carried was typed by hand into the Cooper's ramp
 * list -- the thing he had already ruled out: *"hand writing in that it is closed will go stale
 * with no way of updating it without changing code"*, pasting Google's own "William Dennis Boat
 * Landing -- Temporarily closed" beside it.
 *
 * SAME TIER, SAME RADIUS, SAME NAME RULE AS THE NAMING SWEEP.
 *
 *   - `businessStatus` is a Nearby Search PRO field, the tier `displayName` already bills at
 *     (Google's Nearby Search field list, read 2026-10-01). Adding it does not reprice the call,
 *     and a test reads this mask the way it reads FIELD_MASK.
 *   - 150 m, nearest first, the radius the naming sweep settled on.
 *   - WHICH RESULT IS THE LAUNCH is the naming script's own pick(): the nearest within 150 m whose
 *     NAME reads like a launch. Google barely types boat ramps and a fish camp is typed
 *     `restaurant, store`, so the type is not read. The two patterns below are copied from
 *     Scripts/name_launches_from_places.py, and a test reads them out of the Python and fails the
 *     day the two stop matching.
 *
 * ONE ASK PER LAUNCH PER DAY. A status changes and a name does not, so this is NOT the naming
 * cache, which keeps an answer forever. The key carries the day the answer is stamped with -- his
 * day, Eastern -- so a plan that says "checked 2026-10-01" means it. KV is told to drop the key
 * after two days only so old days clean themselves up; the day in the key is what decides.
 *
 * WHAT IT DOES NOT DO. It does not decide a launch is closed. Google's status is Google's -- for
 * William Dennis it was right and SCDNR's feed was not -- and the plan prints it as Google's, with
 * the name and the distance Google gave and the day it was read.
 */
const STATUS_FIELD_MASK = 'places.id,places.displayName,places.location,places.types,'
  + 'places.businessStatus';
const ACCEPT_M = RADIUS_M;     // name_launches_from_places.py's ACCEPT_M; a test holds them equal
const STATUS_KV_TTL_S = 2 * 24 * 3600;

// Copied from Scripts/name_launches_from_places.py, which says why every word is there.
export const LAUNCH_RE = new RegExp(
  String.raw`\bboat\s+(ramp|landing|launch|dock|slip)|\bmarine\s+complex\b|`
  + String.raw`\b(ramps?|landings?|launch|slipway|marina|dock|ferry|camp|campground|access|park|`
  + String.raw`put[-\s]?in)\b`, 'i');
export const NOT_A_LAUNCH_RE = new RegExp(
  String.raw`\b(rentals?|charters?|guide\s+service|tackle|trailhead|restaurant|grill|`
  + String.raw`parts|repair|store|realty|real\s+estate|dealer|marine\s+(sales|service))\b`, 'i');

/** Does this NAME say it is somewhere you put a boat in? The type is not consulted. */
export function readsLikeALaunch(name) {
  const nm = String(name || '');
  if (!nm || NOT_A_LAUNCH_RE.test(nm)) return false;
  return LAUNCH_RE.test(nm);
}

/**
 * The one result worth calling this launch, or none with the reason -- pick() in the Python, line
 * for line: nearest first, and the first that reads like a launch wins, so a shop 20 m away does
 * not veto the ramp 30 m away.
 */
export function pickLaunch(results) {
  const rs = Array.isArray(results) ? results : [];
  if (!rs.length) return { launch: null, why: 'Google has nothing within ' + RADIUS_M + ' m' };
  const near = rs.filter((r) => r && r.m != null && r.m <= ACCEPT_M);
  if (!near.length) return { launch: null, why: `the nearest thing Google has is ${rs[0].m} m away` };
  for (const r of near) if (readsLikeALaunch(r.name)) return { launch: r, why: '' };
  return { launch: null, why: `nothing within ${ACCEPT_M} m reads like a launch (`
    + near.slice(0, 2).map((x) => x.name).join('; ') + ')' };
}

/** His day, not UTC's: a plan built at 9 PM Eastern is checked "today", not tomorrow. */
export function dayEastern(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric',
                                            month: '2-digit', day: '2-digit' }).format(d);
}

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...JSON_HEADERS, ...CORS } });

const monthKey = () => new Date().toISOString().slice(0, 7);          // "2026-09"
const cacheKey = (lat, lon) => `places:at:${lat.toFixed(5)},${lon.toFixed(5)}`;

async function readBudget(env) {
  let rec = null;
  try {
    const raw = await env.KV.get(BUDGET_KEY);
    rec = raw ? JSON.parse(raw) : null;
  } catch (_) { rec = null; }
  // A new month, or nothing recorded yet, is zero spent. Not "blown" -- see the note above.
  if (!rec || rec.month !== monthKey()) return { month: monthKey(), spent: 0 };
  return { month: rec.month, spent: Number(rec.spent) || 0 };
}

async function writeBudget(env, rec) {
  await env.KV.put(BUDGET_KEY, JSON.stringify(rec)).catch(() => {});
}

function metres(la1, lo1, la2, lo2) {
  const c = Math.cos(((la1 + la2) / 2) * Math.PI / 180);
  return Math.hypot((lo2 - lo1) * 111320 * c, (la2 - la1) * 110540);
}

/**
 * One Nearby Search at a coordinate, with the given mask. Both routes ask through this, so the
 * radius, the order and the error handling cannot drift apart between the name and the status.
 */
async function nearby(env, lat, lon, mask) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': env.PLACES_API_KEY,
      'X-Goog-FieldMask': mask,
    },
    body: JSON.stringify({
      locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius: RADIUS_M } },
      maxResultCount: MAX_RESULTS,
      rankPreference: 'DISTANCE',
    }),
  });

  if (!res.ok) {
    // THE STATUS TRAVELS. A 429 is a quota Ryan set and a 403 is a key problem, and they need
    // different hands; "lookup failed" would send him to the wrong one.
    const body = await res.text().catch(() => '');
    return { error: `places ${res.status}`, detail: String(body).slice(0, 300) };
  }

  const j = await res.json().catch(() => ({}));
  return {
    results: (j.places || []).map((p) => ({
      name: (p.displayName && p.displayName.text) || null,
      place_id: p.id || null,
      types: p.types || [],
      lat: p.location && p.location.latitude,
      lon: p.location && p.location.longitude,
      m: (p.location && Number.isFinite(p.location.latitude))
        ? Math.round(metres(lat, lon, p.location.latitude, p.location.longitude)) : null,
      ...(p.businessStatus !== undefined ? { status: p.businessStatus || null } : {}),
    })),
  };
}

/** One coordinate -> what Google has within RADIUS_M, nearest first. Cached forever. */
async function lookup(env, lat, lon) {
  const k = cacheKey(lat, lon);
  try {
    const hit = await env.KV.get(k);
    if (hit) return { ...JSON.parse(hit), cached: true };
  } catch (_) { /* a bad cache entry is a cache miss */ }

  const got = await nearby(env, lat, lon, FIELD_MASK);
  if (got.error) return { ...got, spent: true };
  const out = { results: got.results, at: new Date().toISOString() };
  // Cached even when EMPTY. "Google has nothing here" is an answer, it is worth knowing about a
  // launch, and paying for it twice would be silly.
  await env.KV.put(k, JSON.stringify(out)).catch(() => {});
  return { ...out, spent: true };
}

/**
 * POST /places/name  { points: [{lat, lon}, ...] }  -> { results: [...], budget: {...} }
 *
 * Token-guarded, because every uncached point in the body costs money.
 * GET /places/name -> the budget and nothing else, so it can be checked without spending.
 */
export async function handlePlaces(request, env, url) {
  const p = url.pathname.replace(/\/+$/, '');
  if (p === '/places/status') return handleStatus(request, env);
  if (p !== '/places/name') return null;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (!env || !env.KV) return json({ error: 'KV not bound' }, 500);

  const budget = await readBudget(env);
  if (request.method === 'GET') {
    return json({ month: budget.month, spent: budget.spent, ceiling: PLACES_BUDGET,
                  configured: !!env.PLACES_API_KEY });
  }
  if (request.method !== 'POST') return json({ error: 'POST' }, 405);
  if (!await isAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
  if (!env.PLACES_API_KEY) return json({ error: 'PLACES_API_KEY is not set on the Worker' }, 503);

  const body = await request.json().catch(() => null);
  const points = (body && Array.isArray(body.points)) ? body.points : null;
  if (!points || !points.length) return json({ error: 'points required' }, 400);
  if (points.length > MAX_POINTS) return json({ error: `at most ${MAX_POINTS} points`, }, 400);

  const results = [];
  let spent = 0;
  for (const q of points) {
    const lat = Number(q && q.lat);
    const lon = Number(q && q.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      results.push({ lat: q && q.lat, lon: q && q.lon, error: 'bad coordinate' });
      continue;
    }
    // CHECKED PER POINT, NOT PER REQUEST. A batch that would cross the ceiling stops at it and
    // says so, rather than being refused whole or spending past it.
    if (budget.spent + spent >= PLACES_BUDGET) {
      results.push({ lat, lon, error: 'monthly budget reached', ceiling: PLACES_BUDGET });
      continue;
    }
    const r = await lookup(env, lat, lon);
    if (r.spent) spent += 1;
    results.push({ lat, lon, ...r, spent: undefined });
  }
  if (spent) await writeBudget(env, { month: budget.month, spent: budget.spent + spent });

  return json({ results, budget: { month: budget.month, spent: budget.spent + spent,
                                   ceiling: PLACES_BUDGET, this_call: spent } });
}


const statusKey = (lat, lon, day) => `places:status:${lat.toFixed(5)},${lon.toFixed(5)}:${day}`;

/** One coordinate -> Google's launch there and whether it is open, for today. */
async function statusLookup(env, lat, lon, day) {
  const k = statusKey(lat, lon, day);
  try {
    const hit = await env.KV.get(k);
    if (hit) return { ...JSON.parse(hit), cached: true };
  } catch (_) { /* a bad cache entry is a cache miss */ }

  const got = await nearby(env, lat, lon, STATUS_FIELD_MASK);
  if (got.error) return { ...got, day, spent: true };
  const { launch, why } = pickLaunch(got.results);
  const out = { day, at: new Date().toISOString(), launch, why, results: got.results };
  await env.KV.put(k, JSON.stringify(out), { expirationTtl: STATUS_KV_TTL_S }).catch(() => {});
  return { ...out, spent: true };
}

/**
 * POST /places/status  { lat, lon }  -> { day, launch: {name, m, status, ...} | null, why,
 *                                        results, budget }
 *
 * Token-guarded and budgeted with /places/name -- one counter, because it is one pool of Ryan's.
 */
async function handleStatus(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (!env || !env.KV) return json({ error: 'KV not bound' }, 500);
  if (request.method !== 'POST') return json({ error: 'POST' }, 405);
  if (!await isAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
  if (!env.PLACES_API_KEY) return json({ error: 'PLACES_API_KEY is not set on the Worker' }, 503);

  const body = await request.json().catch(() => null);
  const lat = Number(body && body.lat);
  const lon = Number(body && body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: 'lat and lon required' }, 400);

  const budget = await readBudget(env);
  const day = dayEastern();
  // A cached answer costs nothing, so the budget only stands in the way of an uncached one.
  const cached = await env.KV.get(statusKey(lat, lon, day)).catch(() => null);
  if (!cached && budget.spent >= PLACES_BUDGET) {
    return json({ error: 'monthly budget reached', day, ceiling: PLACES_BUDGET }, 429);
  }
  const r = await statusLookup(env, lat, lon, day);
  const spent = r.spent ? 1 : 0;
  if (spent) await writeBudget(env, { month: budget.month, spent: budget.spent + spent });
  const { spent: _s, ...out } = r;
  return json({ ...out, budget: { month: budget.month, spent: budget.spent + spent,
                                  ceiling: PLACES_BUDGET, this_call: spent } },
              out.error ? 502 : 200);
}
