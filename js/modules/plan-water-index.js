/**
 * plan-water-index.js — the two spatial lookups the water reasons need, and nothing else.
 *
 * Both read layers that ALREADY SHIP in every pack and are ALREADY IN R2. No refit, no pipeline
 * change. That is worth stating because I twice offered Ryan a fitter change for exactly these
 * two answers before checking what was in the bucket:
 *
 *   depth_areas.geojson      6,714 banded polygons on Wateree -> which side the bottom rises on
 *   garmin_shoreline.geojson 2,573 LineStrings, 26,213 vertices, 1 MB -> where the land is
 *
 * Pure. No DOM, no fetch — the caller hands in parsed GeoJSON, so the whole path runs in a test.
 *
 * WHY BOTH ARE GRIDDED. A leg wants nine samples, a lake has 200+ legs, and a naive scan is
 * 6,714 point-in-polygon tests per sample. Bucketing by a coarse cell turns each lookup into a
 * handful of candidates, which is the difference between a tab that answers and one that hangs.
 */

const M_PER_DEG_LAT = 110540.0;
const m_per_deg_lon = (lat) => 111320.0 * Math.cos((lat * Math.PI) / 180);

/** Ray casting. Returns true when the point is inside the ring. */
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > pt[1]) !== (yj > pt[1]))
        && (pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/**
 * Depth lookup from depth_areas.geojson.
 *
 * Returns the SHALLOWEST band containing the point. Depth areas nest — a 0-1 ft polygon sits
 * inside a 0-5 ft one — so the smallest `depth_max_ft` covering a point is the real answer and
 * taking the first hit would report whichever polygon happened to be indexed first.
 *
 * Returns null where nothing covers the point. Null is UNCHARTED and must not be read as deep;
 * that mistake has cost this project two bugs in the pipeline already.
 */
export function depthSampler(features, { cellDeg = 0.002 } = {}) {
  const grid = new Map();
  const polys = [];
  for (const f of (features || [])) {
    const g = f && f.geometry;
    if (!g || g.type !== 'Polygon' || !Array.isArray(g.coordinates)) continue;
    const p = f.properties || {};
    const maxFt = Number(p.depth_max_ft);
    if (!Number.isFinite(maxFt)) continue;
    const i = polys.push({ rings: g.coordinates, maxFt }) - 1;
    let a = 180, b = 90, c = -180, d = -90;
    for (const pt of g.coordinates[0]) {
      if (pt[0] < a) a = pt[0]; if (pt[1] < b) b = pt[1];
      if (pt[0] > c) c = pt[0]; if (pt[1] > d) d = pt[1];
    }
    for (let x = Math.floor(a / cellDeg); x <= Math.floor(c / cellDeg); x++) {
      for (let y = Math.floor(b / cellDeg); y <= Math.floor(d / cellDeg); y++) {
        const k = `${x},${y}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  }
  return (pt) => {
    const k = `${Math.floor(pt[0] / cellDeg)},${Math.floor(pt[1] / cellDeg)}`;
    let best = null;
    for (const i of (grid.get(k) || [])) {
      const q = polys[i];
      if (!inRing(pt, q.rings[0])) continue;
      // Holes are real: an island inside a depth band is not that depth.
      let hole = false;
      for (let h = 1; h < q.rings.length; h++) if (inRing(pt, q.rings[h])) { hole = true; break; }
      if (hole) continue;
      if (best == null || q.maxFt < best) best = q.maxFt;
    }
    return best;
  };
}

/**
 * IS THERE CHARTED WATER HERE — a different question from how deep it is, and a much cheaper one.
 *
 * depthSampler() answers "how deep", exactly, by testing the point against the depth bands that
 * cover it. Bands NEST, so a point in 30 ft of water sits inside the 30 ft band and outside the
 * twenty-nine shallower ones, and finding that out costs about twenty-five polygon tests -- 57 to
 * 72 microseconds however the index is arranged. Measured: shrinking the index cells from 223 m
 * to 28 m changed nothing at all, and flattening every ring into typed arrays bought 21%. The
 * work is real and it is not going away.
 *
 * That is affordable for the nine samples a leg takes and unaffordable in bulk. trimHook() walks
 * sixteen bearings off a lane end until the water runs out, and on Wateree that put the Water tab
 * at TWELVE SECONDS. Ryan: "whatever gets the job done most efficiently without increasing time
 * on an already long process."
 *
 * SO THIS ANSWERS THE COARSE QUESTION COARSELY. One rasterised bitmap of the charted water, 20 m
 * cells, built once. Lookups are an array index -- 20,000 of them in one millisecond against two
 * seconds for the exact test, two thousand times faster.
 *
 * AND IT IS ONLY HONEST FOR THIS ONE QUESTION. Measured against depthSampler() over 20,000 points
 * along Wateree's fitted lanes:
 *
 *   water-vs-land          99.94% agreement -- 11 points of 20,000
 *   the DEPTH it implies   10.6% differ by 2 ft or more, median -1 ft, p10 -2, p90 +2
 *
 * The depth error is symmetric (mean -0.15 ft) so it is resolution rather than a bug, and it is
 * still far too much to size a bait with -- two feet is the difference between a crankbait
 * clearing a shoal and being left on it. So this returns a BOOLEAN and cannot be mistaken for a
 * depth. Anything that needs feet still pays for depthSampler().
 */
export function waterMask(features, { cellM = 20 } = {}) {
  const polys = [];
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  for (const f of (features || [])) {
    const g = f && f.geometry;
    if (!g || g.type !== 'Polygon' || !Array.isArray(g.coordinates)) continue;
    if (!Number.isFinite(Number((f.properties || {}).depth_max_ft))) continue;
    polys.push(g.coordinates);
    for (const pt of g.coordinates[0]) {
      if (pt[0] < x0) x0 = pt[0]; if (pt[1] < y0) y0 = pt[1];
      if (pt[0] > x1) x1 = pt[0]; if (pt[1] > y1) y1 = pt[1];
    }
  }
  if (!polys.length) return () => false;

  // Square cells in METRES, so a step of `cellM` means the same distance in both directions.
  const dLat = cellM / M_PER_DEG_LAT;
  const dLon = cellM / m_per_deg_lon((y0 + y1) / 2);
  const w = Math.max(1, Math.ceil((x1 - x0) / dLon) + 1);
  const h = Math.max(1, Math.ceil((y1 - y0) / dLat) + 1);
  const grid = new Uint8Array(w * h);

  // Scanline fill, every ring of a polygon at once: outer and holes together, so even-odd cancels
  // an island inside a band without it being a case of its own. Nothing is painted OFF here --
  // the union of every band is the charted water, and a hole in one band is another band's fill.
  const xs = [];
  for (const rings of polys) {
    let ry0 = 90, ry1 = -90;
    for (const r of rings) for (const pt of r) { if (pt[1] < ry0) ry0 = pt[1]; if (pt[1] > ry1) ry1 = pt[1]; }
    const jFrom = Math.max(0, Math.floor((ry0 - y0) / dLat));
    const jTo = Math.min(h - 1, Math.ceil((ry1 - y0) / dLat));
    for (let j = jFrom; j <= jTo; j++) {
      const yc = y0 + (j + 0.5) * dLat;
      xs.length = 0;
      for (const r of rings) {
        for (let i = 0, k = r.length - 1; i < r.length; k = i++) {
          const yi = r[i][1], yk = r[k][1];
          if ((yi > yc) !== (yk > yc)) xs.push(r[k][0] + ((yc - yk) / (yi - yk)) * (r[i][0] - r[k][0]));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      const row = j * w;
      for (let n = 0; n + 1 < xs.length; n += 2) {
        let iFrom = Math.ceil((xs[n] - x0) / dLon - 0.5);
        let iTo = Math.floor((xs[n + 1] - x0) / dLon - 0.5);
        if (iTo < 0 || iFrom > w - 1) continue;
        if (iFrom < 0) iFrom = 0;
        if (iTo > w - 1) iTo = w - 1;
        grid.fill(1, row + iFrom, row + iTo + 1);
      }
    }
  }

  return (pt) => {
    const i = Math.round((pt[0] - x0) / dLon - 0.5);
    const j = Math.round((pt[1] - y0) / dLat - 0.5);
    if (i < 0 || j < 0 || i >= w || j >= h) return false;
    return grid[j * w + i] === 1;
  };
}

/**
 * Nearest-shoreline lookup from garmin_shoreline.geojson.
 *
 * VERTICES, NOT SEGMENTS. The shoreline is sampled every few metres, so the nearest vertex is
 * within a metre or two of the nearest point on the line — far inside the precision that
 * "the bank is 380 m that way" needs, and it avoids a point-to-segment projection per candidate.
 *
 * The search widens by ring until it finds something or gives up at `maxM`, so a leg in open
 * water does not scan the whole lake before returning null.
 */
export function shorelineIndex(features, { cellDeg = 0.004 } = {}) {
  const grid = new Map();
  const pts = [];
  for (const f of (features || [])) {
    const g = f && f.geometry;
    if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates]
                : g.type === 'MultiLineString' ? g.coordinates
                : g.type === 'Polygon' ? g.coordinates
                : [];
    for (const line of lines) {
      for (const c of line) {
        const i = pts.push(c) - 1;
        const k = `${Math.floor(c[0] / cellDeg)},${Math.floor(c[1] / cellDeg)}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  }
  const nearest = (pt, maxM = 1200) => {
    const gx = Math.floor(pt[0] / cellDeg), gy = Math.floor(pt[1] / cellDeg);
    const kx = m_per_deg_lon(pt[1]);
    let best = null, bestD = Infinity;
    // Cell is ~370 m at this latitude, so three rings covers the 1,200 m default.
    for (let r = 0; r <= 3; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;   // ring, not disc
          for (const i of (grid.get(`${gx + dx},${gy + dy}`) || [])) {
            const q = pts[i];
            const d = Math.hypot((q[0] - pt[0]) * kx, (q[1] - pt[1]) * M_PER_DEG_LAT);
            if (d < bestD) { bestD = d; best = q; }
          }
        }
      }
      // Only stop once the ring searched is wider than the best hit, or the answer can be beaten
      // by a point one ring further out.
      if (best && bestD <= r * cellDeg * M_PER_DEG_LAT) break;
    }
    return best && bestD <= maxM ? { at: best, distM: Math.round(bestD) } : null;
  };
  return { nearest, count: pts.length };
}
