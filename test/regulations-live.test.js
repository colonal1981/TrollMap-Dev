// A check that ran, said "I don't know", and showed nothing.
//
// checkRegulations() is gated on a hand-written table of SIX named waters plus Coastal SC Inshore.
// It is live: plan-preflight.js and smart-plan.js both call it before a plan is built. On the
// other 448 waters it returned
//
//     { legal: true, note: 'No specific regulation data available — verify locally before fishing.' }
//
// and NEITHER CALLER READS `note`. checkPlanLegality maps `reason` and `warnings`; smart-plan
// reads `legal` and `warnings`. So the app ran a legality check, got back "we do not know", and
// displayed nothing — indistinguishable from "checked, you are fine". The throw path directly
// above it DOES warn. A failed check spoke and an empty one did not.
import { checkRegulations } from '../js/data/species-intel.js';
import { primeRegulations, livePolicyFor, regulationsPrimed, normalizeWaterName,
         _resetRegulationsCache } from '../js/data/regulations-live.js';

let fails = 0;
const check = (name, cond, got) => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  fails++; console.log(`  FAIL ${name}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`);
};

// The shape the Worker's /regulations returns, which is what parseSCTable builds: published TEXT,
// not numbers — "14\"" and "10/day", as the digest prints them.
const SC_PAYLOAD = {
  state: 'SC', lake: 'Lake Hartwell', parse_failed: false,
  general: {
    'Striped Bass': { species: 'Striped Bass', sizeLimit: '26" TL', creelLimit: '5/day' },
    'Largemouth Bass': { species: 'Largemouth Bass', sizeLimit: '12" TL', creelLimit: '5/day' },
  },
  lake_specific: {
    'Striped Bass': { species: 'Striped Bass', sizeLimit: '20" TL', creelLimit: '2/day' },
  },
  has_exceptions: true,
};

const stub = (payload) => async () => ({ ok: true, json: async () => payload });

console.log('== the unknown branch speaks now ==');
{
  _resetRegulationsCache();
  // A water nobody hand-typed, no digest primed. This is 448 of the 454.
  const r = checkRegulations('Hartwell Lake (Anderson Co, SC)', 'Striped Bass', new Date('2026-08-17'));
  check('still legal, because we genuinely do not know', r.legal === true);
  check('but it WARNS, in the field both callers read',
    Array.isArray(r.warnings) && r.warnings.length === 1, r.warnings);
  check('and the warning names the water and says to verify',
    /Hartwell/.test(r.warnings[0]) && /verify/i.test(r.warnings[0]), r.warnings[0]);
  check('note kept for anything that still reads it', r.note === r.warnings[0]);
  check('no limits invented', r.limits === null);
}

console.log('\n== the digest, once primed ==');
{
  _resetRegulationsCache();
  check('not primed is not primed', regulationsPrimed('SC', 'Hartwell Lake') === false);
  await primeRegulations('SC', 'Hartwell Lake (Anderson Co, SC)',
    { worker: 'https://w', fetch: stub(SC_PAYLOAD), now: 1000 });
  check('primed', regulationsPrimed('SC', 'Hartwell Lake (Anderson Co, SC)') === true);
  check('and the county parenthetical does not make it a different water',
    regulationsPrimed('SC', 'Hartwell Lake') === true);

  // LAKE-SPECIFIC BEATS STATEWIDE, and says which it was: "this lake has its own rule" and "the
  // statewide rule applies here" are different sentences to put in front of somebody about to
  // keep a fish.
  const sp = livePolicyFor('SC', 'Hartwell Lake', 'Striped Bass');
  check('the lake exception wins', sp.scope === 'lake' && sp.sizeLimit === '20" TL', sp);
  const lm = livePolicyFor('SC', 'Hartwell Lake', 'Largemouth Bass');
  check('and falls through to statewide', lm.scope === 'state' && lm.creelLimit === '5/day', lm);
  const none = livePolicyFor('SC', 'Hartwell Lake', 'Bowfin');
  check('a species the book does not list is "none", not null',
    none && none.scope === 'none', none);

  const r = checkRegulations('Hartwell Lake (Anderson Co, SC)', 'Striped Bass',
    new Date('2026-08-17'), 'SC');
  check('the limits reach the caller', r.limits && r.limits.sizeLimit === '20" TL', r.limits);
  check('scope travels with them', r.limits.scope === 'lake');
  check('the warning carries the numbers and still says verify',
    /20" TL/.test(r.warnings[0]) && /2\/day/.test(r.warnings[0]) && /verify/i.test(r.warnings[0]),
    r.warnings[0]);
  // A LIMIT IS NOT A CLOSURE. The digest publishes size and creel; it does not say a season is
  // shut, which is what legal:false means.
  check('a limit never makes something illegal', r.legal === true);
  check('and the warning says so', /No closure information/i.test(r.warnings[0]), r.warnings[0]);
}

console.log('\n== a broken parse is not an answer ==');
{
  _resetRegulationsCache();
  // parse_failed exists precisely because an LLM hiccup and a state with no lake-specific rules
  // both produce an empty object. Caching the first as data removed a state's regulations for a
  // quarter of a year once already.
  await primeRegulations('SC', 'Lake Murray',
    { worker: 'https://w', fetch: stub({ state: 'SC', parse_failed: true, general: {} }), now: 1 });
  check('a failed parse is not cached', regulationsPrimed('SC', 'Lake Murray') === false);

  const bad = async () => ({ ok: false, status: 502, json: async () => ({}) });
  await primeRegulations('SC', 'Lake Murray', { worker: 'https://w', fetch: bad });
  check('an HTTP failure is not cached either', regulationsPrimed('SC', 'Lake Murray') === false);

  const boom = async () => { throw new Error('offline'); };
  let threw = false;
  try { await primeRegulations('SC', 'Lake Murray', { worker: 'https://w', fetch: boom }); }
  catch { threw = true; }
  check('and a thrown fetch does not propagate', threw === false);

  // AND A COLD CACHE IS NOT A PASS.
  const r = checkRegulations('Lake Murray', 'Bowfin', new Date('2026-08-17'), 'SC');
  check('cold cache still warns', r.warnings.length === 1 && /verify/i.test(r.warnings[0]));
}

console.log('\n== the curated table still owns closures ==');
{
  _resetRegulationsCache();
  // Only the hand-typed rows carry notPresent / closedSeason, which is the only thing that can
  // make legal false. The digest cannot say a season is shut.
  const r = checkRegulations('Lake Wateree', 'Striped Bass', new Date('2026-08-17'), 'SC');
  check('a curated water returns its own row', !!r.regInfo);
  check('warnings is always an array, never undefined', Array.isArray(r.warnings));
}

console.log('\n== names ==');
{
  check('county parenthetical dropped',
    normalizeWaterName('Hartwell Lake (Anderson Co, SC)') === 'hartwell lake');
  check('state suffix dropped', normalizeWaterName('Lake Murray, SC') === 'lake murray');
  check('two-state suffix dropped', normalizeWaterName('Lake Wylie, NC/SC') === 'lake wylie');
  check('empty is empty', normalizeWaterName(null) === '');
  _resetRegulationsCache();
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
process.exit(fails ? 1 : 0);
