// TENNESSEE'S RESERVOIR PAGES -- seven pages of law for almost every TN water we offer.
//
// TWRA's digest carries its reservoir exceptions on pages 2-8, headed by a bare word:
// `Cherokee`, `Boone`, `Norris`. The reader was pointed at pages 11-17 only, on the reasoning
// that TWRA's per-reservoir HTML already covered those waters. The HTML is TWRA's summary;
// the digest is the law, and nothing ever compared them. The pages were also outside the page
// ledger, which is how they went unread without anything saying so.
//
// Reading them turned up that the column splitter had been wrong on the pages it WAS reading:
//
//   * _left_edges() kept an x0 bucket only if it held more than 4% of the page's words, a
//     threshold that rises with the text on the page. On this book it found ONE column for
//     pages 6 and 8, a single column starting at x=378 for page 13 -- discarding two thirds of
//     it -- and two of three for page 3, where it cut `Tims Ford` in half and lost Percy
//     Priest. Every block on pages 11-17 was assembled through it.
//   * rows were bucketed by round(top / ytol), so a printed line straddling a bucket edge came
//     apart: `Guntersville` at top=423.4 and its `(Tennessee Section Only)` at 424.4 landed in
//     different rows and the reservoir lost its name to its own qualifier.
//
// 54 blocks and one matched water became 121 blocks and ten -- every Tennessee lake we ship.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(REPO, 'Scripts/build_regulations_table.py'), 'utf8');

test('the reservoir pages are in the read set', () => {
  // PAGES OF THE FULL BOOK NOW, not of a 17-page cut. TWRA publishes one combined guide;
  // printed page N is PDF N+2, so the reservoir tables at printed 22-28 are PDF 24-30 and the
  // TWRA lakes, exceptions and trout at printed 31-37 are PDF 33-39.
  assert.match(SRC, /DIGEST_PAGES = list\(range\(24, 31\)\) \+ list\(range\(33, 40\)\)/);
  assert.match(SRC, /TN_STATEWIDE_PAGE = 17/);
  // The statewide page is read by read_tn_statewide(), not the block reader, so the ledger is
  // told about it or it reports the statewide table as a page carrying law nobody looked at.
  assert.match(SRC, /page_ledger\(tnpdf, set\(DIGEST_PAGES\) \| \{TN_STATEWIDE_PAGE\}, smap,/);
  assert.match(SRC, /read_tn_statewide\(dg_path, page=TN_STATEWIDE_PAGE\)/);
});

test('there is one column finder, and it is the bullet one', () => {
  assert.ok(!/def _left_edges\(/.test(SRC), '_left_edges is gone, not left behind unused');
  assert.match(SRC, /edges = \[float\(x\) for x in column_starts\(\[page\]\)\] or \[0\.0\]/);
});

test('rows are clustered by distance, not bucketed by rounding', () => {
  const fn = SRC.slice(SRC.indexOf('def _column_lines'), SRC.indexOf('def _join_wrapped'));
  assert.ok(!/rows\[round\(w\['top'\] \/ ytol\)\]/.test(fn), 'no fixed-bucket row grouping');
  assert.match(fn, /if rows and w\['top'\] - rows\[-1\]\[0\] <= ytol:/);
});

test('a bare name binds only when it is alone in the book and alone in the state', () => {
  const fn = SRC.slice(SRC.indexOf('def read_tn_digest'), SRC.indexOf('    return {\'blocks_found\''));
  // Counted from the book itself, so a future edition with a second Cherokee starts refusing.
  assert.match(fn, /used = Counter\(/);
  assert.match(fn, /if used\[name\.lower\(\)\] > 1:/);
  assert.match(fn, /'says which county' % used\[name\.lower\(\)\]/);
  // And state-scoped: resolve() is state-blind and answered `Cherokee` with a lake elsewhere.
  assert.match(fn, /slug = resolve_in_state\(name, 'TN', idx\)/);
  // The county rule is untouched -- both Davy Crocketts still refuse on the county they print.
  assert.match(fn, /county mismatch: book says %s, registry says %s/);
});

test('a word the typesetter broke across a line is put back together', () => {
  // `combina- tion`, `mini- mum`, `restric- tions` reached the record as words that do not
  // exist, and every consumer downstream matches on those strings.
  assert.match(SRC, /def _join_wrapped\(a, b\)/);
  const fn = SRC.slice(SRC.indexOf('def _join_wrapped'), SRC.indexOf('def _blocks'));
  assert.match(fn, /if a\.endswith\('-'\) and b\[:1\]\.islower\(\):/);
  assert.match(fn, /return a\[:-1\] \+ b/);
  assert.match(SRC, /cur\['rules'\]\[-1\] = _join_wrapped\(cur\['rules'\]\[-1\], t\)/);
});

test('page furniture is not a water', () => {
  assert.match(SRC, /^FOLIO = re\.compile/m);
  assert.match(SRC, /RUNNING\.match\(ln\['text'\]\) or FOLIO\.match\(ln\['text'\]\)/);
  // A heading with no letters in it is a stray colon, not a name.
  assert.match(SRC, /return \[b for b in out if re\.search\(r'\[A-Za-z\]', b\['heading'\] or ''\)/);
  // A 15pt sidebar title is furniture too -- it used to fall through to the Bold test and be
  // read as a reservoir called `Commercial Fishing in Tennessee`.
  assert.match(SRC, /if sz >= body_size \+ 4:/);
});

test('set like a qualifier is not the same as being one', () => {
  // The facing advertisements are set in the same 10.5pt Medium as `(Greene County):`, so
  // joining every one of them to the heading gave Melton Hill a sentence of ad copy in its name.
  assert.match(SRC, /^QUALIFIER = re\.compile/m);
  assert.match(SRC, /if k == 'qualifier' and QUALIFIER\.match\(t\):/);
});

test('the books abbreviate what the registry spells out', () => {
  // TWRA heads a reservoir `Ft. Loudoun`; the registry calls it `Fort Loudoun Lake`, and the
  // word-subset test failed on ft vs fort. Expanded where both sides pass through.
  assert.match(SRC, /^ABBREV = \{'ft': 'fort'/m);
  const fn = SRC.slice(SRC.indexOf('def _bare_words'), SRC.indexOf('def _bare_words') + 400);
  assert.match(fn, /ABBREV\.get\(w, w\)/);
});
