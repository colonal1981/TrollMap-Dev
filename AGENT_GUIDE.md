# AGENT_GUIDE — Where to look (for AI and human)

This is the map you asked for. 44 files → 6 places that actually matter.

## 1. Single sources (fix once, not 4x)

| If you need to fix | Open this ONE file | Was duplicated in |
|---|---|---|
| Lake → R2 key (contours, supplemental) | `js/data/lake-keys.js` 101 entries | `supplemental-layers.js` had duplicate resolver, `Worker/research/limnology.js` had 74-entry copy |
| Lake → internal LAKES key (wateree, murray) | `Worker/worker-data.js` `lakeKeyFromName()` | `species-intel.js` `resolveLakeKey`, `research/keys.js` `sanitizeLakeId` — different purpose, keep separate |
| Distance/bearing math | `js/utils/geo.js` | 7 copies in `smart-plan.js`, `notifications.js`, `smart-plan-context.js`, `supplemental-layers.js`, `lake-research-engine.js` — now all import from geo.js |
| Ramps/paddle/bank-pier/attractors fetch | `Worker/core/arcgis.js` | `trollmap-worker.js` had 4 copy-paste blocks (23845 chars → 11398), GA FID bug fixed once here |
| Worker fetch with credits | `Worker/research/download.js` + `clients.js` | TinyFish primary, Scrape.do secondary, Jina tertiary, Tavily/Firecrawl backup with budget guard |

## 2. TN lakes + R2 regs (you have these locally)

- You have 10 HTML files locally: Boone, Cherokee, Chilhowee, Douglas, Fort Loudoun, Melton Hill, Norris, South Holston, Tellico, Watauga — example: https://www.tn.gov/.../watauga-reservoir.html
- Previously `TWRA_LAKE_PAGES` had 3 entries. Now 10 + 9 aliases in `Worker/research/discover.js:545`
- You have all regs that matter in R2: `https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/regulations`
  - `clients.js` `STATE_REGULATIONS_CONFIG` already uses R2 digests (sc/nc/ga/tn 2025_2026.pdf)
  - `discover.js` now seeds R2 digest as priority 1, live agency page as priority 2 fallback

## 3. Research pipeline (900 lines → could be 200)

Current `Worker/research/discover.js` is 890 lines because of 5 hardcoded maps:
- `GROKIPEDIA_SLUGS` 30, `LAKE_SYSTEM_ALIASES` 20, `LAKE_OWNER_DOMAINS` 20, `AGENT_DISCOVERY_QUERIES` 40 queries, `offLakePattern` 30 regexes

Better way you suggested: search Grokipedia/Wikipedia and follow sources:

```js
// 1. Deterministic pattern (0 credits, no search)
`https://www.dnr.sc.gov/lakes/${slug}/description.html`

// 2. Grokipedia + Wikipedia discovery (2 TinyFish searches, free)
site:grokipedia.com "Lake X"
site:wikipedia.org "Lake X lake"

// 3. Follow citations from both (2 TinyFish fetches, free) → USACE, EPA, Duke, SCDNR

// 4. 3 generic searches instead of 40
"${lake}" fishing report
"${lake}" water quality filetype:pdf
"${lake}" fisheries survey site:${stateFishDomain}
```

Keep `researchdocs/` golden fixtures for tests. Delete the 5 hardcoded maps.

## 4. Credit policy (you are low on Tavily/Firecrawl)

In `Worker/research/clients.js`:
- `FIRECRAWL_HARD_STOP = 50` → KV `firecrawl:credits_remaining`, never go below 50
- `checkFirecrawlBudget()` + `recordFirecrawlUsage()` — logs remaining
- Same pattern should exist for Tavily/Scrape.do, reset on 1st of month via KV PUT

Current ladder in `download.js` (after fix):
```
TinyFish primary (free, ttl 86400) — even for NEPIS now
→ Scrape.do secondary (1 credit/page, failed=0)
→ Firecrawl backup with budget guard (only if allowed)
→ Jina Reader tertiary (free 10M)
→ basic fetch
```
Search ladder in `discover.js`:
```
TinyFish search primary (free)
→ Tavily backup if <3 results (if key)
→ Firecrawl last resort if budget allowed
```
And in `deterministic.js` SC regs: was Tavily extract (1 credit/5 URLs) primary, now TinyFish primary, Tavily backup.

To reset at new month:
```
wrangler kv:key put --binding=KV firecrawl:credits_remaining 269
wrangler kv:key put --binding=KV tavily:credits_remaining 1000
wrangler kv:key put --binding=KV scrapedo:credits_remaining 1000
```

## 5. What was deleted vs actually shrank

- Deleted: `wateree_zones_overlay.geojson` 5.8MB (pure bloat)
- Deleted: `/audit-plan` route (superseded by `/coach-plan`)
- Combined: lake-keys 3→1, geo 7→1, ArcGIS 4→1 — real shrink: worker 2054→1783 lines (-13%), bundle 517→508KB (-1.5%)
- Added: `core/arcgis.js` 233 lines (real combining), `test/` 79 tests (safety net so AI doesn't break Wateree fixes), expanded `geo.js` +100 lines
- Net JS: 37295→37747 (+1.2%) — more files, but duplicated logic down

## 6. How to use AI now

Don't give AI 14 files. Give it this guide + one task:

> "TWRA pages only has 3 lakes, I have 10 HTML files locally, expand it, and use R2 regs as primary"

Agent does:
```
grep -R "TWRA_LAKE_PAGES" → discover.js:545
read AGENT_GUIDE.md → knows R2 regs in clients.js
edits discover.js (10 + aliases) + adds R2_REGS_MAP
runs npm test (79 tests) → 79 passed
```

If you want monolith back: cat `Worker/research/*.js` → one 8k file, but keep `lake-keys.js`, `geo.js`, `core/arcgis.js` as single sources. I can do that in one commit.

## 7. Smoke checklist (run after every phase)

From REFACTOR_AUDIT.md §7 — still valid. Key: `GET /ramps?state=SC`, `GET /paddle`, `GET /lake?lake=wateree`, research happy path on dev lake id, `npm test`.
