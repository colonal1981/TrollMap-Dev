/**
 * plan-inputs.js — the parts of "what am I planning" that are not the DOM.
 *
 * Split out of `smart-plan-v2-wiring.js` because that file's own opening line says everything
 * that knows about `document` lives there and everything below it is pure — and then these two
 * were sitting in it. They are pure, they carry the awkward domain facts, and they are the two
 * things most worth testing, so they go where a test can reach them: the wiring module cannot be
 * imported outside a browser at all, since its import graph reaches `window`.
 */

import { SPECIES_BEHAVIOR_V2, resolveLakeKey } from '../data/species-intel.js';

/**
 * THE WHOLE DAY'S DEPTH BAND, not a phase's.
 *
 * v1 split the day into three phases and narrowed the band for each, because it built four fixed
 * out-and-back routes and had to decide up front which depth each one ran. v2 has no phases: the
 * model is handed every reachable leg in the species' range and decides itself what to fish when.
 * So this is `preferredDepth` straight out of SPECIES_BEHAVIOR_V2, unnarrowed.
 *
 * `preferredDepth` is sometimes a function of water temperature. `planWaterTemp` is often blank,
 * so the null case has to work: fall back to the static range if calling it throws or returns
 * nonsense, rather than filtering the whole lake out on a bad number.
 */
export function depthBandFor(species, lakeName, season, waterTempF) {
  const sp = SPECIES_BEHAVIOR_V2?.[species];
  if (!sp) return null;

  // getSeason() returns 'summer', and every caller that hand-wrote 'Summer' got silently no
  // plan. Normalise here rather than trusting six call sites to agree.
  const s = String(season || '').toLowerCase();

  const read = (node) => {
    const pref = node && node.preferredDepth;
    if (!pref) return null;
    let band = pref;
    // preferredDepth is a function of water temperature on some lakes, and planWaterTemp is
    // often blank. A throw or a nonsense answer must fall through, not filter out the lake.
    if (typeof pref === 'function') { try { band = pref(waterTempF); } catch { return null; } }
    if (!Array.isArray(band) || band.length !== 2) return null;
    const [a, b] = band.map(Number);
    return Number.isFinite(a) && Number.isFinite(b) && b > a ? [a, b] : null;
  };

  const key = resolveLakeKey(lakeName, sp);
  const own = key && sp[key] ? read(sp[key][s]) : null;
  if (own) return { band: own, basis: key, generic: false };

  // ---------------------------------------------------------------------------------------
  // THE TABLE COVERS FOUR LAKES. THE APP SHIPS FIFTEEN HUNDRED PACKS.
  //
  // SPECIES_BEHAVIOR_V2 holds Wateree, Murray, Marion and Moultrie; v1 holds two. Every other
  // water has no profile for any species, and there is no `default_SC_reservoir` key despite
  // three places reaching for one. v1 hid this: getPhaseRecommendation() returns null and the
  // caller falls into a hardcoded 12-18 / 22-28 ft in its own catch block, so a Hartwell plan
  // has always been built on two numbers nobody chose for Hartwell.
  //
  // Refusing to plan would be honest and would also block the ship rule -- "if it has
  // bathymetry ship it". So instead: take what this species does in this season on the lakes
  // the table DOES cover, and widen to their union. That is derived from real data about the
  // fish rather than a number I made up, and wide is the safe direction for a FILTER -- the
  // model still chooses within it, and a band that is too narrow silently removes the lake.
  //
  // `generic: true` rides along so the UI can say so and the model can be told. Do not let it
  // get dropped on the way through; a generic band presented as a lake-specific one is exactly
  // the sort of quiet fiction this rebuild exists to remove.
  // ---------------------------------------------------------------------------------------
  const across = Object.keys(sp).map((k) => read(sp[k] && sp[k][s])).filter(Boolean);
  if (!across.length) return null;
  return {
    band: [Math.min(...across.map((x) => x[0])), Math.max(...across.map((x) => x[1]))],
    basis: `${s} across the ${across.length} lakes profiled for this species — `
         + `${lakeName} is not one of them`,
    generic: true,
  };
}

/** The 20% LiFePO4 reserve is not optional, so it comes off here and never reaches the model. */
export function usableAhFrom(motorField) {
  const m = String(motorField || '').match(/(\d+)\s*ah/i);
  return (m ? parseInt(m[1], 10) : 100) * 0.8;
}
