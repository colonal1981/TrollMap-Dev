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
//     node Scripts/check_pack_against_app.mjs --chartpack F:\TrollMapPipeline\chartpack
//     node Scripts/check_pack_against_app.mjs --chartpack ... --slug congaree_river -v
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
const ONLY = arg('--slug');
const VERBOSE = argv.includes('-v') || argv.includes('--verbose');
// The band a leg is judged against when nobody has researched the water. Only used to ask whether
// a reach would be OFFERED at all; the real band comes from the research profile at plan time.
const ANY_BAND = [0, Infinity];
if (!CHARTPACK) {
  console.error('--chartpack is required (the folder holding the per-slug packs)');
  process.exit(2);
}

const problems = [];
const fail = (slug, what) => problems.push(`${slug}: ${what}`);

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
  const covered = Math.max(...runs.map((r) => r.properties.reachFromM + Math.round(r.properties.length_m)));
  if (Number.isFinite(span) && covered + 100 < span) {
    fail(slug, `the reaches stop ${Math.round(span - covered)} m short of the end of the river`);
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

  // ── 4b. A LINE THAT ENDS IN A LONG UNSOUNDED RUN ─────────────────────────────────────────────
  //
  // THIS IS THE ONE THAT WOULD HAVE CAUGHT 2026-09-18. The Congaree was carried 26 km past its
  // boundary and every one of those 520 stations came back with an empty profile, because
  // cross_sections() was reading this pack's soundings and that water is Lake Marion's. Nothing in
  // the build report says so: the chain length went UP and the station count went UP.
  //
  // A river genuinely running out of survey at its end is possible, so the test is against the
  // rest of the line: a tail of unsounded stations on a pack that is otherwise well charted is the
  // producer having extended into water it then could not read.
  const sounded = (i) => Array.isArray(prof[i]) && prof[i].some((v) => Number(v) > 0);
  const runAt = (from, step) => {
    let k = 0;
    for (let i = from; i >= 0 && i < n; i += step) { if (sounded(i)) break; k++; }
    return k;
  };
  for (const [end, k] of [['downstream', runAt(n - 1, -1)], ['upstream', runAt(0, +1)]]) {
    if (frac > 0.5 && k > 100) {
      fail(slug, `the ${end} end finishes with ${k} unsounded stations (${(k * (Number(p.step_m) || 50) / 1000).toFixed(1)} km) `
                 + `on a line that is otherwise ${(frac * 100).toFixed(0)}% charted`);
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
    const line = (f.geometry && f.geometry.coordinates) || [];
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

  return { slug, frac, runs: runs.length, covered, span, midMean, chanMean, rejected,
           tailUnsounded: runAt(n - 1, -1), headUnsounded: runAt(0, +1),
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

console.log('%d pack(s) checked through the app\'s own modules', rows.length);
if (!problems.length) {
  const gain = rows.filter((r) => r.chanMean > r.midMean + 0.05).length;
  console.log('   no problems. The channel lane is deeper than the middle on %d of %d.', gain, rows.length);
  process.exit(0);
}
console.log('\n%d PROBLEM(S) -- do not upload:\n', problems.length);
for (const p of problems) console.log('   ' + p);
process.exit(1);
