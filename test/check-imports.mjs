/**
 * check-imports.mjs — every named import across js/ must resolve to a real export.
 *
 *     node test/check-imports.mjs        (or: npm run lint:imports)
 *
 * Written 2026-08-02 after deleting `LURE_DIVE_DEPTHS` from spread-builder.js
 * without noticing that smart-plan-ui.js imported it. The app died on load with
 * "does not provide an export named 'LURE_DIVE_DEPTHS'".
 *
 * The tackle parity checks could never have caught that: they assert the DATA
 * agrees with itself, and this is the module graph disagreeing with itself. Two
 * different failure classes, two different checks.
 *
 * Static on purpose — it reads the source rather than importing it, so modules
 * that touch `document` at load time are still checked.
 *
 * Exits 1 on any unresolved import.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Worker/ was outside this check until 2026-08-03. research/limnology.js imports
// LAKE_NAME_TO_R2_KEY from ../../js/data/lake-keys.js -- a Cloudflare Worker reaching across
// the deploy boundary into the front-end tree -- so a rename in js/data/ can break the Worker
// build, and nothing was watching that edge.
// test/ was outside this check until 2026-08-07, and that gap is why
// depth-palette.test.js imported four symbols tide-engine.js has never exported and
// `lint:imports` still reported PASS. A test file is the one place a broken import is
// SUPPOSED to be caught, and it was the one directory nothing looked at.
const SCAN = ['js', 'Worker', 'test'];

/**
 * Comments blanked, newlines kept.
 *
 * Added 2026-08-07 in the same breath as scanning test/, because the very first run over this
 * directory failed on THIS FILE: the header below documents the shape it matches with
 * `// import { a, b as c } from './x.js'`, and the scanner dutifully reported an unresolved
 * import from a file that has never existed. A checker that cannot tell code from prose
 * eventually reports its own examples — the same trap persistence.test.js fell into against
 * its own changelog.
 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'node_modules' || e.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.js') || e.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/** Named exports a module provides, including `export { x } from './y.js'`. */
function exportsOf(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  if (!existsSync(file)) return null;
  const src = code(readFileSync(file, 'utf8'));
  const names = new Set();

  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // export { a, b as c }  /  export { a } from './x.js'
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      names.add((t.split(/\s+as\s+/).pop() || t).trim());
    }
  }
  // export * from './x.js'
  for (const m of src.matchAll(/^\s*export\s*\*\s*from\s*['"]([^'"]+)['"]/gm)) {
    const target = resolve(dirname(file), m[1]);
    const sub = exportsOf(target, seen);
    if (sub) for (const n of sub) names.add(n);
  }
  if (/^\s*export\s+default\b/m.test(src)) names.add('default');
  return names;
}

const files = SCAN.flatMap(d => (existsSync(join(ROOT, d)) ? walk(join(ROOT, d)) : []));
const problems = [];
let checked = 0;

for (const file of files) {
  const src = code(readFileSync(file, 'utf8'));
  // import { a, b as c } from './x.js'   (relative specifiers only — bare ones are deps)
  //
  // ANCHORED, and that is the whole point. The same trap the `code()` header above describes
  // sprang a second time on 2026-08-25, one quoting style over: blanking comments does nothing
  // about a STRING, and coastal-regulations-live.test.js asserts on the text of an import —
  //
  //     expect(src).toContain("import { liveCoastalPolicyFor } from './regulations-live.js'");
  //
  // Unanchored, that scored as an import of `test/regulations-live.js`, which has never
  // existed. The real import three hundred lines above it is `../js/data/regulations-live.js`
  // and resolves fine. So `lint:audit` reported an unresolved import, `npm run check` went red,
  // and the defect was entirely in the instrument.
  //
  // A real `import` is a statement and lives at the start of its line. The three export
  // patterns above have always been written `^\s*…/gm`; this one never was. It is now.
  for (const m of src.matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/gm)) {
    const target = resolve(dirname(file), m[2]);
    const provided = exportsOf(target);
    const rel = relative(ROOT, file);
    if (provided === null) {
      problems.push(`${rel}\n      imports from ${m[2]} — FILE DOES NOT EXIST`);
      continue;
    }
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const wanted = t.split(/\s+as\s+/)[0].trim();
      checked++;
      if (!provided.has(wanted)) {
        problems.push(`${rel}\n      imports { ${wanted} } from ${m[2]} — NOT EXPORTED`);
      }
    }
  }
}

console.log(`\nimport graph — ${files.length} files, ${checked} named imports\n`);
if (problems.length) {
  for (const p of problems) console.error(`  FAIL  ${p}`);
  console.error(`\n${problems.length} unresolved import(s)\n`);
  process.exit(1);
}
console.log('  ok    every named import resolves\n');
