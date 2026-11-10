// Personal use only, not for distribution or resale; not for navigation.
//
// THE CONGAREE IS IN THE SANTEE CLOSURE, AND THE REGULATIONS ROUTE CAN NOW FIND IT.
//
// Found 2026-11-09 building the "Which lake?" card: the app read the Wateree River closed to stripers June 16 - Sept 30
// and the Congaree "No closure information for this water -- verify before you keep one". The book's Santee River system
// is "All waters of Santee River including tributaries ... upstream to the Lake Murray Dam on the Saluda River, the Canal
// Dam on the Broad River, and the Wateree Dam on the Wateree River" (SC 2026-2027 guide), and the offline table already
// carries both rows on `congaree_river`. The route never reached them: the app says "Congaree River, SC", the registry
// says "Congaree River (to SC-601), SC", and the last pass of resolveRegistryRow() left a space before the comma when it
// took the parenthetical out. Ryan, the same evening: "yes congaree closes from june 16th through sept 30".
import { describe, it, expect } from './expect-shim.mjs';
import { resolveRegistryRow } from '../Worker/registry.js';
import { primeRegulations, _resetRegulationsCache } from '../js/data/regulations-live.js';
import { checkRegulations } from '../js/data/species-intel.js';

// The name fields of these rows, copied from registry/lake_index.json (his PC, 2026-10-05).
const INDEX = {
  congaree_river: { slug: 'congaree_river', state: 'SC', feature_type: 'river', name: 'Congaree River (to SC-601)',
    display_name: 'Congaree River (to SC-601) (Richland Co, SC)', legacy_display_name: 'Congaree River (to SC-601), SC',
    legacy_display_names: ['Congaree River (to SC-601), SC'] },
  wateree_river: { slug: 'wateree_river', state: 'SC', feature_type: 'river', name: 'Wateree River',
    display_name: 'Wateree River (Richland Co, SC)', legacy_display_name: 'Wateree River, SC',
    legacy_display_names: ['Wateree River, SC'] },
  bates_old_river: { slug: 'bates_old_river', state: 'SC', feature_type: 'lake', name: 'Bates Old River',
    display_name: 'Bates Old River (Richland Co, SC)', legacy_display_name: 'Bates Old River, SC',
    legacy_display_names: ['Bates Old River, SC'] },
  saluda_river: { slug: 'saluda_river', state: 'SC', feature_type: 'river', name: 'Saluda River',
    display_name: 'Saluda River (Greenville Co, SC)', legacy_display_name: 'Saluda River, SC',
    legacy_display_names: ['Saluda River, SC'] },
  saluda_river_2: { slug: 'saluda_river_2', state: 'SC', feature_type: 'river', name: 'Saluda River (2)',
    display_name: 'Saluda River (2) (Newberry Co, SC)', legacy_display_name: 'Saluda River (2), SC',
    legacy_display_names: ['Saluda River (2), SC'] },
  // MADE UP, for the refusal: two rows that differ only inside the parenthetical.
  twin_creek_a: { slug: 'twin_creek_a', state: 'SC', name: 'Twin Creek (upper)', legacy_display_names: ['Twin Creek (upper), SC'] },
  twin_creek_b: { slug: 'twin_creek_b', state: 'SC', name: 'Twin Creek (lower)', legacy_display_names: ['Twin Creek (lower), SC'] },
};

describe('the app\'s names reach their rows', () => {
  it('"Congaree River, SC" reaches congaree_river', () => {
    expect(resolveRegistryRow(INDEX, 'Congaree River, SC').slug).toBe('congaree_river');
  });

  it('the names that resolved before still resolve the same way', () => {
    expect(resolveRegistryRow(INDEX, 'Wateree River, SC').slug).toBe('wateree_river');
    expect(resolveRegistryRow(INDEX, 'Bates Old River (Richland Co, SC)').slug).toBe('bates_old_river');
  });

  it('the state suffix still has to match: the Congaree is not reached as an NC water, or with no state', () => {
    expect(resolveRegistryRow(INDEX, 'Congaree River, NC')).toBe(null);
    expect(resolveRegistryRow(INDEX, 'Congaree River, GA')).toBe(null);
  });

  it('an exact name still wins before the parenthetical is dropped: "Saluda River, SC" is the Greenville row', () => {
    expect(resolveRegistryRow(INDEX, 'Saluda River, SC').slug).toBe('saluda_river');
  });

  it('two rows the parenthetical told apart are still refused, not guessed', () => {
    expect(resolveRegistryRow(INDEX, 'Twin Creek, SC')).toBe(null);
  });
});

describe('and once it is reached, the book\'s closure gates the plan', () => {
  // The route's answer for the Congaree once book_slug resolves; the closure is the table's own row for
  // congaree_river (registry/regulations_table.json, 2026-09-24), the same one Lake Marion and the Wateree River carry.
  const PAYLOAD = { parse_failed: false, general: {}, lake_specific: null, has_exceptions: null, saltwater: {},
    saltwater_source: null, closures_error: null, state: 'SC', lake: 'Congaree River, SC', book_slug: 'congaree_river',
    book_rules: null, closures: [
      { effect: 'closed', applies_to: 'harvest', start: '06-16', end: '09-30',
        species: 'Striped or Hybrid Bass or a combination', species_known: true,
        plan_species: ['Striped Bass', 'Hybrid'], species_basis: 'exact', source: 'SC Regs2627.pdf',
        text: 'June 16 - Sept. 30 closed except for Lower Reach Saluda River where catch and release is allowed' },
    ] };

  it('stripers on the Congaree on July 8 are refused; June 15, Oct 1 and a bass trip are not', async () => {
    _resetRegulationsCache();
    await primeRegulations('SC', 'Congaree River, SC',
      { worker: 'https://w', fetch: async () => ({ ok: true, json: async () => PAYLOAD }), now: 1000 });
    const on = (sp, iso) => checkRegulations('Congaree River, SC', sp, new Date(`${iso}T12:00:00`), 'SC').legal;
    expect(on('Striped Bass', '2026-07-08')).toBe(false);
    expect(on('Hybrid', '2026-06-16')).toBe(false);
    expect(on('Striped Bass', '2026-06-15')).toBe(true);
    expect(on('Striped Bass', '2026-10-01')).toBe(true);
    expect(on('Largemouth Bass', '2026-07-08')).toBe(true);
  });
});
