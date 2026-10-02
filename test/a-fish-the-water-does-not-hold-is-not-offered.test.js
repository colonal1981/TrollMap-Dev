/**
 * a-fish-the-water-does-not-hold-is-not-offered.test.js
 *
 * 2026-10-02. Ryan planned the Recreation Lake at Monticello for Striped Bass by accident: "I
 * accidently ran the plan as striper which are not in this lake... funny thing is it created a plan
 * though lol". Monticello's researched roster names fifteen fish and Striped Bass is not one of them,
 * so the picker's filter should never have offered the box. It did, because two things were kept
 * whatever the roster said -- the default tick (Striped Bass is the freshwater default) and any
 * species already ticked, which a lake change from fresh water to fresh water carries over. Neither
 * was his decision. His: "i thought we had built into the plan tab that the check boxes only show
 * up for fish that are researched if a research profile exists".
 *
 * And the plan says so when it is still asked for such a fish -- he said YES to that the same day.
 * The picker filters only once its copy of the roster has loaded, so a plan asked for before then
 * carries the default tick; the planner reads its own copy and annotates, never refuses.
 *
 * The roster is the live profile's, read off /research/get that evening:
 * test/fixtures/monticello-roster-2026-10-02.json.
 *
 *   node --test test/a-fish-the-water-does-not-hold-is-not-offered.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { speciesGroupsFor, speciesNotHeld, rosterNote } from '../js/modules/species-selector.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/monticello-roster-2026-10-02.json', import.meta.url), 'utf8'));
const MONTICELLO = {
  biology: { predatorSpecies: FX.biology.predatorSpecies },
  trollingIntelligence: Object.fromEntries(FX.trollingIntelligenceKeys.map((k) => [k, {}])),
};
// Murray's roster the same evening named Striped Bass, so the box has to stay there.
const MURRAY = { biology: { predatorSpecies: ['Largemouth Bass', 'White Bass / Hybrid', 'Striped Bass',
  'Black Crappie', 'Blue Catfish', 'White Perch'] } };
const values = (groups) => groups.flatMap((g) => g.species.map((s) => s.value));
const src = (f) => readFileSync(new URL(`../js/modules/${f}`, import.meta.url), 'utf8');

describe('the picker offers what the roster names', () => {
  it('Monticello does not offer Striped Bass', () => {
    expect(values(speciesGroupsFor(FX.key, MONTICELLO))).not.toContain('Striped Bass');
  });

  it('and still offers what it holds, group boxes through `covers`', () => {
    const v = values(speciesGroupsFor(FX.key, MONTICELLO));
    for (const s of ['Largemouth Bass', 'Smallmouth Bass', 'Spotted Bass', 'Hybrid', 'White Bass',
      'White Perch', 'Crappie', 'Catfish', 'Bluegill', 'Warmouth']) expect(v).toContain(s);
  });

  it('Murray still offers Striped Bass', () => {
    expect(values(speciesGroupsFor('lake_murray', MURRAY))).toContain('Striped Bass');
  });

  it('a water with no roster still shows the whole catalogue, default tick and all', () => {
    const groups = speciesGroupsFor(FX.key, null);
    expect(values(groups).length).toBe(35);
    expect(groups.flatMap((g) => g.species).filter((s) => s.checked).map((s) => s.value))
      .toEqual(['Striped Bass']);
  });

  it('the re-render no longer hands its ticks to the filter', () => {
    expect(src('species-selector.js').includes('speciesGroupsFor(key, profile);')).toBe(true);
  });
});

describe('the plan says when the fish is not on the list', () => {
  it('names Striped Bass on Monticello', () => {
    expect(speciesNotHeld(FX.key, MONTICELLO, ['Striped Bass'])).toEqual(['Striped Bass']);
    const note = rosterNote(FX.key, FX.lake, MONTICELLO, ['Striped Bass']);
    expect(note).toContain('Striped Bass is not on Lake Monticello, SC');
    expect(note).toContain('researched species list');
  });

  it('says nothing for a fish the roster names, a group box included', () => {
    expect(rosterNote(FX.key, FX.lake, MONTICELLO, ['Largemouth Bass'])).toBe(null);
    expect(rosterNote(FX.key, FX.lake, MONTICELLO, ['Crappie', 'Catfish', 'Hybrid'])).toBe(null);
  });

  it('names only the ones missing when he picks several', () => {
    expect(speciesNotHeld(FX.key, MONTICELLO, ['Largemouth Bass', 'Striped Bass', 'Walleye']))
      .toEqual(['Striped Bass', 'Walleye']);
    expect(rosterNote(FX.key, FX.lake, MONTICELLO, ['Striped Bass', 'Walleye']))
      .toContain('Striped Bass and Walleye are not on');
  });

  it('says nothing where the water has no roster -- no opinion is not no fish', () => {
    expect(rosterNote(FX.key, FX.lake, null, ['Striped Bass'])).toBe(null);
    expect(rosterNote(FX.key, FX.lake, { biology: {} }, ['Striped Bass'])).toBe(null);
  });

  it('a fish only the research names counts as named', () => {
    const p = { biology: { predatorSpecies: ['Largemouth Bass'] }, trollingIntelligence: { Bream: {} } };
    expect(speciesNotHeld('lake_marion', p, ['Bream'])).toEqual([]);
  });

  it('both planners put it on the plan, from the one sequence they share', () => {
    const wiring = src('smart-plan-v2-wiring.js');
    const prep = wiring.slice(wiring.indexOf('export async function preparePlanInputs('));
    expect(prep.slice(0, prep.indexOf('\n}\n')).includes('rosterNote(')).toBe(true);
    expect(prep.slice(0, prep.indexOf('\n}\n')).includes('return { researched, legality, roster }')).toBe(true);
    for (const f of ['smart-plan-v2-wiring.js', 'plan-water-ui.js']) {
      const s = src(f);
      expect(s.includes('const { researched, legality, roster } = await preparePlanInputs(')).toBe(true);
      expect(s.includes('if (roster) r.problems = [roster, ...(r.problems || [])];')).toBe(true);
    }
  });

  it('Smart Plan adds it after the no-plan branch, whose status line is the first problem', () => {
    const s = src('smart-plan-v2-wiring.js');
    const noPlan = s.indexOf("say(r.problems[0] || 'No plan', true);");
    const add = s.indexOf('if (roster) r.problems = [roster');
    const bench = s.indexOf('if (opts.bench) {');
    expect(noPlan > 0 && add > noPlan && bench > add).toBe(true);
  });
});
