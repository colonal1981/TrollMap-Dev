// Santee Cooper Country's attractor table, joined to SCDNR's attractor layer by position.
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-01: "does this match what we have from dnr
// https://www.santeecoopercountry.org/fishing/attractors/" -- it does, site for site, and it
// carries what SCDNR's layer does not: a depth for every site and the state of its buoy. He
// said "both sound good" to showing them in the popup (APP_CHANGE_REQUESTS item 43).
//
// THE LAYER STAYS SCDNR'S. Nothing here moves, adds or hides a point. Each entry is keyed by
// the SCDNR name the live /attractors feed carries and is shown under it, as Santee Cooper
// Country's, with the date the page was read.
//
// HOW THE PAIRS WERE MADE: each of SCC's 32 sites was paired to its nearest SCDNR attractor, and
// every pair is mutual (test/scc-attractor-notes.test.js holds it against a frozen copy of the
// feed). Every pair is 19-26 m apart, and SCDNR's point is about 18 m S and 18 m W of SCC's at
// every site: one list is shifted as a whole. Which one sits on the buoy is not known, so the
// popup says how far and which way SCC's coordinate is and does not choose.
//
// SCC NUMBERS ACROSS BOTH LAKES and calls SCDNR's "#21 Lake Marion" site 20; it has no 21 and
// SCDNR has no 20. SCDNR's Marion #34-#36 are not in SCC's table and get no note.
//
// `note` is SCC's comment column verbatim. `material` is written only where SCC's comment names
// a material that SCDNR's type does not (sites 3 and 4); both are shown, neither is chosen.
//
// Regenerate with _scratch/gen_scc_notes_1001.py (run 2026-10-01) if SCC's table changes.

export const SCC_ATTRACTOR_SOURCE = {
  label: 'Santee Cooper Country',
  url: 'https://www.santeecoopercountry.org/fishing/attractors/',
  checked: '2026-10-01',
};

export const SCC_ATTRACTOR_NOTES = {
 "Fish Attractor #1 Lake Moultrie": {
  "scc": "1",
  "lat": 33.30675,
  "lon": -79.976669,
  "depthFt": 15,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER"
 },
 "Fish Attractor #2 Lake Moultrie": {
  "scc": "2",
  "lat": 33.300169,
  "lon": -79.978311,
  "depthFt": 22,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER"
 },
 "Fish Attractor #3 Lake Moultrie": {
  "scc": "3",
  "lat": 33.299939,
  "lon": -79.987111,
  "depthFt": 30,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER (146.25 CULVERT & CATCH BASING) 2/19/18",
  "material": "Santee Cooper Country's table says culverts and catch basins; SCDNR's layer says brush/trees."
 },
 "Fish Attractor #4 Lake Moultrie": {
  "scc": "4",
  "lat": 33.239781,
  "lon": -80.024919,
  "depthFt": 30,
  "buoy": "YES",
  "note": "BUOY 40 FT OFF TO THE SOUTH (160.5 TONS OF CULVERTS) 12/15/15",
  "material": "Santee Cooper Country's table says culverts; SCDNR's layer says brush/trees."
 },
 "Fish Attractor #5 Lake Moultrie": {
  "scc": "5",
  "lat": 33.37575,
  "lon": -80.074861,
  "depthFt": 20,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER (199.95 TONS) 3/6/14"
 },
 "Fish Attractor #6 Lake Moultrie": {
  "scc": "6",
  "lat": 33.384561,
  "lon": -80.079189,
  "depthFt": 14,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER"
 },
 "Fish Attractor #7 Lake Moultrie": {
  "scc": "7",
  "lat": 33.38675,
  "lon": -80.080439,
  "depthFt": 14,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER"
 },
 "Fish Attractor #8 Lake Moultrie": {
  "scc": "8",
  "lat": 33.349889,
  "lon": -80.095811,
  "depthFt": 12,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER"
 },
 "Fish Attractor #9 Lake Moultrie": {
  "scc": "9",
  "lat": 33.330331,
  "lon": -80.088581,
  "depthFt": 15,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER (66.2 TONS) 5/22/14"
 },
 "Fish Attractor #10 Lake Moultrie": {
  "scc": "10",
  "lat": 33.314189,
  "lon": -80.007031,
  "depthFt": 18,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER (155.75 TONS) 12/30/14"
 },
 "Fish Attractor #11 Lake Moultrie": {
  "scc": "11",
  "lat": 33.2335,
  "lon": -80.028031,
  "depthFt": 25,
  "buoy": "YES",
  "note": "BUOY OFF 198 FEET TO THE EAST"
 },
 "Fish Attractor #12 Lake Moultrie": {
  "scc": "12",
  "lat": 33.258081,
  "lon": -80.025311,
  "depthFt": 17,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER"
 },
 "Fish Attractor #13 Lake Moultrie": {
  "scc": "13",
  "lat": 33.254389,
  "lon": -80.044281,
  "depthFt": 26,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER (152.35 TONS) 10/27/14"
 },
 "Fish Attractor #14 Lake Moultrie": {
  "scc": "14",
  "lat": 33.27475,
  "lon": -80.08025,
  "depthFt": 18,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER-POLY TUBING (152.25 TONS) 3/22/16"
 },
 "Fish Attractor #15 Lake Moultrie": {
  "scc": "15",
  "lat": 33.288669,
  "lon": -80.082439,
  "depthFt": 35,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER (94.75 TONS) 12/13/17"
 },
 "Fish Attractor #16 Lake Moultrie": {
  "scc": "16",
  "lat": 33.3175,
  "lon": -80.1255,
  "depthFt": 20,
  "buoy": "NO",
  "note": "BUOY MISSING"
 },
 "Fish Attractor #17 Lake Moultrie": {
  "scc": "17",
  "lat": 33.335111,
  "lon": -80.04875,
  "depthFt": 23,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER"
 },
 "Fish Attractor #18 Lake Moultrie": {
  "scc": "18",
  "lat": 33.33075,
  "lon": -80.038561,
  "depthFt": 30,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER (143.35 TONS) 8/21/14"
 },
 "Fish Attractor #19 Lake Moultrie": {
  "scc": "19",
  "lat": 33.278611,
  "lon": -80.01275,
  "depthFt": 45,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER"
 },
 "Fish Attractor #21 Lake Marion": {
  "scc": "20",
  "lat": 33.519031,
  "lon": -80.205139,
  "depthFt": 18,
  "buoy": "YES",
  "note": "BUOY 90 FT OFF TO THE NW (78.3 TONS) 6/4/14"
 },
 "Fish Attractor #22 Lake Marion": {
  "scc": "22",
  "lat": 33.414469,
  "lon": -80.152111,
  "depthFt": 14,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER (195.15 TONS) 12/10/17"
 },
 "Fish Attractor #23 Lake Marion": {
  "scc": "23",
  "lat": 33.426311,
  "lon": -80.324719,
  "depthFt": 20,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER"
 },
 "Fish Attractor #24 Lake Marion": {
  "scc": "24",
  "lat": 33.554719,
  "lon": -80.502469,
  "depthFt": 12,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER"
 },
 "Fish Attractor #25 Lake Marion": {
  "scc": "25",
  "lat": 33.432,
  "lon": -80.224061,
  "depthFt": 16,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER (115.25 TONS) 2/1/16"
 },
 "Fish Attractor #26 Lake Marion": {
  "scc": "26",
  "lat": 33.437581,
  "lon": -80.281111,
  "depthFt": 20,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER (153.6 TONS) 10/8/14"
 },
 "Fish Attractor #27 Lake Marion": {
  "scc": "27",
  "lat": 33.430281,
  "lon": -80.322217,
  "depthFt": 16,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER (130.5 TONS) 3/20/17"
 },
 "Fish Attractor #28 Lake Marion": {
  "scc": "28",
  "lat": 33.434081,
  "lon": -80.362081,
  "depthFt": 14,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER (141.45 TONS) 9/21/15"
 },
 "Fish Attractor #29 Lake Marion": {
  "scc": "29",
  "lat": 33.448189,
  "lon": -80.393081,
  "depthFt": 14,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER"
 },
 "Fish Attractor #30 Lake Marion": {
  "scc": "30",
  "lat": 33.465031,
  "lon": -80.419781,
  "depthFt": 25,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER (167.5 TONS) 12/2/14"
 },
 "Fish Attractor #31 Lake Marion": {
  "scc": "31",
  "lat": 33.502969,
  "lon": -80.459831,
  "depthFt": 12,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER"
 },
 "Fish Attractor #32 Lake Marion": {
  "scc": "32",
  "lat": 33.524581,
  "lon": -80.478,
  "depthFt": 12,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER (124.6 TONS) 2/27/18"
 },
 "Fish Attractor #33 Lake Marion": {
  "scc": "33",
  "lat": 33.547939,
  "lon": -80.492469,
  "depthFt": 18,
  "buoy": "YES",
  "note": "BUOY ON THE MARKER (174.3 TONS) 2/11/15"
 }
};

// Metres and an 8-point compass direction from (lat, lon) to SCC's coordinate. Equirectangular:
// the distances here are tens of metres.
export function offsetToScc(lat, lon, e) {
  const c = Math.cos(((lat + e.lat) / 2) * Math.PI / 180);
  const north = (e.lat - lat) * 110540;
  const east = (e.lon - lon) * 111320 * c;
  const m = Math.hypot(north, east);
  const deg = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
  const dir = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
  return { m, dir };
}

// The note for one feed row, or null. SC rows only: the names are SCDNR's.
export function sccNoteFor(row) {
  if (!row || row.state !== 'SC') return null;
  const e = SCC_ATTRACTOR_NOTES[row.name];
  if (!e) return null;
  return { ...e, offset: offsetToScc(Number(row.lat), Number(row.lon), e) };
}
