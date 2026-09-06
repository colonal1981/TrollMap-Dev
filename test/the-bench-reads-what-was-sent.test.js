import { describe, it, expect } from './expect-shim.mjs';
import { splitPrompt, droppedFromAnswer, candidatesFromPrompt } from '../js/utils/bench-read.js';

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

// ---------------------------------------------------------------------------
// Ryan, 2026-09-06, reading the bench's header against its own last pane:
//
//   "it says that the input is 70,599 characters in 10 sections but the last
//    section is The water it may fish (candidates, as sent) 212,397 ch....
//    so does the LLM get that list of 212,397 ch or not"
//
// It does not, and the pane was wrong twice over. It serialised `r.candidates`
// -- the RAW internal candidate objects, a different shape entirely -- with a
// two-space indent, and called the result "as sent". Measured on that run:
//
//     whole prompt                70,534 ch
//     candidate array as sent     34,333 ch   (49% of the prompt)
//     the same array pretty       51,278 ch
//     the pane's number          212,397 ch   (the wrong object, indented)
//
// buildPlanRequest returns only {system, user}, so the prompt string is the
// only place the sent form exists. Reading it back out of there cannot drift
// from what was sent, because it IS what was sent.
// ---------------------------------------------------------------------------

const WITH_CANDS = 'THE WATER YOU MAY FISH\nEach candidate is a stretch.\n'
  + '[{"runId":"w#1","depthFt":20,"structures":[{"type":"point","atM":722}]},'
  + '{"runId":"w#2","depthFt":31,"structures":[]}]\n\nRULES THAT ARE NOT NEGOTIABLE\n1. Something.';

describe('candidatesFromPrompt — the array exactly as the model received it', () => {
  it('finds the array and counts the legs', () => {
    const c = candidatesFromPrompt(WITH_CANDS);
    expect(c.count).toBe(2);
    expect(c.parsed[0].runId).toBe('w#1');
  });

  it('reports the size AS SENT, not the size of a re-serialisation', () => {
    const c = candidatesFromPrompt(WITH_CANDS);
    // the exact substring of the prompt, so it is a slice of the prompt's own length
    expect(WITH_CANDS.includes(c.text)).toBe(true);
    expect(c.chars).toBe(c.text.length);
    expect(c.chars < JSON.stringify(c.parsed, null, 2).length).toBe(true);
  });

  it('stops at the array, not at the first bracket it meets afterwards', () => {
    const c = candidatesFromPrompt(WITH_CANDS);
    expect(c.text.endsWith(']')).toBe(true);
    expect(c.text).not.toMatch(/RULES THAT ARE NOT NEGOTIABLE/);
  });

  it('handles a nested array inside a candidate without ending early', () => {
    const c = candidatesFromPrompt(WITH_CANDS);
    expect(c.parsed[0].structures.length).toBe(1);
  });

  it('is null rather than wrong when there is no candidate array', () => {
    expect(candidatesFromPrompt('THE DAY\n{"water":"x"}')).toBe(null);
    expect(candidatesFromPrompt('')).toBe(null);
    expect(candidatesFromPrompt(null)).toBe(null);
  });
});
