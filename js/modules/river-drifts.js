// ---------------------------------------------------------------------------------------------
// A RIVER LEG IS A DRIFT, NOT A LANE.
//
// Ryan, 2026-09-16, on why the Congaree bench came back with nothing worth offering: "for most
// narrower rivers there aren't going to be a bunch of different lanes you can follow... you are
// going to either pick a side or the middle and then kind of follow where the fish might be... i
// am not equipped on the kayak to really anchor on a river so i am going to be moving no matter
// what." And on what the app owes him: "the app just needs to point me over structure... if it
// can draw a line that i can follow and then turn me back around based on speed."
//
// Measured after he said it: all 57 rivers have a median channel width under 200 m and 43 are
// under 80 m. The Congaree gets 1,473 trolling runs over 126.8 km of water 145 m wide -- 11.6
// "lanes" per kilometre, which is one piece of water cut up 11.6 times rather than 11.6 choices.
// Of those 1,473, the selector rejected 915 as unreachable over the water graph and 415 as not
// fitted, before depth was ever consulted. Both of those tests are about lanes.
//
// THIS MODULE DOES NOT ADD A SECOND CANDIDATE GENERATOR. It produces run-shaped LINES from the
// centreline the pipeline already built, and hands them to selectCandidates() unchanged, so the
// window slider, the structure scoring, the per-type caps, the battery and trip-window checks,
// the spatial dedupe and the ranking are the existing ones. A drift differs from a contour lane
// in where the line comes from, not in what a leg is.
//
// WHY THE GEOMETRY DOES THE SIDE-MATCHING AND NO SIGN CONVENTION IS READ. Every stamped feature
// carries a signed `off_m` and a `bend_side`, and it would be easy to filter structure onto a
// drift by comparing those. kindHits() already measures the real distance from a line to a
// feature, so a quarter-left drift picks up the left-bank holes because they are physically near
// it. One less convention to get backwards, and it is the same join docks and attractors use.
// ---------------------------------------------------------------------------------------------

import { cumulative, kindHits } from './plan-candidates.js';

// THE THREE POSITIONS ARE HIS, AND THE FRACTIONS ARE THE ONES ALREADY MEASURED.
//
// FOUR_THINGS_A_RIVER_DAY_HAS_TO_TELL_HIM_2026-09-16.md measured the Congaree at exactly these
// offsets and found the water under the boat changes by three times the median depth depending on
// which one he takes: quarter-left p50 3 ft, mid-channel p50 5 ft, quarter-right p50 3 ft. So
// "pick a side or the middle" is a bait-depth decision as well as a battery one, and these are
// not new numbers -- they are the ones the measurement was taken at.
export const LATERALS = [
  { key: 'quarter_left', frac: 0.25, label: 'quarter-left, a rod off the left bank' },
  { key: 'mid_channel', frac: 0.50, label: 'mid-channel' },
  { key: 'quarter_right', frac: 0.75, label: 'quarter-right, a rod off the right bank' },
];

// The pack's structure kinds, joined to a drift by real distance. Docks and the state attractor
// feed are deliberately NOT here: selectCandidates() joins those itself for every run it is given,
// and joining them twice would count every dock on the river twice.
export const DRIFT_JOIN_KINDS = ['hole', 'ledge', 'point', 'cove', 'creek_mouth', 'hump',
                                 'timber', 'shallow', 'pile', 'bridge', 'hazard'];

const DEG_LAT_M = 111320;

// ── THE CURRENT, AND WHY THE GUARD IS 2 FT ────────────────────────────────────────────────────
//
// `ampHoursBand()` in plan-water.js has resolved a current against a course since the day it was
// written, charged the component on the nose, and deliberately not floored a following current at
// zero -- which is exactly Ryan's "usage will be close to 0 if there is river current". Nobody has
// ever supplied it. `currentMph` occurs nowhere else in js/ or Worker/. This is where the supply
// starts, because the centreline is the first thing in the app that knows a cross-section.
//
// V = Q/A, and it is only as good as the charted section. On the Congaree 105 of 2,537 stations have
// no charted depth at all and 877 MORE have no charted point deeper than 2 ft -- thin chart, not a
// shallow river, on water that is 76% charted. Dividing 3,000 cfs by one of those sections returns
// 8.30 mph, which is not a river. Reading only the sections with at least two feet somewhere returns
// p10 0.60, p50 0.96, p90 2.17 mph, which is. So 2 ft is where the arithmetic stopped being
// nonsense, measured by the builder before any of this was wired -- not a number anybody liked.
const REAL_SECTION_FT = 2;
const CFS_TO_CMS = 0.0283168466;
const MS_TO_MPH = 2.2369363;

/**
 * The mean of a set of bearings, which is NOT the mean of their numbers.
 *
 * Averaging 350 and 10 arithmetically gives 180 -- a river doubling back on itself -- so the mean
 * is taken on the unit circle. Returns null when the bearings cancel, which is a reach that goes
 * nowhere on average and has no direction to report.
 */
export function meanBearingDeg(degs) {
  let x = 0, y = 0, n = 0;
  for (const d of degs) {
    if (!Number.isFinite(d)) continue;
    const r = (d * Math.PI) / 180;
    x += Math.cos(r); y += Math.sin(r); n++;
  }
  if (!n || (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12)) return null;
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** A point `dxM` east and `dyM` north of [lon, lat]. Flat enough over a channel width. */
function shift(lon, lat, dxM, dyM) {
  const mPerDegLon = DEG_LAT_M * Math.cos((lat * Math.PI) / 180);
  return [lon + dxM / (mPerDegLon || DEG_LAT_M), lat + dyM / DEG_LAT_M];
}

/**
 * A point `offM` to the RIGHT of a station, looking downstream.
 *
 * `bearing_deg` is the downstream bearing, degrees clockwise from north. Right of it is
 * bearing + 90; a negative `offM` therefore lands left. Left and right are named looking
 * downstream, which is the convention the builder stamped `bend_side` and `tributaries[].side`
 * with, so the three agree.
 */
export function offsetPoint(lon, lat, bearingDeg, offM) {
  const rad = ((bearingDeg + 90) * Math.PI) / 180;
  return shift(lon, lat, offM * Math.sin(rad), offM * Math.cos(rad));
}

/** Which column of `depth_profile_ft` a lateral fraction reads. */
export function profileIndexFor(fractions, frac) {
  if (!Array.isArray(fractions) || !fractions.length) return -1;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < fractions.length; i++) {
    const d = Math.abs(Number(fractions[i]) - frac);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * RUN-SHAPED LINES ALONG A RIVER, ONE PER LATERAL POSITION PER REACH.
 *
 * THE REACH LENGTH AND STRIDE ARE DERIVED, NOT PICKED. A reach is `maxM` long -- the ceiling
 * selectCandidates already applies to a leg -- and they start every `maxM / 2`, so every metre of
 * river appears whole inside at least one reach rather than being cut across by a boundary
 * somebody chose. Consecutive reaches therefore overlap by half, and the existing spatial dedupe
 * is what collapses the ones that end up describing the same water: that is what it was written
 * for, and two overlapping reaches through the same holes are the same case as the 15 and 16 ft
 * contours through one pocket.
 *
 * WHAT IS DELIBERATELY ABSENT FROM THE PROPERTIES. `fitted` is not set, because the fitter never
 * saw these lines and a batch may not assert a field it did not compute -- and because
 * selectCandidates derives `fittedAvailable` from the array it is handed, a set containing only
 * drifts switches that gate off by itself rather than by being lied to. `routable` is not set
 * either: the field means the water graph could route this, the graph was never asked, and on a
 * river it should not be -- the charted water's own continuity is 88-99% with no land test at all,
 * and it was the lane routing that was discontinuous, not the river. `depth_ft` is absent because
 * there is no contour behind a drift; the depth comes from the chart, below, or not at all.
 *
 * @param {object} centrelineFc  the pack's centreline.geojson -- one LineString whose properties
 *                               carry parallel per-station arrays
 * @param {object} o
 * @param {object} [o.structures] structureIndex(...) -- without it the lines come back with an
 *                               empty `near[]`, which means every one of them scores zero and
 *                               selectCandidates rejects the lot as scoreless. Say so rather than
 *                               returning legs over water nothing was ever checked against.
 * @param {number} [o.maxM]      the leg ceiling, matched to selectCandidates' own default
 * @param {number} [o.maxOffM]   how far off the line a feature can be and still be on the way
 * @param {string[]} [o.kinds]   which pack kinds to join
 * @param {object[]} [o.laterals] override the three positions, for tests
 * @returns {object[]} GeoJSON LineString features, shaped like trolling_runs.geojson entries
 */
export function riverDriftRuns(centrelineFc, o = {}) {
  const feat = centrelineFc && centrelineFc.features && centrelineFc.features[0];
  const line = feat && feat.geometry && feat.geometry.coordinates;
  const p = (feat && feat.properties) || {};
  if (!Array.isArray(line) || line.length < 2) return [];

  const stationM = p.station_m || [];
  const bearing = p.bearing_deg || [];
  const width = p.width_m || [];
  const profiles = p.depth_profile_ft || [];
  const fractions = p.profile_fractions || [];
  const areaM2 = p.area_m2 || [];
  const deepest = p.deepest_line_ft || [];
  const n = Math.min(line.length, stationM.length, bearing.length, width.length);
  if (n < 2) return [];

  const maxM = o.maxM ?? 8000;
  const maxOffM = o.maxOffM ?? 100;
  const kinds = o.kinds || DRIFT_JOIN_KINDS;
  const laterals = o.laterals || LATERALS;
  const slug = p.slug || o.slug || 'river';
  const strideM = maxM / 2;
  const totalM = Number(p.length_m) || stationM[n - 1] || 0;

  const out = [];
  for (const lat of laterals) {
    const col = profileIndexFor(fractions, lat.frac);
    for (let reachStart = 0; reachStart < Math.max(1, totalM - 1); reachStart += strideM) {
      const reachEnd = reachStart + maxM;
      const coords = [];
      const depths = [];
      const bearings = [];
      const areas = [];
      let charted = 0, stations = 0;
      for (let i = 0; i < n; i++) {
        const sm = Number(stationM[i]);
        if (!(sm >= reachStart && sm <= reachEnd)) continue;
        const w = Number(width[i]);
        const offM = Number.isFinite(w) ? (lat.frac - 0.5) * w : 0;
        coords.push(offsetPoint(line[i][0], line[i][1], Number(bearing[i]) || 0, offM));
        bearings.push(Number(bearing[i]));
        stations++;
        // ONLY A SECTION WITH REAL DEPTH IN IT MAY DIVIDE A DISCHARGE. `deepest_line_ft` is the
        // guard the builder left for exactly this, and a station that fails it is left out of the
        // area rather than dragged into an average where it inflates the velocity.
        const a = Number(areaM2[i]);
        const dl = Number(deepest[i]);
        if (Number.isFinite(a) && a > 0 && Number.isFinite(dl) && dl >= REAL_SECTION_FT) {
          areas.push(a);
        }
        // A NULL HERE IS AN UNCHARTED STATION, NOT SHALLOW WATER. On the Congaree 105 of 2,537
        // stations have no charted depth at all and 877 more have nothing deeper than 2 ft on a
        // river that is 76% charted. Storing a 1 for those would be the `0 ft relief` defect --
        // a missing measurement wearing the clothes of a real one -- so they are counted as
        // uncharted and left out of the mean.
        const row = col >= 0 ? profiles[i] : null;
        const d = Array.isArray(row) ? Number(row[col]) : NaN;
        if (Number.isFinite(d) && d > 0) { depths.push(d); charted++; }
      }
      if (coords.length < 2) continue;
      const cum = cumulative(coords);
      const lengthM = cum[cum.length - 1];
      if (!(lengthM > 0)) continue;

      const near = o.structures
        ? kinds.flatMap((k) => kindHits(coords, cum, o.structures, maxOffM, k))
        : [];

      const props = {
        id: `${slug}:drift:${lat.key}@${Math.round(reachStart)}`,
        slug,
        // What this leg IS, in the vocabulary he used. Carried so the prompt and the card can say
        // "quarter-left, downstream, past three holes" instead of naming a contour that does not
        // exist on moving water.
        drift: { side: lat.key, label: lat.label, frac: lat.frac },
        reachFromM: Math.round(reachStart),
        length_m: Number(lengthM.toFixed(1)),
        near,
        // The stations on this drift that the chart can answer for. Reported beside the depth
        // rather than folded into it, so a thinly charted reach reads as thinly charted.
        charted_stations: charted,
        stations,
        charted_frac: stations ? Number((charted / stations).toFixed(3)) : 0,
      };
      // MEASURED OR ABSENT. `mean_depth_ft` is the name passWaterFt() treats as measured, and on a
      // drift it genuinely is -- the depth along the path travelled, sampled off the chart every
      // 50 m at this lateral position. Where no station on the reach has a charted depth at this
      // position the field is omitted, eligibleForHolding() answers "no charted depth", and the
      // reach is counted in the depth bucket instead of being offered with a number nobody
      // measured.
      if (depths.length) {
        props.mean_depth_ft = Number((depths.reduce((a, b) => a + b, 0) / depths.length).toFixed(1));
        props.shallowest_ft = Math.min(...depths);
        props.deepest_ft = Math.max(...depths);
      }

      // ── WHICH WAY THE WATER IS GOING, AND HOW FAST ────────────────────────────────────────────
      //
      // The bearing is free -- 3DHP's `flowdirection` means vertex order is downstream, so the
      // builder's per-station bearing already points the way the water goes. Until now not one line
      // of js/ or Worker/ carried a flow direction at all; `upstream` and `downstream` appear 164
      // times and every one is a dam chain, a gauge chain or prose.
      //
      // AND THE REASON TRAVELS WITH THE ABSENCE. `current_basis` is always set, because "we asked
      // and the chart cannot answer" and "nobody asked" are different claims and a null with no
      // reason beside it is the hole a model fills from its own recall.
      const meanBearing = meanBearingDeg(bearings);
      if (meanBearing != null) props.flow_deg = Number(meanBearing.toFixed(1));
      const cfs = Number(o.flowCfs);
      if (o.tidal) {
        // Eleven of the 57 carry a NOAA tide station and their current REVERSES. An instantaneous
        // discharge is not the flow there, and Q/A does not describe it at all.
        props.current_basis = 'tidal — the current reverses here, so Q/A does not describe it';
      } else if (!Number.isFinite(cfs)) {
        props.current_basis = 'no discharge reading for this water';
      } else if (!areas.length) {
        props.current_basis = `no station on this reach has ${REAL_SECTION_FT} ft or more of charted `
                            + 'section, so there is nothing honest to divide the discharge by';
      } else {
        // PER STATION, THEN THE MEDIAN — not the discharge over a mean section.
        //
        // The two are not the same and the difference is not academic. Measured on the Congaree, a
        // reach can carry 2 supported stations out of 161, and an area averaged from two sections is
        // one number wearing a reach's clothes. The median of the per-station velocities is also the
        // statistic FOUR_THINGS_A_RIVER_DAY_HAS_TO_TELL_HIM measured this river with, so computing it
        // the same way means this wiring can be CHECKED against that measurement instead of merely
        // believed — and it reproduces it exactly: p10 0.60, p50 0.96, p90 2.17 mph at 3,000 cfs.
        const v = areas.map((a) => (cfs * CFS_TO_CMS / a) * MS_TO_MPH).sort((x, y) => x - y);
        const mid = v.length % 2
          ? v[(v.length - 1) / 2]
          : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
        props.current_mph = Number(mid.toFixed(2));
        // THERE IS ONE ANGLE HERE AND IT IS `flow_deg`, WHICH IS WHERE THE WATER IS GOING.
        //
        // The first version also emitted `current_deg` set to the same value, which was a trap:
        // `headwindMph()` follows the meteorological convention and wants the direction a flow comes
        // FROM, so a field named for a current and holding a heading it is going TO is 180 degrees
        // wrong the first time somebody passes it straight through. Two names for one angle with
        // opposite meanings is the defect this project keeps finding, so there is one name, it means
        // the plain-English thing, and the conversion happens at the point of use with a note on it.
        // See the cost in plan-candidates.js.
        props.current_area_m2 = Number((areas.reduce((a, b) => a + b, 0) / areas.length).toFixed(1));
        // HOW MUCH OF THE REACH IS BEHIND THAT NUMBER, as a field and not only as prose. A velocity
        // from 2 of 161 stations and one from 150 of 161 deserve different amounts of trust, and NO
        // THRESHOLD IS INVENTED HERE — whoever consumes it picks, which is the same rule the bend
        // radius follows. What is not acceptable is offering the number with the support invisible.
        props.current_stations = areas.length;
        props.current_frac = Number((areas.length / Math.max(1, stations)).toFixed(3));
        props.current_basis = `Q/A — median of ${areas.length} station velocities at `
                            + `${Math.round(cfs).toLocaleString()} ft3/s, ${areas.length} of `
                            + `${stations} stations carrying ${REAL_SECTION_FT} ft or more of `
                            + 'charted section';
      }
      out.push({ type: 'Feature',
                 geometry: { type: 'LineString', coordinates: coords },
                 properties: props });
    }
  }
  return out;
}
