// THE STATEWIDE TABLE THE BUILD MADE AND NOBODY SERVED.
//
// build_regulations_table.py has been producing a `statewide` block per state -- SC 88 rows,
// NC 43, GA 42, TN 18 -- and /regulations read exactly one thing out of it: the records marked
// `statewide coastal`, for coastal_closures. Every freshwater statewide limit in all four
// books was built, written to R2, fetched by the Worker, and skipped.
//
// It matters because of what a lake-specific rule is: rare. Ryan: "most lakes do not have a
// specific limit... a per lake number isn't ever going to work... unless you are extracting
// the general regulation for each species and assigning that to each lake."
//
// Two things had to be true before it could be served at all, and neither was:
//
//   * `species` was computed for every row and then spent only on closure records, so a rule
//     carrying a limit and no closure -- most of them, and all 103 statewide rows -- reached a
//     consumer as an anonymous list of cells.
//   * TN's eighteen rows are appended straight to `statewide` by read_tn_statewide() and never
//     met the row loop, so they never met expand_species(). TWRA's entire statewide table
//     reached the plan form as nothing. The phrases were in species_map.json the whole time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = readFileSync(path.join(REPO, 'Worker/trollmap-worker.js'), 'utf8');
const SRC = readFileSync(path.join(REPO, 'Scripts/build_regulations_table.py'), 'utf8');

test('/regulations serves the book statewide table', () => {
  assert.match(WORKER, /book_statewide: bookStatewide,/);
  assert.match(WORKER, /book_statewide_source: bookStatewideSource,/);
  // Coastal records still go to coastal_closures and must not appear in both.
  const blk = WORKER.slice(WORKER.indexOf('let bookStatewide = []'),
                           WORKER.indexOf('} catch (err) {', WORKER.indexOf('let bookStatewide = []')));
  assert.match(blk, /if \(r\.scope !== 'statewide coastal'\) \{/);
  assert.match(blk, /continue;\s*\n\s*\}/);
});

test('it does not replace the digest parse, it travels beside it', () => {
  // A disagreement between the LLM parse and the book parse is worth seeing, not hiding.
  assert.match(WORKER, /general: stateRegs\.general \|\| \{\},/);
  assert.match(WORKER, /It does NOT replace `general`/);
});

test('absent and empty stay tellable apart', () => {
  assert.match(WORKER, /a null `book_statewide_source`/);
  assert.match(WORKER, /means no book was read for this state rather than a state that sets no/);
});

test('a served record carries its species, its checkboxes and its sentence', () => {
  const blk = WORKER.slice(WORKER.indexOf('bookStatewide.push({'),
                           WORKER.indexOf('});', WORKER.indexOf('bookStatewide.push({')));
  for (const f of ['species:', 'plan_species:', 'species_basis:', 'cells:', 'source:', 'page:']) {
    assert.ok(blk.includes(f), `${f} travels on the record`);
  }
});

test('the builder puts the species on the record, not only on its closures', () => {
  assert.match(SRC, /if sp and not all_species:\s*\n\s*rec\['species'\] = sp/);
  assert.match(SRC, /rec\['plan_species'\] = ex\['plan_species'\]/);
  // A saltwater fish has no business in the freshwater plan form, and says so rather than
  // arriving as UNMAPPED, which reads like a lookup that failed.
  const blk = SRC.slice(SRC.indexOf("if sp and not all_species:"), SRC.indexOf("last_species = sp"));
  assert.match(blk, /coastal species -- the freshwater plan/);
});

test("Tennessee's statewide rows go through the same species resolution as every other row", () => {
  const blk = SRC.slice(SRC.indexOf("get('statewide_table') or \\[\\]") > 0 ? 0 : SRC.indexOf('def project_by_water'),
                        SRC.indexOf('def add(slug, rec)') + 4000);
  assert.match(blk, /if rec\.get\('species'\) and not rec\.get\('plan_species'\):/);
  assert.match(blk, /ex = expand_species\(rec\['species'\], smap or \{\}\)/);
});
