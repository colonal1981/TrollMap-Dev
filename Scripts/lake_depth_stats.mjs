#!/usr/bin/env node
// lake_depth_stats.mjs — max and average depth for one chartpack, from the app's own function.
//
// Ryan, 2026-09-04, on Smart Plan getting no depth: "but that doesn't fix that depth still needs
// to be stamped somewhere for smartplan right... because smartplan needs the info?"
//
// It does. `Max depth` and `Average depth` are two of the twenty-odd lines researchIntel() prints,
// and they are computed from `depth_areas.geojson` — which Pick Water downloads because it draws
// a bathymetry map from it, and Smart Plan does not download because it draws no such map. So a
// Smart Plan could only ever get them out of a stored research profile, and 3 of 80 profiles carry
// them. Item 2 of the research refactor: the pipeline works them out once, stamps them on the
// registry row, and both tabs read a property instead of a file.
//
// THE FILE IS THE REASON THIS IS A PIPELINE JOB AND NOT A FETCH. Measured on the pipeline copies:
// 0.1 MB on lake_russel, 18.6 MB on Wateree, 174.7 MB on Murray, 255.0 MB on Thurmond. Two numbers
// are not worth a quarter-gigabyte parse in a browser tab, and they never change between Garmin
// card updates — which is exactly the cadence this runs at.
//
// IT IMPORTS deriveDepthStatistics RATHER THAN REIMPLEMENTING IT. Same reason
// build_dnr_ramps_by_lake.py runs js/data/ga-access-species.js under node instead of keeping a
// second copy of the Georgia species columns: a number the browser and the pipeline both compute
// is a number they can disagree about. The browser still derives these live where it has the file
// in hand (Pick Water does), and a live measurement beats a stamp — see registryIdentity() in
// js/modules/plan-inputs.js for that precedence.
//
//     node Scripts/lake_depth_stats.mjs <packDir> [boundaryFile]
//
// Prints one JSON object on stdout. Every failure is a JSON object too, with `error`, because the
// caller is a batch and an exception it cannot parse is a pack it cannot report on.
//
// Personal use only, not for distribution or resale; not for navigation.
import fs from 'node:fs';
import path from 'node:path';
import { deriveDepthStatistics, getBoundaryOuterRing, depthStats_needsContours }
  from '../js/utils/pack-facts.js';

const [, , packDir, boundaryFile] = process.argv;
const say = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(o.error ? 2 : 0); };
if (!packDir) say({ error: 'usage: lake_depth_stats.mjs <packDir> [boundaryFile]' });

const readJson = (p) => {
  if (!p || !fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return { _readError: e.message }; }
};

const depthPath = path.join(packDir, 'depth_areas.geojson');
const depthGeo = readJson(depthPath);
if (depthGeo && depthGeo._readError) say({ error: `depth_areas: ${depthGeo._readError}` });

// Contours only when there are no depth areas at all -- 1,513 of 1,566 packs never need them,
// and on Thurmond that file is another 133 MB.
const contourGeo = depthStats_needsContours(depthGeo)
  ? readJson(path.join(packDir, 'contours.geojson')) : null;
if (contourGeo && contourGeo._readError) say({ error: `contours: ${contourGeo._readError}` });

const boundaryGeo = readJson(boundaryFile || path.join(packDir, 'boundary.geojson'));
const ring = boundaryGeo && !boundaryGeo._readError ? getBoundaryOuterRing(boundaryGeo) : null;

if (!depthGeo && !contourGeo) say({ error: 'no depth_areas.geojson and no contours.geojson' });

const s = deriveDepthStatistics(contourGeo, depthGeo, ring);
say({
  // `ok` is deriveDepthStatistics' own word for "the average is trustworthy" -- it wants 65%
  // polygon coverage of the boundary, or three distinct bands when there is no boundary. The
  // caller stamps the average only when this is true; the max does not depend on it.
  ok: !!s.ok,
  maxDepthFt: s.maxDepthFt ?? null,
  averageDepthFt: s.averageDepthFt ?? null,
  // Computed but NOT trusted -- reported so a pack that is close to the bar is visible rather
  // than looking identical to one with no data at all.
  averageDepthFtPartial: s.averageDepthFtPartial ?? null,
  surfaceAreaAcres: s.surfaceAreaAcres ?? null,
  coverage: s.coverage ?? 0,
  bandCount: s.bandCount ?? 0,
  hadBoundary: !!ring,
  usedContours: !!contourGeo,
});
