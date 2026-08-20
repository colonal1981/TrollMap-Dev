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
 * Last reviewed: 2026-08-20, against the 2026-2027 PDFs in R2 `regulations/`
 * rather than against a search. EVERY SC AND GA VALUE BELOW WAS UNCHANGED by
 * the new books -- five species each, size, creel, vessel limit and both SC gig
 * closures. The table was not stale; only its `verifyBy` and its citation were,
 * and an expired `verifyBy` on correct numbers reads to the angler exactly like
 * an expired one on wrong numbers. That is the cost of dating the review rather
 * than the data.
 */

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

  NC: {
    _meta: {
      agency: 'NC Division of Marine Fisheries (NCDMF)',
      digest: 'proclamation-driven',
      // NC changes by proclamation with little notice — verify often.
      verifyBy: '2026-09-01',
      url: 'https://deq.nc.gov/about/divisions/marine-fisheries',
    },
    'Red Drum (Redfish)': {
      sizeLimit: { min: 18, max: 27 },
      creelLimit: 1,
      measurement: 'TL',
      note: 'NC slot 18–27" TL, 1/person/day. Harvest must be reported to NCDMF.',
    },
    'Speckled Trout (Spotted Seatrout)': {
      // Proclamation FF-12-2026 closed all coastal and joint waters on
      // 2026-02-06 after widespread cold-stun events; scheduled to reopen by
      // proclamation on 2026-07-01. Encoded as a dated window so the block
      // lifts automatically, but verifyBy still forces confirmation.
      closedSeason: [2, 6, 6, 30],
      sizeLimit: { min: 14, max: 20 },
      creelLimit: 3,
      measurement: 'TL',
      note: 'Closed 6 Feb – 30 Jun 2026 by NCDMF proclamation FF-12-2026 (cold stun). Reopens by proclamation — confirm before harvesting. Slot 14–20", 1 fish over 26" allowed, 3/day.',
      proclamation: 'FF-12-2026',
    },
    'Southern Flounder': {
      // The Marine Fisheries Commission declined to set a recreational season
      // in coastal waters; southern flounder remain overfished. A narrow gulf
      // flounder opening exists but is a different species and area.
      harvestClosed: true,
      measurement: 'TL',
      note: 'No recreational southern flounder season in NC coastal waters — stock is overfished and overfishing is occurring. A limited gulf-flounder season may open by proclamation in specific areas only. Catch-and-release only unless NCDMF says otherwise.',
    },
    'Black Drum': { sizeLimit: { min: 14 }, creelLimit: 10, measurement: 'TL', note: '14" TL min, 10/day.' },
    'Sheepshead': { sizeLimit: { min: 14 }, creelLimit: 5, measurement: 'TL', note: '14" TL min, 5/day.' },
  },
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

  if (!table) {
    return {
      legal: true, reason: null, regInfo: null, warnings, stale: false,
      note: `No saltwater regulation data for "${stateCode}" — verify with the state agency before keeping fish.`,
    };
  }

  const meta = table._meta;
  // Past verifyBy the printed numbers may already have been superseded.
  const stale = !!(meta?.verifyBy && new Date(meta.verifyBy) < now);
  if (stale) {
    warnings.push(
      `${meta.agency} limits below are from the ${meta.digest} cycle and passed their ` +
      `review date (${meta.verifyBy}) — confirm at ${meta.url} before harvesting.`
    );
  }

  if (!key || !table[key]) {
    return {
      legal: true, reason: null, regInfo: null, warnings, stale,
      note: `No specific ${st} saltwater regulation for "${species}" — verify locally before fishing.`,
    };
  }

  const reg = table[key];
  const d = date instanceof Date ? date : new Date(date);

  // A CAUTION THE AGENCY PRINTS ITSELF OUTRANKS verifyBy, and does not expire with it.
  // GA DNR's own 2026-2027 finfish table says red drum limits "may have changed" and points at
  // CoastalGaDNR.org/Limits. When the state declines to warrant its own book for a species, a
  // date on OUR side cannot make it current, so this fires whether or not the digest is stale.
  if (reg.verifyAlways) warnings.push(reg.verifyAlways);

  // Indefinite closure (no scheduled reopen).
  if (reg.harvestClosed) {
    return {
      legal: false,
      reason: `Harvest closed: ${reg.note}`,
      regInfo: reg, warnings, stale, note: reg.note,
    };
  }

  // Dated closure window.
  if (reg.closedSeason && inWindow(d, reg.closedSeason)) {
    const [sm, sd, em, ed] = reg.closedSeason;
    const proc = reg.proclamation ? ` (${reg.proclamation})` : '';
    return {
      legal: false,
      reason: `Closed season ${sm}/${sd}–${em}/${ed}${proc}: ${reg.note}`,
      regInfo: reg, warnings, stale, note: reg.note,
    };
  }

  // Gear restrictions never block rod-and-reel, so warn instead of blocking.
  if (reg.gearClosure && inWindow(d, reg.gearClosure.window)) {
    warnings.push(reg.gearClosure.note);
  }

  return { legal: true, reason: null, regInfo: reg, warnings, stale, note: reg.note };
}

/** Human-readable limit summary, e.g. '18–25" TL slot · 1/day · 2/boat'. */
export function formatCoastalLimit(reg) {
  if (!reg) return '';
  if (reg.harvestClosed) return 'No open harvest season';
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
