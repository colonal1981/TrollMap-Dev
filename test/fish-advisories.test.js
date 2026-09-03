import { describe, it, expect } from './expect-shim.mjs';
import {
  advisoryRows, advisoryFor, hasAdvisory, primeFishAdvisories, _setAdvisoryCache,
} from '../js/data/fish-advisories.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT YOU MAY KEEP, THEN WHAT TO KNOW ABOUT KEEPING IT.
 *
 * Ryan placed this section himself: "probably below the regulations entry in the smartplan
 * output html... hey this is what you can keep... but if you keep them know this about them."
 *
 * Fourteen of South Carolina's sixty-two bound waters carry a DO NOT EAT species, and on five of
 * them it is LARGEMOUTH BASS — the Edisto, Little Pee Dee, Lumber, Waccamaw and Savannah — plus
 * striped bass on Hartwell. The state naming the fish somebody is most likely to be targeting is
 * the case this whole section exists for, so it is the first thing tested.
 *
 * SIX WATERS ARE IN BOTH STATES' BOOKS and that is the second thing tested, because a slug now
 * holds a LIST of records rather than one.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

const EDISTO = {
  display_name: 'Edisto River (Colleton Co, SC)',
  state: 'SC', water_type: 'freshwater',
  source: 'SC DES fish consumption advisories',
  advisories: [{ name: 'Edisto River', advisory: 'Mercury', confidence: 'name+geom' }],
  species: [
    { species: 'Largemouth Bass', advice: 'DO NOT EAT ANY', published_as: 'Bass- Largemouth' },
    { species: 'Bluegill', advice: 'One meal per week', published_as: 'Bluegill' },
    { species: 'Bowfin (Mudfish)', advice: 'DO NOT EAT ANY', published_as: 'Bowfin (Mudfish)' },
    { species: 'Redear Sunfish', advice: 'No Restrictions', published_as: 'Sunfish- Redear' },
  ],
  do_not_eat: ['Largemouth Bass', 'Bowfin (Mudfish)'],
  water_level_notes: [],
};

const CLEARED = {
  display_name: 'Lake Murray (Lexington Co, SC)',
  state: 'SC', water_type: 'freshwater',
  advisories: [{ name: 'Lake Murray', advisory: 'No Advisory', confidence: 'name+geom' }],
  species: [], do_not_eat: [], water_level_notes: ['No Restrictions'],
};

// Hartwell is in both books. South Carolina sampled it for PCB and Georgia advises the main body
// separately — where it says DO NOT EAT to striped and hybrid bass in all three size classes.
const HARTWELL_SC = {
  display_name: 'Hartwell Lake (Anderson Co, SC/GA)',
  state: 'SC',
  source: 'SC DES fish consumption advisories',
  advisories: [{ name: 'Lake Hartwell-All Remaining', advisory: 'PCB', confidence: 'name+geom' }],
  species: [{ species: 'Largemouth Bass', advice: 'One meal per month',
              published_as: 'Bass- Largemouth' }],
  do_not_eat: [], water_level_notes: [],
};
const HARTWELL_GA = {
  display_name: 'Hartwell Lake (Anderson Co, SC/GA)',
  state: 'SC',
  source: 'GA EPD, Guidelines For Eating Fish From Georgia Waters 2023',
  advisories: [{ name: 'Lake Hartwell Main Body', basin: 'Savannah River Basin', page: 16,
                 confidence: 'name' }],
  species: [
    { species: 'Striped Bass', advice: 'Do Not Eat', published_as: 'Hybrid/Strip Bass',
      size: 'Over 16”', corrected: 'the book truncates "Striped"' },
    { species: 'Spotted Bass', advice: '1 meal/month', published_as: 'Spotted Bass',
      size: 'Over 16”' },
  ],
  do_not_eat: ['Striped Bass'], water_level_notes: [],
};

describe('the advisory a plan prints under its regulations', () => {
  it('an unprimed cache says nothing rather than throwing', () => {
    _setAdvisoryCache(null);
    expect(advisoryRows('edisto_river', ['Largemouth Bass'])).toBe(null);
    expect(advisoryFor('edisto_river')).toBe(null);
    expect(hasAdvisory('edisto_river')).toBe(false);
  });

  it('the species being fished for come first', () => {
    _setAdvisoryCache({ edisto_river: EDISTO });
    const adv = advisoryRows('edisto_river', ['Bluegill']);
    expect(adv.rows[0].species).toBe('Bluegill');
    expect(adv.rows[0].targeted).toBe(true);
  });

  it('A DO NOT EAT ON A FISH NOBODY PLANNED FOR STILL SHOWS', () => {
    // The plan is a day on the water, not a shopping list. Somebody catches a bowfin by
    // accident and the state's answer about eating it is the same either way.
    _setAdvisoryCache({ edisto_river: EDISTO });
    const adv = advisoryRows('edisto_river', ['Bluegill']);
    const names = adv.rows.map((r) => r.species);
    expect(names.includes('Bowfin (Mudfish)')).toBe(true);
    // Targeted first, then the do-not-eats ahead of the rest.
    expect(adv.rows[1].doNotEat).toBe(true);
  });

  it('a targeted species the state says not to eat is flagged as both', () => {
    _setAdvisoryCache({ edisto_river: EDISTO });
    const adv = advisoryRows('edisto_river', ['Largemouth Bass']);
    expect(adv.rows[0].species).toBe('Largemouth Bass');
    expect(adv.rows[0].targeted).toBe(true);
    expect(adv.rows[0].doNotEat).toBe(true);
  });

  it('"No Restrictions" is still a row, because it is still a fish that is here', () => {
    _setAdvisoryCache({ edisto_river: EDISTO });
    const adv = advisoryRows('edisto_river', []);
    expect(adv.rows.map((r) => r.species).includes('Redear Sunfish')).toBe(true);
  });

  it('a parenthetical does not stop a species matching what was planned', () => {
    // The plan says "Bowfin"; the state publishes "Bowfin (Mudfish)".
    _setAdvisoryCache({ edisto_river: EDISTO });
    const adv = advisoryRows('edisto_river', ['Bowfin']);
    expect(adv.rows[0].species).toBe('Bowfin (Mudfish)');
    expect(adv.rows[0].targeted).toBe(true);
  });

  it('A CLEARED WATER IS AN ANSWER, NOT A MISSING SECTION', () => {
    // Twenty of the sixty-two were sampled and had nothing to warn about. Rendering that as an
    // absent section would turn a clean bill of health into a hole.
    _setAdvisoryCache({ lake_murray: CLEARED });
    const adv = advisoryRows('lake_murray', ['Largemouth Bass']);
    expect(adv.cleared).toBe(true);
    expect(adv.rows).toHaveLength(0);
    expect(adv.notes).toEqual(['No Restrictions']);
    expect(hasAdvisory('lake_murray')).toBe(true);
  });

  it('a water with no advisory at all prints nothing', () => {
    _setAdvisoryCache({ edisto_river: EDISTO });
    expect(advisoryRows('lake_wateree', [])).toBe(null);
    expect(hasAdvisory('lake_wateree')).toBe(false);
  });

  it('the advisory KIND travels, because mercury and PCB are different problems', () => {
    _setAdvisoryCache({ edisto_river: EDISTO });
    expect(advisoryRows('edisto_river', []).kinds).toEqual(['Mercury']);
  });
});

describe('a water both states sampled', () => {
  it('KEEPS BOTH SURVEYS. NEITHER STATE OVERWRITES THE OTHER', () => {
    // Georgia's Hartwell main body is the strongest warning in that book about a fish Ryan
    // targets. Merging the two records, or letting one file land on top of the other, is how it
    // would go missing on the one water where it matters most.
    _setAdvisoryCache({ hartwell_lake: [HARTWELL_SC, HARTWELL_GA] });
    const adv = advisoryRows('hartwell_lake', ['Striped Bass']);
    expect(adv.rows).toHaveLength(3);
    expect(adv.rows[0].species).toBe('Striped Bass');
    expect(adv.rows[0].doNotEat).toBe(true);
    expect(adv.doNotEat).toEqual(['Striped Bass']);
  });

  it('every row still says which state published it', () => {
    _setAdvisoryCache({ hartwell_lake: [HARTWELL_SC, HARTWELL_GA] });
    const adv = advisoryRows('hartwell_lake', []);
    const bySpecies = Object.fromEntries(adv.rows.map((r) => [r.species, r.source]));
    expect(bySpecies['Largemouth Bass']).toBe('SC DES fish consumption advisories');
    expect(bySpecies['Striped Bass'])
      .toBe('GA EPD, Guidelines For Eating Fish From Georgia Waters 2023');
    expect(adv.sources).toHaveLength(2);
  });

  it('ONE STATE CLEARING A SHARED WATER DOES NOT CLEAR THE OTHER STATE\'S ROWS', () => {
    _setAdvisoryCache({ hartwell_lake: [CLEARED, HARTWELL_GA] });
    const adv = advisoryRows('hartwell_lake', []);
    expect(adv.cleared).toBe(false);
    expect(adv.rows.length).toBe(2);
  });

  it('a single record still works, because most waters are in one book', () => {
    _setAdvisoryCache({ edisto_river: EDISTO });
    expect(advisoryFor('edisto_river')).toHaveLength(1);
    expect(advisoryRows('edisto_river', []).rows).toHaveLength(4);
  });
});

describe('priming never breaks a plan', () => {
  it('no worker base means no request and no throw', async () => {
    _setAdvisoryCache(null);
    expect(await primeFishAdvisories({})).toBe(null);
  });

  it('a failed response is null, not an exception', async () => {
    _setAdvisoryCache(null);
    const res = await primeFishAdvisories({
      worker: 'https://example.invalid',
      fetch: async () => ({ ok: false, status: 500 }),
    });
    expect(res).toBe(null);
  });

  it('a fetch that throws is null too — offline at a ramp is not a broken plan', async () => {
    _setAdvisoryCache(null);
    const res = await primeFishAdvisories({
      worker: 'https://example.invalid',
      fetch: async () => { throw new Error('offline'); },
    });
    expect(res).toBe(null);
  });

  it('it reads both files and groups them by our slug', async () => {
    _setAdvisoryCache(null);
    const asked = [];
    const res = await primeFishAdvisories({
      worker: 'https://example.invalid/',
      fetch: async (url) => {
        asked.push(url);
        if (url.endsWith('sc_fish_advisories.json')) {
          return { ok: true, json: async () => ({
            source: 'SC DES fish consumption advisories',
            waters: { edisto_river: EDISTO, hartwell_lake: HARTWELL_SC } }) };
        }
        return { ok: true, json: async () => ({
          source: 'GA EPD, Guidelines For Eating Fish From Georgia Waters 2023',
          waters: { hartwell_lake: HARTWELL_GA } }) };
      },
    });
    expect(asked).toEqual([
      'https://example.invalid/chartpacks/_registry/sc_fish_advisories.json',
      'https://example.invalid/chartpacks/_registry/ga_fish_advisories.json',
    ]);
    expect(Object.keys(res).sort()).toEqual(['edisto_river', 'hartwell_lake']);
    expect(res.hartwell_lake).toHaveLength(2);
    expect(advisoryFor('edisto_river')[0].display_name).toBe('Edisto River (Colleton Co, SC)');
  });

  it('ONE FILE MISSING DOES NOT TAKE THE OTHER DOWN', () => {
    // Georgia's object landing in the bucket a week after South Carolina's is the normal case.
    _setAdvisoryCache(null);
    return primeFishAdvisories({
      worker: 'https://example.invalid',
      fetch: async (url) => (url.endsWith('ga_fish_advisories.json')
        ? { ok: false, status: 404 }
        : { ok: true, json: async () => ({ source: 'SC', waters: { edisto_river: EDISTO } }) }),
    }).then((res) => {
      expect(Object.keys(res)).toEqual(['edisto_river']);
    });
  });

  it('the file says where it came from, and a record may say it better', async () => {
    // South Carolina states its source once at the top of the file and Georgia repeats it on
    // every record. The record wins where it has an answer, so neither file has to be edited to
    // make the plan able to name the state beside a row.
    _setAdvisoryCache(null);
    await primeFishAdvisories({
      worker: 'https://example.invalid',
      fetch: async (url) => (url.endsWith('ga_fish_advisories.json')
        ? { ok: true, json: async () => ({ source: 'the file', waters: {
            seed_lake: HARTWELL_GA,
            lake_rabun: { ...CLEARED, source: undefined } } }) }
        : { ok: false, status: 404 }),
    });
    expect(advisoryRows('seed_lake', []).sources)
      .toEqual(['GA EPD, Guidelines For Eating Fish From Georgia Waters 2023']);
    expect(advisoryRows('lake_rabun', []).sources).toEqual(['the file']);
  });
});
