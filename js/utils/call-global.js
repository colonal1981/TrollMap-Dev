/**
 * callGlobal — invoke a function that another module hung on `window`, without letting it
 * take the caller down and without letting it fail in silence.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS EXISTS
 *
 * Fourteen places across map-init, tabs, chart-overlay, gps and smart-plan wrote some
 * variation of:
 *
 *     try { window.renderEditTables?.(); } catch (_) {}
 *
 * The `?.` and the `catch` are doing two different jobs, and only one of them is right.
 *
 * The `?.` handles "that module has not loaded yet", which is a real and expected state
 * during startup -- these are cross-module calls through the global namespace precisely
 * because there is no import graph between them, so ordering is not guaranteed. Skipping is
 * the correct response.
 *
 * The `catch {}` handles "the function ran and threw", which is not expected at all. Every
 * one of these callees is a RENDERER. When one throws, the table or the stats panel it owns
 * keeps showing the previous state -- so the visible symptom of a crashed renderer is a
 * screen that looks fine and is quietly out of date. That is the worst failure mode a UI can
 * have, and fourteen copies of `catch (_) {}` were the reason it never surfaced.
 *
 * Collapsing them here separates the two: a missing function stays silent, a throwing
 * function gets logged with its own name attached. One implementation, so the day this should
 * raise a banner instead of a console line, that is a change to this file.
 */

/**
 * Call `window[name](...args)` if it exists.
 *
 * @param {string} name  the global function's name, used in the log when it throws
 * @param {...*} args    forwarded to the callee
 * @returns {*} whatever the callee returned, or undefined if it was absent or threw
 */
export function callGlobal(name, ...args) {
  const fn = typeof window !== 'undefined' ? window[name] : undefined;
  // Absent is normal: module load order is not guaranteed for globals.
  if (typeof fn !== 'function') return undefined;
  try {
    return fn(...args);
  } catch (err) {
    console.error(`[callGlobal] ${name}() threw; the view it owns is now stale:`, err && err.message);
    return undefined;
  }
}

/**
 * Call a function you already hold a reference to, with the same guarantee.
 *
 * For listener fan-out, where the callee is not a global and one bad subscriber must not stop
 * the rest -- but must still be identifiable rather than vanishing into `catch (_) {}`.
 *
 * @param {Function} fn
 * @param {string} label  what to call it in the log
 * @param {...*} args
 */
export function callSafely(fn, label, ...args) {
  if (typeof fn !== 'function') return undefined;
  try {
    return fn(...args);
  } catch (err) {
    console.error(`[callSafely] ${label} threw:`, err && err.message);
    return undefined;
  }
}
