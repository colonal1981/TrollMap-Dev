// ONE PROMPT, TWO PLANNERS, AND ONLY ONE OF THEM FILLING IT IN.
//
// Ryan, 2026-08-30, on a Pick Water plan for Lake Wateree, SC: "so that note shows up but the
// plan actually shows the research profile". Both halves were true. The plan card's Lake
// Intelligence Briefing is assembled by lake-intel from the researched profile -- v140.0, 96%
// confidence, 66 ft max depth, a 27 ft summer thermocline -- while the PROMPT that produced the
// day was handed `intel: undefined` and fell to its no-research fallback. The model repeated it
// back in the rationale: "Since no profile exists for this water, rely on sonar".
//
// plan-water-ui.js WAS loading the profile. `const researched = await loadResearchedProfile(...)`
// sits twelve lines above, spends it on depthBandFor(), and drops it. Smart Plan has sent `intel`
// since 2026-08-07; Pick Water never did.
//
// It was not alone. buildPlanRequest reads nineteen fields off its argument and NOTHING IN THE
// CODEBASE HELD THE TWO CALLERS TO THE SAME LIST, so a field could be added, documented and read
// by the prompt while one planner -- or, for `hazards`, BOTH -- silently sent nothing:
//
//   intel         Smart Plan yes, Pick Water no    -> "no profile exists" on a researched lake
//   snapEligible  Smart Plan yes, Pick Water no    -> "(unknown -- treat everything as tie-only)"
//   hazards       NEITHER                          -> the safety note has never once fired
//
// So this file is the list. It reads the contract out of plan-prompt.js rather than restating it,
// because a hand-written copy is the next thing to go stale.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';
import { researchHazards } from '../js/modules/plan-inputs.js';
import { snapEligibleFrom, TERMINAL_CONNECTION } from '../js/data/lure-knowledge.js';
import { chartedHazards, HAZARD_POI_TYPES } from '../js/modules/plan-candidates.js';
import { buildPlanRequest } from '../js/modules/plan-prompt.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');
// Comments mention these names too, and a mention in prose is not a field being sent. Three of my
// own assertions have already been tripped by my own commentary.
const live = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const prompt = src('js/modules/plan-prompt.js');
// Everything buildPlanRequest actually reads off its options object.
const CONTRACT = [...new Set(live(prompt).match(/\bo\.[A-Za-z_][A-Za-z0-9_]*/g) || [])]
  .map((s) => s.slice(2)).sort();

// The two planners, and the module each one hands the request through.
const CALLERS = {
  'Smart Plan': ['js/modules/smart-plan-v2.js', 'js/modules/smart-plan-v2-wiring.js'],
  'Pick Water': ['js/modules/plan-from-water.js', 'js/modules/plan-water-ui.js'],
};

describe('the prompt contract', () => {
  it('is read off plan-prompt.js and is not empty', () => {
    expect(CONTRACT.length > 10).toBe(true);
    for (const f of ['intel', 'hazards', 'snapEligible', 'candidates', 'tackle']) {
      expect(CONTRACT.includes(f)).toBe(true);
    }
  });

  // FIVE FIELDS ARE GENUINELY ONE-SIDED, and the prompt says which: everything below line 399 is
  // guarded by `o.waterIsChosen`, the branch that exists because Pick Water hands over water Ryan
  // ticked himself and Smart Plan does not. They are the picked-water dialect, not a gap.
  //
  // The list is here rather than derived because deriving it from "which files mention it" would
  // be circular -- it would call any unfilled field one-sided and pass forever. Stated, it does
  // the opposite: a NEW prompt field wired into only one planner fails this test, and clearing
  // the failure means either wiring the other planner or writing down why it does not apply.
  // That review is the thing that was missing when `intel`, `snapEligible` and `hazards` went in.
  const PICKED_WATER_DIALECT = ['castStopsWanted', 'chosenCastSpots', 'freeCastSpots',
                                'orderIsChosen', 'waterIsChosen'];

  // A field name that appears NOWHERE in a planner cannot possibly be sent by it. That is a
  // weaker claim than "the value is right", and it is deliberately the claim that catches the
  // bug that actually happened three times: the field was simply absent.
  for (const [who, files] of Object.entries(CALLERS)) {
    it(`${who} mentions every field the prompt reads`, () => {
      const text = files.map((f) => live(src(f))).join('\n');
      const missing = CONTRACT.filter((f) => !new RegExp(`\\b${f}\\b`).test(text));
      const unexplained = missing.filter((f) => !PICKED_WATER_DIALECT.includes(f));
      expect(unexplained).toEqual([]);
    });
  }

  it('and every one-sided field really is one of the picked-water pair', () => {
    const pw = live(src('js/modules/plan-from-water.js')) + live(src('js/modules/plan-water-ui.js'));
    for (const f of PICKED_WATER_DIALECT) expect(new RegExp(`\\b${f}\\b`).test(pw)).toBe(true);
  });
});

describe('what the research says will hurt you', () => {
  // The shape measured off the live Worker for Lake Wateree, SC on 2026-08-30, not invented:
  // navigation.hazards is an array of sentences.
  const WATEREE = {
    navigation: {
      hazards: ['Severe thunderstorms historical activity near Lake Wateree dam',
                'Construction activity: S-20-101 (River Road) bridge replacement (Project ID P029350)'],
      notes: 'Public access is available at Lake Wateree State Recreational Area.',
    },
  };

  it('reads navigation.hazards, which is where the research agent writes them', () => {
    expect(researchHazards(WATEREE).length).toBe(2);
    expect(researchHazards(WATEREE)[0]).toMatch(/Severe thunderstorms/);
  });

  it('takes the object form too, and keeps the location it carries', () => {
    const p = { navigation: { hazards: [{ description: 'Submerged pilings', location: 'old US-21 crossing' }] } };
    expect(researchHazards(p)).toEqual(['Submerged pilings (old US-21 crossing)']);
  });

  it('counts drawdown notes as a navigation hazard, the way lake-intel already did', () => {
    const p = { navigation: { hazards: ['a'], drawdownNotes: 'winter drawdown to 220 ft' } };
    expect(researchHazards(p)).toEqual(['a', 'winter drawdown to 220 ft']);
  });

  it('is empty, never null, when a lake has no profile at all', () => {
    expect(researchHazards(null)).toEqual([]);
    expect(researchHazards({})).toEqual([]);
  });

  it('does not repeat itself', () => {
    expect(researchHazards({ navigation: { hazards: ['a', 'a', ''] } })).toEqual(['a']);
  });

  it('reaches the safety section, and is kept apart from the charted kind', () => {
    const req = buildPlanRequest({ water: 'Lake Wateree, SC', species: ['Striped Bass'],
                                   tackle: [], candidates: [], hazards: researchHazards(WATEREE) });
    const txt = JSON.stringify(req);
    expect(txt.includes('S-20-101')).toBe(true);
    expect(txt.includes('WHAT IS IN THE WAY')).toBe(true);
    expect(txt.includes('never imply an unpositioned one is marked on the chart')).toBe(true);
  });

  it('and says nothing at all when there is nothing in the way', () => {
    const req = buildPlanRequest({ water: 'x', species: [], tackle: [], candidates: [], hazards: [] });
    expect(JSON.stringify(req).includes('WHAT IS IN THE WAY')).toBe(false);
  });
});

// 91 CHARTED HAZARDS PER LAKE, SITTING IN A FILE BOTH PLANNERS ALREADY FETCH.
//
// The prompt's hazard sentence said "marked hazard zones on this water" and no chartpack has a
// hazards layer, so nothing ever filled it -- while pois.geojson carried them all along, typed and
// positioned off Garmin's survey. RESEARCH_REFACTOR_END_STATE_2026-08-27.md §2 names this exact
// pair of failures: an agent inventing prose hazards into a field whose only reader looked for a
// different name, and 33 charted ones per lake that nothing reads.
describe('what Garmin charted that can hurt you', () => {
  // poi_type values counted off the real wateree_lake pack, 2026-08-30.
  const POIS = { features: [
    ...Array.from({ length: 33 }, () => ({ properties: { poi_type: 'danger_buoy' } })),
    ...Array.from({ length: 32 }, () => ({ properties: { poi_type: 'obstruction' } })),
    ...Array.from({ length: 13 }, () => ({ properties: { poi_type: 'hazard_area' } })),
    ...Array.from({ length: 12 }, () => ({ properties: { poi_type: 'pile' } })),
    { properties: { poi_type: 'caution_buoy' } },
    // The three that are deliberately NOT hazards -- see chartedHazards().
    ...Array.from({ length: 34 }, () => ({ properties: { poi_type: 'slow_no_wake' } })),
    ...Array.from({ length: 13 }, () => ({ properties: { poi_type: 'restricted_area' } })),
    ...Array.from({ length: 38 }, () => ({ properties: { poi_type: 'height_marker' } })),
  ] };

  it('counts the kinds that can hole a hull, commonest first', () => {
    const [line] = chartedHazards(POIS);
    expect(line.startsWith('33 danger buoys, 32 charted obstructions, 13 hazard areas, 12 piles, '
                         + '1 caution buoy')).toBe(true);
  });

  it('leaves out no-wake, restricted areas and clearance gauges', () => {
    const [line] = chartedHazards(POIS);
    for (const t of ['no-wake', 'restricted', 'height', 'marker']) {
      expect(line.toLowerCase().includes(t)).toBe(false);
    }
    for (const t of ['slow_no_wake', 'restricted_area', 'height_marker']) {
      expect(t in HAZARD_POI_TYPES).toBe(false);
    }
  });

  it('says the count is Garmin, so the prompt can keep it apart from the prose', () => {
    expect(chartedHazards(POIS)[0]).toMatch(/charted on this water by Garmin's survey/);
  });

  it('is empty on a pack with no hazard POIs, and on no pack at all', () => {
    expect(chartedHazards({ features: [{ properties: { poi_type: 'marina' } }] })).toEqual([]);
    expect(chartedHazards(null)).toEqual([]);
    expect(chartedHazards({})).toEqual([]);
  });

  it('is fetched from the pack both planners already hold, not a new request', () => {
    for (const f of ['js/modules/smart-plan-v2.js', 'js/modules/plan-water-ui.js']) {
      const t = live(src(f));
      expect(t).toMatch(/hazards:\s*\[\s*\.\.\.chartedHazards\(/);
      // one pois.geojson fetch per planner, the one that was already there
      expect((t.match(/pois\.geojson/g) || []).length).toBe(1);
    }
  });
});

describe('which lures may hang off a snap', () => {
  const BAG = [{ name: 'Rat-L-Trap', type: 'lipless' }, { name: 'Bucktail', type: 'bucktail_jig' },
               { name: 'Fluke', type: 'soft_jerkbait' }];

  it('is canTakeSnap over the bag, not a second copy of the test', () => {
    const want = BAG.filter((l) => TERMINAL_CONNECTION[l.type] && TERMINAL_CONNECTION[l.type] !== 'tie')
                    .map((l) => l.name);
    expect(snapEligibleFrom(BAG)).toEqual(want);
  });

  it('survives an empty or missing bag', () => {
    expect(snapEligibleFrom()).toEqual([]);
    expect(snapEligibleFrom([])).toEqual([]);
  });

  it('no longer exists as a hand-rolled copy inside a planner', () => {
    for (const f of ['js/modules/smart-plan-v2.js', 'js/modules/plan-water-ui.js']) {
      expect(live(src(f)).includes("connectionFor(l.type) !== 'tie'")).toBe(false);
    }
  });
});

describe('Pick Water carries the research it already loaded', () => {
  const ui = live(src('js/modules/plan-water-ui.js'));

  it('derives the intel where the profile, the species and the date all exist', () => {
    expect(ui).toMatch(/intel:\s*researchIntel\(researched,\s*species,\s*getSeason\(date\)\)/);
    expect(ui).toMatch(/hazards:\s*\[\.\.\.chartedHazards\(poFc\), \.\.\.researchHazards\(researched\)\]/);
  });

  it('and hands them to the prompt from the tab state, across the two functions', () => {
    expect(ui).toMatch(/intel:\s*T\.intel/);
    expect(ui).toMatch(/hazards:\s*T\.hazards/);
    expect(ui).toMatch(/snapEligible:\s*snapEligibleFrom\(castable\)/);
  });
});
