import { describe, it, expect } from './expect-shim.mjs';
import { depthBandFor, usableAhFrom, researchedBand, researchIntel, ageSentence } from '../js/modules/plan-inputs.js';
import { SPECIES_BEHAVIOR_V2, getSeason } from '../js/data/species-intel.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// Two traps, both found by loading the page in a browser rather than by
// reasoning about the code.
//
// 1. getSeason() returns 'summer'. A caller writing 'Summer' got no band, and
//    no band means the planner refuses before it reads the pack -- a silent
//    dead end for a capital letter.
//
// 2. SPECIES_BEHAVIOR_V2 covers FOUR lakes. The app ships fifteen hundred
//    packs. Three places reach for a `default_SC_reservoir` key that does not
//    exist, so everywhere else fell through -- v1 landed in a hardcoded
//    12-18 / 22-28 ft in a catch block, which is how every Hartwell plan has
//    ever been built.
//
// The rule that comes out of the second one: a generic band is fine, but it
// must never be presented as a lake-specific one.
// ---------------------------------------------------------------------------

const PROFILED = Object.keys(SPECIES_BEHAVIOR_V2['Striped Bass']);

describe('depthBandFor — the species depth band for a whole day', () => {
  it('uses the RESEARCHED profile before anything hardcoded', () => {
    // The whole point of the research pipeline. Ryan: "i thought that whole thing was supposed
    // to be replaced by the research pipeline... please tell me we are using all of that great
    // data that is sitting there." It was not being used at all, on a lake the table also knows.
    const profile = { trollingIntelligence: { 'Striped Bass': { summer: { preferredDepth: [26, 34] } } } };
    const r = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'summer', 84, profile);
    expect(r.source).toBe('research');
    expect(r.band).toEqual([26, 34]);
    const table = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'summer', 84);
    expect(table.source).toBe('table');
    expect(table.band).not.toEqual(r.band);   // and they really do disagree
  });

  it('matches species names loosely, because an LLM wrote the keys', () => {
    for (const key of ['Striped Bass', 'striped bass', 'STRIPED BASS', 'Striped-Bass']) {
      const p = { trollingIntelligence: { [key]: { summer: { preferredDepth: [26, 34] } } } };
      expect(researchedBand(p, 'Striped Bass', 'summer').band).toEqual([26, 34]);
    }
  });

  it('falls past a profile that has nothing for this species or season', () => {
    const p = { trollingIntelligence: { Crappie: { summer: { preferredDepth: [8, 14] } } } };
    expect(researchedBand(p, 'Striped Bass', 'summer')).toBe(null);
    const p2 = { trollingIntelligence: { 'Striped Bass': { winter: { preferredDepth: [8, 14] } } } };
    expect(researchedBand(p2, 'Striped Bass', 'summer')).toBe(null);
    // ...and the table catches it, rather than the planner refusing.
    expect(depthBandFor('Striped Bass', 'Lake Wateree, SC', 'summer', 84, p2).source).toBe('table');
  });

  it('ignores a malformed researched band instead of trusting it', () => {
    for (const bad of [[30], ['a', 'b'], [40, 20], 'deep', null, {}]) {
      const p = { trollingIntelligence: { 'Striped Bass': { summer: { preferredDepth: bad } } } };
      expect(researchedBand(p, 'Striped Bass', 'summer')).toBe(null);
    }
  });

  it('uses the lake\'s own table entry when there is no research', () => {
    const r = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'summer', 84);
    expect(r.generic).toBe(false);
    expect(r.basis).toBe('built-in table, Lake Wateree');
    expect(r.source).toBe('table');
    expect(r.band.length).toBe(2);
    expect(r.band[1] > r.band[0]).toBe(true);
  });

  it('does not care how the season is capitalised', () => {
    const a = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'summer', 84);
    const b = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'Summer', 84);
    const c = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'SUMMER', 84);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('agrees with what getSeason actually returns', () => {
    // The bug in one line: whatever getSeason emits has to resolve.
    const season = getSeason(new Date('2026-08-10T12:00:00'));
    expect(depthBandFor('Striped Bass', 'Lake Wateree, SC', season, 84)).not.toBe(null);
  });

  it('still answers when the water temperature is blank', () => {
    // preferredDepth is a function of temperature on some lakes, and planWaterTemp is often
    // empty. A throw or a nonsense answer must not filter out the entire lake.
    const r = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'summer', null);
    expect(r).not.toBe(null);
    expect(Number.isFinite(r.band[0]) && Number.isFinite(r.band[1])).toBe(true);
  });

  it('falls back to what the species does elsewhere, and says that it did', () => {
    const r = depthBandFor('Striped Bass', 'Lake Hartwell', 'summer', 84);
    expect(r.generic).toBe(true);
    expect(r.basis.includes('Lake Hartwell has no researched profile')).toBe(true);
    expect(r.source).toBe('table-union');
    // The union of profiled lakes, so it is wider than any one of them. Wide is the safe
    // direction for a filter: the model still picks inside it, and a narrow band would quietly
    // remove the whole lake.
    const own = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'summer', 84);
    expect(r.band[0] <= own.band[0]).toBe(true);
    expect(r.band[1] >= own.band[1]).toBe(true);
  });

  it('never labels a generic band as lake-specific', () => {
    for (const lake of ['Lake Hartwell', 'Lake Keowee', 'Clarks Hill Lake', 'Lake Wylie']) {
      const r = depthBandFor('Striped Bass', lake, 'summer', 84);
      expect(r.generic).toBe(true);
    }
    for (const lake of PROFILED) {
      const r = depthBandFor('Striped Bass', lake, 'summer', 84);
      if (r) expect(r.generic).toBe(false);
    }
  });

  it('returns null rather than guessing for a species nobody profiled', () => {
    expect(depthBandFor('Coelacanth', 'Lake Wateree, SC', 'summer', 84)).toBe(null);
    expect(depthBandFor('Striped Bass', 'Lake Wateree, SC', 'monsoon', 84)).toBe(null);
  });
});

describe('usableAhFrom — the reserve comes off before anyone sees the number', () => {
  it('takes 20% off a LiFePO4 pack', () => {
    expect(usableAhFrom('NK180 Pro 24V, 100Ah LiFePO4')).toBe(80);
    expect(usableAhFrom('50ah')).toBe(40);
  });

  it('assumes the 100 Ah pack when the field says nothing useful', () => {
    expect(usableAhFrom('')).toBe(80);
    expect(usableAhFrom(null)).toBe(80);
    expect(usableAhFrom('some motor')).toBe(80);
  });
});

describe('how old the research is reaches the model', () => {
  // metadata.lastUpdated has been on every profile since storage.js was built, and THREE places
  // in the UI already show it to a person. The plan path — the one place that hands the research
  // to a model — read the profile and never read its date, so a profile researched in March and
  // one from last week produced a byte-identical prompt.
  const AT = Date.parse('2026-08-20T12:00:00Z');
  const aged = (days) => ({ metadata: { lastUpdated: new Date(AT - days * 86400000).toISOString() } });

  it('says the age in days when it is recent', () => {
    expect(ageSentence(aged(0), AT)).toBe(', researched 0 days ago');
    expect(ageSentence(aged(1), AT)).toBe(', researched 1 day ago');
    expect(ageSentence(aged(20), AT)).toMatch(/20 days ago/);
  });

  it('warns once it is old enough for "current" to be a lie', () => {
    // The pipeline bounds its current-fisheries-report search to 45 days AT RESEARCH TIME, so
    // that section is handed over as current however long ago research actually ran.
    expect(ageSentence(aged(45), AT)).toMatch(/possibly out of date/);
    expect(ageSentence(aged(190), AT)).toMatch(/a different season/);
  });

  it('undated is not fresh, and says so', () => {
    expect(ageSentence({ metadata: {} }, AT)).toMatch(/unknown age/);
    expect(ageSentence({}, AT)).toMatch(/unknown age/);
    expect(ageSentence({ metadata: { lastUpdated: 'not a date' } }, AT)).toMatch(/unknown age/);
  });

  it('and it rides on the intel block the prompt actually carries', () => {
    const profile = { identity: { maxDepthFt: 60 }, metadata: { lastUpdated: new Date(AT - 190 * 86400000).toISOString() } };
    expect(researchIntel(profile, 'Striped Bass', 'summer', AT)).toMatch(/6 months ago/);
  });
});

describe('researchIntel — the rest of the profile, which v2 was throwing away', () => {
  const profile = {
    metadata: { status: 'verified' },
    identity: { archetype: 'Piedmont storage reservoir', maxDepthFt: 90 },
    limnology: {
      thermocline: { summerDepthFt: 22, strength: 'strong' },
      oxygen: { anoxicBelowFt: 30 },
      waterClarity: { typical: 'stained', secchiFt: 3 },
      seasonalDrawdownFt: 4,
    },
    biology: { primaryForage: 'Blueback herring', baitfishMovement: 'suspend over the channel by August' },
    habitat: { standingTimber: 'extensive in the upper end', artificialHabitatDetails: { attractorCount: 31 } },
    trollingIntelligence: { 'Striped Bass': { summer: { preferredDepth: [26, 34], notes: 'stay on the old river channel' } } },
    summary: { text: 'A long narrow reservoir on the Catawba.' },
  };

  it('carries the two facts that decide where fish can physically be', () => {
    const s = researchIntel(profile, 'Striped Bass', 'summer');
    expect(s.includes('Thermocline in summer: 22 ft')).toBe(true);
    expect(s.includes('Anoxic below: 30 ft')).toBe(true);
  });

  it('carries forage, habitat and the fisheries agent\'s own notes', () => {
    const s = researchIntel(profile, 'Striped Bass', 'summer');
    expect(s.includes('Blueback herring')).toBe(true);
    expect(s.includes('31')).toBe(true);
    expect(s.includes('old river channel')).toBe(true);
    expect(s.includes('26-34 ft')).toBe(true);
  });

  it('says out loud when a profile has not been verified', () => {
    expect(researchIntel(profile, 'Striped Bass', 'summer').includes('(verified)')).toBe(true);
    const unver = { ...profile, metadata: {} };
    expect(researchIntel(unver, 'Striped Bass', 'summer').includes('NOT yet verified')).toBe(true);
  });

  it('omits what the research could not establish rather than emitting a blank', () => {
    const thin = { identity: { archetype: 'farm pond' } };
    const s = researchIntel(thin, 'Striped Bass', 'summer');
    expect(s.includes('Thermocline')).toBe(false);
    expect(s.includes('Anoxic')).toBe(false);
    expect(s.includes('farm pond')).toBe(true);
  });

  it('returns null when there is no profile at all', () => {
    expect(researchIntel(null, 'Striped Bass', 'summer')).toBe(null);
    expect(researchIntel({}, 'Striped Bass', 'summer')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Against a REAL profile, verbatim.
//
// Lake Wateree's trollingIntelligence for Striped Bass, pasted from R2 by Ryan
// on 2026-08-07. Everything above this point was written against a fixture I
// invented, and two of my field names were wrong: the pipeline writes
// `structures` and `recommendedPresentations`, not `preferredStructure` and
// `preferredPresentation`. Those lines silently produced nothing.
//
// It also settles what was at stake. The research says stripers are 15-40 ft
// on Wateree in summer. The built-in table says 10-16. Those are different
// fish in different water, and the research is the one that looked at THIS
// lake.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TI = JSON.parse(readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'wateree-trolling-intel.json'), 'utf8'));
const REAL = { metadata: { status: 'verified' }, trollingIntelligence: TI };

describe('against Lake Wateree\'s real researched profile', () => {
  it('reads every season\'s band', () => {
    expect(researchedBand(REAL, 'Striped Bass', 'summer').band).toEqual([15, 40]);
    expect(researchedBand(REAL, 'Striped Bass', 'spring').band).toEqual([10, 25]);
    expect(researchedBand(REAL, 'Striped Bass', 'fall').band).toEqual([10, 25]);
    expect(researchedBand(REAL, 'Striped Bass', 'winter').band).toEqual([15, 25]);
  });

  it('beats the built-in table, which disagrees with it materially', () => {
    const r = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'summer', 84, REAL);
    const t = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'summer', 84);
    expect(r.source).toBe('research');
    expect(r.band).toEqual([15, 40]);
    expect(t.source).toBe('table');
    // The disagreement is the reason this precedence matters, not a rounding difference.
    expect(t.band[1] < r.band[1] - 10).toBe(true);
  });

  it('carries the structures, forage, presentations and notes into the prompt', () => {
    const s = researchIntel(REAL, 'Striped Bass', 'summer');
    expect(s.includes('main lake points')).toBe(true);
    expect(s.includes('lower lake basin')).toBe(true);
    expect(s.includes('Blueback herring')).toBe(true);
    expect(s.includes('downlines')).toBe(true);
    expect(s.includes('topwater lures')).toBe(true);
    expect(s.includes('Schooling activity common early and late')).toBe(true);
    expect(s.includes('15-40 ft')).toBe(true);
  });

  it('does not leak another season\'s advice into today', () => {
    const s = researchIntel(REAL, 'Striped Bass', 'summer');
    expect(s.includes('planer boards')).toBe(false);      // spring and fall only
    expect(s.includes('move up the river to spawn')).toBe(false);
  });
});
