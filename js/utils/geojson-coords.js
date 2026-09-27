/**
 * Walking GeoJSON coordinates, and the bounding box that falls out of it.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS EXISTS
 *
 * Four places computed a shoreline's bounding box by flattening every coordinate into one
 * long array of numbers and then GUESSING whether that array was [x,y,x,y,…] or
 * [x,y,z,x,y,z,…]. Two lived in the Worker (research/limnology.js, research/vision.js) and
 * two in the front end (modules/lake-research-engine.js). They had already drifted:
 *
 *   Worker:     stride = (flat.length % 3 === 0 && flat.length % 2 !== 0) ? 3 : 2
 *   front end:  step   = (flat.length >= 3 && flat[2] === 0.0)
 *                     || (flat.length % 3 === 0 && flat.length % 2 !== 0) ? 3 : 2
 *
 * and the drift was a bug, not a style difference. The shared clause only detects 3D when the
 * number count is divisible by three and NOT by two — so a ring of, say, six 3D positions
 * (18 numbers: 18 % 3 === 0, but 18 % 2 === 0 too) failed the test and was read two numbers
 * at a time. That interleaves longitudes with latitudes and altitudes and produces a bounding
 * box made of coordinates that never existed. The front end had bolted on `flat[2] === 0.0`
 * to catch the common case, because 3DHP polygons are MultiPolygon Z with Z = 0; the Worker
 * never got that patch, so vision.js planned its scan tiles and limnology.js looked up its
 * thermocline data from a box that could be silently wrong for exactly the geometry this
 * project's own pipeline produces.
 *
 * The guess is not needed. GeoJSON nests positions — a position is the innermost array, and
 * ITS length is the stride, stated rather than inferred. Recursing to it is both simpler than
 * the heuristic and exactly correct for 2D and 3D alike, at every geometry type, which is why
 * this replaces all four copies instead of picking the better of the two.
 */

/**
 * Call `fn([lon, lat, ...rest])` for every position in any GeoJSON value.
 *
 * Accepts a FeatureCollection, a Feature, a GeometryCollection, a bare geometry, or a raw
 * coordinates array. Unknown shapes contribute nothing rather than throwing — a malformed
 * member of an otherwise good collection should not lose the whole file.
 *
 * @param {*} node
 * @param {(pos: number[]) => void} fn
 */
export function forEachPosition(node, fn) {
  if (!node) return;

  if (Array.isArray(node)) {
    // A position: the first element is a number, so this array IS [lon, lat] or [lon,lat,z].
    if (typeof node[0] === 'number') {
      if (node.length >= 2 && Number.isFinite(node[0]) && Number.isFinite(node[1])) fn(node);
      return;
    }
    for (const child of node) forEachPosition(child, fn);
    return;
  }

  if (typeof node !== 'object') return;

  if (node.type === 'FeatureCollection') {
    if (Array.isArray(node.features)) for (const f of node.features) forEachPosition(f, fn);
    return;
  }
  if (node.type === 'Feature') { forEachPosition(node.geometry, fn); return; }
  if (node.type === 'GeometryCollection') {
    if (Array.isArray(node.geometries)) for (const g of node.geometries) forEachPosition(g, fn);
    return;
  }
  if (node.coordinates) forEachPosition(node.coordinates, fn);
}

/**
 * Every position as [lon, lat], altitude dropped.
 *
 * @param {*} geojson
 * @returns {Array<[number, number]>}
 */
export function collectPositions(geojson) {
  const out = [];
  forEachPosition(geojson, (p) => out.push([p[0], p[1]]));
  return out;
}

/**
 * Bounding box of everything in `geojson`, or null when it holds no usable position.
 *
 * Null rather than a zero box on purpose: an empty result and a box at the origin are
 * different answers, and every caller of the code this replaced went on to divide by the
 * box's span.
 *
 * @param {*} geojson
 * @returns {{west:number, south:number, east:number, north:number}|null}
 */
export function boundsOf(geojson) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  let seen = 0;
  forEachPosition(geojson, (p) => {
    seen++;
    if (p[0] < west) west = p[0];
    if (p[0] > east) east = p[0];
    if (p[1] < south) south = p[1];
    if (p[1] > north) north = p[1];
  });
  return seen ? { west, south, east, north } : null;
}

/**
 * Is (lon, lat) inside `ring`, a closed [[lon, lat], ...] ring? Even-odd ray cast.
 *
 * THE ONE COPY, since 2026-09-25. Four modules each wrote this loop -- plan-water-index.js,
 * water-state-parts.js, river-drifts.js and Worker/research/on-water.js -- identical but for
 * argument order and one divide-by-zero guard the short-circuit already makes unreachable (a
 * horizontal edge fails `(yi > lat) !== (yj > lat)` before it divides).
 */
export function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/**
 * THE SAME RAY CAST FOR A RING ASKED MANY TIMES: index it once, then read only the edges that
 * can cross the ray.
 *
 * A horizontal ray is crossed only by an edge whose latitude span holds the point's latitude --
 * the first half of inRing()'s own test, `(yi > lat) !== (yj > lat)`. indexRing() files every
 * edge under each latitude row it spans; inIndexedRing() reads the one row its point is in and
 * applies inRing()'s test, unchanged, to those edges. The edges it skips are exactly the ones that
 * cannot pass that test, so THE ANSWER IS inRing()'S ANSWER, not an approximation of it. The
 * ring's own arrays are read, not copied; the index is one Int32Array of edge numbers.
 *
 * Why it exists: Pick Water hung the browser on Murray, 2026-09-26, inside inRing() under
 * depthSampler(). See plan-water-index.js.
 *
 * @param {Array<[number, number]>} ring
 * @returns {object} opaque; hand it to inIndexedRing()
 */
export function indexRing(ring) {
  const n = ring.length;
  let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = ring[i][0], y = ring[i][1];
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
  }
  // About two edges a row, so the rows scale with the ring and a tiny ring stays one row.
  const rows = Math.max(1, Math.ceil(n / 2));
  const h = (y1 - y0) / rows || 1;
  const row = (y) => Math.min(rows - 1, Math.max(0, Math.floor((y - y0) / h)));
  const start = new Int32Array(rows + 1);
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i][1], b = ring[j][1];
    const r1 = row(Math.max(a, b));
    for (let r = row(Math.min(a, b)); r <= r1; r++) start[r + 1]++;
  }
  for (let r = 0; r < rows; r++) start[r + 1] += start[r];
  const edges = new Int32Array(start[rows]);
  const fill = start.slice(0, rows);
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i][1], b = ring[j][1];
    const r1 = row(Math.max(a, b));
    for (let r = row(Math.min(a, b)); r <= r1; r++) edges[fill[r]++] = i;
  }
  return { ring, n, y0, y1, x0, x1, row, start, edges };
}

// A billionth of a degree, about 0.1 mm. inRing()'s crossing point can round a few units in the
// last place past the edge it lies on -- around 1e-13 of a degree out here -- so the box test
// below stands this far off the ring before it answers for it, and never answers differently.
const BOX_MARGIN_DEG = 1e-9;

/**
 * inRing() against a ring indexed by indexRing(). Same answer, a fraction of the edges read.
 *
 * @param {number} lon
 * @param {number} lat
 * @param {object} idx  from indexRing()
 * @returns {boolean}
 */
export function inIndexedRing(lon, lat, idx) {
  // Nothing spans a latitude outside the ring: no crossing, so not inside, as inRing() finds.
  if (!(lat >= idx.y0 && lat < idx.y1)) return false;
  // East of the ring, nothing crosses the ray. West of it, every edge that spans the latitude
  // crosses, and around a closed ring that is always an even number. Not inside either way, which
  // is inRing()'s answer; this only skips reading the edges to find that out.
  if (lon > idx.x1 + BOX_MARGIN_DEG || lon < idx.x0 - BOX_MARGIN_DEG) return false;
  const ring = idx.ring, r = idx.row(lat);
  let inside = false;
  for (let k = idx.start[r]; k < idx.start[r + 1]; k++) {
    const i = idx.edges[k], j = i === 0 ? idx.n - 1 : i - 1;
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/**
 * Could any edge of an indexed ring come within BOX_MARGIN_DEG of the box [w,s]-[e,n]?
 *
 * Conservative on purpose: it answers true for an edge whose own box touches the grown box, which
 * includes a few that pass by the corner without entering. False is the claim that matters, and
 * false is exact: then every point in the box is at least the margin from the ring, the ray cast
 * cannot round differently anywhere in it, and the whole box is inside or the whole box is out.
 */
export function ringNearBox(idx, w, s, e, n) {
  if (idx.y1 < s - BOX_MARGIN_DEG || idx.y0 > n + BOX_MARGIN_DEG
      || idx.x1 < w - BOX_MARGIN_DEG || idx.x0 > e + BOX_MARGIN_DEG) return false;
  const ring = idx.ring;
  const r1 = idx.row(n + BOX_MARGIN_DEG);
  for (let r = idx.row(s - BOX_MARGIN_DEG); r <= r1; r++) {
    for (let k = idx.start[r]; k < idx.start[r + 1]; k++) {
      const i = idx.edges[k], j = i === 0 ? idx.n - 1 : i - 1;
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (Math.min(xi, xj) <= e + BOX_MARGIN_DEG && Math.max(xi, xj) >= w - BOX_MARGIN_DEG
          && Math.min(yi, yj) <= n + BOX_MARGIN_DEG && Math.max(yi, yj) >= s - BOX_MARGIN_DEG) return true;
    }
  }
  return false;
}
