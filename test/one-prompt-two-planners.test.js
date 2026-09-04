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
import { snapEligibleFrom, TERMINAL_CONNECTION } from '../js/data/lure-knowledge.js';
import { chartedHazards, NO_GO_POI_TYPES, AVOID_POI_TYPES } from '../js/modules/plan-candidates.js';
import { buildPlanRequest, planArgsFrom } from '../js/modules/plan-prompt.js';

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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AND ONE ASSEMBLER, WITH THE SAME PROBLEM ONE LAYER DOWN
//
// Ryan, 2026-09-04: "so you are saying that smartplan can hand me a trolling lane and a lure and
// not know whether that lure will be lost trolling that lane?" It could. `assemblePlan` reads
// twenty fields off its argument and nothing held ITS two callers to a list either, so the same
// failure happened again in the same shape and in both directions at once:
//
//   lureByName   Pick Water yes, Smart Plan no  -> capBaitDepth() returned null on its first
//                                                  line, so no Smart Plan day EVER checked a
//                                                  bait against the shoal on its own leg
//   safety       Smart Plan yes, Pick Water no  -> the model's NO-GO was parsed and dropped
//   water/slug/  Smart Plan yes, Pick Water no  -> every Pick Water plan carried
//   ramp/date/                                     meta:{water:null,...} and conditions:{}
//   species/conditions
//
// Same test, same reason, one layer down. `trollMph` and `transitMph` are defaults with their own
// constants and are genuinely nobody's to send.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('the assembler contract', () => {
  const assemble = src('js/modules/plan-assemble.js');
  const BODY = (() => {
    const t = live(assemble);
    return t.slice(t.indexOf('export function assemblePlan(o) {'), t.indexOf('export function planRoute'));
  })();
  const ASSEMBLE_CONTRACT = [...new Set(BODY.match(/\bo\.[A-Za-z_][A-Za-z0-9_]*/g) || [])]
    .map((x) => x.slice(2)).sort();

  // Defaults, not inputs: `trollMph` falls back to 2.0 and `transitMph` to 3.5 from this file's
  // own constants, and neither planner has an opinion to send.
  const ASSEMBLER_DEFAULTS = ['trollMph', 'transitMph'];

  // WHAT A SPREAD ALREADY CARRIES. Smart Plan writes `assemblePlan({ ...args, ... })`, so
  // `deploy`, `changes`, `stops`, `loadout`, `candidates` and `safety` arrive without their names
  // ever appearing in that file. Asked of planArgsFrom() at run time rather than written down,
  // because a list typed here is the next thing to go stale -- which is the whole point of this
  // file. A planner satisfies one of these by spreading `args`; anything else it must name.
  const SPREAD_KEYS = Object.keys(planArgsFrom({}, [], { tackle: [] }));
  const spreads = (text) => /assemblePlan\(\{\s*(?:\/\/[^\n]*\n\s*)*\.\.\.args\b/.test(text);

  it('is read off plan-assemble.js and holds the fields the bug was about', () => {
    expect(ASSEMBLE_CONTRACT.length > 10).toBe(true);
    for (const f of ['lureByName', 'safety', 'conditions', 'water', 'slug', 'species']) {
      expect(ASSEMBLE_CONTRACT.includes(f)).toBe(true);
    }
  });

  for (const [who, files] of Object.entries(CALLERS)) {
    it(`${who} mentions every field the assembler reads`, () => {
      const text = files.map((f) => live(src(f))).join('\n');
      const bySpread = spreads(text) ? SPREAD_KEYS : [];
      const missing = ASSEMBLE_CONTRACT
        .filter((f) => !ASSEMBLER_DEFAULTS.includes(f))
        .filter((f) => !bySpread.includes(f))
        .filter((f) => !new RegExp(`\\b${f}\\b`).test(text));
      expect(missing).toEqual([]);
    });
  }

  // THE ONES THAT WERE ACTUALLY BROKEN, ASSERTED ON THE CALL AND NOT ON THE FILE.
  //
  // The mention test above is deliberately the weak claim -- it catches a field that is absent
  // from a planner entirely, which is the bug that happened three times to the prompt. It cannot
  // catch these: `lureByName` was already in smart-plan-v2.js once (for the prompt) while the
  // assembler got none, and `safety` reads back off `r.plan.safety` in plan-water-ui.js on a path
  // that never put one there. So these read the assemblePlan CALL itself.
  const callIn = (f) => {
    const t = live(src(f));
    return t.slice(t.indexOf('assemblePlan({'));
  };

  it('both hand the assembler the lure resolver, not just the prompt', () => {
    for (const f of ['js/modules/smart-plan-v2.js', 'js/modules/plan-from-water.js']) {
      expect(/lureByName: o\.lureByName/.test(callIn(f))).toBe(true);
    }
  });

  it('both hand it the model\'s safety verdict, so a NO-GO can reach the screen either way', () => {
    expect(/safety: args\.safety/.test(callIn('js/modules/plan-from-water.js'))).toBe(true);
    // Smart Plan supplies it through the spread; that is what SPREAD_KEYS is for.
    expect(spreads(live(src('js/modules/smart-plan-v2.js')))).toBe(true);
    expect(SPREAD_KEYS.includes('safety')).toBe(true);
  });

  it('both name the water the plan is of, so meta is not five nulls', () => {
    const call = callIn('js/modules/plan-from-water.js');
    for (const f of ['slug', 'water', 'ramp', 'date', 'species', 'conditions']) {
      expect(new RegExp(`\\b${f}:`).test(call)).toBe(true);
    }
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

  // researchHazards() WAS TESTED HERE AND IS GONE -- 2026-09-01, with the navigation agent that
  // wrote the field it read. Ryan: "cut hazards from the agent... weather handles weather... and
  // some random bridge closure i am sure i will find on my own another way."
  //
  // What these six tests pinned was a reader for prose that no longer exists. The SAFETY SECTION
  // itself still matters and is still tested below -- buildPlanRequest() takes `hazards` from
  // whoever calls it, and both planners now fill that from chartedHazards() off the pack's POI
  // layer: typed, positioned, and off Garmin's survey rather than out of a model.

  it('reaches the safety section, and is kept apart from the charted kind', () => {
    const req = buildPlanRequest({ water: 'Lake Wateree, SC', species: ['Striped Bass'],
                                   tackle: [], candidates: [],
                                   hazards: WATEREE.navigation.hazards });
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

// THE CHART SAYS WHERE YOU MAY NOT GO. IT DOES NOT SAY WHAT IS DANGEROUS TO A KAYAK.
//
// The prompt's hazard sentence said "marked hazard zones on this water" and no chartpack has a
// hazards layer, so nothing ever filled it -- while pois.geojson carried the answer all along.
// The first cut of this function picked the types that SOUND dangerous and got three of five
// wrong, because EVERY_POI_TYPE_ON_THE_CARD_2026-08-27.md had already counted all 39 poi_type
// values across the 281 indexed packs and Ryan had already sorted them. In a kayak, half of what
// a chart marks as a danger is where you are trying to go.
//
//   pile              "target" -- bridge pilings, confirmed at 3 m against his own photo
//   submerged_bridge  "not a hazard it is a target"
//   obstruction       median 49 m from the SCDNR attractor coordinates on Wateree, 59% within
//                     150 m -- brush piles, charted as obstructions because they take a prop off
//   slow_no_wake      "a no wake buoy is not a hazard to a kayak fisherman"
//   shallow_area      "avoid if in a deep area when trolling - target possibly when casting"
//
// So this file is that document, as an assertion.
describe('what the chart says you may not enter, and what it says to avoid', () => {
  // poi_type and name values counted off the real wateree_lake pack, 2026-08-30.
  const pt = (poi_type, name, n = 1) =>
    Array.from({ length: n }, () => ({ properties: { poi_type, name } }));
  const POIS = { features: [
    ...pt('restricted_area', 'No Boats, Spar/Spindle Buoy', 13),
    ...pt('dam', 'DAM'),
    ...pt('hazard_area', 'Hazard Area', 12),
    ...pt('hazard_area', 'Dutchmans creek'),
    ...pt('danger_buoy', 'Hazard, Spar/Spindle Buoy', 33),
    ...pt('caution_buoy', 'Water Intake Keep Clear, Spar/Spindle Buoy'),
    // Everything below is a TARGET or a non-hazard and must not appear.
    ...pt('obstruction', '', 32),
    ...pt('pile', '', 12),
    ...pt('shallow_area', 'Shallow Area', 61),
    ...pt('slow_no_wake', 'No Wake, Spar/Spindle Buoy', 34),
    ...pt('height_marker', 'Vertical Clearance', 38),
    ...pt('submerged_bridge', 'Submerged Bridge', 4),
  ] };

  const [noGo, avoid] = chartedHazards(POIS);

  it('separates the hard constraint from the warning, because they are different facts', () => {
    expect(noGo.startsWith('CANNOT ENTER')).toBe(true);
    expect(avoid.startsWith('AVOID')).toBe(true);
    expect(chartedHazards(POIS).length).toBe(2);
  });

  it('puts restricted areas and dams in the one you may not enter', () => {
    expect(noGo.includes('13× No Boats')).toBe(true);
    expect(noGo.includes('1× DAM')).toBe(true);
    expect(Object.keys(NO_GO_POI_TYPES).sort()).toEqual(['dam', 'restricted_area']);
  });

  it('puts hazard areas and warning buoys in the one to keep clear of', () => {
    expect(avoid.includes('33× Hazard, Spar/Spindle Buoy')).toBe(true);
    expect(avoid.includes('12× Hazard Area')).toBe(true);
    expect(Object.keys(AVOID_POI_TYPES).sort()).toEqual(['caution_buoy', 'danger_buoy', 'hazard_area']);
  });

  it('never calls a kayak target a hazard', () => {
    const both = `${noGo}\n${avoid}`.toLowerCase();
    for (const t of ['obstruction', 'pile', 'shallow', 'no wake', 'clearance', 'submerged bridge']) {
      expect(both.includes(t)).toBe(false);
    }
    for (const t of ['obstruction', 'pile', 'shallow_area', 'slow_no_wake', 'height_marker',
                     'submerged_bridge', 'creek_bed', 'road_bed', 'flooded_timber']) {
      expect(t in NO_GO_POI_TYPES).toBe(false);
      expect(t in AVOID_POI_TYPES).toBe(false);
    }
  });

  it('quotes what the chart says rather than counting anonymous points', () => {
    // The names ARE the meaning. A count of "13 restricted areas" loses "No Boats".
    expect(noGo).toMatch(/Garmin's survey/);
    expect(avoid.includes('Water Intake Keep Clear')).toBe(true);
  });

  it('drops the source disclaimer that is 93% of every caution_buoy on the card', () => {
    const disclaimed = { features: pt('caution_buoy',
      'The location of all buoys within this cell were accurate at the time of source date. '
      + 'Buoys should always be used with caution as they may be moved or damaged.', 40) };
    expect(chartedHazards(disclaimed)).toEqual([]);
  });

  it('says nothing on a pack with neither kind, and on no pack at all', () => {
    expect(chartedHazards({ features: pt('marina', 'Clearwater Marina') })).toEqual([]);
    expect(chartedHazards(null)).toEqual([]);
    expect(chartedHazards({})).toEqual([]);
  });

  it('is read from the pack both planners already hold, not a new request', () => {
    for (const f of ['js/modules/smart-plan-v2.js', 'js/modules/plan-water-ui.js']) {
      const t = live(src(f));
      // Was `[...chartedHazards(`, a spread over a second source that no longer exists: the
      // research agent's prose went with the navigation agent on 2026-09-01. What this test is
      // for is that hazards come off the pack both planners already fetched, not a new request.
      expect(t).toMatch(/hazards:\s*chartedHazards\(/);
      // one pois.geojson fetch per planner, the one that was already there
      expect((t.match(/pois\.geojson/g) || []).length).toBe(1);
    }
  });
});

// A FLUKE IS NOT A TROLLING BAIT AND THE PROMPT NEVER SAID SO.
//
// Both planners build the lure list as `TACKLE_INVENTORY.filter(l => l.trollable || l.castable)`
// and hand the model one flat list of NAMES. The prompt split that list by snap-versus-tie-direct
// and by nothing else, so `Fluke / Soft Jerkbait` -- trollable:false, type cast_only -- arrived
// looking exactly like a crankbait. `trollable` was read in precisely two places in the whole plan
// path, and both of them only used it to build that union.
describe('which of the bag may go behind the boat', () => {
  const BAG = ['DD2 Crankbait (16-20ft)', 'Fluke / Soft Jerkbait', 'Stick Bait (Senko)'];

  it('names the cast-only ones and says why no lead saves them', () => {
    const req = buildPlanRequest({ water: 'Lake Wateree, SC', species: ['Striped Bass'],
                                   candidates: [], tackle: BAG,
                                   trollable: ['DD2 Crankbait (16-20ft)'] });
    const txt = JSON.stringify(req);
    expect(txt.includes('CAST ONLY — NEVER BEHIND THE BOAT')).toBe(true);
    expect(txt.includes('Fluke / Soft Jerkbait, Stick Bait (Senko)')).toBe(true);
    expect(txt.includes('plane instead of sinking')).toBe(true);
    expect(txt.includes('a rod\\nfishing nothing') || txt.includes('fishing nothing')).toBe(true);
  });

  it('says nothing when every lure in the bag may be trolled', () => {
    const req = buildPlanRequest({ water: 'x', species: [], candidates: [], tackle: BAG,
                                   trollable: BAG });
    expect(JSON.stringify(req).includes('CAST ONLY')).toBe(false);
  });

  it('omitting it keeps the old behaviour rather than calling the whole bag cast-only', () => {
    const req = buildPlanRequest({ water: 'x', species: [], candidates: [], tackle: BAG });
    expect(JSON.stringify(req).includes('CAST ONLY')).toBe(false);
  });

  it('both planners derive it from the inventory flag, not from a list', () => {
    for (const f of ['js/modules/smart-plan-v2.js', 'js/modules/plan-water-ui.js']) {
      expect(live(src(f))).toMatch(/\.filter\(\(l\) => l(?: &&)? \.?l?\.?trollable\)|filter\(\(l\) => l && l\.trollable\)|filter\(\(l\) => l\.trollable\)/);
    }
    expect(live(src('js/modules/smart-plan-v2.js'))).toMatch(/tackle: o\.tackle, snapEligible, trollable/);
    expect(live(src('js/modules/plan-water-ui.js'))).toMatch(/trollable: castable\.filter/);
  });
});

describe('Pick Water carries the research it already loaded', () => {
  const ui = live(src('js/modules/plan-water-ui.js'));

  it('derives the intel where the profile, the species and the date all exist', () => {
    // `getSeason(date, inp.waterTempF)` since 2026-08-31: the season decides which research
    // entry is read, and it was decided by the month alone -- so a plan dated September 1st
    // read the fall profile with 85 degree water in the lake.
    //
    // AND THE PACK'S OWN FACTS ALONGSIDE THE PROFILE'S, since 2026-09-04. A derivation stored in
    // a research profile is a photograph of a chart Garmin has since replaced, so anything the
    // pack can answer is answered from the pack that this plan is being built on -- see
    // packDerivedFacts() in js/utils/pack-facts.js. Both tabs pass one; the assertion is that
    // this one does, with the layers it already fetched.
    //
    // A CLOSURE SINCE 2026-09-04, and for the reason the Smart Plan tab has always had one: the
    // operator's seasonal drawdown comes off the conditions call, which runs in buildFromPicked()
    // after the water has been ticked. Everything else -- profile, species, season, pack -- is
    // known in findWater(). A string built there cannot carry the drawdown, and re-fetching the
    // conditions to make one would be a second call for a fact the other half already holds.
    expect(ui).toMatch(/intelFor:\s*\(extra\) => researchIntel\(researched,\s*species,\s*getSeason\(date, inp\.waterTempF\),/);
    expect(ui).toMatch(/packDerivedFacts\(\{\s*lakeName: inp\.lakeName/);
    // And the prompt calls it where the water state exists.
    expect(ui).toMatch(/intel:\s*T\.intelFor\s*\?\s*T\.intelFor\(/);
    expect(ui).toMatch(/seasonalDrawdownFt: waterState\.pool\.seasonalDrawdownFt/);
    // The charted half only, since 2026-09-01.
    expect(ui).toMatch(/hazards:\s*chartedHazards\(poFc\)/);
  });

  it('and hands them to the prompt from the tab state, across the two functions', () => {
    expect(ui).toMatch(/hazards:\s*T\.hazards/);
    expect(ui).toMatch(/snapEligible:\s*snapEligibleFrom\(castable\)/);
  });
});
