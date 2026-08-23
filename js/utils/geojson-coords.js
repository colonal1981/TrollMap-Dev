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
 * A [west, south, east, north] row, padded, as a box — or null if the row is not one.
 *
 * `lake_index.json` carries `bounds_wsen` on every registry row, which is the same box
 * `boundsOf` computes but already measured by the pipeline against the real boundary. A caller
 * that has a registry record does not need to fetch a geometry to find out where a lake is.
 *
 * Null rather than a partly-filled box: a row with three numbers in it, or a string where a
 * number should be, is a row nobody should be building a query out of. WQP answers a bad box
 * with someone else's lake rather than with an error.
 *
 * @param {*} wsen  [west, south, east, north]
 * @param {number} pad degrees added on every side
 * @returns {{west:number, south:number, east:number, north:number}|null}
 */
export function paddedBox(wsen, pad = 0) {
  if (!Array.isArray(wsen) || wsen.length !== 4) return null;
  const n = wsen.map(Number);
  if (!n.every(Number.isFinite)) return null;
  const [west, south, east, north] = n;
  if (west > east || south > north) return null;
  return { west: west - pad, south: south - pad, east: east + pad, north: north + pad };
}
