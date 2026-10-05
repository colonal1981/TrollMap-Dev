#!/usr/bin/env node
// qdc_points.mjs -- Ryan's Quickdraw recordings to soundings, with the APP'S OWN reader.
//
// Personal use only, not for distribution or resale; not for navigation.
//
//     node Scripts/qdc_points.mjs --layer 0 --out points.json <folder> [<folder> ...]
//
// Writes [[lon, lat, depth_ft], ...] for every sounded cell, and prints how many files it saw,
// how many it could read at this layer, and the extent it decoded.
//
// WHY NODE AND NOT A PYTHON PORT. js/modules/qdc-decoder.js is what draws his Quickdraw in the
// app, and it is a port of qdc-converter that has already been fixed twice (the sentinel bounds,
// and the per-tile grid). A second decoder in Python is a second answer to "where is this
// sounding" -- the shape of every drift this project keeps paying for. So the pipeline imports
// the app's reader, unchanged, and survey_chart.py calls this.
//
// The card nests a .qdc ten folders deep. Files are taken in path order, which is the order a
// folder pick hands the browser, so a tile two files write is decided the same way in both.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { parseQDCFolder } = await import(pathToFileURL(path.join(here, '..', 'js', 'modules', 'qdc-decoder.js')).href);

const argv = process.argv.slice(2);
let layer = 0, out = null;
const roots = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--layer') layer = Number(argv[++i]);
  else if (argv[i] === '--out') out = argv[++i];
  else roots.push(argv[i]);
}
if (!roots.length || !out) {
  console.error('usage: node Scripts/qdc_points.mjs --layer 0 --out points.json <folder> [<folder> ...]');
  process.exit(2);
}

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.qdc')) acc.push(p);
  }
  return acc;
}
const paths = [];
for (const r of roots) {
  if (!fs.existsSync(r)) { console.error(`no such folder: ${r}`); process.exit(2); }
  walk(r, paths).sort();
}
// A File-shaped view over a file on disk: the three things parseQDCFolder reads.
const asFile = (p) => {
  const buf = fs.readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const view = (a) => ({ size: a.byteLength, arrayBuffer: async () => a, slice: (s, e) => view(a.slice(s, e)) });
  return { name: path.basename(p), ...view(ab) };
};
const files = paths.map(asFile);
let pts = [];
try {
  pts = await parseQDCFolder(files, layer);
} catch (e) {
  // "No valid QDC files found for this layer" is an answer, not a crash: say it and write nothing.
  console.error(`!! ${e.message}`);
  process.exit(1);
}
const rows = pts.map((p) => [+p.lon.toFixed(7), +p.lat.toFixed(7), +p.depth.toFixed(2)]);
fs.writeFileSync(out, JSON.stringify(rows));
let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
for (const [x, y] of rows) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
const sizes = new Set([372736, 352256, 110592, 90112]);
console.log(`${paths.length} .qdc file(s) seen, ${files.filter((f) => sizes.has(f.size)).length} of a Quickdraw size; `
  + `layer ${layer}: ${rows.length} soundings`
  + (rows.length ? `, lon ${w.toFixed(5)}..${e.toFixed(5)} lat ${s.toFixed(5)}..${n.toFixed(5)}` : ''));
