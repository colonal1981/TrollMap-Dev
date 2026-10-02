// Personal use only, not for distribution or resale; not for navigation.
/**
 * WHERE A PLAN'S MINUTES WENT, read off the status line he already watches.
 *
 * Ryan, 2026-10-02: "the next thing i want to look at is how long it takes for claude to build the
 * plan... it is taking anywhere from 8-13 minutes now to run a plan". His bridge log said how long
 * Claude took on each ask and nothing said where the rest went. Asked whether to time the app's own
 * steps, he said yes.
 *
 * Every step of a build already announces itself on the status line ("Checking the forecast…",
 * "Reading the pack…", "Asking Claude…"), so the planner's `say()` marks the clock and a step lasts
 * until the next one is announced. No second list of step names to keep in step with the first.
 */

/** A clock for one build. `mark(step)` starts a step; `report()` says how long each took. */
export function stepTimer(now = () => Date.now()) {
  const t0 = now();
  const marks = [];
  return {
    mark(step) { marks.push({ step: String(step == null ? '' : step), at: now() }); },
    report(end = now()) {
      const steps = marks.map((m, i) => ({
        step: m.step, ms: (i + 1 < marks.length ? marks[i + 1].at : end) - m.at,
      }));
      // The work before the first announcement is a step too.
      if (marks.length && marks[0].at > t0) steps.unshift({ step: 'before the first step', ms: marks[0].at - t0 });
      return { totalMs: end - t0, steps };
    },
  };
}

/**
 * Is this step the model writing? The asker announces each ask itself -- "Asking Claude (…) on
 * this PC…", or "… — asking Gemini." when Claude was not there -- and "Reading the answer…" the
 * moment it comes back (claude-bridge.js), so the model's time is exactly the steps between.
 */
export function isModelStep(step) {
  return /^Asking Claude\b|asking Gemini\b/i.test(String(step || ''));
}

/** One per answer that came back, so it counts the asks. */
export const ANSWER_STEP = 'Reading the answer…';

/** 604000 -> "10 min 4 s"; 41200 -> "41 s". */
export function fmtDuration(ms) {
  const s = Math.round(Math.max(0, Number(ms) || 0) / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m} min ${s % 60} s` : `${s} s`;
}

/**
 * The one line on the plan: the total, the model's share and how many answers it took, and the
 * app's own steps in the order they ran. A step that rounds to 0 s is left out of the list; its
 * time is still in the app's total.
 */
export function timingNote(report) {
  if (!report || !Array.isArray(report.steps) || !report.steps.length) return null;
  const modelMs = report.steps.filter((s) => isModelStep(s.step)).reduce((a, s) => a + s.ms, 0);
  const asks = report.steps.filter((s) => s.step === ANSWER_STEP).length;
  // A step announced more than once (the answer is read after every ask) is summed under its name,
  // in the order it first ran.
  const byName = new Map();
  for (const s of report.steps) {
    if (isModelStep(s.step)) continue;
    const name = s.step.replace(/[….\s]+$/, '');
    byName.set(name, (byName.get(name) || 0) + s.ms);
  }
  const listed = [...byName].filter(([, ms]) => Math.round(ms / 1000) > 0)
    .map(([name, ms]) => `${name} ${fmtDuration(ms)}`);
  return `this plan took ${fmtDuration(report.totalMs)}: the model ${fmtDuration(modelMs)}`
    + `${asks > 1 ? ` over ${asks} answers` : ''}, the app ${fmtDuration(report.totalMs - modelMs)}`
    + (listed.length ? ` (${listed.join(', ')})` : '');
}
