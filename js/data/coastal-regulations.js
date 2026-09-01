/**
 * coastal-regulations.js — saltwater size/creel/season rules for SC, GA, NC.
 *
 * WHY THIS EXISTS SEPARATELY FROM species-intel.js REGULATIONS:
 * that table is keyed by individual lake name and had a single catch-all
 * 'Coastal SC Inshore' entry that no coastal zone name actually resolved to.
 * `checkRegulations('Charleston Harbor, SC', 'Red Drum (Redfish)', ...)`
 * returned `{legal: true, note: 'No specific regulation data available'}`,
 * so SmartPlan would happily build a plan for a closed fishery. Coastal rules
 * are also set per STATE rather than per waterbody, so keying by state is both
 * correct and far less to maintain than 21 near-identical zone entries.
 *
 * ── TWO-LAYER DESIGN ───────────────────────────────────────────────────────
 * These values are a BASELINE, not gospel. Saltwater rules change mid-season
 * in ways an annual table cannot express:
 *   - SC red drum changed 2026-07-01 by statute (15-23"/2 -> 18-25"/1).
 *   - NC closes seatrout and flounder by NCDMF proclamation, sometimes with
 *     only days of notice.
 * Every entry therefore carries `verifyBy`. Past that date the app must treat
 * the numbers as unverified and say so, rather than asserting stale limits.
 * The authoritative live layer is the `saltwater_regulations` research agent
 * (Worker/research/coastal-agents.js), which reconciles the R2 digest against
 * a recency-bounded amendment search. When a researched profile exists it wins.
 *
 * Sources: SCDNR 2026-2027 digest, SALTWATER FISHING / SIZE & CATCH LIMITS
 * (the "FINFISH: INSHORE & OFFSHORE" table), effective 2026-08-14 through
 * 2027-08-14; GA DNR CRD 2026-2027 digest, "Finfish Seasons, Limits, Sizes",
 * effective 2026-07-01 through 2027-06-30; NCDMF proclamations FF-12-2026 and
 * the NC Marine Fisheries Commission southern flounder decision.
 *
 * ── THE TABLE BELOW IS THE FLOOR, NOT THE ANSWER (2026-08-20) ──────────────
 * Ryan: *"why would we hard code regulations"* and *"i want it to match freshwater exactly...
 * its the same exact files as freshwater"*. He is right, and it was the same file all along:
 * SCDNR's book is one PDF whose pages 1-18 are freshwater and 21-29 saltwater. The Worker has
 * downloaded the whole thing on every cold /regulations call since 2026-08-03, parsed the
 * freshwater half, and thrown the saltwater half away -- while this table asked a person to
 * re-read those same pages by hand every August.
 *
 * So checkCoastalRegulations() now consults the live digest FIRST, exactly the way
 * checkRegulations() consults livePolicyFor(), off the same endpoint, the same cache and the
 * same prime. What is left below is what the digest does NOT publish and cannot: closures,
 * proclamations, gear windows, and the agency's own "these may have changed" caution. That is
 * the same job REGULATIONS' six hand-written waters already do inland.
 *
 * AND THE NUMBERS ARE NOW MEASURED AGAINST THE BOOK rather than dated. `verifyBy` was a guess
 * about when the values MIGHT move; crossCheckLimits() below says whether they DID, by comparing
 * this table against this year's digest. An expired date on correct numbers reads to the angler
 * exactly like an expired date on wrong ones -- a comparison does not have that problem.
 *
 * Last reviewed: 2026-08-20, against the 2026-2027 PDFs in R2 `regulations/`
 * rather than against a search. EVERY SC AND GA VALUE BELOW WAS UNCHANGED by
 * the new books -- five species each, size, creel, vessel limit and both SC gig
 * closures. The table was not stale; only its `verifyBy` and its citation were,
 * and an expired `verifyBy` on correct numbers reads to the angler exactly like
 * an expired one on wrong numbers. That is the cost of dating the review rather
 * than the data.
 */

import { liveCoastalPolicyFor, coastalClosuresFor } from './regulations-live.js';

export const COASTAL_SPECIES_LIST = [
  'Red Drum (Redfish)',
  'Speckled Trout (Spotted Seatrout)',
  'Southern Flounder',
  'Black Drum',
  'Sheepshead',
];

/**
 * closedSeason: [startMonth, startDay, endMonth, endDay] — inclusive, may wrap
 *               the year boundary.
 * harvestClosed: true means closed with no fixed reopen date (proclamation).
 * gearClosure: a restriction that does NOT block hook-and-line angling, so it
 *              is surfaced as a warning rather than a hard block.
 */
export const COASTAL_REGULATIONS = {
  SC: {
    _meta: {
      agency: 'SCDNR Marine Resources',
      digest: '2026-2027',
      // The digest's own validity window, not a guessed cadence: the SC book is
      // stamped 2026-08-14 through 2027-08-14, so that is the date on which it
      // stops claiming to be current. Verified against it 2026-08-20.
      //
      // A statute or proclamation can still supersede this mid-year -- SC red drum
      // moved on 2026-07-01 that way -- which is what `effectiveFrom` on a species
      // row is for, and what the saltwater_regulations research agent exists to
      // catch. verifyBy is the backstop, not the mechanism.
      effectiveFrom: '2026-08-14',
      verifyBy: '2027-08-14',
      url: 'https://saltwaterfishing.sc.gov',
    },
    'Red Drum (Redfish)': {
      sizeLimit: { min: 18, max: 25 },
      creelLimit: 1,
      vesselLimit: 2,
      measurement: 'TL',
      gearClosure: { window: [12, 1, 2, 28], gear: 'gig', note: 'May not be harvested by gig Dec 1 – Feb 28.' },
      note: 'SC slot 18–25" TL, 1/person/day, 2/boat. Changed 2026-07-01 (was 15–23", 2/day) — ASMFC stock rebuilding.',
      effectiveFrom: '2026-07-01',
    },
    'Speckled Trout (Spotted Seatrout)': {
      sizeLimit: { min: 14 },
      creelLimit: 10,
      measurement: 'TL',
      gearClosure: { window: [12, 1, 2, 28], gear: 'gig', note: 'May not be harvested by gig Dec 1 – Feb 28.' },
      note: '14" TL minimum, 10/person/day. Watch for cold-stun closures after hard freezes.',
    },
    'Southern Flounder': {
      sizeLimit: { min: 16 },
      creelLimit: 5,
      vesselLimit: 10,
      measurement: 'TL',
      note: '16" TL minimum, 5/person/day, 10/boat. Applies to southern, summer and gulf flounder combined.',
    },
    'Black Drum':  { sizeLimit: { min: 14, max: 27 }, creelLimit: 5, measurement: 'TL', note: '14–27" TL slot, 5/day.' },
    'Sheepshead':  { sizeLimit: { min: 14 }, creelLimit: 10, vesselLimit: 30, measurement: 'TL', note: '14" TL min, 10/day, 30/boat.' },
  },

  GA: {
    _meta: {
      agency: 'GA DNR Coastal Resources Division',
      digest: '2026-2027',
      // GA runs a fiscal-year book: "effective for the period of July 1, 2026
      // through June 30, 2027". Verified against it 2026-08-20.
      //
      // The GA table prints its own caution beside red drum -- "These limits and
      // sizes may have changed. Please check CoastalGaDNR.org/Limits for the most
      // up-to-date regulations" -- so the state does not warrant its own book for
      // that species. Carried onto the row below rather than left in a PDF.
      effectiveFrom: '2026-07-01',
      verifyBy: '2027-06-30',
      url: 'https://coastalgadnr.org',
    },
    'Red Drum (Redfish)': {
      sizeLimit: { min: 14, max: 23 },
      creelLimit: 5,
      measurement: 'TL',
      // GA DNR prints this warning against red drum in its own 2026-2027 table.
      verifyAlways: 'Georgia flags red drum limits as subject to change — confirm at '
                  + 'CoastalGaDNR.org/Limits before harvesting.',
      note: 'GA slot 14–23" TL, 5/person/day.',
    },
    'Speckled Trout (Spotted Seatrout)': {
      sizeLimit: { min: 14 },
      creelLimit: 15,
      measurement: 'TL',
      note: '14" TL minimum, 15/person/day.',
    },
    'Southern Flounder': {
      sizeLimit: { min: 12 },
      creelLimit: 15,
      measurement: 'TL',
      note: '12" TL minimum, 15/person/day. Gig is the only legal spear-type gear for flounder.',
    },
    'Black Drum': { sizeLimit: { min: 14 }, creelLimit: 15, measurement: 'TL', note: '14" TL min, 15/day.' },
    'Sheepshead': { sizeLimit: { min: 10 }, creelLimit: 15, measurement: 'FL', note: '10" FL min, 15/day.' },
  },

  // ── NC REMOVED 2026-09-01 ─────────────────────────────────────────────────
  //
  // Ryan: "the new regs are out... they have been parsed... i plan to cut all coastal areas from
  // NC anyways."
  //
  // This block was a hand-typed copy of NCDMF's rules with a `verifyBy` of 2026-09-01, and that
  // date came due during the session that removed it. The expiry was not the problem; the copy
  // was. It is the same shape as the REGULATIONS table deleted from species-intel.js on
  // 2026-08-27 -- thirteen hand-typed rows against a parser that reads the book itself -- and it
  // failed the same way: a slot limit typed once, going stale silently while a proclamation
  // replaced it.
  //
  // SC and GA stay for now because nothing has replaced them yet. When the parser covers them,
  // this whole table goes the way this block did.
};

/** Inclusive month/day window test that tolerates wrapping the new year. */
function inWindow(date, [sm, sd, em, ed]) {
  const d = date instanceof Date ? date : new Date(date);
  const v = (d.getMonth() + 1) * 100 + d.getDate();
  const start = sm * 100 + sd;
  const end = em * 100 + ed;
  return start <= end ? (v >= start && v <= end) : (v >= start || v <= end);
}

/** Normalise loose UI labels onto the canonical species keys. */
export function canonicalCoastalSpecies(name) {
  const s = String(name || '').toLowerCase();
  if (/red\s*drum|redfish|spot ?tail|channel bass/.test(s)) return 'Red Drum (Redfish)';
  if (/speck|seatrout|sea trout|spotted trout/.test(s))     return 'Speckled Trout (Spotted Seatrout)';
  if (/flounder|flatfish|doormat/.test(s))                  return 'Southern Flounder';
  if (/black\s*drum/.test(s))                               return 'Black Drum';
  if (/sheepshead|convict/.test(s))                         return 'Sheepshead';
  return null;
}

/** True when a species is one we hold saltwater rules for. */
export function isCoastalSpecies(name) {
  return canonicalCoastalSpecies(name) !== null;
}

/**
 * The inches in a published size limit, as {min?, max?} -- or null when the string cannot be read.
 *
 * NULL MEANS "COULD NOT READ IT", NEVER "NO LIMIT". Those are the same absence and only one of
 * them is permission. Every caller here treats null as "say the text out loud and let the angler
 * read it", not as agreement.
 *
 * A RANGE IS A SLOT AND BOTH ENDS COUNT. Collapsing "18-25 inches" to a minimum of 18 turns an
 * illegal 30 inch red drum into a legal one, which is the single most expensive mistake this
 * file can make.
 */
export function parseSizeLimitText(text) {
  const s = String(text == null ? '' : text).replace(/[\u2013\u2014\u2212]/g, '-');
  if (!/\d/.test(s)) return null;
  const N = '(\\d{1,3}(?:\\.\\d)?)';
  const range = s.match(new RegExp(N + '\\s*(?:"|\'\'|in(?:ch(?:es)?)?)?\\s*(?:-|to)\\s*' + N, 'i'));
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    // A "range" that runs backwards is not a slot, it is a misread. Refuse rather than invert it.
    return hi > lo ? { min: lo, max: hi } : null;
  }

  // ONLY NUMBERS CARRYING A LENGTH UNIT COUNT. This started out reading the digits nearest the
  // word "min", and on `10" FL min, 15/day` that is the CREEL limit -- it reported a 15 inch
  // minimum for a 10 inch fish. A creel limit misread as a size limit is a measurement whose
  // error points one way: it always makes the legal fish bigger than the book does.
  const units = [...s.matchAll(/(\d{1,3}(?:\.\d)?)\s*(?:"|''|inches\b|inch\b|in\b)/gi)];
  if (!units.length || units.length > 2) return null;

  const minAt = s.search(/min(?:imum)?\b|at least|no smaller than|no less than|over\b/i);
  const maxAt = s.search(/max(?:imum)?\b|no longer than|not (?:more|greater) than|under\b/i);

  if (units.length === 1) {
    const v = Number(units[0][1]);
    if (maxAt >= 0 && minAt < 0) return { max: v };
    // A lone length with no qualifier is a minimum -- that is what a digest means by "14\" TL",
    // and it is the same reading formatCoastalLimit() prints.
    return { min: v };
  }

  // Two lengths and no range punctuation: only readable when the book names both ends.
  if (minAt < 0 || maxAt < 0) return null;
  const first = Number(units[0][1]);
  const second = Number(units[1][1]);
  const [lo, hi] = minAt < maxAt ? [first, second] : [second, first];
  return hi > lo ? { min: lo, max: hi } : null;
}

/**
 * The fish-per-person-per-day in a published creel limit, or null when it cannot be read.
 *
 * PER BOAT IS NOT PER PERSON. "10 per boat" read as a creel limit hands a solo kayaker ten times
 * the legal answer, so a vessel limit deliberately parses to null rather than to its number.
 */
export function parseCreelLimitText(text) {
  const s = String(text == null ? '' : text).replace(/[\u2013\u2014\u2212]/g, '-');
  if (!/\d/.test(s)) return null;
  const per = s.match(/(\d{1,3})\s*(?:fish\s*)?(?:per|\/)\s*(?:person|angler|day\b|d\b)/i);
  if (per) return Number(per[1]);
  const bare = s.match(/^\s*(\d{1,3})\s*$/);
  if (bare) return Number(bare[1]);
  return null;
}

/**
 * This table's row against this year's digest. Three outcomes, three different sentences.
 *
 *   confirmed   the book was re-read and says the same thing -- say nothing, and the row is not
 *               stale no matter what date is printed on it
 *   disagree    name BOTH numbers. NEVER silently prefer one: a hand-typed table that is right
 *               and a digest parse that is right are both possible, and so is the reverse
 *   unreadable  the digest text did not parse -- surface it verbatim, because a limit we cannot
 *               read is not a limit we may ignore
 *
 * @returns {{confirmed: boolean, warnings: string[]}}
 */
export function crossCheckLimits(reg, limits, species) {
  const warnings = [];
  if (!reg || !limits) return { confirmed: false, warnings };
  const src = limits.source || 'the state digest';
  let checks = 0;
  let agreed = 0;

  const liveSize = parseSizeLimitText(limits.sizeLimit);
  if (limits.sizeLimit && !liveSize) {
    warnings.push(`${src} states the ${species} size limit as "${limits.sizeLimit}" and this app `
      + `could not read it as a number — go by the digest, not by the summary shown here.`);
  } else if (liveSize && reg.sizeLimit) {
    checks++;
    const wantMin = reg.sizeLimit.min ?? null;
    const wantMax = reg.sizeLimit.max ?? null;
    const gotMin = liveSize.min ?? null;
    const gotMax = liveSize.max ?? null;
    if (wantMin === gotMin && wantMax === gotMax) agreed++;
    else {
      warnings.push(`${species} size limit disagrees: this app's table says `
        + `${describeSize(wantMin, wantMax)} and ${src} says "${limits.sizeLimit}". `
        + `Go by the digest and verify before you keep one.`);
    }
  }

  const liveCreel = parseCreelLimitText(limits.creelLimit);
  if (limits.creelLimit && liveCreel == null) {
    warnings.push(`${src} states the ${species} creel limit as "${limits.creelLimit}" and this `
      + `app could not read it as a number — go by the digest, not by the summary shown here.`);
  } else if (liveCreel != null && reg.creelLimit != null) {
    checks++;
    if (Number(reg.creelLimit) === liveCreel) agreed++;
    else {
      warnings.push(`${species} creel limit disagrees: this app's table says ${reg.creelLimit}/day `
        + `and ${src} says "${limits.creelLimit}". Go by the digest and verify before you keep one.`);
    }
  }

  // CONFIRMED MEANS EVERY COMPARISON THAT COULD BE MADE WAS MADE AND AGREED. Zero comparisons is
  // not confirmation -- that is the empty set reading as success, and it is how a row with no
  // readable numbers would quietly stop being stale.
  return { confirmed: checks > 0 && agreed === checks, warnings };
}

function describeSize(min, max) {
  // "a 18 inch slot" reads as a typo to the person being warned about a mismatch, which is
  // exactly the moment the sentence needs to sound like it was checked.
  const art = (n) => (/^(8|11|18)/.test(String(n)) ? 'an' : 'a');
  if (min != null && max != null) return `${art(min)} ${min}–${max}" slot`;
  if (min != null) return `${art(min)} ${min}" minimum`;
  if (max != null) return `${art(max)} ${max}" maximum`;
  return 'no size limit';
}

/** The one-line "here is what the book says" sentence, used wherever limits are surfaced. */
function limitsSentence(species, limits) {
  return `${species}: ${limits.sizeLimit || 'no stated size limit'} / `
       + `${limits.creelLimit || 'no stated creel limit'} (${limits.source}).`;
}

/** The label that says WHICH book answered, including the year it was published. */
function liveSourceLabel(st, live) {
  const pub = live && live.source && live.source.published;
  // The published string already carries its own parenthetical -- "2026-2027 (effective August
  // 14, 2026)" -- so wrapping it in another set gives "digest (2026-2027 (effective ...))".
  return pub ? `the ${st} saltwater digest ${pub}` : `the ${st} saltwater digest`;
}

/**
 * Saltwater legality check, shaped exactly like species-intel.js
 * checkRegulations() so smart-plan.js can use either interchangeably.
 *
 * @param {string} stateCode  'SC' | 'GA' | 'NC'
 * @param {string} species    UI label or canonical key
 * @param {Date|string} date  trip date
 * @param {Date} [now]        for deterministic verifyBy tests
 * @returns {{legal:boolean, reason:string|null, regInfo:object|null,
 *            note:string|null, warnings:string[], stale:boolean}}
 */
export function checkCoastalRegulations(stateCode, species, date, now = new Date()) {
  const st = String(stateCode || '').toUpperCase();
  const table = COASTAL_REGULATIONS[st];
  const key = canonicalCoastalSpecies(species);
  const warnings = [];

  // THE LIVE DIGEST FIRST, exactly the way species-intel.js checkRegulations() consults
  // livePolicyFor(). Same endpoint, same cache, same prime: /regulations?state=SC returns the
  // saltwater half off the download that already answers for freshwater, so a coastal zone costs
  // no extra fetch and no extra agent.
  //
  // A COLD CACHE IS NOT A PASS. `null` here means nobody has read the book, and everything below
  // falls back to the hand-typed table with its dated caution intact.
  const live = liveCoastalPolicyFor(st, key || species);
  const limits = live && live.scope !== 'none'
    ? { sizeLimit: live.sizeLimit, creelLimit: live.creelLimit, scope: live.scope,
        species: live.species, state: live.state || st,
        specialRules: live.specialRules || [],
        source: liveSourceLabel(st, live) }
    : null;

  // The digest's own special rules travel whether or not the table below knows this fish. Vessel
  // limits and closed-season prose live here, and dropping them because a species is missing from
  // a five-row table is how a published rule goes unsaid.
  if (limits) for (const r of limits.specialRules) if (r) warnings.push(`${limits.source}: ${r}`);

  const d0 = date instanceof Date ? date : new Date(date);

  // THE BOOK COMES FIRST, AND THE TABLE BELOW IS THE FLOOR -- the same order species-intel.js
  // now uses for freshwater.
  //
  // This table has FIVE species per state and the coast has dozens. Atlantic sturgeon is the
  // case that shows it: GA's book says `No Harvest` in a column headed OPEN SEASON, the fish is
  // nowhere in the rows below, and the `!reg` branch answered `legal: true` with "No closure
  // information for this species". A no-harvest species reading as legal is the wrong direction.
  //
  // ALL of them, not the first. A freshwater water with two blocking closures reported one and
  // dropped the other on 2026-08-27; the same mistake is available here and this does not make
  // it. Everything not blocking is still carried, because the book's sentence is what a person
  // can check.
  const book = coastalClosuresFor(st, species, d0);
  if (book) {
    for (const c of book.warnings) {
      warnings.push(`${book.source || 'the state book'}: ${c.text}`
        + (c.effect === 'open_only' ? ' — that is the OPEN season, and today is outside it.' : ''));
    }
    if (book.blocking.length) {
      const shut = book.blocking.map((c) => c.text).join('; ');
      const who = book.blocking.every((c) => c.applies_to === 'harvest') ? 'Harvest closed'
        : 'Closed';
      return {
        legal: false,
        reason: `${who} — ${book.source || 'the state book'}: ${shut}`,
        regInfo: (table && key) ? (table[key] || null) : null,
        limits, warnings, stale: false, note: shut, source: book.source || null,
      };
    }
  }

  if (!table) {
    if (limits) warnings.push(limitsSentence(species, limits));
    return {
      legal: true, reason: null, regInfo: null, limits, warnings, stale: false,
      note: limits ? limitsSentence(species, limits)
        : `No saltwater regulation data for "${stateCode}" — verify with the state agency before keeping fish.`,
    };
  }

  const meta = table._meta;
  const reg = key ? table[key] : null;
  // Past verifyBy the printed numbers may already have been superseded -- unless the digest was
  // read and agreed with them, which is checked below and outranks the date.
  const expired = !!(meta?.verifyBy && new Date(meta.verifyBy) < now);
  const cross = (reg && limits) ? crossCheckLimits(reg, limits, key) : null;
  const stale = expired && !(cross && cross.confirmed);

  if (stale) {
    warnings.push(
      `${meta.agency} limits below are from the ${meta.digest} cycle and passed their ` +
      `review date (${meta.verifyBy}) — confirm at ${meta.url} before harvesting.`
    );
  }

  if (!reg) {
    // NOT IN THE TABLE IS NOT THE SAME AS NOT IN THE BOOK. Sheepshead is one of five rows here
    // and the digest carries a dozen more species, so a live answer for a fish this table has
    // never heard of is the ordinary case, not the exotic one.
    if (limits) warnings.push(limitsSentence(species, limits)
      + ' No closure information for this species — verify before you keep one.');
    else if (live) warnings.push(`The ${st} saltwater digest was read and lists nothing for `
      + `"${species}". Verify before you keep one.`);
    return {
      legal: true, reason: null, regInfo: null, limits, warnings, stale,
      note: limits ? limitsSentence(species, limits)
        : `No specific ${st} saltwater regulation for "${species}" — verify locally before fishing.`,
    };
  }

  const d = date instanceof Date ? date : new Date(date);

  // A CAUTION THE AGENCY PRINTS ITSELF OUTRANKS verifyBy, and does not expire with it.
  // GA DNR's own 2026-2027 finfish table says red drum limits "may have changed" and points at
  // CoastalGaDNR.org/Limits. When the state declines to warrant its own book for a species, a
  // date on OUR side cannot make it current, and neither can a clean cross-check against the
  // very book carrying the caution. So this fires unconditionally.
  if (reg.verifyAlways) warnings.push(reg.verifyAlways);

  // CLOSURES ARE THE TABLE'S JOB AND THE TABLE'S ALONE. The digest publishes limits; a size and
  // a creel limit is not a closure, and no amount of live data can tell you a season is shut.
  // That is why this table survives at all.
  if (reg.harvestClosed) {
    return {
      legal: false,
      reason: `Harvest closed: ${reg.note}`,
      regInfo: reg, limits, warnings, stale, note: reg.note,
    };
  }

  if (reg.closedSeason && inWindow(d, reg.closedSeason)) {
    const [sm, sd, em, ed] = reg.closedSeason;
    const proc = reg.proclamation ? ` (${reg.proclamation})` : '';
    return {
      legal: false,
      reason: `Closed season ${sm}/${sd}–${em}/${ed}${proc}: ${reg.note}`,
      regInfo: reg, limits, warnings, stale, note: reg.note,
    };
  }

  // Gear restrictions never block rod-and-reel, so warn instead of blocking.
  if (reg.gearClosure && inWindow(d, reg.gearClosure.window)) {
    warnings.push(reg.gearClosure.note);
  }

  // The measured disagreement, after the closures, because a closure is the louder fact.
  if (cross) for (const w of cross.warnings) warnings.push(w);

  return { legal: true, reason: null, regInfo: reg, limits, warnings, stale, note: reg.note };
}

/** Human-readable limit summary, e.g. '18–25" TL slot · 1/day · 2/boat'. */
export function formatCoastalLimit(reg) {
  if (!reg) return '';
  if (reg.harvestClosed) return 'No open harvest season';
  // THE DIGEST SPEAKS IN PROSE AND THE TABLE IN NUMBERS, and both shapes land here -- callers
  // pass `check.limits || check.regInfo`. A published string is already the sentence;
  // re-formatting it would mean parsing it first, which is how a slot loses its top end.
  if (typeof reg.sizeLimit === 'string' || typeof reg.creelLimit === 'string') {
    return [reg.sizeLimit, reg.creelLimit]
      .filter(v => typeof v === 'string' && v.trim())
      .map(v => v.trim())
      .join(' · ');
  }
  const bits = [];
  if (reg.sizeLimit?.min != null && reg.sizeLimit?.max != null) {
    bits.push(`${reg.sizeLimit.min}–${reg.sizeLimit.max}" ${reg.measurement || 'TL'} slot`);
  } else if (reg.sizeLimit?.min != null) {
    bits.push(`${reg.sizeLimit.min}" ${reg.measurement || 'TL'} min`);
  }
  if (reg.creelLimit != null) bits.push(`${reg.creelLimit}/day`);
  if (reg.vesselLimit != null) bits.push(`${reg.vesselLimit}/boat`);
  return bits.join(' · ');
}
