#!/usr/bin/env node
/**
 * tools/audit.mjs — generate the map of this codebase, from the codebase.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS EXISTS
 *
 * 2026-08-06, Ryan: "this thing has gotten so big neither you or i know what is in it or how
 * it works anymore."
 *
 * That is measurable, and it was measured the hard way. In one session four confident claims
 * were made about this repo with the whole tree readable, and all four were wrong:
 *
 *   - "Georgia attractors render nothing"      -- they render; a static file was feeding them
 *   - "utils/solunar.js has no importers"      -- smart-plan.js:31 and plan-builder.js:28
 *   - "worker auth is untouched"               -- gated at the router via MUTATING_ROUTES
 *   - "no cameras in SC/NC/GA/TN"              -- 52 of them
 *
 * Each came from a grep that answered a narrower question than the one being asked. The fix is
 * not to grep more carefully. It is to stop asking the tree questions one grep at a time.
 *
 * WHY GENERATED AND NOT WRITTEN
 *
 * DELETION_TAB.md was RIGHT about solunar and was contradicted anyway, because nobody read it
 * at the moment of the decision. A written map decays silently; 114 project docs are as hard to
 * hold in your head as the code they describe. This file is regenerated from source every run,
 * so it cannot drift from what is actually there. If it is wrong, the code changed and the
 * audit is stale by exactly one command.
 *
 * WHAT IT WILL NOT DO
 *
 * It is regex over source, not a type-aware AST pass. It reports what it can see and labels
 * confidence. A binding referenced only through a computed property, a string built at runtime,
 * or a dynamic import will read as dead here and may not be. Every "unused" finding is a
 * QUESTION, not a verdict -- see the lakes.js near miss in DELETION_TAB.md, where "no
 * production JS imports it" was true and "nothing depends on it" was false, because the
 * dependency ran through Python.
 *
 * RUN
 *     node tools/audit.mjs                 # writes AUDIT.md + audit.json, prints a summary
 *     node tools/audit.mjs --check         # non-zero exit if new dead code appeared
 *     node tools/audit.mjs --what ramps    # what touches "ramps"? files, routes, feeds, keys
 */

import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const ARGS = process.argv.slice(2);
const WHAT = ARGS.includes('--what') ? ARGS[ARGS.indexOf('--what') + 1] : null;
const CHECK = ARGS.includes('--check');

const SCAN_DIRS = ['js', 'Worker', 'Scripts', 'test', 'tools'];
const SCAN_FILES = ['index.html', 'sw.js'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'researchdocs', '_to_delete', '__pycache__']);

// ── file walk ────────────────────────────────────────────────────────────────────────────────

function walk(p, out = []) {
  if (!fs.existsSync(p)) return out;
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(p))) return out;
    for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e), out);
    return out;
  }
  if (/\.(m?js|py|html|toml)$/.test(p)) out.push(path.relative(ROOT, p).replace(/\\/g, '/'));
  return out;
}

const FILES = [...SCAN_DIRS.flatMap(d => walk(path.join(ROOT, d))),
               ...SCAN_FILES.filter(f => fs.existsSync(path.join(ROOT, f)))]
  .filter((v, i, a) => a.indexOf(v) === i).sort();

const SRC = Object.fromEntries(FILES.map(f => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

/** Strip line comments and block comments so a match in prose is not mistaken for code. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}
const CODE = Object.fromEntries(FILES.map(f => [f, stripComments(SRC[f])]));

/** First sentence of a file's leading comment -- "what is this for". */
function purpose(src) {
  const m = src.match(/^\s*(?:#!.*\n)?\s*(?:\/\*\*?([\s\S]*?)\*\/|"""([\s\S]*?)"""|((?:\s*(?:\/\/|#)[^\n]*\n)+))/);
  if (!m) return '';
  const body = (m[1] || m[2] || m[3] || '')
    .split('\n').map(l => l.replace(/^\s*(\*|\/\/|#)\s?/, '').trim())
    .filter(Boolean);
  const firstReal = body.find(l => l.length > 12 && !/^[-=*_]{3,}$/.test(l)) || body[0] || '';
  return firstReal.replace(/\s+/g, ' ').slice(0, 160);
}

// ── JS modules: exports, imports, reverse index ──────────────────────────────────────────────

const modules = {};
for (const f of FILES.filter(f => /\.m?js$/.test(f))) {
  const code = CODE[f];
  const exports = new Set();
  for (const m of code.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) exports.add(m[1]);
  for (const m of code.matchAll(/export\s*\{([^}]+)\}/g))
    m[1].split(',').forEach(s => { const n = s.trim().split(/\s+as\s+/).pop().trim(); if (n) exports.add(n); });
  if (/export\s+default/.test(code)) exports.add('default');

  const imports = [];
  // ANCHORED. Unanchored, this matched the word `import` inside a STRING and scored the quoted
  // path after it as a real dependency. coastal-regulations-live.test.js asserts on the text of
  // an import statement, and that one assertion put `test/regulations-live.js` — a file that has
  // never existed — into `missingImports`, which is what `--check` exits non-zero on. Reported
  // 2026-08-25, together with the same defect in test/check-imports.mjs, which had already been
  // bitten once by the comment-shaped version of it and carries the note.
  //
  // An `import` statement lives at the start of its line. A quoted one does not.
  for (const m of code.matchAll(/^\s*import\s+(?:([\w$*\s{},]+?)\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    const names = (m[1] || '').replace(/[{}]/g, ' ').split(',')
      .map(s => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean);
    imports.push({ from: m[2], names });
  }
  for (const m of code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) imports.push({ from: m[1], names: ['*dynamic*'], dynamic: true });

  // RE-EXPORTS ARE IMPORTS. `export { a, b } from './x.js'` and `export * from './x.js'` are how
  // this codebase builds its barrels -- worker-research.js re-exports eleven modules and
  // lake-research.js re-exports the 1,851-line UI. Missing this form reported four live files
  // as orphans, which is the exact false confidence this tool exists to remove.
  for (const m of code.matchAll(/export\s*(?:\*|\{([^}]*)\})\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = m[1]
      ? m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
      : ['*'];
    imports.push({ from: m[2], names, reexport: true });
    // The re-exported names are also exports of THIS module.
    (m[1] ? m[1].split(',') : []).forEach(s => {
      const n = s.trim().split(/\s+as\s+/).pop().trim();
      if (n) exports.add(n);
    });
  }

  modules[f] = {
    purpose: purpose(SRC[f]),
    lines: SRC[f].split('\n').length,
    exports: [...exports],
    imports,
    importedBy: [],
    deadExports: [],
    globalsWritten: [...new Set([...code.matchAll(/window\.(_[\w$]+|[A-Z][\w$]*)\s*=/g)].map(m => m[1]))],
    globalsRead: [...new Set([...code.matchAll(/window\.(_[\w$]+)\b(?!\s*=)/g)].map(m => m[1]))],
  };
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  let p = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  for (const cand of [p, p + '.js', p + '.mjs', p + '/index.js']) if (modules[cand]) return cand;
  return p; // unresolved -- reported below
}

const missingImports = [];
for (const [f, m] of Object.entries(modules)) {
  for (const imp of m.imports) {
    const target = resolveImport(f, imp.from);
    if (!target) continue;                       // bare specifier / CDN
    if (!modules[target]) { missingImports.push({ file: f, spec: imp.from, resolved: target }); continue; }
    imp.resolved = target;
    modules[target].importedBy.push({ file: f, names: imp.names });
  }
}

// A binding is dead when nothing imports it BY NAME and no HTML references it.
const htmlBlob = FILES.filter(f => f.endsWith('.html')).map(f => CODE[f]).join('\n');
for (const [f, m] of Object.entries(modules)) {
  const importedNames = new Set(m.importedBy.flatMap(i => i.names));
  m.deadExports = m.exports.filter(n =>
    !importedNames.has(n) && !importedNames.has('*dynamic*') &&
    !new RegExp(`\\b${n.replace(/[$]/g, '\\$')}\\b`).test(htmlBlob));
}

// ── Worker routes ────────────────────────────────────────────────────────────────────────────

const workerFiles = FILES.filter(f => f.startsWith('Worker/'));
const routerSrc = SRC['Worker/trollmap-worker.js'] || '';
const mutatingList = (() => {
  const m = routerSrc.match(/const\s+MUTATING_ROUTES\s*=\s*\[([\s\S]*?)\]/);
  return m ? [...m[1].matchAll(/["']([^"']+)["']/g)].map(x => x[1]) : [];
})();

// AUTH IS NOT ONLY THE MUTATING_ROUTES LIST. `/sync/*` is gated by an enclosing
// `if (path.startsWith("/sync")) { if (!await isAuthorized(...)) return 401; ... }`, and the
// chartpack and contour uploads by an inline check. Reading membership in MUTATING_ROUTES alone
// reported `POST /sync/migrate` and `DELETE /sync/purge-type/*` as open, which would have sent
// someone hunting a hole that is not there -- the same false alarm this tool exists to stop.
const gatedPrefixes = [];
for (const f of workerFiles) {
  for (const m of CODE[f].matchAll(/if\s*\(\s*path\.startsWith\(\s*["']([^"']+)["']\s*\)\s*\)\s*\{/g)) {
    if (/isAuthorized\s*\(/.test(CODE[f].slice(m.index, m.index + 600))) gatedPrefixes.push(m[1]);
  }
}

const routes = [];
for (const f of workerFiles) {
  const code = CODE[f];
  for (const m of code.matchAll(/path\s*===\s*["']([^"']+)["']|path\.startsWith\(\s*["']([^"']+)["']/g)) {
    const route = m[1] || m[2];
    const at = m.index;
    const ln = lineOf(code, at);
    const tail = code.slice(at, at + 260);
    const method = (tail.match(/request\.method\s*===\s*["'](\w+)["']/) || [])[1] || 'ANY';
    // outbound hosts inside this route's rough block
    const block = code.slice(at, at + 3000);
    const hosts = [...new Set([...block.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map(x => x[1].toLowerCase()))];
    const r2 = [...new Set([...block.matchAll(/env\.(R2_[A-Z0-9_]+)\.(get|put|list|delete|head)\(/g)].map(x => `${x[1]}.${x[2]}`))];
    const existing = routes.find(x => x.route === route && x.file === f && x.method === method);
    if (existing) continue;
    routes.push({
      route, file: f, line: ln, method,
      auth: mutatingList.includes(route) ? 'REQUIRED (list)'
          : gatedPrefixes.some(p => route.startsWith(p)) ? 'REQUIRED (prefix)'
          : /isAuthorized\s*\(/.test(block) ? 'REQUIRED (inline)'
          : 'open',
      fetches: hosts.filter(h => !h.includes('example')),
      r2: r2,
      calledFrom: [],
    });
  }
}
// Who calls each route from the front end?
//
// The first version of this required the route to sit immediately after a quote, which is
// almost never how this codebase writes them -- `fetch(`${CF_WORKER_URL}/research/save`)` puts
// a `}` there. It reported 55 of 62 routes as uncalled, which was nonsense, and it was caught
// only because the number was too bad to believe. Match the path anywhere, and use a negative
// lookahead so `/research/save` does not also claim `/research/save-normalized`.
// A route with no browser caller is NOT necessarily dead: several are operator endpoints the
// pipeline scripts hit (r2_audit.py reads /chartpacks/list) or that get curled by hand. Search
// the Python side too and label which it is, so "nothing calls this" means nothing at all.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const r of routes) {
  const re = new RegExp(esc(r.route) + '(?![\\w-])');
  for (const f of FILES.filter(f => f.startsWith('js/') || f.endsWith('.html'))) {
    if (re.test(CODE[f])) r.calledFrom.push(f);
  }
  r.calledFromTooling = FILES
    .filter(f => f.startsWith('Scripts/') || f.startsWith('tools/') || f.startsWith('test/'))
    .filter(f => re.test(CODE[f]));
}

// ── external feeds ───────────────────────────────────────────────────────────────────────────

const feeds = {};
for (const f of FILES) {
  for (const m of CODE[f].matchAll(/https?:\/\/([a-z0-9.-]+)([^\s"'`)]*)/gi)) {
    const host = m[1].toLowerCase();
    if (/^(www\.)?(w3|example)\./.test(host)) continue;
    feeds[host] ??= { host, hits: 0, files: new Set(), side: new Set() };
    feeds[host].hits++;
    feeds[host].files.add(`${f}:${lineOf(CODE[f], m.index)}`);
    feeds[host].side.add(f.startsWith('Worker/') ? 'worker' : f.startsWith('Scripts/') ? 'pipeline' : 'browser');
  }
}

// ── R2 keys ──────────────────────────────────────────────────────────────────────────────────

const r2ops = [];
for (const f of workerFiles.concat(FILES.filter(f => f.startsWith('Scripts/')))) {
  for (const m of CODE[f].matchAll(/env\.(R2_[A-Z0-9_]+)\.(get|put|list|delete|head)\(\s*([^,)]{0,90})/g))
    r2ops.push({ file: f, line: lineOf(CODE[f], m.index), binding: m[1], op: m[2], key: m[3].trim().replace(/\s+/g, ' ') });
}

// ── data files: who reads what ───────────────────────────────────────────────────────────────

const dataRefs = {};
for (const f of FILES) {
  for (const m of CODE[f].matchAll(/['"`]([^'"`]*\b(?:data|registry)\/[A-Za-z0-9_.\-${}]+\.(?:json|geojson|csv|txt))['"`]/g)) {
    const key = m[1].replace(/^\.\//, '');
    dataRefs[key] ??= [];
    dataRefs[key].push(`${f}:${lineOf(CODE[f], m.index)}`);
  }
}

// ── python scripts ───────────────────────────────────────────────────────────────────────────

const pyScripts = FILES.filter(f => f.endsWith('.py')).map(f => ({
  file: f,
  purpose: purpose(SRC[f]),
  flags: [...new Set([...CODE[f].matchAll(/add_argument\(\s*["'](--?[\w-]+)["']/g)].map(m => m[1]))],
  reads: [...new Set([...CODE[f].matchAll(/(?:open|read_text|load)\(\s*[^)]*?["']([^"']*\.(?:json|geojson|csv|txt))["']/g)].map(m => m[1]))].slice(0, 8),
}));

// ── duplicate function names across files ────────────────────────────────────────────────────

const fnIndex = {};
for (const f of FILES.filter(f => /\.m?js$/.test(f))) {
  for (const m of CODE[f].matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    fnIndex[m[1]] ??= [];
    fnIndex[m[1]].push(`${f}:${lineOf(CODE[f], m.index)}`);
  }
}
const dupFns = Object.entries(fnIndex).filter(([, v]) => v.length > 1)
  .map(([name, at]) => ({ name, at })).sort((a, b) => b.at.length - a.at.length);

// ── cross-module globals ─────────────────────────────────────────────────────────────────────

const globals = {};
for (const [f, m] of Object.entries(modules)) {
  for (const g of m.globalsWritten) { globals[g] ??= { written: [], read: [] }; globals[g].written.push(f); }
  for (const g of m.globalsRead)    { globals[g] ??= { written: [], read: [] }; globals[g].read.push(f); }
}

// ── --what: one question, every layer ────────────────────────────────────────────────────────

if (WHAT) {
  const q = WHAT.toLowerCase();
  const hit = (s) => String(s).toLowerCase().includes(q);
  console.log(`\n=== what touches "${WHAT}" ===\n`);
  const fileHits = FILES.filter(f => hit(f) || hit(CODE[f]));
  console.log(`FILES (${fileHits.length})`);
  for (const f of fileHits.slice(0, 40)) {
    const n = [...CODE[f].matchAll(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'))].length;
    console.log(`  ${f}  (${n} mention${n === 1 ? '' : 's'})${modules[f]?.purpose ? ' — ' + modules[f].purpose.slice(0, 70) : ''}`);
  }
  const rh = routes.filter(r => hit(r.route));
  if (rh.length) { console.log(`\nROUTES (${rh.length})`); rh.forEach(r => console.log(`  ${r.method.padEnd(4)} ${r.route.padEnd(34)} auth=${r.auth}  ${r.file}:${r.line}  called from ${r.calledFrom.length} file(s)`)); }
  const fh = Object.values(feeds).filter(x => hit(x.host));
  if (fh.length) { console.log(`\nFEEDS (${fh.length})`); fh.forEach(x => console.log(`  ${x.host}  [${[...x.side].join(',')}]  ${x.hits} ref(s)`)); }
  const dh = Object.entries(dataRefs).filter(([k]) => hit(k));
  if (dh.length) { console.log(`\nDATA FILES (${dh.length})`); dh.forEach(([k, v]) => console.log(`  ${k}\n      read by: ${v.join(', ')}`)); }
  const kh = r2ops.filter(o => hit(o.key));
  if (kh.length) { console.log(`\nR2 (${kh.length})`); kh.forEach(o => console.log(`  ${o.op.toUpperCase().padEnd(6)} ${o.key}   ${o.file}:${o.line}`)); }
  console.log('');
  process.exit(0);
}

// ── report ───────────────────────────────────────────────────────────────────────────────────

const orphanModules = Object.entries(modules)
  .filter(([f, m]) => m.importedBy.length === 0 && !f.endsWith('.html')
    && !/^(js\/main\.js|js\/lazy-data\.js|test\/|tools\/|Worker\/trollmap-worker\.js)/.test(f)
    && !new RegExp(`["'\`][^"'\`]*${path.basename(f)}`).test(htmlBlob))
  .map(([f, m]) => ({ file: f, lines: m.lines, exports: m.exports.length }));

const uncalledRoutes = routes.filter(r => r.calledFrom.length === 0 && (r.calledFromTooling || []).length === 0);
const openMutating = routes.filter(r => r.method !== 'GET' && r.method !== 'ANY' && r.auth === 'open');
const deadExportCount = Object.values(modules).reduce((a, m) => a + m.deadExports.length, 0);
const orphanData = Object.entries(dataRefs).filter(([, v]) => v.length === 0);

const summary = {
  files: FILES.length,
  jsModules: Object.keys(modules).length,
  pyScripts: pyScripts.length,
  routes: routes.length,
  routesUncalled: uncalledRoutes.length,
  routesMutatingUngated: openMutating.length,
  feeds: Object.keys(feeds).length,
  deadExports: deadExportCount,
  orphanModules: orphanModules.length,
  duplicateFnNames: dupFns.length,
  crossModuleGlobals: Object.keys(globals).length,
  unresolvedImports: missingImports.length,
};

const md = [];
const P = (s = '') => md.push(s);

P('# TrollMap audit — GENERATED, do not edit');
P('');
P('Regenerate with `node tools/audit.mjs`. Written by `tools/audit.mjs` from source, so it');
P('cannot drift from the tree. If something here is wrong, the code changed.');
P('');
P('Every "unused" finding below is a QUESTION, not a verdict. This is regex over source, not a');
P('type-aware pass — a binding reached through a computed name, a runtime-built string, or the');
P('Python side will read as dead here and may not be. See the `lakes.js` near miss in');
P('`DELETION_TAB.md`: "no production JS imports it" was true, "nothing depends on it" was false.');
P('');
P('## Summary');
P('');
P('| metric | count |');
P('|---|---|');
for (const [k, v] of Object.entries(summary)) P(`| ${k} | ${v} |`);
P('');

P('## Worker routes');
P('');
P('| route | method | auth | fetches | R2 | called from |');
P('|---|---|---|---|---|---|');
for (const r of routes.sort((a, b) => a.route.localeCompare(b.route))) {
  P(`| \`${r.route}\` | ${r.method} | ${r.auth.startsWith('REQUIRED') ? '**' + r.auth + '**' : 'open'} | ${r.fetches.slice(0, 3).join('<br>') || '—'} | ${r.r2.join('<br>') || '—'} | ${r.calledFrom.length ? r.calledFrom.map(f => f.split('/').pop()).join('<br>') : '**nothing**'} |`);
}
P('');

if (openMutating.length) {
  P('### Non-GET routes not in MUTATING_ROUTES');
  P('');
  P('Read-shaped POSTs (LLM proxies, search) are deliberately open — see the comment above');
  P('`MUTATING_ROUTES`. Anything here that WRITES is a hole.');
  P('');
  for (const r of openMutating) P(`- \`${r.method} ${r.route}\` — ${r.file}:${r.line}`);
  P('');
}

P('## Routes nothing calls');
P('');
P(uncalledRoutes.length ? uncalledRoutes.map(r => `- \`${r.route}\` (${r.file}:${r.line})`).join('\n') : '_none_');
P('');

P('## External feeds');
P('');
P('| host | side | refs | first seen |');
P('|---|---|---|---|');
for (const x of Object.values(feeds).sort((a, b) => b.hits - a.hits))
  P(`| ${x.host} | ${[...x.side].join(', ')} | ${x.hits} | ${[...x.files][0]} |`);
P('');

P('## R2 key shapes');
P('');
P('| op | key expression | where |');
P('|---|---|---|');
for (const o of r2ops) P(`| ${o.op} | \`${o.key.slice(0, 70)}\` | ${o.file}:${o.line} |`);
P('');

P('## Data files — who reads them');
P('');
P('| file | read by |');
P('|---|---|');
for (const [k, v] of Object.entries(dataRefs).sort()) P(`| \`${k}\` | ${v.join('<br>')} |`);
P('');

P('## JS modules');
P('');
P('| module | lines | exports | imported by | dead exports | purpose |');
P('|---|---|---|---|---|---|');
for (const [f, m] of Object.entries(modules).sort())
  P(`| \`${f}\` | ${m.lines} | ${m.exports.length} | ${m.importedBy.length} | ${m.deadExports.length ? '**' + m.deadExports.length + '**' : '0'} | ${m.purpose.slice(0, 90)} |`);
P('');

P('### Modules nothing imports');
P('');
P(orphanModules.length ? orphanModules.map(o => `- \`${o.file}\` — ${o.lines} lines, ${o.exports} exports`).join('\n') : '_none_');
P('');

P('### Exported but never imported by name');
P('');
for (const [f, m] of Object.entries(modules)) if (m.deadExports.length) P(`- \`${f}\`: ${m.deadExports.join(', ')}`);
P('');

P('## Same function name in more than one file');
P('');
for (const d of dupFns.slice(0, 40)) P(`- \`${d.name}()\` — ${d.at.join(', ')}`);
P('');

P('## Cross-module state on `window`');
P('');
P('| global | written by | read by |');
P('|---|---|---|');
for (const [g, v] of Object.entries(globals).sort())
  P(`| \`window.${g}\` | ${v.written.join('<br>') || '—'} | ${v.read.join('<br>') || '**nothing**'} |`);
P('');

P('## Pipeline scripts');
P('');
P('| script | flags | purpose |');
P('|---|---|---|');
for (const s of pyScripts) P(`| \`${s.file}\` | ${s.flags.join(' ') || '—'} | ${s.purpose.slice(0, 110)} |`);
P('');

if (missingImports.length) {
  P('## Imports that do not resolve');
  P('');
  for (const m of missingImports) P(`- \`${m.file}\` imports \`${m.spec}\` → \`${m.resolved}\` **(missing)**`);
  P('');
}

fs.writeFileSync(path.join(ROOT, 'AUDIT.md'), md.join('\n'));
fs.writeFileSync(path.join(ROOT, 'audit.json'), JSON.stringify(
  { generatedFrom: 'tools/audit.mjs', summary, routes, modules, feeds: Object.fromEntries(
      Object.entries(feeds).map(([k, v]) => [k, { ...v, files: [...v.files], side: [...v.side] }])),
    r2ops, dataRefs, pyScripts, dupFns, globals, orphanModules, missingImports }, null, 2));

console.log('\n=== TrollMap audit ===');
for (const [k, v] of Object.entries(summary)) console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log('\n  wrote AUDIT.md and audit.json');
if (missingImports.length) {
  console.log('\n  UNRESOLVED IMPORTS (these break a clean checkout):');
  for (const m of missingImports) console.log(`    ${m.file} -> ${m.spec}`);
}
if (openMutating.length) {
  console.log('\n  NON-GET ROUTES NOT IN MUTATING_ROUTES (verify each is read-shaped):');
  for (const r of openMutating) console.log(`    ${r.method} ${r.route}`);
}
console.log('');

if (CHECK && (missingImports.length || openMutating.some(r => /save|delete|store|publish|approve|write/i.test(r.route)))) {
  console.error('audit --check failed: unresolved imports or an ungated write route');
  process.exit(1);
}
