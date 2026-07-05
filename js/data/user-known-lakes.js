/**
 * user-known-lakes.js — Angler-flagged SC lakes not covered elsewhere.
 *
 * Unlike scdnr-state-lakes.js (one official SCDNR publication), these came
 * from a mix of public sources, verified individually 2026-07-03:
 *
 *   - Lowthers Lake:      user-supplied coordinate. Matches the official
 *                         legal definition of "Louther's Lake" in SC Code
 *                         §50-1-50(145): "the oxbow lake off of the Great
 *                         Pee Dee River in eastern Darlington County near
 *                         S.C. State Highway S-16-495."
 *   - Second Millpond:    SC Picture Project / Google Maps directions link
 *                         (Liberty Street bridge boat landing, Sumter, SC).
 *   - Wee Tee Lake:       OpenStreetMap way 146411340 (natural=water).
 *                         Oxbow of the Santee River, Wee Tee State Forest.
 *   - Dawhoo Lake:        USGS GNIS (federal gazetteer, authoritative).
 *                         Oxbow near the Santee River, Georgetown County.
 *   - Bates Old River:    Derived from USGS gauge station ID
 *                         334709080381100 ("Bates Old River at SC601 near
 *                         Wateree, SC") = 33°47'09"N 80°38'11"W. Long oxbow
 *                         of the Congaree River, accessed off Hwy 601 near
 *                         the Congaree National Park / Bates Ferry Trail.
 *   - HB Robinson Lake:   Duke Energy nuclear plant cooling lake (H.B. Robinson
 *                         Steam Electric Plant), Darlington County near
 *                         Hartsville. Not in any DNR ArcGIS feed — Duke Energy
 *                         ownership means no public ramp records in SCDNR data.
 *                         Warm water discharge keeps fish active year-round;
 *                         adjacent to Prestwood Lake on Black Creek.
 *
 * The last four (Wee Tee, Dawhoo, Bates Old River are oxbow lakes; Second
 * Millpond is a mill pond) are small/river-adjacent waterbodies unlikely to
 * ever appear as "Boat Ramp" type records in the worker's ArcGIS feeds —
 * several have unimproved or no formal boat ramps at all.
 *
 * Coordinates here are single reference points (river-access/landing area
 * for the oxbows, dam/landing area for the ponds) — good enough for nearest-
 * point lake-name matching, not survey-precise lake boundaries.
 */

export const USER_KNOWN_LAKES = [
  { name: 'Lowthers Lake', county: 'Darlington', state: 'SC', lat: 34.324463, lon: -79.723411, note: "Legally 'Louther's Lake', oxbow off the Great Pee Dee River (SC Code §50-1-50)" },
  { name: 'Second Millpond', county: 'Sumter', state: 'SC', lat: 33.9253168, lon: -80.389208025, note: 'Also called Second Mill Lake; boat landing near Liberty Street bridge' },
  { name: 'Wee Tee Lake', county: 'Williamsburg', state: 'SC', lat: 33.373194, lon: -79.771922, note: 'Oxbow of the Santee River, Wee Tee State Forest; bowfin water' },
  { name: 'HB Robinson Lake', county: 'Darlington', state: 'SC', lat: 34.385, lon: -80.100, note: 'Duke Energy nuclear cooling lake near Hartsville; warm water discharge keeps fish active year-round; adjacent to Prestwood Lake on Black Creek' },
  { name: 'Bates Old River', county: 'Richland/Calhoun', state: 'SC', lat: 33.78583, lon: -80.63639, note: 'Long oxbow of the Congaree River off Hwy 601; bowfin water' },
];
