// ONE PLACE TO ASK "IS THIS A NUMBER", BECAUSE Number(null) IS 0 AND 0 IS FINITE.
//
// `Number.isFinite(Number(v))` reads as a null check and is not one. Number(null) is 0,
// Number('') is 0, Number('   ') is 0, Number([]) is 0 and Number([7]) is 7. Every one of those
// passes, so a field that was never measured comes out of the guard as a real reading of zero.
//
// THIS FAMILY HAS NOW BEEN FOUND EIGHT TIMES IN THIS APP. Worker/registry.js carries the same fix
// written out longhand inside identityBaseline() after a null area_acres reported a lake of zero
// acres. compassOf(null) returned 'N' for the same reason and had to grow its own guard. And on
// 2026-09-15, conditionsPromptBlock() in plan-prompt.js was found sending this to the model on
// every water with no gauge bound to it:
//
//     WHAT THE GAUGES SAY TODAY
//     Water temperature null °F.
//     Dissolved oxygen null mg/L. Below about 4 mg/L is not holding fish.
//     Chance of rain null% in the first forecast period.
//     Barometer null mb — one observation, so there is no trend in it.
//     Flow versus normal null — National Water Model anomaly...
//
// under a heading promising what the gauges say, on waters where no gauge said anything. That
// function's own docblock reads "Every line is silent when its field is null. Nothing is inferred
// from an absence." Five lines did the opposite, and `Number.isFinite(Number(x))` is the whole
// reason: `x` was null, `Number(x)` was 0, the guard passed, and the template printed the
// ORIGINAL value — the string "null" — beside a unit.
//
// ABSENCE IS CHECKED BEFORE THE CONVERSION, NEVER AFTER. That is the whole rule, and it is here
// once so the ninth instance is a one-word change instead of a rediscovery.
//
// Worker/ code cannot import this: the Worker is a separate bundle and imports nothing from js/.
// Its copy stays where it is rather than being reached across a boundary that does not exist.

/**
 * Is `v` an actual number — measured, parsed or typed — as opposed to an absence?
 *
 * A number is finite and is a number, or a non-blank string that parses to one. Everything else
 * is absence: null, undefined, '', whitespace, [], {}, NaN, Infinity, true.
 */
export function isNum(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string' || v.trim() === '') return false;
  return Number.isFinite(Number(v));
}

/** `v` as a number, or null when it is an absence. Never 0 for a thing that was not measured. */
export function num(v) {
  return isNum(v) ? Number(v) : null;
}
