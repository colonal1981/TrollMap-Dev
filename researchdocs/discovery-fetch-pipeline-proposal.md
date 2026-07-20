# TrollMap Research Discovery and Fetch Pipeline Proposal

**Date:** 2026-07-20  
**Status:** Search and fetch experiments completed; two PDF-handling changes implemented locally; shared R2 corpus and final query changes are proposed but not yet implemented.

## 1. Goals

1. Keep discovery lake-agnostic: every template accepts a canonical lake name/slug and optional metadata-driven aliases.
2. Find authoritative, lake-specific evidence without requiring every desired term in one restrictive query.
3. Fetch and normalize a canonical source only once, even if it supports multiple lakes or research categories.
4. Store reusable national, state, basin, system, and multi-lake documents in a shared R2 corpus.
5. Use free/cached acquisition paths first and spend Scrape.do or Firecrawl credits only when necessary.
6. Scope extracted facts to the relevant document section so a statewide report cannot leak another lake's facts into the target profile.

## 2. Findings from the experiments

### Search findings

- Short, focused searches substantially outperform long lists of required terms.
- Queries requiring `electrofishing gill net hydroacoustic recruitment` frequently returned zero results.
- One method per search works well, e.g. `"Lake Norman" electrofishing site:ncwildlife.gov`.
- `ncwildlife.gov` is the current NCWRC domain; legacy `ncwildlife.org` results may still appear.
- State-specific publication patterns can be extremely effective. For SC, `"{lake}" "Fisheries Investigations in Lakes and Streams" site:dnr.sc.gov/fish/fwfi` returned highly relevant annual reports.
- Owner/operator-aware discovery is required. USACE was productive for Lake Lanier, while TVA is relevant to Chickamauga.
- Canonical and system aliases improve coverage, e.g. `Lake Norman` plus `Catawba-Wateree` and `Lake Marion` plus `Santee-Cooper`.
- Search snippets often mention the target only in a citation. Results whose title names another lake must be rejected or heavily down-ranked.
- Limnology queries using dissolved oxygen and monitoring terminology performed consistently well.
- Vegetation and navigation need separate focused searches.
- TinyFish social exclusions work as documented when sent as plain operators: `-site:facebook.com`, etc.
- TinyFish `domain_type` and `purpose` are API parameters, not text operators. The production wrapper already supports both, even if the playground does not expose controls for them.

### Fetch findings

A mixed TinyFish batch successfully extracted 7 of 10 sources:

- NCWRC `/open` PDF route
- NCWRC `download?attachment` route
- NCWRC opaque `/media/{id}/download?attachment` routes
- NCDEQ multi-lake PDF
- UGA dissertation with a redirected final URL
- LNMC HTML navigation page

TinyFish returned `target_unreachable` for:

- Two NRC PDFs
- One USACE PDF

Scrape.do successfully retrieved the USACE source as binary PDF for one credit. TinyFish and Scrape.do could not retrieve the tested NRC sources, while Firecrawl could. Direct Cloudflare Worker/browser fetch returned 403 for both NRC PDFs.

One TinyFish fetch title was incorrect: NCWRC media 3125 was labeled as a Lake James report, while the first page correctly identified it as the **Lake Rhodhiss Largemouth Bass Survey (2005–2007)**. Provider titles therefore cannot be treated as authoritative.

## 3. Lake and authority inputs

Every query builder should accept:

```json
{
  "lakeName": "Lake Norman",
  "lakeSlug": "lake-norman",
  "state": "NC",
  "aliases": ["Catawba-Wateree", "Catawba-Wateree Project"],
  "owner": "Duke Energy",
  "ownerDomains": ["duke-energy.com"],
  "stateAgencyDomains": ["ncwildlife.gov", "ncwildlife.org"]
}
```

Aliases must come from lake metadata, owner/project metadata, or a maintained alias registry. Queries must never depend on a Lake Marion-, Norman-, Lanier-, or Chickamauga-specific hard-coded string.

Suggested authority domains:

| State | Fisheries/environment authorities |
|---|---|
| SC | `dnr.sc.gov`, `des.sc.gov` |
| NC | `ncwildlife.gov`, legacy `ncwildlife.org`, `deq.nc.gov`, `files.nc.gov` |
| GA | `georgiawildlife.com`, `georgiawildlife.blog` |
| TN | `tn.gov/twra`, `tn.gov/environment` |
| Federal/owner | `army.mil`, `tva.com`, `nrc.gov`, `usgs.gov`, `epa.gov`, `ferc.gov` |

## 4. Proposed discovery query templates

Use `location=US` and `language=en`. Use `domain_type=web` unless specified. Add this purpose through the API where appropriate:

```text
Find authoritative, fetchable evidence about {category} for {lakeName} in {state}. Prefer government agencies, reservoir owners, universities, and original studies. Reject sources about a different lake that merely cite the target lake.
```

Do not run every optional query automatically. Start with the primary query, assess coverage, and run focused or alias queries only for gaps.

### 4.1 Identity

Primary:

```text
"{lakeName}" dam owner FERC license reservoir filetype:pdf
```

Owner-aware:

```text
"{lakeName}" reservoir project site:{ownerDomain}
```

Alias/system:

```text
"{alias}" "{lakeName}" project license reservoir filetype:pdf
```

Identity should continue using deterministic owner/project seeds before search.

### 4.2 Limnology

Primary:

```text
"{lakeName}" dissolved oxygen water quality monitoring assessment filetype:pdf
```

Focused thermocline query:

```text
"{lakeName}" thermocline hypolimnion temperature profile filetype:pdf
```

Owner/agency query:

```text
"{lakeName}" water quality monitoring site:{ownerOrEnvironmentDomain}
```

Alias/system query:

```text
"{alias}" "{lakeName}" water quality monitoring filetype:pdf
```

### 4.3 Biology

State-agency primary:

```text
"{lakeName}" fisheries survey site:{stateFishAgencyDomain}
```

Focused methods (run separately, only as needed):

```text
"{lakeName}" electrofishing site:{stateFishAgencyDomain}
```

```text
"{lakeName}" "gill net" fisheries -site:facebook.com -site:instagram.com -site:youtube.com
```

Stocking:

```text
"{lakeName}" stocking evaluation site:{stateFishAgencyDomain}
```

Forage/managed species:

```text
"{lakeName}" striped bass forage stocking assessment -site:facebook.com -site:instagram.com -site:youtube.com
```

Academic web fallback for playground-style search:

```text
"{lakeName}" {stateName} fisheries population habitat study thesis -site:facebook.com -site:instagram.com -site:youtube.com
```

University-focused fallback:

```text
"{lakeName}" fish population striped bass forage site:edu filetype:pdf
```

Production academic search should instead use:

- query: `"{lakeName}" fisheries population habitat`
- `domain_type=research_paper`
- purpose: find original data about fish populations, recruitment, habitat use, and management for the target lake.

SC publication-series query:

```text
"{lakeName}" "Fisheries Investigations in Lakes and Streams" site:dnr.sc.gov/fish/fwfi
```

This is state-specific but lake-agnostic. Equivalent publication-series terminology should be maintained per state when identified.

### 4.4 Habitat

Vegetation:

```text
"{lakeName}" aquatic vegetation hydrilla management -site:facebook.com -site:instagram.com
```

Structural enhancement:

```text
"{lakeName}" fish habitat enhancement assessment -site:facebook.com -site:instagram.com
```

General fallback:

```text
"{lakeName}" aquatic habitat fish community assessment filetype:pdf
```

Owner-aware:

```text
"{lakeName}" shoreline habitat management site:{ownerDomain}
```

### 4.5 Navigation

```text
"{lakeName}" navigation hazards channel markers -site:facebook.com -site:instagram.com -site:youtube.com
```

Optional owner/marine authority query:

```text
"{lakeName}" navigation shoal markers hazards site:{ownerOrMarineAuthorityDomain}
```

Reject generic buoy explanations and pages that name another lake in the title.

### 4.6 Regulations

Regulations should be sourced primarily from known state regulation documents/pages and parsed once into shared state data. Do not depend on lake-specific web discovery for every run.

Fallback discovery:

```text
"{lakeName}" fishing regulations exceptions site:{stateFishAgencyDomain}
```

State document discovery:

```text
inland fishing regulations digest site:{stateFishAgencyDomain}
```

Species profile pages may help identify applicable species but are not substitutes for the authoritative creel/size table.

### 4.7 Fisheries / seasonal angling

```text
"{lakeName}" seasonal fishing patterns bass crappie striped bass -site:facebook.com -site:instagram.com -site:youtube.com
```

Current report query may use a recency window:

```text
"{lakeName}" fishing report
```

Recommended API options for current reports:

- `domain_type=web` or `news`
- `recency_minutes` appropriate to the desired freshness
- preserve report date and publisher

Official fisheries management reports discovered by this category should be added to the shared document library and made available to biology rather than fetched again.

### 4.8 Summary

Summary must not perform discovery or fetch. It consumes category outputs, deterministic facts, shared document references, and citations.

## 5. Query execution rules

1. Never combine all desired technical methods into one mandatory query.
2. Run at most one primary and one gap-focused query per category initially.
3. Canonicalize and deduplicate URLs across all selected categories before fetching.
4. Preserve search title, snippet, position, score, category requests, canonical lake, and aliases.
5. Reject social domains for evidence acquisition unless explicitly enabled.
6. Down-rank a result when its title names another lake.
7. A snippet-only target mention is not enough when the title clearly identifies another waterbody.
8. Give authority bonuses to state/federal agencies, reservoir owners, universities, and recognized fisheries organizations.
9. Use `purpose` through the TinyFish API; do not insert it into the query string.
10. Use `domain_type=research_paper` as an API parameter for academic biology queries.

Suggested pre-fetch scoring:

- +5 canonical lake in title
- +4 canonical lake in snippet
- +4 known alias in title
- +3 known alias in snippet
- +3 authoritative state/federal/owner domain
- +2 report/assessment/survey/management-plan terminology
- +1 PDF or recognized downloadable document route
- -6 another lake in title
- -5 another state in title/context
- -5 social/inaccessible source

Only fetch candidates above a configured threshold, except guaranteed seeds.

## 6. Shared R2 document architecture (proposed, not implemented)

### Core invariant

> A canonical source is fetched and normalized no more than once, regardless of how many lakes or categories use it.

Suggested keys:

```text
research/shared/document-registry.json
research/shared/documents/{documentId}.json
research/shared/manifests/US-{category}.json
research/shared/manifests/{state}-{category}.json
research/shared/manifests/{state}-{systemSlug}-{category}.json
```

Shared document example:

```json
{
  "id": "scdnr-2015-annual-report",
  "requestedUrl": "https://example/report.pdf",
  "finalUrl": "https://example/download/report.pdf?version=1",
  "canonicalUrl": "https://example/report.pdf",
  "contentHash": "sha256:...",
  "providerTitle": "Provider supplied title",
  "title": "Validated first-page title",
  "titleSource": "document_first_page",
  "authority": "SCDNR",
  "scope": "statewide",
  "state": "SC",
  "fetchProvider": "tinyfish",
  "fetchedAt": "2026-07-20T00:00:00Z",
  "lastCheckedAt": "2026-07-20T00:00:00Z",
  "etag": null,
  "lastModified": null,
  "sections": []
}
```

Section example:

```json
{
  "id": "hydroacoustic-santee-cooper",
  "heading": "Hydroacoustic Evaluation of Santee-Cooper Lakes",
  "pages": [1, 5],
  "lakeSlugs": ["lake-marion", "lake-moultrie"],
  "aliases": ["Santee-Cooper Lakes"],
  "categories": ["biology", "limnology", "fisheries"],
  "topics": ["forage", "hydroacoustics", "gill-net sampling", "recruitment"],
  "text": "..."
}
```

A lake/category package stores references, not another physical copy:

```json
{
  "sharedDocumentRefs": [
    {
      "documentId": "scdnr-2015-annual-report",
      "sectionIds": ["hydroacoustic-santee-cooper"],
      "usedBy": ["biology", "limnology", "fisheries"]
    }
  ]
}
```

### Cross-category orchestration

```text
Discover for selected categories
  -> combine candidates
  -> canonicalize URLs
  -> merge requestedBy/category tags
  -> check shared R2 registry
  -> fetch each missing URL once
  -> normalize and segment once
  -> route relevant sections to each category
```

### Freshness

Track separately:

- `fetchedAt`: when normalized content was acquired
- `lastCheckedAt`: when freshness was last checked
- `lastModified`: origin-provided modification timestamp
- `etag`: origin/provider validator
- `contentHash`: normalized-content identity

TinyFish supports `ttl`, `if_none_match`, `if_modified_since`, and `include_etag_and_last_modified`. Firecrawl supports cache reuse through `maxAge`. Scrape.do currently returns text/binary through TrollMap without preserved freshness metadata, so R2 TTL and content hashes must govern it.

Historical annual reports and completed papers should generally be treated as immutable. Regulations, operations pages, and fishing reports need shorter category-specific TTLs.

## 7. Proposed provider-independent fetch sequence

### PDFs

```text
Shared R2 cache
  -> TinyFish Fetch
  -> direct Worker fetch
  -> PDF.js for returned binary
  -> domain-aware Scrape.do fallback
  -> domain-aware Firecrawl fallback
  -> unresolved/manual mirror search
```

Observed domain routing:

| Domain/source | Result and preferred route |
|---|---|
| `ncwildlife.gov` | TinyFish succeeded, including `/open` and `?attachment` |
| `files.nc.gov` | TinyFish succeeded |
| `openscholar.uga.edu` | TinyFish succeeded after redirect |
| `lnmc.org` | TinyFish HTML succeeded |
| USACE tested PDF | TinyFish failed; Scrape.do returned binary PDF |
| NRC tested PDFs | TinyFish failed; direct Worker returned 403; Scrape.do failed; Firecrawl succeeded |

NRC should therefore use a narrowly scoped Firecrawl fallback only after shared cache, TinyFish, and direct fetch fail. This domain-specific rule prevents arbitrary PDF failures from silently spending Firecrawl credits.

### HTML

```text
Shared R2 cache
  -> TinyFish
  -> Scrape.do
  -> Firecrawl if budget permits
  -> Jina
  -> direct fetch
```

Special handlers remain appropriate for NEPIS, eRegulations, and other known SPA/two-step sources.

### Binary response handling

If a provider returns `application/pdf`, preserve the bytes and extract with PDF.js. If TinyFish or Firecrawl returns `text/plain`/Markdown for a PDF URL, consume it as normalized text and do not send it to PDF.js.

### Title validation

Resolve titles in this order:

1. first-page document title
2. relevant search-result title
3. provider/HTML title
4. filename fallback

Preserve `providerTitle` for auditing when it differs.

## 8. Proposed reusable fetch test corpus

The following mixed batch was tested through TinyFish:

```text
https://www.ncwildlife.gov/lake-norman-lmb-stocking-evaluation-final-1pdf/open
https://www.ncwildlife.gov/fishing/lkn-bb-final-report-2026/download?attachment
https://www.ncwildlife.gov/media/2984/download?attachment
https://www.ncwildlife.gov/media/3125/download?attachment
https://www.nrc.gov/docs/ML1504/ML15042A121.pdf
https://files.nc.gov/ncdeq/Water%20Quality/Environmental%20Sciences/Reports/CatawbaLakes2017.pdf
https://www.sam.usace.army.mil/Portals/46/docs/planning_environmental/docs/EIS/section-3.pdf
https://openscholar.uga.edu/record/7366/files/zeng_xiao-qing_200112_phd.pdf
https://www.nrc.gov/docs/ML2009/ML20090F579.pdf
https://lnmc.org/navigation/
```

Seven succeeded. NRC and USACE behavior is documented above.

## 9. Code changes already made on this branch

### 9.1 `Worker/worker-research.js`

Implemented:

- Expanded TinyFish Fetch from ordinary HTML-only sources to ordinary HTML **and PDF** sources.
- PDF TinyFish requests omit HTML include/exclude selectors.
- Successful TinyFish PDF extraction is returned as normalized `text/plain` with `X-Source: tinyfish`.
- Scrape.do, generic Firecrawl, and Jina fallbacks in this block are now HTML-only.
- If TinyFish PDF extraction is insufficient, the existing direct binary fetch remains the PDF fallback.
- This prevents a failed PDF from automatically consuming Scrape.do or generic Firecrawl credits.

Not yet implemented:

- NRC-specific Firecrawl PDF fallback.
- USACE-specific Scrape.do PDF fallback.
- Shared R2 document registry/manifests.
- Batched cross-agent fetching.
- ETag/Last-Modified persistence.
- Final query-template replacement.
- Snippet-based pre-fetch scoring.
- First-page title correction/indexing.

### 9.2 `js/modules/lake-research-engine.js`

Implemented:

- Fixed binary PDF corruption in the client-side agent runner.
- The previous code used `proxyRes.text()` for every source, including binary PDFs.
- The runner now examines `Content-Type`.
- Actual `application/pdf` responses are read with `arrayBuffer()` and passed to the existing PDF.js extractor.
- TinyFish-extracted `text/plain` from a PDF URL remains text and is not incorrectly passed to PDF.js.
- Fetch logs identify PDF.js processing.

## 10. Recommended implementation order

1. Replace final discovery templates with the focused, state/authority-aware templates above.
2. Preserve TinyFish search snippets and metadata in source candidates.
3. Add pre-fetch relevance scoring and wrong-lake rejection.
4. Add global canonical URL normalization and per-run cross-category deduplication.
5. Implement shared R2 document registry and document objects.
6. Segment shared documents by heading/page and index lake aliases/categories/topics.
7. Route only relevant sections to each agent.
8. Add provider freshness metadata and content hashes.
9. Add domain-aware USACE Scrape.do and NRC Firecrawl fallbacks with budget guards.
10. Test cross-category single-fetch behavior, cross-lake reuse, wrong-lake section isolation, and unchanged-document refresh.

## 11. Acceptance criteria

- A URL requested by three categories is fetched once.
- A statewide report used by three lakes has one physical shared R2 document.
- A Lake Marion run cannot accept a Lake Hartwell section from the same annual report.
- Search results naming another lake in the title are rejected unless explicitly classified as a multi-lake/system report.
- TinyFish failure for one URL does not discard successful batch results.
- Binary PDFs are never stored as raw text.
- Provider titles are validated against document content.
- NRC Firecrawl usage and USACE Scrape.do usage occur only after free/cache paths fail.
- Summary performs no discovery or fetch.
- Historical immutable documents are not repeatedly fetched.

## 12. Implementation clarifications and decisions

This section resolves details that were intentionally left at an architectural level in the first draft. These decisions should be treated as the implementation contract.

### 12.1 Phased implementation decision

Do **not** implement the shared R2 registry, shared segmentation, or shared-section routing in the first implementation phase.

The first phase should include only:

1. Replace the discovery query templates.
2. Preserve TinyFish title, snippet, position, score, site name, date, and final URL where available.
3. Add pre-fetch relevance scoring and conservative wrong-lake rejection.
4. Add canonical URL normalization and cross-category/per-run URL deduplication.
5. Add the domain-aware USACE Scrape.do and NRC Firecrawl fallbacks with existing credit guards.
6. Persist TinyFish ETag/Last-Modified fields where the current lake-level normalized-document format can safely carry them.
7. Keep all current lake-package storage behavior intact.

This delivers the low-risk discovery/fetch improvements without introducing a cross-lake dependency. The shared registry is Phase 2 and must use the segmentation, canonicalization, and rollback rules below.

### 12.2 Segmentation approach for the shared corpus

A mandatory LLM segmentation pass is **not** approved. It would add cost, nondeterminism, and another way to misclassify lake scope. Phase 2 segmentation should be deterministic first, with optional LLM assistance only for an explicitly queued ambiguous document.

#### Segmentation inputs

Preserve structural information during acquisition whenever possible:

- PDF.js output: retain `--- PAGE n ---` markers and page records.
- TinyFish/Firecrawl Markdown: retain headings, horizontal rules, tables, and page markers if supplied.
- HTML: retain heading hierarchy and main-content boundaries.
- Provider title and first-page title remain separate metadata.

#### Deterministic split order

1. Split on explicit PDF page markers while retaining page numbers.
2. Detect document-level section headings using Markdown headings and conservative plain-text heading rules:
   - short line, generally under 140 characters;
   - surrounded by blank lines;
   - title case or mostly uppercase;
   - recognized prefixes such as `Study Title`, `Job Title`, `Chapter`, `Section`, `Appendix`, `Summary`, or numbered headings.
3. Keep heading and subordinate paragraphs/tables together.
4. If a section exceeds 12,000 characters, split it into chunks at paragraph boundaries with an 800-character overlap.
5. If no reliable headings exist, use page groups up to 12,000 characters rather than inventing semantic sections.
6. Never split a table row-by-row unless required by the existing table parser; preserve the heading and table caption in every resulting table chunk.

Store both levels:

```json
{
  "sectionId": "stable-document-local-id",
  "heading": "Hydroacoustic Evaluation of Santee-Cooper Lakes",
  "startPage": 1,
  "endPage": 5,
  "chunks": [
    { "chunkId": "...-01", "text": "...", "overlapBefore": 0 },
    { "chunkId": "...-02", "text": "...", "overlapBefore": 800 }
  ]
}
```

#### Deterministic lake tagging

Build tags from the TrollMap lake catalog and alias registry, not from an LLM:

1. Normalize text and match complete canonical lake names and approved aliases using token boundaries.
2. Match names in the heading, first 1,500 section characters, captions, and repeated body references.
3. Give heading matches the highest confidence.
4. Associate a system/basin alias with its member lakes only when that membership is explicitly present in maintained metadata.
5. Do not infer that every lake in the same river basin applies to every basin-level section.
6. Store match evidence:

```json
{
  "lakeSlug": "lake-marion",
  "matchedText": "Lakes Marion and Moultrie",
  "matchLocation": "heading",
  "confidence": 1.0
}
```

#### Deterministic category/topic tagging

Use transparent keyword/rule maps for candidate routing, not final fact creation. One section may have multiple category tags. Examples:

- biology: stocking, recruitment, population, electrofishing, gill net, species abundance;
- limnology: dissolved oxygen, temperature profile, thermocline, nutrient, chlorophyll, Secchi;
- habitat: vegetation, hydrilla, substrate, woody debris, fish attractor, shoreline habitat;
- navigation: shoal, hazard, channel marker, stump, navigation;
- regulations: creel, size limit, possession, closed season;
- fisheries: angler, seasonal pattern, catch rate, fishing mortality, creel survey;
- identity: owner, dam, impoundment, license, project number.

These tags select candidate sections for an agent. They do not authorize a fact by themselves.

#### Wrong-lake isolation at extraction time

Section tagging alone is not the final safety boundary. Before a fact is accepted:

1. Its citation/evidence window must contain the canonical lake, an approved alias, or an inherited unambiguous section heading.
2. If the evidence window names a different lake and not the target, reject the fact.
3. If it names the target and another lake, mark it `multiLake=true`; accept only facts explicitly stated for the target or shared system.
4. Statewide rules/facts may be inherited only from sections tagged `scope=statewide` and from categories that permit statewide inheritance (for example regulations). Numerical biological observations must not be inherited statewide.
5. Every extracted fact stores `documentId`, `sectionId`, `chunkId`, page range, and exact evidence excerpt.

#### Optional ambiguous-document queue

If deterministic segmentation/tagging produces no reliable sections or conflicting lake tags, mark the document `indexStatus=ambiguous`. Do not expose it to agents by default. A later maintenance task may use one bounded LLM indexing pass that returns only section boundaries and tags, followed by deterministic validation against the lake/alias catalog. This is optional and is not part of normal lake research.

### 12.3 Freshness and fingerprint decision

Do not compute a full normalized-text SHA-256 in the Worker request path.

Use this precedence:

1. Origin/provider ETag.
2. Origin/provider Last-Modified.
3. Immutable-document policy for historical PDFs/papers.
4. Source-type TTL.
5. Lightweight normalized-content fingerprint only when validators are unavailable and content is refreshed.

The lightweight fingerprint should include more than the first 1,000 characters to avoid collisions between annual reports with similar covers. Compute it over a bounded signature:

```text
normalized canonical title
+ normalized text length
+ first 4096 characters
+ middle 4096 characters
+ last 4096 characters
```

Hash that bounded signature with a fast non-cryptographic 32/64-bit function or Web Crypto SHA-256. Because the input is capped near 12 KB, Worker CPU cost is bounded. Store it as `contentFingerprint`, not `contentHash`, so it is not misrepresented as a full-content cryptographic identity.

A full-file/full-text cryptographic hash may be generated by an offline maintenance tool but is not required for request-time deduplication or freshness.

### 12.4 Canonical URL normalization rules

Canonicalization must preserve a lossless audit trail:

```json
{
  "requestedUrl": "...",
  "finalUrl": "...",
  "canonicalUrl": "...",
  "urlAliases": ["..."]
}
```

Never overwrite the original requested or final URL.

#### Generic normalization

1. Parse with the URL API; reject non-HTTP(S) URLs.
2. Lowercase scheme and hostname.
3. Remove default ports (`:80` for HTTP, `:443` for HTTPS).
4. Remove fragments.
5. Collapse duplicate path slashes.
6. Normalize percent-encoding only for unreserved characters; do not decode encoded path separators.
7. Remove a trailing slash except for the origin root.
8. Sort retained query parameters by key and value.
9. Remove known tracking parameters:
   - `utm_*`, `fbclid`, `gclid`, `msclkid`, `srsltid`;
   - analytics/referral-only parameters confirmed not to select content.
10. Do **not** remove all query parameters generically.

#### Parameter classes

Store stripped revision/download parameters as version metadata when present:

- `rev`, `ver`, `version`;
- `attachment`, `download` when they only toggle disposition;
- UGA `withWatermark`, `withMetadata`, `registerDownload`.

Retain functional identity parameters unless a domain adapter proves they are disposable:

- NEPIS `Dockey`, `File`, `ZyAction`, and document identifiers;
- repository record/item IDs;
- parameters such as `sequence` when they may select a different file/version.

#### Domain adapters

- **NCWRC:** preserve the `/open`, `/download`, or `/media/{id}` path initially. After a redirect/fetch, register both requested and final normalized URLs as aliases of the same document ID. Do not assume two different NCWRC paths are identical until redirect metadata or fingerprint confirms it.
- **Duke PDFs:** strip `rev` from the identity key but retain its value as `sourceRevision`. A changed revision triggers freshness review, not a second permanent identity.
- **USACE:** strip cache/version query parameters such as `ver` from identity but retain them as source revision metadata.
- **UGA:** canonicalize the stable `/record/{id}/files/{filename}` requested URL when available; register the `/nanna/` final download URL as an alias and strip download-presentation flags.
- **NRC:** normalize hostname/path case conservatively and retain the accession path; do not rewrite accession IDs.
- **NEPIS:** use the existing NEPIS document/file identifier logic. Do not apply ordinary PDF query stripping.

#### Deduplication key and collision resolution

Use a hash of the short canonical URL string as the registry lookup key, with the canonical URL stored in the record for collision verification. On fetch/redirect, merge records only when one of these is true:

1. normalized requested/final URLs intersect;
2. a domain adapter identifies the same stable document ID;
3. validators and bounded fingerprint match;
4. an explicit reviewed alias relation exists.

A similar title is never sufficient to merge documents.

### 12.5 Shared-registry isolation, rollback, and rebuild

The shared registry must be versioned and replaceable. Do not make a single mutable JSON object the sole source of truth.

Suggested layout:

```text
research/shared/generations/{generationId}/manifest.json
research/shared/generations/{generationId}/indexes/...
research/shared/documents/{documentId}/versions/{versionId}.json
research/shared/pointers/current.json
research/shared/pointers/previous.json
research/shared/quarantine/{documentId}.json
```

Rules:

1. Shared document versions are immutable after publication.
2. Build a new manifest/index generation under a new `generationId`.
3. Validate counts, references, lake slugs, section bounds, and checksums/fingerprints.
4. Publish by updating `previous.json`, then atomically replacing the small `current.json` pointer last.
5. Lake research reads one generation ID at the start and uses it for the entire run.
6. Lake packages record `sharedGenerationId` and all referenced document/section versions.
7. Rollback changes `current.json` back to the previous validated generation; no document rewrite is required.
8. A kill switch such as `SHARED_RESEARCH_ENABLED=false` must make the pipeline fall back to the current per-lake behavior.
9. Bad documents are quarantined by document/version ID and excluded in the next generation; do not destructively delete evidence.
10. Rebuild indexes deterministically from immutable shared document versions plus the lake/alias catalog. If those objects are unavailable, discard the shared generation and use per-lake acquisition.

This preserves the existing lake-package isolation as a fallback and makes shared-index corruption reversible.

### 12.6 Fishing-report recency decision

Separate current reports from evergreen seasonal-pattern research.

#### Current fishing reports

Primary query:

```text
"{lakeName}" fishing report
```

Use:

- `domain_type=web` (or `news` only for a specifically requested news pass);
- `recency_minutes=64800` (45 days);
- location `US`, language `en`.

If fewer than three relevant, fetchable results survive scoring, run one fallback query with `recency_minutes=259200` (180 days). Do not automatically run both windows.

Reject or heavily down-rank tournament result pages, social posts, generic aggregation pages, and pages whose publication date is outside the requested window even if TinyFish returns them.

#### Evergreen seasonal patterns

Query:

```text
"{lakeName}" seasonal fishing patterns bass crappie striped bass -site:facebook.com -site:instagram.com -site:youtube.com
```

Do not apply `recency_minutes`. Seasonal technique pages and agency studies may remain useful for years. Store publication/update date and apply ordinary source-quality and freshness scoring.

The two result sets serve different purposes and must not share one recency policy.

### 12.7 Domain-aware paid fallback decision

Paid fallbacks must be narrow and observable.

- **USACE PDF:** shared cache -> TinyFish -> direct Worker fetch -> Scrape.do GET -> returned binary PDF -> PDF.js. Firecrawl is not attempted unless Scrape.do also fails and the source is explicitly high-priority.
- **NRC PDF:** shared cache -> TinyFish -> direct Worker fetch -> optional Scrape.do only if policy retains it -> Firecrawl scrape. Testing established that Firecrawl succeeds where the other tested paths failed.
- Record every paid attempt with provider, canonical URL, category requests, reason, result, and estimated/actual credit count.
- Check the existing Firecrawl budget guard before every fallback.
- A failed source is cached with a short failure TTL to prevent every category from retrying it in the same run.
- Cross-category deduplication must occur before fallback selection so three agents cannot spend three credits on one URL.

### 12.8 Phase 1 acceptance criteria

Before beginning Phase 2 shared storage, Phase 1 must demonstrate:

- all selected categories merge candidates before fetching;
- one canonical URL causes at most one acquisition attempt per provider per run;
- search snippets and metadata survive into scoring/logging;
- clear wrong-lake titles are rejected;
- NCWRC attachment/open URL forms are retained and fetchable;
- USACE and NRC fallbacks follow the tested domain routes and budget guards;
- existing lake package output remains compatible;
- disabling the new scoring/deduplication path restores the existing behavior.
