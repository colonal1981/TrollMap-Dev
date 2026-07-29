/**
 * qdc-decoder.js — pure functions: raw .qdc folder → grid → contour GeoJSON.
 * No DOM, no state, no map — just data in, GeoJSON out. Import into
 * contour-data.js (or anywhere else) and wire to whatever UI/state you want.
 *
 * Pipeline: parseQDCFolder() -> buildDepthGrid() -> contourGrid()
 *
 * parseQDCFolder is a direct port of qdc-converter's cli.py, including the
 * sentinel-value fix from github.com/interlark/qdc-converter/issues/3
 * (x_min/x_max/y_min/y_max must start at the true int16 boundary, not
 * ±32000, or extreme-value points get silently dropped and the grid
 * misaligns — confirmed by the original VBA-script author).
 *
 * buildDepthGrid / contourGrid / marchingSquares are ports of the
 * qdc_to_trollmap.py Marching Squares contour engine, unchanged logic
 * from the old monolithic index_old.html.
 */

// ═══════════════════════════════════════════════════════════════════════
// Raw .qdc binary decoder
// ═══════════════════════════════════════════════════════════════════════

const QDC_LAYER_PARAMETERS = {
  0: { a_step: 90 / 2 ** 22, n_sectors: 7, f_size1: 372736, f_offset1: 4097,
       f_size2: 352256, f_offset2: 4097, f_size3: -1, f_offset3: 0,
       f_size4: -1, f_offset4: 0, l_size: 256, l_size2: 256 },
  1: { a_step: 90 / 2 ** 21, n_sectors: 3, f_size1: 372736, f_offset1: 266241,
       f_size2: 352256, f_offset2: 266241, f_size3: 110592, f_offset3: 4097,
       f_size4: 90112, f_offset4: 4097, l_size: 128, l_size2: 128 },
  2: { a_step: 90 / 2 ** 20, n_sectors: 1, f_size1: 372736, f_offset1: 331777,
       f_size2: 352256, f_offset2: 331777, f_size3: 110592, f_offset3: 69633,
       f_size4: 90112, f_offset4: 69633, l_size: 64, l_size2: 64 },
  3: { a_step: 90 / 2 ** 19, n_sectors: 0, f_size1: 372736, f_offset1: 348161,
       f_size2: 352256, f_offset2: 348161, f_size3: 110592, f_offset3: 86017,
       f_size4: 90112, f_offset4: 86017, l_size: 32, l_size2: 32 },
  4: { a_step: 90 / 2 ** 18, n_sectors: 1, f_size1: 372736, f_offset1: 352257,
       f_size2: -1, f_offset2: 0, f_size3: 110592, f_offset3: 90113,
       f_size4: -1, f_offset4: 0, l_size: 64, l_size2: 16 },
  5: { a_step: 90 / 2 ** 17, n_sectors: 0, f_size1: 372736, f_offset1: 368641,
       f_size2: -1, f_offset2: 0, f_size3: 110592, f_offset3: 106497,
       f_size4: -1, f_offset4: 0, l_size: 32, l_size2: 8 },
};

function _qdcInt16(dv, offset) {
  return dv.getInt16(offset, true); // little-endian
}

/**
 * Decode a folder of raw .qdc files into {lat, lon, depth(ft)} points.
 * @param {File[]} files - .qdc File objects (from a webkitdirectory input)
 * @param {number} [layer=1] - 0-5, matches qdc-converter's -l flag
 * @param {function} [onProgress] - callback(current, total, stage)
 */
export async function parseQDCFolder(files, layer = 1, onProgress = null) {
  const params = QDC_LAYER_PARAMETERS[layer];
  if (!params) throw new Error(`Invalid QDC layer: ${layer} (must be 0-5)`);

  const validSizes = [params.f_size1, params.f_size2, params.f_size3, params.f_size4]
    .filter((s) => s > 0);

  const matched = [];
  for (const file of files) {
    if (validSizes.includes(file.size)) {
      const buf = await file.arrayBuffer();
      matched.push({ file, dv: new DataView(buf) });
    }
  }
  if (matched.length === 0) {
    throw new Error('No valid QDC files found for this layer (file sizes did not match).');
  }

  // Boundary scan — sentinels fixed to true int16 range (issue #3 fix)
  let x_min = 32767, y_min = 32767;
  let x_max = -32768, y_max = -32768;
  for (const { dv } of matched) {
    const xVal = _qdcInt16(dv, 164);
    x_min = Math.min(xVal, x_min);
    x_max = Math.max(xVal, x_max);
    const yVal = _qdcInt16(dv, 160);
    y_min = Math.min(yVal, y_min);
    y_max = Math.max(yVal, y_max);
  }
  if (x_min === 32767 || y_min === 32767 || x_max === -32768 || y_max === -32768) {
    throw new Error('No valid QDC files found!');
  }

  const x_size = (x_max - x_min + 1) * params.l_size;
  const y_size = (y_max - y_min + 1) * params.l_size;
  const arrDepth = new Int16Array(x_size * y_size);

  let processed = 0;
  for (const { file, dv } of matched) {
    const xVal = _qdcInt16(dv, 164);
    const x_orig = (xVal - x_min) * params.l_size2;
    const yVal = _qdcInt16(dv, 160);
    const y_orig = (yVal - y_min) * params.l_size2;

    let i;
    if (file.size === params.f_size1) i = params.f_offset1;
    else if (file.size === params.f_size2) i = params.f_offset2;
    else if (file.size === params.f_size3) i = params.f_offset3;
    else if (file.size === params.f_size4) i = params.f_offset4;

    for (let yy = 0; yy <= params.n_sectors; yy++) {
      for (let xx = 0; xx <= params.n_sectors; xx++) {
        for (let y = 0; y < 32; y++) {
          for (let x = 0; x < 32; x++) {
            const x_abs = xx * 32 + x + x_orig;
            const y_abs = yy * 32 + y + y_orig;
            if (i + 2 < dv.byteLength && i - 1 >= 0) {
              const valCode = _qdcInt16(dv, i + 1);
              if (valCode !== 0) {
                const valDepth = _qdcInt16(dv, i - 1);
                arrDepth[x_abs * y_size + y_abs] = valDepth;
              }
            }
            i += 4;
          }
        }
      }
    }
    processed++;
    if (onProgress) onProgress(processed, matched.length, 'decoding');
  }

  const x_orig_global = x_min * 90 / 2 ** 14;
  const y_orig_global = y_min * 90 / 2 ** 14;

  const pts = [];
  for (let ix = 0; ix < x_size; ix++) {
    for (let iy = 0; iy < y_size; iy++) {
      const raw = arrDepth[ix * y_size + iy];
      if (raw <= 0) continue;
      const lon = x_orig_global + params.a_step / 2 + ix * params.a_step;
      const lat = y_orig_global + params.a_step / 2 + iy * params.a_step;
      pts.push({ lat, lon, depth: (raw / 100) * 3.28084 }); // cm -> m -> ft
    }
  }
  if (onProgress) onProgress(matched.length, matched.length, 'done');
  return pts;
}

// ═══════════════════════════════════════════════════════════════════════
// Grid building (bin, smooth, fringe-fill)
// ═══════════════════════════════════════════════════════════════════════

export function buildDepthGrid(pts, n, doSmooth = true, doFringe = true) {
  if (!pts.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  pts.forEach((p) => {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
  });
  const dLat = (maxLat - minLat) / n, dLon = (maxLon - minLon) / n;
  if (dLat <= 0 || dLon <= 0) return null;

  const sum = Array.from({ length: n }, () => Array(n).fill(0));
  const cnt = Array.from({ length: n }, () => Array(n).fill(0));
  pts.forEach((p) => {
    const ix = Math.min(n - 1, Math.max(0, Math.floor((p.lon - minLon) / dLon)));
    const iy = Math.min(n - 1, Math.max(0, Math.floor((maxLat - p.lat) / dLat)));
    sum[iy][ix] += p.depth; cnt[iy][ix]++;
  });
  let grid = sum.map((row, y) => row.map((s, x) => (cnt[y][x] > 0 ? s / cnt[y][x] : NaN)));
  let has_data = cnt.map((row) => row.map((c) => c > 0));

  const MIN_PTS = 10;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (cnt[y][x] > 0 && cnt[y][x] < MIN_PTS) {
        grid[y][x] = NaN;
        has_data[y][x] = false;
      }
    }
  }

  if (doSmooth) {
    const smooth = Array.from({ length: n }, () => Array(n).fill(NaN));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!has_data[y][x]) continue;
        let vsum = 0, vcnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = y + dy, nx = x + dx;
            if (ny < 0 || ny >= n || nx < 0 || nx >= n) continue;
            if (has_data[ny][nx] && !isNaN(grid[ny][nx])) { vsum += grid[ny][nx]; vcnt++; }
          }
        }
        smooth[y][x] = vcnt ? vsum / vcnt : grid[y][x];
      }
    }
    grid = smooth;
  }

  if (doFringe) {
    const dilated = has_data.map((row) => row.slice());
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (has_data[y][x]) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const ny = y + dy, nx = x + dx;
              if (ny >= 0 && ny < n && nx >= 0 && nx < n) dilated[ny][nx] = true;
            }
          }
        }
      }
    }
    const filled = grid.map((row) => row.slice());
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (dilated[y][x] && !has_data[y][x]) {
          let best = NaN, bestd = 1e9;
          for (let ry = Math.max(0, y - 3); ry <= Math.min(n - 1, y + 3); ry++) {
            for (let rx = Math.max(0, x - 3); rx <= Math.min(n - 1, x + 3); rx++) {
              if (has_data[ry][rx] && !isNaN(grid[ry][rx])) {
                const d = (ry - y) ** 2 + (rx - x) ** 2;
                if (d < bestd) { bestd = d; best = grid[ry][rx]; }
              }
            }
          }
          if (!isNaN(best)) filled[y][x] = best;
        }
      }
    }
    grid = filled;
    has_data = dilated;
  }

  const BORDER = 2;
  for (let x = 0; x < n; x++) {
    for (let b = 0; b < BORDER; b++) {
      grid[b][x] = NaN; has_data[b][x] = false;
      grid[n - 1 - b][x] = NaN; has_data[n - 1 - b][x] = false;
    }
  }
  for (let y = 0; y < n; y++) {
    for (let b = 0; b < BORDER; b++) {
      grid[y][b] = NaN; has_data[y][b] = false;
      grid[y][n - 1 - b] = NaN; has_data[y][n - 1 - b] = false;
    }
  }

  const features = [];
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const v = grid[iy][ix];
      if (isNaN(v)) continue;
      const w = minLon + ix * dLon, e = w + dLon;
      const n2 = maxLat - iy * dLat, s = n2 - dLat;
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[w, n2], [e, n2], [e, s], [w, s], [w, n2]]] },
        properties: { depth: Math.round(v) },
      });
    }
  }
  return { type: 'FeatureCollection', features, meta: { minLat, maxLat, minLon, maxLon, n, grid, has_data } };
}

// ═══════════════════════════════════════════════════════════════════════
// Marching Squares contouring
// ═══════════════════════════════════════════════════════════════════════

function marchingSquares(grid, level) {
  const rows = grid.length, cols = grid[0].length;
  function interp(v0, v1, p0, p1) {
    const dv = v1 - v0;
    return Math.abs(dv) < 1e-10 ? (p0 + p1) / 2 : p0 + (level - v0) / dv * (p1 - p0);
  }
  const ET = {
    0: [], 15: [],
    1: [[3, 0]], 14: [[0, 3]],
    2: [[0, 1]], 13: [[1, 0]],
    3: [[3, 1]], 12: [[1, 3]],
    4: [[1, 2]], 11: [[2, 1]],
    5: [[3, 2], [1, 0]], 10: [[0, 3], [2, 1]],
    6: [[0, 2]], 9: [[2, 0]],
    7: [[3, 2]], 8: [[2, 3]],
  };
  const segments = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const vbl = grid[r][c], vbr = grid[r][c + 1], vtr = grid[r + 1][c + 1], vtl = grid[r + 1][c];
      if (isNaN(vbl) || isNaN(vbr) || isNaN(vtr) || isNaN(vtl)) continue;
      const cs = (vbl >= level ? 1 : 0) | (vbr >= level ? 2 : 0) | (vtr >= level ? 4 : 0) | (vtl >= level ? 8 : 0);
      if (cs === 0 || cs === 15) continue;
      const e0 = [interp(vbl, vbr, c, c + 1), r];
      const e1 = [c + 1, interp(vbr, vtr, r, r + 1)];
      const e2 = [interp(vtl, vtr, c, c + 1), r + 1];
      const e3 = [c, interp(vbl, vtl, r, r + 1)];
      const edges = [e0, e1, e2, e3];
      (ET[cs] || []).forEach(([ea, eb]) => segments.push([edges[ea], edges[eb]]));
    }
  }
  if (!segments.length) return [];

  function K(pt) { return Math.round(pt[0] * 1000) / 1000 + ',' + Math.round(pt[1] * 1000) / 1000; }
  const adj = {};
  segments.forEach((seg, i) => {
    const ka = K(seg[0]), kb = K(seg[1]);
    (adj[ka] = adj[ka] || []).push(i);
    (adj[kb] = adj[kb] || []).push(i);
  });
  const used = new Array(segments.length).fill(false);
  const polylines = [];
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    let a = segments[start][0], b = segments[start][1];
    const chain = [a, b];
    for (const forward of [true, false]) {
      while (true) {
        const tip = forward ? chain[chain.length - 1] : chain[0];
        const cand = (adj[K(tip)] || []).filter((i) => !used[i]);
        if (!cand.length) break;
        const i = cand[0]; used[i] = true;
        const na = segments[i][0], nb = segments[i][1];
        const pt = K(na) === K(tip) ? nb : na;
        if (forward) chain.push(pt); else chain.unshift(pt);
      }
    }
    if (chain.length >= 2) polylines.push(chain);
  }
  return polylines;
}

export function contourGrid(gridObj, interval, minD, maxD) {
  const { grid, minLon, maxLon, minLat, maxLat, n } = gridObj.meta;
  const g2 = grid.slice().reverse();
  let maxVal = -Infinity;
  g2.forEach((row) => row.forEach((v) => { if (!isNaN(v)) maxVal = Math.max(maxVal, v); }));
  const maxDepth = Math.min(maxD, isFinite(maxVal) ? maxVal : maxD);
  const features = [];
  for (let level = minD; level <= maxDepth + 1e-6; level += interval) {
    const chains = marchingSquares(g2, level);
    chains.forEach((chain) => {
      const coords = chain.map((pt) => {
        const [col, row] = pt;
        const lon = minLon + (col / (n - 1)) * (maxLon - minLon);
        const lat = minLat + (row / (n - 1)) * (maxLat - minLat);
        return [parseFloat(lon.toFixed(7)), parseFloat(lat.toFixed(7))];
      });
      if (coords.length >= 2) {
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: { depth: Math.round(level), depth_ft: Math.round(level), label: Math.round(level) + 'ft' },
        });
      }
    });
  }
  return { type: 'FeatureCollection', features };
}
