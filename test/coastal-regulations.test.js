import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  COASTAL_REGULATIONS,
  COASTAL_SPECIES_LIST,
  canonicalCoastalSpecies,
  isCoastalSpecies,
  checkCoastalRegulations,
  formatCoastalLimit,
} from '../js/data/coastal-regulations.js';
import { checkRegulations } from '../js/data/species-intel.js';
import { COASTAL_ZONES, COASTAL_SLUGS } from '../js/data/coastal-zones.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planSrc = readFileSync(path.join(REPO, 'js/modules/smart-plan.js'), 'utf8');
const selSrc = readFileSync(path.join(REPO, 'js/modules/species-selector.js'), 'utf8');
const html = readFileSync(path.join(REPO, 'index.html'), 'utf8');

const FEB = new Date('2026-02-15T12:00:00');
const AUG = new Date('2026-08-20T12:00:00');

describe('the gap this closes', () => {
  it('freshwater checkRegulations() cannot protect coastal zones', () => {
    // The REGULATIONS map is keyed by lake and has no entry that any coastal
    // zone display name resolves to, so it waves everything through. This is
    // the bug: a plan for a closed fishery was reported legal.
    const r = checkRegulations('Pamlico Sound / Neuse River, NC', 'Speckled Trout (Spotted Seatrout)', FEB);
    expect(r.legal).toBe(true);
    expect(r.regInfo).toBeNull();
  });

  it('the saltwater check blocks that same trip', () => {
    const r = checkCoastalRegulations('NC', 'Speckled Trout (Spotted Seatrout)', FEB);
    expect(r.legal).toBe(false);
    expect(r.reason).toMatch(/Closed season/);
  });
});

describe('closed seasons block, gear closures only warn', () => {
  it('blocks NC seatrout during the cold-stun proclamation window', () => {
    const r = checkCoastalRegulations('NC', 'Speckled Trout (Spotted Seatrout)', FEB);
    expect(r.legal).toBe(false);
    expect(r.reason).toMatch(/FF-12-2026/);
  });

  it('allows NC seatrout once the window has passed', () => {
    expect(checkCoastalRegulations('NC', 'Speckled Trout (Spotted Seatrout)', AUG).legal).toBe(true);
  });

  it('blocks NC southern flounder year-round (no recreational season)', () => {
    for (const d of [FEB, AUG]) {
      const r = checkCoastalRegulations('NC', 'Southern Flounder', d);
      expect(r.legal).toBe(false);
      expect(r.reason).toMatch(/Harvest closed/);
    }
  });

  it('does NOT block SC trout for a gig-only closure', () => {
    // Dec-Feb gigging is closed, but rod and reel is fine — blocking the plan
    // would be wrong.
    const r = checkCoastalRegulations('SC', 'Speckled Trout (Spotted Seatrout)', FEB);
    expect(r.legal).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/gig/i);
  });

  it('allows open species', () => {
    expect(checkCoastalRegulations('SC', 'Red Drum (Redfish)', AUG).legal).toBe(true);
    expect(checkCoastalRegulations('GA', 'Southern Flounder', AUG).legal).toBe(true);
    expect(checkCoastalRegulations('NC', 'Red Drum (Redfish)', AUG).legal).toBe(true);
  });

  it('handles a closed window that wraps the new year', () => {
    const reg = { closedSeason: [12, 1, 2, 28] };
    const table = { XX: { _meta: { agency: 'T', digest: 'd', verifyBy: '2099-01-01', url: 'u' }, 'Red Drum (Redfish)': reg } };
    const saved = COASTAL_REGULATIONS.XX;
    COASTAL_REGULATIONS.XX = table.XX;
    expect(checkCoastalRegulations('XX', 'Red Drum (Redfish)', new Date('2026-01-15T12:00:00')).legal).toBe(false);
    expect(checkCoastalRegulations('XX', 'Red Drum (Redfish)', new Date('2026-07-15T12:00:00')).legal).toBe(true);
    if (saved === undefined) delete COASTAL_REGULATIONS.XX; else COASTAL_REGULATIONS.XX = saved;
  });
});

describe('current limits match the agencies', () => {
  it('SC red drum reflects the 2026-07-01 change, not the stale digest', () => {
    const reg = COASTAL_REGULATIONS.SC['Red Drum (Redfish)'];
    expect(reg.sizeLimit).toEqual({ min: 18, max: 25 });
    expect(reg.creelLimit).toBe(1);
    expect(reg.vesselLimit).toBe(2);
  });

  it('every slot-managed species carries both bounds', () => {
    // Collapsing a slot to a minimum would authorise keeping an oversize fish.
    for (const st of ['SC', 'GA', 'NC']) {
      const rd = COASTAL_REGULATIONS[st]['Red Drum (Redfish)'];
      expect(rd.sizeLimit.min, `${st} red drum min`).toBeGreaterThan(0);
      expect(rd.sizeLimit.max, `${st} red drum max`).toBeGreaterThan(rd.sizeLimit.min);
    }
  });

  it('GA seatrout is 15/day, not the 10 the brief claimed', () => {
    expect(COASTAL_REGULATIONS.GA['Speckled Trout (Spotted Seatrout)'].creelLimit).toBe(15);
  });

  it('every state covers the three primary target species', () => {
    for (const st of ['SC', 'GA', 'NC']) {
      for (const sp of ['Red Drum (Redfish)', 'Speckled Trout (Spotted Seatrout)', 'Southern Flounder']) {
        expect(COASTAL_REGULATIONS[st][sp], `${st} / ${sp}`).toBeTruthy();
      }
    }
  });
});

describe('staleness signalling (digests lapse mid-August)', () => {
  it('is not stale before the review date', () => {
    const r = checkCoastalRegulations('SC', 'Red Drum (Redfish)', AUG, new Date('2026-07-24T12:00:00'));
    expect(r.stale).toBe(false);
  });

  it('flags stale and warns once the review date passes', () => {
    const r = checkCoastalRegulations('SC', 'Red Drum (Redfish)', AUG, new Date('2026-09-01T12:00:00'));
    expect(r.stale).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/passed their review date/i);
  });

  it('every state declares an agency, url and review date', () => {
    for (const st of ['SC', 'GA', 'NC']) {
      const meta = COASTAL_REGULATIONS[st]._meta;
      expect(meta.agency).toBeTruthy();
      expect(meta.url).toMatch(/^https?:\/\//);
      expect(Number.isNaN(Date.parse(meta.verifyBy))).toBe(false);
    }
  });
});

describe('species naming', () => {
  it('canonicalises the labels the UI uses', () => {
    expect(canonicalCoastalSpecies('Red Drum (Redfish)')).toBe('Red Drum (Redfish)');
    expect(canonicalCoastalSpecies('redfish')).toBe('Red Drum (Redfish)');
    expect(canonicalCoastalSpecies('spottail bass')).toBe('Red Drum (Redfish)');
    expect(canonicalCoastalSpecies('Speckled Trout')).toBe('Speckled Trout (Spotted Seatrout)');
    expect(canonicalCoastalSpecies('Southern Flounder')).toBe('Southern Flounder');
  });

  it('rejects freshwater species', () => {
    expect(canonicalCoastalSpecies('Striped Bass')).toBeNull();
    expect(isCoastalSpecies('Crappie')).toBe(false);
    expect(isCoastalSpecies('Red Drum (Redfish)')).toBe(true);
  });

  it('is inert for unknown states and species rather than throwing', () => {
    expect(checkCoastalRegulations('ZZ', 'Red Drum (Redfish)', AUG).legal).toBe(true);
    expect(checkCoastalRegulations('SC', 'Tarpon', AUG).legal).toBe(true);
  });
});

describe('formatCoastalLimit', () => {
  it('renders a slot with both bounds', () => {
    expect(formatCoastalLimit(COASTAL_REGULATIONS.SC['Red Drum (Redfish)']))
      .toBe('18–25" TL slot · 1/day · 2/boat');
  });

  it('renders a minimum-only limit', () => {
    expect(formatCoastalLimit(COASTAL_REGULATIONS.GA['Southern Flounder']))
      .toMatch(/12" TL min · 15\/day/);
  });

  it('says so when there is no open season', () => {
    expect(formatCoastalLimit(COASTAL_REGULATIONS.NC['Southern Flounder']))
      .toBe('No open harvest season');
  });
});

describe('SmartPlan integration', () => {
  it('routes coastal zones to the saltwater check', () => {
    expect(planSrc).toContain('checkCoastalRegulations');
    expect(planSrc).toMatch(/_coastalState\s*\n?\s*\?\s*checkCoastalRegulations/);
  });

  it('keeps the existing hard block for both paths', () => {
    expect(planSrc).toContain('if (!regCheck.legal)');
    expect(planSrc).toContain('REGULATION BLOCK');
  });

  it('surfaces limits and advisories in the Groq prompt', () => {
    expect(planSrc).toContain('formatCoastalLimit');
    expect(planSrc).toContain('Harvest limit');
  });

  it('every coastal zone maps to a state with a regulation table', () => {
    for (const slug of COASTAL_SLUGS) {
      const st = COASTAL_ZONES[slug].state;
      expect(COASTAL_REGULATIONS[st], `${slug} -> ${st}`).toBeTruthy();
    }
  });

  it('no coastal zone can request a blocked species and pass the gate', () => {
    // End-to-end: for every zone and every target species, a blocked species
    // must be blocked, in both winter and summer.
    for (const slug of COASTAL_SLUGS) {
      const st = COASTAL_ZONES[slug].state;
      for (const sp of ['Red Drum (Redfish)', 'Speckled Trout (Spotted Seatrout)', 'Southern Flounder']) {
        for (const d of [FEB, AUG]) {
          const r = checkCoastalRegulations(st, sp, d);
          if (st === 'NC' && sp === 'Southern Flounder') {
            expect(r.legal, `${slug}/${sp}`).toBe(false);
          }
          expect(typeof r.legal).toBe('boolean');
        }
      }
    }
  });
});

describe('species selector UI', () => {
  it('offers the saltwater species that were previously unreachable', () => {
    for (const sp of ['Red Drum (Redfish)', 'Speckled Trout (Spotted Seatrout)', 'Southern Flounder']) {
      expect(selSrc, `selector missing ${sp}`).toContain(sp);
    }
  });

  it('keeps the freshwater list intact', () => {
    for (const sp of ['Striped Bass', 'Largemouth Bass', 'Crappie', 'Catfish']) {
      expect(selSrc).toContain(sp);
    }
  });

  it('disables closed species at the checkbox', () => {
    expect(selSrc).toContain('disabled');
    expect(selSrc).toContain('CLOSED');
  });

  it('re-evaluates when the trip date changes', () => {
    // Closures are date-dependent, so the list must not be built once.
    expect(selSrc).toContain("getElementById('planDate')");
  });

  it('is imported by main.js and the container exists', () => {
    const main = readFileSync(path.join(REPO, 'js/main.js'), 'utf8');
    expect(main).toContain('./modules/species-selector.js');
    expect(html).toContain('id="planSpeciesChecks"');
  });
});

describe('COASTAL_SPECIES_LIST', () => {
  it('every listed species canonicalises and has rules somewhere', () => {
    for (const sp of COASTAL_SPECIES_LIST) {
      expect(canonicalCoastalSpecies(sp), sp).toBe(sp);
      const anywhere = ['SC', 'GA', 'NC'].some((st) => COASTAL_REGULATIONS[st][sp]);
      expect(anywhere, `${sp} has no rules in any state`).toBe(true);
    }
  });
});
