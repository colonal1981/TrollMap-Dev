/**
 * ── A TACKLE NAME AS THE PROMPT MUST SPELL IT ───────────────────────────────────────────────────
 *
 * The bag holds `3" Lipless Crankbait`, and an unescaped inch mark ends the JSON string the model is
 * asked to write. So the prompt sends `3in Lipless Crankbait`, the model echoes that back, and
 * resolveTackleName() in plan-prompt.js matches it at its `asShown` tier and puts the real name in
 * the plan.
 *
 * IT LIVES IN utils/ BECAUSE THE BENCH READER NEEDS IT AND MUST NOT IMPORT THE PLANNER.
 * `droppedFromAnswer()` in bench-read.js compares what the model wrote against what reached the plan,
 * and the one transform the app itself applied is not a value going missing — so it has to undo the
 * same substitution, from the same function, or the two spellings drift apart. Pulling plan-prompt.js
 * into a util to get two lines of string work would drag the whole prompt builder with it.
 *
 * `stripLureAnnotation()` is its sibling and stays in plan-prompt.js for now: nothing outside the
 * planner reads it, and moving a function nobody else needs is churn.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */
export function promptSafeTackleName(name) {
  return String(name == null ? '' : name).replace(/"/g, 'in');
}
