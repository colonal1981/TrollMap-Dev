// THE RESEARCH PIPELINE EXTRACTED A CLOSED SEASON AND THE PLANNER NEVER ASKED FOR IT.
//
// `regulations.lakeSpecificRegulations.closedSeasons` is filled by the coastal fact assembler in
// lake-research-engine.js from extracted documents, and by the LLM regulation schema in
// Worker/research/facts-util.js. Before this it had exactly two readers, both of them the
// research TAB — lake-research-ui.js renders it under a red "Closed Seasons" heading, and
// Worker/research/agents.js counts it for completeness scoring.
//
// `checkPlanLegality()` is the one call on the plan path whose whole job is, in Ryan's words,
// "reg check is needed so we don't plan on closed waters". It consulted the offline book parse
// and the hand-typed coastal table and it did not consult this. A closure that only reaches a tab
// nobody is looking at on the morning of a launch is a closure the app did not tell him about.
//
// THREE CLAIMS AND THEY FAIL SEPARATELY:
//   1. the sentences come out of the profile, in every shape the three writers emit
//   2. they WARN and never block — see profileClosures() for why a guessed date is worse
//   3. the wiring hands the profile over, and does it before the check rather than after
//
// The third is the one that has bitten this file's neighbours repeatedly: a synchronous check
// standing ahead of the only await that fills what it reads. ensureRegulations() was written for
// exactly that bug and the profile load was sitting seventy lines below the check.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');

globalThis.window = globalThis;

const { profileClosures, checkPlanLegality } = await import('../js/modules/plan-preflight.js');

const withClosures = (rows) => ({
  regulations: { state: 'SC', lakeSpecificRegulations: { closedSeasons: rows } },
});

describe('the sentences come out of the profile', () => {
  it('reads the {species, period, note} shape the LLM schema emits', () => {
    const out = profileClosures(withClosures([
      { species: 'Striped Bass / Hybrid', period: 'June 1 – Sept 30', note: 'no harvest below the dam' },
    ]), 'Striped Bass / Hybrid');
    expect(out.length).toBe(1);
    expect(out[0].text).toContain('June 1 – Sept 30');
    expect(out[0].text).toContain('no harvest below the dam');
  });

  it('reads the {note, source} shape the coastal fact assembler writes', () => {
    // lake-research-engine.js pushes `{ note: f.fact, source: f.source || null }` — no species
    // and no period at all. Requiring either would drop every coastal closure on the floor.
    const out = profileClosures(withClosures([
      { note: 'Harvest of southern flounder is closed Jan 1 through Aug 31.', source: 'SCDNR' },
    ]), 'Southern Flounder');
    expect(out.length).toBe(1);
    expect(out[0].text).toContain('southern flounder is closed');
    expect(out[0].source).toBe('SCDNR');
  });

  it('reads a bare string, because the research tab already handles one', () => {
    const out = profileClosures(withClosures(['Closed to all fishing during the spawn.']), 'Crappie');
    expect(out.length).toBe(1);
    expect(out[0].text).toBe('Closed to all fishing during the spawn.');
  });

  it('a row naming ANOTHER fish is not this trip’s problem', () => {
    const out = profileClosures(withClosures([
      { species: 'Walleye / Sauger', period: 'March', note: 'closed' },
    ]), 'Largemouth Bass');
    expect(out.length).toBe(0);
  });

  it('...and a row naming NO fish governs the water, so it is kept', () => {
    const out = profileClosures(withClosures([
      { period: 'March 1 – April 15', note: 'the whole impoundment is closed' },
    ]), 'Largemouth Bass');
    expect(out.length).toBe(1);
  });

  it('a parenthetical is a second name, not a mismatch', () => {
    // `Red Drum (Redfish)` on the plan and `Redfish` in the document are one fish, and neither
    // string contains the other. This is the failure regulations-live.js documents by name.
    const out = profileClosures(withClosures([
      { species: 'Redfish', period: 'November', note: 'closed to harvest' },
    ]), 'Red Drum (Redfish)');
    expect(out.length).toBe(1);
  });

  it('no profile, no regulations block and no rows are all simply nothing', () => {
    expect(profileClosures(null, 'Crappie')).toEqual([]);
    expect(profileClosures({}, 'Crappie')).toEqual([]);
    expect(profileClosures(withClosures([]), 'Crappie')).toEqual([]);
  });
});

describe('they warn and they never block', () => {
  const PROFILE = withClosures([
    { species: 'Largemouth Bass', period: 'April 1 – May 15', note: 'closed on the spawning flats' },
  ]);

  it('the sentence reaches the plan’s warnings', () => {
    const r = checkPlanLegality('Lake Wateree, SC', 'Largemouth Bass',
      new Date('2026-04-10T12:00:00'), { profile: PROFILE });
    const joined = r.warnings.join(' | ');
    expect(joined).toContain('April 1 – May 15');
    expect(joined).toContain('closed on the spawning flats');
  });

  it('and it says which book it is NOT, because that is what he has to go check', () => {
    const r = checkPlanLegality('Lake Wateree, SC', 'Largemouth Bass',
      new Date('2026-04-10T12:00:00'), { profile: PROFILE });
    expect(r.warnings.join(' | ')).toContain('researched profile');
  });

  it('a free-text period CANNOT cancel the morning', () => {
    // Inventing a start and an end out of "April 1 – May 15" is how a planner refuses a trip on
    // a rule it guessed at. The sentence is carried; the gate is not.
    const r = checkPlanLegality('Lake Wateree, SC', 'Largemouth Bass',
      new Date('2026-04-10T12:00:00'), { profile: PROFILE });
    expect(r.legal).toBe(true);
  });

  it('the closure is said FIRST, ahead of the limits', () => {
    const r = checkPlanLegality('Lake Wateree, SC', 'Largemouth Bass',
      new Date('2026-04-10T12:00:00'), { profile: PROFILE });
    expect(r.warnings[0]).toContain('Closed season on this water');
  });

  it('calling without a profile is unchanged — it costs the sentences, never permission', () => {
    const bare = checkPlanLegality('Lake Wateree, SC', 'Largemouth Bass', new Date('2026-04-10T12:00:00'));
    expect(bare.legal).toBe(true);
    expect(bare.warnings.some((w) => /Closed season on this water/.test(w))).toBe(false);
  });
});

describe('the wiring actually hands it over', () => {
  const wiring = src('js/modules/smart-plan-v2-wiring.js');

  it('checkPlanLegality is given the profile', () => {
    expect(wiring).toMatch(/checkPlanLegality\([^)]*\{\s*profile:\s*researched\s*\}/);
  });

  it('AND THE PROFILE IS LOADED FIRST — the check cannot await for it', () => {
    // The bug this file exists to prevent from coming back. `loadResearchedProfile` sat seventy
    // lines BELOW the legality call, so passing it there would have passed `undefined` forever
    // and every assertion above would still be green.
    //
    // ANCHORED ON THE CALL, NOT THE NAME. `checkPlanLegality()` is named in a comment twenty
    // lines above the call it describes, and indexOf('checkPlanLegality(') finds the comment --
    // which is how four source-reading guards in this suite spent a session asserting against
    // their own prose. The assignment is the thing that runs.
    const load = wiring.indexOf('const researched = await loadResearchedProfile(');
    const check = wiring.indexOf('const legality = checkPlanLegality(');
    expect(load).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(-1);
    expect(load).toBeLessThan(check);
  });

  it('ONE load, not a second fetch for the law', () => {
    const loads = wiring.match(/await loadResearchedProfile\(/g) || [];
    expect(loads.length).toBe(1);
  });

  it('the warnings are merged BEFORE anything reads r.problems', () => {
    // They were merged below planToTimeline(), which had already snapshotted the list — so the
    // no-plan branch, the bench JSON and the bench draw all got a list with none of the law in
    // it. Same defect as the closure above, one layer out: computed right, addressed late.
    const merge = wiring.indexOf('r.problems = [...legality.warnings');
    expect(merge).toBeGreaterThan(-1);
    const firstRead = Math.min(
      ...['say(r.problems[0]', 'warnings: r.problems || []', 'planIssuesHtml(r.plan, r.problems)']
        .map((s) => wiring.indexOf(s))
        .filter((i) => i > -1));
    expect(merge).toBeLessThan(firstRead);
  });
});
