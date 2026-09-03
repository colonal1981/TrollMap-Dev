/**
 * fish-advisories.js — what a state says about EATING what you keep.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan placed this himself, 2026-09-03: *"probably below the regulations entry in the smartplan
 * output html... that would make sense to me... hey this is what you can keep... but if you keep
 * them know this about them."* The regulations table says what may be kept. This says what the
 * state knows about the fish that gets kept, and the two belong together in that order.
 *
 * SOUTH CAROLINA NAMES A "DO NOT EAT" SPECIES ON FOURTEEN OF ITS SIXTY-TWO WATERS, and on five of
 * them it is LARGEMOUTH BASS -- the Edisto, the Little Pee Dee, the Lumber, the Waccamaw and the
 * Savannah. Georgia says DO NOT EAT to striped and hybrid bass on the main body of Hartwell, in
 * all three size classes. That is a state naming the fish somebody is most likely to be
 * targeting, and until now the app had no way to say it.
 *
 * TWO STATES, TWO FILES, AND A WATER CAN BE IN BOTH.
 *
 * South Carolina publishes polygons and Georgia publishes a booklet, so they are read by
 * different scripts into different objects -- and six waters we ship are in both: Hartwell, J.
 * Strom Thurmond, Richard B Russell, Yonah, the Savannah River and the Savannah coastal zone.
 * They are NOT merged into one record here. Each state sampled its own side, on its own dates,
 * for its own chemicals, and flattening two surveys into one row would invent an agreement
 * neither state made. So a slug holds a LIST of records and the display concatenates them, with
 * every row still carrying the words its own state published.
 *
 * SAME SHAPE AS lake-registry.js. The existing /chartpacks/<key>/<file> route serves any R2
 * object, so this reads the two `_registry/*_fish_advisories.json` objects through it and needs
 * no Worker change. Primed on water selection like regulations-live.js, because the plan render
 * is synchronous and cannot await.
 *
 * A WATER WITH NO SPECIES IS NOT A GAP. Twenty of South Carolina's sixty-two carry
 * `water_level_notes` of "No Restrictions" and an empty species list: the state sampled them and
 * found nothing to warn about. That is a clean bill of health and it is worth printing as one --
 * reading it as missing data would turn an answer into a hole.
 */

// Both are optional. A bucket with one of them and not the other has to work, because the two
// are built by different scripts on different days.
const REGISTRY_PATHS = [
  '/chartpacks/_registry/sc_fish_advisories.json',
  '/chartpacks/_registry/ga_fish_advisories.json',
];
const CACHE_MS = 12 * 60 * 60 * 1000;   // the states revise these rarely; twelve hours is generous

let _cache = null;
let _at = 0;
let _inflight = null;

/** A record, or a list of them, always seen as a list. Lets a caller hand over either. */
function asList(v) {
  if (!v) return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v];
}

/**
 * Load the advisory tables once and hold them. Never throws — a water with no advisory and a
 * bucket with no object have to look the same to the caller, because both mean "nothing to say".
 *
 * One file failing does not take the other down with it. Georgia's object landing in the bucket
 * a week after South Carolina's is the normal case, not an error.
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
      const out = {};
      for (const path of REGISTRY_PATHS) {
        let payload = null;
        try {
          const res = await impl(`${base}${path}`);
          if (!res || !res.ok) continue;
          payload = await res.json();
        } catch (err) {
          continue;                   // offline at a ramp is not a broken plan
        }
        const waters = (payload && payload.waters) || null;
        if (!waters) continue;
        // The file says where it came from once; every record it holds carries that answer, so
        // the plan can name the state beside the rows instead of assuming one.
        const source = (payload && payload.source) || null;
        for (const [slug, rec] of Object.entries(waters)) {
          if (!rec) continue;
          // The record's own answer wins where it has one — Georgia repeats its source on every
          // water, South Carolina states it once at the top of the file. Written this way rather
          // than as a spread because `{ source, ...rec }` lets a record carrying an explicit
          // undefined wipe the stamp out.
          const row = { ...rec };
          if (!row.source && source) row.source = source;
          (out[slug] || (out[slug] = [])).push(row);
        }
      }
      _cache = Object.keys(out).length ? out : null;
      _at = Date.now();
      return _cache;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/** Every advisory record for a slug, newest source last. Synchronous — reads the warmed cache. */
export function advisoryFor(slug) {
  if (!_cache || !slug) return null;
  const recs = asList(_cache[slug]);
  return recs.length ? recs : null;
}

/**
 * The rows to show, narrowed to the species actually being fished for where that is known.
 *
 * NARROWED, NOT FILTERED AWAY. A DO NOT EAT on a species nobody planned for still shows: the
 * plan is a day on the water, not a shopping list, and "do not eat any bowfin" matters to
 * somebody who catches one by accident. So targeted species come first and the rest follow.
 *
 * On a water two states both sampled, the rows are concatenated and each keeps the words its own
 * state published — including the case where they disagree, which is a thing worth seeing.
 */
export function advisoryRows(slug, species = []) {
  const recs = advisoryFor(slug);
  if (!recs) return null;
  const want = new Set((Array.isArray(species) ? species : [])
    .map((s) => String(s || '').toLowerCase().trim()).filter(Boolean));
  const norm = (s) => String(s || '').toLowerCase().replace(/\s*\([^)]*\)/g, '').trim();
  const rows = [];
  const doNotEat = [];
  const notes = [];
  const kinds = [];
  const sources = [];
  for (const rec of recs) {
    for (const r of rec.species || []) {
      rows.push({
        ...r,
        source: rec.source || null,
        targeted: want.size
          ? want.has(norm(r.species)) || want.has(String(r.species).toLowerCase())
          : false,
        doNotEat: /do\s*not\s*eat/i.test(r.advice || ''),
      });
    }
    for (const d of rec.do_not_eat || []) if (!doNotEat.includes(d)) doNotEat.push(d);
    for (const n of rec.water_level_notes || []) if (!notes.includes(n)) notes.push(n);
    for (const a of rec.advisories || []) {
      if (a && a.advisory && !kinds.includes(a.advisory)) kinds.push(a.advisory);
    }
    if (rec.source && !sources.includes(rec.source)) sources.push(rec.source);
  }
  rows.sort((a, b) => (b.targeted - a.targeted) || (b.doNotEat - a.doNotEat));
  return {
    displayName: (recs.find((r) => r.display_name) || {}).display_name,
    rows,
    doNotEat,
    notes,
    kinds,
    sources,
    // Sampled and nothing to warn about. Only an answer when NO source found anything: one state
    // clearing a water it shares does not clear the other state's rows.
    cleared: !rows.length && !!notes.length,
  };
}

/** True when this water has anything to say at all. */
export function hasAdvisory(slug) {
  const recs = advisoryFor(slug);
  return !!(recs && recs.some((r) => (r.species || []).length || (r.water_level_notes || []).length));
}

/** Test seam — lets a test install a table without a network. Takes a record or a list of them. */
export function _setAdvisoryCache(waters) {
  if (!waters) {
    _cache = null;
    _at = 0;
    return;
  }
  _cache = Object.fromEntries(Object.entries(waters).map(([k, v]) => [k, asList(v)]));
  _at = Date.now();
}
