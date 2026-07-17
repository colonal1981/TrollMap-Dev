# TrollMap-Dev System Audit Report
**Date:** July 17, 2026
**Focus:** Cloudflare Worker Scraping/Parsing & Front-End Module Code Bloat Analysis

---

## Executive Summary
This audit provides a detailed review of the TrollMap repository codebase, focusing on **Cloudflare Worker processing logic** (the backend) and the **front-end modules** (under `./js`). 

Our analysis reveals that:
1. **Considerable direct bloat exists in the front-end code** due to duplicated files. When the app was refactored to use modern ES modules and folders (`js/modules/` and `js/utils/`), older monolithic or pre-sync files were left in `js/data/` or `js/modules/` without being deleted. These are 100% dead files that are never imported.
2. **Brittle and overly specific parsers** in the Worker (`worker-research.js` and `worker-data.js`) rely on highly fragile regular expressions. They scrape third-party websites (SCDNR, eRegulations, and Angler's Headquarters) and try to match strings down to the character. If these third-party websites make minor updates or fix typos, our parsers will instantly break.
3. **Architectural redundancy** exists between legacy/v1 species databases and modern v2 versions, as well as naming clashes across directories (`ramps.js`, `smart-plan.js`, etc.) which increases developer cognitive load and risk of edit mismatches.

Below is a detailed breakdown of findings and concrete, safe recommendations for clean-up.

---

## Part 1: Obsolete & Dead Files (The Bloat)
By performing a directory-aware import trace starting from the entry point (`js/main.js` and `index.html`), we identified **eight completely unreferenced files** that constitute dead weight.

### 1. Older Duplicates left in `js/data/`
During the modular split, several core scripts were successfully migrated to `js/modules/` or `js/utils/` where they were actively updated with new features (like cloud sync and route-specific speeds). However, their older, feature-impoverished copies are still sitting in `js/data/` and loading zero references:

| File Path | Size | Description | Status & Replacement |
| :--- | :--- | :--- | :--- |
| **`js/data/smart-plan.js`** | 61.9 KB | Legacy Smart Plan orchestrator. | **Obsolete.** Replaced by `js/modules/smart-plan.js` (which implements universal coordinates, Universal Access Index, and casting-stop generation). |
| **`js/data/custom-vectors.js`** | 25.7 KB | Legacy structures loader. | **Obsolete.** Replaced by `js/modules/custom-vectors.js` (which contains critical cloud-sync integration hooks). |
| **`js/data/spread-builder.js`** | 19.9 KB | Legacy spread layout manager. | **Obsolete.** Replaced by `js/modules/spread-builder.js`. |
| **`js/data/smart-plan-ui.js`** | 17.1 KB | Legacy Smart Plan UI builder. | **Obsolete.** Replaced by `js/modules/smart-plan-ui.js` (which supports route-specific speeds). |
| **`js/data/wateree-ramps.js`** | 12.3 KB | Static, hardcoded ramp list. | **Obsolete.** Ramps are now retrieved dynamically from worker endpoints or the Universal Access Index. |

### 2. Older Duplicates and Prototypes in `js/modules/`
Similarly, some files in `js/modules/` are duplicates of utils or represent older abandoned prototypes:

| File Path | Size | Description | Status & Replacement |
| :--- | :--- | :--- | :--- |
| **`js/modules/ryan-ramps.js`** | 14.6 KB | Hardcoded personal ramp databases. | **Obsolete.** Bypassed by the universal `access-index.js` and dynamic worker endpoints. |
| **`js/modules/catch_importer.js`** | 13.0 KB | Legacy prototype for drag-and-drop EXIF image parsing. | **Obsolete.** Fully replaced by `js/modules/catch-photo.js` and `js/modules/catch-journal.js`. |
| **`js/modules/rod-row.js`** | 1.4 KB | Legacy rod row schema. | **Obsolete.** Replaced by `js/utils/rod-row.js`, which has critical fixes for A-Rig trailer fields. |

> **Total Obsolete Front-End JS Bloat:** **~165.9 KB** of completely unused files. Removing these will declutter the workspace and prevent developers from accidentally editing or importing the wrong file.

---

## Part 2: Overly Specific / Brittle Parsers (The Fragility)
The Cloudflare Worker implements automated web scraping. However, the custom parsers written to process the raw HTML/text are **highly brittle** and contain rules designed only to catch narrow edge cases.

### 1. SCDNR Description Scraper (`Worker/worker-research.js`)
The `parseSCDNRDescriptionFacts` function extracts metadata from SCDNR lake pages using a sequence of extremely specific regular expressions:
```javascript
const mCounties = text.match(/Counties Lake is Within:\s*([^*]+?)(?:Average Depth:|Maximum Depth:|Boat Ramps:)/i);
const mPublicPrivate = text.match(/maintain\s*([a-z0-9]+) public boat access areas.*?Five are privately owned and operated/i);
const mRiver = text.match(/largest of the ([A-Za-z\- ]+?) lakes/i) || text.match(/upper most of the two beautiful water bodies that comprise ([A-Za-z\- ]+?) reservoir/i);
```
* **Why it's brittle:** If SCDNR fixes a typo, adds a county, changes "Boat Ramps:" to "Access Areas:", or rewrites the introductory prose (e.g., changes "Five are privately owned" to "5 are privately operated"), these regexes will fail silently, writing `null` or capturing garbage.

### 2. South Carolina eRegulations Table Parser (`Worker/worker-research.js`)
The `parseSCRegulationsFromHtml` function tries to parse HTML or Markdown tables from eRegulations for South Carolina.
* **Typo-Matching Hack:** It matches typos from the live website to align columns:
  ```javascript
  const statewideStriper = striperRows.find(r => {
    const w = normalizeResearchName(r[0] || '');
    return w.startsWith('statewide except the water bodies list below') // Typos on live SC DNR page
      || w.startsWith('statewide except the water bodies listed below')
  });
  ```
* **System-Specific Hardcoding:** It uses custom functions like `isRiverOrSystemRow` containing hardcoded arrays of river/estuary keywords (`Ashepoo|Waccamaw|Pee Dee|Edisto|Combahee|Cooper River`) to filter out river-specific regulations.
* **Why it's brittle:** HTML/Markdown table layouts are notorious for changing without notice. If the publisher inserts a column, merges cells, or changes abbreviations, this parsing loop will break or map limits to the wrong species.

### 3. Angler's Headquarters Temperature Scraper (`Worker/worker-data.js`)
The `fetchAhqWaterTemp` function scrapes fishing reports to parse water temperatures:
```javascript
const vagueRe = /water\s+temperatures?\s+(?:are\s+|is\s+|now\s+)?(?:in\s+the\s+)?(lower|low|mid|upper|high)?\s*(\d{2,3})s(?:\s*(?:to|[-–])\s*(lower|low|mid|upper|high)?\s*(\d{2,3})s)?/i;
```
* **Over-engineered Text Translation:** It attempts to translate verbal descriptors like *"temperatures are in the upper 60s to lower 70s"* using a custom sub-function `band()` to convert strings like `"lower"`, `"low"`, `"mid"`, `"upper"`, or `"high"` into offset temperatures (e.g., `"lower 60s"` = `62`°F, `"upper 70s"` = `78`°F).
* **Why it's brittle:** Translating natural-language fishing reports into exact numeric averages via regex is extremely fragile and misses edge cases where temperatures are mentioned but refer to historical records, target ranges, or specific depths.

---

## Part 3: Architecture & Design Redundancies

### 1. Duplicate Species Information
The system maintains two distinct files for species recommendations and limits:
* **`js/data/species-intel.js`** (V1 behavior, seasons, and SCDNR regulations check).
* **`js/data/species-intel-v2.js`** (V2 trolling-first multi-species brain, which supports complex seasonal depth bands).
* **Bloat:** In `js/modules/smart-plan.js`, both files are loaded simultaneously:
  ```javascript
  import { SPECIES_BEHAVIOR, getSeason, checkRegulations, resolveLakeKey } from '../data/species-intel.js';
  import * as IntelV2 from '../data/species-intel-v2.js';
  ```
  The code has to coordinate fallbacks between them. Merging them into a single file would consolidate the species intelligence database and clear up redundant object key mappings.

### 2. Filename Clashing and Confusion
Having identical filenames in different paths creates severe development friction:
* `js/data/ramps.js` vs. `js/modules/ramps.js`
* `js/data/smart-plan.js` vs. `js/modules/smart-plan.js`
* `js/data/smart-plan-ui.js` vs. `js/modules/smart-plan-ui.js`
* `js/data/custom-vectors.js` vs. `js/modules/custom-vectors.js`
* `js/data/spread-builder.js` vs. `js/modules/spread-builder.js`
* `js/utils/rod-row.js` vs. `js/modules/rod-row.js`

If a developer does a quick search for `smart-plan.js` or `custom-vectors.js`, they risk editing the inactive copy in `js/data/` or importing the legacy file, which breaks cloud-sync and other modern features.

---

## Part 4: Recommendations for Safe Refactoring

To clean up this bloat and reduce system fragility without breaking any features, we recommend the following phased clean-up strategy:

### Phase 1: Safe File Deletions (Zero-Risk Bloat Removal)
Delete the files that our directory-aware audit proved are **100% unreferenced and unused**:
* [x] `js/data/custom-vectors.js` (Deleted)
* [x] `js/data/smart-plan.js` (Deleted)
* [x] `js/data/smart-plan-ui.js` (Deleted)
* [x] `js/data/spread-builder.js` (Deleted)
* [x] `js/data/wateree-ramps.js` (Deleted)
* [x] `js/modules/rod-row.js` (Deleted)
* [x] `js/modules/catch_importer.js` (Deleted)
* [x] `js/modules/ryan-ramps.js` (Deleted)

*Note: Doing this will instantly reclaim ~180 KB of disk and code size, making search results clean and editing foolproof.*

### Phase 2: Refactoring Fragile HTML Parsers to Structured LLM Prompts (Completed & Cleaned)
* [x] **Refactored `parseSCDNRDescriptionFacts` and `parseSCRegulationsFromHtml`:** Migrated to asynchronous, robust **LLM-driven Structured Extraction** with strict JSON schemas.
* [x] **Stripped Bundler Noise:** Cleaned out all 49 `__name(...)` calls and its helper variable from the file.

Since the Cloudflare Worker is already configured to connect to an LLM (imported as `callLLM` in `Worker/worker-core.js`), we can eliminate hundreds of lines of brittle regexes by adopting an **LLM-driven Structured Extraction** approach:
* **The Pattern:** Instead of writing massive regular expressions to match tables, text, and typographic variations:
  1. Fetch the raw page text (stripped of heavy HTML tags).
  2. Send it to the LLM with a highly specific system prompt and a strict JSON schema.
  3. The LLM parses the natural-language paragraphs (e.g. *"water temperatures are in the lower 70s"* or eRegulations lists) and yields a perfect JSON payload.
* **Why it's better:** LLMs are exceptionally good at understanding context, handling variable structures, and tolerating spelling mistakes or layout modifications, transforming a highly brittle script into an adaptable, self-healing system.

### Phase 3: Consolidate Species Intelligence Databases (Completed)
Merge the v1 regulations check and basic information with the v2 trolling behavior database:
* [x] **Consolidated `js/data/species-intel.js` and `js/data/species-intel-v2.js`:** Merged legacy regulations and behavior matrices into a unified, clean source of truth under `js/data/species-intel.js`.
* [x] **Refactored imports in `js/modules/smart-plan.js`:** Standardized the import of species information and behavior parameters to use the unified module.
* [x] **Cleaned up `js/data/species-intel-v2.js`:** Deleted the now obsolete file.

### Phase 4: Rename Data Loaders to Avoid Name Clashing (Completed)
Rename files in `js/data/` to represent their actual functions so they do not clash with `js/modules/` controllers:
* [x] **Renamed `js/data/ramps.js` to `js/data/ramps-loader.js`:** Cleanly distinguishes the dynamic data caching and loading system from the Leaflet UI controller `js/modules/ramps.js`.
* [x] **Updated all active imports:** Modified `js/main.js`, `js/modules/fishing-index.js`, and `js/modules/ramps.js` to use the correct `ramps-loader.js` path.

---
*Report compiled by TrollMap-Dev Audit Engine.*
