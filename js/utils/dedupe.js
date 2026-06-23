/**
 * Spatial + text deduplication for boat-ramp launches.
 *
 * The SCDNR-style launch database often contains near-duplicates (e.g. the
 * same physical ramp listed under slightly different names, or two ramps
 * at the exact same coordinates). This helper collapses those before
 * showing them to the user.
 *
 * Rules:
 *   1. Two ramps within 0.006° (~2000 ft) of each other are duplicates
 *      regardless of name.
 *   2. Two ramps with the same normalized name (after stripping "ramp",
 *      "launch", "park", etc.) AND within 0.02° (~1.3 mi) of each other
 *      are considered duplicates.
 *
 * @param {Object<string, [number, number]>} launches — {name: [lat, lon]}
 * @returns {Object<string, [number, number]>} deduped launches
 */
export function dedupeLaunchesList(launches) {
  const unique = {};
  const STRIP = /ramp|launch|landing|boatingaccess|marina|park|facility|area/g;

  for (const [rName, coords] of Object.entries(launches || {})) {
    if (!rName || !coords || isNaN(coords[0])) continue;

    const cleanName = rName.toLowerCase().replace(/[^a-z0-9]/g, '').replace(STRIP, '');
    let isDupe = false;

    for (const [uName, uCoords] of Object.entries(unique)) {
      const uClean = uName.toLowerCase().replace(/[^a-z0-9]/g, '').replace(STRIP, '');
      const dist = Math.hypot(coords[0] - uCoords[0], coords[1] - uCoords[1]);

      if (dist < 0.006) {
        isDupe = true;
        break;
      }

      if (
        cleanName && cleanName.length >= 4 &&
        (cleanName.includes(uClean) || uClean.includes(cleanName)) &&
        dist < 0.02
      ) {
        isDupe = true;
        break;
      }
    }

    if (!isDupe) unique[rName] = coords;
  }
  return unique;
}
