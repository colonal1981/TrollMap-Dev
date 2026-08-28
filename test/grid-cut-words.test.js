// A ROW THE RULED GRID CUT THROUGH IS NOT A LIMIT.
//
// NC's statewide largemouth bass rule reads:
//
//   14-inch minimum, except 2 may be less than 14 inches
//
// and the ruled reader returns it as `14-inch minimum, e` / `xcept 2 may be` / `less than 14`
// / `inches`. The row was found, the row was wrong, and nothing said so -- the same failure
// the page ledger was built for, one level down. 34 of the 103 rows in NC's warmwater game
// fish table are like this, and 8 of 56 in its nongame table. GA and TN are clean.
//
// It became urgent the moment these records started being served: a mangled limit in front of
// somebody about to keep a fish is worse than no limit, because it looks like an answer.
//
// THE PAGE IS ITS OWN ORACLE. extract_text() reads glyph runs in reading order without the
// ruled grid, so a word in a cell that is NOT in the page's own text was cut by the grid
// rather than printed by the book. No dictionary, no heuristic, no threshold -- two readings
// of one page disagreeing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(REPO, 'Scripts/build_regulations_table.py'), 'utf8');
const WORKER = readFileSync(path.join(REPO, 'Worker/trollmap-worker.js'), 'utf8');

test('the check judges a cell against the page that printed it', () => {
  const fn = SRC.slice(SRC.indexOf('def cells_that_cut_a_word'),
                       SRC.indexOf('def read_pdf_state'));
  assert.match(fn, /page_words \|= set\(re\.findall\(r'\[a-z\]\{3,\}'/);
  assert.match(fn, /if w not in page_words/);
  // The facing page counts too -- a row can run past the foot of its own page, and judging it
  // against one page reported the continuation as damage.
  assert.match(fn, /for k in \(n, n \+ 1\):/);
  // Two-letter runs are skipped: initials and units as often as damage.
  assert.match(fn, /\[a-z\]\{3,\}/);
});

test('the damaged row is marked, not only counted', () => {
  assert.match(SRC, /row\['text_cut_by_the_grid'\] = cut/);
  assert.match(SRC, /rec\['text_cut_by_the_grid'\] = row\['text_cut_by_the_grid'\]/);
  assert.match(SRC, /'the ruled grid sliced through words that '/);
});

test('the Worker withholds a cut row instead of serving it', () => {
  const blk = WORKER.slice(WORKER.indexOf('let bookStatewide = []'),
                           WORKER.indexOf('bookStatewide.push({'));
  assert.match(blk, /if \(Array\.isArray\(r\.text_cut_by_the_grid\) && r\.text_cut_by_the_grid\.length\) \{/);
  assert.match(blk, /bookStatewideDamaged \+= 1;/);
  assert.match(blk, /continue;/);
});

test('withholding is said out loud, so it cannot read as an open season', () => {
  assert.match(WORKER, /book_statewide_damaged: bookStatewideDamaged,/);
  assert.match(WORKER, /a known gap and not an open season/);
  // Three answers have to stay tellable apart: no rule, never read, and read-but-not-trusted.
  assert.match(WORKER, /which is a third answer from/);
});

test('a page is read against the rules the book actually drew on it', () => {
  // column_edges() takes pdfplumber's cell corners, and those come from rects as well as
  // lines -- so every shading block contributes two more "column boundaries". NC page 1 had
  // nine verticals where the table has four, with 77.8 and 88.1 inside the WATER BODY column
  // and 230.0 inside SIZE LIMIT.
  assert.match(SRC, /def rules_only_edges\(pdf, page_no, min_len=40\.0\)/);
  const fn = SRC.slice(SRC.indexOf('def rules_only_edges'), SRC.indexOf('def column_edges'));
  // Length is measured at the x, summed across segments: a book draws a column rule either as
  // one line down the table or as one short segment beside every row, and NC does both.
  assert.match(fn, /drawn\[round\(l\['x0'\], 1\)\] \+= abs\(l\['y1'\] - l\['y0'\]\)/);
  assert.match(fn, /if total >= min_len/);
});

test('the repair is gated on the damage it repairs, so it cannot make a page worse', () => {
  const fn = SRC.slice(SRC.indexOf('def collect_tables'), SRC.indexOf('    return sorted(out, key'));
  assert.match(fn, /hurt = len\(cells_that_cut_a_word\(pdf, got\)\)/);
  assert.match(fn, /if retry and len\(cells_that_cut_a_word\(pdf, retry\)\) < hurt:/);
  // A page whose header matched nothing gets its own drawn rules BEFORE another page's --
  // NC page 1 was being rescued by borrowing page 2's cell corners, themselves polluted.
  assert.match(fn, /got = by_drawn_rules\(n\)/);
  assert.match(fn, /xs = rules_only_edges\(pdf, src\) or column_edges\(pdf, src\)/);
});
