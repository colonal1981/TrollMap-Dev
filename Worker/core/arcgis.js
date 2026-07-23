// Worker/core/arcgis.js — shared ArcGIS helper for ramps/paddle/bank-pier/attractors
// Extracted from trollmap-worker.js 4 copy-paste blocks (Phase P1 dedupe)
// Behavior-preserving: same pagination, same cache TTL, same waterbody grouping, same R2 keys

const PAGE_SIZE = 1000;

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
 * @param {Object} opts - { useGeometryFallback: boolean }
 * Returns waterbodies object: { [waterbodyName]: Array<{name, lat, lon, ...meta}> }
 */
export function groupFeaturesByWaterbody(features, source) {
  const waterbodies = {};
  for (const feat of features) {
    const p = feat.properties || {};
    if (!source.filter(p)) continue;
    // lat/lon: prefer source.lat/lon mappers, fallback to geometry
    let lat = null;
    let lon = null;
    try {
      lat = source.lat ? source.lat(p) : null;
      if (lat == null && feat.geometry?.coordinates?.[1] != null) lat = feat.geometry.coordinates[1];
    } catch (_) {}
    try {
      lon = source.lon ? source.lon(p) : null;
      if (lon == null && feat.geometry?.coordinates?.[0] != null) lon = feat.geometry.coordinates[0];
    } catch (_) {}
    lat = Number(lat);
    lon = Number(lon);
    if (!lat || !lon || Number.isNaN(lat) || Number.isNaN(lon)) continue;
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
  return waterbodies;
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
        } catch (_) {}
      }
      return new Response(cached.body, { headers });
    }
  }

  try {
    const idField = source.idField || 'OBJECTID';
    const allFeatures = await fetchArcGisAllFeatures(source.url, idField);
    const waterbodies = groupFeaturesByWaterbody(allFeatures, source);
    const flatCount = Object.values(waterbodies).reduce((s, arr) => s + arr.length, 0);
    const result = buildResult(state, source, waterbodies, flatCount, allFeatures.length);
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
    // Try to serve stale cache on failure (old ramps logic did this)
    try {
      const stale = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
      if (stale) {
        const body = await stale.text();
        return new Response(body, {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'X-Cache': 'STALE',
            'X-Cache-Error': err.message,
          },
        });
      }
    } catch (_) {}
    const { JSON_HEADERS } = await import('../worker-core.js');
    return new Response(JSON.stringify({ error: `Failed to fetch ${state} ${cachePrefix} data: ${err.message}` }), {
      headers: JSON_HEADERS,
      status: 502,
    });
  }
}
