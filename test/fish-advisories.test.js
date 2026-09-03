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
 * Fourteen of the sixty-two bound waters carry a DO NOT EAT species, and on five of them it is
 * LARGEMOUTH BASS — the Edisto, Little Pee Dee, Lumber, Waccamaw and Savannah — plus striped
 * bass on Hartwell. The state naming the fish somebody is most likely to be targeting is the
 * case this whole section exists for, so it is the first thing tested.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

const EDISTO = {
  display_name: 'Edisto River (Colleton Co, SC)',
  state: 'SC', water_type: 'freshwater',
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

  it('it reads the waters object off the published shape', async () => {
    _setAdvisoryCache(null);
    const res = await primeFishAdvisories({
      worker: 'https://example.invalid/',
      fetch: async (url) => {
        expect(url).toBe('https://example.invalid/chartpacks/_registry/sc_fish_advisories.json');
        return { ok: true, json: async () => ({ waters: { edisto_river: EDISTO } }) };
      },
    });
    expect(Object.keys(res)).toEqual(['edisto_river']);
    expect(advisoryFor('edisto_river').display_name).toBe('Edisto River (Colleton Co, SC)');
  });
});
