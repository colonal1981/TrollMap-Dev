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

/** One coordinate -> what Google has within RADIUS_M, nearest first. Cached forever. */
async function lookup(env, lat, lon) {
  const k = cacheKey(lat, lon);
  try {
    const hit = await env.KV.get(k);
    if (hit) return { ...JSON.parse(hit), cached: true };
  } catch (_) { /* a bad cache entry is a cache miss */ }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': env.PLACES_API_KEY,
      'X-Goog-FieldMask': FIELD_MASK,
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
    return { error: `places ${res.status}`, detail: String(body).slice(0, 300), spent: true };
  }

  const j = await res.json().catch(() => ({}));
  const out = {
    results: (j.places || []).map((p) => ({
      name: (p.displayName && p.displayName.text) || null,
      place_id: p.id || null,
      types: p.types || [],
      lat: p.location && p.location.latitude,
      lon: p.location && p.location.longitude,
      m: (p.location && Number.isFinite(p.location.latitude))
        ? Math.round(metres(lat, lon, p.location.latitude, p.location.longitude)) : null,
    })),
    at: new Date().toISOString(),
  };
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
