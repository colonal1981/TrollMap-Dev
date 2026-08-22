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

  const sized = files.filter((f) => validSizes.includes(f.size));
  if (sized.length === 0) {
    throw new Error('No valid QDC files found for this layer (file sizes did not match).');
  }

  // ONE GRID PER TILE, NOT ONE ARRAY OVER THE WHOLE FOLDER.
  //
  // A .qdc file carries one tile, and the block it writes starts at that tile's own index.
  // The old code still allocated a single Int16Array spanning the bounding rectangle of every
  // tile in the folder and let each file fill its own corner of it. That rectangle is nearly
  // all air: Ryan's C folder holds 2,959 tiles inside a 311 x 344 rectangle, so 97% of it is
  // empty before a byte is read. At the default layer 1 the array asked for 1.75e9 cells --
  // 3.5 GB, past what a browser hands out in one ArrayBuffer -- and threw `Array buffer
  // allocation failed` at the allocation, before any depth was decoded. Layer 0 asks four
  // times that, 14 GB. A 400-file subfolder spans 44 x 31 tiles and wants 45 MB, which is why
  // only the whole-folder load ever failed. Measured 2026-08-22 over all 2,959 files.
  //
  // Working a tile at a time caps the grid at l_size2^2 cells no matter how many files arrive
  // -- 32 KB at layer 1, 128 KB at layer 0 -- and the header pass reads 168 bytes per file
  // instead of the whole file, so the folder is never resident either: 2,959 files held as
  // DataViews was a second gigabyte waiting to happen. It is also about five times faster,
  // because emitting points no longer means walking 1.75e9 mostly-empty cells.
  //
  // Layers 4 and 5 need the general form: there l_size is 4x l_size2, so a file's block covers
  // four tiles in each direction and neighbouring files genuinely overlap. `span` is that
  // ratio, a tile pulls in every file whose block reaches it, and the files are replayed in
  // folder order so a later file's blanks leave an earlier file's depths standing -- the same
  // rule the single array gave. Verified point-for-point against the old code on all six
  // layers: on the 21-file Bates set, which carries tiles held by both the C (community) and
  // U (own recordings) trees, and on a synthetic stand-in for all 2,959 files.
  const HDR = 168;                    // tile index lives at 160 (y) and 164 (x)
  const L2 = params.l_size2;          // cells along one tile edge
  const span = Math.max(1, Math.round(params.l_size / L2));
  const degPerTile = params.a_step * L2;

  const byTile = new Map();           // "x:y" -> [{ order, file }] in folder order
  for (let n = 0; n < sized.length; n++) {
    const file = sized[n];
    const head = new DataView(await file.slice(0, HDR).arrayBuffer());
    const key = `${_qdcInt16(head, 164)}:${_qdcInt16(head, 160)}`;
    let a = byTile.get(key); if (!a) byTile.set(key, a = []);
    a.push({ order: n, file });
  }
  if (byTile.size === 0) throw new Error('No valid QDC files found!');

  // Every tile any file can write into, not just the tiles files sit on (span > 1 only).
  const outTiles = new Set();
  for (const key of byTile.keys()) {
    const [tx, ty] = key.split(':').map(Number);
    for (let i = 0; i < span; i++) {
      for (let j = 0; j < span; j++) outTiles.add(`${tx + i}:${ty + j}`);
    }
  }

  const arrDepth = new Int16Array(L2 * L2);   // reused, one tile at a time
  const pts = [];
  let processed = 0;

  for (const key of outTiles) {
    const [ox, oy] = key.split(':').map(Number);

    const contributors = [];
    for (let i = 0; i < span; i++) {
      for (let j = 0; j < span; j++) {
        for (const c of byTile.get(`${ox - i}:${oy - j}`) || []) {
          contributors.push({ ...c, dx: -i * L2, dy: -j * L2 });
        }
      }
    }
    if (!contributors.length) continue;
    contributors.sort((a, b) => a.order - b.order);

    arrDepth.fill(0);
    for (const { file, dx, dy } of contributors) {
      const dv = new DataView(await file.arrayBuffer());

      let i;
      if (file.size === params.f_size1) i = params.f_offset1;
      else if (file.size === params.f_size2) i = params.f_offset2;
      else if (file.size === params.f_size3) i = params.f_offset3;
      else if (file.size === params.f_size4) i = params.f_offset4;

      for (let yy = 0; yy <= params.n_sectors; yy++) {
        for (let xx = 0; xx <= params.n_sectors; xx++) {
          for (let y = 0; y < 32; y++) {
            for (let x = 0; x < 32; x++) {
              const gx = xx * 32 + x + dx;
              const gy = yy * 32 + y + dy;
              if (gx >= 0 && gx < L2 && gy >= 0 && gy < L2
                  && i + 2 < dv.byteLength && i - 1 >= 0) {
                const valCode = _qdcInt16(dv, i + 1);
                if (valCode !== 0) arrDepth[gx * L2 + gy] = _qdcInt16(dv, i - 1);
              }
              i += 4;
            }
          }
        }
      }
      if (span === 1) {
        processed++;
        if (onProgress) onProgress(processed, sized.length, 'decoding');
      }
    }

    const lonOrig = ox * degPerTile;
    const latOrig = oy * degPerTile;
    for (let ix = 0; ix < L2; ix++) {
      for (let iy = 0; iy < L2; iy++) {
        const raw = arrDepth[ix * L2 + iy];
        if (raw <= 0) continue;
        pts.push({
          lat: latOrig + params.a_step / 2 + iy * params.a_step,
          lon: lonOrig + params.a_step / 2 + ix * params.a_step,
          depth: (raw / 100) * 3.28084,          // cm -> m -> ft
        });
      }
    }
  }

  if (onProgress) onProgress(sized.length, sized.length, 'done');
  return pts;
}

// ═══════════════════════════════════════════════════════════════════════
// Grid building (bin, smooth, fringe-fill)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Split points into separate bodies of water.
 *
 * WHY THIS EXISTS. buildDepthGrid() lays ONE grid over the bounding box of every point it is
 * given. A QuickDraw folder is not one lake -- Ryan's holds four, spread over 39 x 92 km. A
 * fixed 140 x 140 grid across that is 276 m x 660 m per cell, so 15,162 soundings recorded at
 * ~2.4 m spacing collapsed into SEVENTEEN occupied cells, and marching squares turned those into
 * two contour lines lying in a forest. Measured 2026-08-07 against ryan_personal.csv.
 *
 * Flood-fill on a coarse grid, 8-connected. `linkM` is how close two soundings must be to count
 * as the same water; a kilometre separates lakes without splitting a long river.
 */
export function clusterPoints(pts, linkM = 1000) {
  const cell = linkM / 111320;             // degrees, near enough at these latitudes
  const occ = new Map();
  for (let i = 0; i < pts.length; i++) {
    const k = `${Math.round(pts[i].lon / cell)}:${Math.round(pts[i].lat / cell)}`;
    let a = occ.get(k); if (!a) occ.set(k, a = []);
    a.push(i);
  }
  const seen = new Set(); const out = [];
  for (const k of occ.keys()) {
    if (seen.has(k)) continue;
    const stack = [k]; seen.add(k); const members = [];
    while (stack.length) {
      const c = stack.pop();
      for (const i of occ.get(c)) members.push(pts[i]);
      const [cx, cy] = c.split(':').map(Number);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const nb = `${cx + dx}:${cy + dy}`;
          if (occ.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
        }
      }
    }
    out.push(members);
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}

/**
 * Grid size for a target cell edge, rather than a fixed count.
 *
 * n = 140 was fixed regardless of extent, and the two failure modes hide each other:
 *
 *   one 39 x 92 km grid at n=140  ->  276 m cells, 17 occupied, 2 contour lines
 *   one  1 x 1.6 km grid at n=140 ->    7 m cells, 2,333 occupied, ZERO survive MIN_PTS
 *
 * Fix the clustering alone and you get nothing at all. Measured on the largest of Ryan's four
 * water bodies (8,686 points, 0.96 x 1.56 km), cells of ~15 m put n near 60-80, which keeps
 * 400-600 cells and 99% of the points.
 */
export function gridSizeFor(pts, targetCellM = 15, min = 24, max = 250) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon; if (p.lon > maxLon) maxLon = p.lon;
  }
  const midLat = (minLat + maxLat) / 2;
  const widthM = (maxLon - minLon) * 111320 * Math.cos((midLat * Math.PI) / 180);
  const heightM = (maxLat - minLat) * 110570;
  const span = Math.max(widthM, heightM);
  if (!isFinite(span) || span <= 0) return min;
  return Math.max(min, Math.min(max, Math.round(span / targetCellM)));
}

/**
 * Points -> contour FeatureCollection, one water body at a time.
 *
 * Replaces `buildDepthGrid(pts, 140) -> contourGrid(...)` at the call site. Returns the merged
 * features plus a per-cluster report, because the old importer's real sin was SILENCE: it threw
 * away 99.9% of the detail and said 'Done'.
 */
export function contoursFromPoints(pts, o = {}) {
  const interval = o.interval ?? 2, minD = o.minD ?? 4, maxD = o.maxD ?? 120;
  const clusters = clusterPoints(pts, o.linkM ?? 1000)
    .filter((c) => c.length >= (o.minClusterPts ?? 40));
  const features = []; const report = [];
  for (const c of clusters) {
    const n = gridSizeFor(c, o.targetCellM ?? 15);
    const g = buildDepthGrid(c, n, true, true, o.minPts ?? 3);
    if (!g) { report.push({ points: c.length, n, features: 0, note: 'grid build failed' }); continue; }
    const fc = contourGrid(g, interval, minD, maxD);
    features.push(...fc.features);
    report.push({ points: c.length, n, features: fc.features.length });
  }
  return { type: 'FeatureCollection', features, report,
           clusters: clusters.length, points: pts.length };
}
export function buildDepthGrid(pts, n, doSmooth = true, doFringe = true, minPts = 3) {
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

  // WAS A HARDCODED 10. At the ~15 m cells this decoder now uses, a cell holds a handful of
  // soundings and a threshold of 10 discards every one of them -- measured: 2,333 occupied cells,
  // zero survivors. 3 keeps 99% of the points while still rejecting single-ping noise.
  const MIN_PTS = minPts;
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

  // THE MASK THE CONTOURS GET CLIPPED TO, TAKEN BEFORE THE FRINGE WIDENS IT.
  //
  // doFringe dilates has_data by one cell and fills the ring from the nearest real value, which
  // is what lets marching squares CLOSE a contour at the edge of coverage instead of leaving it
  // hanging. That is a numerical device for the surface; it is not ground anyone drove over. Left
  // in the output it puts contour line up to 24.3 m past the last sounding -- 24.5% of vertices
  // on the Bates oxbow, measured 2026-08-22, against 4.8% and 7.1 m with the fringe off, which is
  // just cell rounding. On water 75 m wide that is a third of the width bleeding onto each bank,
  // and it is why TrollMap drew lines over dry land where ActiveCaptain did not.
  //
  // So: keep the fringe for the surface, hand the pre-dilation mask to contourGrid, and cut the
  // lines back to it. Costs nothing structurally -- 70 lines become 72 pieces.
  const has_real = has_data.map((row) => row.slice());

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
      grid[b][x] = NaN; has_data[b][x] = false; has_real[b][x] = false;
      grid[n - 1 - b][x] = NaN; has_data[n - 1 - b][x] = false; has_real[n - 1 - b][x] = false;
    }
  }
  for (let y = 0; y < n; y++) {
    for (let b = 0; b < BORDER; b++) {
      grid[y][b] = NaN; has_data[y][b] = false; has_real[y][b] = false;
      grid[y][n - 1 - b] = NaN; has_data[y][n - 1 - b] = false; has_real[y][n - 1 - b] = false;
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
  return { type: 'FeatureCollection', features, meta: { minLat, maxLat, minLon, maxLon, n, grid, has_data, has_real } };
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
  const { grid, minLon, maxLon, minLat, maxLat, n, has_real } = gridObj.meta;
  const g2 = grid.slice().reverse();
  // Same flip marching squares works in, so a chain point indexes straight into it.
  const r2 = has_real ? has_real.slice().reverse() : null;
  const onRealGround = (col, row) => {
    if (!r2) return true;
    const y = Math.round(row), x = Math.round(col);
    return y >= 0 && y < n && x >= 0 && x < n && r2[y][x];
  };
  let maxVal = -Infinity;
  g2.forEach((row) => row.forEach((v) => { if (!isNaN(v)) maxVal = Math.max(maxVal, v); }));
  const maxDepth = Math.min(maxD, isFinite(maxVal) ? maxVal : maxD);
  const features = [];
  for (let level = minD; level <= maxDepth + 1e-6; level += interval) {
    const chains = marchingSquares(g2, level);
    chains.forEach((chain) => {
      // CUT THE CHAIN WHERE IT LEAVES THE SOUNDED GROUND, rather than drawing the whole of it.
      // A contour past the last sounding is the fringe-fill's invention, not a depth anyone
      // measured, and on a narrow water it lands on the bank. See buildDepthGrid.
      let run = [];
      const flush = () => {
        if (run.length >= 2) {
          features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: run },
            properties: { depth: Math.round(level), depth_ft: Math.round(level), label: Math.round(level) + 'ft' },
          });
        }
        run = [];
      };
      for (const pt of chain) {
        const [col, row] = pt;
        if (!onRealGround(col, row)) { flush(); continue; }
        const lon = minLon + (col / (n - 1)) * (maxLon - minLon);
        const lat = minLat + (row / (n - 1)) * (maxLat - minLat);
        run.push([parseFloat(lon.toFixed(7)), parseFloat(lat.toFixed(7))]);
      }
      flush();
    });
  }
  return { type: 'FeatureCollection', features };
}
