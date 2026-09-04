import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { researchIntel } from '../js/modules/plan-inputs.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE RESEARCH TAB IS THE VIEWER OF WHAT SMART PLAN RECEIVES
//
// THE_RESEARCH_TAB_BECOMES_THE_SMART_PLAN_INPUT_VIEWER_2026-09-02.md, in Ryan's words: "research
// is what goes into smart plan... that tab will be rebuilt to show everything that smartplan gets
// as an input", and the rule with it -- if a value reaches the plan prompt the tab shows it, and
// if it does not reach the plan it does not belong on the tab.
//
// The panel renders researchIntel() rather than describing it, because a second implementation of
// the block is a second answer waiting to disagree with the first. These tests hold that seam:
// the panel exists, it is wired, and the function it leans on still answers.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const UI = readFileSync(new URL('../js/modules/lake-research-ui.js', import.meta.url), 'utf8');

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

describe('the panel is mounted where the plan block belongs', () => {
  it('index.html carries the container, above Research Sections', () => {
    expect(HTML.includes('id="researchPlanInput"')).toBe(true);
    expect(HTML.indexOf('id="researchPlanInput"') < HTML.indexOf('id="researchSections"')).toBe(true);
  });

  it('renderProfile fills it, and does so BEFORE the stored sections', () => {
    expect(UI.includes('renderPlanInput(profile);')).toBe(true);
    expect(UI.indexOf('renderPlanInput(profile);') < UI.indexOf('renderSections(profile);')).toBe(true);
  });

  it('and it renders the plan\'s own function rather than a second copy of the block', () => {
    // A panel that rebuilds the block by hand is the failure this whole page exists to prevent.
    expect(/import \{ researchIntel \} from '\.\/plan-inputs\.js'/.test(UI)).toBe(true);
    expect(UI.includes('researchIntel(profile, sp, season')).toBe(true);
  });
});

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

  it('says out loud whether the profile is verified, because the panel prints that line', () => {
    const v = researchIntel(PROFILE, 'Largemouth Bass', 'summer', Date.parse('2026-09-04'));
    expect(v.includes('(verified)')).toBe(true);
    const d = researchIntel({ ...PROFILE, metadata: { status: 'draft' } },
                            'Largemouth Bass', 'summer', Date.parse('2026-09-04'));
    expect(d.includes('NOT yet verified')).toBe(true);
  });
});
