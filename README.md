# What to push — 2026-08-04

Everything in this folder is repo-relative: `js/...` goes to `js/...` in the repo, `test/...`
to `test/...`, `Scripts/...` to `Scripts/...`.

Verified before staging: **652 tests, 651 pass, 1 skipped, 0 fail. `npm run lint` clean.**

---

## 1. New file

| file | why |
|---|---|
| `js/utils/depth-palette.js` | the one depth ladder, replacing three private band tables |
| `test/depth-palette.test.js` | 16 tests covering the ladder and the tide rule |

## 2. Changed files

| file | why |
|---|---|
| `js/modules/tide-engine.js` | `displayDepth()` / `setDisplayTide()` — one tide owner for all three layers |
| `js/modules/contour-data.js` | contour colour + labels go through the shared palette and tide rule |
| `js/modules/supplemental-layers.js` | drops both local band tables; hover now agrees with the fill |
| `js/modules/coastal-layers.js` | soundings drop their private 2/4/8 palette, use the shared one |
| `js/data/dump_js_lists.mjs` | no longer imports the deleted `lakes.js` |
| `test/check-lake-geo.mjs` | reads its 50 ground-truth centres from `registry/curated_lakes.json` |
| `test/smart-plan-coastal.test.js` | the `LAKE_DB` tests become "the file is gone and stays gone" |

## 3. DELETE from the repo

    js/data/lakes.js

**Its data is not dead — it moved.** `consolidate_lake_index.py` read it as the only source of
USGS gauge sites (Marion, Moultrie, Murray, Parr Shoals, Wateree), Duke and Dominion bindings,
pool curves, and the curated ramp lists on 38 index rows. All 50 entries are now in
`registry/curated_lakes.json`, which is **already on the drive** along with the patched
`consolidate_lake_index.py` that reads it. Order does not matter for you; both halves are in
place locally.

## 4. Scripts/ — 37 up, 8 out

`Scripts/` here holds all 41 live pipeline scripts plus `make_counties.mjs`. Of these:

- **32 are new to the repo.**
- **5 already exist but are STALE** — `coastal_catalog.py`, `fetch_osm_structures.py`,
  `lake_catalog.py`, `trollmap_pipeline_coastal.py`, `upload_to_r2_coastal.py`. Confirmed by
  git blob hash; the drive copies are the ones you have been running.
- 4 are already identical and can be skipped.

Uploading the whole folder is fine — identical files produce no diff.

### Delete these 8 from `Scripts/`

Archive-tier, safe outright:

    derived_bboxes.py            generated output, not a script
    fetch_osm_coastal.py         declared dead; fetch_osm_structures.py replaced it
    trollmap_lake_boundaries.py  hand-typed bboxes; superseded by the cutter
    trollmap_pipeline.py         old "one button" driver
    upload_to_r2.py              superseded by the three current uploaders

Review-tier, your call:

    gmp_lake_mapper.py
    trollmap_garmin_bridge.py
    trollmap_r2_clean.py

## 5. `curated_lakes.json` — a decision, not an instruction

It sits in this folder's root rather than a repo path because there is no obvious home for it.
It is pipeline **data**, it lives at `F:\TrollMapPipeline\registry\curated_lakes.json`, and the
pipeline already reads it from there — so the repo does not need it to work.

But it is now the single source of every gauge, pool curve and curated ramp list in the index,
and it is hand-maintained. Losing it loses data no script can regenerate. If you want it
versioned, `data/curated_lakes.json` sits alongside the paddle JSONs you already put there.
Skipping it is also defensible. Your call — this file is not required for anything above.
