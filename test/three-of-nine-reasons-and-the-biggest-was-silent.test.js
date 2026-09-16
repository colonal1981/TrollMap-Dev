// THREE OF NINE REASONS, AND THE BIGGEST ONE WAS SILENT.
//
// Ryan, 2026-09-16, on a Congaree bench plan that came back with no lanes at all:
//
//     "of 1473 runs, 101 failed the depth rule, 42 had no window worth trolling,
//      0 passed nothing worth trolling"
//
// That accounts for 143 of 1,473. The dominant reason was UNROUTABLE -- 915 runs, 62% of the
// water -- and the sentence whose entire job is to say which test emptied the list never
// mentioned it. selectCandidates counts NINE reasons; this printed three of them by name.
//
// The comment above the old message says it exists so that "the band is wrong" and "this fish does
// not live on this lake" stop reading as the same failure. It could not do that while the largest
// bucket had no line.
//
// Built from the counter object now, largest first, so a tenth filter shows up the day it starts
// rejecting something -- and `accountedFor` is compared against `considered`, because a run in no
// bucket is a filter somebody added without a counter.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'js', 'modules', 'smart-plan-v2.js'), 'utf8');
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const CAND = readFileSync(join(here, '..', 'js', 'modules', 'plan-candidates.js'), 'utf8');

// The message builder, lifted from the source so the ordering and the labels are exercised rather
// than read. buildSmartPlanV2 needs a pack, a graph and a model to reach that branch.
const WHY = {
  unroutable: "could not be reached from the ramp over this water's graph",
  unfitted: 'are not fitted lanes, and this pack has fitted lanes',
  depth: 'failed the depth rule',
  noWindow: 'had no window worth trolling',
  scoreless: 'scored nothing worth trolling',
  battery: 'were over the battery budget',
  window: 'fell outside the trip window',
  dedupe: 'duplicated a lane already offered',
  limit: 'were past the candidate limit',
  // Added 2026-09-16 with its counter. The `continue` for a run with fewer than two coordinates
  // had none at all, so accountedFor could not balance and nothing said why -- zero on every pack
  // measured, but "it does not happen today" is why a missing counter survives, not a reason to
  // leave it. This test failed the moment the counter was added and the wording was not, which is
  // the drift check working in the direction it was written for.
  geometry: 'carried fewer than two coordinates',
};
const reasons = (r) => Object.entries(r).filter(([, n]) => Number(n) > 0)
  .sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${WHY[k] || `were rejected by ${k}`}`);

describe('the empty-plan message names every reason it counted', () => {
  it('leads with unroutable on the run that exposed this', () => {
    // congaree_river, measured off the shipped pack: 1,473 runs, 558 routable, 915 not.
    const out = reasons({ depth: 101, unroutable: 915, noWindow: 42, scoreless: 0,
                          battery: 0, window: 0, dedupe: 0, limit: 415, unfitted: 0 });
    expect(out[0]).toBe("915 could not be reached from the ramp over this water's graph");
    expect(out[1]).toBe('415 were past the candidate limit');
    expect(out.length).toBe(4);
  });

  it('says nothing about a reason that rejected nothing', () => {
    // The old message printed "0 passed nothing worth trolling" on every failure, which reads as
    // a finding and is noise.
    const out = reasons({ depth: 3, unroutable: 0, noWindow: 0, scoreless: 0 });
    expect(out).toEqual(['3 failed the depth rule']);
  });

  it('names a counter it has no label for rather than dropping it', () => {
    // A tenth filter appears the day it rejects something, even before anyone writes its wording.
    expect(reasons({ somethingNew: 7 })).toEqual(['7 were rejected by somethingNew']);
  });

  it('covers every counter selectCandidates actually keeps', () => {
    // The labels and the counters must not drift apart. accountedFor in plan-candidates.js lists
    // the full set, and this pins the message against it.
    const listed = CAND.split('accountedFor:')[1].split('depthRule')[0];
    for (const k of Object.keys(WHY)) {
      expect(listed.includes(`rejected.${k}`) || k === 'depth', `${k} not in accountedFor`)
        .toBe(true);
    }
    for (const m of listed.matchAll(/rejected\.([a-zA-Z]+)/g)) {
      expect(Object.keys(WHY).includes(m[1]), `no wording for rejected.${m[1]}`).toBe(true);
    }
  });
});

describe('the source carries the fix, not just the test', () => {
  it('builds the list from the counters instead of three named fields', () => {
    expect(CODE).toContain('Object.entries(r)');
    expect(CODE).toContain('.sort((a, b) => b[1] - a[1])');
    // The three hand-picked reads that hid the other six.
    expect(CODE.includes('${r.depth ?? 0} `')).toBe(false);
    expect(CODE.includes('passed nothing worth trolling')).toBe(false);
  });

  it('compares accountedFor against considered', () => {
    // A run in no bucket is a filter added without a counter -- the exact defect plan-candidates
    // computes accountedFor to catch, and nothing had ever read it.
    expect(CODE).toContain('s.considered - s.accountedFor');
    expect(CODE).toContain('a filter ');
  });

  it('still says when holding was unknown, which changes which rule ran', () => {
    expect(CODE).toContain('holdingUnknown');
    expect(CODE).toContain('fish-band-vs-water-depth test was used');
  });

  it('says so plainly when nothing rejected anything either', () => {
    // considered > 0, every counter zero, kept empty: a real state, and silence would read as a
    // crash rather than as "no run was offered and none was refused".
    expect(CODE).toContain('none were rejected by any rule');
  });
});
