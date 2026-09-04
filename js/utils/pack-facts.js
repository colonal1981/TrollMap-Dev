/**
 * pack-facts.js -- every fact a chartpack can answer on its own, from GeoJSON the caller holds.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY IT IS NOT IN THE RESEARCH ENGINE ANY MORE. Ryan, 2026-09-04: "contours can change each time
 * Garmin updates them so anything derived from the packs should be ran when a plan is ran".
 * THE_PROFILE_BECAME_A_CACHE_AND_NOBODY_MOVED_THE_READS_2026-09-01.md says the same in its "What
 * moves, concretely" list: lift the pack derivations into the plan path, because both planners
 * already hold these objects on every run. A derivation stored in a profile is a photograph of a
 * chart that has since been replaced.
 *
 * It could not move while it lived in lake-research-engine.js, because importing that module
 * drags custom-vectors.js and half the research UI with it -- it throws on `window` the moment
 * node loads it, which is the same coupling in a different coat. Everything here is pure: give it
 * the layers, get back the block. Two utils in, nothing else.
 *
 * ONE IMPLEMENTATION, TWO CALLERS. deriveGeospatialStructureFacts() in the engine is the fetching
 * half and calls packDerivedFacts(); the planners call it on what they already downloaded. A plan
 * and a research run cannot disagree about what one pack says.
 */
import { buildEvidenceEntry } from './wqp-limnology.js';
import { geoDistanceFt } from './geo.js';

function getBoundaryOuterRing(boundaryGeo) {
  const features = boundaryGeo?.features || [];
  // Select largest polygon by coordinate count (proxy for area) — same logic as supplemental-layers client
  let best = null, bestSize = 0;
  for (const f of features) {
    const g = f?.geometry;
    if (!g) continue;
    let ring = null;
    if (g.type === 'Polygon' && Array.isArray(g.coordinates?.[0])) ring = g.coordinates[0];
    else if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates?.[0]?.[0])) ring = g.coordinates[0][0];
    if (ring && ring.length > bestSize) { best = ring; bestSize = ring.length; }
  }
  return best;
}

function toFeetXY(lon, lat, refLat) {
  const x = lon * 364000 * Math.cos((refLat || lat) * Math.PI / 180);
  const y = lat * 364000;
  return [x, y];
}

function polygonAreaAcresLonLat(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  const refLat = ring.reduce((a, p) => a + (p[1] || 0), 0) / ring.length;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = toFeetXY(ring[i][0], ring[i][1], refLat);
    const [x2, y2] = toFeetXY(ring[i + 1][0], ring[i + 1][1], refLat);
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2) / 43560;
}

function centroidLonLat(ring) {
  if (!Array.isArray(ring) || !ring.length) return [0, 0];
  let lon = 0, lat = 0;
  for (const p of ring) { lon += p[0]; lat += p[1]; }
  return [lon / ring.length, lat / ring.length];
}

function pointInPolygonLonLat(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// geoDistanceFt now from utils/geo.js (canonical)

function summarizePointComplexityFromBoundary(ring) {
  if (!Array.isArray(ring) || ring.length < 40) return {};
  const step = Math.max(1, Math.floor(ring.length / 120));
  const sampled = ring.filter((_, idx) => idx % step === 0);
  const [clon, clat] = centroidLonLat(sampled);
  const radii = sampled.map(([lon, lat]) => geoDistanceFt(clat, clon, lat, lon));
  if (radii.length < 10) return {};
  const smooth = radii.map((_, i) => {
    const prev = radii[(i - 1 + radii.length) % radii.length];
    const cur = radii[i];
    const next = radii[(i + 1) % radii.length];
    return (prev + cur + next) / 3;
  });
  const avg = smooth.reduce((a, b) => a + b, 0) / smooth.length;
  let maxima = 0, minima = 0;
  for (let i = 1; i < smooth.length - 1; i++) {
    if (smooth[i] > smooth[i - 1] && smooth[i] > smooth[i + 1] && smooth[i] > avg * 1.06) maxima++;
    if (smooth[i] < smooth[i - 1] && smooth[i] < smooth[i + 1] && smooth[i] < avg * 0.94) minima++;
  }
  const out = {};
  if (maxima >= 7) out.points = 'numerous shoreline points visible in boundary geometry';
  else if (maxima >= 4) out.points = 'several prominent shoreline points visible in boundary geometry';
  else if (maxima >= 2) out.points = 'a few major shoreline points visible in boundary geometry';
  if (minima >= 6) out.creekArms = 'multiple creek arms / embayments visible in boundary geometry';
  else if (minima >= 3) out.creekArms = 'several creek arms / embayments visible in boundary geometry';
  return out;
}

function isClosedContour(coords) {
  if (!Array.isArray(coords) || coords.length < 4) return false;
  const first = coords[0], last = coords[coords.length - 1];
  return geoDistanceFt(first[1], first[0], last[1], last[0]) < 150;
}

function flattenLineCoords(geom) {
  if (!geom) return [];
  if (geom.type === 'LineString') return [geom.coordinates || []];
  if (geom.type === 'MultiLineString') return geom.coordinates || [];
  return [];
}

/**
 * Minimum distance in degrees from a point to any segment of a ring.
 * Used to reject hump/ledge candidates that sit on or near the shoreline
 * (islands, shoreline points) rather than in open water.
 */
function minDistToRingDeg(lon, lat, ring) {
  let minD = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((lon - x1) * dx + (lat - y1) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const px = x1 + t * dx, py = y1 + t * dy;
    const d = Math.sqrt((lon - px) ** 2 + (lat - py) ** 2);
    if (d < minD) minD = d;
  }
  return minD;
}

// ~0.003° ≈ 300m — humps/ledges must be at least this far from the shoreline
const MIN_OFFSHORE_DEG = 0.003;

// Caps live in js/utils/structure-markers.js so they can be tested without a DOM.
// See that file for the byte counts that made a cap necessary.

function structuresFromPack(structGeo) {
  // READS structure.geojson. It used to be deriveContourStructures(), which grid-bucketed
  // contour centroids in the browser and kept eight humps and eight ledges per lake, per
  // research run. build_structure.py derives the same things offline from contour NESTING --
  // which is what actually makes a hump a hump -- and Wateree's file holds 395 humps and 6,915
  // ledges with relief, area and crown depth on every one.
  //
  // build_structure.py prints the comparison itself: "the old adapter would have kept 8 and 8
  // per lake, in the browser, per research run."
  const out = {};
  const feats = structGeo?.features;
  if (!feats?.length) return out;

  const humps = [], ledges = [];
  for (const f of feats) {
    const p = f.properties || {};
    // build_structure.py emits Points, so the coordinate IS the structure -- carry it.
    const c = f.geometry?.coordinates;
    const rec = Array.isArray(c) && c.length >= 2
      ? { ...p, lon: Number(c[0]), lat: Number(c[1]) }
      : { ...p };
    if (p.kind === 'hump') humps.push(rec);
    else if (p.kind === 'ledge') ledges.push(rec);
  }

  if (humps.length) {
    // Ranked by RELIEF, not by count. A hump is worth reporting because it stands proud of the
    // bottom around it; how many there are says nothing about which one matters.
    const top = humps.filter(h => Number.isFinite(Number(h.relief_ft)))
                     .sort((a, b) => Number(b.relief_ft) - Number(a.relief_ft))
                     .slice(0, 8);
    const desc = top.map(h => {
      const bits = [`${Math.round(Number(h.relief_ft))} ft relief`];
      if (Number.isFinite(Number(h.depth_ft))) bits.push(`crown ${Number(h.depth_ft).toFixed(1)} ft`);
      if (Number.isFinite(Number(h.area_acres))) bits.push(`${Number(h.area_acres).toFixed(1)} ac`);
      return bits.join(', ');
    });
    out.humps = `${humps.length} charted humps; largest by relief — ${desc.join('; ')}`;
  }

  if (ledges.length) {
    // LEDGES DO NOT DISCRIMINATE. Wateree has 6,915, so every stretch of water passes 90-140 of
    // them and a list of "the best ledges" is noise dressed as a finding. Report the shape of
    // the distribution and let the season and species decide which band matters.
    const ft = ledges.map(l => Number(l.depth_ft)).filter(Number.isFinite).sort((a, b) => a - b);
    const rel = ledges.map(l => Number(l.relief_ft)).filter(Number.isFinite).sort((a, b) => a - b);
    const q = (arr, f) => arr.length ? arr[Math.floor((arr.length - 1) * f)] : null;
    const parts = [`${ledges.length} charted ledges`];
    if (ft.length) parts.push(`depths ${ft[0].toFixed(1)}–${ft[ft.length - 1].toFixed(1)} ft, median ${q(ft, 0.5).toFixed(1)} ft`);
    if (rel.length) parts.push(`relief median ${q(rel, 0.5).toFixed(1)} ft, steepest ${rel[rel.length - 1].toFixed(1)} ft`);
    out.ledges = parts.join('; ');
  }

  // ---------------------------------------------------------------------
  // COUNTS AND PROSE. THE COORDINATES DO NOT LIVE HERE ANY MORE.
  //
  // They did between eba1ed1 (2026-08-07) and today, and it was the wrong home. A research
  // profile is a document: saved to R2, re-read on every load, pasted into every LLM prompt.
  // Thurmond ships 3,531 humps and 45,876 ledges, which came to 549 KB of an 810 KB profile
  // and most of a 402,757-character habitat prompt.
  //
  // Capping them was the obvious fix and the wrong one. Ryan, 2026-08-16: "how can i do all
  // casting stops instead of trolling lanes if i want to if you cap everything out
  // arbitrarily". Humps ARE the casting stops -- capping them caps the trip.
  //
  // structure.geojson has been in every pack since the Python pipeline started building it and
  // nothing in the client read it. It does now: supplemental-layers.js prefetches the layer and
  // smart-plan.js takes candidates from it, uncapped, through js/utils/structure-markers.js.
  // What the profile keeps is what a research document is for -- how many, and what that means.
  // Defined here rather than inherited: the previous version of this block declared `placed`
  // alongside the coordinate mapping, and removing the coordinates took the helper with it.
  // node --check cannot see a ReferenceError, and this function cannot be imported under
  // node --test (Leaflet), so the whole geospatial adapter failed at runtime with
  // "placed is not defined" and every habitat and species fact went with it.
  const isPlaced = (r) => Number.isFinite(r.lat) && Number.isFinite(r.lon);
  const placedHumps = humps.filter(isPlaced);
  const placedLedges = ledges.filter(isPlaced);
  if (placedHumps.length) out.humpCount = placedHumps.length;
  if (placedLedges.length) out.ledgeCount = placedLedges.length;
  out.structureSource = 'chartpack structure.geojson (coordinates served from the pack, not this profile)';

  return out;
}

function waterFeaturesFromPack(featGeo) {
  // READS water_features.geojson -- points, coves and named creek mouths, which research has
  // never seen at all. Counting Wateree's own trollingIntelligence, humps and ledges are 7 of
  // 104 structure citations; points, coves and creek mouths are most of the rest.
  const out = {};
  const feats = featGeo?.features;
  if (!feats?.length) return out;

  const byKind = {};
  for (const f of feats) {
    const k = f.properties?.kind;
    if (!k) continue;
    (byKind[k] = byKind[k] || []).push(f);
  }

  if (byKind.point?.length) {
    const rel = byKind.point.map(f => Number(f.properties?.deep_side_ft)).filter(Number.isFinite);
    out.points = `${byKind.point.length} charted points`
      + (rel.length ? `; deep side runs to ${Math.max(...rel).toFixed(1)} ft` : '');
  }
  if (byKind.cove?.length) out.coves = `${byKind.cove.length} charted coves`;
  if (byKind.creek_mouth?.length) {
    // Named ones only -- an unnamed creek mouth is a shape, a named one is a place you can be
    // told to go.
    const named = byKind.creek_mouth.map(f => f.properties?.name).filter(Boolean);
    out.creekMouths = named.length
      ? `${byKind.creek_mouth.length} creek mouths including ${named.slice(0, 6).join(', ')}`
      : `${byKind.creek_mouth.length} charted creek mouths`;
  }
  return out;
}


function deriveDepthAreaStructures(depthGeo) {
  const result = {};
  if (!depthGeo?.features?.length) return result;
  let largeShallow = 0;
  for (const f of depthGeo.features) {
    const p = f.properties || {};
    const max = Number(p.depth_max_ft ?? p.depth_min_ft ?? NaN);
    if (!isFinite(max) || max > 10) continue;
    const g = f.geometry;
    if (!g) continue;
    const rings = g.type === 'Polygon' ? [g.coordinates?.[0]] : g.type === 'MultiPolygon' ? (g.coordinates || []).map(poly => poly[0]) : [];
    for (const ring of rings) {
      const acres = polygonAreaAcresLonLat(ring || []);
      if (acres >= 20) largeShallow++;
    }
  }
  if (largeShallow >= 3) result.flats = 'multiple large shallow flats appear in mapped depth-area polygons';
  else if (largeShallow >= 1) result.flats = 'at least one large shallow flat appears in mapped depth-area polygons';
  return result;
}

// ── Depth-statistics derivation from bathymetric polygons ────────────────────
// Computes area-weighted mean depth and max depth directly from the
// depth_areas.geojson band polygons, cross-checked against contour lines and
// the lake boundary. This replaces LLM/sourced numbers when polygon coverage
// is sufficient — it is the limnologically standard hypsometric average
// (V/A) computed with midpoint integration over each depth band.
const GEOM_DEPTH_COVERAGE_THRESHOLD = 0.65; // require polygons to cover ≥65% of lake area
function polygonRingsAcres(g) {
  // Returns array of { ring, acres } for every outer ring of a Polygon/MultiPolygon.
  // Holes are not subtracted — depth_areas exports from the chart pipeline
  // typically do not include holes, and subtracting them requires a full
  // planar overlay we can't do client-side cheaply; outer-ring shoelace is
  // within ~2–5% for these datasets which is well inside the band-midpoint
  // error already present.
  if (!g) return [];
  const out = [];
  const collect = (coords) => {
    const outer = Array.isArray(coords) ? coords[0] : null;
    if (!Array.isArray(outer) || outer.length < 4) return;
    out.push({ ring: outer, acres: polygonAreaAcresLonLat(outer) });
  };
  if (g.type === 'Polygon') collect(g.coordinates);
  else if (g.type === 'MultiPolygon') (g.coordinates || []).forEach(poly => collect(poly));
  return out;
}

function deriveDepthStatistics(contourGeo, depthGeo, boundaryRing) {
  const out = { ok: false, polygonAreaAcres: 0, boundaryAreaAcres: 0, coverage: 0, bandCount: 0 };

  // 1. Sum polygon areas + build band histogram
  let totalBandArea = 0;
  let volumeAcFt = 0;
  let polyMaxDepth = 0;
  // THERE IS NO SUCH THING AS AN OPEN BAND, and this used to be built on the idea that there is.
  // `be` was read as "deeper than X with no ceiling"; it is the one band that straddles a 256 dm
  // page line, so its ceiling byte reads 0 because 256 mod 256 is 0. Every polygon on the card
  // carries both ends. Measured 2026-08-23 after the re-extract: 0 of 89,835 depth-area features
  // across 298 shipped packs lack a numeric depth_max_ft.
  //
  // So `openBanded`, `openBandAreaAcres`, `openBandAreaShare` and `averageDepthIsLowerBound` are
  // gone. They reported zero on every profile and described a property the data does not have.
  // What is left below is a guard on an UNREADABLE record rather than a claim about the lake --
  // counted, the way gmapmf_regions_v51.py counts `band_floor_above_ceiling`, so an impossible
  // case that starts happening is visible instead of silent.
  let unreadableCeilings = 0;
  // Distinct (floor, ceiling) pairs -- the number a person means by "depth bands". This counted
  // RINGS until 2026-08-23, which told the habitat agent Lake Jocassee has 18,967 depth bands
  // when it has 135, and set the no-boundary trust gate on a number that could be three rings of
  // one band.
  const bandsSeen = new Set();
  let ringCount = 0;
  if (depthGeo?.features?.length) {
    for (const f of depthGeo.features) {
      const p = f.properties || {};
      const zMin = Number(p.depth_min_ft);
      const zMaxRaw = p.depth_max_ft;
      const zMax = Number(zMaxRaw);
      const rings = polygonRingsAcres(f.geometry);
      for (const { acres } of rings) {
        if (!isFinite(acres) || acres <= 0) continue;
        totalBandArea += acres;
        // Band midpoint. If the deepest band has no upper bound (zMaxRaw is null/non-numeric),
        // treat the depth as zMin — conservative lower bound for average depth.
        let zEffective;
        if (isFinite(zMax) && isFinite(zMin)) {
          zEffective = (zMin + zMax) / 2;
          if (zMax > polyMaxDepth) polyMaxDepth = zMax;
        } else if (isFinite(zMin)) {
          // A FLOOR AND NO READABLE CEILING. Not a kind of band -- a record we could not read.
          // Count it at its floor rather than dropping it: the area is real water and dropping it
          // would move coverage and the average without saying so. `unreadableCeilings` is the
          // tripwire; it should stay at zero forever.
          zEffective = zMin;
          unreadableCeilings++;
          if (zMin > polyMaxDepth) polyMaxDepth = zMin;
        } else {
          continue; // no usable depth on this polygon
        }
        volumeAcFt += acres * zEffective;
        bandsSeen.add(isFinite(zMax) ? zMin + ':' + zMax : zMin + ':?');
        ringCount++;
      }
    }
  }
  out.polygonAreaAcres = Math.round(totalBandArea * 10) / 10;
  out.bandCount = bandsSeen.size;
  out.polygonCount = ringCount;
  out.unreadableCeilings = unreadableCeilings;

  // 2. Cross-check max against contour lines (deeper isobars may exist outside polygon coverage)
  let contourMaxDepth = 0;
  if (contourGeo?.features?.length) {
    for (const f of contourGeo.features) {
      const d = Number(f?.properties?.depth_ft);
      if (isFinite(d) && d > contourMaxDepth) contourMaxDepth = d;
    }
  }
  const maxDepthFt = Math.max(polyMaxDepth, contourMaxDepth);
  out.maxDepthFt = isFinite(maxDepthFt) && maxDepthFt > 0 ? Math.round(maxDepthFt * 10) / 10 : null;
  out.contourMaxDepthFt = isFinite(contourMaxDepth) && contourMaxDepth > 0 ? contourMaxDepth : null;
  out.polyMaxDepthFt = isFinite(polyMaxDepth) && polyMaxDepth > 0 ? polyMaxDepth : null;

  // 3. Compute surface area from boundary and coverage ratio
  const boundaryArea = boundaryRing ? polygonAreaAcresLonLat(boundaryRing) : 0;
  out.boundaryAreaAcres = Math.round(boundaryArea * 10) / 10;
  const hasBoundary = boundaryArea > 0;

  // Surface area determination: the boundary polygon represents the lake at full
  // pool and is the authoritative surface area. Depth-band polygons from chart
  // pipelines can overlap significantly (each band polygon may extend slightly
  // into adjacent bands), causing their sum to vastly overestimate the true lake
  // area (e.g. 70k ac summed vs 13k ac actual). When no boundary exists, we
  // cannot derive a reliable surface area — the overlapping bands sum inflates
  // wildly. Only set surfaceAreaAcres when we have a boundary polygon.
  let surfaceAcres;
  if (hasBoundary) {
    surfaceAcres = boundaryArea;
    // Detect excessive polygon overlap: if sum exceeds 1.5× boundary, the bands
    // are clearly overlapping and we should use boundary as the truth.
    if (totalBandArea > boundaryArea * 1.5) {
      out._bandOverlapWarning = `Depth-band polygons sum to ${Math.round(totalBandArea)} ac but boundary is ${Math.round(boundaryArea)} ac — using boundary area`;
    }
  } else {
    // No boundary — surface area cannot be reliably derived from overlapping bands.
    surfaceAcres = 0;
  }
  out.surfaceAreaAcres = (hasBoundary && surfaceAcres > 0) ? Math.round(surfaceAcres) : null;

  // Coverage ratio only computable when we have a boundary to compare against.
  if (totalBandArea > 0 && hasBoundary && surfaceAcres > 0) {
    const rawCoverage = totalBandArea / surfaceAcres;
    out.coverage = Math.round(Math.min(rawCoverage, 1.0) * 1000) / 1000;
    out._rawCoverage = Math.round(rawCoverage * 1000) / 1000;
  }

  // 4. Average depth = volume / totalBandArea — works correctly even with
  //    band overlap (both numerator and denominator are inflated proportionally).
  //    With a boundary: require ≥65% polygon coverage of the lake area.
  //    Without a boundary: require at least 3 depth bands as a minimum data bar.
  const canTrustAverage = hasBoundary
    ? (out.coverage >= GEOM_DEPTH_COVERAGE_THRESHOLD)
    : (bandsSeen.size >= 3);
  if (totalBandArea > 0 && canTrustAverage) {
    const avg = volumeAcFt / totalBandArea;
    if (isFinite(avg) && avg > 0) {
      out.averageDepthFt = Math.round(avg * 10) / 10;
      out.ok = true;
    }
  } else if (totalBandArea > 0 && out.maxDepthFt) {
    // Compute anyway but mark as partial — useful as a fallback or QA signal,
    // not published as a verified identity value.
    const avg = volumeAcFt / totalBandArea;
    if (isFinite(avg) && avg > 0) out.averageDepthFtPartial = Math.round(avg * 10) / 10;
  }

  return out;
}

// deriveDepthStatistics falls back to contour geometry when the depth-area polygons do not
// cover enough of the lake. Asking first means a pack with good depth areas -- which is most of
// them, 1,513 of 1,566 -- never downloads contours at all during research.
function depthStats_needsContours(depthGeo) {
  return !(depthGeo?.features?.length > 0);
}

// GARMIN SOUNDED THE BOTTOM AND WROTE IT DOWN, AND AN LLM WAS BEING ASKED THE SAME QUESTION.
//
// `garmin_6_0` is Garmin's nature-of-the-seabed class -- identified 2026-08-27, with the firmware's
// own section header "Bottom Conditions" sitting immediately ahead of the feature block at
// 0x6e966f8. The labels are standard chart abbreviations (NOAA Chart No. 1, section J): a material
// code, optionally preceded by a lowercase qualifier, space-separated when the bottom is mixed.
//
// Counted across every pack on disk, 2026-09-01: 4,074 records on 46 waters, 1,759 of them named,
// in 40 distinct label combinations. IT IS A MARINE ATTRIBUTE -- 98% sit on the 24 coastal zone
// packs, and inland it is 97 records on 11 waters, most of those tidal coastal-plain rivers.
// Wateree has none and Murray has one. So this fills bottomComposition where Garmin surveyed it
// and leaves it empty everywhere else, which is the honest answer and is what the field was
// getting a model's paragraph for.
//
// `Wd` is weed -- 60 records. That is the only charted vegetation anywhere in the pack set, and it
// is far too sparse to describe a lake's grass. It is reported as its own count rather than being
// folded into the bottom, so nobody later mistakes it for a vegetation survey.
const SEABED_MATERIAL = {
  S: 'sand', M: 'mud', Cy: 'clay', Si: 'silt', St: 'stones', G: 'gravel',
  P: 'pebbles', Sh: 'shells', Rk: 'rock', Co: 'coral', Wd: 'weed',
};
const SEABED_QUALIFIER = {
  f: 'fine', m: 'medium', c: 'coarse', so: 'soft', sy: 'sticky',
  h: 'hard', bk: 'broken', sf: 'stiff',
};

function bottomCompositionFromPois(poiGeo) {
  const feats = poiGeo?.features;
  if (!feats?.length) return null;
  const material = {};
  const qualifier = {};
  let labelled = 0;
  for (const f of feats) {
    const p = f.properties || {};
    if (p.poi_type !== 'garmin_6_0') continue;
    const label = String(p.name || '').trim();
    if (!label) continue;               // 57% of them carry no label at all
    labelled += 1;
    for (const token of label.split(/\s+/)) {
      // A token is an optional lowercase qualifier followed by a capitalised material code:
      // `soM` soft mud, `bkSh` broken shells, `fS` fine sand, `Cy` clay. A bare qualifier
      // (`so`, `sy`) is what the chart drew when it named a consistency and no material.
      const m = /^([a-z]*)([A-Z][a-z]?)?$/.exec(token);
      if (!m) continue;
      const [, q, mat] = m;
      if (q && SEABED_QUALIFIER[q]) qualifier[SEABED_QUALIFIER[q]] = (qualifier[SEABED_QUALIFIER[q]] || 0) + 1;
      if (mat && SEABED_MATERIAL[mat]) material[SEABED_MATERIAL[mat]] = (material[SEABED_MATERIAL[mat]] || 0) + 1;
    }
  }
  if (!labelled) return null;
  const weed = material.weed || 0;
  delete material.weed;
  const out = { ...material, ...qualifier };
  // A WEED MARK IS NOT A BOTTOM COMPOSITION. Lake Murray carries exactly one `garmin_6_0` label
  // and it reads `Wd`, which produced a bottom-composition object holding nothing but a note --
  // an empty finding dressed as a finding, on a 50,000-acre water. The rule is the material, not
  // a count: no decoded material or consistency means Garmin recorded no bottom here.
  if (!Object.keys(out).length) return weed ? { bottomComposition: null, chartedWeedMarks: weed } : null;
  out.note = `From ${labelled} charted Garmin bottom-conditions labels on this water`
    + (weed ? `; ${weed} of them read Wd (weed), which is a sounding note and not a vegetation survey.` : '.');
  return { bottomComposition: out, chartedWeedMarks: weed || null };
}

function derivePoiStructures(poiGeo) {
  // THIS USED TO KEEP ONLY BRIDGE NAMES. Fourteen lines whose entire output was one string:
  // it mapped every POI to its name, filtered for /bridge/i, and discarded the rest. Murrells
  // Inlet loads 2,353 POIs; research kept the bridges.
  //
  // What it was throwing away is precisely what Ryan pointed at on 2026-08-06: "there are garmin
  // POI labels that say submerged timber... fish attractors aren't going to show you stump
  // fields or submerged timber they will just show where dnr has dropped a brushpile... hazard
  // buoys for rocks, or sudden shallow areas is another place to look." On Wateree that is 55
  // Flooded Timber, 61 Shallow Area and 45 hazard marks, all fetched, all parsed, all dropped.
  const result = {};
  const feats = poiGeo?.features;
  if (!feats?.length) return result;

  // Grouped by the layer's own poi_type. `on_water` is already a field in the pack -- use it
  // rather than re-deriving it, and keep land POIs out of a structure summary. Ramps and
  // parking are legitimately on land and belong to the access index, not here.
  const counts = {};
  const named = {};
  for (const f of feats) {
    const p = f.properties || {};
    if (p.on_water === false) continue;
    const t = String(p.poi_type || p.class || '').trim();
    if (!t) continue;
    counts[t] = (counts[t] || 0) + 1;
    if (p.name) (named[t] = named[t] || []).push(String(p.name));
  }

  // The kinds the intel actually cites. Anything else is still counted below, but these get
  // named, because "Flooded Timber" is a place you fish and "Buoy" is furniture.
  const CITED = [/timber/i, /shallow/i, /hazard/i, /attractor/i, /pile/i, /bridge/i, /wreck/i, /reef/i];
  const cited = Object.keys(counts).filter(t => CITED.some(re => re.test(t)));
  if (cited.length) {
    result.chartedStructurePois = cited
      .sort((a, b) => counts[b] - counts[a])
      .map(t => `${counts[t]} ${t}`)
      .join('; ');
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total) {
    const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 6);
    result.chartedPoiMix = `${total} on-water charted POIs — ${top.map(t => `${counts[t]} ${t}`).join(', ')}`;
  }
  // Kept because it was here and it is genuinely useful on a river.
  const bridges = (named.Bridge || []).concat(
    Object.entries(named).filter(([t]) => /bridge/i.test(t)).flatMap(([, v]) => v));
  if (bridges.length) {
    result.bridges = bridges.length >= 2
      ? `bridge-related POIs include ${[...new Set(bridges)].slice(0, 3).join(', ')}`
      : `bridge-related POI includes ${bridges[0]}`;
  }
  return result;
}


/**
 * EVERY PACK-DERIVED FACT, FROM GEOJSON THE CALLER ALREADY HOLDS. No fetches, no lake-name
 * resolution, no R2 -- hand it the layers and it hands back the block.
 *
 * WHY IT IS SPLIT FROM THE FETCH. Ryan, 2026-09-04: "contours can change each time Garmin updates
 * them so anything derived from the packs should be ran when a plan is ran... the research
 * refactor docs should cover this". They do:
 * THE_PROFILE_BECAME_A_CACHE_AND_NOBODY_MOVED_THE_READS_2026-09-01.md, "What moves, concretely",
 * item 1 -- lift the pack derivations out of the research pipeline into the plan path, because
 * both planners already hold these same objects. A derivation stored in a profile is a photograph
 * of a chart that has since been replaced; the same derivation run on the bytes in hand cannot be
 * stale.
 *
 * ONE IMPLEMENTATION, TWO CALLERS. deriveGeospatialStructureFacts() is now the fetching half and
 * calls this, so a plan and a research run cannot disagree about what one pack says.
 */
function packDerivedFacts({ lakeName, structGeo, featGeo, depthGeo, poiGeo, boundaryGeo, contourGeo }) {
  const ring = getBoundaryOuterRing(boundaryGeo);
  const structuralElements = {
    ...summarizePointComplexityFromBoundary(ring),
    ...structuresFromPack(structGeo),
    ...waterFeaturesFromPack(featGeo),
    ...deriveDepthAreaStructures(depthGeo),
    ...derivePoiStructures(poiGeo),
  };

  // Geometry-derived identity facts (surface area, max depth, average depth).
  // These are preferred over LLM/sourced numbers when bathymetric polygon
  // coverage meets the threshold defined in deriveDepthStatistics.
  // Surface area / max depth / average depth is a DIFFERENT job from structure, and it is the
  // only thing that still wants the raw contour geometry. Fetched here rather than above so the
  // structure path no longer pays for it on packs that have structure.geojson.
  const depthStats = deriveDepthStatistics(contourGeo, depthGeo, ring);

  const identityFacts = {};
  const identityEvidence = {};
  const geoMeta = {};
  if (depthStats.ok) {
    if (depthStats.surfaceAreaAcres) identityFacts.surfaceAreaAcres = depthStats.surfaceAreaAcres;
    if (depthStats.maxDepthFt) identityFacts.maxDepthFt = depthStats.maxDepthFt;
    if (depthStats.averageDepthFt) identityFacts.averageDepthFt = depthStats.averageDepthFt;
    geoMeta.bathymetryCoverage = depthStats.coverage;
    geoMeta.bathymetryBandCount = depthStats.bandCount;
    geoMeta.bathymetryPolygonCount = depthStats.polygonCount;
    // Zero unless a record could not be read at all. See deriveDepthStatistics -- it replaces
    // four open-band fields that reported zero on every profile because open bands do not exist.
    geoMeta.bathymetryUnreadableCeilings = depthStats.unreadableCeilings || 0;
    const bathyEntry = buildEvidenceEntry(
      'internal_geospatial_layer',
      'TrollMap bathymetric contour/depth-area polygons',
      'internal:bathymetry',
      null,
      'geometry_derived_hypsometry',
      {
        polygonAreaAcres: depthStats.polygonAreaAcres,
        boundaryAreaAcres: depthStats.boundaryAreaAcres,
        coverage: depthStats.coverage,
        maxDepthFt: depthStats.maxDepthFt,
        averageDepthFt: depthStats.averageDepthFt,
        surfaceAreaAcres: depthStats.surfaceAreaAcres,
        unreadableCeilings: depthStats.unreadableCeilings || 0,
        bandCount: depthStats.bandCount,
      }
    );
    if (depthStats.surfaceAreaAcres) identityEvidence.surfaceAreaAcres = [bathyEntry];
    if (depthStats.maxDepthFt) identityEvidence.maxDepthFt = [bathyEntry];
    if (depthStats.averageDepthFt) identityEvidence.averageDepthFt = [bathyEntry];
  } else if (depthStats.maxDepthFt) {
    // Coverage too low to trust the average, but max depth from contours is still usable.
    identityFacts.maxDepthFt = depthStats.maxDepthFt;
    geoMeta.bathymetryCoverage = depthStats.coverage;
    geoMeta.bathymetryNote = 'Polygon coverage below threshold; only contour max depth used.';
    identityEvidence.maxDepthFt = [buildEvidenceEntry(
      'internal_geospatial_layer',
      'TrollMap bathymetric contour lines',
      'internal:contours',
      null,
      'geometry_derived_max_depth_only',
      { maxDepthFt: depthStats.maxDepthFt, coverage: depthStats.coverage }
    )];
  }

  const bottom = bottomCompositionFromPois(poiGeo);
  const hasStructure = Object.keys(structuralElements).length > 0;
  const hasIdentity = Object.keys(identityFacts).length > 0;
  if (!hasStructure && !hasIdentity && !bottom) return null;

  const evidence = { habitat: {}, identity: identityEvidence };
  for (const field of Object.keys(structuralElements)) {
    evidence.habitat[`structuralElements.${field}`] = [buildEvidenceEntry('internal_geospatial_layer', 'TrollMap structure / water_features / POI / boundary layers', 'internal:structure+water_features+pois+boundaries', null, 'pipeline_derived_structure_layers', { lakeName })];
  }

  if (bottom?.bottomComposition) {
    evidence.habitat.bottomComposition = [buildEvidenceEntry(
      'internal_geospatial_layer', 'Garmin charted bottom-conditions labels (chartpack pois.geojson)',
      'internal:pois#garmin_6_0', null, 'charted_seabed_abbreviations', { labelled: bottom.bottomComposition.note })];
  }
  const habitatSection = (hasStructure || bottom) ? {
    ...(hasStructure ? { structuralElements } : {}),
    ...(bottom?.bottomComposition ? { bottomComposition: bottom.bottomComposition } : {}),
    ...(bottom?.chartedWeedMarks ? { chartedWeedMarks: bottom.chartedWeedMarks } : {}),
    notes: 'Structural elements summarized from TrollMap contour, depth-area, POI, and boundary layers.'
  } : (undefined);

  const identitySection = hasIdentity ? { ...identityFacts, _geometryDerived: true, _bathymetryMeta: geoMeta } : (undefined);

  return {
    habitat: habitatSection,
    identity: identitySection,
    evidence,
    sources: [{ label: 'TrollMap structure / water_features / POI / boundary layers', url: 'internal:contours+supplemental+boundaries', trust: 'OFFICIAL_GIS', sourceType: 'internal_geospatial_layer' }],
    depthStats,
  };
}

export {
  packDerivedFacts,
  // The engine's fetching half still asks whether it needs to download contours at all.
  depthStats_needsContours,
  // Read directly by tests that pin the geometry, and by nothing else.
  deriveDepthStatistics,
  getBoundaryOuterRing,
  structuresFromPack,
  waterFeaturesFromPack,
  deriveDepthAreaStructures,
  derivePoiStructures,
  bottomCompositionFromPois,
};
