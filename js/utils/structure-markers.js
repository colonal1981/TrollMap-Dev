/**
 * structure-markers.js — humps and ledges, read from the pack the pipeline builds.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS EXISTS, and it is a correction.
 *
 * These coordinates used to be derived in the browser (`deriveContourStructures()`, capped at
 * 8 of each because grid-bucketing contours is guesswork and eight guesses was enough). The
 * Python pipeline builds them properly now and writes `structure.geojson` into every pack.
 * `eba1ed1` wired the real ones into the research PROFILE, and that is the part that was wrong:
 * the profile is a research document that gets saved to R2, re-read on every load, and pasted
 * into every LLM prompt. Thurmond ships 3,531 humps and 45,876 ledges; as profile fields that
 * was 549 KB of an 810 KB document, and most of a 402,757-character habitat prompt.
 *
 * THE ANSWER WAS NEVER A CAP. Ryan, 2026-08-16: *"how can i do all casting stops instead of
 * trolling lanes if i want to if you cap everything out arbitrarily"*. Exactly right — humps
 * are what SmartPlan turns into casting stops, so capping them caps the trip. The profile was
 * simply the wrong delivery path. `structure.geojson` is already in R2 beside contours and
 * depth areas, already served by /chartpacks/<slug>/<layer>.geojson, and until now nothing in
 * the client ever read it.
 *
 * So: EVERY hump and EVERY ledge, straight from the pack, and the research profile goes back to
 * carrying prose and counts — which is all a research document was ever for.
 */

// A property that is null, '' or all spaces is no reading. The local copy here was
// `Number.isFinite(Number(v))`, and Number(null) is 0, so a hump with no recorded depth came out
// 0 ft deep. build_structure.py writes a number or null into every field read below.
import { num } from './num.js';

function pointOf(feature) {
  const g = feature && feature.geometry;
  if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) return null;
  const [lon, lat] = g.coordinates;
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/**
 * Humps from a pack's structure.geojson, most relief first. UNCAPPED.
 *
 * Relief before area: a 6 ft rise is a place to stop, a 1 ft rise across 30 acres is the bottom
 * being slightly uneven. The order matters even without a cap, because SmartPlan takes
 * candidates off the front of the list.
 */
export function humpsFromPack(structGeo) {
  const feats = (structGeo && structGeo.features) || [];
  const out = [];
  for (const f of feats) {
    const p = (f && f.properties) || {};
    if (String(p.kind || '').toLowerCase() !== 'hump') continue;
    const pt = pointOf(f);
    if (!pt) continue;
    out.push({
      id: p.id, lat: pt.lat, lon: pt.lon,
      depth: num(p.depth_ft), areaAcres: num(p.area_acres),
      reliefFt: num(p.relief_ft), levels: num(p.levels), score: num(p.score),
    });
  }
  return out.sort((a, b) => ((b.reliefFt ?? 0) - (a.reliefFt ?? 0))
                         || ((b.areaAcres ?? 0) - (a.areaAcres ?? 0)));
}

/**
 * HOLES from the pack, deepest first.
 *
 * A nest of closed contours falls as often as it rises and only the rise had a name. Ryan, on
 * 34.49680,-80.88458: "this is a very deep hole in the river channel... it goes from very
 * shallow to very deep pretty quickly", and then "there are actually 2 ledge labels in that
 * section #1 and #8 and neither make it clear that the whole thing is a huge hole". Thirty-six
 * rings stack over that point, 18 ft at the rim to 54 ft at the bottom. build_structure.py
 * emits it as one `hole` now; this is the reader.
 *
 * `depth` is the BOTTOM -- where the pin is, the same rule the hump's crown follows -- and
 * `rimFt` is the lip it drops from.
 */
export function holesFromPack(structGeo) {
  const feats = (structGeo && structGeo.features) || [];
  const out = [];
  for (const f of feats) {
    const p = (f && f.properties) || {};
    if (String(p.kind || '').toLowerCase() !== 'hole') continue;
    const pt = pointOf(f);
    if (!pt) continue;
    out.push({
      id: p.id, lat: pt.lat, lon: pt.lon,
      depth: num(p.depth_ft), rimFt: num(p.rim_ft), areaAcres: num(p.area_acres),
      reliefFt: num(p.relief_ft), levels: num(p.levels), score: num(p.score),
    });
  }
  return out.sort((a, b) => ((b.reliefFt ?? 0) - (a.reliefFt ?? 0))
                         || ((b.areaAcres ?? 0) - (a.areaAcres ?? 0)));
}

/** Ledges from the pack, steepest first. UNCAPPED — slope is what separates a break worth
 *  stopping on from a contour that happens to be near another contour. */
export function ledgesFromPack(structGeo) {
  const feats = (structGeo && structGeo.features) || [];
  const out = [];
  for (const f of feats) {
    const p = (f && f.properties) || {};
    if (String(p.kind || '').toLowerCase() !== 'ledge') continue;
    const pt = pointOf(f);
    if (!pt) continue;
    out.push({
      id: p.id, lat: pt.lat, lon: pt.lon,
      // `depth` is the LIP -- where the pin is. `deepFt` is the first step down, `fallToFt`
      // the foot of the whole wall, and `fallFt` how far that is. `drop_ft` measured only the
      // first step, so a 6 ft ledge and a 28 ft wall reported the same number.
      depth: num(p.depth_ft), slopeFtPer100Ft: num(p.slope_ft_per_100ft),
      dropFt: num(p.drop_ft), deepFt: num(p.deep_ft),
      fallToFt: num(p.fall_to_ft), fallFt: num(p.fall_ft),
      runFt: num(p.run_ft), score: num(p.score),
    });
  }
  return out.sort((a, b) => (b.slopeFtPer100Ft ?? 0) - (a.slopeFtPer100Ft ?? 0));
}

/**
 * The structure a consumer should use: the pack's.
 *
 * IT HAD A PROFILE FALLBACK until 2026-09-25: the research profile's humpCoordinates and
 * ledgeCoordinates (under habitat's structural elements), for a pack with no structure layer.
 * Those are retired fields. Eight stored profiles carry them, exactly 8 of each -- the old browser
 * agent's cap, never measured -- and 0 of 373 shipped packs lack structure.geojson. Structure
 * comes from the pack. `source` stays so a caller, or a person reading a plan, can tell 'pack'
 * from 'none'.
 */
export function structureFor(packGeo) {
  const humps = humpsFromPack(packGeo);
  const ledges = ledgesFromPack(packGeo);
  const holes = holesFromPack(packGeo);
  return { humps, ledges, holes,
           source: (humps.length || ledges.length || holes.length) ? 'pack' : 'none',
           humpCount: humps.length, ledgeCount: ledges.length, holeCount: holes.length };
}
