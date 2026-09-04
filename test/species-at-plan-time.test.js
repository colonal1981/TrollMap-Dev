import { describe, it, expect } from './expect-shim.mjs';
import { registrySpeciesFor } from '../Worker/research/deterministic.js';
import { _resetIndexCache } from '../Worker/registry.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE OTHER TWO STATES' FISH, WITHOUT A RESEARCH PROFILE
//
// Ryan, 2026-09-04: "now wire up the fish species to the other states for the refactor".
//
// South Carolina and Georgia publish species on their ramp feeds, and since the two ramp source
// tables were merged the browser holds those directly. North Carolina and Tennessee publish none
// there. NC's fish are in registry/nc_species_by_lake.json and TN's are on the TWRA lake pages
// parsed into registry/agency_lake_facts.json -- both in R2 with cached loaders since 2026-08-28,
// and until now the ONLY reader of either was the research pipeline. So a water reached a plan
// with a roster if somebody had run research on it and with nothing if they had not.
//
// registrySpeciesFor() is those four registry-keyed blocks lifted out of
// handleResearchDeterministicFacts, so the handler and GET /species are one assembly rather than
// two that agree today.
//
// A ROSTER AND A FLOOR ARE DIFFERENT CLAIMS. The NC file and the agency page say what is IN the
// water; the regulations and advisory blocks say only that the state wrote a rule about a fish or
// sampled one. `sources[].kind` is how a caller tells them apart.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const INDEX = {
  lake_norman: { slug: 'lake_norman', state: 'NC', name: 'Lake Norman',
                 display_name: 'Lake Norman (Catawba Co, NC)' },
  boone_lake: { slug: 'boone_lake', state: 'TN', name: 'Boone Lake',
                display_name: 'Boone Lake (Sullivan Co, TN)' },
  hugh_m_gillis: { slug: 'hugh_m_gillis', state: 'GA', name: 'Hugh M Gillis',
                   display_name: 'Hugh M Gillis PFA (Laurens Co, GA)' },
};

const NC_SPECIES = { lakes: {
  lake_norman: {
    predatorSpecies: ['Largemouth Bass', 'Striped Bass', 'White Perch'],
    knownStockings: ['Striped Bass'],
    locations: [{ locationID: 1 }, { locationID: 2 }],
    stockingPlan: [{ species: 'Striped Bass', number: 325000, size: '1-2 in', agency: 'NCWRC', year: 2026 },
                   { species: 'Walleye', number: 180000, agency: 'NCWRC', year: 2026 }],
  },
} };

const AGENCY = { rows: {
  boone_lake: [{ state: 'TN', agency: 'TWRA', page_name: 'Boone Lake',
                 source: { url: 'https://www.tn.gov/twra/boone-lake.html' },
                 species: [{ name: 'Largemouth Bass' }, { name: 'Smallmouth Bass' },
                           { name: 'Walleye' }, { name: 'Crappie' }] }],
  // The GA DNR PFA template run through the LAKE reader: section headings, not fish.
  hugh_m_gillis: [{ state: 'GA', agency: 'GA DNR', page_name: 'Hugh M Gillis PFA',
                    source: { url: 'https://georgiawildlife.com/hugh-m-gillis-pfa' },
                    species: [{ name: 'Gallery' }, { name: 'Fees & Passes' },
                              { name: 'Stay connected' }] }],
} };

const REGS = { by_water: {
  boone_lake: { state: 'TN', rules: [{ label: 'Striped or Hybrid Bass or a combination',
                                       plan_species: ['Striped Bass', 'Hybrid Striped Bass'] }] },
} };

const ADVISORIES = { source: 'NC DHHS fish consumption advisory',
                     waters: { lake_norman: { species: [{ species: 'Blue Catfish' }] } } };

const KEYS = {
  '_registry/lake_index.json': INDEX,
  '_registry/nc_species_by_lake.json': NC_SPECIES,
  '_registry/agency_lake_facts.json': AGENCY,
  '_registry/regulations.json': REGS,
  '_registry/sc_fish_advisories.json': ADVISORIES,
};

const env = () => ({
  R2_TROLLMAP_CHARTPACKS: {
    get: async (key) => (KEYS[key]
      ? { text: async () => JSON.stringify(KEYS[key]),
          arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(KEYS[key])).buffer }
      : null),
  },
});

const fresh = async (name, state) => { _resetIndexCache(); return registrySpeciesFor(env(), name, state); };

describe('North Carolina fish come out of the file that is the only place NC publishes them', () => {
  it('returns the roster, the stocking flag and the stocking plan count', async () => {
    const r = await fresh('Lake Norman (Catawba Co, NC)', 'NC');
    expect(r.slug).toBe('lake_norman');
    for (const sp of ['Largemouth Bass', 'Striped Bass']) {
      expect(r.predatorSpecies.includes(sp)).toBe(true);
    }
    const striper = r.knownStockings.find((s) => s.species === 'Striped Bass');
    expect(!!striper).toBe(true);
    // The flag landed first and carries no number; the plan's note fills it in rather than
    // being dropped as a duplicate species.
    expect(/325,000/.test(striper.note || '')).toBe(true);
    expect(!!r.knownStockings.find((s) => s.species === 'Walleye')).toBe(true);
  });

  it('and names the file it came from, as a roster', async () => {
    const r = await fresh('Lake Norman (Catawba Co, NC)', 'NC');
    const src = r.sources.find((s) => s.url === 'registry:nc_species_by_lake.json');
    expect(!!src).toBe(true);
    expect(src.kind).toBe('roster');
  });
});

describe("Tennessee's fish come off the TWRA lake page", () => {
  it('reads the roster the state already published', async () => {
    const r = await fresh('Boone Lake (Sullivan Co, TN)', 'TN');
    expect(r.slug).toBe('boone_lake');
    for (const sp of ['Largemouth Bass', 'Smallmouth Bass', 'Walleye']) {
      expect(r.predatorSpecies.includes(sp)).toBe(true);
    }
    expect(r.sources.some((s) => s.label === 'TWRA lake page' && s.kind === 'roster')).toBe(true);
  });

  it('and unions the rule floor in underneath it without replacing it', async () => {
    const r = await fresh('Boone Lake (Sullivan Co, TN)', 'TN');
    // The book's two names arrive through canonicalizeResearchSpecies(), which folds
    // "Hybrid Striped Bass" onto the app's own checkbox value -- asserting the raw string would
    // be asserting the book's vocabulary rather than the plan form's.
    expect(r.predatorSpecies.includes('Striped Bass')).toBe(true);
    expect(r.predatorSpecies.includes('White Bass / Hybrid')).toBe(true);
    // And the page's own fish all survive: a floor unions in, it never replaces.
    expect(r.predatorSpecies.includes('Smallmouth Bass')).toBe(true);
    expect(r.predatorSpecies.includes('Walleye')).toBe(true);
    const floor = r.sources.find((s) => s.kind === 'floor');
    expect(!!floor).toBe(true);
    expect(/regulations digest/.test(floor.label)).toBe(true);
  });

  // THREE OF THE FOUR EVIDENCE ROWS HAD NEVER BEEN WRITTEN. The handler called
  // `buildEvidence([{...}])` for the agency page and both floors, and buildEvidence's first
  // parameter is `sourceType` -- so the array landed there and the call returned an object.
  // mergeEvidence() opens with `if (!entries?.length) return`, an object has no length, and every
  // one was dropped. That is why a species sourced from an agency page shows up in a stored
  // profile with no provenance behind it.
  it('records provenance for the agency page, which it never used to', async () => {
    const r = await fresh('Boone Lake (Sullivan Co, TN)', 'TN');
    const rows = r.evidence.filter((e) => e.field === 'predatorSpecies').flatMap((e) => e.entries);
    const page = rows.find((x) => x.method === 'agency_page_roster');
    expect(!!page).toBe(true);
    expect(page.sourceLabel).toBe('TWRA lake page');
    expect(page.speciesCount).toBe(4);
    expect(rows.some((x) => x.method === 'lake_rule_species_floor')).toBe(true);
  });
});

describe('a page that names no fish is refused', () => {
  it('does not put "Gallery" and "Fees & Passes" into a roster', async () => {
    // uniqueResearchSpecies() removes non-game fish and cannot tell a fish from a nav link, so
    // the guard is that a real roster names at least one fish this codebase already knows.
    const r = await fresh('Hugh M Gillis PFA (Laurens Co, GA)', 'GA');
    expect(r.predatorSpecies).toEqual([]);
    expect(r.sources).toEqual([]);
  });
});

describe('an advisory is a floor too, and it is the only source some waters have', () => {
  it('adds the fish the state sampled, marked as a floor', async () => {
    const r = await fresh('Lake Norman (Catawba Co, NC)', 'NC');
    expect(r.predatorSpecies.includes('Blue Catfish')).toBe(true);
    const adv = r.sources.find((s) => s.url === 'registry:fish_advisories.json');
    expect(!!adv).toBe(true);
    expect(adv.kind).toBe('floor');
  });
});

describe('a water the registry cannot identify answers with nothing, not a guess', () => {
  it('returns an empty roster and no slug', async () => {
    const r = await fresh('Somewhere That Is Not In The Registry, SC', 'SC');
    expect(r.slug).toBe(null);
    expect(r.predatorSpecies).toEqual([]);
    expect(r.sources).toEqual([]);
  });
});
