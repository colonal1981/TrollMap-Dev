# TrollMap — Kayak Fishing Intelligence Platform

A full-suite fishing application built for trolling-first kayak anglers in South Carolina (and expanding). Started as a trolling lane generator, now a modular ES-modules web app with AI-assisted fish ID, Smart Plan route generation, catch journaling, live lake intelligence, and satellite structure detection.

**Live app:** `https://trollmap-dev.pages.dev`
**API worker:** `https://trollmap-worker.colonal1981.workers.dev`

---

## What it does

- **Smart Plan** — AI-generated multi-phase trolling plans per species/lake/season. Produces GPX routes, rod spread recommendations with lead lengths, and a Groq/Llama 3.3 plan audit with scored categories (depth, lure, speed, battery, safety)
- **Catch Journal** — nightly photo upload workflow with Gemini vision AI for species ID and length measurement, fish/lure photo pairing, GPS lake matching against full DNR access-point database (SC/NC/GA)
- **Live Lake Intelligence** — water level (Duke Energy, USGS), dam flow, clarity forecast, solunar timing, species-specific tactical notes
- **Contour Routes** — depth-contour-following sine-sweep trolling lanes loaded from GeoJSON datasets (Lake Wateree, Marion, Moultrie, Murray, Monticello/Parr)
- **Structure Detection** — Groq Llama 4 Scout vision AI detects docks, piers, boat ramps, and timber from the satellite basemap viewport
- **Ramp Database** — live SC/NC/GA DNR boat ramp data via Cloudflare Worker (ArcGIS REST APIs), per-state IDB cache with independent TTLs
- **Plan Builder** — full fishing trip plan with rod spread, tackle notes, safety checklist, preview, and PDF export
- **GIS Layers** — SCDNR fish attractors/brush piles, bank/pier access, paddle launches, ramps, catch plot, pinch point finder
- **Garmin Integration** — GPX import/export with Garmin extensions, Quickdraw depth key overlay

---

## Architecture

```
trollmap-dev (Cloudflare Pages — auto-deploys from GitHub)
├── index.html                # App shell
├── sw.js                     # Service worker v16 — minimal core asset cache
├── manifest.json             # PWA metadata
├── js/
│   ├── main.js               # Entry point
│   ├── lazy-data.js          # Optional GIS JSON loader
│   ├── utils/                # escape, dedupe, rod-row, db, geo, parsers
│   ├── data/                 # ramps, lakes, access-index, species-intel,
│   │                         # species-intel-v2, fishing-style-profile,
│   │                         # scdnr-state-lakes, user-known-lakes,
│   │                         # spread-defaults
│   ├── core/                 # state, tabs, map-init
│   └── modules/              # ~40 feature modules (see below)
└── data/                     # Contour GeoJSON datasets (5 lakes)

trollmap-worker (Cloudflare Worker — deployed via wrangler)
├── /ramps, /paddle, /bank-pier, /attractors  — DNR access data (SC/NC/GA)
├── /lake, /duke, /usgs, /river               — live water level/flow
├── /lake-intel, /lake-clarity                — lake intelligence + runoff
├── /identify-catch, /identify-catch-v2      — Gemini vision fish ID
├── /audit-plan                               — Groq plan audit (Llama 3.3 70B)
├── /detect-structure                         — Groq vision structure detection (Llama 4 Scout)
├── /sync/*                                   — Cloud sync (D1 + R2)
└── /chartpacks/*                             — Contour chartpack hosting (R2)
```

---

## Key modules

| Module | What it does |
|---|---|
| `smart-plan.js` | Multi-phase route planning, species-intel-v2 brain, Groq audit |
| `route-builder.js` | Contour-following sine-sweep GPX route generator |
| `plan-builder.js` | Plan form, preview, PDF export |
| `catch-journal.js` | Photo upload, AI ID queue, nightly workflow |
| `lake-intel.js` | Lake intelligence + clarity forecast |
| `species-intel-v2.js` | Trolling-first multi-species recommendation brain |
| `fishing-style-profile.js` | Angler gear/style constraints (spinning only, no live bait FW) |
| `access-index.js` | Shared worker-backed lake/ramp index (SC/NC/GA DNR) |
| `osm-structure.js` | Groq vision dock/structure detection from satellite imagery |
| `gis-toggles.js` | Attractor/ramp/bank-pier/paddle layer toggles |
| `spread-builder.js` | Rod spread table, lure catalog, auto lead-length calculation |
| `duke-energy.js` | Duke Energy lake level dashboard scraper (via worker proxy) |
| `pinch-point-finder.js` | Depth-contour saddle/funnel detection |
| `ble-motor.js` | Web Bluetooth NK180/BMS integration |

---

## Species coverage (species-intel-v2.js)

Striped Bass, Largemouth Bass, White Bass/Hybrid, Crappie, Blue Catfish, Channel Catfish, Flathead Catfish, Bowfin, Chain Pickerel, Red Drum (Redfish), Speckled Trout, Bluegill, Redear Sunfish (Shellcracker)

All entries are trolling-first, spinning-gear-only, freshwater-live-bait-unavailable by default. See `fishing-style-profile.js` for the full angler constraint profile.

---

## Worker bindings

| Binding | Type | Purpose |
|---|---|---|
| `DB` | D1 | Cloud sync database |
| `R2_TROLLMAP_CHARTPACKS` | R2 | Contour chartpack storage |
| `GEMINI_API_KEY` | Secret | Fish ID vision AI |
| `GROQ_API_KEY` | Secret | Plan audit + structure detection |
| `SYNC_TOKEN` | Var | Cloud sync auth |

---

## Deployment

**Frontend (automatic):** Push to GitHub → Cloudflare Pages auto-deploys within ~60 seconds.

**Worker (manual):** 
```powershell
cd F:\TrollMap-Dev-main
wrangler deploy
```

`wrangler.toml` in the project root declares all bindings. Secrets set separately:
```powershell
wrangler secret put GEMINI_API_KEY
wrangler secret put GROQ_API_KEY
```

---

## Platform

- **Watercraft:** Native Watersports Slayer Propel Max 12.5 + NK180 bow-mount trolling motor
- **Sonar:** Garmin ECHOMAP UHD2 93sv
- **Rods:** Spinning only — no lead-core, no conventional reels, no planer boards
- **Primary waters:** Lake Wateree, Marion, Moultrie, Murray, Monticello (SC freshwater) + SC inshore saltwater
