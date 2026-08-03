/**
 * utils/worker-auth.js — the shared secret for TrollMap's own Worker, in one place.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 *   import { workerHeaders } from '../utils/worker-auth.js';
 *   fetch(`${CF_WORKER_URL}/research/save`, {
 *     method: 'POST', headers: workerHeaders(), body: JSON.stringify(payload),
 *   });
 *
 * WHY THIS EXISTS
 *
 * The token was written out twice, and the two copies did not match. `cloud-sync.js` sent
 * `trollmap2026`; `plan-builder.js` hand-rolled its own tombstone DELETE and sent
 * `trollmap-sync-9a8b7c6d5e`, a literal found nowhere else in the codebase. The worker's
 * isAuthorized() is a strict `got === want`, so every one of those came back 401 into a
 * `.catch(() => {})` — deleted plans never tombstoned server-side and came back on the next
 * page load. A secret that appears in more than one place has already gone wrong; it just has
 * not been noticed yet.
 *
 * WHAT THIS IS NOT
 *
 * This is not access control, and it must not be mistaken for it. The token ships inside
 * client JavaScript that every browser downloads — it is readable from view-source or the
 * network tab in about ten seconds, and `wrangler.toml` carries it as a plaintext `[vars]`
 * entry rather than a secret. What it buys is a gate against opportunistic and accidental
 * writes: a scanner that finds `/research/delete` cannot simply call it, and neither can a
 * mistyped curl.
 *
 * Real access control means the browser cannot hold the credential at all — Cloudflare Access
 * in front of the mutating routes, or short-lived signed tokens minted per session. That is a
 * design change, deliberately not smuggled in here.
 *
 * ONLY send these headers to TrollMap's own Worker. `lake-research-engine.js` also fetches
 * Open-Meteo, USGS and third-party documents; attaching the token to those would hand it to
 * hosts that have no business seeing it.
 */

/**
 * The shared token. Kept here so there is exactly one spelling of it in the front end.
 * Must match `SYNC_TOKEN` in the Worker's wrangler.toml.
 */
export const SYNC_TOKEN = 'trollmap2026';

/**
 * Headers for a call to TrollMap's Worker.
 *
 * @param {Object} [extra] merged last, so a caller can override Content-Type for a non-JSON
 *                         body without losing the token.
 * @returns {Object}
 */
export function workerHeaders(extra) {
  return { 'Content-Type': 'application/json', 'X-Sync-Token': SYNC_TOKEN, ...(extra || {}) };
}

/**
 * Headers for a request with no body — a GET or a DELETE. Same token, no Content-Type, which
 * some CDNs and proxies treat differently on a bodyless request.
 */
export function workerAuthOnly(extra) {
  return { 'X-Sync-Token': SYNC_TOKEN, ...(extra || {}) };
}
