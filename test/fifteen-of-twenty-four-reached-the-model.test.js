import { describe, it, expect } from './expect-shim.mjs';
import { conditionsPromptBlock } from '../js/modules/plan-prompt.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// Ryan, 2026-09-06, pasting the whole conditions card: "how much of this from
// conditions is presented to the LLM... i am having a hard time seeing if
// everything here is presented... it doesn't look like it".
//
// Counted fact by fact against the Sep 6 prompt: FIFTEEN of the card's
// twenty-four reached the model, NINE did not.
//
//   reached   pool level, full pool, flow, stage, flood status, flow vs
//             history, civil twilight, sunrise/sunset, measured wind, pool
//             trend, clarity, the LIP operator notice, drought stage, wind by
//             hour, solunar
//   did not   water temperature, dissolved oxygen, moon, rain chance,
//             barometer, releases, access closures, flow-vs-normal anomaly,
//             the Duke guide curve
//
// conditions-strip.js and plan-prompt.js read the SAME object. Only the card
// printed them. The sharpest one: the prompt asks the model to weigh "what the
// water clarity and temperature argue for" and never gives it a temperature --
// 85.5 °F on that card, from a real gauge, and the same number getSeason() uses
// to call September summer.
// ---------------------------------------------------------------------------

const WATEREE = {
  waterTempF: 85.5, waterTempGauge: 'LAKE WATEREE TAILRACE ABOVE CAMDEN, SC',
  oxygenMgL: 6.1, moonPhase: 'Waning Crescent', moonIllumination: '24%',
  popPct: 40, pressureMb: 1010.1, flowAnomaly: 0.5,
  releases: { all_no_release: true, items: [] },
  accessAlerts: [{ place: 'Buck Hill Access Area',
                   text: 'Buck Hill Access Area will close on March 2, 2026 for approximately one year.' }],
};

describe('conditionsPromptBlock — the nine the card kept to itself', () => {
  it('gives the model the water temperature it is told to reason about', () => {
    expect(conditionsPromptBlock(WATEREE)).toMatch(/Water temperature 85\.5 °F/);
  });

  it('carries where the temperature was measured, because a tailrace is not the lake', () => {
    const b = conditionsPromptBlock(WATEREE);
    expect(b).toMatch(/LAKE WATEREE TAILRACE ABOVE CAMDEN, SC/);
    const borrowed = conditionsPromptBlock({ waterTempF: 71, waterTempFrom: 'upstream',
                                             waterTempGauge: 'French Broad at Newport' });
    expect(borrowed).toMatch(/measured UPSTREAM, not on this water/);
  });

  it('repeats the card own oxygen rule rather than inventing a second threshold', () => {
    expect(conditionsPromptBlock(WATEREE))
      .toMatch(/Dissolved oxygen 6\.1 mg\/L\. Below about 4 mg\/L is not holding fish\./);
  });

  it('carries moon, rain chance and barometer', () => {
    const b = conditionsPromptBlock(WATEREE);
    expect(b).toMatch(/Moon Waning Crescent · 24% lit/);
    expect(b).toMatch(/Chance of rain 40%/);
    expect(b).toMatch(/Barometer 1010\.1 mb — one observation, so there is no trend/);
  });

  it('says only the SIGN of the flow anomaly is usable, as the card does', () => {
    expect(conditionsPromptBlock(WATEREE)).toMatch(/Only the SIGN is usable/);
  });

  it('states that no water is being released, which is the fact behind the LIP notice', () => {
    // The reason -- Stage 2 -- already reached the model through the operator
    // message. The fact it causes did not.
    expect(conditionsPromptBlock(WATEREE))
      .toMatch(/every day on it reads NO RELEASE\. Do not build the day around current\./);
  });

  it('names a closed ramp, because the model plans launches', () => {
    const b = conditionsPromptBlock(WATEREE);
    expect(b).toMatch(/ACCESS NOTICES from the operator \(1\)/);
    expect(b).toMatch(/Buck Hill Access Area will close on March 2, 2026/);
  });

  it('prints a published release schedule when there is one', () => {
    const b = conditionsPromptBlock({ releases: { all_no_release: false,
      items: [{ date: '2026-09-07', text: '1200 cfs 09:00-13:00' }] } });
    expect(b).toMatch(/has published releases: 2026-09-07 1200 cfs/);
  });

  it('is silent line by line rather than inferring anything from an absence', () => {
    expect(conditionsPromptBlock({})).toBe('');
    expect(conditionsPromptBlock(null)).toBe('');
    expect(conditionsPromptBlock({ error: 'timeout', waterTempF: 85.5 })).toBe('');
    const only = conditionsPromptBlock({ oxygenMgL: 6.1 });
    expect(only).toMatch(/Dissolved oxygen/);
    expect(only).not.toMatch(/Water temperature|Moon|Barometer|ACCESS/);
  });
});
