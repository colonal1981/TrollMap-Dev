import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');

// ---------------------------------------------------------------------------
// Why this test exists
//
// Ryan, 2026-08-07: "see it is stuff like this that needs tests... you were
// going to miss wiring up an entire pipeline built for smart plan to have the
// intel it needs to plan."
//
// He is right, and the failure is a genre, not a bug. SmartPlan v2 shipped
// with 931 passing tests while using a four-lake hardcoded table and ignoring
// the research pipeline entirely -- a pipeline whose whole purpose is to
// produce per-lake fishing intelligence. Every unit test passed because every
// unit did what it said. Nothing asserted that the units were CONNECTED.
//
// So this test is about reachability, not correctness:
//
//   1. the planner loads a research profile at all
//   2. every field the research agents produce is either consumed by the
//      planner or explicitly excused, with a reason
//
// When the pipeline grows a field, this fails until somebody decides whether
// the planner should use it. That decision then lives in the allowlist below
// instead of never being made.
//
// NOTE ON METHOD. `DELETION_TAB.md` is rightly rude about tests that grep
// source for an identifier and pass when it appears in a comment -- that
// exact failure cost four deploys on 2026-08-04. So comments and strings are
// stripped before matching, and the planner files are read as CODE.
// ---------------------------------------------------------------------------

// Everything between the research profile and the model.
const PLAN_PATH = [
  'js/modules/plan-inputs.js',
  'js/modules/smart-plan-v2-wiring.js',
  'js/modules/smart-plan-v2.js',
  'js/modules/plan-prompt.js',
];

/** Source with comments and string literals removed, so a mention in prose cannot count. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // block comments
    .replace(/^\s*\/\/.*$/gm, ' ')          // line comments
    .replace(/\/\/[^\n'"`]*$/gm, ' ')       // trailing comments without quotes in them
    .replace(/`(?:[^`\\]|\\.)*`/g, ' ')     // template literals (the prompt text lives here)
    .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ');
}

const PLANNER_CODE = PLAN_PATH.map((p) => codeOnly(read(p))).join('\n');
const PLANNER_RAW = PLAN_PATH.map((p) => read(p)).join('\n');

/** Every field the research agents are told to produce. */
function agentTargetFields() {
  const src = read('js/modules/lake-research-engine.js');
  const out = new Set();
  for (const block of src.match(/targetFields:\s*\[[^\]]*\]/g) || []) {
    for (const q of block.match(/'([^']+)'/g) || []) out.add(q.replace(/'/g, ''));
  }
  return [...out].sort();
}

// A field is excused only with a reason. "Not used" is a decision that has to be written down,
// which is the entire point -- an unexplained absence is how the whole pipeline went unwired.
// The `identity.*` excuses went with the identity agent, the coastal ones with `estuary` and
// `tidal` (2026-08-31), and the `navigation.*` ones with the navigation agent (2026-09-01). An excuse is for a field an agent
// still hunts and the planner declines to read; a field nothing hunts needs no excuse.
const NOT_FOR_THE_PLANNER = {
  'biology.invasiveSpecies': 'regulatory and ecological, does not change where to troll',
  'biology.speciesAbundance': 'prose about the fishery; the catch journal is the local truth',
  'biology.predatorSpecies': 'the species being targeted is chosen in the form',
  'habitat.cover': 'superseded by the pack: docks, timber and attractors arrive as geometry',
  'habitat.dockDensity': 'docks.geojson carries every dock individually',
  'habitat.riprapLocations': 'no riprap layer in the pack yet — see DELETION_TAB custom-vectors',
  'habitat.shallowFlatAreas': 'depth_areas.geojson is finer than a prose description',
  'habitat.artificialHabitat': 'the Details.attractorCount/Types fields carry the usable form',
  // `navigation.hazards` WAS EXCUSED HERE with "handed to the prompt from the pack, not the
  // profile" -- half true and the half that was false hid a gap. The pack's charted hazards were
  // reaching nothing, and neither was the profile's prose. Both do now, chart first, so this is a
  // consumed field and the test below is what checks it.
  //
  // The three regulations entries that stood here are gone with the agents that produced them:
  // no `targetFields` names them any more, so excusing them was a stale excuse -- which is the
  // exact thing the last test in this file is for, and it is what caught them.
  // Coastal / tidal. v2 has only been run on reservoirs; when it plans a coastal day these
  // become real and this list should shrink.
  //
  // `limnology.waterClarity.color` was excused here as "typical + secchi already carry clarity".
  // That was an argument for deleting the field, not for keeping it unread, and on 2026-09-01 it
  // was deleted along with the agent that wrote it. No targetFields names it, so the excuse would
  // now be stale -- which the last test in this file checks for.
};

describe('the research pipeline reaches the planner', () => {
  it('the planner loads a research profile at all', () => {
    // The one-line version of the whole failure: v2 never asked for one.
    expect(/getResearchedProfile|research\/get/.test(PLANNER_RAW)).toBe(true);
  });

  it('a researched depth band outranks the hardcoded table', () => {
    // INSIDE depthBandFor's body, not across the file -- the import line names the table at the
    // top regardless of what the logic does, and comparing whole-file positions passed a broken
    // precedence in the first version of this test.
    const src = codeOnly(read('js/modules/plan-inputs.js'));
    const from = src.indexOf('function depthBandFor');
    const to = src.indexOf('function researchedBand');
    expect(from >= 0 && to > from).toBe(true);
    const body = src.slice(from, to);
    const iResearch = body.indexOf('researchedBand');
    const iTable = body.indexOf('SPECIES_BEHAVIOR_V2');
    expect(iResearch >= 0 && iTable >= 0).toBe(true);
    expect(iResearch < iTable).toBe(true);
  });

  it('the profile reaches the prompt, not just the depth filter', () => {
    // THIS ASSERTION USED TO PASS BY ACCIDENT, and the way it did is worth keeping.
    //
    // It ran `/intel/` against codeOnly(plan-prompt.js), and codeOnly() STRIPS TEMPLATE
    // LITERALS -- which is where the entire prompt lives. `intel` only survived the strip
    // because the old code nested a backtick inside the outer template literal, which
    // terminated the stripper's non-greedy match early and left the rest of the file exposed.
    // Flattening that nesting on 2026-08-20 made the test fail against code that was MORE
    // correct, not less.
    //
    // So it reads the RAW source for the prompt file: the prompt is text, and stripping the
    // text before looking for it is asking the wrong question.
    expect(/researchIntel/.test(codeOnly(read('js/modules/smart-plan-v2-wiring.js')))).toBe(true);
    const prompt = read('js/modules/plan-prompt.js');
    expect(prompt).toContain('WHAT IS ALREADY KNOWN');
    expect(prompt).toContain('o.intel');
  });

  it('an ABSENT profile is stated, not silently omitted', () => {
    // The block used to render only `${o.intel ? ... : ''}`, so a water with no research
    // produced a prompt with no mention of research at all -- and the model cannot tell
    // "nobody has studied this water" from "it was studied and nothing was found".
    const prompt = read('js/modules/plan-prompt.js');
    expect(prompt).toMatch(/No researched profile exists for this water/);
  });

  it('and the prompt says how old the research is', () => {
    // metadata.lastUpdated is on every profile and three places in the UI already show it to a
    // person. The one place that hands the research to a MODEL never read it.
    expect(read('js/modules/plan-inputs.js')).toContain('ageSentence');
  });

  it('every field the research agents produce is used or explicitly excused', () => {
    const unaccounted = [];
    for (const field of agentTargetFields()) {
      if (field in NOT_FOR_THE_PLANNER) continue;
      // Match the leaf, which is how it is read: `lim.thermocline.summerDepthFt`.
      const leaf = field.split('.').pop();
      if (!new RegExp(`\\b${leaf}\\b`).test(PLANNER_CODE)) unaccounted.push(field);
    }
    // The message matters more than the assertion: this is the list of decisions nobody made.
    expect(unaccounted).toEqual([]);
  });

  it('nothing is excused without a reason', () => {
    for (const [field, why] of Object.entries(NOT_FOR_THE_PLANNER)) {
      expect(typeof why === 'string' && why.length > 12).toBe(true);
      if (!why) throw new Error(`${field} is excused with no reason`);
    }
  });

  it('the excuse list does not outlive the fields it excuses', () => {
    // A stale excuse hides a field that was renamed, which is the same silence in reverse.
    const fields = new Set(agentTargetFields());
    const stale = Object.keys(NOT_FOR_THE_PLANNER).filter((f) => !fields.has(f));
    expect(stale).toEqual([]);
  });

  it('the chartpack answers habitat, and the planner reads the chartpack', () => {
    // deriveGeospatialStructureFacts() has always written habitat.structuralElements from
    // water_features.geojson and pois.geojson -- named creek mouths, charted points and coves,
    // and the Flooded Timber / Shallow Area / Hazard counts. lake-intel.js rendered it and THIS
    // PLANNER NEVER READ IT, printing the habitat agent's `namedCreekMouths` and `standingTimber`
    // instead. Counted 2026-09-01 over the 343 packs the app offers: 1,352 creek mouths, all of
    // them named.
    expect(/structuralElements/.test(PLANNER_CODE)).toBe(true);
    for (const leaf of ['creekMouths', 'chartedStructurePois']) {
      expect(new RegExp(`\\b${leaf}\\b`).test(PLANNER_CODE)).toBe(true);
    }
    // And the agent's versions must not come back: a survey with a position beats a sentence.
    expect(/namedCreekMouths|standingTimber|timberFields/.test(PLANNER_CODE)).toBe(false);
  });

  it('the two fields that decide where fish can physically be are consumed', () => {
    // Thermocline and anoxic depth are not colour on a stratified reservoir in August. If these
    // ever fall out of the planner, a plan can put the angler on water nothing can live in.
    expect(/summerDepthFt/.test(PLANNER_CODE)).toBe(true);
    expect(/anoxicBelowFt/.test(PLANNER_CODE)).toBe(true);
  });
});
