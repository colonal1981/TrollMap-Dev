// research/vision.js — split from worker-research.js (behavior-preserving)
import { JSON_HEADERS } from '../worker-core.js';
import { resolveSupplementalKeyWorker } from './limnology.js';

async function handleResearchVisionScan(request, env) {
  const body = await request.json().catch(() => ({}));
  const { lakeName, tileBounds } = body;
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });

  // Tile plan request — return bbox and tile list so browser can drive the scan
  if (!tileBounds) {
    const resolvedKey = resolveSupplementalKeyWorker(lakeName);

    // Load boundary geometry — prefer shoreline.geojson, fall back to 3DHP boundary polygon.
    // Shoreline is a LineString (i-boating derived); boundary is a Polygon (USGS 3DHP).
    // Both work for bbox derivation and point-in-polygon tile filtering.
    let geo = null;
    let boundarySource = null;
    const shorelineObj = await env.R2_TROLLMAP_CHARTPACKS.get(`supplemental/${resolvedKey}/shoreline.geojson`);
    if (shorelineObj) {
      geo = JSON.parse(await shorelineObj.text());
      boundarySource = 'shoreline';
    } else {
      const boundaryObj = await env.R2_TROLLMAP_CHARTPACKS.get(`boundaries/${resolvedKey}_3dhp.geojson`);
      if (boundaryObj) {
        geo = JSON.parse(await boundaryObj.text());
        boundarySource = '3dhp_boundary';
      }
    }
    if (!geo) return new Response(JSON.stringify({ ok: false, error: `no shoreline or 3DHP boundary found for ${resolvedKey}` }), { status: 400, headers: JSON_HEADERS });
    console.log(`[vision-scan] using ${boundarySource} for tile plan: ${resolvedKey}`);

    const coords = [];
    const extractCoords = (obj) => {
      if (!obj) return;
      if (obj.type === 'Feature') extractCoords(obj.geometry);
      else if (obj.type === 'FeatureCollection') obj.features?.forEach(extractCoords);
      else if (obj.coordinates) {
        const flat = obj.coordinates.flat(Infinity);
        const stride = (flat.length % 3 === 0 && flat.length % 2 !== 0) ? 3 : 2;
        for (let i = 0; i < flat.length - stride + 1; i += stride) coords.push([flat[i], flat[i+1]]);
      }
    };
    extractCoords(geo);
    if (!coords.length) return new Response(JSON.stringify({ ok: false, error: `no coords in ${boundarySource}` }), { status: 400, headers: JSON_HEADERS });
    const lons = coords.map(c => c[0]), lats = coords.map(c => c[1]);
    const bboxW = Math.min(...lons), bboxE = Math.max(...lons);
    const bboxS = Math.min(...lats), bboxN = Math.max(...lats);
    // Scale tile size to lake extent — target ~8x8 grid
    const latSpan = bboxN - bboxS;
    const lonSpan = bboxE - bboxW;
    const TILE_DEG = Math.max(0.004, Math.max(latSpan, lonSpan) / 8);
    const MAX_TILES = 100;

    // Point-in-polygon — only tile centers inside the lake boundary
    function pointInPoly(lon, lat, polyCoords) {
      let inside = false;
      for (let i = 0, j = polyCoords.length - 1; i < polyCoords.length; j = i++) {
        const xi = polyCoords[i][0], yi = polyCoords[i][1];
        const xj = polyCoords[j][0], yj = polyCoords[j][1];
        if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    }

    const tiles = [];
    for (let lat = bboxS; lat < bboxN; lat += TILE_DEG) {
      for (let lon = bboxW; lon < bboxE; lon += TILE_DEG) {
        const cLat = lat + TILE_DEG / 2;
        const cLon = lon + TILE_DEG / 2;
        if (!pointInPoly(cLon, cLat, coords)) continue;
        tiles.push({ s: lat, n: Math.min(lat + TILE_DEG, bboxN), w: lon, e: Math.min(lon + TILE_DEG, bboxE) });
        if (tiles.length >= MAX_TILES) break;
      }
      if (tiles.length >= MAX_TILES) break;
    }
    // Write initial status
    try {
      await env.R2_TROLLMAP_CHARTPACKS.put(
        `supplemental/${resolvedKey}/vision-scan-status.json`,
        JSON.stringify({ status: 'scanning', lakeName, lakeKey: resolvedKey, boundarySource, tilesTotal: tiles.length, tilesProcessed: 0, structuresFound: 0, startedAt: new Date().toISOString() }),
        { httpMetadata: { contentType: 'application/json' } }
      );
    } catch (_) {}
    return new Response(JSON.stringify({ ok: true, tiles, lakeKey: resolvedKey }), { headers: JSON_HEADERS });
  }

  // Single tile analysis — worker fetches ESRI image (no CORS) + runs Gemini
  if (!tileBounds) return new Response(JSON.stringify({ ok: false, error: 'missing tileBounds' }), { status: 400, headers: JSON_HEADERS });

  const geminiKeys = [env.GEMINI_FREE_API_KEY, env.GEMINI_FREE2_API_KEY, env.GEMINI_FREE3_API_KEY, env.GEMINI_FREE4_API_KEY, env.GEMINI_FREE5_API_KEY].filter(Boolean);
  if (!geminiKeys.length) return new Response(JSON.stringify({ ok: false, error: 'no Gemini keys' }), { status: 500, headers: JSON_HEADERS });

  // Fetch ESRI satellite image from worker (no CORS restrictions)
  const { s, n, w, e } = tileBounds;
  const bbox = `${w},${s},${e},${n}`;
  const esriUrl = `https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${encodeURIComponent(bbox)}&bboxSR=4326&imageSR=4326&size=800,800&format=jpg&transparent=false&f=image`;
  const imgController = new AbortController();
  const imgTimeout = setTimeout(() => imgController.abort(), 12000);
  let imgRes;
  try {
    imgRes = await fetch(esriUrl, { signal: imgController.signal });
  } finally {
    clearTimeout(imgTimeout);
  }
  if (!imgRes.ok) return new Response(JSON.stringify({ ok: false, error: `ESRI ${imgRes.status}`, features: [] }), { headers: JSON_HEADERS });

  const buf = await imgRes.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const imageBase64 = btoa(binary);

  const MODEL = 'gemini-3.1-flash-lite';
  const prompt = `Analyze this aerial/satellite image of a freshwater lake.

Identify ONLY these structure types that are CLEARLY VISIBLE:
1. DOCK_CLUSTER — 3 or more docks/piers concentrated in one area
2. RIPRAP — rock or concrete revetment along a shoreline
3. BRIDGE — bridge crossing the water with visible pilings
4. FLOODED_TIMBER — standing dead trees or stumps in or at water's edge

DO NOT report individual docks, vegetation, boats, or anything below the water surface.
Give the centre of each detected structure as INTEGER PIXEL coordinates in the 800x800 image: x is pixels from the LEFT (0–799) and y is pixels from the TOP (0–799). Do not use latitude/longitude, percentages, fractions, or normalized 0–1 coordinates. A marker must identify the visible structure itself, not a nearby shoreline or the centre of the tile.

Return ONLY valid JSON:
{"structures":[{"type":"DOCK_CLUSTER|RIPRAP|BRIDGE|FLOODED_TIMBER","x":400,"y":400,"confidence":0.85,"description":"brief","dock_count_estimate":null}],"has_water":true}
If nothing found: {"structures":[],"has_water":true}`;

  for (let attempt = 0; attempt < geminiKeys.length; attempt++) {
    const key = geminiKeys[attempt % geminiKeys.length];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: imageBase64 } }, { text: prompt }] }],
          generationConfig: { temperature: 0.05, maxOutputTokens: 600, responseMimeType: 'application/json' }
        })
      });
      if (r.status === 429) { continue; }
      if (!r.ok) throw new Error(`Gemini ${r.status}`);
      const data = await r.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const result = JSON.parse(text.replace(/```json|```/g, '').trim());
      console.log(`[vision-scan] raw structures: ${JSON.stringify(result.structures)} tileBounds: ${JSON.stringify({s,n,w,e})}`);
      const IMG_SIZE = 800;
      const features = (result.structures || [])
        .filter(st => (st.confidence || 0) >= 0.6)
        .map(st => {
          // Robust coordinate parsing — handles Gemini inventing field names like "y_760"
          const extract = (axis) => {
            if (st[axis] !== undefined) return parseFloat(st[axis]);
            if (st[`${axis}_frac`] !== undefined) return parseFloat(st[`${axis}_frac`]);
            if (st[`${axis}_pixel`] !== undefined) return parseFloat(st[`${axis}_pixel`]);
            const key = Object.keys(st).find(k => k.toLowerCase().startsWith(axis));
            return key ? parseFloat(st[key]) : null;
          };
          const xVal = extract('x');
          const yVal = extract('y');
          // Reject invalid coordinates — never default to tile centre
          if (!Number.isFinite(xVal) || !Number.isFinite(yVal) || xVal < 0 || xVal >= IMG_SIZE || yVal < 0 || yVal >= IMG_SIZE) return null;
          const xFrac = xVal / IMG_SIZE;
          const yFrac = yVal / IMG_SIZE;
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [w + (e - w) * xFrac, n - (n - s) * yFrac] },
            properties: { structure_type: st.type, confidence: st.confidence, description: st.description || '', dock_count_estimate: st.dock_count_estimate || null, source: 'gemini_vision', image_position_px: { x: xVal, y: yVal }, tile_bounds: { s, n, w, e }, scanned_at: new Date().toISOString() }
          };
        })
        .filter(Boolean);
      return new Response(JSON.stringify({ ok: true, hasWater: result.has_water, features }), { headers: JSON_HEADERS });
    } catch (e) {
      if (attempt === geminiKeys.length - 1) {
        return new Response(JSON.stringify({ ok: false, error: e.message, features: [] }), { headers: JSON_HEADERS });
      }
    }
  }
  return new Response(JSON.stringify({ ok: false, error: 'all Gemini keys failed', features: [] }), { headers: JSON_HEADERS });
}

// Save accumulated vision scan results to R2
async function handleResearchVisionScanSave(request, env) {
  const body = await request.json().catch(() => ({}));
  const { lakeName, features, tilesTotal, tilesProcessed, tilesSkipped } = body;
  if (!lakeName || !features) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName or features' }), { status: 400, headers: JSON_HEADERS });
  const resolvedKey = resolveSupplementalKeyWorker(lakeName);
  const geojson = {
    type: 'FeatureCollection', features,
    metadata: { lakeName, lakeKey: resolvedKey, tilesTotal, tilesProcessed, tilesSkipped, structuresFound: features.length, scannedAt: new Date().toISOString(), model: 'gemini-3.1-flash-lite' }
  };
  await env.R2_TROLLMAP_CHARTPACKS.put(`supplemental/${resolvedKey}/vision-structure.geojson`, JSON.stringify(geojson), { httpMetadata: { contentType: 'application/json' } });
  await env.R2_TROLLMAP_CHARTPACKS.put(`supplemental/${resolvedKey}/vision-scan-status.json`,
    JSON.stringify({ status: 'complete', lakeName, lakeKey: resolvedKey, tilesTotal, tilesProcessed, structuresFound: features.length, completedAt: new Date().toISOString() }),
    { httpMetadata: { contentType: 'application/json' } }
  );
  return new Response(JSON.stringify({ ok: true, structuresFound: features.length }), { headers: JSON_HEADERS });
}


async function handleResearchVisionScanStatus(request, env) {
  const body = await request.json().catch(() => ({}));
  const { lakeName } = body;
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });
  const resolvedKey = resolveSupplementalKeyWorker(lakeName);
  try {
    const statusObj = await env.R2_TROLLMAP_CHARTPACKS.get(`supplemental/${resolvedKey}/vision-scan-status.json`);
    if (!statusObj) return new Response(JSON.stringify({ ok: true, status: 'not_started' }), { headers: JSON_HEADERS });
    const status = JSON.parse(await statusObj.text());
    // Check if GeoJSON result also exists
    const resultObj = await env.R2_TROLLMAP_CHARTPACKS.head(`supplemental/${resolvedKey}/vision-structure.geojson`);
    return new Response(JSON.stringify({ ok: true, ...status, hasResult: !!resultObj }), { headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: JSON_HEADERS });
  }
}



// ─── BATCH PROXY DOWNLOAD ────────────────────────────────────────────────────
// Fetches up to 10 HTML URLs in a single TinyFish batch call.
// PDFs, NEPIS, and other special sources are excluded from the batch and must
// be fetched individually via handleResearchProxyDownload.
// Returns: { results: [{ url, text, source, ok, error }] }

export { handleResearchVisionScan, handleResearchVisionScanSave, handleResearchVisionScanStatus };
