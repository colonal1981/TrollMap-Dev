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
const NOT_FOR_THE_PLANNER = {
  'identity.county': 'administrative; regulations already handle jurisdiction',
  'identity.damName': 'administrative; the dam is not a fishing decision',
  'identity.reservoirOwner': 'administrative; who owns it changes nothing on the water',
  'identity.riverSystem': 'administrative; the water graph already knows the shape',
  'identity.yearImpounded': 'history, not today',
  'identity.surfaceAreaAcres': 'the pack geometry is authoritative for size',
  'identity.normalPoolFt': 'pool level comes from the live gauge, not the profile',
  'biology.invasiveSpecies': 'regulatory and ecological, does not change where to troll',
  'biology.speciesAbundance': 'prose about the fishery; the catch journal is the local truth',
  'biology.predatorSpecies': 'the species being targeted is chosen in the form',
  'habitat.cover': 'superseded by the pack: docks, timber and attractors arrive as geometry',
  'habitat.dockDensity': 'docks.geojson carries every dock individually',
  'habitat.riprapLocations': 'no riprap layer in the pack yet — see DELETION_TAB custom-vectors',
  'habitat.shallowFlatAreas': 'depth_areas.geojson is finer than a prose description',
  'habitat.artificialHabitat': 'the Details.attractorCount/Types fields carry the usable form',
  'navigation.ramps': 'the access index is authoritative and the ramp is chosen in the form',
  'navigation.notes': 'free prose, no reliable structure',
  'navigation.hazards': 'hazards are handed to the prompt from the pack, not the profile',
  'regulations.generalStateRegulations': 'checked separately and hard-blocks before planning',
  'regulations.lakeSpecificRegulations': 'checked separately and hard-blocks before planning',
  saltwaterRegulations: 'checked separately and hard-blocks before planning, coastal',
  // Coastal / tidal. v2 has only been run on reservoirs; when it plans a coastal day these
  // become real and this list should shrink.
  'estuary.marshAcreage': 'coastal — v2 is reservoir-only so far',
  'estuary.meanTidalRangeFt': 'coastal; the live tide engine owns this, not the profile',
  'estuary.oysterPresence': 'coastal — v2 is reservoir-only so far',
  'estuary.primaryInlets': 'coastal — v2 is reservoir-only so far',
  'estuary.tributaryRivers': 'coastal — v2 is reservoir-only so far',
  'estuary.waterBodyType': 'coastal — v2 is reservoir-only so far',
  'tidal.datum': 'coastal; the live tide engine owns this, not the profile',
  'tidal.flushingTimeDays': 'coastal — v2 is reservoir-only so far',
  'tidal.salinityPpt': 'coastal — v2 is reservoir-only so far',
  'tidal.stratificationType': 'coastal — v2 is reservoir-only so far',
  'tidal.tidalCurrentKts': 'coastal; the live tide engine owns this, not the profile',
  'tidal.turbidity': 'coastal — clarity comes off the form',
  'tidal.waterTempF': 'coastal — water temperature comes off the form',
  
  
  'limnology.waterClarity.color': 'typical + secchi already carry clarity',
  
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
    expect(/researchIntel/.test(codeOnly(read('js/modules/smart-plan-v2-wiring.js')))).toBe(true);
    expect(/intel/.test(codeOnly(read('js/modules/plan-prompt.js')))).toBe(true);
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

  it('the two fields that decide where fish can physically be are consumed', () => {
    // Thermocline and anoxic depth are not colour on a stratified reservoir in August. If these
    // ever fall out of the planner, a plan can put the angler on water nothing can live in.
    expect(/summerDepthFt/.test(PLANNER_CODE)).toBe(true);
    expect(/anoxicBelowFt/.test(PLANNER_CODE)).toBe(true);
  });
});
