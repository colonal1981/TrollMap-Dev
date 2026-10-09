/**
 * catch-pins.js — which of his catches the map and the plans may use.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-10-04, looking at Wyboo Creek from Rowland Subdivision on Lake Marion: "i am seeing
 * fish on land in this area still... we need to fix this somehow". Asked how, he wrote the rule:
 *
 *   > honestly if it is showing off water it should be filtered from the app... fish with either no
 *   > position or incorrect position should not make it into the app... going forward and the way i
 *   > have done it the last couple of times with the gpx and the catch photo this shouldn't be a
 *   > problem
 *
 * The positions are where the PHONE said the photo was taken (catch-journal.js imports them from
 * the photo's sidecar). On some days the phone wrote a fix on the bank, in a yard, or kilometres
 * inland. Since 9/27 he marks a waypoint on the Garmin when a fish bites (catch-waypoints.js), so a
 * new catch carries the unit's fix -- this is the old photos' problem.
 *
 * THE JOURNAL IS NOT TOUCHED. Nothing here deletes or edits a catch: the synced journal is his
 * record, and the Catch Center still lists every row. The map and the plans read through these.
 */

/**
 * Two photos of one fish are one fish: the same species, the same date and minute, within
 * SAME_SPOT_M of each other. That is his wander off a line -- the 25 m the loop measures the bottom
 * over (plan-troll-loop.js) and the cell of its grid -- and the phone's fixes for one fish land
 * 0-9 m apart (2024-10-13 flounder, 9 m; 2025-11-25 2:13 PM hybrid, 2 m). On 10/4 the journal held
 * 17 fish saved once per photo (a 2024-10-25 trout four times), each photo a catch of its own: the
 * 11/23 1:20 PM striper on Marion, two photos a second apart, counted twice in the loop's depth.
 *
 * A row the sorter marked as a second fish in one photo (`<photo>#2`, his "2 fish lol" of
 * 2024-04-22) is a fish of its own and is never folded.
 *
 * NOR IS A FISH LOGGED AT A GARMIN WAYPOINT. The nightly upload makes one row per board shot, so
 * every row with a `waypoint` is one fish already, and several fish at one mark share its minute
 * and its spot: his three stripers at 0007 on 2026-10-08 (*"The first 3 fish were all caught at the
 * same time at waypoint 0007"*) were folded into one here, in the map and in the plans' depth.
 */
export const SAME_SPOT_M = 25;

const M_PER_DEG_LAT = 110540;

/** A catch with a usable position: both numbers, and not the 0,0 an empty field parses to. */
export function hasPosition(c) {
  if (!c) return false;
  const lat = parseFloat(c.lat), lon = parseFloat(c.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
}

const secondFish = (c) => /#\d+$/.test(String((c && c.sourceFile) || ''));
const markedFish = (c) => !!(c && c.waypoint && (c.waypoint.name || c.waypoint.time));
const minuteOf = (c) => String((c && c.time) || '').trim().toUpperCase().replace(/\s+/g, ' ');
const apartM = (a, b) => {
  const la = parseFloat(a.lat), lb = parseFloat(b.lat);
  const kx = 111320 * Math.cos(((la + lb) / 2) * Math.PI / 180);
  return Math.hypot((la - lb) * M_PER_DEG_LAT, (parseFloat(a.lon) - parseFloat(b.lon)) * kx);
};

/**
 * The catches with each fish once: the first row of a fish's photos stands for it. Rows without a
 * position or a time are left as they are -- with nothing to match them on, they are not folded.
 *
 * @param {object[]} catches  journal rows
 * @returns {object[]}        the same objects, fewer of them, in their order
 */
export function oneFishEach(catches) {
  const out = [];
  const kept = new Map();   // species|date|minute -> rows kept
  for (const c of (catches || [])) {
    if (!c) continue;
    const minute = minuteOf(c);
    if (!hasPosition(c) || !c.date || !minute || secondFish(c) || markedFish(c)) { out.push(c); continue; }
    const k = `${String(c.species || '').trim().toLowerCase()}|${c.date}|${minute}`;
    const same = kept.get(k);
    if (same && same.some((o) => apartM(o, c) <= SAME_SPOT_M)) continue;
    if (same) same.push(c); else kept.set(k, [c]);
    out.push(c);
  }
  return out;
}

/**
 * WHETHER A CATCH IS SHOWN OFF THE WATER IT IS FILED UNDER: its lake resolves to this water, and its
 * pin is on neither the water's depth chart nor inside its boundary. Both, because the chart is
 * Garmin's survey and stops short of water nobody sounded -- the body of Bates Old River has no
 * bathymetry, and it is inside the Congaree's boundary (SETTLED, 2026-08-13) -- while the boundary
 * stops at the bank.
 *
 * A catch filed under another water, or under a name that resolves to none, is not this water's to
 * judge: false. So is any catch when neither test is in hand.
 *
 * @param {object} c
 * @param {object} water
 * @param {string} water.key                    the water's pack key
 * @param {function(string): ?string} water.keyOf  a lake name to its pack key (resolveR2Key)
 * @param {?function(number[]): ?number} [water.depthAt]  chart depth at [lon, lat], null off it
 * @param {?function(number, number): boolean} [water.inside]  (lon, lat) inside its boundary
 */
export function pinOffItsWater(c, water) {
  if (!water || !water.key || !hasPosition(c)) return false;
  if (!water.depthAt && !water.inside) return false;
  let key = null;
  try { key = water.keyOf ? water.keyOf(String(c.lake || '')) : null; } catch (_) { key = null; }
  if (!key || key !== water.key) return false;
  const lon = parseFloat(c.lon), lat = parseFloat(c.lat);
  if (water.depthAt && water.depthAt([lon, lat]) != null) return false;
  if (water.inside && water.inside(lon, lat)) return false;
  return true;
}
