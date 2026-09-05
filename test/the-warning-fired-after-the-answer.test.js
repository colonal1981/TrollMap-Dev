import { describe, it, expect } from './expect-shim.mjs';
import { timeBudgetBlock } from '../js/modules/plan-prompt.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// The numbers are the real ones. Lake Wateree, Clearwater Cove, 2026-09-06,
// 06:00 to 15:00: the plan came back at 792 minutes against a 540 minute
// window, and 80.61 Ah against 80 usable.
//
// Every part of that arithmetic already existed. plan-water-ui.js computes
// windowMin from the launch and return times. dayCost() prices the picked set
// against it. plan-assemble.js writes "estimated 792 min against a 540 min
// window" into the warnings. And the string "540" had never once appeared in
// the prompt -- the model got "06:00" and "15:00" and was left to do the
// arithmetic itself.
//
// A warning that fires after the answer comes back is a receipt, not a
// constraint.
//
// The block does NOT ask for a leg to be dropped. Three hundred lines further
// down the same prompt says "He picked these stretches himself... The list
// above IS the day", and a leg left out is a leg he runs with bare rods. So
// the instruction is to name where the clock runs out and let him make the
// cut.
// ---------------------------------------------------------------------------

describe('timeBudgetBlock — the budget the prompt never carried', () => {
  it('states the window in minutes, which is the unit the plan is counted in', () => {
    const b = timeBudgetBlock(540, '06:00', '15:00');
    expect(b).toMatch(/06:00 to 15:00 is 540 MINUTES on the water/);
    expect(b).toMatch(/9 hours, ramp to\s+ramp/);
    expect(b).toMatch(/Every duration you write must add up against 540/);
  });

  it('carries the app own price for the water and the size of the overrun', () => {
    const b = timeBudgetBlock(540, '06:00', '15:00', 792);
    expect(b).toMatch(/prices the water below at 792 minutes/);
    expect(b).toMatch(/252 minutes\s+MORE than he has/);
  });

  it('asks where the clock runs out instead of asking for a leg to be dropped', () => {
    const b = timeBudgetBlock(540, '06:00', '15:00', 792);
    expect(b).toMatch(/Do not solve this by dropping a leg/);
    expect(b).toMatch(/WHERE THE CLOCK RUNS OUT/);
    expect(b).toMatch(/name the leg he will be on when the 540 minutes are gone/);
    expect(b).toMatch(/The\s+cut is his to make/);
  });

  it('reports slack as slack when the day actually fits', () => {
    const b = timeBudgetBlock(540, '06:00', '15:00', 400);
    expect(b).toMatch(/leaves\s+140 minutes of slack/);
    expect(b).toMatch(/spend it on stops, not on padding the legs/);
    expect(b).not.toMatch(/MORE than he has/);
    expect(b).not.toMatch(/WHERE THE CLOCK RUNS OUT/);
  });

  it('still states the budget when no price for the water exists', () => {
    // Smart Plan's path: selectCandidates trims the OFFER to the window and the
    // model picks from it, so there is no chosen-set total at prompt time. The
    // constraint applies anyway.
    const b = timeBudgetBlock(540, '06:00', '15:00');
    expect(b).toMatch(/540 MINUTES/);
    expect(b).not.toMatch(/prices the water below/);
    expect(b).not.toMatch(/slack/);
  });

  it('is silent rather than inventing a day length', () => {
    expect(timeBudgetBlock(null, '06:00', '15:00', 792)).toBe('');
    expect(timeBudgetBlock(0, '06:00', '15:00')).toBe('');
    expect(timeBudgetBlock(undefined, null, null)).toBe('');
  });

  it('does not re-estimate — a dayMin that is not a number is simply absent', () => {
    const b = timeBudgetBlock(540, '06:00', '15:00', NaN);
    expect(b).toMatch(/540 MINUTES/);
    expect(b).not.toMatch(/prices the water below/);
  });
});
