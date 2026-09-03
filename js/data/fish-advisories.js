/**
 * fish-advisories.js — what South Carolina says about EATING what you keep.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan placed this himself, 2026-09-03: *"probably below the regulations entry in the smartplan
 * output html... that would make sense to me... hey this is what you can keep... but if you keep
 * them know this about them."* The regulations table says what may be kept. This says what the
 * state knows about the fish that gets kept, and the two belong together in that order.
 *
 * FOURTEEN OF THE SIXTY-TWO BOUND WATERS CARRY A "DO NOT EAT" SPECIES, and on five of them it is
 * LARGEMOUTH BASS -- the Edisto, the Little Pee Dee, the Lumber, the Waccamaw and the Savannah --
 * plus striped bass on Hartwell. That is the state naming the fish somebody is most likely to be
 * targeting, and until now the app had no way to say it.
 *
 * SAME SHAPE AS lake-registry.js. The existing /chartpacks/<key>/<file> route serves any R2
 * object, so this reads `_registry/sc_fish_advisories.json` through it and needs no Worker
 * change. Primed on water selection like regulations-live.js, because the plan render is
 * synchronous and cannot await.
 *
 * A WATER WITH NO SPECIES IS NOT A GAP. Twenty of the sixty-two carry `water_level_notes` of
 * "No Restrictions" and an empty species list: the state sampled them and found nothing to warn
 * about. That is a clean bill of health and it is worth printing as one -- reading it as missing
 * data would turn an answer into a hole.
 */

const REGISTRY_PATH = '/chartpacks/_registry/sc_fish_advisories.json';
const CACHE_MS = 12 * 60 * 60 * 1000;   // the state revises these rarely; twelve hours is generous

let _cache = null;
let _at = 0;
let _inflight = null;

/**
 * Load the advisory table once and hold it. Never throws — a water with no advisory and a
 * bucket with no object have to look the same to the caller, because both mean "nothing to say".
 */
export async function primeFishAdvisories(opts = {}) {
  const now = Date.now();
  if (_cache && now - _at < CACHE_MS) return _cache;
  if (_inflight) return _inflight;
  const base = String(opts.worker || '').replace(/\/+$/, '');
  const impl = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!base || !impl) return null;
  _inflight = (async () => {
    try {
      const res = await impl(`${base}${REGISTRY_PATH}`);
      if (!res || !res.ok) return null;
      const payload = await res.json();
      _cache = (payload && payload.waters) || null;
      _at = Date.now();
      return _cache;
    } catch (err) {
      return null;                    // offline at a ramp is not a broken plan
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/** The advisory record for a slug, or null. Synchronous — reads the warmed cache. */
export function advisoryFor(slug) {
  if (!_cache || !slug) return null;
  return _cache[slug] || null;
}

/**
 * The rows to show, narrowed to the species actually being fished for where that is known.
 *
 * NARROWED, NOT FILTERED AWAY. A DO NOT EAT on a species nobody planned for still shows: the
 * plan is a day on the water, not a shopping list, and "do not eat any bowfin" matters to
 * somebody who catches one by accident. So targeted species come first and the rest follow.
 */
export function advisoryRows(slug, species = []) {
  const rec = advisoryFor(slug);
  if (!rec) return null;
  const want = new Set((Array.isArray(species) ? species : [])
    .map((s) => String(s || '').toLowerCase().trim()).filter(Boolean));
  const norm = (s) => String(s || '').toLowerCase().replace(/\s*\([^)]*\)/g, '').trim();
  const rows = (rec.species || []).map((r) => ({
    ...r,
    targeted: want.size ? want.has(norm(r.species)) || want.has(String(r.species).toLowerCase()) : false,
    doNotEat: /do\s*not\s*eat/i.test(r.advice || ''),
  }));
  rows.sort((a, b) => (b.targeted - a.targeted) || (b.doNotEat - a.doNotEat));
  return {
    displayName: rec.display_name,
    rows,
    doNotEat: rec.do_not_eat || [],
    notes: rec.water_level_notes || [],
    kinds: [...new Set((rec.advisories || []).map((a) => a.advisory).filter(Boolean))],
    cleared: !(rec.species || []).length && !!(rec.water_level_notes || []).length,
  };
}

/** True when this water has anything to say at all. */
export function hasAdvisory(slug) {
  const rec = advisoryFor(slug);
  return !!(rec && ((rec.species || []).length || (rec.water_level_notes || []).length));
}

/** Test seam — lets a test install a table without a network. */
export function _setAdvisoryCache(waters) {
  _cache = waters || null;
  _at = waters ? Date.now() : 0;
}
