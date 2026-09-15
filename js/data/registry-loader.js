/**
 * registry-loader.js — one cached fetch for the `_registry/*.json` tables.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A REFACTOR FOR ITS OWN SAKE.
 *
 * Every registry the app reads travels the same route: built by a script on the drive, uploaded
 * to `_registry/<name>.json` in R2, served by the Worker at `/chartpacks/_registry/<name>.json`,
 * read once per page and held. `Worker/registry.js` has `passthroughLoader()` for exactly this on
 * its side of the wire. The browser side had the same eleven lines written out per file, and
 * coastal-layers.js already recorded what that costs -- "the same eleven lines pasted three times
 * with the nouns changed" -- when it collapsed three layer toggles into the layer registry.
 *
 * Two rules are carried here rather than left to each caller, because both were learned the hard
 * way on the Worker side and neither is obvious:
 *
 *   A BAD BODY IS NOT CACHED AS AN ANSWER. `pick` must find the shape it was promised. A 200 that
 *   returns an error page, a half-written upload or a file whose top-level key was renamed all
 *   parse as JSON, and caching any of them means the app spends the next twelve hours confidently
 *   answering out of nothing. Same reason `parse_failed` is checked in regulations-live.js.
 *
 *   A FAILURE IS SILENCE, NEVER A THROW AND NEVER AN EMPTY ANSWER. A registry is an ADDITION to
 *   a plan -- a section of the prompt that prints when the table is in hand. A bucket with no
 *   object and a network that dropped must look identical to the caller, and both must mean the
 *   section does not appear. Nothing here can turn a network problem into a fact.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */

/** Twelve hours. These tables are rebuilt by hand on the drive, not by the minute. */
export const REGISTRY_CACHE_MS = 12 * 60 * 60 * 1000;

/**
 * A prime/read pair for one registry file.
 *
 * @param {string}   path  the served path, e.g. '/chartpacks/_registry/mrip_inshore.json'
 * @param {function} pick  (payload) => the object the caller needs, or a falsy value to REFUSE
 *                         the body. This is the shape guard; make it name the key, not the file.
 * @returns {{prime: function, get: function, primed: function, reset: function, path: string}}
 */
export function registryLoader(path, pick) {
  let cache = null;
  let at = 0;
  let inflight = null;

  const prime = async (opts = {}) => {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    if (cache && now - at < REGISTRY_CACHE_MS && !opts.force) return cache;
    if (inflight) return inflight;
    const base = String(opts.worker || '').replace(/\/+$/, '');
    const impl = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!base || !impl) return null;
    inflight = (async () => {
      try {
        const r = await impl(`${base}${path}`);
        if (!r.ok) return null;
        const body = await r.json();
        const got = pick(body);
        if (!got) return null;          // see A BAD BODY IS NOT CACHED AS AN ANSWER
        cache = body;
        at = now;
        return body;
      } catch (e) {
        console.warn(`[registry] ${path} unavailable:`, e && e.message);
        return null;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  return {
    path,
    prime,
    /** The whole payload, or null when nothing has been read. Never a partial object. */
    get: () => cache,
    primed: () => !!cache,
    reset: () => { cache = null; at = 0; inflight = null; },
  };
}
