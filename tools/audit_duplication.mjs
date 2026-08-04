#!/usr/bin/env node
// Find duplicated logic across the front end and the Worker.
//
// The point is not a similarity percentage. It is a list you can act on, so that "we still
// have duplication somewhere" stops being a feeling and becomes a number that either goes
// down or does not.
//
//   node tools/audit_duplication.mjs                 # blocks duplicated across files
//   node tools/audit_duplication.mjs --min 6         # minimum block length in lines (default 8)
//   node tools/audit_duplication.mjs --within        # also report repeats inside one file
//   node tools/audit_duplication.mjs --json
//   node tools/audit_duplication.mjs --dir js
//
// Method: normalise each line (strip comments, collapse whitespace, drop string and number
// literals), then hash every window of N consecutive normalised lines and report windows that
// hash the same in more than one place. Literals are dropped on purpose -- two ladders that
// differ only in which variable name they test are the same duplication, and that is exactly
// the pair this tool was written to catch in discover.js.
//
// Exit code is 1 when anything is reported, so it can gate a commit.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'vendor', '.wrangler',
  'researchdocs', 'chartpacks', 'registry', '_to_delete',
]);
const SKIP_FILE = /(\.min\.js$|\.bundle\.js$|-bundle\.js$)/;

// Data tables are SUPPOSED to look repetitive -- a hundred lakes with the same six fields is
// a list, not duplicated logic. Reporting them buries the real findings.
const DATA_FILE = /^js\/data\/|-data\.js$|catalog\.py$/;

/** Reduce a line to its structure: no comments, no literals, no spacing. */
function normalise(line) {
  let s = line;
  s = s.replace(/\/\/.*$/, '');
  s = s.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, 'S'); // string literals -> S
  s = s.replace(/\b\d[\d._eE+-]*\b/g, 'N');         // numbers -> N
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Lines that carry no structure on their own and would create phantom matches. */
function isNoise(s) {
  return !s
    || s.length < 6
    || /^[)}\];,]+$/.test(s)
    || /^(?:else|try|\}|\{|break;|continue;|return;)$/.test(s);
}

/**
 * A line that is just a key mapped to a literal or an empty container.
 *
 * These dominate the raw output and none of them are findings. A response schema listing
 * twenty fields as `null` is identical to the next schema listing twenty fields as `null`
 * once literals are erased -- structurally the same, semantically unrelated, and nothing is
 * saved by "sharing" them. Blocks made mostly of these are dropped so the real duplication
 * is visible rather than buried under agents.js declaring its output shape.
 */
function isLiteralPair(s) {
  return /^S\s*:\s*(?:null|S|N|\[\s*\]|\{\s*\}|true|false)\s*,?$/.test(s)
      || /^S\s*:\s*\[(?:\s*[SN],?)*\s*\]\s*,?$/.test(s);
}
function isDataBlock(rows) {
  const lits = rows.filter((r) => isLiteralPair(r.norm)).length;
  return lits / rows.length >= 0.6;
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, acc);
    else if (/\.(?:js|mjs|cjs)$/.test(name) && !SKIP_FILE.test(name)) acc.push(abs);
  }
  return acc;
}

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const within = argv.includes('--within');
const minIdx = argv.indexOf('--min');
const MIN = minIdx >= 0 ? Number(argv[minIdx + 1]) : 8;
const dirIdx = argv.indexOf('--dir');
const scanRoot = dirIdx >= 0 ? join(ROOT, argv[dirIdx + 1]) : ROOT;

// file -> [{ line, norm }] with noise removed but original line numbers kept
const docs = new Map();
for (const abs of walk(scanRoot)) {
  const rel = relative(ROOT, abs).split(sep).join('/');
  if (rel.startsWith('test/') || rel.startsWith('tools/')) continue;
  if (DATA_FILE.test(rel)) continue;
  const kept = [];
  readFileSync(abs, 'utf8').split('\n').forEach((raw, i) => {
    const n = normalise(raw);
    if (!isNoise(n)) kept.push({ line: i + 1, norm: n });
  });
  if (kept.length >= MIN) docs.set(rel, kept);
}

// hash of an N-line window -> every place it occurs
const index = new Map();
for (const [file, rows] of docs) {
  for (let i = 0; i + MIN <= rows.length; i++) {
    const win = rows.slice(i, i + MIN);
    const h = createHash('sha1').update(win.map((r) => r.norm).join('\n')).digest('hex');
    if (!index.has(h)) index.set(h, []);
    index.get(h).push({ file, start: win[0].line, end: win[MIN - 1].line, rows: win });
  }
}

// Keep only windows that occur more than once, then greedily absorb overlapping windows so a
// 40-line clone is reported once rather than 33 times.
let groups = [...index.values()].filter((g) => g.length > 1);
if (!within) groups = groups.filter((g) => new Set(g.map((o) => o.file)).size > 1);
groups = groups.filter((g) => !isDataBlock(g[0].rows));

groups.sort((a, b) => (b[0].end - b[0].start) - (a[0].end - a[0].start));
const claimed = new Map(); // file -> array of [start,end] already reported
const report = [];
for (const g of groups) {
  const overlaps = g.some((o) =>
    (claimed.get(o.file) || []).some(([s, e]) => o.start <= e && o.end >= s));
  if (overlaps) continue;
  for (const o of g) {
    if (!claimed.has(o.file)) claimed.set(o.file, []);
    claimed.get(o.file).push([o.start, o.end]);
  }
  report.push({
    lines: g[0].end - g[0].start + 1,
    copies: g.length,
    sites: g.map((o) => ({ file: o.file, start: o.start, end: o.end })),
    sample: g[0].rows.slice(0, 3).map((r) => r.norm),
  });
}
report.sort((a, b) => (b.lines * b.copies) - (a.lines * a.copies));

if (asJson) {
  console.log(JSON.stringify({ minBlock: MIN, findings: report.length, report }, null, 2));
} else {
  const dupLines = report.reduce((n, r) => n + r.lines * (r.copies - 1), 0);
  console.log(`${docs.size} files scanned under ${relative(ROOT, scanRoot) || '.'}, blocks of >= ${MIN} lines`);
  console.log(`${report.length} duplicated block(s), ~${dupLines} redundant lines\n`);
  for (const r of report) {
    console.log(`  ${r.lines} lines x ${r.copies} copies`);
    for (const s of r.sites) console.log(`      ${s.file}:${s.start}-${s.end}`);
    console.log(`      | ${r.sample.join('\n      | ')}\n`);
  }
}

process.exit(report.length ? 1 : 0);
