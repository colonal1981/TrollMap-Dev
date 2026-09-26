import { describe, it, expect } from './expect-shim.mjs';
import { researchIntel } from '../js/modules/plan-inputs.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE RESEARCH TAB IS THE VIEWER OF WHAT SMART PLAN RECEIVES
//
// THE_RESEARCH_TAB_BECOMES_THE_SMART_PLAN_INPUT_VIEWER_2026-09-02.md, in Ryan's words: "research
// is what goes into smart plan... that tab will be rebuilt to show everything that smartplan gets
// as an input", and the rule with it -- if a value reaches the plan prompt the tab shows it, and
// if it does not reach the plan it does not belong on the tab.
//
// The panel rendered researchIntel() rather than describing it, because a second implementation of
// the block is a second answer waiting to disagree with the first.
//
// THE TAB WAS DELETED ON 2026-09-25. Ryan: "nothing the tab writes should be used anymore". The
// three tests that held the panel's wiring went with it; the function it leaned on is what the
// plan still calls, and the tests of that stay below.
// ─────────────────────────────────────────────────────────────────────────────────────────────


const PROFILE = {
  lakeName: 'Test Water, SC',
  metadata: { status: 'verified', lastUpdated: '2026-09-01T00:00:00.000Z', version: 4 },
  biology: { predatorSpecies: ['Largemouth Bass', 'Blue Catfish'], primaryForage: 'Gizzard Shad' },
  limnology: { trophicStatus: 'eutrophic', thermocline: { summerDepthFt: 18 } },
  trollingIntelligence: {
    'Largemouth Bass': {
      // FIELD NAMES READ OFF A REAL PROFILE, not guessed: allatoona_lake_ga.json carries
      // ['forage','notes','preferredDepth','recommendedPresentations','structures']. The first
      // version of this fixture said `depthBandFt` and failed against correct code -- which is
      // the same trap plan-inputs.js already documents at this exact call site.
      summer: { preferredDepth: [12, 18], structures: 'ledges', forage: 'shad',
                recommendedPresentations: 'crankbait', notes: 'bait on the points' },
    },
  },
};

describe('and the block it shows is the block the plan gets', () => {
  it('emits the species the profile carries a band for', () => {
    const txt = researchIntel(PROFILE, 'Largemouth Bass', 'summer', Date.parse('2026-09-04'));
    expect(txt.includes('Researched for Largemouth Bass, summer: 12-18 ft')).toBe(true);
    expect(txt.includes('ledges')).toBe(true);
  });

  it('still answers with no species, so a profile without a band is not silently blank', () => {
    const txt = researchIntel(PROFILE, null, 'summer', Date.parse('2026-09-04'));
    expect(!!txt).toBe(true);
    expect(txt.includes('Thermocline in summer')).toBe(true);
  });

  it('returns null for a profile that reaches no plan at all', () => {
    expect(researchIntel({ metadata: {} }, 'Largemouth Bass', 'summer')).toBe(null);
    expect(researchIntel(null, 'Largemouth Bass', 'summer')).toBe(null);
  });

  it('says how old the profile is, which is what replaced the verified line', () => {
    // THE VERIFIED LINE IS GONE ON PURPOSE and this assertion outlived it. `NOT yet verified --
    // weigh accordingly` opened every Congaree prompt and all it meant was that nobody had clicked
    // a button in the research tab -- Ryan: "once we remove the research tab... there won't be a
    // way to verify them or mark them verified". A plan that discounts its own research because of
    // a missing click plans off general knowledge instead, which is the failure the block exists to
    // prevent. What the header carries now is what the profile IS and when it was taken.
    const v = researchIntel(PROFILE, 'Largemouth Bass', 'summer', Date.parse('2026-09-04'));
    expect(v.startsWith('Researched profile for this water')).toBe(true);
    expect(/research|date|old|ago|unknown age/i.test(v.split('\n')[0])).toBe(true);
    // And a draft reads the same, because the status was never the useful fact. ONLY THE STATUS
    // CHANGES: spreading `metadata: { status: 'draft' }` replaces the whole block and drops
    // `lastUpdated` with it, so the header went from "researched 3 days ago" to "of unknown age"
    // and the comparison failed on the date rather than on the status. Two things changed at once.
    const d = researchIntel({ ...PROFILE, metadata: { ...PROFILE.metadata, status: 'draft' } },
                            'Largemouth Bass', 'summer', Date.parse('2026-09-04'));
    expect(d.includes('NOT yet verified')).toBe(false);
    expect(d.split('\n')[0]).toBe(v.split('\n')[0]);
  });
});
