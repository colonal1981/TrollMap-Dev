/**
 * Which USGS cameras are on this water, and the newest frame from one.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 * NIMS imagery is Public Domain.
 *
 * THIS FILE EXISTS BECAUSE THERE ARE NOW TWO CONSUMERS. The ramp popup has shown camera frames
 * since 2026-08-05; Ryan then asked, 2026-08-16: *"for the cameras we have USGS would it be
 * possible for those to be displayed in the top bar now with all of the other information"* —
 * and the honest way to answer that is not to copy the selection rule and the frame cache into
 * the conditions strip. Two copies of a cache are two caches that can disagree about how old a
 * picture is, and the whole point of showing the age is that it is true.
 *
 * So the selection and the fetch live here, pure but for one injectable fetch, and both the
 * popup and the strip are DOM around this. Same split as water-conditions.js / conditions-strip.js.
 *
 * TWO SELECTION RULES, AND THEY ARE GENUINELY DIFFERENT.
 *
 *   A RAMP is a point. You are asking "what will I see when I get out of the truck HERE", so
 *   the answer is the nearest camera SITE on the same water and every view that site has.
 *   `nearestSite` — this is the rule that has always been in ramp-cameras.js.
 *
 *   A WATER is not a point. Before a ramp is chosen the question is "what does this river look
 *   like today", and the nearest camera to a lake's centroid is a meaningless tiebreak — on the
 *   Congaree the four cameras run from Columbia to Fort Motte and they are four different
 *   answers, not three worse copies of one. `camerasOnWater` returns all of them.
 *
 * Distance is deliberately NOT a filter in the second rule. The build step already decided the
 * camera is on this water by polygon; re-testing it with a radius from an arbitrary centroid
 * would throw away correct bindings on any water longer than 40 km, which is most rivers.
 *
 * NO PROXY FOR THE IMAGE BYTES, DELIBERATELY. The frame comes back as an S3 URL and goes
 * straight into img.src. CORS governs fetch() and canvas readback, not <img src> — a
 * cross-origin image has always been allowed to DISPLAY — so there is nothing to test and no
 * Worker bandwidth spent on pictures.
 */

import { CAMERA_INDEX_BUILT, NIMS_CAMERAS } from '../data/cameras.js';

export const MAX_RAMP_KM = 20;

export function kmBetween(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Every camera bound to this water at build time.
 *
 * TWO WAYS TO THE SAME WATER, and the app needs both. A registry slug is authoritative when the
 * caller has one. A ramp carries the DNR feed's name instead, and those vocabularies do not
 * agree: the registry says "Lynches River (Darlington Co, SC)" and the feed says "Lynches
 * River". Measured across all four state feeds, ZERO of the 17 camera waters matched a DNR
 * waterbody name through resolveR2Key alone, which is why the build step ships `waterAliases` —
 * the display name with its parentheticals peeled off one layer at a time.
 *
 * Peeling is deliberately NOT done inside resolveR2Key: collapsing "Lake Wallace (Marlboro Co,
 * SC)" to "Lake Wallace" is exactly the ambiguity `lint:keys` fails on, and a name that means
 * two lakes must not silently resolve to one. It is safe here because an alias only NOMINATES,
 * and the caller's own rule decides.
 *
 * `slug` OR an alias, never both required. An empty result means no camera is bound to this
 * water — which is the normal case, for 437 of the 454 waters in the registry.
 */
export function camerasOnWater({ slug, name } = {}) {
  if (!CAMERA_INDEX_BUILT || !NIMS_CAMERAS.length) return [];
  const want = String(name || '').trim().toLowerCase();
  if (!slug && !want) return [];
  return NIMS_CAMERAS.filter(
    (c) => (slug && c.slug === slug) ||
           (!!want && Array.isArray(c.waterAliases) && c.waterAliases.includes(want))
  );
}

/**
 * The nearest camera SITE to a point, and every view that site has.
 *
 * DISTANCE ALONE PICKS THE WRONG WATER, measured: Pick Hill Access on the BROAD RIVER takes
 * "Little Hope Creek at Charlotte", 60 km away in a different watershed, and WT Billy Tolar on
 * WATEREE takes a CONGAREE camera at 21.6 km. Both are the nearest by distance and both are
 * wrong. So the water has to agree first — that is `camerasOnWater`, which the caller has
 * already applied — and the distance only breaks ties. Same two-signal shape the gauge bindings
 * use, for the same reason.
 *
 * Deduped on camId and never on nwisId, because UPSTREAM/DOWNSTREAM at one site is two views of
 * one reach and both are wanted. More than one camera per site is the normal case, not a
 * duplicate.
 */
export function nearestSite(onWater, lat, lon, maxKm = MAX_RAMP_KM) {
  if (!Array.isArray(onWater) || !onWater.length) return [];
  if (typeof lat !== 'number' || typeof lon !== 'number') return [];

  let best = null;
  for (const c of onWater) {
    const d = kmBetween(lat, lon, c.lat, c.lon);
    if (d > maxKm) continue;
    if (!best || d < best.d) best = { d, cam: c };
  }
  if (!best) return [];

  const site = best.cam.nwisId
    ? onWater.filter((c) => c.nwisId === best.cam.nwisId)
    : [best.cam];
  const seen = new Set();
  const out = [];
  for (const c of site) {
    if (seen.has(c.camId)) continue;
    seen.add(c.camId);
    out.push({ ...c, km: kmBetween(lat, lon, c.lat, c.lon) });
  }
  return out;
}

/** Every camera on the water, in a stable order, deduped on camId. */
export function camerasForWater(slug, name) {
  const seen = new Set();
  const out = [];
  for (const c of camerasOnWater({ slug, name })) {
    if (seen.has(c.camId)) continue;
    seen.add(c.camId);
    out.push(c);
  }
  // Sorted by NAME, not by distance to anything. There is no point to be near.
  out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return out;
}

// Frames land every 5, 15 or 60 minutes depending on the camera, and the Worker already edge-
// caches for 120 s. This second cache exists because Leaflet rebuilds every ramp marker on any
// map move, so the same popup can be opened repeatedly within seconds — and now also because
// the conditions card repaints on every strip toggle.
export const FRAME_TTL_MS = 120000;
const _frames = new Map();

/** Exposed for tests; nothing in the app should need to clear this. */
export function _clearFrameCache() { _frames.clear(); }

/**
 * The newest frame for one camera, through the Worker.
 *
 * ONE CACHE, SHARED BY EVERY CONSUMER. The age shown next to the picture is the reason this
 * function exists at all — 22 of the 47 visible cameras in this footprint are DAYLIGHT ONLY, so
 * open the app at 22:00 and the newest frame is from 20:15: a real image, correctly served, and
 * completely misleading with nothing next to it saying so. Two caches would eventually show one
 * age in the popup and a different age on the card for the same picture.
 */
export async function cameraFrame(camId, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const hit = _frames.get(camId);
  if (hit && now - hit.t < FRAME_TTL_MS) return hit.v;
  const impl = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!impl) throw new Error('no fetch available');
  const base = String(opts.worker || '').replace(/\/+$/, '');
  const res = await impl(`${base}/cameras/frame?camId=${encodeURIComponent(camId)}`);
  if (!res.ok) throw new Error(`frame ${res.status}`);
  const v = await res.json();
  _frames.set(camId, { t: now, v });
  return v;
}

export function ageLabel(mins) {
  if (mins == null) return 'time unknown';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return `${h} h ${mins % 60} min ago`;
}
