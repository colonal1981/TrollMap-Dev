/**
 * Shared mutable application state.
 *
 * Every feature module imports this singleton and reads/mutates its
 * properties. This replaces the old pattern of `let MAP = null;` etc.
 * sprinkled across the monolithic <script> block, and the awkward
 * `window.MAP = MAP` hoisting dance.
 *
 * Convention:
 *   import { state } from '../core/state.js';
 *   state.MAP = someMapInstance;
 *   if (state.MAP_OK) ...
 *
 *   DO NOT destructure: `import { MAP }` would give you a *local*
 *   binding that disconnects from the singleton. Always go through
 *   `state.X`.
 */

export const CF_WORKER_URL = 'https://trollmap-worker.colonal1981.workers.dev';

export const state = {
  // ── Leaflet map + base layers ──
  MAP: null,
  LAYER: null,            // working GPX layer group (waypoints + tracks)
  BASE: null,             // base tile layer (satellite or street)
  BASE_LABELS: null,      // optional labels overlay
  MAP_OK: false,          // map ready for module code to act on

  // ── Chart image overlay (georef workflow) ──
  IMG_OVERLAY: null,
  IMG_DATAURL: null,
  IMG_NATSIZE: null,      // { w, h } natural pixel size
  IMG_BOUNDS: null,       // current Leaflet bounds after affine
  IMG_ROTATION: 0,
  IMG_AFFINE: null,       // [[a,b,c],[d,e,f]] 2x3 matrix or null
  IMG_AFFINE_PTS: null,   // [{lat,lon}] corresponding source points
  GEOREF: null,           // {bbox, ...} once georef finished
  georefState: null,      // current georef step machine

  // ── Working data ──
  DATA: { waypoints: [], tracks: [] },
  CATCHES: [],
  SPREAD: [],

  // ── Chart mosaic (multi-layer depth-contour overlays) ──
  CHARTS: [],            // committed depth-contour overlay layers
  ACTIVE_CHART: -1,     // -1 = working overlay; >=0 = index into CHARTS

  // ── Contour datasets ──
  CONTOUR_DATASETS: [],    // [{ key, lake_name, area_name, zoom, bounds, depthRange, hasSmart, hasRaw }]
  ACTIVE_CONTOUR: null,    // { smart: FeatureCollection|null, raw: FeatureCollection|null }
  ACTIVE_CONTOUR_KEY: null, // dataset key string
  CONTOUR_LAYER: null,     // Leaflet layer group for contour rendering

  // ── GPS / live tracking ──
  GPS_WATCH: null,       // navigator.geolocation.watchPosition ID
  GPS_MARKER: null,      // Leaflet marker for current location
  GPS_LINE: null,        // Leaflet polyline for the recorded track
  GPS_TRACK: [],         // [[lat, lon], ...] while recording
  FOLLOW_GPS: false,     // pan map to GPS position on each fix
  RECORDING: false,      // true when recording GPS into a track
};
