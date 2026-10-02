#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHERE EACH FITTED LANE RUNS IN A CHANNEL, ONE FILE PER PACK: <pack>/channels.json
//
// Ryan, 2026-10-01: "just the fact that it is a deep creek channel is structure in itself... it is
// called out as something to fish for striper", and "I just want that water in the middle of the
// creek and the east to west channel to be offered in smart plan". The rule is in
// js/modules/plan-channels.js and this runs that module, not a second copy of it, over every
// fitted lane with the app's own depth sampler. Smart Plan reads the answer; it never downloads the
// depth areas this needs (51 MB on Marion).
//
//     node Scripts/stamp_channels.mjs --root F:\TrollMapPipeline\chartpack
//     node Scripts/stamp_channels.mjs --root F:\TrollMapPipeline\chartpack --lake lake_marion wateree_lake
//
// Then the upload, which is Ryan's:
//     py Scripts\upload_garmin_to_r2.py --root F:\TrollMapPipeline\chartpack --layers channels
//
// A pack without the file plans exactly as it did before it existed.
//
// Personal use only, not for distribution or resale; not for navigation.
// ─────────────────────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { channelStretches, RELIEF_RADIUS_M, FLAT_DROP_FT } from '../js/modules/plan-channels.js';
import { depthSampler } from '../js/modules/plan-water-index.js';

const argv = process.argv.slice(2);
const at = argv.indexOf('--root');
const ROOT = at >= 0 ? argv[at + 1] : null;
if (!ROOT || !fs.existsSync(ROOT)) {
  console.error('usage: node Scripts/stamp_channels.mjs --root <chartpack folder> [--lake slug ...]');
  process.exit(2);
}
const li = argv.indexOf('--lake');
const ONLY = li >= 0 ? argv.slice(li + 1).filter((a) => !a.startsWith('--')) : null;

const slugs = (ONLY && ONLY.length ? ONLY : fs.readdirSync(ROOT))
  .filter((s) => !s.startsWith('_') && fs.existsSync(path.join(ROOT, s, 'trolling_runs.geojson'))
               && fs.existsSync(path.join(ROOT, s, 'depth_areas.geojson')));

let done = 0, failed = 0;
const t0 = Date.now();
for (const slug of slugs) {
  const dir = path.join(ROOT, slug);
  const t = Date.now();
  try {
    const runs = JSON.parse(fs.readFileSync(path.join(dir, 'trolling_runs.geojson'), 'utf8')).features || [];
    const depthAt = depthSampler(JSON.parse(fs.readFileSync(path.join(dir, 'depth_areas.geojson'), 'utf8')).features || []);
    const out = {};
    let lanes = 0, tagged = 0, metres = 0;
    for (const f of runs) {
      const p = f && f.properties;
      if (!p || p.fitted !== true || !p.id || !Array.isArray(p.envelope_line_ft)) continue;
      lanes++;
      const st = channelStretches(f, depthAt);
      if (!st.length) continue;
      out[p.id] = st;
      tagged++;
      for (const [a, b] of st) metres += b - a;
    }
    fs.writeFileSync(path.join(dir, 'channels.json'), JSON.stringify({
      built: new Date().toISOString(),
      rule: { radiusM: RELIEF_RADIUS_M, riseFt: FLAT_DROP_FT, probe: 'envelope_m',
              says: 'a stretch of a fitted lane where the bottom comes up more than riseFt above '
                  + 'the water under the line within radiusM on BOTH sides' },
      lanes, runs: out,
    }));
    done++;
    console.log(`${slug}: ${tagged} of ${lanes} fitted lanes run a channel somewhere, `
              + `${(metres / 1609.34).toFixed(0)} mi in all (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    console.error(`${slug}: FAILED ${e && e.message}`);
  }
}
console.log(`\n${done} packs stamped, ${failed} failed, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
process.exit(failed ? 1 : 0);
