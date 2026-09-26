// NOW IT IS NOT READ AT ALL, ON PURPOSE. 2026-09-25.
//
// This file was written to make the planner read `regulations.lakeSpecificRegulations.closedSeasons`
// and warn with each sentence (profileClosures() in plan-preflight.js). Only the Research tab's
// coastal assembler ever wrote that field -- one stored profile of 133 carries any, Santee River
// Delta, a shellfish-season sentence -- and the tab was deleted. Ryan: "nothing the tab writes
// should be used anymore". So the tests below assert the opposite of what they used to: the
// field is not read, the legality check takes no profile, and the state book and the hand table
// are the two sources left. The history that follows is why it was read in the first place.
//
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

const preflight = await import('../js/modules/plan-preflight.js');
const { checkPlanLegality } = preflight;

const withClosures = (rows) => ({
  regulations: { state: 'SC', lakeSpecificRegulations: { closedSeasons: rows } },
});
const code = (f) => src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the retired field is not read', () => {
  it('profileClosures() is gone', () => {
    expect(preflight.profileClosures).toBeUndefined();
  });

  it('no code in plan-preflight.js names closedSeasons', () => {
    const c = code('js/modules/plan-preflight.js');
    expect(c.includes('closedSeasons')).toBe(false);
    expect(c.includes('lakeSpecificRegulations')).toBe(false);
  });

  it('a profile carrying a closed season changes nothing about the answer', () => {
    const PROFILE = withClosures([
      { species: 'Largemouth Bass', period: 'April 1 – May 15', note: 'closed on the spawning flats' },
    ]);
    const date = new Date('2026-04-10T12:00:00');
    const withIt = checkPlanLegality('Lake Wateree, SC', 'Largemouth Bass', date, { profile: PROFILE });
    const bare = checkPlanLegality('Lake Wateree, SC', 'Largemouth Bass', date);
    expect(withIt).toEqual(bare);
    expect(withIt.warnings.join(' | ').includes('spawning flats')).toBe(false);
  });
});

describe('neither planner hands a profile to the legality check', () => {
  const wiring = src('js/modules/smart-plan-v2-wiring.js');
  const pw = src('js/modules/plan-water-ui.js');

  // One call for both planners since 2026-09-25: preparePlanInputs() in smart-plan-v2-wiring.js.
  const prep = wiring.slice(wiring.indexOf('export async function preparePlanInputs('));

  it('preparePlanInputs() passes the launch and nothing else', () => {
    expect(prep).toMatch(/const legality = checkPlanLegality\([^)]*\{\s*at:\s*ramp\s*\}\)/);
    expect(/checkPlanLegality\([^)]*profile:/.test(code('js/modules/smart-plan-v2-wiring.js'))).toBe(false);
  });

  it('and both planners go through it, Pick Water with no check of its own', () => {
    expect(wiring).toContain('await preparePlanInputs(inp, species, date, ramp)');
    expect(pw).toContain('await preparePlanInputs(inp, species, date, ramp)');
    expect(/checkPlanLegality\(/.test(code('js/modules/plan-water-ui.js'))).toBe(false);
  });

  it('the profile is loaded exactly once, for the depth band and the prompt', () => {
    expect((wiring.match(/await loadResearchedProfile\(/g) || []).length).toBe(1);
    expect(prep).toMatch(/await loadResearchedProfile\(/);
    expect((pw.match(/await loadResearchedProfile\(/g) || []).length).toBe(0);
  });

  it('the warnings are merged BEFORE anything reads r.problems', () => {
    // They were merged below planToTimeline(), which had already snapshotted the list — so the
    // no-plan branch, the bench JSON and the bench draw all got a list with none of the law in
    // it. Computed right, addressed late. Still true of the book's warnings.
    const merge = wiring.indexOf('r.problems = [...legality.warnings');
    expect(merge).toBeGreaterThan(-1);
    const firstRead = Math.min(
      ...['say(r.problems[0]', 'warnings: r.problems || []', 'planIssuesHtml(r.plan, r.problems)']
        .map((s) => wiring.indexOf(s))
        .filter((i) => i > -1));
    expect(merge).toBeLessThan(firstRead);
  });
});
