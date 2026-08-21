// A TABLE THAT LOOKS LIKE A KNOB AND IS NOT CONNECTED.
//
// Ryan, 2026-08-21, when I proposed a registry of known agency index URLs: *"I absolutely hate
// the idea of hard coding queries... we actually ripped all of that out and went to what we have
// now... hard seeding makes it impossible to expand"*. He was right, and dropping that idea led
// somewhere better — the seeding that was ALREADY there and had already gone stale.
//
// STATE_FISH_AGENCY_DOMAINS holds ten domains across four states. The code read four of them:
// `[0]` and nothing else. And a second, hard-coded copy of the same knowledge in extract.js had
// drifted onto a domain that no longer serves.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { STATE_FISH_AGENCY_DOMAINS, STATE_ENVIRONMENT_DOMAINS, siteFilter }
  from '../Worker/research/discover.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(path.join(REPO, f), 'utf8');

describe('siteFilter scopes every domain it is given', () => {
  it('gives each term its own site:', () => {
    // `site:a OR b` does NOT scope the OR — it reads as "site:a, or the loose word b". That is
    // how extract.js had been asking for eregulations.com: as a keyword, not a domain.
    expect(siteFilter(['a.gov', 'b.com'])).toBe('(site:a.gov OR site:b.com)');
  });

  it('does not wrap a single domain in pointless parentheses', () => {
    expect(siteFilter(['a.gov'])).toBe('site:a.gov');
    expect(siteFilter('a.gov')).toBe('site:a.gov');
  });

  it('an empty list is an empty filter, not "site:undefined"', () => {
    expect(siteFilter([])).toBe('');
    expect(siteFilter(null)).toBe('');
    expect(siteFilter([null, ''])).toBe('');
  });

  it('uses EVERY domain, which is the whole point', () => {
    // Six of the ten domains in these tables were written down and never queried. Adding one did
    // nothing at all, which is the opposite of expandable.
    const f = siteFilter(STATE_FISH_AGENCY_DOMAINS.NC);
    for (const d of STATE_FISH_AGENCY_DOMAINS.NC) expect(f).toContain(`site:${d}`);
  });
});

describe('one table, not a second copy', () => {
  it('extract.js reads the shared table rather than its own ternary', () => {
    const code = src('Worker/research/extract.js');
    expect(code).toContain('STATE_FISH_AGENCY_DOMAINS');
    expect(code).toContain('siteFilter');
  });

  it('nothing in the research engine still targets the dead NC host in a site: filter', () => {
    // ncwildlife.org 302s to ncwildlife.gov. Measured on Lake Norman, 2026-08-21:
    //   site:ncwildlife.org  -> Wikipedia, and a lake survey from TEXAS
    //   site:ncwildlife.gov  -> seven NCWRC documents, one dated 2026
    //
    // The .org name stays in the DOMAIN LIST on purpose — old links still resolve through the
    // redirect and it costs nothing to keep looking there. What must not exist is a `site:`
    // filter that names it INSTEAD of the current host.
    for (const f of ['Worker/research/extract.js', 'Worker/research/discover.js']) {
      const code = src(f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      const bad = /site:\s*(['"`]?)ncwildlife\.org/.test(code)
               || /['"`]ncwildlife\.org\s+OR/.test(code);
      expect(bad, `${f} still filters on the dead NC host`).toBe(false);
    }
  });

  it('the current host leads its list, because [0] is still what single-domain callers take', () => {
    expect(STATE_FISH_AGENCY_DOMAINS.NC[0]).toBe('ncwildlife.gov');
    for (const st of ['SC', 'NC', 'GA', 'TN']) {
      expect(Array.isArray(STATE_FISH_AGENCY_DOMAINS[st]), st).toBe(true);
      expect(STATE_FISH_AGENCY_DOMAINS[st].length > 0, st).toBe(true);
      expect(Array.isArray(STATE_ENVIRONMENT_DOMAINS[st]), st).toBe(true);
    }
  });

  it('the gap query takes a built filter, not a bare domain to interpolate', () => {
    // `site:${dnr}` is the construction that un-scoped the OR. The filter arrives complete.
    const code = src('Worker/research/extract.js');
    expect(code.includes('limit site:${dnr}')).toBe(false);
  });
});
