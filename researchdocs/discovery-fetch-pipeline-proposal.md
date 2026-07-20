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
