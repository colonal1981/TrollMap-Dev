/**
 * research_todo_rules.mjs -- the three decisions research_todo.mjs makes about a row, pulled out
 * where a test can reach them. research_todo.mjs itself loads the live access index and calls
 * the worker at import time, so nothing inside it can be exercised without the network.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */

/**
 * Every state a name stamps on itself: "Silver Lake, GA" -> ['GA'], "Lake Sidney Lanier (Hall Co,
 * GA)" -> ['GA'], "Hartwell (SC/GA)" -> ['SC', 'GA'], "Broad River" -> []. The same shapes
 * stateOfQuery() in lake-registry.js reads, upper-case only, because every name the picker offers
 * is stamped that way (477 of 477 bound names on 2026-09-23) and a lower-case pair at the end of
 * a name is more likely a word than a state.
 */
export function stampedStates(name) {
  const m = /(?:,\s*|\(\s*)([A-Z]{2}(?:\s*\/\s*[A-Z]{2})*)\s*\)?\s*$/.exec(String(name || ''));
  return m ? m[1].split(/\s*\/\s*/) : [];
}

/**
 * MAY THIS RECORD ANSWER FOR THIS NAME, ON STATE ALONE?
 *
 * Asked only of lakeRecordFor(), the resolver that goes state-blind when its state index has
 * nothing. Measured on Ryan's machine 2026-09-23: 127 of the picker's names reach it, and the 28
 * whose answer is in a state the name rules out are all different waters -- "Silver Lake, GA"
 * and "Goose Creek, TN" became South Carolina lakes, "Lake Lanier, GA" a small SC lake called
 * lake_lanier, "Cherokee Lake, GA" the TVA reservoir, "INTRACOASTAL WATERWAY, NC" the Murrells
 * Inlet zone. None of the border reservoirs whose rows carry one state -- Russell, Thurmond,
 * Wylie, Chatuge, Tugalo, Yonah -- comes this way: the access index binds all of them on its own
 * evidence, so this check never sees them.
 *
 * NOT MOVED INTO lakeRecordFor(), AND MEASURED BEFORE DECIDING THAT. Applied there, the same rule
 * changed 36 resolutions across the app rather than 28, and the eight extra were the border
 * reservoirs above, which the app's other callers reach through lakeRecordFor() directly and
 * which are right. Their rows name one state of two; the register's broad-river-sc-is-an-nc-row
 * item is that data problem, and the rule belongs in the resolver only once the rows are fixed.
 *
 * A name with no stamp cannot be contradicted, and neither can a row with no state.
 */
export function stampAllows(rec, name) {
  const stamped = stampedStates(name);
  if (!rec || !stamped.length) return true;
  const own = String(rec.state || '').toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  return !own.length || own.some((s) => stamped.includes(s));
}

/**
 * THE ROW'S STATE WHEN A ROW ANSWERED, THE NAME'S OWN STAMP WHEN NONE DID.
 *
 * With a cross-state binding refused by stampAllows(), a row that answers is in a state the name
 * allows or was bound by the access index on its own evidence, so this is where the 28 refused
 * names get their state from now: their own stamp, "Silver Lake, GA" -> GA, where the refused
 * row would have said SC.
 *
 * THE STAMP DOES NOT OVERRIDE A ROW, AND THAT WAS MEASURED, NOT ASSUMED. Nine names the access
 * index binds carry a stamp their row does not -- Broad (SC), Thurmond (SC), Wylie (SC), Chatuge
 * (NC), Russell (GA), Tugalo (GA), Yonah (GA), French Broad (TN) and the Wright River -- and for
 * "Broad River, SC" the stamp is the half that is right (Ryan: "there is no Broad River in
 * Cherokee County, North Carolina"). But the Worker opens NC WRC's species file only when the
 * state it is handed is NC (registrySpeciesFor in Worker/research/deterministic.js), and that
 * file holds 8 species for broad_river and 7 for french_broad_river. Stamp-first would have
 * researched both under the right state and without the only roster either one has. The rows
 * are the register's broad-river-sc-is-an-nc-row item, and they are fixed there or not at all.
 *
 * The stamp pattern also reads "(Hall Co, GA)", which the one it replaces did not.
 */
export function stateFor(name, rec) {
  return (rec && rec.state) || stampedStates(name)[0] || null;
}

/**
 * THE WORK LIST IN THE ORDER IT IS WORTH DOING: most buildable trolling runs first.
 *
 * The acreage floor ranked rivers upside down against how much of them is sounded -- the
 * Nolichucky (3,398 ac, 12 runs) was in and the Sampit (721 ac, 1,861 runs) was out -- and there
 * is no cliff in the runs distribution to put a second floor on. So nothing is cut here; the
 * list is ordered, and --limit takes the top of it.
 *
 * `runsBySlug` is registry/_trolling_runs.json's `lakes` object. A row with no count -- no slug,
 * or a water the run builder has not reached -- goes after every counted row, in the order it
 * came, because "not built" is not a measurement of zero. Stable, and it never drops a row.
 */
export function orderByRuns(rows, runsBySlug) {
  const runsOf = (r) => {
    const v = r && r.slug && runsBySlug && runsBySlug[r.slug];
    return v && Number.isFinite(v.runs) ? v.runs : null;
  };
  return rows
    .map((r, i) => ({ r: { ...r, runs: runsOf(r) }, i }))
    .sort((a, b) => {
      const x = a.r.runs, y = b.r.runs;
      if (x === null && y === null) return a.i - b.i;
      if (x === null) return 1;
      if (y === null) return -1;
      return (y - x) || (a.i - b.i);
    })
    .map((e) => e.r);
}
