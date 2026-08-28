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
// TWO THINGS THIS DELIBERATELY DOES NOT DO. It does not outrank `general`: where the LLM found
// the fish, its answer still stands, because making a second answer reachable and changing
// which answer wins are different decisions. And it does not match species by string --
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

console.log('\n== it does not outrank the model where the model answered ==');
{
  _resetRegulationsCache();
  await primeRegulations('TN', 'Cherokee Lake (Hawkins Co, TN)', {
    worker: 'https://w', now: 1000,
    fetch: stub({ ...TN_PAYLOAD, lake: 'Cherokee Lake',
      general: { Crappie: { species: 'Crappie', sizeLimit: '9" TL', creelLimit: '20/day' } } }),
  });
  const cr = livePolicyFor('TN', 'Cherokee Lake', 'Crappie');
  check('the live parse still wins where it has an answer',
    cr.scope === 'state' && cr.sizeLimit === '9" TL' && !cr.fromBook, cr);
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
