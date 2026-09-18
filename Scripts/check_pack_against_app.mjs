#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────────────────────
// DOES THE APP GET A DAY OUT OF THIS PACK?
//
// Twice on 2026-09-18 the pipeline wrote output that was structurally perfect and the app could
// not use. Both times the thing that caught it was a throwaway script and a pair of eyes:
//
//   * the trolling lane was drawn down the middle of the water instead of the channel, so the leg
//     Ryan ran came back over a sandbar with 4 ft on it while the same cross-section held 20;
//   * the centreline was carried 26 km past the boundary and every one of those stations arrived
//     with NO DEPTH, because cross_sections() was handed this pack's own soundings and that water
//     is charted by Lake Marion. charted_frac 0, every envelope -1, mean_depth_ft absent -- a
//     reach eligibleForHolding() rejects outright and a lane channelFractions() cannot follow.
//
// Neither is visible in the build report. Both are obvious the moment the pack is read by the
// code that has to plan on it. So this loads a real pack through the APP'S OWN MODULES -- not a
// second implementation of them -- and asserts what a day needs.
//
// Run it after the pipeline and BEFORE the upload. Exit code 1 means do not upload.
//
//     node Scripts/check_pack_against_app.mjs --chartpack F:\TrollMapPipeline\chartpack ^
//                                              --registry F:\TrollMapPipeline\registry
//     ... --slug congaree_river -v        one river, with the per-river table
//
// Personal use only, not for distribution or resale; not for navigation.
// ─────────────────────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { riverDriftRuns, channelFractions, lateralsFor, medianWidthM,
         centrelineTransit } from '../js/modules/river-drifts.js';
import { eligibleForHolding } from '../js/modules/plan-candidates.js';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const CHARTPACK = arg('--chartpack');
const REGISTRY = arg('--registry');
const ONLY = arg('--slug');
const VERBOSE = argv.includes('-v') || argv.includes('--verbose');
// The band a leg is judged against when nobody has researched the water. Only used to ask whether
// a reach would be OFFERED at all; the real band comes from the research profile at plan time.
const ANY_BAND = [0, Infinity];
if (!CHARTPACK) {
  console.error('--chartpack is required (the folder holding the per-slug packs)');
  process.exit(2);
}
// REQUIRED, NOT OPTIONAL-WITH-A-DOWNGRADE. Rule 4b's only failure needs the boundary, and a check
// that quietly does less when a flag is missing is verify_registry_r2.py printing that twenty
// objects matched over twenty it had not compared. If the boundaries are not there, say so and stop.
if (!REGISTRY || !fs.existsSync(path.join(REGISTRY, 'boundaries'))) {
  console.error('--registry is required and must hold boundaries\\<slug>.geojson');
  console.error('   e.g. --registry F:\\TrollMapPipeline\\registry');
  process.exit(2);
}

const problems = [];
const fail = (slug, what) => problems.push(`${slug}: ${what}`);

// ── WHERE THE REGISTRY SAYS THIS WATER IS ────────────────────────────────────────────────────
// Read once per pack and only asked about the two ends of the line, so the cost is a parse and a
// handful of point-in-polygon tests, not a spatial index.
function loadBoundary(slug) {
  const bp = path.join(REGISTRY, 'boundaries', `${slug}.geojson`);
  if (!fs.existsSync(bp)) return null;
  try {
    const fc = JSON.parse(fs.readFileSync(bp, 'utf8'));
    return (fc.features || [fc]).map((ft) => ft.geometry).filter(Boolean);
  } catch { return null; }
}

function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** Inside the outline, holes excluded. A ring is lon/lat and so is the point; no projection is
 *  needed because containment is invariant under the monotone map either axis gets. */
function inWater(geoms, pt) {
  if (!geoms || !Array.isArray(pt)) return false;
  const [x, y] = pt;
  for (const g of geoms) {
    const polys = g.type === 'Polygon' ? [g.coordinates]
      : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      if (!poly.length || !inRing(poly[0], x, y)) continue;
      let hole = false;
      for (let k = 1; k < poly.length; k++) if (inRing(poly[k], x, y)) hole = true;
      if (!hole) return true;
    }
  }
  return false;
}

/** Every pack that carries a river centreline. */
function riverSlugs() {
  return fs.readdirSync(CHARTPACK)
    .filter((s) => !s.startsWith('_'))
    .filter((s) => fs.existsSync(path.join(CHARTPACK, s, 'centreline.geojson')))
    .filter((s) => !ONLY || s === ONLY)
    .sort();
}

function checkOne(slug) {
  const fc = JSON.parse(fs.readFileSync(path.join(CHARTPACK, slug, 'centreline.geojson'), 'utf8'));
  const f = fc.features && fc.features[0];
  if (!f) { fail(slug, 'centreline.geojson carries no feature'); return null; }
  const p = f.properties || {};
  const n = (p.station_m || []).length;
  const line = (f.geometry && f.geometry.coordinates) || [];
  const boundary = loadBoundary(slug);

  // ── 1. THE AXIS AND THE LENGTH ARE BOTH WRITTEN, AND NAMED FOR WHAT THEY ARE ─────────────────
  // river-drifts.js bounds its reaches with `station_span_m` and cuts them on `station_m`. When it
  // used `length_m` -- the chord sum, 0.8% shorter -- every reach stopped 21 stations short of the
  // end of the Congaree, which on the downstream arm was a third of the arm.
  const span = Number(p.station_span_m);
  if (!Number.isFinite(span)) fail(slug, 'no station_span_m: the producer is not naming the axis');
  else if (span + 1 < Number(p.length_m)) fail(slug, `station_span_m ${span} is under length_m ${p.length_m}`);

  // ── 2. THE PROFILE IS THERE AND IT IS NOT ALL HOLES ──────────────────────────────────────────
  const prof = p.depth_profile_ft || [];
  const fr = p.profile_fractions || [];
  if (prof.length !== n || !fr.length) fail(slug, 'depth_profile_ft does not line up with the stations');
  const charted = prof.filter((row) => Array.isArray(row) && row.some((v) => Number(v) > 0)).length;
  const frac = n ? charted / n : 0;

  // ── 3. THE CHANNEL LANE, WHICH IS WHAT THE DAY IS ACTUALLY FISHED ON ─────────────────────────
  const fracAt = channelFractions(prof, fr, p.width_m || []);
  if (fracAt.length !== (p.width_m || []).length) fail(slug, 'channelFractions did not answer per station');
  const mid = fr.indexOf(0.5);
  const depthAt = (i, frq) => {
    const row = prof[i];
    if (!Array.isArray(row)) return null;
    let best = 0, bd = Infinity;
    for (let j = 0; j < fr.length; j++) { const d = Math.abs(fr[j] - frq); if (d < bd) { bd = d; best = j; } }
    const v = Number(row[best]);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  let midSum = 0, midN = 0, chanSum = 0, chanN = 0;
  for (let i = 0; i < n; i++) {
    const a = mid >= 0 ? depthAt(i, 0.5) : null;
    const b = depthAt(i, fracAt[i]);
    if (a != null) { midSum += a; midN++; }
    if (b != null) { chanSum += b; chanN++; }
  }
  const midMean = midN ? midSum / midN : 0;
  const chanMean = chanN ? chanSum / chanN : 0;
  // THE ONE PROPERTY THE LANE FIX GUARANTEES. The channel line reads the deepest charted column at
  // every station, so it cannot average shallower than a line down the middle. If it does, either
  // the profile columns have been reordered or channelFractions is reading the wrong axis.
  if (chanN && midN && chanMean + 1e-9 < midMean) {
    fail(slug, `the channel lane averages ${chanMean.toFixed(1)} ft against the middle's ${midMean.toFixed(1)}`);
  }

  // ── 4. THE REACHES THE APP WOULD ACTUALLY BUILD ──────────────────────────────────────────────
  // rampStationM 0 IS THE HEAD OF THE LINE, NOT A GUESS AT A LAUNCH. A real ramp is a plan-time
  // input and there is no right value for it here; what this section asks is whether the reaches
  // cover the river and carry depth, and the answer to that must not depend on where he put in.
  // An earlier draft of this check failed on "5 of 20 reaches carry no depth", which was true of
  // the ramp I had invented and of nothing else.
  const runs = riverDriftRuns(fc, { slug, rampStationM: 0, maxOffM: 100 });
  if (!runs.length) { fail(slug, 'riverDriftRuns returned nothing'); return { slug, frac, runs: 0 }; }
  // HOW FAR THE REACHES REACH, ON THE AXIS AND NOT IN CHORD METRES.
  //
  // The first version of this added `reachFromM` -- a station -- to `length_m` -- the chord sum of
  // the drawn coordinates -- and allowed 100 m of slack to cover the difference. That is the exact
  // swap river-drifts.js has a paragraph about: an axis and a length share a unit and are not the
  // same quantity, and the sagitta of every 50 m step makes the chord about 0.8% shorter. So it
  // reported four rivers stopping 102-152 m short and the number was the sagitta of their last
  // reach, not a gap. A check whose tolerance has to be guessed is measuring the wrong thing.
  //
  // Stations are evenly spaced at `envelope_step_m` and a reach holds every station in its span, so
  // its span on the axis is exactly (stations - 1) steps from where it starts. What is left over is
  // then bounded by one step -- the last station can sit that far short of the span -- and that is a
  // derived bound rather than a picked one.
  const reachEnd = (q) => Number(q.reachFromM) + (Number(q.stations) - 1) * (Number(q.envelope_step_m) || 50);
  const covered = Math.max(...runs.map((r) => reachEnd(r.properties)));
  const step = Number(p.step_m) || 50;
  if (Number.isFinite(span) && covered + step < span) {
    fail(slug, `the reaches stop ${Math.round(span - covered)} m short of the end of the river `
               + `(one station step is ${step} m)`);
  }
  let noEnvelope = 0, rejected = 0, inconsistent = 0;
  for (const r of runs) {
    const q = r.properties;
    if (!Array.isArray(q.envelope_line_ft) || !Array.isArray(q.envelope_ft)
        || q.envelope_line_ft.length !== q.stations) noEnvelope++;
    if (!eligibleForHolding(q, ANY_BAND, null).ok) rejected++;
    // THE INVARIANT, AS OPPOSED TO THE COVERAGE. A reach whose envelope carries real soundings and
    // still has no mean depth is broken; a reach over water nobody sounded is honest, and failing
    // on it would be failing on Garmin's survey rather than on this pipeline.
    const sounded = Array.isArray(q.envelope_line_ft) && q.envelope_line_ft.some((v) => Number(v) > 0);
    if (sounded && !Number.isFinite(q.mean_depth_ft)) inconsistent++;
  }
  if (inconsistent) {
    fail(slug, `${inconsistent} reach(es) carry soundings in the envelope and no mean_depth_ft`);
  }
  if (noEnvelope) fail(slug, `${noEnvelope} of ${runs.length} reaches have no usable envelope arrays`);
  if (frac > 0.5 && rejected === runs.length) {
    fail(slug, 'every reach would be rejected by eligibleForHolding — nothing here can be planned');
  }

  // ── 4b. A LINE THAT ENDS WHERE THE APP CAN SEE NO DEPTH ──────────────────────────────────────
  //
  // THIS IS THE ONE THAT WOULD HAVE CAUGHT 2026-09-18. The Congaree was carried 26 km past its
  // boundary and every one of those stations came back with an empty profile, because
  // cross_sections() was reading this pack's own soundings and that water is Lake Marion's.
  // Nothing in the build report says so: the chain length went UP and the station count went UP.
  //
  // BUT "NO DEPTH THE APP CAN USE" HAS THREE CAUSES AND ONLY ONE IS A DEFECT, and the first
  // version of this rule could not tell them apart -- it fired on four rivers and called all four
  // ends "unsounded", which was the wrong word for three of them:
  //
  //   Garmin never surveyed it.      combahee_river's top 17.2 km. Inside its own boundary,
  //                                  charted_frac 0 the whole way, 10-25 m wide. Failing on this
  //                                  is failing on Garmin's survey, not on this pipeline.
  //   Garmin surveyed it as 0-1 ft.  congaree_river's top 43.9 km -- which is the Broad above
  //                                  Columbia, inside the registry's own congaree boundary -- and
  //                                  saluda_river_2's top 11.3 km. There IS a depth area over
  //                                  those stations and its band is [0,1], so cross_sections()
  //                                  writes the band's shallow edge, 0, and river-drifts.js reads
  //                                  `d > 0` and discards it. Real data about water he cannot
  //                                  troll. Worth saying; not a defect.
  //   The line is somewhere no        waccamaw_river's top 7.6 km sits outside EVERY registry
  //   water is.                       water's bounding box, its own included, with no chart on it.
  //                                   That is the producer having put stations where nothing owns
  //                                   the water, which is the 26 km extension's exact shape.
  //
  // So the discriminator is the boundary, and `charted_frac` -- which the producer already writes
  // per station -- separates the first two for free. The failure is: an end run the app can get no
  // depth from, that nothing charted at all, lying OUTSIDE this water's own boundary.
  const sounded = (i) => Array.isArray(prof[i]) && prof[i].some((v) => Number(v) > 0);
  const cf = p.charted_frac || [];
  const dl = p.deepest_line_ft || [];
  const runAt = (from, dir) => {
    const idx = [];
    for (let i = from; i >= 0 && i < n; i += dir) { if (sounded(i)) break; idx.push(i); }
    return idx;
  };
  const endNotes = [];
  for (const [end, idx] of [['downstream', runAt(n - 1, -1)], ['upstream', runAt(0, +1)]]) {
    if (idx.length < 20) continue;                 // a handful of stations at a bank is not a story
    const km = (idx.length * step / 1000).toFixed(1);
    // THE THREE BUCKETS, EACH FROM A FIELD THE PRODUCER ALREADY WRITES RATHER THAN FROM A GUESS AT
    // A CAUSE. `charted_frac` is the share of cross-section probes that found any depth band;
    // `deepest_line_ft` is the deepest band's shallow EDGE anywhere on that section. So a station
    // with probes that hit and a deepest edge of 0 was surveyed, and surveyed as the 0-1 ft band.
    const nochart = idx.filter((i) => !(Number(cf[i]) > 0));
    const zeroBand = idx.filter((i) => Number(cf[i]) > 0 && !(Number(dl[i]) > 0));
    // AND THE ONE THAT WOULD BE A PRODUCER BUG. The section found real depth and not one of the
    // profile's fractions landed on it -- cross_sections() takes the nearest sample to each
    // fraction out of ALL samples, hit or not, so on a sparsely charted section every fraction can
    // land in a gap while the section itself has 20 ft on it. Nought across all 57 rivers today,
    // which is why it is asserted rather than assumed: this is the guard on that rule.
    const lost = idx.filter((i) => Number(dl[i]) > 0);
    const outside = boundary ? idx.filter((i) => !inWater(boundary, line[i])).length : null;
    endNotes.push(`${end} ${km} km: ${nochart.length} unsurveyed, ${zeroBand.length} surveyed as `
                  + `0-1 ft` + (outside === null ? ''
                    : `, ${outside} of ${idx.length} outside the boundary`));
    if (lost.length) {
      fail(slug, `${lost.length} station(s) at the ${end} end have real depth on the section and `
                 + `nothing in the profile -- every fraction landed in a gap`);
    }
    // THE WHOLE RUN, NOT ITS TIP. The first version asked only about the outermost station and
    // called black_mingo_creek and chessie_creek defects on the strength of it: 67 of 69 and 71 of
    // 74 of those stations are inside their own boundary, and the two that are not are the last
    // resampled stations poking past a polygon edge the line is following. Every station outside is
    // unambiguous and is the shape of the 26 km extension -- all 520 of those were outside.
    if (outside === idx.length && nochart.length === idx.length) {
      fail(slug, `the ${end} end runs ${km} km (${idx.length} stations) entirely outside this `
                 + `water's own boundary with nothing charted on any of it`);
    }
  }

  // ── 5. A POINT ON THE LINE STILL PROJECTS BACK TO ITS OWN STATION ────────────────────────────
  //
  // centrelineTransit().stationAt() is what turns Bates Bridge into a station metre, and every
  // reach in the day is placed relative to that one number. It reads `station_m` at the nearest
  // VERTEX, so the two arrays have to stay in step -- and the producer now appends and prepends
  // vertices, which is precisely the operation that can leave them out of step. A line whose
  // geometry and station array disagree does not fail: it silently puts the launch somewhere else
  // on the river, and the day is built around the wrong place.
  //
  // So the test is the one the app depends on: feed a vertex back in and get its own station out.
  // Endpoints and the middle, to catch a reversed line as well as a shifted one.
  const t = centrelineTransit(fc);
  if (!t || typeof t.stationAt !== 'function') {
    fail(slug, 'centrelineTransit could not read this pack');
  } else {
    const stn = p.station_m || [];
    for (const i of [0, Math.floor(n / 2), n - 1]) {
      if (!Array.isArray(line[i])) { fail(slug, `no vertex at station ${i}`); break; }
      const got = t.stationAt(line[i]);
      // Exactly its own station, not near it: stationAt returns a value COPIED from station_m,
      // so any difference is the wrong vertex, and on a hairpin the wrong vertex is the far arm.
      if (Number(got) !== Number(stn[i])) {
        fail(slug, `vertex ${i} projects to ${got} m and its station says ${stn[i]} m`);
        break;
      }
    }
  }

  return { slug, frac, runs: runs.length, covered, span, midMean, chanMean, rejected, endNotes,
           laterals: lateralsFor(medianWidthM(p.width_m), 100).map((l) => l.key).join('+') };
}

const rows = [];
for (const slug of riverSlugs()) {
  try {
    const r = checkOne(slug);
    if (r) rows.push(r);
  } catch (e) {
    fail(slug, `threw: ${e && e.message}`);
  }
}

if (VERBOSE) {
  console.log('%s %s %s %s %s %s', 'river'.padEnd(26), 'charted'.padStart(8), 'reaches'.padStart(8),
              'middle'.padStart(8), 'channel'.padStart(8), 'lane');
  for (const r of rows) {
    console.log('%s %s %s %s %s %s', r.slug.padEnd(26),
                `${(r.frac * 100).toFixed(0)}%`.padStart(8), String(r.runs).padStart(8),
                `${r.midMean.toFixed(1)}`.padStart(8), `${r.chanMean.toFixed(1)}`.padStart(8),
                r.laterals);
  }
  console.log();
}

// WHAT THE ENDS OF EACH LINE ACTUALLY ARE. Not failures -- most of these are Garmin's survey and
// not this pipeline's doing -- but the thing to read before believing a river's charted percentage,
// because a fifth of the Congaree's stations are the Broad above Columbia charted as a foot deep.
const withEnds = rows.filter((r) => r.endNotes && r.endNotes.length);
if (withEnds.length) {
  console.log('ends the app can get no depth from:');
  for (const r of withEnds) for (const noteLine of r.endNotes) {
    console.log('   %s %s', r.slug.padEnd(26), noteLine);
  }
  console.log();
}

console.log('%d pack(s) checked through the app\'s own modules', rows.length);
if (!problems.length) {
  const gain = rows.filter((r) => r.chanMean > r.midMean + 0.05).length;
  console.log('   no problems. The channel lane is deeper than the middle on %d of %d.', gain, rows.length);
  process.exit(0);
}
console.log('\n%d PROBLEM(S) -- do not upload:\n', problems.length);
for (const p of problems) console.log('   ' + p);
process.exit(1);
