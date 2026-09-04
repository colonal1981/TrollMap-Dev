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

  // THE SHAPE IS COPIED FROM registry/lake_index.json, read 2026-09-04. `ramps` is keyed by FEED
  // and the species sit one level down under `meta`, which is the level a search for `species`
  // misses -- the same nesting that made four of the five ramp feeds read as species-free on
  // 2026-09-03. Savannah's four are the real values off the GA access layer.
  coast_savannah_ga: {
    slug: 'coast_savannah_ga', state: 'GA', name: 'Savannah', feature_type: 'coastal',
    display_name: 'Savannah River / Wassaw Sound, GA',
    ramps: {
      osm: [{ name: null, tag: 'leisure=slipway', lat: 31.93, lon: -81.11 }],
      dnr: [{ name: 'Bahia Bleu Marina', wb: 'Wilmington River', type: 'Boat Ramp',
              src: 'Georgia DNR WRD Water Access Points',
              meta: { lanes: 2, dock: 'Y', county: 'Chatham', owner: 'Private',
                      species: 'Red Drum (Redfish), Spotted Seatrout, Southern Flounder, Sheepshead' } }],
      dnr_paddle: [{ name: "Bell's Landing", meta: { county: 'Chatham' } }],
    },
  },

  // A ramp feed naming things that are not targets, beside two that are.
  ramp_noise_sc: {
    slug: 'ramp_noise_sc', state: 'SC', name: 'Ramp Noise', display_name: 'Ramp Noise Lake, SC',
    ramps: { dnr: [{ name: 'A Landing', src: 'SCDNR',
                     meta: { species: 'Largemouth Bass, Various, Other, Shrimp, Blue Catfish' } }] },
  },
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AND THE SAME PAGE SAYS WHAT THOSE FISH EAT
//
// Forage was the last thin field on the refactor: 21% of the mirrored profiles carry a primary
// forage, and the only writer was the fisheries agent, asked to establish it "from the documents
// you are reading everything else from" — which ARE these pages, already parsed onto the drive.
//
// The rule invents no vocabulary: a name RESEARCH_SPECIES_CANON recognises, which
// uniqueResearchSpecies() then DROPS, is forage. NON_GAME_SPECIES has always known which fish are
// not targets; nothing had ever kept the half it threw away.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const HARTWELL = [{
  state: 'GA', agency: 'GA DNR', page_name: 'Lake Hartwell',
  source: { url: 'https://georgiawildlife.com/lake-hartwell' },
  overview: ['Lake Hartwell is one of the three large reservoirs on the Savannah River.'],
  species: [
    { name: 'Spotted Bass',
      technique: ['Threadfin shad and blueback herring are the preferred prey of spotted bass in '
                + 'Lake Hartwell but they also feed on small sunfish and crayfish.'] },
    { name: 'Hybrid & Striped Bass',
      technique: ['Striped bass and hybrid bass feed almost exclusively on blueback herring but '
                + 'trophy-sized stripers will take large gizzard shad at certain times of year.'] },
  ],
}];

describe('the agency page names the bait, in a sentence, and we read it now', () => {
  it('takes the clupeids the roster filter drops', async () => {
    const { forageFromAgencyPages } = await import('../Worker/research/deterministic.js');
    const { forage } = forageFromAgencyPages(HARTWELL);
    expect(forage).toEqual(['Blueback Herring', 'Gizzard Shad', 'Threadfin Shad']);
  });

  it('keeps the agency\'s own sentence as the quote', async () => {
    const { forageFromAgencyPages } = await import('../Worker/research/deterministic.js');
    const { quotes } = forageFromAgencyPages(HARTWELL);
    expect(/preferred prey of spotted bass/.test(quotes[0] || '')).toBe(true);
  });

  it('does not report "Shad" beside "Threadfin Shad"', async () => {
    // The canon holds `shad` as well as `threadfin shad`, so one sentence yields both. A result
    // that is a strict substring of another is the shorter reading of the same fish.
    const { forageFromAgencyPages } = await import('../Worker/research/deterministic.js');
    expect(forageFromAgencyPages(HARTWELL).forage.includes('Shad')).toBe(false);
  });

  it('reads only inside a predator write-up, never the page overview', async () => {
    // Cape Fear River's rows are survey PDFs, not lake pages — `species: []`, titled "AMERICAN
    // SHAD MONITORING IN THE CAPE FEAR RIVER-2015", with a sentence saying Longnose Gar "were
    // the most abundant nongame fish". Reading overviews returned American Shad and Longnose Gar
    // as this river's forage. Neither is prey; both merely failed to be targets.
    const { forageFromAgencyPages } = await import('../Worker/research/deterministic.js');
    const survey = [{ agency: 'NCWRC', species: [],
      overview: ['AMERICAN SHAD MONITORING IN THE CAPE FEAR RIVER-2015',
                 'Flathead Catfish, Channel Catfish, Blue Catfish, and Longnose Gar were the '
               + 'most abundant nongame fish.'] }];
    expect(forageFromAgencyPages(survey).forage).toEqual([]);
  });

  it('reads every prose field the four agencies actually write', async () => {
    // Counted across the file: GA DNR writes prospect/technique/target/notes, TWRA notes/tips,
    // SCDNR notes, NCWRC only `from` — a citation. The first cut omitted `tips` and lost
    // Cherokee Lake's alewife, which sits in exactly that field.
    const { forageFromAgencyPages } = await import('../Worker/research/deterministic.js');
    const twra = [{ agency: 'TWRA', species: [{ name: 'Walleye',
      tips: ['Walleye must be stocked because of the presence of alewife in the reservoir.'] }] }];
    expect(forageFromAgencyPages(twra).forage).toEqual(['Alewife']);
  });

  it('and a page that names no forage says nothing', async () => {
    const { forageFromAgencyPages } = await import('../Worker/research/deterministic.js');
    expect(forageFromAgencyPages([]).forage).toEqual([]);
    expect(forageFromAgencyPages([{ agency: 'GA DNR', species: [{ name: 'Bream',
      notes: ['Best in the spring around bedding areas.'] }] }]).forage).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AND WHAT THE TARGET EATS, WHICH IS THE OTHER HALF AND NOT A FACT ABOUT ANY LAKE
//
// registry/species_traits.json is 56 species read out of SCDNR's Guide to Freshwater Fishes of
// South Carolina, with a `Food Habits` section on 41 entries and `Foraging Habits` on 12. It is
// published, current, and had no reader in the plan path.
//
// forageFromAgencyPages() says what forage a WATER has; this says what the SPECIES eats. The
// fisheries prompt needs both — without the second it feeds blueback herring to bluegill.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const TRAITS = { species: {
  'Striped Bass': [
    { state: 'SC', agency: 'SCDNR', page: 36, scientific: 'Morone saxatilis',
      source: 'FreshwaterFishPocketGuide.pdf',
      sections: { Range: 'Statewide.',
        'Food Habits': 'The diet of striped bass consists mostly of fish. Preferred species in '
                     + 'freshwater are threadfin shad, gizzard shad and blueback herring.' } },
  ],
  'Bluegill': [
    { state: 'SC', agency: 'SCDNR', page: 20,
      sections: { Range: 'Statewide.' } },                    // no diet section at all
    { state: 'SC', agency: 'SCDNR', page: 21,
      sections: { 'Foraging Habits': 'Feeds on insects, snails and small crustaceans.' } },
  ],
} };

const traitsEnv = () => ({
  R2_TROLLMAP_CHARTPACKS: {
    get: async (key) => (key === '_registry/species_traits.json'
      ? { text: async () => JSON.stringify(TRAITS) } : null),
  },
});

describe('the state guide says what the target eats', () => {
  const food = async (name) => {
    const { speciesFoodHabits } = await import('../Worker/research/deterministic.js');
    _resetIndexCache();
    return speciesFoodHabits(traitsEnv(), name);
  };

  it('returns the diet with the page it came from', async () => {
    const f = await food('Striped Bass');
    expect(/threadfin shad, gizzard shad and blueback herring/.test(f.text)).toBe(true);
    expect(f.agency).toBe('SCDNR');
    expect(f.page).toBe(36);
  });

  it('says out loud that it is statewide, not this water', async () => {
    // The file's own note: "Per-SPECIES and statewide, not per-water". A sentence about what
    // stripers eat in South Carolina read as a sentence about this reservoir is the confusion
    // the evidence rows exist to prevent, so the flag travels with the fact.
    expect((await food('Striped Bass')).statewide).toBe(true);
  });

  it('falls through an entry with no diet section to one that has it', async () => {
    expect((await food('Bluegill')).text).toBe('Feeds on insects, snails and small crustaceans.');
  });

  it('matches through the species canon, not on the exact string', async () => {
    // The plan form and the guide do not have to spell a fish the same way.
    expect((await food('striped bass')).species).toBe('Striped Bass');
  });

  it('answers nothing for a fish the guide does not cover', async () => {
    expect(await food('Muskellunge')).toBe(null);
    expect(await food('')).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AND THE RAMP FEEDS, WHICH WERE LEFT OUT AND ARE THE BIGGEST SOURCE OF THE FIVE
//
// Ryan, 2026-09-04, on being told Georgia's four saltwater zones were blocked on him for five
// species names: "this is not waiting on me... the ramp feed fixes this and the fix you [did]
// for the ramp feed should have actually put it into smartplans hands today".
//
// He was right. The species were left out of registrySpeciesFor() because getRampSpeciesFacts()
// is a live ArcGIS fetch -- but build_dnr_ramps_by_lake.py has also been baking them onto the
// registry row, and this function already holds that row. Measured the same day: 110 of 355
// waters carry ramp species, more than any other block here reaches.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the ramp feeds reach a plan, off the row this function already has', () => {
  it("gives Georgia's saltwater zones the roster they were said to be missing", async () => {
    const r = await fresh('Savannah River / Wassaw Sound, GA', 'GA');
    expect(r.slug).toBe('coast_savannah_ga');
    // THE FEED'S WORDS ARE NOT THE APP'S, and uniqueResearchSpecies() is where they meet:
    // Georgia's layer says `Spotted Seatrout` and the app's canon is
    // `Speckled Trout (Spotted Seatrout)`. The first version of this test asserted the feed's
    // spelling and failed against correct code -- the same common-name-versus-canon trap the
    // FishBase join was measured on the same day.
    for (const sp of ['Red Drum (Redfish)', 'Speckled Trout (Spotted Seatrout)',
                      'Southern Flounder', 'Sheepshead']) {
      expect(r.predatorSpecies.includes(sp)).toBe(true);
    }
  });

  it('splits the comma string and keeps a parenthesised name whole', async () => {
    const r = await fresh('Savannah River / Wassaw Sound, GA', 'GA');
    expect(r.predatorSpecies.includes('Red Drum (Redfish)')).toBe(true);
    expect(r.predatorSpecies.some((s) => /^Redfish\)?$/.test(s))).toBe(false);
  });

  it('names the feed and the access layer in the evidence, as a FLOOR not a roster', async () => {
    const r = await fresh('Savannah River / Wassaw Sound, GA', 'GA');
    const src = r.sources.find((x) => /access points/i.test(x.label || ''));
    expect(!!src).toBe(true);
    expect(src.kind).toBe('floor');
    expect(/dnr/.test(src.label)).toBe(true);
    const ev = r.evidence.find((e) => e.field === 'predatorSpecies'
      && (e.entries || []).some((x) => /ramp/i.test(JSON.stringify(x))));
    expect(!!ev).toBe(true);
  });

  it('drops what is not a target and keeps what is', async () => {
    const r = await fresh('Ramp Noise Lake, SC', 'SC');
    expect(r.predatorSpecies.includes('Largemouth Bass')).toBe(true);
    expect(r.predatorSpecies.includes('Blue Catfish')).toBe(true);
    for (const junk of ['Various', 'Other', 'Shrimp']) {
      expect(r.predatorSpecies.includes(junk)).toBe(false);
    }
  });

  it('reads a feed with no species, and a row with no ramps, without throwing', async () => {
    const r = await fresh('Savannah River / Wassaw Sound, GA', 'GA');
    // osm and dnr_paddle carry no species on this row; only dnr should have produced a source.
    expect(r.sources.filter((x) => /access points/i.test(x.label || '')).length).toBe(1);
    const bare = await fresh('Lake Norman (Catawba Co, NC)', 'NC');
    expect(bare.sources.some((x) => /access points/i.test(x.label || ''))).toBe(false);
  });

  it('COSTS NO FETCH -- the row is already in hand, so no extra R2 object is read', async () => {
    _resetIndexCache();
    const asked = [];
    const e = env();
    const inner = e.R2_TROLLMAP_CHARTPACKS.get;
    e.R2_TROLLMAP_CHARTPACKS.get = async (key) => { asked.push(key); return inner(key); };
    await registrySpeciesFor(e, 'Savannah River / Wassaw Sound, GA', 'GA');
    // Whatever else it reads, it must not have gone looking for a ramp object.
    expect(asked.some((k) => /ramp|access/i.test(k))).toBe(false);
    expect(asked.includes('_registry/lake_index.json')).toBe(true);
  });
});
