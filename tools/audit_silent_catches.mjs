#!/usr/bin/env node
// Audit every `catch` block in the repo and classify what it does when it fires.
//
// Why this exists as a tool rather than a one-off grep: the refactor plan quoted "91 silent
// Worker catches". A strict count found 37. Neither number could be reproduced because
// neither was produced by anything you could run again. This can be run again.
//
//   node tools/audit_silent_catches.mjs              # summary + the SILENT list
//   node tools/audit_silent_catches.mjs --all        # every catch, with its class
//   node tools/audit_silent_catches.mjs --json       # machine-readable
//   node tools/audit_silent_catches.mjs --dir Worker # restrict the scan root
//
// Exit code is 1 if any SILENT catches remain, so it can gate a commit.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'vendor',
  '.wrangler', 'researchdocs', 'chartpacks', 'registry',
]);

// Files that are generated or bundled -- their catches belong to their source, not here.
const SKIP_FILE = /(\.min\.js$|\.bundle\.js$|-bundle\.js$)/;

/**
 * Strip strings, template literals, regex literals and comments to a same-length blank mask,
 * so brace matching can't be fooled by a `}` inside a string. Returns { code, comments }
 * where `code` has non-code spans blanked and `comments` keeps only comment text (used to
 * find the `Audited` marker, which lives in comments).
 */
function mask(src) {
  const n = src.length;
  const code = src.split('');
  const comments = new Array(n).fill(' ');

  // One flat loop with an explicit mode. Every branch advances `i` unconditionally, which is
  // the whole point: an earlier version nested the template-literal scan inside the main loop
  // and could re-enter the same index forever on `` `${x}` `` -- it hung the audit rather
  // than reporting anything, which is a worse failure than a wrong count.
  const TPL = 't'; // inside a template literal's text
  let mode = null;
  let quote = '';
  const stack = []; // for each open `${`, the brace depth within it; TPL marks a literal body
  // Regex vs division: a `/` can only start a regex when the previous significant character
  // is not an identifier, number, `)` or `]`.
  let prevSig = '';
  let i = 0;

  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';

    if (mode === 'line') {
      comments[i] = c;
      if (c === '\n') mode = null; else code[i] = ' ';
      i++; continue;
    }
    if (mode === 'block') {
      comments[i] = c;
      if (c !== '\n') code[i] = ' ';
      if (c === '*' && d === '/') { comments[i + 1] = '/'; code[i + 1] = ' '; mode = null; i += 2; continue; }
      i++; continue;
    }
    if (mode === 'str') {
      if (c === '\\') { code[i] = ' '; if (i + 1 < n) code[i + 1] = ' '; i += 2; continue; }
      if (c === quote) { mode = null; prevSig = 'x'; i++; continue; }
      if (c !== '\n') code[i] = ' ';
      i++; continue;
    }
    if (mode === 'regex') {
      if (c === '\\') { code[i] = ' '; if (i + 1 < n) code[i + 1] = ' '; i += 2; continue; }
      if (c === '\n') { mode = null; i++; continue; } // unterminated -- it was division
      if (c === '[') quote = '['; // inside a character class, `/` is literal
      else if (c === ']') quote = '';
      else if (c === '/' && quote !== '[') { code[i] = ' '; mode = null; prevSig = 'x'; i++; continue; }
      code[i] = ' ';
      i++; continue;
    }
    if (mode === TPL) {
      if (c === '\\') { code[i] = ' '; if (i + 1 < n) code[i + 1] = ' '; i += 2; continue; }
      if (c === '`') { stack.pop(); mode = stack.length ? (stack[stack.length - 1] === TPL ? TPL : null) : null; prevSig = 'x'; i++; continue; }
      if (c === '$' && d === '{') { stack.push(0); mode = null; prevSig = '{'; i += 2; continue; }
      if (c !== '\n') code[i] = ' ';
      i++; continue;
    }

    // ── live code ──
    if (c === '/' && d === '/') { mode = 'line'; continue; }
    if (c === '/' && d === '*') { mode = 'block'; continue; }
    if (c === '"' || c === "'") { mode = 'str'; quote = c; i++; continue; }
    if (c === '`') { stack.push(TPL); mode = TPL; i++; continue; }
    if (c === '/' && !'x)]'.includes(prevSig)) { mode = 'regex'; quote = ''; code[i] = ' '; i++; continue; }
    if (stack.length && stack[stack.length - 1] !== TPL) {
      // Inside a `${ }`: track braces so the closing one returns us to the literal body.
      if (c === '{') stack[stack.length - 1]++;
      else if (c === '}') {
        if (stack[stack.length - 1] === 0) {
          stack.pop();
          mode = stack.length && stack[stack.length - 1] === TPL ? TPL : null;
          i++; continue;
        }
        stack[stack.length - 1]--;
      }
    }
    if (!/\s/.test(c)) prevSig = /[A-Za-z0-9_$)\]]/.test(c) ? 'x' : c;
    i++;
  }
  return { code: code.join(''), comments: comments.join('') };
}

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) if (src[i] === '\n') line++;
  return line;
}

const LOG_CALL = /\bconsole\s*\.\s*(?:log|warn|error|info|debug|trace)\s*\(/;
const RETHROW = /\bthrow\b/;
const AUDITED = /Audited \d{4}-\d{2}-\d{2}/;
// The failure is written somewhere a person or the caller can still see it: pushed onto a
// log array, counted, or assembled into the returned payload. The first cut of this only
// matched identifiers containing "error"/"fail", which mis-filed `queryLog.push(...)` as
// silent. What matters is whether the caught value escapes the block, not its variable name.
const ESCAPES = (binding) => {
  if (!binding) return /\bnull\b(?!)/; // no binding -> the error cannot escape by definition
  const b = binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${b}\\b`);
};
const RECORDS = /(?:\.push\s*\(|\+\+|\+=\s*1\b)/;
// The body substitutes a fixed fallback and nothing else -- `return null`, `body = {}`,
// `return []`, `return out`. Benign in isolation, but it is the shape that hides real
// failures, so it gets its own class instead of being lumped in with a truly empty block.
const DEFAULT_ONLY = /^[\s;]*(?:(?:return|break|continue)\b[^;]*;?|[\w.$[\]]+\s*=\s*(?:\{\s*\}|\[\s*\]|null|undefined|false|true|0|''|""|`\s*`)\s*;?)?[\s;]*$/;

function classify(bodySrc, bodyComments, binding) {
  if (AUDITED.test(bodyComments)) return 'ANNOTATED';
  if (RETHROW.test(bodySrc)) return 'RETHROW';
  if (LOG_CALL.test(bodySrc)) return 'LOGGED';
  // Does the caught error itself leave the block -- into a Response, a returned object, a
  // pushed string? Then the failure is reported, just not to the console.
  if (binding && ESCAPES(binding).test(bodySrc)) return 'REPORTS';
  if (RECORDS.test(bodySrc)) return 'RECORDS';
  if (!bodySrc.trim()) return 'SWALLOWS';
  if (DEFAULT_ONLY.test(bodySrc)) return 'DEFAULTS';
  return 'SWALLOWS';
}

function scanFile(abs) {
  const src = readFileSync(abs, 'utf8');
  const { code, comments } = mask(src);
  const out = [];
  const re = /\bcatch\b/g;
  let m;
  while ((m = re.exec(code))) {
    // Walk to the opening brace of the block, skipping the optional (binding).
    let i = m.index + 5;
    while (i < code.length && /\s/.test(code[i])) i++;
    let binding = null;
    if (code[i] === '(') {
      const start = i + 1;
      let depth = 1; i++;
      while (i < code.length && depth) { if (code[i] === '(') depth++; else if (code[i] === ')') depth--; i++; }
      binding = src.slice(start, i - 1).trim();
      while (i < code.length && /\s/.test(code[i])) i++;
    }
    if (code[i] !== '{') continue; // not a catch clause (e.g. `.catch` handled elsewhere)
    const bodyStart = i + 1;
    let depth = 1; i++;
    while (i < code.length && depth) { if (code[i] === '{') depth++; else if (code[i] === '}') depth--; i++; }
    const bodyEnd = i - 1;

    // The explanatory comment often sits just ABOVE the `try`, not inside the body. Look
    // back up to 6 lines from the catch keyword as well.
    let back = m.index;
    for (let k = 0, seen = 0; back > 0 && seen < 6; back--, k++) if (src[back] === '\n') seen++;

    out.push({
      line: lineOf(src, m.index),
      binding,
      body: src.slice(bodyStart, bodyEnd),
      cls: classify(src.slice(bodyStart, bodyEnd), comments.slice(back, bodyEnd), binding),
    });
  }
  return out;
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

// ── main ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const showAll = argv.includes('--all');
const asJson = argv.includes('--json');
const dirArg = argv.indexOf('--dir');
const scanRoot = dirArg >= 0 ? join(ROOT, argv[dirArg + 1]) : ROOT;

const rows = [];
for (const abs of walk(scanRoot)) {
  const rel = relative(ROOT, abs).split(sep).join('/');
  if (rel.startsWith('test/')) continue; // tests catch on purpose
  for (const c of scanFile(abs)) rows.push({ file: rel, ...c });
}

const counts = rows.reduce((a, r) => (a[r.cls] = (a[r.cls] || 0) + 1, a), {});
// SWALLOWS is the only class that is unambiguously a defect: the error is discarded and
// nothing downstream can tell the difference between failure and an empty result.
const silent = rows.filter((r) => r.cls === 'SWALLOWS');

if (asJson) {
  console.log(JSON.stringify({ counts, total: rows.length, rows: showAll ? rows : silent }, null, 2));
} else {
  const order = ['SWALLOWS', 'DEFAULTS', 'ANNOTATED', 'REPORTS', 'RECORDS', 'LOGGED', 'RETHROW'];
  console.log(`${rows.length} catch blocks under ${relative(ROOT, scanRoot) || '.'}`);
  for (const k of order) if (counts[k]) console.log(`  ${k.padEnd(10)} ${String(counts[k]).padStart(4)}`);
  const list = showAll ? rows : silent;
  if (list.length) {
    console.log(`\n${showAll ? 'All catches' : 'SWALLOWS (error discarded, nothing reported)'}:`);
    let lastFile = '';
    for (const r of list) {
      if (r.file !== lastFile) { console.log(`\n  ${r.file}`); lastFile = r.file; }
      const one = r.body.replace(/\s+/g, ' ').trim().slice(0, 68) || '(empty)';
      console.log(`    ${String(r.line).padStart(5)}  ${showAll ? r.cls.padEnd(10) : ''}${one}`);
    }
  }
}

process.exit(silent.length ? 1 : 0);
