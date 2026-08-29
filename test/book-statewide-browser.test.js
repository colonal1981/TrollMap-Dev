// THE BOOK ANSWERING WHERE THE MODEL DID NOT.
//
// /regulations answers from the same digest twice. `general` is the book parsed by an LLM at
// request time; `book_statewide` is build_regulations_table.py's reading of the same pages,
// deterministic, with the sentence it came from and the plan checkboxes it governs both
// resolved offline. Until now the browser could only see the first one, so every species the
// LLM parse missed came back as `scope: 'none'` -- "the digest was read and it says nothing
// about this fish here" -- when the book plainly says something.
//
// Tennessee is the case that made it visible: TWRA's statewide creel and length table is
// eighteen rows and the app had never shown one of them.
//
// IT NOW OUTRANKS `general`, AND THAT IS A REVERSAL. When this file was written the book was
// tried last: making a second answer reachable and changing which answer wins were different
// decisions, and only the first had been made. The second was made on 2026-08-29, after both
// readers were measured against the same pages. They are not two sources -- fetchStateRegulations
// runs TinyFish over the digest PDFs in our own R2 bucket and hands the text to a model, so the
// LLM reads the SAME document this table is built from. On GA it turned `15, only two of which
// can be 22 inches or longer` into a 22-inch minimum size limit, which is the opposite of the
// rule; on NC it handed the impoundment striper limit to rivers. Every error was a scoped rule
// promoted to statewide. So the book answers first, the digest answers only into a silence, and
// a row the Worker WITHHELD is not a silence. And it does not match species by string --
// `plan_species` is resolved at build time, so `Black Bass (includes Largemouth, Smallmouth,
// Spotted, Alabama, Coosa and all hybrids)` arrives already naming the Largemouth Bass box.
import { primeRegulations, livePolicyFor, _resetRegulationsCache }
  from '../js/data/regulations-live.js';

let fails = 0;
const check = (name, cond, got) => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  fails++; console.log(`  FAIL ${name}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`);
};

const TN_PAYLOAD = {
  state: 'TN', lake: 'Norris Lake', parse_failed: false,
  // What TN's live parse has actually been returning: nothing.
  general: {},
  lake_specific: {},
  book_statewide_source: 'TN tn_digest_2026_2027.pdf',
  book_statewide_damaged: 0,
  book_statewide: [
    { species: 'Black Bass (includes Largemouth, Smallmouth, Spotted, Alabama, Coosa and all hybrids)',
      plan_species: ['Largemouth Bass'], species_basis: 'partial -- the book is wider than the form',
      size_limit: 'none', creel_limit: '5 No more than 5 Black Bass per day in any combination may be taken.',
      cells: ['Black Bass (includes Largemouth, Smallmouth, Spotted, Alabama, Coosa and all hybrids)',
              '5 No more than 5 Black Bass per day in any combination may be taken.', 'none'],
      source: 'TN tn_digest_2026_2027.pdf', page: 1 },
    { species: 'Crappie (all species combined)', plan_species: ['Crappie'],
      size_limit: '10 inches', creel_limit: '15',
      cells: ['Crappie (all species combined)', '15', '10 inches'],
      source: 'TN tn_digest_2026_2027.pdf', page: 1 },
  ],
};

const stub = (payload) => async () => ({ ok: true, json: async () => payload });

console.log('== the book answers where the model found nothing ==');
{
  _resetRegulationsCache();
  await primeRegulations('TN', 'Norris Lake (Union Co, TN)',
    { worker: 'https://w', fetch: stub(TN_PAYLOAD), now: 1000 });

  const cr = livePolicyFor('TN', 'Norris Lake', 'Crappie');
  check('a species the LLM parse missed now has limits',
    cr && cr.scope === 'state' && cr.sizeLimit === '10 inches' && cr.creelLimit === '15', cr);
  check('and says it came from the book, with the sentence it is quoting',
    cr.fromBook === true && /Crappie \(all species combined\)/.test(cr.text), cr);

  // MATCHED ON THE CHECKBOX, NOT THE STRING. Nothing about the phrase `Black Bass (includes
  // Largemouth, ...)` equals `Largemouth Bass`; plan_species is what carries the answer.
  const lm = livePolicyFor('TN', 'Norris Lake', 'Largemouth Bass');
  check('a book phrase reaches the checkbox it governs',
    lm && lm.scope === 'state' && lm.fromBook === true, lm);
  check('and it is the black bass row, not a text match on "bass"',
    /Black Bass/.test(lm.species), lm && lm.species);

  // A fish neither half names is still "the book was read and says nothing", not null.
  const bow = livePolicyFor('TN', 'Norris Lake', 'Bowfin');
  check('a fish in neither half is still `none`, not null', bow && bow.scope === 'none', bow);
}

console.log('\n== the book outranks the model on the same page ==');
{
  _resetRegulationsCache();
  await primeRegulations('TN', 'Cherokee Lake (Hawkins Co, TN)', {
    worker: 'https://w', now: 1000,
    fetch: stub({ ...TN_PAYLOAD, lake: 'Cherokee Lake',
      general: { Crappie: { species: 'Crappie', sizeLimit: '9" TL', creelLimit: '20/day' } } }),
  });
  const cr = livePolicyFor('TN', 'Cherokee Lake', 'Crappie');
  check('the book wins where both answered', cr.fromBook === true, cr);
  check('and it is the book\'s numbers, not the digest\'s',
    cr.sizeLimit === '10 inches' && cr.creelLimit === '15', cr);
  check('and it carries the sentence it is quoting', typeof cr.text === 'string' && cr.text.length,
    cr.text);
}

console.log('\n== the model still fills a silence, and never fills a refusal ==');
{
  // THE SC BLUE CATFISH CASE. The book's only entry for it is a pointer at a section we have
  // not parsed, so the table has no row -- the digest's number is the only answer there is, and
  // it is worth having.
  _resetRegulationsCache();
  await primeRegulations('SC', 'Lake Murray (Lexington Co, SC)', {
    worker: 'https://w', now: 1000,
    fetch: stub({ state: 'SC', lake: 'Lake Murray', parse_failed: false, lake_specific: {},
      general: { 'Blue Catfish': { sizeLimit: null, creelLimit: '150' } },
      book_statewide: [], book_statewide_source: 'SC Regs2627.pdf' }),
  });
  const bc = livePolicyFor('SC', 'Lake Murray', 'Blue Catfish');
  check('into a silence the digest still answers',
    bc.scope === 'state' && bc.creelLimit === '150' && bc.fromBook === false, bc);
}
{
  // THE NC RIVER CASE. The Worker withheld the statewide striper rule from this water because
  // the book writes it for impoundments. The digest offers 20 inches anyway; it must not land.
  _resetRegulationsCache();
  await primeRegulations('NC', 'Cape Fear River (Cumberland Co, NC)', {
    worker: 'https://w', now: 1000,
    fetch: stub({ state: 'NC', lake: 'Cape Fear River', parse_failed: false, lake_specific: {},
      general: { 'Striped Bass / Hybrid': { sizeLimit: '20-inch minimum',
                                            creelLimit: '4 in combination' } },
      book_statewide: [], book_statewide_source: 'NC nc_digest_2026_2027.pdf',
      book_withheld: [{ species: 'STRIPED BASS AND BODIE BASS (STRIPED BASS HYBRID)',
                        plan_species: ['Striped Bass', 'Hybrid'],
                        why: 'the book writes this for lake and this water is a river',
                        source: 'NC nc_digest_2026_2027.pdf' }] }),
  });
  const sb = livePolicyFor('NC', 'Cape Fear River', 'Striped Bass');
  check('a withheld row is reported as withheld, not answered', sb.scope === 'withheld', sb);
  check('and it carries no numbers at all',
    sb.sizeLimit === null && sb.creelLimit === null, sb);
  check('and it says why', typeof sb.why === 'string' && /river/.test(sb.why), sb.why);
}

console.log('\n== the book addressed to this water beats the statewide default ==');
{
  _resetRegulationsCache();
  await primeRegulations('SC', 'Wateree Lake (Kershaw Co, SC)', {
    worker: 'https://w', now: 1000,
    fetch: stub({ state: 'SC', lake: 'Wateree Lake', parse_failed: false, lake_specific: {},
      general: {}, book_statewide_source: 'SC Regs2627.pdf',
      book_statewide: [{ species: 'Largemouth Bass', plan_species: ['Largemouth Bass'],
                         size_limit: 'Any length', creel_limit: '5', cells: [],
                         source: 'SC Regs2627.pdf' }],
      book_rules: { state: 'SC', display_name: 'Wateree Lake (Kershaw Co, SC)', rules: [
        { source: 'SC Regs2627.pdf', page: 31, species: 'Largemouth Bass',
          plan_species: ['Largemouth Bass'], size_limit: '14 inches min',
          creel_limit: 'No more than 5 combined total of smallmouth, largemouth, redeye bass '
                     + 'or their hybrids',
          address: 'Lakes Blalock, Greenwood, Jocassee, Marion, Monticello, Moultrie, Murray, '
                 + 'Secession, Wateree, Wylie', cells: ['Largemouth Bass', '14 inches min'] }] } }),
  });
  const lm = livePolicyFor('SC', 'Wateree Lake', 'Largemouth Bass');
  check('the water\'s own row wins over the statewide row',
    lm.scope === 'lake' && lm.sizeLimit === '14 inches min', lm);
  check('and it cites the page', lm.page === 31 && lm.fromBook === true, lm);
}

console.log('\n== a payload with no book half is unchanged ==');
{
  _resetRegulationsCache();
  await primeRegulations('SC', 'Lake Murray (Lexington Co, SC)', {
    worker: 'https://w', now: 1000,
    fetch: stub({ state: 'SC', lake: 'Lake Murray', parse_failed: false,
                  general: {}, lake_specific: {} }),
  });
  const r = livePolicyFor('SC', 'Lake Murray', 'Crappie');
  check('no book_statewide key is not a crash, it is `none`', r && r.scope === 'none', r);
}

console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
