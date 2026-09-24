// ELEVEN YEARS OF INTERCEPTS, READ BY ONE RESEARCH PROMPT AND NO PLAN.
//
// registry/mrip_inshore.json was built 2026-09-03 out of NOAA's Access Point Angler Intercept
// Survey — AREA_X = 5, inland waters, per state, per two-month wave, with the survey's own length
// measurements. Its only reader was Worker/research/agents.js, so it reached a research prompt and
// never reached a plan. 00_START_HERE's standing test is that A FACT COUNTS WHEN IT REACHES
// buildPlanRequest(), and by that test this file did not count.
//
// It matters now because Ryan fishes inshore only and wants saltwater this fall. A coastal zone
// has no research profile the way a reservoir does, so before this the prompt's entire knowledge
// of a September redfish was its size and creel limit.
//
// THE ONE THING THAT MUST NOT GO WRONG: MRIP does not work wave 1 (Jan–Feb) in SC or GA. The file
// writes those as {sampled: false} and never as {intercepts: 0}, for the obvious reason — a reader
// that flattens the two tells somebody the seatrout are gone in February. Every share and every
// rank here is computed across SAMPLED waves only, and the unsampled wave carries no number at
// all. Four of the tests below are about that single distinction.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');
const FIXTURE = JSON.parse(readFileSync(join(here, 'fixtures/mrip_inshore.sample.json'), 'utf8'));

const {
  primeInshoreSeason, inshoreSeasonFor, inshoreSeasonPrimed, _resetInshoreSeason,
  waveFor, WAVES, REGISTRY_PATH,
} = await import('../js/data/inshore-season.js');

const prime = async (body = FIXTURE, ok = true) => {
  _resetInshoreSeason();
  let asked = null;
  await primeInshoreSeason({
    worker: 'https://w', now: Date.now(),
    fetch: async (u) => { asked = u; return { ok, json: async () => body }; },
  });
  return asked;
};

const SEP = new Date('2026-09-15T12:00:00');   // wave 5
const FEB = new Date('2026-02-15T12:00:00');   // wave 1 — the one MRIP does not work here

describe('the wave is the calendar, not a guess', () => {
  it('maps every month onto the survey’s own pairs', () => {
    const got = [1,2,3,4,5,6,7,8,9,10,11,12]
      .map((m) => waveFor(new Date(2026, m - 1, 15)));
    expect(got).toEqual([1,1,2,2,3,3,4,4,5,5,6,6]);
  });

  it('names them the way the survey does', () => {
    expect(WAVES[1]).toBe('Jan–Feb');
    expect(WAVES[5]).toBe('Sep–Oct');
  });
});

describe('the table is loaded off the same route every registry travels', () => {
  it('asks for _registry/mrip_inshore.json under /chartpacks', async () => {
    const asked = await prime();
    expect(asked).toBe(`https://w${REGISTRY_PATH}`);
    expect(REGISTRY_PATH).toContain('/chartpacks/_registry/');
    expect(inshoreSeasonPrimed()).toBe(true);
  });

  it('a failed fetch is silence, not a throw and not an empty answer', async () => {
    await prime(FIXTURE, false);
    expect(inshoreSeasonPrimed()).toBe(false);
    expect(inshoreSeasonFor('SC', 'Red Drum (Redfish)', SEP)).toBeNull();
  });

  it('a body with no states is refused rather than cached as an answer', async () => {
    await prime({ note: 'nothing here' });
    expect(inshoreSeasonPrimed()).toBe(false);
  });

  it('a cold table says nothing at all', () => {
    _resetInshoreSeason();
    expect(inshoreSeasonFor('SC', 'Red Drum (Redfish)', SEP)).toBeNull();
  });
});

describe('the join is nameForms, because neither string contains the other', () => {
  it('SPOTTED SEATROUT answers to “Speckled Trout (Spotted Seatrout)”', async () => {
    await prime();
    const r = inshoreSeasonFor('SC', 'Speckled Trout (Spotted Seatrout)', SEP);
    expect(r).toBeTruthy();
    expect(r.surveyName).toBe('SPOTTED SEATROUT');
  });

  it('RED DRUM answers to “Red Drum (Redfish)”', async () => {
    await prime();
    expect(inshoreSeasonFor('SC', 'Red Drum (Redfish)', SEP).surveyName).toBe('RED DRUM');
  });

  it('a fish the state table does not carry is silence, not a zero', async () => {
    // The file's own rule is "intercepted inland AND the book gives it a limit", so an absence is
    // one of two different sentences and we cannot tell which. Silence over a wrong sentence.
    await prime();
    expect(inshoreSeasonFor('SC', 'Largemouth Bass', SEP)).toBeNull();
  });

  it('a state with no coastal roster is silence — every inland water lands here', async () => {
    await prime();
    expect(inshoreSeasonFor('TN', 'Red Drum (Redfish)', SEP)).toBeNull();
  });
});

describe('NOT SAMPLED IS NOT ZERO', () => {
  it('February in SC reports sampled:false and carries NO count', async () => {
    await prime();
    const r = inshoreSeasonFor('SC', 'Speckled Trout (Spotted Seatrout)', FEB);
    expect(r.sampled).toBe(false);
    expect(r.waveIntercepts).toBeNull();
    expect(r.sharePct).toBeNull();
    expect(r.rank).toBeNull();
  });

  it('the unsampled wave is NAMED so the prompt can say which months', async () => {
    await prime();
    expect(inshoreSeasonFor('SC', 'Red Drum (Redfish)', SEP).unsampledWaves).toEqual(['Jan–Feb']);
  });

  it('the total is the SAMPLED waves only — an absent wave adds nothing', async () => {
    await prime();
    const r = inshoreSeasonFor('SC', 'Speckled Trout (Spotted Seatrout)', SEP);
    const sc = FIXTURE.states.SC.species['SPOTTED SEATROUT'].byWave;
    const hand = ['2','3','4','5','6'].reduce((s, w) => s + sc[w].intercepts, 0);
    expect(r.totalIntercepts).toBe(hand);
    expect(r.sampledWaveCount).toBe(5);
  });

  it('...and counting the empty wave as a zero would have changed the share', async () => {
    // The guard that makes the test above worth having: if wave 1 were folded in as 0 it would
    // still not change the TOTAL. It would change the RANK and the wave COUNT, which is how a
    // "1 of 6" reads as a busier month than it is.
    await prime();
    const r = inshoreSeasonFor('SC', 'Speckled Trout (Spotted Seatrout)', SEP);
    expect(r.sampledWaveCount).toBe(5);
    expect(r.sampledWaveCount).not.toBe(6);
  });
});

describe('what it says about a September redfish in South Carolina', () => {
  it('Sep–Oct is the busiest wave of its year', async () => {
    await prime();
    const r = inshoreSeasonFor('SC', 'Red Drum (Redfish)', SEP);
    expect(r.wave).toBe(5);
    expect(r.waveLabel).toBe('Sep–Oct');
    expect(r.rank).toBe(1);
    expect(r.sharePct).toBeGreaterThan(20);
  });

  it('and it carries the survey’s own measured lengths', async () => {
    await prime();
    const r = inshoreSeasonFor('SC', 'Red Drum (Redfish)', SEP);
    expect(r.lengthIn.medianIn).toBe(17);
    expect(r.lengthIn.minIn).toBe(10);
    expect(r.lengthIn.n).toBeGreaterThan(1000);
  });

  it('seatrout peaks LATER than red drum, and the block has to be able to say so', async () => {
    await prime();
    const trout = inshoreSeasonFor('SC', 'Speckled Trout (Spotted Seatrout)', SEP);
    expect(trout.rank).toBe(2);
    expect(trout.best.label).toBe('Nov–Dec');
  });
});

describe('it reaches buildPlanRequest, which is the only test that counts', () => {
  const prompt = src('js/modules/plan-prompt.js');
  const wiring = src('js/modules/smart-plan-v2-wiring.js');
  const engine = src('js/modules/smart-plan-v2.js');

  it('the block is rendered into the prompt body', () => {
    expect(prompt).toContain('${inshoreSeasonBlock(o.inshoreSeason)}');
  });

  it('the engine passes the input through to the request', () => {
    expect(engine).toMatch(/inshoreSeason:\s*o\.inshoreSeason/);
  });

  it('the wiring resolves it and hands it over', () => {
    expect(wiring).toMatch(/inshoreSeason:\s*inshoreSeasonFor\(/);
  });

  it('AND THE TABLE IS PRIMED BEFORE THE PROMPT IS BUILT', () => {
    // inshoreSeasonFor() is synchronous and answers out of a cache. This is the third time on
    // this path that a synchronous reader has stood ahead of the only call that fills it —
    // ensureRegulations() and loadResearchedProfile() were the first two — so it is asserted
    // rather than remembered.
    const warm = wiring.indexOf('await primeInshoreSeason(');
    const read = wiring.indexOf('inshoreSeason: inshoreSeasonFor(');
    expect(warm).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(warm);
  });

  it('ONE derivation of the state, shared with the legality check', () => {
    // Two readers of "which state is this water in" is how they drift, and this path already had
    // one: regulationStateFor().
    // With the launch since 2026-09-24, as the legality check has it -- a water in two states
    // answers by which bank he puts in from, and both readers must ask the same question.
    expect(wiring).toContain('inshoreSeasonFor(regulationStateFor(inp.lakeName, ramp)');
  });
});

describe('the prompt block says what the number is and what it is not', () => {
  // RUN, DO NOT READ. This described the SOURCE of plan-prompt.js and matched sentences that
  // happen to sit on one line; its sibling suite went red on two identical assertions purely
  // because the words fell either side of a string concatenation. The rendered block is what the
  // model is handed.
  let render;
  const out = async (st, sp, d) => {
    if (!render) ({ inshoreSeasonBlock: render } = await import('../js/modules/plan-prompt.js'));
    await prime();
    return render(inshoreSeasonFor(st, sp, new Date(`${d}T12:00:00`)));
  };

  it('calls it STATEWIDE, not a fact about the creek', async () => {
    expect(await out('SC', 'Red Drum (Redfish)', '2026-09-15')).toContain('STATEWIDE, not this creek');
  });

  it('says an intercept is an angler trip, not a fish', async () => {
    // The count rises with how many people fished. Read as abundance it is a different claim.
    const t = await out('SC', 'Red Drum (Redfish)', '2026-09-15');
    expect(t).toContain('ANGLER TRIP');
    expect(t).toContain('never as abundance');
  });

  it('says an unsampled wave is a hole in the survey, in those words', async () => {
    const t = await out('SC', 'Speckled Trout (Spotted Seatrout)', '2026-02-15');
    expect(t).toContain('HOLE IN THE SURVEY, NOT AN ABSENCE OF FISH');
    // ...and carries no count for that wave at all.
    expect(t).not.toMatch(/intercepts in Jan–Feb/);
  });

  it('does not say the same hole twice', async () => {
    // The unsampled-wave paragraph and the trailing "the survey does not work X" line were both
    // firing on a February plan, which reads as two different holes in the survey.
    const t = await out('SC', 'Speckled Trout (Spotted Seatrout)', '2026-02-15');
    expect((t.match(/does not work/gi) || []).length).toBe(1);
    // ...while a September plan still gets the trailing line, because there the hole is elsewhere.
    expect(await out('SC', 'Red Drum (Redfish)', '2026-09-15'))
      .toContain('does not work Jan–Feb in SC at all');
  });

  it('puts the median against the slot rather than leaving it to be read as a target', async () => {
    expect(await out('SC', 'Red Drum (Redfish)', '2026-09-15'))
      .toContain('median under the slot means most of what is landed goes back');
  });

  it('nothing to say is silence, not an empty heading', async () => {
    if (!render) ({ inshoreSeasonBlock: render } = await import('../js/modules/plan-prompt.js'));
    expect(render(null)).toBe('');
  });
});
