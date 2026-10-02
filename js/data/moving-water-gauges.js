/**
 * moving-water-gauges.js -- which gauges show each lake's water moving, as the pipeline derived it.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Built for every lake by Scripts/build_moving_water.py from water_bindings.json and
 * water_chain.json, and published at _registry/moving_water_gauges.json by upload_garmin_to_r2.py.
 * Nothing here names a lake (item 46; Ryan, 2026-10-02: "remember my rule no lake gets something
 * that isn't available to all"). A water the file has nothing for gets nothing, and a file that
 * could not be read is silence, never an empty answer -- see registry-loader.js.
 */

import { registryLoader } from './registry-loader.js';

export const MOVING_WATER_PATH = '/chartpacks/_registry/moving_water_gauges.json';

const LOADER = registryLoader(MOVING_WATER_PATH,
  (b) => b && b.waters && typeof b.waters === 'object' && !Array.isArray(b.waters) && b.waters);

/** This lake's gauges, or [] when the file has none for it, or null when it could not be read. */
export async function movingWaterGaugesFor(slug, { worker, fetch: impl } = {}) {
  const body = await LOADER.prime({ worker, fetch: impl });
  if (!body) return null;
  const rows = body.waters[slug];
  return Array.isArray(rows) ? rows : [];
}

/** For tests: forget what was read. */
export function resetMovingWaterGauges() { LOADER.reset(); }
