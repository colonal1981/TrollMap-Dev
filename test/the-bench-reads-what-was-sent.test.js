import { describe, it, expect } from './expect-shim.mjs';
import { splitPrompt, droppedFromAnswer } from '../js/utils/bench-read.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// Ryan, 2026-09-06: "i want this as something to test the app before a plan is
// a plan... this way i am not firing alerts off on my phone for a plan that i
// will never fish." And earlier, on what it has to show: "the 1st thing shows
// me what the LLM gets... then the second thing is the output... what the LLM
// gives us and what we do with it... do we throw away good data".
//
// Both questions are answered by reading, not by a second implementation. The
// bench runs runSmartPlanV2() and these two functions read the result.
//
// The section titles below are the real ones off the Sep 6 Wateree prompt,
// which splits into ten sections totalling 76,272 characters:
//
//     48  OPENING            1,943  WHERE THE WATER IS TODAY
// 18,907  THE DAY              804  WHAT THE LIGHT IS DOING
// 36,098  THE WATER YOU MAY FISH 283  HOW LONG HE HAS
//  7,802  RULES THAT ARE NOT NEGOTIABLE
//    782  THE THERMOCLINE ON THIS WATER HAS NOT BEEN MEASURED
//  1,646  WHAT IS ALREADY KNOWN
//  1,978  RETURN EXACTLY THIS SHAPE
// ---------------------------------------------------------------------------

const PROMPT = [
  'Plan today on Lake Wateree, SC for Striped Bass.',
  '',
  'THE DAY',
  '{ "water": "Lake Wateree, SC" }',
  '',
  'WHERE THE WATER IS TODAY',
  '222.60 ft · 2.90 ft below full pool',
  '',
  'WHAT THE LIGHT IS DOING',
  'First light runs 06:34 to 07:00 (civil dawn to sunrise).',
  '',
  'HOW LONG HE HAS',
  '06:00 to 15:00 is 540 MINUTES on the water',
].join('\n');

describe('splitPrompt — read the structure the prompt already has', () => {
  it('splits on the shouted headings the blocks already open with', () => {
    const secs = splitPrompt(PROMPT);
    expect(secs.map((s) => s.title)).toEqual(
      ['OPENING', 'THE DAY', 'WHERE THE WATER IS TODAY', 'WHAT THE LIGHT IS DOING',
       'HOW LONG HE HAS']);
  });

  it('keeps every character of the body, because the point is what was SENT', () => {
    const secs = splitPrompt(PROMPT);
    const light = secs.find((s) => s.title === 'WHAT THE LIGHT IS DOING');
    expect(light.body.join('\n')).toMatch(/First light runs 06:34 to 07:00/);
  });

  it('does not mistake a JSON line for a heading', () => {
    // `{ "water": ... }` is inside THE DAY and must not open a section of its own.
    const secs = splitPrompt(PROMPT);
    expect(secs.some((s) => /^[{[]/.test(s.title))).toBe(false);
  });

  it('survives an empty prompt rather than inventing a section', () => {
    expect(splitPrompt('')).toEqual([]);
    expect(splitPrompt(null)).toEqual([]);
  });

  it('shows a block that ran and had nothing to say', () => {
    // The interesting case. A heading with an empty body means the block fired
    // and produced nothing -- which is exactly what "what is missing" looks like.
    const secs = splitPrompt('OPENING LINE HERE\n\nWHAT THE LIGHT IS DOING\n\nHOW LONG HE HAS\n540');
    const light = secs.find((s) => s.title === 'WHAT THE LIGHT IS DOING');
    expect(!!light).toBe(true);
    expect(light.body.join('').trim()).toBe('');
  });
});

describe('droppedFromAnswer — what the model said that the app does not carry', () => {
  const ANSWER = {
    loadout: { why: 'a sentence about the six rods and how they cover the day',
               rods: [{ id: 'R1', lure: 'MR Crankbait (6-12ft)', color: 'Chartreuse Shad' }] },
    legs: [{ runId: 'wateree_lake#129', why: 'the channel edge holds bait through the morning' }],
    notes: { scoutNotes: 'work the main lake points early and slide out as the sun climbs' },
  };

  it('reports nothing when both readings carry the answer', () => {
    const kept = { args: { loadout: ANSWER.loadout }, plan: { legs: ANSWER.legs,
                   notes: ANSWER.notes } };
    expect(droppedFromAnswer(ANSWER, kept)).toEqual([]);
  });

  it('names the path of a value that survived nowhere', () => {
    const kept = { args: { loadout: ANSWER.loadout }, plan: { legs: ANSWER.legs } };
    const d = droppedFromAnswer(ANSWER, kept);
    expect(d.length).toBe(1);
    expect(d[0].path).toBe('notes.scoutNotes');
  });

  // THIS IS THE BUG THE BENCH ALMOST SHIPPED WITH. Comparing the answer against
  // `plan` alone reported all six rods, every colour and every rationale as
  // dropped -- 30 values on the real Sep 6 run -- because assemblePlan() does
  // not carry a loadout. planArgsFrom() does. Both readings, or the number is
  // confidently wrong in the direction this whole bench exists to catch.
  it('does not call the loadout dropped just because the plan has no loadout', () => {
    const planOnly = { plan: { legs: ANSWER.legs, notes: ANSWER.notes } };
    const both = { args: { loadout: ANSWER.loadout }, plan: { legs: ANSWER.legs,
                   notes: ANSWER.notes } };
    expect(droppedFromAnswer(ANSWER, planOnly).length > 0).toBe(true);
    expect(droppedFromAnswer(ANSWER, both)).toEqual([]);
  });

  it('skips values too short to be evidence either way', () => {
    // A rod id appearing somewhere in a large object proves nothing.
    const d = droppedFromAnswer({ id: 'R1', n: 2 }, {});
    expect(d).toEqual([]);
  });
});
