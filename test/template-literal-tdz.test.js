import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_ROOT = path.join(REPO, 'js');

// ---------------------------------------------------------------------------
// Why this test exists
//
// 2026-08-07: SmartPlan died on Wateree with
//
//     ReferenceError: Cannot access 'hazardZones' before initialization
//         at runSmartPlan (smart-plan.js:838)
//
// `hazardZones` was a function-local `const` declared ~375 lines BELOW the
// giant `planPrompt` template literal that interpolated it. Same block, so the
// reference sat in the temporal dead zone and threw the moment the button was
// pressed. `node --check` passes, every import resolves, and no unit test
// touched it, because a TDZ violation is a RUNTIME error in valid syntax.
//
// The prompt builders in this app are 100+ line template literals splicing in
// dozens of locals. Reordering anything above them can push a declaration
// below its use and nothing complains until a human clicks the button.
//
// The check: for every template literal of >= MIN_TEMPLATE_LINES lines, every
// `${identifier}` must not resolve to a `const`/`let`/`var` declared LATER in
// the same block. "Same block" is decided by brace depth, so a name declared
// inside a different callback -- the common false positive, e.g. a loop index
// reused in a later event handler -- is correctly ignored.
// ---------------------------------------------------------------------------

const MIN_TEMPLATE_LINES = 10;
// A `const`/`let`/`var` binding a plain name. Destructuring patterns are
// deliberately not matched -- missing one is a false negative, and this guard
// is only worth having if it never cries wolf.
const DECL = /(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'vendor') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

// Walk the source once, character by character, tracking whether we are in a
// string, comment, regex or template literal. Returns, per line: the brace
// depth at the START of the line, and the template regions.
//
// Depth is counted only OUTSIDE template literals and strings, so the JSON
// examples embedded in the prompt templates -- which are full of braces -- do
// not corrupt it.
function scan(source) {
  const lines = source.split(/\r?\n/);
  const depthBefore = new Array(lines.length).fill(0);
  const regions = [];

  let depth = 0;
  let line = 0;
  let mode = 'code';           // code | line-comment | block-comment | sq | dq | template
  const templateStack = [];    // start line of each open template literal
  let prev = '';

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const n = source[i + 1];

    if (c === '\n') {
      line++;
      if (line < lines.length) depthBefore[line] = depth;
      if (mode === 'line-comment') mode = 'code';
      prev = c;
      continue;
    }

    if (mode === 'line-comment') { prev = c; continue; }

    if (mode === 'block-comment') {
      if (c === '*' && n === '/') { mode = 'code'; i++; }
      prev = c;
      continue;
    }

    if (mode === 'sq' || mode === 'dq') {
      if (c === '\\') { i++; prev = ''; continue; }
      if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"')) mode = 'code';
      prev = c;
      continue;
    }

    if (mode === 'template') {
      if (c === '\\') { i++; prev = ''; continue; }
      if (c === '`') {
        mode = 'code';
        const start = templateStack.pop();
        regions.push({ start, end: line });
      }
      prev = c;
      continue;
    }

    // mode === 'code'
    if (c === '/' && n === '/') { mode = 'line-comment'; i++; prev = ''; continue; }
    if (c === '/' && n === '*') { mode = 'block-comment'; i++; prev = ''; continue; }
    if (c === "'") { mode = 'sq'; prev = c; continue; }
    if (c === '"') { mode = 'dq'; prev = c; continue; }
    if (c === '`') { mode = 'template'; templateStack.push(line); prev = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    prev = c;
  }

  return { lines, depthBefore, regions };
}

// Every `${identifier}` inside a long template literal, reported against the
// line the TEMPLATE starts on -- because that is the scope the interpolation
// is evaluated in, no matter how many lines of prose sit above it.
function templateUses(lines, regions) {
  const uses = [];
  for (const r of regions) {
    if (r.end - r.start + 1 < MIN_TEMPLATE_LINES) continue;
    for (let i = r.start; i <= r.end; i++) {
      for (const m of lines[i].matchAll(/\$\{\s*([A-Za-z_$][\w$]*)/g)) {
        uses.push({ name: m[1], line: i, scopeLine: r.start });
      }
    }
  }
  return uses;
}

function declarations(lines, regions) {
  // Prose inside a template literal is not code -- a prompt that says "const"
  // must not register as a binding.
  const inTemplate = new Set();
  for (const r of regions) {
    for (let i = r.start + 1; i <= r.end; i++) inTemplate.add(i);
  }

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (inTemplate.has(i)) continue;
    DECL.lastIndex = 0;
    let m;
    while ((m = DECL.exec(lines[i])) !== null) out.push({ name: m[1], line: i });
  }
  return out;
}

// The block a declaration belongs to starts at the last line above it whose
// depth is shallower. Anything at or after that line, and at least as deep,
// is inside the same block or nested in it -- which is exactly where a TDZ
// reference can be observed.
function blockStart(depthBefore, declLine) {
  const d = depthBefore[declLine];
  let i = declLine;
  while (i > 0 && depthBefore[i - 1] >= d) i--;
  return i;
}

function findViolations(source) {
  const { lines, depthBefore, regions } = scan(source);
  const uses = templateUses(lines, regions);
  if (!uses.length) return [];

  const decls = declarations(lines, regions);
  const byName = new Map();
  for (const d of decls) {
    if (!byName.has(d.name)) byName.set(d.name, []);
    byName.get(d.name).push(d.line);
  }

  const violations = [];
  const seen = new Set();
  for (const use of uses) {
    const declLines = byName.get(use.name);
    if (!declLines) continue;                       // import, global or param

    // An earlier declaration in scope means the name is already bound.
    if (declLines.some(dl => dl <= use.scopeLine)) continue;

    for (const dl of declLines) {
      if (dl <= use.scopeLine) continue;
      const start = blockStart(depthBefore, dl);
      const inSameBlock =
        use.scopeLine >= start && depthBefore[use.scopeLine] >= depthBefore[dl];
      if (!inSameBlock) continue;
      const key = `${use.name}:${use.line}:${dl}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({ name: use.name, useLine: use.line + 1, declLine: dl + 1 });
      break;
    }
  }
  return violations;
}

describe('template literals do not read a local declared below them (TDZ)', () => {
  const files = jsFiles(JS_ROOT);

  it('finds js files to check', () => {
    expect(files.length > 50).toBe(true);
  });

  for (const file of files) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    const source = readFileSync(file, 'utf8');
    if (!source.includes('`')) continue;

    it(`${rel} has no template literal reading a later local`, () => {
      const violations = findViolations(source);
      const report = violations
        .map(v => `  ${v.name} used at line ${v.useLine}, declared at line ${v.declLine}`)
        .join('\n');
      expect(violations.length === 0 ? 'clean' : `TDZ:\n${report}`).toBe('clean');
    });
  }
});

describe('the detector itself catches the bug it was written for', () => {
  it('flags a const used in a template above its declaration', () => {
    const bad = [
      'export function build() {',
      '  const head = 1;',
      '  const prompt = `line1',
      'line2', 'line3', 'line4', 'line5', 'line6', 'line7', 'line8',
      '${hazardZones.length}',
      'line10`;',
      '  const hazardZones = [];',
      '  return prompt + hazardZones + head;',
      '}',
    ].join('\n');
    const v = findViolations(bad);
    expect(v.length).toBe(1);
    expect(v[0].name).toBe('hazardZones');
  });

  it('does not flag a name declared inside a different callback', () => {
    const ok = [
      'export function render(rows) {',
      '  rows.forEach((row, i) => {',
      '    row.html = `line1',
      'line2', 'line3', 'line4', 'line5', 'line6', 'line7', 'line8',
      '<td data-i="${i}"></td>',
      'line10`;',
      '  });',
      '  rows.forEach((el) => {',
      '    el.on("change", (e) => {',
      '      const i = +e.target.dataset.i;',
      '      return i;',
      '    });',
      '  });',
      '}',
    ].join('\n');
    expect(findViolations(ok).length).toBe(0);
  });

  it('is not confused by braces inside the template prose', () => {
    const ok = [
      'export function build() {',
      '  const answer = 1;',
      '  const prompt = `Return ONLY valid JSON:',
      '{', '  "a": {', '    "b": <number>', '  }', '}', 'line7', 'line8',
      '${answer}',
      'line10`;',
      '  return prompt;',
      '}',
    ].join('\n');
    expect(findViolations(ok).length).toBe(0);
  });
});
