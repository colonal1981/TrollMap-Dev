/**
 * scdnr-state-lakes.js — SCDNR State Lakes Program.
 *
 * Source: "SCDNR State Lakes — Locations, Maps, Rules, Regulations and
 * Facilities" (SCDNR publication 14-10064), provided 2026-07-03.
 *
 * These 18 small lakes are a DNR-managed public fishing program, distinct
 * from the boat-ramp ArcGIS feeds the worker pulls (/ramps, /paddle, etc).
 * Most are paddle/electric-motor-only, several have restricted open days,
 * and several are small enough (as low as 1 acre) that they're unlikely to
 * ever appear as "Boat Ramp" type records in a DNR access-point layer.
 * Confirmed absent from both LAKE_DB (data/lakes.js) and the worker access
 * index as of 2026-07-03 — this is a standalone gap, not something the NC
 * worker fix or LAKE_DB touches.
 *
 * Coordinates are the PDF's published "Property Location" lat/lon for each
 * lake (single point per lake — these are small enough that one point is a
 * reasonable representation, unlike the multi-ramp big reservoirs).
 *
 * Two same-named ambiguities exist elsewhere in SC (e.g. "Lake Robinson" —
 * see fishing-index.js SCDNR_OVERRIDES for the Greenville/Darlington split).
 * County is kept in the display name here to avoid silently colliding with
 * an unrelated same-named waterbody from the worker feed.
 */

export const SCDNR_STATE_LAKES = [
  { name: 'Lake Edgar Brown', county: 'Barnwell', state: 'SC', lat: 33.254, lon: -81.368, acres: 100 },
  { name: 'Lake Cherokee', county: 'Cherokee', state: 'SC', lat: 35.042, lon: -81.572, acres: 50 },
  { name: 'Lake Thicketty', county: 'Cherokee', state: 'SC', lat: 35.079, lon: -81.782, acres: 100 },
  { name: 'Lake Oliphant', county: 'Chester', state: 'SC', lat: 34.796, lon: -81.187, acres: 40 },
  { name: 'Mountain Lake 1', county: 'Chester', state: 'SC', lat: 34.655, lon: -81.253, acres: 42 },
  { name: 'Mountain Lake 2', county: 'Chester', state: 'SC', lat: 34.655, lon: -81.263, acres: 7 },
  { name: "Dargan's Pond", county: 'Darlington', state: 'SC', lat: 34.301, lon: -79.729, acres: 50 },
  { name: 'Star Fort Pond', county: 'Greenwood', state: 'SC', lat: 34.147, lon: -82.01, acres: 22 },
  { name: 'Lake George Warren', county: 'Hampton', state: 'SC', lat: 32.831, lon: -81.173, acres: 400 },
  { name: 'Webb Center Lakes', county: 'Hampton', state: 'SC', lat: 32.602, lon: -81.313, acres: 17 }, // two lakes, 7ac + 10ac combined
  { name: 'Lancaster Reservoir', county: 'Lancaster', state: 'SC', lat: 34.702, lon: -80.75, acres: 60 },
  { name: 'Sunrise Lake', county: 'Lancaster', state: 'SC', lat: 34.619, lon: -80.672, acres: 25 },
  { name: 'Lake Ashwood', county: 'Lee', state: 'SC', lat: 34.103, lon: -80.318, acres: 75 },
  { name: 'Lake Paul Wallace', county: 'Marlboro', state: 'SC', lat: 34.641, lon: -79.676, acres: 300 },
  { name: 'Lake Edwin B. Johnson', county: 'Spartanburg', state: 'SC', lat: 34.88, lon: -81.836, acres: 40 },
  { name: 'Jonesville Reservoir', county: 'Union', state: 'SC', lat: 34.855, lon: -81.681, acres: 25 },
  { name: 'Lake John D. Long', county: 'Union', state: 'SC', lat: 34.775, lon: -81.511, acres: 80 },
  { name: 'Draper WMA Lakes', county: 'York', state: 'SC', lat: 34.873, lon: -81.189, acres: 8 }, // three ponds, 1-5ac each
];
