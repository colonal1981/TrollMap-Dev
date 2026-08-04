// Worker/core/arcgis.js — shared ArcGIS helper for ramps/paddle/bank-pier/attractors
// Extracted from trollmap-worker.js 4 copy-paste blocks (Phase P1 dedupe)
// Behavior-preserving: same pagination, same cache TTL, same waterbody grouping, same R2 keys

const PAGE_SIZE = 1000;

/**
 * Which build of THIS file is live.
 *
 * Bump on every edit to this module. `/build` reports it next to the marker in
 * trollmap-worker.js, so one curl answers "is the deployed bundle actually the
 * code in main?" -- a question that cost most of an afternoon on 2026-08-04,
 * when the live Worker was emitting a warning string that existed in no commit
 * on main. The two markers being out of step means the bundle is stale or the
 * build did not pick this file up.
 */
export const ARCGIS_BUILD = 'arcgis-2026-08-04e';

/**
 * Is this ArcGIS yes/no flag set?
 *
 * Read this before writing another state filter by hand.
 *
 * ArcGIS coded-value domains store a CODE and display a DESCRIPTION. The web
 * viewer -- which is where every one of these filters was written from -- shows
 * you "YES". The REST response gives you `1`. Both of those are the same field.
 * A filter that compares the response against the label the viewer showed
 * matches nothing at all, forever, and the only symptom is a feed that looks
 * like a state with no access sites.
 *
 * Confirmed instances, all the same root cause:
 *   - GA ramps compared 'yes'/'no' against a column carrying Y/N.
 *   - NC paddle compared Non_Motorized_Access against 'yes'; the layer returns
 *     the numeric code 1. 136 qualifying sites came through as 11 -- the 11 were
 *     picked up by the OR's other branch, so it never even looked empty.
 *
 * Accept every encoding these agencies actually use, and let the field's
 * presence, not its spelling, decide.
 */
export function flagIsYes(v) {
  if (v === true || v === 1) return true;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'y' || s === 'yes' || s === '1' || s === 'true' || s === 't';
}

/** Non-empty free-text field (NC uses these alongside the coded flags). */
export function hasText(v) {
  return String(v == null ? '' : v).trim().length > 0;
}

/**
 * Fetch all features from an ArcGIS FeatureServer query endpoint.
 * Handles pagination via resultOffset/resultRecordCount.
 * @param {string} baseUrl - FeatureServer .../query URL
 * @param {string} idField - objectIdFieldName (e.g. OBJECTID or FID for GA WRD)
 */
export async function fetchArcGisAllFeatures(baseUrl, idField = 'OBJECTID') {
  const allFeatures = [];
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({
      outFields: '*',
      where: '1=1',
      f: 'geojson',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
      orderByFields: idField,
    });
    const resp = await fetch(`${baseUrl}?${params}`, {
      headers: { 'User-Agent': 'TrollMap/1.0 (Cloudflare Worker)', Accept: 'application/json' },
      cf: { cacheTtl: 0 },
    });
    if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status} for ${baseUrl}`);
    const data = await resp.json();
    const features = data.features || [];
    allFeatures.push(...features);
    if (features.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return allFeatures;
}

/**
 * Try to get cached R2 JSON if not forceRefresh and not expired.
 * Returns { hit: boolean, body: string|null, ageMs: number|null, meta: object|null }
 */
export async function getCachedGis(env, cacheKey, ttlDays) {
  try {
    const cached = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
    if (!cached) return { hit: false };
    const meta = cached.customMetadata || {};
    // Two cache meta styles in old code: customMetadata.fetchedAt vs uploaded (from cache.uploaded)
    // and also cached.uploaded date
    let fetchedAt = null;
    if (meta.fetchedAt) fetchedAt = new Date(meta.fetchedAt);
    else if (cached.uploaded) fetchedAt = new Date(cached.uploaded);
    else if (meta.uploaded) fetchedAt = new Date(meta.uploaded);
    const ageMs = fetchedAt ? Date.now() - fetchedAt.getTime() : Infinity;
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    if (ageMs < ttlMs) {
      const body = await cached.text();
      return { hit: true, body, ageMs, meta, uploaded: cached.uploaded };
    }
    return { hit: false, stale: cached, ageMs };
  } catch (_) {
    return { hit: false };
  }
}

/**
 * Group ArcGIS features into waterbodies map using source mappers.
 * @param {Array} features - GeoJSON features
 * @param {Object} source - { filter, name, wb, lat, lon, meta?, type?, ... }
 * Returns { waterbodies, stats } where stats is
 *   { fetched, kept, filtered, dropped, mapperErrors, filterRejectedAll }
 *
 * The stats are not decoration. A `filter` that names a field the layer does not
 * return -- because the field was renamed, or because it only ever existed inside
 * the layer's own viewDefinitionQuery -- evaluates against `undefined` on every
 * row, rejects the entire feed, and produces `count: 0` with an empty waterbodies
 * object. That is byte-identical to "this state genuinely has no access sites",
 * so it survives every smoke test and every eyeball. It has now happened twice:
 * GA ramps checked 'yes'/'no' against a Y/N column, and TN paddle checked
 * `IncludeWeb`, which is server-side-only on that layer. `filterRejectedAll`
 * exists so the third time is loud instead of silent.
 */
export function groupFeaturesByWaterbody(features, source) {
  const waterbodies = {};
  let dropped = 0;         // features with no usable lat/lon
  let mapperErrors = 0;    // source.lat / source.lon threw -- a schema change upstream
  let filtered = 0;        // features rejected by source.filter
  for (const feat of features) {
    const p = feat.properties || {};
    if (!source.filter(p)) { filtered++; continue; }
    // lat/lon: prefer source.lat/lon mappers, fallback to geometry
    let lat = null;
    let lon = null;
    try {
      lat = source.lat ? source.lat(p) : null;
      if (lat == null && feat.geometry?.coordinates?.[1] != null) lat = feat.geometry.coordinates[1];
    } catch (err) { mapperErrors++; }
    try {
      lon = source.lon ? source.lon(p) : null;
      if (lon == null && feat.geometry?.coordinates?.[0] != null) lon = feat.geometry.coordinates[0];
    } catch (err) { mapperErrors++; }
    lat = Number(lat);
    lon = Number(lon);
    // A ramp without usable coordinates is DROPPED here, silently, one `continue` at a time.
    // When a state changes its field names the mapper throws on every feature and the whole
    // feed empties out -- and the only symptom is an empty ramp dropdown, which looks exactly
    // like a lake that has no ramps. Counted rather than logged per feature: 438 SC ramps
    // would be 438 lines.
    if (!lat || !lon || Number.isNaN(lat) || Number.isNaN(lon)) { dropped++; continue; }
    const wbRaw = source.wb ? source.wb(p) : 'Unknown';
    let wb = String(wbRaw || 'Unknown Waterbody').trim() || 'Unknown Waterbody';
    let name = String((source.name ? source.name(p) : 'Unnamed') || 'Unnamed').trim() || 'Unnamed';
    if (!waterbodies[wb]) waterbodies[wb] = [];
    const base = { name, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
    if (source.meta) {
      // meta can be object or function returning object
      const m = typeof source.meta === 'function' ? source.meta(p) : source.meta;
      if (m && typeof m === 'object') Object.assign(base, m);
      else base.meta = m;
    }
    if (source.type) {
      const t = typeof source.type === 'function' ? source.type(p) : source.type;
      base.type = String(t || 'Unknown').trim() || 'Unknown';
    }
    // For backward compat: some old code pushed meta as nested `meta` field
    // e.g. paddle pushed {name, lat, lon, meta: {...}} while ramps flattened meta fields.
    // We preserve both styles via options — if source.flattenMeta === false, keep meta nested.
    // Default: flatten for ramps-like, nested for paddle/bank-pier old code? Let's mimic old:
    // We detect: if source uses `meta` returning object but old paddle code pushed `meta: source.meta(p)`,
    // we need to reconstruct. To keep simple and behavior-compatible, we check if source has `metaNested` flag.
    if (source.metaNested) {
      // old paddle/bank-pier style: {name, lat, lon, meta: {...}}
      const entry = { name: base.name, lat: base.lat, lon: base.lon, meta: {} };
      // copy other props into meta if they came from meta mapper
      const rawMeta = source.meta ? source.meta(p) : {};
      entry.meta = rawMeta;
      waterbodies[wb].push(entry);
    } else {
      waterbodies[wb].push(base);
    }
  }
  // Sort each waterbody by name
  for (const wb of Object.keys(waterbodies)) {
    waterbodies[wb].sort((a, b) => a.name.localeCompare(b.name));
  }
  // Report the losses once, with the totals that make them interpretable. A handful of
  // dropped features is ordinary data quality; a `dropped` close to the feature count, or any
  // `mapperErrors` at all, means the upstream schema moved and this feed is now empty.
  const kept = Object.values(waterbodies).reduce((n, v) => n + v.length, 0);
  if (dropped || mapperErrors) {
    console.warn(`[arcgis] kept ${kept}, dropped ${dropped} with no usable lat/lon`
                 + (mapperErrors ? `, ${mapperErrors} lat/lon mapper errors -- upstream schema may have changed` : ''));
  }
  // Total rejection of a non-empty feed is never correct data. The server returned rows;
  // our predicate said none of them count. That is a broken predicate, not an empty state.
  const filterRejectedAll = features.length > 0 && filtered === features.length;
  let sampleKeys = null;
  let sampleRow = null;
  if (filterRejectedAll) {
    // Naming the failure is not enough -- "the filter names a field this layer does not
    // return" is a hypothesis, and the first time this fired for real (TN paddle) the
    // hypothesis was wrong: the field WAS in a direct query. What you actually need is
    // the row as the Worker received it, because the difference between what a browser
    // query returns and what this fetch returns is exactly where these bugs live.
    // `properties` is checked explicitly: an f=json response nests attributes under
    // `attributes`, and reading `.properties` off it yields undefined for every row --
    // which looks like a filter bug and is not one.
    const first = features[0] || {};
    const sample = first.properties || {};
    sampleKeys = Object.keys(sample);
    if (!sampleKeys.length) sampleKeys = Object.keys(first).map((k) => `<no properties; feature keys: ${k}>`);
    sampleRow = {};
    for (const k of Object.keys(sample).slice(0, 60)) {
      const v = sample[k];
      sampleRow[k] = (v && typeof v === 'object') ? '[object]' : v;
    }
    console.error(`[arcgis] FILTER REJECTED ALL ${features.length} features.`
                  + ` Keys on the first row: ${sampleKeys.join(', ') || '(none)'}`);
  }
  return {
    waterbodies,
    sampleKeys,
    sampleRow,
    stats: { fetched: features.length, kept, filtered, dropped, mapperErrors, filterRejectedAll },
  };
}

/**
 * Generic handler for ramps/paddle/bank-pier/attractors routes.
 * Preserves previous cache keys, TTL, and response shapes as much as possible,
 * while unifying pagination and grouping logic.
 *
 * @param {Object} opts
 * @param {Request} opts.request - original request (unused but for signature)
 * @param {Object} opts.env - Cloudflare env with R2 bucket
 * @param {URL} opts.url - parsed URL with searchParams
 * @param {string} opts.cachePrefix - e.g. 'ramps' or 'paddle'
 * @param {number} opts.ttlDays - cache TTL days
 * @param {Object} opts.sources - map state -> source config {url, idField?, filter, name, wb, lat, lon, meta?, type?, label?, metaNested?}
 * @param {Function} opts.buildResult - (state, source, waterbodies) => result object to JSON.stringify
 * @param {Function} opts.getCacheHeaders - (isHit, extra) => headers object
 * Returns Response
 */
export async function handleGisRoute({ env, url, cachePrefix, ttlDays, sources, buildResult }) {
  const state = (url.searchParams.get('state') || 'SC').toUpperCase();
  const forceRefresh = url.searchParams.has('refresh');
  const cacheKey = `${cachePrefix}/${state.toLowerCase()}/${cachePrefix}.json`;
  const source = sources[state];
  if (!source) {
    const { JSON_HEADERS } = await import('../worker-core.js');
    return new Response(JSON.stringify({ error: `Unknown state: ${state}` }), {
      headers: JSON_HEADERS,
      status: 400,
    });
  }

  // A source with no url produces `fetch('undefined?outFields=*&...')`, which throws,
  // which lands in the stale-cache fallback below and hands back a body some earlier
  // build wrote -- so a config typo renders as plausible-looking data from the past.
  // That is how a dropped `url:` line survived four deploys on 2026-08-04. Refuse it
  // here, by name, before anything can paper over it.
  for (const key of ['url', 'filter', 'name', 'wb']) {
    if (source[key] == null) {
      const { JSON_HEADERS } = await import('../worker-core.js');
      return new Response(JSON.stringify({
        error: `${cachePrefix} source for ${state} is missing "${key}"`,
        hint: 'This is a Worker config bug, not an upstream outage. No cached fallback'
              + ' is served for it, deliberately -- stale data would hide it.',
      }), { headers: JSON_HEADERS, status: 500 });
    }
  }

  // Try cache
  if (!forceRefresh) {
    const cached = await getCachedGis(env, cacheKey, ttlDays);
    if (cached.hit && cached.body) {
      const ageHours = cached.ageMs ? Math.round(cached.ageMs / 36e5) : 0;
      const ageDays = cached.ageMs ? (cached.ageMs / 864e5).toFixed(1) : '0';
      // Preserve old header names: X-Cache, X-Cache-Age, X-Cache-Age-Days, X-Ramp-Count etc
      const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'X-Cache': 'HIT',
        'X-Cache-Age': `${ageHours}h`,
        'X-Cache-Age-Days': ageDays,
      };
      // Some old routes used customMetadata count
      if (cached.meta?.count) headers['X-Ramp-Count'] = String(cached.meta.count);
      if (cachePrefix === 'ramps') {
        // also include count if available
        try {
          const parsed = JSON.parse(cached.body);
          if (parsed.count) headers['X-Ramp-Count'] = String(parsed.count);
        } catch (_) {
          // Intentionally silent: X-Ramp-Count is a debugging convenience on a cache HIT and
          // the body is returned intact either way, so a failure here costs a header nobody
          // reads. Audited 2026-08-03 -- logging it would put a line on every cached request.
        }
      }
      return new Response(cached.body, { headers });
    }
  }

  try {
    const idField = source.idField || 'OBJECTID';
    const allFeatures = await fetchArcGisAllFeatures(source.url, idField);
    const { waterbodies, stats, sampleKeys, sampleRow } = groupFeaturesByWaterbody(allFeatures, source);
    const flatCount = stats.kept;
    const result = buildResult(state, source, waterbodies, flatCount, allFeatures.length);
    // Surfaced in the JSON body, not just the Worker log, because the only way anyone
    // looks at this data is `curl .../paddle?state=TN` -- and a bare `count: 0` reads as
    // "TN has no paddle access" when it actually means "the filter is broken".
    if (stats.filterRejectedAll) {
      result.warning = `filter rejected all ${stats.fetched} features returned by the source`;
      result.fetchedFeatures = stats.fetched;
      result.availableFields = sampleKeys;
      result.sampleRow = sampleRow;
    }
    const body = JSON.stringify(result);
    // Store with metadata for cache age checks
    await env.R2_TROLLMAP_CHARTPACKS.put(cacheKey, body, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        fetchedAt: result.fetched || new Date().toISOString(),
        uploaded: new Date().toISOString(),
        state,
        count: String(flatCount),
      },
    });
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'X-Cache': 'MISS',
      'X-Ramp-Count': String(flatCount),
    };
    return new Response(body, { headers });
  } catch (err) {
    // Try to serve stale cache on failure (old ramps logic did this).
    //
    // Serving stale on an upstream blip is right. Serving it in a body that looks
    // exactly like a fresh one is not, and it cost an afternoon on 2026-08-04: TN
    // paddle returned a body written by a build from three commits earlier, complete
    // with that build's warning text, while `X-Cache: STALE` and the actual error sat
    // in headers that `curl` does not print without -i. Every conclusion drawn from
    // that body was a conclusion about code that was no longer deployed.
    //
    // So the staleness goes IN THE BODY. Headers are for machines; the body is what a
    // person reads.
    try {
      const stale = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
      if (stale) {
        const raw = await stale.text();
        let body = raw;
        try {
          const parsed = JSON.parse(raw);
          const uploaded = stale.uploaded ? new Date(stale.uploaded) : null;
          parsed.stale = true;
          parsed.staleError = err.message;
          parsed.staleFetchedAt = stale.customMetadata?.fetchedAt
                                  || (uploaded ? uploaded.toISOString() : null);
          parsed.staleAgeHours = uploaded
            ? Math.round((Date.now() - uploaded.getTime()) / 36e5) : null;
          parsed.note = 'THIS IS CACHED DATA. The live fetch failed; every other field'
                        + ' below was produced by whatever code was deployed at'
                        + ' staleFetchedAt, not by the current build.';
          body = JSON.stringify(parsed);
        } catch (_) {
          // Not JSON, or not an object. Hand back exactly what was stored rather than
          // wrapping it -- callers that were parsing it before must keep working.
        }
        return new Response(body, {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'X-Cache': 'STALE',
            'X-Cache-Error': err.message,
          },
        });
      }
    } catch (staleErr) {
      // The stale-cache fallback is the last thing standing between an upstream outage and a
      // 502. If IT fails too, that is worth saying out loud -- otherwise the 502 below looks
      // like the feed simply being down, rather than the feed being down AND the cache being
      // unreadable.
      console.error(`[arcgis] stale-cache fallback failed for ${state} ${cachePrefix}:`,
                    staleErr && staleErr.message);
    }
    const { JSON_HEADERS } = await import('../worker-core.js');
    return new Response(JSON.stringify({ error: `Failed to fetch ${state} ${cachePrefix} data: ${err.message}` }), {
      headers: JSON_HEADERS,
      status: 502,
    });
  }
}
