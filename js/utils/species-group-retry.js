// species-group-retry.js — a species group the Worker could not answer is asked again in a NEW
// request, and the second answer is merged into the first.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// WHY THE RETRY LIVES HERE AND NOT IN THE WORKER. /research/agent-llm for `fisheries` runs every
// species group inside one Worker invocation, and Workers Free allows that invocation 50 external
// subrequests (developers.cloudflare.com/workers/platform/limits/#subrequests). A group retried
// inside it could spend the allowance, and every group after it then failed on its first fetch
// without ever reaching a model -- Nottely Lake (GA), 2026-09-25, lost catfish, panfish and
// "other" to "Too many subrequests by single Worker invocation." A new request has a fresh
// allowance, so the Worker makes one pass per group and the caller asks again.
//
// The Python batch has the same rule in Scripts/species_group_retry.py. Two languages, so two
// copies; test/a-refused-group-is-asked-in-a-new-request.test.js holds this one.

// The backoff the Worker used to spend inside the request, unchanged: "a spike measured in seconds
// is answered by seconds" (the note above runGroup in Worker/research/agents.js).
export const GROUP_RETRY_WAITS_MS = [8000, 20000];

/**
 * The longest delay Google asked for across the groups `res` did not answer, in ms, or 0. A group
 * refused per minute or for "high demand" ends its pass after one request (stopOnRefusal,
 * Worker/worker-core.js) and reports Google's "Please retry in 35.4s" as retryAfterMs; asking
 * again before it is up is a request spent on a refusal. Scripts/species_group_retry.py has the
 * same rule.
 */
export function retryAfterMs(res) {
  const groups = res?.meta?.groups;
  if (!Array.isArray(groups)) return 0;
  return Math.max(0, ...groups.filter((g) => g && g.ok === false).map((g) => Number(g.retryAfterMs) || 0));
}

/** The groups a response says it did not answer: failed, or never asked. */
export function groupsToAskAgain(res) {
  const groups = res?.meta?.groups;
  return Array.isArray(groups) ? groups.filter((g) => g && g.ok === false).map((g) => g.group) : [];
}

const keyOf = (v) => (typeof v === 'string' ? v.trim().toLowerCase()
  : String(v?.species || v?.name || '').trim().toLowerCase());

// The Worker's own union rule for the lake-level answers (addAll in handleResearchAgent): the
// first non-empty entry per name stands, and a later answer cannot delete an earlier one.
function union(a, b) {
  const out = [];
  for (const x of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const k = keyOf(x);
    if (!k || out.some((y) => keyOf(y) === k)) continue;
    out.push(typeof x === 'string' ? x.trim() : x);
  }
  return out;
}

/**
 * The second request's answer, merged into the first. `again` answered only the groups it was
 * asked for (`again.meta.askedGroups`); every other group keeps the first request's outcome.
 */
export function mergeGroupAnswers(first, again) {
  if (!again || !again.success) return first;
  const fm = first.meta || {};
  const am = again.meta || {};
  const redo = new Set((am.groups || []).map((g) => g.group));
  const prior = new Map((fm.groups || []).map((g) => [g.group, g]));
  const groups = (fm.groups || []).map((g) => {
    const n = (am.groups || []).find((x) => x.group === g.group);
    return n ? { ...n, attempts: (g.attempts || 0) + (n.attempts || 0) } : g;
  });
  for (const n of am.groups || []) if (!prior.has(n.group)) groups.push(n);
  // What went missing, per group: the first request's list less the species of every group the
  // second one was asked about, plus whatever the second one could not answer in turn.
  const redoSpecies = new Set([...redo].flatMap((g) => prior.get(g)?.species || []));
  const missingSpecies = union((fm.missingSpecies || []).filter((s) => !redoSpecies.has(s)),
                               am.missingSpecies || []);
  const isRedoLine = (w) => [...redo].some((g) => String(w).startsWith(`fisheries group "${g}"`));
  const fd = first.data || {};
  const ad = again.data || {};
  return {
    ...first,
    section: { ...(first.section || {}), ...(again.section || {}) },
    data: {
      ...fd,
      lakeForage: {
        primary: union(fd.lakeForage?.primary, ad.lakeForage?.primary),
        secondary: union(fd.lakeForage?.secondary, ad.lakeForage?.secondary),
      },
      speciesFound: union(fd.speciesFound, ad.speciesFound),
    },
    meta: {
      ...fm,
      groups,
      failedGroups: groups.filter((g) => !g.ok && g.asked !== false),
      notAskedGroups: groups.filter((g) => !g.ok && g.asked === false),
      missingSpecies,
    },
    warnings: [...(first.warnings || []).filter((w) => !isRedoLine(w)), ...(again.warnings || [])],
  };
}

/**
 * Ask the groups `first` did not answer again, one new request per wait, until none are left or
 * the waits are spent. `ask(groupNames)` makes the request and resolves to the parsed JSON (or
 * throws). Resolves to { res, reasked } -- the merged answer and every group that needed a
 * second request.
 */
export async function askFailedGroupsAgain(ask, first, {
  waits = GROUP_RETRY_WAITS_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
} = {}) {
  let res = first;
  const reasked = new Set();
  for (const argued of waits) {
    const redo = groupsToAskAgain(res);
    if (!redo.length) break;
    // The wait argued for above, or Google's own delay when it asked for longer.
    const wait = Math.max(argued, retryAfterMs(res));
    log(`species group(s) ${redo.join(', ')} not answered -- asking again in a new request after ${wait / 1000}s`);
    await sleep(wait);
    redo.forEach((g) => reasked.add(g));
    let again = null;
    try { again = await ask(redo); } catch (e) { log(`the new request failed: ${e.message}`); }
    res = mergeGroupAnswers(res, again);
  }
  return { res, reasked: [...reasked] };
}
