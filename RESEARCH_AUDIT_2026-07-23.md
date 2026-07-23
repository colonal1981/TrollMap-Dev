# Research Pipeline Audit — Seed Removal and Root-Cause Simplification

**Date:** 2026-07-23  
**Scope:** `Worker/research/**`, `Worker/worker-research.js`, the research routes in `Worker/trollmap-worker.js`, and `js/modules/lake-research-engine.js`.  
**Constraints applied:** preserve existing behavior; do **not** split more modules; reduce code rather than add another layer; R2-hosted copies, Grokipedia, Wikipedia, and sources genuinely unreachable through search are acceptable exceptions.

This is a fresh audit of the current checkout, not a restatement of the earlier refactor audit. The earlier split of the old 7,500-line Worker file has occurred. The remaining problem is now **policy and orchestration duplication**, not file size alone.

## Implementation status — 2026-07-23

**Phase 1 and Phase 2 have begun.** The implementation removed 749 lines of research code while retaining the existing module boundaries.

Completed:

- Removed per-lake live-source routing from discovery: Grokipedia slug map, search-name overrides, system aliases, owner-domain map, Duke/owner drawdown seeds, direct SCDNR seeds, broad state-news seeds, and the hard-coded no-results fallback.
- Retained the approved R2 regulation digests, R2 TN/GA source copies, generic Grokipedia candidates/citation following, Wikipedia citation following, and the EPA NSCEP search endpoint.
- Deleted the unused `drawdown.js` module after all its imports/callers were removed.
- Removed the Lake Wateree-specific cached-document regex corrections and direct live agency/regulation fetches from deterministic facts.
- Grounded the regulations agent from the approved R2 digest parser instead of live hard-coded eRegulations URLs.
- Centralized legacy profile-key resolution through `researchStorageId()` and removed the duplicate storage map.

Deferred intentionally:

- The Worker-side `/research/agent` end-to-end coordinator remains until production access logs confirm that no manual or external client uses it. The browser does not call it, but deleting a public route without that evidence could remove a working external workflow.

---

## 1. Plain-English map: what each research module does

### What happens during a normal full run

1. **Browser engine (`js/modules/lake-research-engine.js`, 2,214 lines)**
   - Coordinates the run and displays progress.
   - Gets deterministic facts, R2 geometry-derived habitat facts, and Water Quality Portal data.
   - For each research subject (identity, water quality, biology, habitat, navigation, regulations, fishing strategy), asks the Worker to discover sources.
   - Downloads documents through the Worker. PDFs are converted to text in the browser, which avoids Worker CPU limits.
   - Sends the document text back for fact extraction, de-duplication, and an LLM section result.
   - Merges all results, preserves verified values, runs a final “fill only missing values” pass, and saves the profile.

2. **Discovery (`Worker/research/discover.js`, 1,080 lines)**
   - Builds searches, searches through TinyFish, removes obvious wrong-lake/no-value results, scores candidates, follows Grokipedia/Wikipedia citations, and returns the source list.
   - It is also the main location of the unwanted lake-by-lake seed tables.

3. **Downloading (`Worker/research/download.js`, 605 lines)**
   - Is a fetch/proxy service only: TinyFish first, then Scrape.do, Firecrawl, and raw fetch fallbacks. It returns document bytes/text for the browser to normalize.

4. **Deterministic facts (`Worker/research/deterministic.js`, 529 lines)**
   - Builds facts that do not need a search: state regulations, official ramp/attractor GIS, and some saved-document facts.
   - It currently also contains several Lake Wateree-specific corrections hidden inside generic-looking logic. That is precisely the kind of edge-case patch that should be removed or made generic.

5. **Fact extraction (`Worker/research/extract.js`, 828 lines)**
   - Classifies text, asks the LLM for quote-backed facts, de-duplicates facts, finds contradictions, and supports gap searches.

6. **Section agents (`Worker/research/agents.js`, 1,507 lines)**
   - Has the LLM prompts and defensive cleanup for each profile section.
   - Also contains `handleResearchAgentPipeline`, an old Worker-side end-to-end pipeline that overlaps the browser engine’s current orchestration.

7. **R2/KV storage (`storage.js`, `shared.js`, `keys.js`)**
   - `storage.js`: saves/loads/version-controls lake profiles and validates missing fields.
   - `shared.js`: stores a normalized document once and lets later lakes/runs reuse it.
   - `keys.js`: turns lake display names into stable R2 profile names and handles a small number of true cross-border aliases.

8. **Specialized data helpers**
   - `clients.js`: TinyFish and scrape clients plus R2 regulation-digest retrieval.
   - `dataset.js`: EPA/agency dataset discovery and wrong-document filtering.
   - `drawdown.js`: owner/operator operations-source selection.
   - `limnology.js`: Water Quality Portal analysis.
   - `facts-util.js`: official ArcGIS ramps/attractors and shared evidence helpers.
   - `vision.js`: satellite-structure scan support.

### Important distinction

The browser engine and Worker are **not duplicate modules** in the normal sense:

- The browser must retain PDF text extraction because that is deliberately client-side.
- The Worker must retain discovery, secure provider access, LLM calls, and R2/KV access.

The duplication is that **both sides contain an end-to-end research coordinator**. The browser coordinator is live; the Worker coordinator is a legacy alternative that was retained after browser orchestration was introduced.

---

## 2. Audit conclusion

### Overall result: needs a targeted cleanup, not another rewrite

The pipeline can already discover most information by searching. However, `discover.js` has accumulated lake-specific maps, aliases, special searches, and direct URLs as patches for individual failures. Guaranteed seeds use `priority: 1`, which bypasses the normal per-agent source cap. Therefore every new exception increases both code and documents fetched, rather than improving the discovery mechanism itself.

The right correction is:

> **Search first. Keep only documented exceptions. An exception must be R2, Grokipedia, Wikipedia, or have a recorded reason that search cannot retrieve it.**

This can be done inside the existing `discover.js` module. It does not require creating or splitting any modules.

---

## 3. Seed inventory and disposition

### A. Keep: allowed by the stated policy

| Current code | Why it is allowed | Cleanup still worthwhile |
|---|---|---|
| R2 regulation digests in `clients.js` and `discover.js` | R2 is explicitly allowed. State regulations are stable cached copies and the live sites can be scraper-hostile. | Remove the duplicate R2 base/map definitions so one R2 regulation configuration drives both paths. |
| R2 TWRA reservoir pages in `discover.js` | Explicit R2 exception; the comments say live TN pages block scrapers. | Keep the data, but collapse “Boone”/“Boone Lake” etc. aliases through `parseLakeBaseName()` rather than maintaining 19 entries for 10 documents. |
| R2 GADNR forecast pages in `discover.js` | Explicit R2 exception; StoryMaps are not reliably fetchable. | Keep the data. Ideally use an R2 manifest when one is available; until then this is an approved exception table. |
| Grokipedia discovery/citation following | Explicitly allowed. It also produces citations that are then filtered to official/academic sources. | Keep generic candidate generation and citation following. |
| Wikipedia search and citation following | Explicitly allowed. It is searched rather than seeded as a per-lake URL. | Keep. |
| Known bad NEPIS IDs | These are **blocks**, not sources. They prevent two known wrong-lake EPA false positives. | Keep one shared set in `dataset.js`; remove the duplicate local set in `discover.js`. |
| Cross-border research IDs in `keys.js` | These identify one physical lake with different state-facing names, rather than forcing a source. | Keep centralized in `keys.js`; remove legacy copies in `storage.js` and `deterministic.js`. |

### B. Remove from automatic guaranteed seeding: search should be tried first

| Current seed/patch | Evidence in current code | Why it should not be automatically hardcoded | Safe replacement behavior |
|---|---|---|---|
| `GROKIPEDIA_SLUGS` map and Hartwell/Thurmond extra Grokipedia pages | `discover.js` lines 87–122 and special cases around 524–531 | Grokipedia itself is allowed, but manually selecting a different river/person-adjacent page for each lake is still lake-by-lake code. The generic Grokipedia candidates and search can find or fail naturally. | Search Grokipedia by lake name; retain only an exception if the generic search demonstrably fails and document the reason. |
| `queryLakeOverrides` for Russell, Thurmond, Norris, Douglas, and Watauga | `discover.js` lines 71–80 | These are search wording patches. They do not represent inaccessible data. | Search with both canonical display name and normalized base name; use aliases returned from the lake catalog where available, not a local hand-maintained map. |
| `LAKE_SYSTEM_ALIASES` | `discover.js` lines 124–150 (25 entries) | Basin/project names improve recall, but manual per-lake recall tuning is the behavior being avoided. | Make the first search exact-lake-name official-domain search. Add an alias only after a failed search is recorded; store it with the lake catalog, not discovery logic. |
| `LAKE_OWNER_DOMAINS` | `discover.js` lines 152–167 | This is another per-lake owner map, and duplicates the owner decisions in `drawdown.js`. | Discover the owner from source text/LLM or existing lake metadata, then run a generic owner-domain search. Do not assume it from the lake name. |
| Direct SCDNR description and regulation URL for every SC lake | `discover.js` lines 558–565 | URLs are templated, not a huge per-lake table, but they are still guaranteed direct fetches even when search works. | Search `site:dnr.sc.gov/lakes` first. Use the template only as a documented fallback if a search finds no official lake page. |
| State fishing-news page as a priority-1 source for every run | `discover.js` around 647–658 | It is a broad state page, not lake-specific evidence. It can consume a source slot while offering no facts about the selected lake. | Search for lake-specific current reports; retain the state landing page only as a no-results fallback. |
| Owner/drawdown landing pages and per-lake Duke CRA URLs | `drawdown.js`, `discover.js` around 634–645 | The per-lake PDF list and name list hardcode 11 documents plus an owner decision. Some may genuinely be hard to find, but that must be demonstrated, not assumed. | First search `"lake name" site:owner-domain drawdown OR agreement`. Keep an exception only for documents search cannot surface. The existing R2 exception rule does **not** cover live Duke URLs. |
| Clarks Hill/Thurmond triple-name search special case | `discover.js` lines 888–910 | It is an alias issue, not a source-access issue. | Put the physical-lake alias in `keys.js`/lake catalog once and let generic query building use it. |
| `otherLakeNames` lists (two separate lists) | `discover.js` lines 26 and 279 | These are brittle false-positive filters. They will miss newly supported lakes and need continual additions. | Require exact lake phrase or a catalog alias in title/snippet; use state/location scoring instead of a negative list. |

### C. Conditional exception: retain only after proof is captured

The following are not automatically “bad”; they need a short machine-readable reason next to the exception before being permitted as priority-1 seeds:

- Per-lake Duke CRA PDF links.
- Any owner-specific operations URL.
- A non-R2 agency page that blocks every supported fetch provider.
- A page whose public search result is consistently absent but whose exact URL is known and remains authoritative.

Required exception fields should be: `url`, `reasonSearchFails`, `checkedAt`, `fallbackSearchQuery`, `agentTags`, and `reviewAfter`. If those facts are absent, it should be discovered through normal search.

This is a policy inside `discover.js`, not a new module.

---

## 4. Hard-coded code volume found

The core issue is concentrated, not spread throughout the repository.

| Location | Current hard-coded material | Finding |
|---|---:|---|
| `discover.js` | 16 Grokipedia slug entries | Remove as automatic routing; generic Grokipedia search remains. |
| `discover.js` | 25 system-alias entries | Convert from default behavior to evidence-backed exceptions. |
| `discover.js` | 14 owner-domain entries | Duplicates owner logic in `drawdown.js`; eliminate the map-driven discovery path. |
| `discover.js` | 19 TWRA map entries for 10 actual R2 documents | Allowed R2 data but 9 entries are spelling aliases; normalize names instead. |
| `discover.js` | 31 GADNR R2 entries | Allowed R2 data; retain until an R2 manifest replaces it. |
| `drawdown.js` | 11 Duke PDFs plus lake-name ownership lists | Not automatically allowed; search-first or documented exception required. |
| `deterministic.js` | Wateree-specific document selection and regex corrections | High-risk edge-case patching disguised as generic deterministic processing. Remove/generalize. |
| `deterministic.js`, `storage.js`, `keys.js` | Repeated legacy profile-key maps | One canonical ID registry already exists in `keys.js`; duplicate copies are unnecessary. |
| `discover.js`, `dataset.js` | Same bad-NEPIS IDs | Keep the guard once, in `dataset.js`. |

---

## 5. The root cause behind the seed growth

### Problem 1: guaranteed seeds bypass the budget

In the browser engine, source caps are intended to limit work (for example, eight identity sources). But `priority: 1` guaranteed seeds are always included, then discovered sources are added afterward. A growing number of exceptions therefore defeats the cap.

**Fix within existing modules:** Make “guaranteed” mean only **approved exceptions**. All normal sources—official state sites included—enter the scored search results and obey the same cap.

### Problem 2: information used to improve search is encoded as code

Lake aliases, owner domains, special names, and operator assumptions are embedded in `discover.js`. That makes every new lake a code change and makes incorrect assumptions permanent.

**Fix within existing modules:**

- Use `LAKE_DB`/the existing lake catalog for display name, state, and any already-authoritative aliases.
- Use source facts to resolve owner, then issue one generic owner query.
- Keep a very small, reviewable exception list only for search failures.
- Do not invent a new module or a new database for this. The existing lake catalog and `keys.js` are the correct homes for identity aliases; `discover.js` is the correct home for the exception policy.

### Problem 3: edge-case patches are allowed to overwrite generic results

`deterministic.js` searches saved documents for specific EPA, SCDNR, and Angler’s Headquarters wording, including comments explicitly about correcting a Lake Wateree depth/clarity result. It is not deterministic for arbitrary lakes; it is a personalized correction path.

**Fix within existing modules:** remove the Lake Wateree-specific correction block. If a generic unit conversion or table interpretation is valid, implement it generically in `extract.js` or `facts-util.js`; otherwise leave the field null with evidence rather than embedding a one-lake answer.

---

## 6. Browser/Worker duplication

### Confirmed duplicate orchestration

| Live browser path | Worker duplicate | Finding |
|---|---|---|
| `runAgent()` in `lake-research-engine.js`: discover → cache/shared check → proxy download → browser PDF extraction → save normalized docs → extract facts → de-dupe → LLM | `handleResearchAgentPipeline()` in `agents.js` performs a server-side end-to-end agent pipeline | The browser code explicitly says it replaced the Worker pipeline because a long Worker request exceeded CPU limits. The browser does **not** call `/research/agent`; it calls the smaller endpoints and `/research/agent-llm`. |

**Recommendation:** do not replace the live browser flow with the Worker route. It would reintroduce the Worker CPU/PDF issue. Instead, after checking Worker request logs for external/manual users of `/research/agent`, remove the unused route and `handleResearchAgentPipeline` from the existing `agents.js` module. This is deletion, not a module split.

### Duplication that should remain

Some safeguards occur both before and after a network call:

- Browser normalization protects UI and saved-profile assembly.
- Worker sanitization protects the API and all callers, including non-browser callers.

That is appropriate boundary validation, not wasteful duplication. The audit does **not** recommend removing Worker-side validation or browser-side type safety.

### Duplication worth consolidating without splitting files

1. **Field lists/caps:** browser `AGENT_DEFINITIONS`, browser validation field lists, and Worker agent expectations are separately maintained. Use one field catalog constant in the existing browser engine for browser-only lists, and keep the Worker schema authoritative for the API. Do not make two orchestration paths.
2. **R2 regulations configuration:** `clients.js` and `discover.js` repeat the R2 base and state digest choices. Keep the configuration in `clients.js`; `discover.js` should call/use it rather than recreate it.
3. **Lake identity aliases:** retain `RESEARCH_CANONICAL_IDS` in `keys.js` and delete the legacy copies elsewhere.
4. **NEPIS bad-document list:** retain it in `dataset.js` and import it into discovery.

---

## 7. Recommended implementation order (no new modules)

### Phase 1 — safe deletions/consolidations

1. Delete the unused Worker end-to-end agent pipeline and `/research/agent` route **only after access-log confirmation that no external caller uses it**.
2. Delete duplicate legacy profile-key maps from `storage.js` and `deterministic.js`; use `researchStorageId()` everywhere.
3. Delete the duplicate `KNOWN_BAD_NEPIS_IDS` declaration in `discover.js`.
4. Collapse TWRA spelling aliases to normalized names, preserving every R2 document.
5. Remove the Lake Wateree-only cached-document correction logic; retain only generic, source-agnostic conversions/parsing.

### Phase 2 — change the default discovery policy

1. Treat all non-exception sources as search results, including standard official agency pages.
2. Run exact lake-name + state/official-domain queries first.
3. Add Grokipedia/Wikipedia search/citation discovery as currently allowed.
4. Only if those searches produce no usable source may a documented exception be injected.
5. Enforce the existing per-agent cap over **all** sources; an approved exception can take a slot but must not make the cap unbounded.

### Phase 3 — review and shrink special maps

1. Remove the Grokipedia slug map and per-lake companion pages unless an actual search-failure record justifies one.
2. Remove `queryLakeOverrides`, `LAKE_SYSTEM_ALIASES`, and `LAKE_OWNER_DOMAINS` from default discovery.
3. Test each removed map entry by recording the exact search query, results, and selected official source for a representative lake.
4. Keep only live, documented exceptions. R2 remains allowed without this search-failure proof.

### Required acceptance checks

- A normal SC/NC/GA/TN lake obtains sources from search without a lake-specific live URL in code.
- A TN and GA lake still gets its approved R2 static source.
- Grokipedia and Wikipedia citation following continue to work.
- Cross-border lake profiles still resolve to a single R2 profile.
- A missing/blocked source results in an evidence-backed null, not an invented value or a new hard-coded URL.
- No profile merge overwrites an already verified field.

---

## 8. Risks and decisions that need product-owner confirmation

1. **How strict should “search failure” be?** This audit recommends a reproducible failure record (query + date + provider result) before retaining a live non-R2 seed. Without that rule, temporary provider failures will quickly recreate the seed tables.
2. **Should direct predictable official templates (for example SCDNR’s `/lakes/{slug}/description.html`) be treated as search-first fallback or as an allowed permanent adapter?** The audit classifies them as search-first fallback because they are searchable; a decision to retain them permanently would be a deliberate exception to the stated rule.
3. **Can `/research/agent` be retired?** The frontend does not call it, but a Worker route can have manual or external callers. Check production request logs before removal.
4. **Are the uploaded R2 source manifests complete and maintained?** R2 is allowed, but missing R2 documents should fail visibly rather than silently falling back to a hard-coded live source.

---

## 9. Verification performed

- Read the prior audits (`REFACTOR_AUDIT.md`, `REFACTOR_STATUS_UPDATE.md`, and `audit_report.md`) and audited the current files rather than relying on their historical line counts.
- Confirmed current research module sizes: Worker research modules total 8,902 lines; browser research engine is 2,214 lines; UI is 1,666 lines.
- Confirmed the browser uses the small research endpoints and `/research/agent-llm`, not `/research/agent`.
- Confirmed the Worker still routes `/research/agent`.
- `npm test` could not start because local dependencies are absent (`vitest: not found`). No dependency installation or application-code changes were made as part of this audit.

---

## Bottom line

Keep the modules as they are. Do not add another “seed manager,” “research v2,” or server orchestration module.

Reduce the code by deleting the dead Worker orchestration path and duplicate registries, then make discovery genuinely search-first. R2, Grokipedia, Wikipedia, and documented no-search exceptions remain available, but they become narrow exceptions instead of the default path for each lake.
