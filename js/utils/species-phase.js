/**
 * WHAT THE FISH ARE DOING AT THIS HOUR — a stated rule, not invented per-lake numbers.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHAT THIS REPLACES. `SPECIES_BEHAVIOR` in js/data/species-intel.js carries dawn/day/dusk
 * `depthShift` and `speed` figures for ONE species on TWO lakes. Ryan, 2026-08-16:
 *
 *   "those 2 got hand built numbers because you hand built them... they were hand built before
 *    we had the research pipeline... you were that agent that invented them in the first place"
 *
 * He is right, and it is the same failure as the Duke basin id and the Davy Crockett binding: a
 * number nobody measured, wearing the clothes of lake-specific knowledge. Two lakes had it and
 * 452 did not, and the two were not better off — they were confidently wrong.
 *
 * THE RULE, in his words: *"as a general rule topwater action is much more possible at dusk and
 * dawn due to feeding and that fish don't have eye lids... also more prevalent on overcast
 * days... speed is variable"*.
 *
 * Three things follow, and each is a deliberate design decision rather than a tuning knob:
 *
 *   1. LOW LIGHT IS THE VARIABLE, NOT THE CLOCK. Dawn and dusk matter because of light, so
 *      overcast counts too, and a heavy overcast midday is nearer to dawn than a bright one.
 *      One factor from 0 to 1 carries both, instead of a table keyed on the hour.
 *   2. NO SPEED IS EMITTED. Speed is variable, so a number here would be invention. `speed` is
 *      null and the caller keeps whatever it had.
 *   3. THE DEPTHS COME FROM THE RESEARCH PROFILE. `trollingIntelligence[species][season]` is
 *      extracted from documents with quotes attached; this shifts within that band and never
 *      outside it. A rule may move you inside measured water. It may not invent new water.
 */

/** Cloud cover from whatever the forecast actually gave us, as 0..1, or null if it said nothing. */
export function cloudFraction(weather) {
  if (weather == null) return null;
  if (typeof weather === 'number') {
    return Number.isFinite(weather) ? Math.max(0, Math.min(1, weather > 1 ? weather / 100 : weather)) : null;
  }
  const s = String(weather).toLowerCase();
  if (!s.trim()) return null;
  // NWS phrases, coarsest first. This is a lookup of what the feed says, not a model of the sky.
  if (/overcast|cloudy(?!.*partly)|rain|storm|shower|fog/.test(s)) return 0.9;
  if (/mostly cloudy/.test(s)) return 0.8;
  if (/partly (cloudy|sunny)|scattered/.test(s)) return 0.5;
  if (/mostly (sunny|clear)/.test(s)) return 0.2;
  if (/fair|sunny|clear/.test(s)) return 0.1;
  return null;
}

/**
 * How much like dawn this moment is, 0 (glare) to 1 (first light).
 *
 * Overcast lifts a midday phase but never all the way: an overcast noon is dimmer than a clear
 * noon and still brighter than first light, and saying otherwise would be the invention this
 * whole file exists to remove.
 */
export function lowLightFactor({ phaseNum, weather } = {}) {
  const base = phaseNum === 1 ? 1 : phaseNum === 2 ? 0.5 : 0.25;
  const cloud = cloudFraction(weather);
  if (cloud == null) return base;
  return Math.round(Math.min(1, base + cloud * (1 - base) * 0.6) * 100) / 100;
}

/**
 * A season node from the research profile, narrowed to this phase.
 *
 * `node` is `trollingIntelligence[species][season]` as the pipeline writes it:
 * `preferredDepth: [min,max]`, `structures`, `forage`, `recommendedPresentations`, `notes`.
 */
export function phaseWindow(node, { phaseNum = 2, weather = null } = {}) {
  if (!node || !Array.isArray(node.preferredDepth) || node.preferredDepth.length !== 2) return null;
  const [lo, hi] = node.preferredDepth.map(Number);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;

  const light = lowLightFactor({ phaseNum, weather });
  const spread = hi - lo;
  // Low light works the TOP of the measured band; bright light works the bottom. The window is
  // never wider than the band and never outside it — the profile measured that water, this did
  // not.
  const width = Math.max(1, Math.round(spread * 0.55));
  const top = Math.round(lo + spread * (1 - light) * 0.45);
  const depthMin = Math.max(lo, top);
  const depthMax = Math.min(hi, depthMin + width);

  return {
    depthMin,
    depthMax,
    // The one thing Ryan named outright. Fish have no eyelids, they feed in low light, and
    // topwater is worth carrying whenever the light is down — including an overcast midday.
    topwaterViable: light >= 0.6,
    lowLight: light,
    presentations: node.recommendedPresentations || [],
    structure: node.structures || [],
    forage: node.forage || [],
    holding: node.holding || null,
    notes: Array.isArray(node.notes) ? node.notes.join(' · ') : (node.notes || ''),
    // SPEED IS VARIABLE and so no speed is asserted. The old table published 1.8 and 2.0 as
    // though they had been measured on those lakes. They had not.
    speed: null,
    basis: 'research profile depth band, narrowed by light — not lake-specific behaviour data',
  };
}
