// The books can say no, and this is the proof that they say it to the right person on the right day.
//
// Until 2026-08-27 `legal: false` came from ONE place: the six hand-typed rows of REGULATIONS in
// species-intel.js. registry/regulations.json is the same law parsed offline from the four state
// digests with no LLM anywhere in the path, and it reaches 74 waters, 28 of which carry a closure
// that can gate a trip. Lake Marion is the case that made this necessary — its striped bass
// shutdown is real, printed, and the research pipeline lost it three separate times.
//
// FOUR WAYS THIS GATE COULD BE WORSE THAN NO GATE, all of them tested below:
//   1. Blocking the wrong fish. `June 16 - Sept. 30 closed` is a STRIPER rule. Told to a crappie
//      trip it reads "Lake Marion is closed", which is false and which the app would have said
//      before plan_species was baked on at build time.
//   2. Blocking on the wrong day. A window that wraps the year end inverts if compared naively.
//   3. Reading a name that did not resolve as an open water. `closures: []` is what both a clean
//      water and an unmatched name look like; only `book_slug` tells them apart.
//   4. Swallowing a sentence it could not classify. That is the exact failure regulations-live.js
//      was written to correct, one layer up.
//
// The fixtures below are COPIED FROM registry/regulations_table.json, not invented, except where
// a comment says otherwise and says why.
import { checkRegulations, REGULATIONS } from '../js/data/species-intel.js';
import { primeRegulations, closuresFor, _resetRegulationsCache } from '../js/data/regulations-live.js';

let fails = 0;
const check = (name, cond, got) => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  fails++; console.log(`  FAIL ${name}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`);
};
const stub = (payload) => async () => ({ ok: true, json: async () => payload });
const base = { parse_failed: false, general: {}, lake_specific: null, has_exceptions: null,
               saltwater: {}, saltwater_source: null, closures_error: null };
const prime = (state, lake, payload) =>
  primeRegulations(state, lake, { worker: 'https://w', fetch: stub(payload), now: 1000 });

const STRIPER_BOTH = ['Striped Bass', 'Hybrid'];
const ALL_FIFTEEN = ['Striped Bass', 'Hybrid', 'Largemouth Bass', 'White Bass', 'Bowfin', 'Catfish',
  'Crappie', 'White Perch', 'Yellow Perch', 'Bluegill', 'Redear Sunfish (Shellcracker)',
  'Redbreast Sunfish', 'Warmouth', 'Green Sunfish', 'Pumpkinseed'];

// Lake Marion, SC Regs2627.pdf page 32, verbatim. Two records off the same table: a slot stated
// with a date window, and the closure. Together they tile the year, which is why the slot row is
// NOT inverted into a closure anywhere — the book already wrote the other half.
const MARION = { ...base, state: 'SC', lake: 'Lake Marion (Clarendon Co, SC)',
  book_slug: 'lake_marion', book_rules: null, closures: [
  { effect: 'open_only', applies_to: 'harvest', start: '10-01', end: '06-15',
    species: 'Striped or Hybrid Bass or a combination', species_known: true,
    plan_species: STRIPER_BOTH, species_basis: 'exact', source: 'SC Regs2627.pdf',
    text: 'Oct. 1 - June 15 striped bass between 23 and 25 inches may be harvested except that one fish may be greater than 26 inches' },
  { effect: 'closed', applies_to: 'harvest', start: '06-16', end: '09-30',
    species: 'Striped or Hybrid Bass or a combination', species_known: true,
    plan_species: STRIPER_BOTH, species_basis: 'exact', source: 'SC Regs2627.pdf',
    text: 'June 16 - Sept. 30 closed except for Lower Reach Saluda River where catch and release is allowed but when fishing with live or dead fish or bait fish parts hook gap (point to shank) must not exceed 3/8 of an inch except all sizes of inline, non-offset, non-stainless steel circle hooks are allowed.' },
]};

// Lake Edwin B. Johnson, the SC state-lakes table. No dates: the water is shut, full stop, and
// the second row says until when. Fifteen plan species because the closure is on the WATER.
const EDWIN = { ...base, state: 'SC', lake: 'Lake Edwin B. Johnson (Darlington Co, SC)',
  book_slug: 'lake_edwin_johnson', book_rules: null, closures: [
  { effect: 'closed', applies_to: 'all_fishing', start: null, end: null,
    species: null, species_known: false, plan_species: ALL_FIFTEEN, species_basis: 'every species -- the water is shut',
    source: 'SC Regs2627.pdf', text: 'Closed to Boating and Fishing' },
  { effect: 'closed', applies_to: 'all_fishing', start: null, end: null,
    species: null, species_known: false, plan_species: ALL_FIFTEEN, species_basis: 'every species -- the water is shut',
    source: 'SC Regs2627.pdf', text: 'Closed to Boating and Fishing until July 1, 2027' },
]};

console.log('== Lake Marion, the water that made this necessary ==');
{
  _resetRegulationsCache();
  await prime('SC', 'Lake Marion (Clarendon Co, SC)', MARION);
  const inside = new Date('2026-07-15'), outside = new Date('2026-11-15');

  const r = checkRegulations('Lake Marion (Clarendon Co, SC)', 'Striped Bass', inside, 'SC');
  check('July 15 is inside the closure and the answer is no', r.legal === false, r.legal);
  check('the reason names the fish and the dates',
    /Striped Bass harvest is closed \(06-16 to 09-30\)/.test(r.reason), r.reason);
  check("and quotes the book's own sentence rather than paraphrasing it",
    r.reason.includes('June 16 - Sept. 30 closed'), r.reason);
  check('the source travels with it', r.source === 'SC Regs2627.pdf', r.source);

  check('Hybrid is the same rule and gets the same answer',
    checkRegulations('Lake Marion', 'Hybrid', inside, 'SC').legal === false);

  // THE ONE THAT WOULD HAVE BEEN A LIE. A striper closure is not a lake closure.
  const cr = checkRegulations('Lake Marion', 'Crappie', inside, 'SC');
  check('crappie in the same water on the same day is legal', cr.legal === true, cr.legal);
  check('and is not warned about somebody else’s striper rule',
    !cr.warnings.some((w) => /June 16/.test(w)), cr.warnings);

  check('November 15 is outside it', checkRegulations('Lake Marion', 'Striped Bass', outside, 'SC').legal === true);
  // The slot row is `open_only`, and November 15 sits inside it. An open season is not a closure
  // and must never be read as one in either direction.
  check('and the slot row did not become a second closure',
    closuresFor('SC', 'Lake Marion', 'Striped Bass', outside).blocking.length === 0);
}

console.log('\n== the curated row and the book, on the same water ==');
{
  // This is the retirement evidence. REGULATIONS['Lake Marion'] carries closedSeason [6,16,9,30];
  // the book parses to 06-16..09-30. If they agree on every day of the year, the hand row is a
  // duplicate and can go. If they ever disagree, this test says which day and stops the delete.
  check('the hand table still has the row', !!REGULATIONS['Lake Marion']['Striped Bass'].closedSeason);
  const days = [];
  for (let m = 1; m <= 12; m++) for (const d of [1, 15, 28]) days.push([m, d]);
  let disagree = 0, sample = null;
  for (const [m, d] of days) {
    const when = new Date(2026, m - 1, d);
    _resetRegulationsCache();
    const hand = checkRegulations('Lake Marion', 'Striped Bass', when);        // no state: books off
    await prime('SC', 'Lake Marion', MARION);
    const book = checkRegulations('Lake Marion', 'Striped Bass', when, 'SC');  // books on
    if (hand.legal !== book.legal) { disagree++; sample = sample || [m, d, hand.legal, book.legal]; }
  }
  check('hand row and parsed book agree on all 36 sample days', disagree === 0, sample);
}

console.log('\n== a water that is simply shut ==');
{
  _resetRegulationsCache();
  await prime('SC', 'Lake Edwin B. Johnson (Darlington Co, SC)', EDWIN);
  for (const sp of ['Striped Bass', 'Crappie', 'Bluegill', 'Catfish']) {
    const r = checkRegulations('Lake Edwin B. Johnson', sp, new Date('2026-07-15'), 'SC');
    check(`${sp} is refused`, r.legal === false, r.legal);
    check(`  and is told the WATER is closed, not the fish`,
      /^This water is closed/.test(r.reason), r.reason);
  }
  // No start and no end is "always", not "never". Getting this backwards opens a closed lake.
  const dec = checkRegulations('Lake Edwin B. Johnson', 'Crappie', new Date('2026-12-25'), 'SC');
  check('a dateless closure applies in December too', dec.legal === false, dec.legal);
  check('and the reason carries no invented window', !/\(/.test(dec.reason), dec.reason);
  check('the second row is a warning beside the first, not a lost sentence',
    dec.warnings.length === 1 && /until July 1, 2027/.test(dec.warnings[0]), dec.warnings);
}

console.log('\n== a sentence the parser could not type ==');
{
  // Lake Murray, verbatim. `June 1 - Sept. 30: any length` is a real record with effect
  // `unknown` — the builder saw a window and would not guess what it did. It is the same
  // species and very nearly the same months as Marion's shutdown, which is exactly why it may
  // not be dropped. It cannot block, because nobody knows what it says. It can be quoted.
  _resetRegulationsCache();
  await prime('SC', 'Lake Murray', { ...base, state: 'SC', lake: 'Lake Murray',
    book_slug: 'lake_murray', book_rules: null, closures: [
    { effect: 'unknown', applies_to: 'unknown', start: '06-01', end: '09-30',
      species: 'Striped or Hybrid Bass or a combination', species_known: true,
      plan_species: STRIPER_BOTH, species_basis: 'exact', source: 'SC Regs2627.pdf',
      text: 'June 1 - Sept. 30: any length' },
  ]});
  const r = checkRegulations('Lake Murray', 'Striped Bass', new Date('2026-07-15'), 'SC');
  check('an untyped rule does not shut the water', r.legal === true, r.legal);
  check('but it is said out loud, in the field both callers read',
    r.warnings.some((w) => /June 1 - Sept\. 30: any length/.test(w)), r.warnings);
  check('and it is silent in April, when it does not apply',
    !checkRegulations('Lake Murray', 'Striped Bass', new Date('2026-04-15'), 'SC')
      .warnings.some((w) => /any length/.test(w)));
}

console.log('\n== a rule about a fish nobody can select ==');
{
  // Cherokee Lake, TN digest, verbatim. Every method closure in all four books today is
  // Paddlefish, and Paddlefish has no checkbox — species_map.json files it under
  // no_home_in_the_form. So this record must reach nobody at all, rather than reaching a
  // striper trip as "closed to snagging".
  _resetRegulationsCache();
  await prime('TN', 'Cherokee Lake', { ...base, state: 'TN', lake: 'Cherokee Lake',
    book_slug: 'cherokee_lake', book_rules: null, closures: [
    { effect: 'closed', applies_to: 'method:snagging', start: '03-01', end: '03-31',
      species: null, species_known: false, plan_species: [], species_basis: null,
      source: 'TN Fishing Guide 2026.pdf',
      text: 'Paddlefish: One (1) per day, no length limit. Season is open from April 1–15. Culling is prohibited.' },
  ]});
  const r = checkRegulations('Cherokee Lake', 'Striped Bass', new Date('2026-03-15'), 'TN');
  check('a paddlefish snagging rule does not block a striper trip', r.legal === true, r.legal);
  check('and does not warn one either',
    !r.warnings.some((w) => /Paddlefish/.test(w)), r.warnings);
  check('closuresFor agrees it applies to nobody',
    closuresFor('TN', 'Cherokee Lake', 'Striped Bass', new Date('2026-03-15')).warnings.length === 0);
}

console.log('\n== a method closure that could exist ==');
{
  // SHAPED, NOT COPIED, and the only fixture here that is. No row in the 2026 books is a method
  // closure on a species the form offers, so the warn-don't-block arm has no live example. The
  // branch exists because the next book can have one, and an untested branch in a legality gate
  // is worse than no branch.
  _resetRegulationsCache();
  await prime('NC', 'Some Reservoir', { ...base, state: 'NC', lake: 'Some Reservoir',
    book_slug: 'some_reservoir', book_rules: null, closures: [
    { effect: 'closed', applies_to: 'method:snagging', start: '03-01', end: '03-31',
      species: 'Striped Bass', species_known: true, plan_species: ['Striped Bass'],
      species_basis: 'exact', source: 'NC Regulations Digest', text: 'Closed to snagging March 1-31.' },
  ]});
  const r = checkRegulations('Some Reservoir', 'Striped Bass', new Date('2026-03-15'), 'NC');
  check('a method closure does not stop the trip', r.legal === true, r.legal);
  check('it warns, carrying the sentence',
    r.warnings.some((w) => /Closed to snagging March 1-31\./.test(w)), r.warnings);
}

console.log('\n== the year end ==');
{
  // SHAPED, NOT COPIED. Zero of the 31 closures in the four 2026 books wrap December into
  // January; the wrapping windows we do parse are all slot and creel rules. So the wrap arm of
  // the window comparison would never execute against real data, and a naive `md >= a && md <= b`
  // would look correct for a whole year and then open a closed season on New Year's Day.
  _resetRegulationsCache();
  await prime('NC', 'Winter Lake', { ...base, state: 'NC', lake: 'Winter Lake',
    book_slug: 'winter_lake', book_rules: null, closures: [
    { effect: 'closed', applies_to: 'harvest', start: '11-01', end: '02-28',
      species: 'Muskellunge', species_known: true, plan_species: ['Largemouth Bass'],
      species_basis: 'exact', source: 'NC Regulations Digest', text: 'Nov. 1 - Feb. 28 closed.' },
  ]});
  const on = (iso) => checkRegulations('Winter Lake', 'Largemouth Bass', new Date(iso), 'NC').legal;
  check('Nov 1, the first day, is closed', on('2026-11-01') === false);
  check('Dec 25 is closed', on('2026-12-25') === false);
  check('Jan 1, across the boundary, is still closed', on('2027-01-01') === false);
  check('Feb 28, the last day, is closed', on('2027-02-28') === false);
  check('Mar 1 is open', on('2027-03-01') === true);
  check('Oct 31 is open', on('2026-10-31') === true);
}

console.log('\n== the four ways silence could be mistaken for permission ==');
{
  // 1. THE NAME DID NOT RESOLVE. resolveRegistryRow refuses an ambiguous name rather than
  //    guessing, and a refusal produces `closures: []` — byte-identical to a clean water.
  _resetRegulationsCache();
  await prime('SC', 'Some Pond', { ...base, state: 'SC', lake: 'Some Pond',
    book_slug: null, book_rules: null, closures: [] });
  const c = closuresFor('SC', 'Some Pond', 'Striped Bass', new Date('2026-07-15'));
  check('an unresolved name says so', c.resolved === false && c.slug === null, c);
  const r = checkRegulations('Some Pond', 'Striped Bass', new Date('2026-07-15'), 'SC');
  check('and the trip is still warned rather than waved through',
    r.legal === true && r.warnings.length >= 1 && /verify/i.test(r.warnings[0]), r.warnings);

  // 2. A RESOLVED WATER WITH NO CLOSURES is a different sentence, and both are honest.
  _resetRegulationsCache();
  await prime('SC', 'Clean Lake', { ...base, state: 'SC', lake: 'Clean Lake',
    book_slug: 'clean_lake', book_rules: null, closures: [] });
  const c2 = closuresFor('SC', 'Clean Lake', 'Striped Bass', new Date('2026-07-15'));
  check('a resolved water with nothing on it says THAT', c2.resolved === true && c2.slug === 'clean_lake');
  check('and blocks nothing', c2.blocking.length === 0 && c2.warnings.length === 0);

  // 3. THE R2 OBJECT WAS MISSING. A pipeline state must not read as an open season, and must
  //    not take the limits down with it either.
  _resetRegulationsCache();
  await prime('SC', 'Broken Lake', { ...base, state: 'SC', lake: 'Broken Lake',
    book_slug: null, book_rules: null, closures: [],
    closures_error: 'R2 object _registry/regulations.json not found',
    general: { 'Striped Bass': { species: 'Striped Bass', sizeLimit: '26" TL', creelLimit: '5/day' } } });
  const r3 = checkRegulations('Broken Lake', 'Striped Bass', new Date('2026-07-15'), 'SC');
  check('a missing closure table warns',
    r3.warnings.some((w) => /Closure data could not be read/.test(w)), r3.warnings);
  check('and the limits still travel past it', r3.limits && r3.limits.creelLimit === '5/day', r3.limits);

  // 4. NOBODY PRIMED ANYTHING. The synchronous lookup reads a cache that may be cold; cold is
  //    the unknown branch, which warns, and closuresFor must return null rather than an empty
  //    verdict that looks like "checked, nothing found".
  _resetRegulationsCache();
  check('a cold cache is null, not an empty answer',
    closuresFor('SC', 'Lake Marion', 'Striped Bass', new Date('2026-07-15')) === null);
  const r4 = checkRegulations('Lake Marion', 'Striped Bass', new Date('2026-07-15'), 'SC');
  check('and Marion falls back to the hand row, which still says no',
    r4.legal === false && /Closed season/.test(r4.reason), r4.reason);
}

console.log('\n== calling it the old way still works ==');
{
  // checkRegulations(lake, species, date) with no state is the three-argument call plan
  // preflight used before the digest existed. It must not throw and must not consult books.
  _resetRegulationsCache();
  const r = checkRegulations('Lake Marion', 'Striped Bass', new Date('2026-11-15'));
  check('three arguments, no throw', r && typeof r.legal === 'boolean');
  check('warnings is an array even here', Array.isArray(r.warnings));
  const bad = checkRegulations('Lake Marion', 'Striped Bass', new Date('2026-07-15'), null);
  check('an explicit null state does not reach the books', bad.legal === false && !bad.source);
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
process.exit(fails ? 1 : 0);
