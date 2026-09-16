import io, sys, os
repo = sys.argv[1]

p = os.path.join(repo, 'js/modules/plan-candidates.js')
s = io.open(p, encoding='utf-8').read()

old = """export function attractorSpotFeatures(dnrRows, poiSpots = [], dedupeM = 30) {
  const charted = [];
  for (const f of (poiSpots || [])) {
    if ((f.properties || {}).kind === 'attractor' && f.geometry) charted.push(f.geometry.coordinates);
  }
  const out = [];
  for (const r of (dnrRows || [])) {
    const lon = Number(r && r.lon), lat = Number(r && r.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    let dup = false;
    for (const c of charted) {
      if (metresBetween([lon, lat], c) <= dedupeM) { dup = true; break; }
    }
    if (dup) continue;"""

new = """/**
 * An occupancy grid of everywhere this pack has charted something.
 *
 * THE PACK IS THE LAKE. Both callers hold the water's own contours, runs and features and neither
 * holds the registry, so the honest test for "is this point on this water" is not a name and not
 * a bounding box -- a box around Wateree, which runs north-west to south-east, contains a good
 * deal of Fishing Creek Reservoir. It is whether the point sits near something this pack charted.
 *
 * Cells of `cellM`; a point counts as on-water if its own cell or any of the eight touching it
 * holds a charted coordinate. That makes the real tolerance one to two cells, which is what the
 * default is chosen for. O(n) either side, which matters at 5,263 attractor rows.
 */
export function chartedGrid(featureArrays, cellM = 250) {
  const cells = new Set();
  let lat0 = null;
  const add = (c) => {
    if (lat0 == null) lat0 = c[1];
    const dLat = cellM / 111320;
    const dLon = cellM / (111320 * Math.max(0.2, Math.cos(lat0 * Math.PI / 180)));
    cells.add(`${Math.floor(c[0] / dLon)},${Math.floor(c[1] / dLat)}`);
  };
  const walk = (c) => {
    if (!Array.isArray(c) || !c.length) return;
    if (Number.isFinite(c[0]) && Number.isFinite(c[1])) { add(c); return; }
    for (const x of c) walk(x);
  };
  for (const arr of (featureArrays || [])) {
    for (const f of (arr || [])) walk(f && f.geometry && f.geometry.coordinates);
  }
  if (!cells.size) return null;              // nothing charted: cannot judge, so do not
  const dLat = cellM / 111320;
  const dLon = cellM / (111320 * Math.max(0.2, Math.cos((lat0 || 34) * Math.PI / 180)));
  return (lon, lat) => {
    const cx = Math.floor(lon / dLon), cy = Math.floor(lat / dLat);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) if (cells.has(`${cx + a},${cy + b}`)) return true;
    }
    return false;
  };
}

/**
 * The state feed -> attractor features ON THIS WATER, deduped against Garmin's own.
 *
 * WHY I WOULD NOT FISH FISHING CREEK FROM A KAYAK ON WATEREE. Ryan, 2026-08-30: "why would i fish
 * the fish attractor at fishing creek, lancaster reservoir or lake monticello when i am lake
 * wateree? i dont think my kayak will make it there and i am damn sure i can't cast that far".
 *
 * There was no spatial filter here at all. The Worker returns every attractor it has -- 5,263
 * rows across South Carolina, North Carolina, Georgia and Tennessee -- and every one of them
 * became a cast spot on whatever lake was open. Pick Water listed 5,258 of them. Smart Plan was
 * scoring days against the same set.
 *
 * `onWater` is the grid above, built from the pack the caller already loaded. Passing it is not
 * optional in practice: without it this cannot tell one lake from another, so its absence is said
 * out loud rather than quietly reverting to four states of brushpiles.
 */
export function attractorSpotFeatures(dnrRows, poiSpots = [], opts = {}) {
  const { dedupeM = 30, onWater = null, where = 'attractors' } = (
    typeof opts === 'number' ? { dedupeM: opts } : opts);
  if (!onWater) {
    console.warn(`[candidates] ${where}: no charted grid given, so every state's attractors are `
      + `in play. This is what listed 5,258 of them on one lake.`);
  }
  const charted = [];
  for (const f of (poiSpots || [])) {
    if ((f.properties || {}).kind === 'attractor' && f.geometry) charted.push(f.geometry.coordinates);
  }
  const out = [];
  let offWater = 0;
  for (const r of (dnrRows || [])) {
    const lon = Number(r && r.lon), lat = Number(r && r.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (onWater && !onWater(lon, lat)) { offWater += 1; continue; }
    let dup = false;
    for (const c of charted) {
      if (metresBetween([lon, lat], c) <= dedupeM) { dup = true; break; }
    }
    if (dup) continue;"""
assert s.count(old) == 1, 'attractorSpotFeatures head'
s = s.replace(old, new)

old = """                             source: r.source || 'state DNR', waterbody: r.waterbody || null } });
  }
  return out;
}"""
new = """                             source: r.source || 'state DNR', waterbody: r.waterbody || null } });
  }
  if (offWater) {
    console.log(`[candidates] ${where}: ${out.length} on this water, ${offWater} elsewhere and `
      + `not listed`);
  }
  return out;
}"""
assert s.count(old) == 1, 'attractorSpotFeatures tail'
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('plan-candidates.js: chartedGrid(), and attractors are filtered to this water')

# ── Pick Water ──
p = os.path.join(repo, 'js/modules/plan-water-ui.js')
s = io.open(p, encoding='utf-8').read()
old = """import { poiSpotFeatures, attractorSpotFeatures, dockSpotFeatures } from './plan-candidates.js';"""
new = """import { poiSpotFeatures, attractorSpotFeatures, dockSpotFeatures, chartedGrid }
  from './plan-candidates.js';"""
assert s.count(old) == 1, 'pw import'
s = s.replace(old, new)
old = """  const dnrSpots = attractorSpotFeatures(dnrRows, poiSpotFeatures(poFc))"""
new = """  // Everywhere this pack has charted anything -- the runs, the depth areas, the shoreline, the
  // features, the structure. An attractor outside all of it is on another lake.
  const onWater = chartedGrid([lanes, (daFc && daFc.features) || [], (slFc && slFc.features) || [],
                               (wfFc && wfFc.features) || [], (stFc && stFc.features) || []]);
  const dnrSpots = attractorSpotFeatures(dnrRows, poiSpotFeatures(poFc),
                                         { onWater, where: `pick-water ${r2Key}` })"""
assert s.count(old) == 1, 'pw attractor call'
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('plan-water-ui.js: attractors filtered to the pack')

# ── Smart Plan ──
p = os.path.join(repo, 'js/modules/smart-plan-v2.js')
s = io.open(p, encoding='utf-8').read()
old = """import { selectCandidates, structureIndex, forModel, orientLegs, poiSpotFeatures, attractorSpotFeatures } from './plan-candidates.js';"""
new = """import { selectCandidates, structureIndex, forModel, orientLegs, poiSpotFeatures,
         attractorSpotFeatures, chartedGrid } from './plan-candidates.js';"""
assert s.count(old) == 1, 'sp import'
s = s.replace(old, new)
old = """  const attractors = structureIndex(attractorSpotFeatures(o.dnrAttractors, poiSpots));"""
new = """  // SAME FILTER, SAME REASON. Smart Plan was scoring days against every attractor in four
  // states; a brushpile on Lake Monticello has no business weighting a leg on Wateree.
  const onWater = chartedGrid([runs, (structFc && structFc.features) || [],
                               (waterFc && waterFc.features) || [],
                               (docksFc && docksFc.features) || []]);
  const attractors = structureIndex(attractorSpotFeatures(o.dnrAttractors, poiSpots,
                                    { onWater, where: `smart-plan ${o.r2Key}` }));"""
assert s.count(old) == 1, 'sp attractor call'
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('smart-plan-v2.js: attractors filtered to the pack')
