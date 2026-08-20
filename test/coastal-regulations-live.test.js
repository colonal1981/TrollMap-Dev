// THE SAME FILE AS FRESHWATER, AND IT ALWAYS WAS.
//
// Ryan, 2026-08-20: *"that is not even close to how i want those regulations... i want it to
// match freshwater exactly... why would we hard code regulations"* and, when asked which source:
// *"its the same exact files as freshwater"*.
//
// He was right about the file. SCDNR ships ONE book: digest pages 1-18 are freshwater limits,
// 21-29 are saltwater. The Worker downloaded the whole PDF on every cold /regulations call,
// ran freshwaterRegionOf() to cut the saltwater half off, parsed the rest, and dropped the
// remainder on the floor -- while COASTAL_REGULATIONS asked a person to re-read those same
// discarded pages by hand every August.
//
// So the saltwater half now rides the download it was always part of: one fetch, two parses,
// one cache, one prime. These tests hold the seams of that.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  COASTAL_REGULATIONS,
  checkCoastalRegulations,
  formatCoastalLimit,
  parseSizeLimitText,
  parseCreelLimitText,
  crossCheckLimits,
} from '../js/data/coastal-regulations.js';
import {
  primeRegulations,
  liveCoastalPolicyFor,
  coastalRegulationsPrimed,
  nameForms,
  _resetRegulationsCache,
} from '../js/data/regulations-live.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUG = new Date('2026-08-20T12:00:00');           // inside every SC/GA verifyBy window
const PAST_SC = new Date('2027-09-01T12:00:00');       // past SC verifyBy 2027-08-14

/** The shape the Worker's /regulations returns: published TEXT, as the digest prints it. */
const payload = (saltwater, source = { anchor: 'SIZE & CATCH LIMITS', published: '2026-2027' }) => ({
  state: 'SC', lake: null, parse_failed: false, parse_error: null,
  general: { 'Largemouth Bass': { sizeLimit: null, creelLimit: '5 per day' } },
  lake_specific: null, has_exceptions: false,
  saltwater, saltwater_source: source,
});

const prime = async (salt, source, now = AUG.getTime()) => {
  _resetRegulationsCache();
  await primeRegulations('SC', 'Charleston Harbor, SC', {
    worker: 'https://w', now,
    fetch: async () => ({ ok: true, json: async () => payload(salt, source) }),
  });
};

const SC_BOOK = {
  'Red Drum (Redfish)': {
    sizeLimit: '18-25 inches TL', creelLimit: '1 per person per day',
    specialRules: ['Not to exceed 2 per boat per day.'],
  },
  'Speckled Trout (Spotted Seatrout)': {
    sizeLimit: '14 inch minimum TL', creelLimit: '10 per person per day', specialRules: [],
  },
  // Not in the five-row hand table. This is the ordinary case, not the exotic one.
  'Tripletail': { sizeLimit: '18 inch minimum', creelLimit: '2 per person per day', specialRules: [] },
};

describe('the saltwater half rides the freshwater download', () => {
  it('one prime warms both halves — no second endpoint, no second call', async () => {
    _resetRegulationsCache();
    let calls = 0;
    await primeRegulations('SC', 'Lake Marion', {
      worker: 'https://w', now: AUG.getTime(),
      fetch: async () => { calls++; return { ok: true, json: async () => payload(SC_BOOK) }; },
    });
    expect(calls).toBe(1);
    // AN INLAND LAKE WARMED THE COAST. Saltwater limits are statewide, so they are filed by
    // state — a coastal zone that was never itself selected still gets the answer.
    expect(coastalRegulationsPrimed('SC')).toBe(true);
    expect(liveCoastalPolicyFor('SC', 'Red Drum (Redfish)').sizeLimit).toBe('18-25 inches TL');
  });

  it('not primed is null, and null is not an empty answer', () => {
    _resetRegulationsCache();
    expect(coastalRegulationsPrimed('SC')).toBe(false);
    expect(liveCoastalPolicyFor('SC', 'Red Drum (Redfish)')).toBeNull();
  });

  it('primed but silent about a fish is a different answer from not primed', async () => {
    await prime(SC_BOOK);
    const r = liveCoastalPolicyFor('SC', 'Cobia');
    expect(r.scope).toBe('none');
    expect(r.sizeLimit).toBeNull();
  });

  it('a located-but-empty parse is NOT filed as an answer', async () => {
    // Empty-because-it-broke must not be cacheable, the same rule parse_failed enforces for
    // freshwater. A cold coastal cache is the unknown branch, which warns.
    await prime({}, { anchor: 'SIZE & CATCH LIMITS', published: '2026-2027' });
    expect(coastalRegulationsPrimed('SC')).toBe(false);
  });

  it('no located section means no coastal answer at all', async () => {
    await prime(SC_BOOK, null);
    expect(coastalRegulationsPrimed('SC')).toBe(false);
  });
});

describe('a parenthetical is a second name', () => {
  it('splits both forms out', () => {
    expect(nameForms('Speckled Trout (Spotted Seatrout)')).toEqual(['speckled trout', 'spotted seatrout']);
    expect(nameForms('Red Drum (Redfish)')).toEqual(['red drum', 'redfish']);
    expect(nameForms('Sheepshead')).toEqual(['sheepshead']);
    expect(nameForms(null)).toEqual([]);
  });

  it('matches the digest word order against the picker word order', async () => {
    // NEITHER STRING CONTAINS THE OTHER. Without the alias pass the angler is told the book
    // says nothing about seatrout while the book is open at the seatrout row.
    await prime({ 'Spotted Seatrout (Speckled Trout)': { sizeLimit: '14 inch minimum', creelLimit: '10 per day', specialRules: [] } });
    const r = liveCoastalPolicyFor('SC', 'Speckled Trout (Spotted Seatrout)');
    expect(r.scope).toBe('state');
    expect(r.sizeLimit).toBe('14 inch minimum');
  });

  it('the alias pass is whole-form equality, not substring', () => {
    // 'trout' is not one of the FORMS of 'Speckled Trout (Spotted Seatrout)'. The alias pass
    // compares whole names only, so adding it cannot make a bare word claim a longer one.
    //
    // NOTE, because it would otherwise be discovered: findSpecies() has a looser substring pass
    // AFTER this one, longstanding freshwater behaviour, under which 'Trout' does reach
    // 'Speckled Trout'. That pass is not changed here — it is why this test asserts the forms
    // rather than the lookup.
    expect(nameForms('Speckled Trout (Spotted Seatrout)').includes('trout')).toBe(false);
    expect(nameForms('Red Drum (Redfish)').includes('drum')).toBe(false);
  });

  it('an unrelated species is not matched at all', async () => {
    await prime(SC_BOOK);
    expect(liveCoastalPolicyFor('SC', 'Bluegill').scope).toBe('none');
  });
});

describe('parseSizeLimitText — null means "could not read it", never "no limit"', () => {
  it('reads a slot with both ends', () => {
    expect(parseSizeLimitText('18-25 inches TL')).toEqual({ min: 18, max: 25 });
    expect(parseSizeLimitText('18 to 25 inches total length')).toEqual({ min: 18, max: 25 });
    expect(parseSizeLimitText('Slot: 14"-23"')).toEqual({ min: 14, max: 23 });
    expect(parseSizeLimitText('Minimum 18 inches, maximum 25 inches')).toEqual({ min: 18, max: 25 });
  });

  it('never collapses a slot to its minimum', () => {
    // A lost maximum reads as permission: keeping a 30" red drum out of an 18-25" slot is
    // illegal, and this is the single most expensive mistake the file can make.
    const r = parseSizeLimitText('18-25 inches TL');
    expect(r.max).toBe(25);
  });

  it('reads a minimum, whichever side the word is on', () => {
    expect(parseSizeLimitText('14" TL minimum')).toEqual({ min: 14 });
    expect(parseSizeLimitText('Minimum 16 inches')).toEqual({ min: 16 });
    expect(parseSizeLimitText('12 inch minimum, 15 per day')).toEqual({ min: 12 });
  });

  it('does not read the creel limit as the size limit', () => {
    // This is the regression. Matching the digits nearest the word "min" made `10" FL min,
    // 15/day` a FIFTEEN inch minimum — an error that points one way, always making the legal
    // fish bigger than the book does.
    expect(parseSizeLimitText('10" FL min, 15/day')).toEqual({ min: 10 });
  });

  it('refuses rather than guessing', () => {
    expect(parseSizeLimitText('No minimum size limit')).toBeNull();
    expect(parseSizeLimitText('5 per day')).toBeNull();
    expect(parseSizeLimitText('see the table on page 22')).toBeNull();
    expect(parseSizeLimitText('')).toBeNull();
    expect(parseSizeLimitText(null)).toBeNull();
    // A range that runs backwards is a misread, not a slot.
    expect(parseSizeLimitText('25-18 inches')).toBeNull();
  });
});

describe('parseCreelLimitText — per boat is not per person', () => {
  it('reads the ordinary phrasings', () => {
    expect(parseCreelLimitText('1 per person per day')).toBe(1);
    expect(parseCreelLimitText('10/day')).toBe(10);
    expect(parseCreelLimitText('15 per person per day, 45 per boat')).toBe(15);
    expect(parseCreelLimitText('5')).toBe(5);
  });

  it('refuses a vessel limit rather than reporting it as a creel limit', () => {
    // "10 per boat" read as a creel limit hands a solo kayaker ten times the legal answer.
    expect(parseCreelLimitText('2 per boat')).toBeNull();
    expect(parseCreelLimitText('not to exceed 10 per vessel')).toBeNull();
  });

  it('refuses what it cannot read', () => {
    expect(parseCreelLimitText('refer to the chart')).toBeNull();
    expect(parseCreelLimitText(null)).toBeNull();
  });
});

describe('checkCoastalRegulations consults the digest first', () => {
  it('surfaces the published limits instead of the hand-typed ones', async () => {
    await prime(SC_BOOK);
    const r = checkCoastalRegulations('SC', 'Red Drum (Redfish)', AUG, AUG);
    expect(r.limits).toBeTruthy();
    expect(r.limits.sizeLimit).toBe('18-25 inches TL');
    expect(r.limits.scope).toBe('state');
    expect(r.limits.source).toMatch(/SC saltwater digest/);
  });

  it('answers for a species the five-row table has never heard of', async () => {
    await prime(SC_BOOK);
    const r = checkCoastalRegulations('SC', 'Tripletail', AUG, AUG);
    expect(r.regInfo).toBeNull();
    expect(r.limits.sizeLimit).toBe('18 inch minimum');
    // ...and says plainly what it still cannot know.
    expect(r.warnings.some((w) => /No closure information/.test(w))).toBe(true);
  });

  it('carries the digest’s own special rules', async () => {
    await prime(SC_BOOK);
    const r = checkCoastalRegulations('SC', 'Red Drum (Redfish)', AUG, AUG);
    expect(r.warnings.some((w) => /2 per boat/.test(w))).toBe(true);
  });

  it('falls back to the table when nothing is primed', () => {
    _resetRegulationsCache();
    const r = checkCoastalRegulations('SC', 'Red Drum (Redfish)', AUG, AUG);
    expect(r.limits).toBeNull();
    expect(r.regInfo).toBe(COASTAL_REGULATIONS.SC['Red Drum (Redfish)']);
    expect(r.legal).toBe(true);
  });
});

describe('closures stay the table’s job', () => {
  it('a live limit cannot open a closed season', async () => {
    await prime({ 'Speckled Trout (Spotted Seatrout)': { sizeLimit: '14 inch minimum', creelLimit: '3 per day', specialRules: [] } });
    // NC seatrout is shut by proclamation FF-12-2026 in February. The digest publishes limits;
    // a size and a creel limit is not a closure, and no live answer may override one.
    const r = checkCoastalRegulations('NC', 'Speckled Trout (Spotted Seatrout)', new Date('2026-02-15T12:00:00'), AUG);
    expect(r.legal).toBe(false);
    expect(r.reason).toMatch(/Closed season/);
  });

  it('a live limit cannot open an indefinite closure', async () => {
    await prime({ 'Southern Flounder': { sizeLimit: '15 inch minimum', creelLimit: '4 per day', specialRules: [] } });
    const r = checkCoastalRegulations('NC', 'Southern Flounder', AUG, AUG);
    expect(r.legal).toBe(false);
    expect(r.reason).toMatch(/Harvest closed/);
  });

  it('gear windows still warn without blocking', async () => {
    await prime(SC_BOOK);
    const r = checkCoastalRegulations('SC', 'Red Drum (Redfish)', new Date('2026-01-15T12:00:00'), AUG);
    expect(r.legal).toBe(true);
    expect(r.warnings.some((w) => /gig/i.test(w))).toBe(true);
  });
});

describe('the numbers are measured against the book, not dated', () => {
  it('agreement outranks an expired verifyBy', async () => {
    await prime(SC_BOOK, undefined, PAST_SC.getTime());
    const r = checkCoastalRegulations('SC', 'Red Drum (Redfish)', AUG, PAST_SC);
    // verifyBy says 2027-08-14 and `now` is past it — but the book was re-read and says the
    // same thing. An expired date on correct numbers reads to the angler exactly like an
    // expired date on wrong ones.
    expect(r.stale).toBe(false);
    expect(r.warnings.some((w) => /passed their review date/.test(w))).toBe(false);
  });

  it('disagreement names BOTH numbers and never silently prefers one', async () => {
    await prime({ 'Red Drum (Redfish)': { sizeLimit: '15-23 inches TL', creelLimit: '2 per person per day', specialRules: [] } }, undefined, AUG.getTime());
    const r = checkCoastalRegulations('SC', 'Red Drum (Redfish)', AUG, AUG);
    const joined = r.warnings.join(' | ');
    expect(joined).toMatch(/size limit disagrees/);
    expect(joined).toMatch(/18/);          // the table's slot
    expect(joined).toMatch(/15-23/);       // the digest's
    expect(joined).toMatch(/creel limit disagrees/);
  });

  it('an unreadable published limit is surfaced verbatim, not ignored', async () => {
    await prime({ 'Red Drum (Redfish)': { sizeLimit: 'see the table on page 22', creelLimit: 'refer to chart', specialRules: [] } }, undefined, AUG.getTime());
    const r = checkCoastalRegulations('SC', 'Red Drum (Redfish)', AUG, AUG);
    expect(r.warnings.some((w) => /could not read it as a number/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /see the table on page 22/.test(w))).toBe(true);
  });

  it('an expired table with nothing to compare against is still stale', () => {
    _resetRegulationsCache();
    const r = checkCoastalRegulations('SC', 'Red Drum (Redfish)', AUG, PAST_SC);
    expect(r.stale).toBe(true);
    expect(r.warnings.some((w) => /passed their review date/.test(w))).toBe(true);
  });

  it('zero comparisons is not confirmation', () => {
    // The empty set reading as success is how a row with no readable numbers would quietly
    // stop being stale.
    const out = crossCheckLimits({ note: 'no numbers here' },
      { sizeLimit: null, creelLimit: null, source: 'the SC saltwater digest' }, 'Cobia');
    expect(out.confirmed).toBe(false);
  });

  it('the agency’s own caution outranks a clean cross-check', async () => {
    // GA prints "these limits may have changed" beside red drum in its own 2026-2027 table.
    // When the state declines to warrant its own book, agreeing with that book proves nothing.
    _resetRegulationsCache();
    await primeRegulations('GA', 'Savannah River Delta, GA', {
      worker: 'https://w', now: AUG.getTime(),
      fetch: async () => ({ ok: true, json: async () => ({
        ...payload({ 'Red Drum (Redfish)': { sizeLimit: '14-23 inches TL', creelLimit: '5 per person per day', specialRules: [] } }),
        state: 'GA' }) }),
    });
    const r = checkCoastalRegulations('GA', 'Red Drum (Redfish)', AUG, AUG);
    expect(r.stale).toBe(false);
    expect(r.warnings.some((w) => /CoastalGaDNR\.org\/Limits/.test(w))).toBe(true);
  });
});

describe('formatCoastalLimit takes either shape', () => {
  it('still renders the table’s numbers', () => {
    expect(formatCoastalLimit(COASTAL_REGULATIONS.SC['Red Drum (Redfish)']))
      .toBe('18–25" TL slot · 1/day · 2/boat');
  });

  it('renders the digest’s prose without re-parsing it', () => {
    // Re-formatting a published string would mean parsing it first, which is how a slot loses
    // its top end.
    expect(formatCoastalLimit({ sizeLimit: '18-25 inches TL', creelLimit: '1 per person per day' }))
      .toBe('18-25 inches TL · 1 per person per day');
  });

  it('a closure still wins the label', () => {
    expect(formatCoastalLimit(COASTAL_REGULATIONS.NC['Southern Flounder'])).toBe('No open harvest season');
  });
});

describe('it reaches the app', () => {
  it('the species picker shows the digest, not the floor', () => {
    const sel = readFileSync(path.join(REPO, 'js/modules/species-selector.js'), 'utf8');
    expect(sel).toContain('formatCoastalLimit(reg.limits || reg.regInfo)');
  });

  it('the coastal check imports the live layer', () => {
    const src = readFileSync(path.join(REPO, 'js/data/coastal-regulations.js'), 'utf8');
    expect(src).toContain("import { liveCoastalPolicyFor } from './regulations-live.js'");
  });

  it('the Worker returns the saltwater half of the same parse', () => {
    const src = readFileSync(path.join(REPO, 'Worker/trollmap-worker.js'), 'utf8');
    expect(src).toContain('saltwater: stateRegs.saltwater || {}');
    expect(src).toContain('saltwater_source: stateRegs.saltwaterSource || null');
  });

  it('the saltwater parse runs once, not once per digest page', () => {
    // Two pages would otherwise re-locate and re-parse the same section and bill for it twice.
    const src = readFileSync(path.join(REPO, 'Worker/research/clients.js'), 'utf8');
    const loopEnd = src.indexOf('if (SALTWATER_DIGEST[state] && digestText.length)');
    expect(loopEnd > 0).toBe(true);
    // ...and it reads the WHOLE page, not the freshwater-only slice.
    expect(src).toContain('extractSaltwaterDigest(state, digestText.join');
  });

  it('the parser is told the app’s own species keys', () => {
    const src = readFileSync(path.join(REPO, 'Worker/research/clients.js'), 'utf8');
    expect(src).toContain("'Speckled Trout (Spotted Seatrout)'");
  });
});
