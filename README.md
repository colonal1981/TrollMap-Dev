# TrollMap GPX Studio — Modular Build

This is the **modular ES-modules version** of TrollMap. The original
single-file build is preserved in `legacy/` for reference.

## File structure

```
trollmap-modular/
├── index.html                # Thin shell — markup + CSS + one <script type="module">
├── sw.js                     # Service worker (v15 — pre-caches all 53 modules)
├── manifest.json             # PWA metadata (unchanged)
├── icons/                    # PWA icons (192, 512)
│
├── js/
│   ├── main.js               # Entry point — imports every module + boots the app
│   ├── lazy-data.js          # Loader for optional bank/pier/paddle/attractor JSON
│   │
│   ├── utils/                # 6 pure-function utility modules
│   │   ├── escape.js         #   esc() HTML-escape
│   │   ├── dedupe.js         #   Ramp deduplication
│   │   ├── rod-row.js        #   newRodRow() builder
│   │   ├── db.js             #   IndexedDB layer
│   │   ├── geo.js            #   9 pure geo helpers (distFt, simplifyLine, …)
│   │   └── parsers.js        #   GPX / KML / GeoJSON parsers + GPX builder
│   │
│   ├── data/                 # 3 pure-data modules
│   │   ├── ramps.js          #   1,288+ SC/NC/GA boat ramps
│   │   ├── lakes.js          #   LAKE_DB with USGS/Duke mappings
│   │   └── spread-defaults.js#   Default 6-rod trolling spread
│   │
│   ├── core/                 # 3 application-core modules
│   │   ├── state.js          #   Shared mutable state singleton (state.MAP, state.DATA, …)
│   │   ├── tabs.js           #   Bottom-nav tab switcher
│   │   └── map-init.js       #   Leaflet map + base layers + renderMap/renderAll/fitMap
│   │
│   └── modules/              # 39 feature modules
│       ├── gps.js            #   GPS tracking + recording
│       ├── ramps.js          #   1,288 ramp layer
│       ├── chart-overlay.js  #   Single-image georef workflow
│       ├── chart-mosaic.js   #   Multi-chart saved layers
│       ├── chart-import.js   #   KML/GPX/GeoJSON layer import
│       ├── custom-vectors.js #   Private GeoJSON structure layers
│       ├── spread-builder.js #   Rod spread table UI + auto-lead calculation
│       ├── saved-spreads.js  #   Named spread persistence
│       ├── catch-journal.js  #   Catch log + photos
│       ├── garmin-parser.js  #   Import GPX catches from Garmin
│       ├── garmin-export.js  #   Export GPX with Garmin extensions
│       ├── file-io.js        #   Top-bar Load / New / Save GPX
│       ├── topbar.js         #   Basemap selector + fit + edit-mode
│       ├── noaa-tides.js     #   NOAA CO-OPS tide predictions
│       ├── duke-energy.js    #   Duke dashboard scraper (via worker)
│       ├── utility-sync.js   #   Live pool elevation + water temp sync
│       ├── lake-intel.js     #   Lake Intelligence briefing from worker
│       ├── plan-builder.js   #   Plan tab form collection + preview/save
│       ├── troll-generator.js # Trolling lane generator
│       ├── edit.js           #   Edit-tab tables + bulk operations
│       ├── track-reverse.js  #   Loop trolling (reversed track)
│       ├── cloud-chartpacks.js # Browse + import cloud-stored chartpacks
│       ├── contour-job-export.js # Drive i-Boating capture pipeline
│       ├── fishing-index.js   #   Fisherman-friendly ramp groupings
│       ├── measure-tool.js    #   Click-to-measure distance + bearing
│       ├── catch-plot.js     #   Toggle catch markers on the map
│       ├── waypoint-to-generator.js # Send wpt → Generate tab
│       ├── spot-repositioning.js # Drag markers to correct positions
│       ├── safety-checklist.js # Auto-compile safety briefing
│       ├── gis-toggles.js    #   Bank/pier/paddle/attractor toggles
│       ├── ble-motor.js      #   Web Bluetooth XZNY/JBD BMS pairing
│       ├── wet-hands-remote.js #  Keyboard + gamepad shortcuts
│       ├── gear-autopilot.js #   Auto-fill NK180/93sv profile
│       ├── auto-crop.js      #   Strip phone status bar from screenshots
│       ├── casting-rings.js  #   60ft casting approach circles
│       ├── catch-photo.js    #   Full-screen photo lightbox
│       ├── osm-structure.js  #   OSM Overpass pre-impoundment structures
│       ├── quickdraw-key.js  #   Floating depth-color legend
│       └── sw-register.js    #   Service worker registration
│
├── data/                     # Optional GIS JSON files (lazily loaded)
│   ├── tristate-bank-pier.json
│   ├── tristate-paddle.json
│   └── tristate-hotspots.json
│
└── backend/                  # Python capture pipeline + Cloudflare worker
    ├── trollmap-worker.js
    ├── trollmap_build_contours.py
    └── trollmap_capture_server.py
```

## How the modules talk to each other

1. **Shared mutable state** lives in `js/core/state.js` as a singleton
   (`state.MAP`, `state.DATA`, `state.SPREAD`, `state.CHARTS`, …).
   Every module imports `state` and mutates its properties.

2. **DOM helpers** that popup buttons invoke across modules are exposed
   on `window` by their owning module — e.g. `window.sendWptToGenerator`,
   `window.enableSpotRepositioning`, `window.showCatchPhoto`. Popup
   HTML in map markers calls them via inline `onclick`.

3. **Cross-module function references** in `core/tabs.js` and
   `core/map-init.js` use `window.X?.()` defensive lookups so a tab
   click that triggers `renderEditTables()` works even before that
   module has finished wiring its handlers.

## How to deploy

1. Push the entire `trollmap-modular/` folder to your GitHub Pages
   repo (any subdirectory works — `trollmap-modular/` recommended so
   the old monolithic build can live alongside it).

2. The path the worker expects:
   - `https://yourname.github.io/yourrepo/trollmap-modular/` is the
     app's base URL.

3. The Cloudflare worker (in `backend/`) is deployed separately —
   see its comments for the route mapping.

## Service worker

`sw.js` cache name is `trollmap-v15-modular-2026-06-23`. Bump this and
re-deploy whenever you add a new module — old caches will auto-prune.

## Adding a new module

1. Create `js/modules/your-feature.js` and `export` whatever you need.
2. Add `import './js/modules/your-feature.js';` to `js/main.js`.
3. Add the new module to `CORE_ASSETS` in `sw.js` (and bump the cache
   version).
4. Done — the app will load it on next visit.

