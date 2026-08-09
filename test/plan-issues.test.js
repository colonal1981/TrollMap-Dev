import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { planIssuesHtml } from '../js/modules/plan-issues.js';

const WIRING = readFileSync(new URL('../js/modules/smart-plan-v2-wiring.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Why this test exists
//
// assemblePlan() refuses things correctly and says so: a stop on a run that is not in the
// plan, a change on a rod that is not in the loadout, a deploy of a seventh rod, a day over
// its amp-hour budget, a last leg that ends 2.8 km from the ramp. Every one of those pushed
// a line onto plan.warnings -- and the wiring rendered `problems` only when `r.plan` was
// null, so the entire list was thrown away the moment a plan succeeded.
//
// Ryan's report: "only gave me 1 spot to stop and cast". Two stops had been refused, in
// writing, into a variable nobody displayed.
// ---------------------------------------------------------------------------

describe('plan-issues — a refusal is not a smaller kind of error', () => {
  it('renders warnings when the plan is NOT null', () => {
    const out = planIssuesHtml({ warnings: ['dropped a stop on w#9 — that run is not in the plan'] }, []);
    expect(out).toContain('dropped a stop on w#9');
  });

  it('says nothing when there is nothing to say', () => {
    expect(planIssuesHtml({ warnings: [] }, [])).toBe('');
    expect(planIssuesHtml(null, [])).toBe('');
    expect(planIssuesHtml({ warnings: [], safety: { isGo: true } }, [])).toBe('');
  });

  it('lists each warning once — problems already contains plan.warnings', () => {
    // smart-plan-v2.js:120 folds args.problems, plan.warnings and validatePlan() into one list.
    // Printing the assembler's warnings twice reads like two different refusals.
    const w = 'dropped a lure change on R9 — no such rod in the loadout';
    const out = planIssuesHtml({ warnings: [w] }, [w, 'L2 starts at 4300, expected 4299']);
    expect(out.split('<li>').length - 1).toBe(2);
  });

  it('honours safety.isGo === false with a block, not a footnote', () => {
    // v1 stopped for this (smart-plan.js:1066) and the rewrite lost it: the model could return
    // isGo:false with a hazard warning and v2 rendered the day as though nothing was wrong.
    // Over 15 sustained or 20 gusting is a no-go for a 12.5 ft kayak.
    const out = planIssuesHtml({ warnings: [],
      safety: { isGo: false, warning: 'gusting 22 mph out of the northwest',
                rampEvaluation: 'Clearwater Cove is a lee shore today' } }, []);
    expect(out).toContain('NO-GO');
    expect(out).toContain('gusting 22 mph');
    expect(out).toContain('Clearwater Cove is a lee shore');
  });

  it('escapes what it prints — a warning carries model text and structure names', () => {
    const out = planIssuesHtml({ warnings: ['<script>alert(1)</script> & more'] }, []);
    expect(out.includes('<script>')).toBe(false);
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&amp; more');
  });

  it('drops blanks rather than printing an empty bullet', () => {
    expect(planIssuesHtml({ warnings: ['', '   ', null] }, [undefined])).toBe('');
  });
});

describe('smart-plan-v2-wiring — the warnings reach the screen with the plan', () => {
  it('renders the issues on the success path, not only when the plan is null', () => {
    const i = WIRING.indexOf('if (!r.plan)');
    const j = WIRING.indexOf('planIssuesHtml(r.plan, r.problems)');
    expect(j).toBeGreaterThan(i);      // after the null-plan early return, i.e. a plan exists
    expect(WIRING).toContain('insertAdjacentHTML');
  });

  it('inserts them AFTER the renderer, which sets innerHTML on the same container', () => {
    expect(WIRING.indexOf('renderSmartPlanUI({'))
      .toBeLessThan(WIRING.indexOf('planIssuesHtml(r.plan, r.problems)'));
  });

  it('prepends the regulation advisories exactly once', () => {
    // They were prepended at :195 and again at :204-206, so a slot limit printed twice.
    expect((WIRING.match(/\.\.\.legality\.warnings/g) || []).length).toBe(1);
  });

  it('stops the status line claiming a plan when the model called a no-go', () => {
    expect(WIRING).toContain('safety.isGo === false');
    expect(WIRING).toContain('NO-GO');
  });
});
