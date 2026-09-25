#!/usr/bin/env python3
r"""species_group_retry.py -- a species group the Worker could not answer is asked again in a NEW
request, and the second answer is merged into the first.

Personal use only, not for distribution or resale; not for navigation.

WHY THE RETRY LIVES HERE AND NOT IN THE WORKER. /research/agent-llm for `fisheries` runs every
species group inside one Worker invocation, and Workers Free allows that invocation 50 external
subrequests (developers.cloudflare.com/workers/platform/limits/#subrequests). A group retried inside
it could spend the allowance, and every group after it then failed on its first fetch without ever
reaching a model. Ryan's lake batch, 2026-09-25, `--group-models claude`:

    warn [Nottely Lake, GA]: fisheries group "catfish" returned nothing (Too many subrequests by
         single Worker invocation. ...)   -- and "panfish", and "other"
    [ 22/30] ok  484.8s  Nottely Lake, GA  5/10 species ... 7 retries  LOST: Channel Catfish, ...

A new request has a fresh allowance. So the Worker makes one pass per group and reports each one --
`ok`, or failed with its reason, or `asked: false` when the allowance was spent before its turn --
and the callers ask the rest again: research_lakes.py and time_fisheries_run.py through this file,
the app through js/utils/species-group-retry.js. Two languages, two copies of one rule.
"""
import time

# The backoff the Worker used to spend inside the request, unchanged: "a spike measured in seconds
# is answered by seconds" (the note above runGroup in Worker/research/agents.js).
GROUP_RETRY_WAITS = (8, 20)


def groups_to_ask_again(res):
    """The groups a response says it did not answer: failed, or never asked."""
    groups = ((res or {}).get("meta") or {}).get("groups") or []
    return [g.get("group") for g in groups if isinstance(g, dict) and g.get("ok") is False]


def _key(v):
    if isinstance(v, str):
        return v.strip().lower()
    if isinstance(v, dict):
        return str(v.get("species") or v.get("name") or "").strip().lower()
    return ""


def _union(a, b):
    # The Worker's own union rule for the lake-level answers (addAll in handleResearchAgent): the
    # first entry per name stands, and a later answer cannot delete an earlier one.
    out, seen = [], set()
    for x in list(a or []) + list(b or []):
        k = _key(x)
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(x.strip() if isinstance(x, str) else x)
    return out


def merge_group_answers(first, again):
    """The second request's answer, merged into the first. `again` answered only the groups it was
    asked for; every other group keeps the first request's outcome."""
    if not again or not again.get("success", True):
        return first
    fm, am = first.get("meta") or {}, again.get("meta") or {}
    prior = {g.get("group"): g for g in fm.get("groups") or []}
    fresh = {g.get("group"): g for g in am.get("groups") or []}
    groups = []
    for g in fm.get("groups") or []:
        n = fresh.get(g.get("group"))
        groups.append(dict(n, attempts=(g.get("attempts") or 0) + (n.get("attempts") or 0))
                      if n else g)
    groups += [n for name, n in fresh.items() if name not in prior]
    # What went missing: the first request's list less the species of every group asked again,
    # plus whatever the second request could not answer in turn.
    redo_species = {s for name in fresh for s in (prior.get(name) or {}).get("species") or []}
    missing = _union([s for s in fm.get("missingSpecies") or [] if s not in redo_species],
                     am.get("missingSpecies") or [])
    redo_lines = tuple(f'fisheries group "{name}"' for name in fresh)
    fd, ad = first.get("data") or {}, again.get("data") or {}
    ff, af = fd.get("lakeForage") or {}, ad.get("lakeForage") or {}
    merged = dict(first)
    merged["section"] = {**(first.get("section") or {}), **(again.get("section") or {})}
    merged["data"] = dict(fd, lakeForage={"primary": _union(ff.get("primary"), af.get("primary")),
                                          "secondary": _union(ff.get("secondary"),
                                                              af.get("secondary"))},
                          speciesFound=_union(fd.get("speciesFound"), ad.get("speciesFound")))
    merged["meta"] = dict(fm, groups=groups, missingSpecies=missing,
                          failedGroups=[g for g in groups
                                        if g.get("ok") is False and g.get("asked") is not False],
                          notAskedGroups=[g for g in groups
                                          if g.get("ok") is False and g.get("asked") is False])
    merged["warnings"] = ([w for w in first.get("warnings") or []
                           if not str(w).startswith(redo_lines)]
                          + list(again.get("warnings") or []))
    return merged


def ask_failed_groups_again(ask, first, waits=GROUP_RETRY_WAITS, sleep=None, log=print):
    """Ask the groups `first` did not answer again, one new request per wait, until none are left
    or the waits are spent. `ask(names)` returns the parsed response or None. -> (merged, reasked),
    reasked being every group that needed a second request, in the order first asked again."""
    res, reasked = first, []
    for wait in waits:
        redo = groups_to_ask_again(res)
        if not redo:
            break
        log(f"species group(s) {', '.join(redo)} not answered -- asking again in a new request "
            f"after {wait}s")
        (sleep or time.sleep)(wait)
        reasked += [g for g in redo if g not in reasked]
        res = merge_group_answers(res, ask(redo))
    return res, reasked
