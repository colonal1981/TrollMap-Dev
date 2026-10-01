/**
 * saved-plan-alerts.js -- a saved plan, put back into the shape the trip alerts read.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Item 20, still open after 2026-09-26: the trip alerts armed when a plan was BUILT and never when
 * one was LOADED. Ryan, 2026-09-25, the night before Wateree with Murray two days later: "can't
 * build it now or it will change the alerts to fire on the murray plan instead of the wateree one
 * lol". The watch has been one per fishing day since `6820d25`, so building the next trip no
 * longer moves it. What was left: a plan brought back from Saved Plans or a JSON file -- after a
 * refresh, or on the other machine -- drew its legs and armed nothing, and the page said so.
 *
 * The reason given was that the alerts need each leg's own geometry and stops, and the saved file
 * keeps the geometry as tracks rather than on the legs. Both are in the file:
 *
 *   - each leg's line is `gpx.trackList`, named `L1 · ...` / `T1 · transit`, in [lat, lon];
 *   - each stop is a `stop_and_cast` entry of the timeline, with its id, its leg, its position
 *     and how far into the leg it is.
 *
 * So this reads them back onto the legs, in the [lon, lat] every geometry in the plan uses, and
 * hands back what loadSessionFromPlan() is handed on the build path. NOTHING IS RE-ASKED and
 * nothing is recomputed that the file already says.
 *
 * THE LAUNCH IS THE PLAN'S OWN FIRST POINT. The assembler joins the first move to the ramp it was
 * costed from (joinEnds() in plan-assemble.js), so the first leg's first coordinate IS the ramp,
 * and so is the run home's last one. No ramp lookup that could pick a neighbouring launch.
 *
 * A DAY THAT HAS GONE BY IS NOT ARMED. The Worker would keep a watch for 24 h from now and poll
 * the weather for a lake he is not on. That is not a threshold: it is the date on the plan
 * against today's.
 */

const legIdOf = (name) => String(name == null ? '' : name).split('·')[0].trim();

// [lat, lon] arrays from planTracks(), or {lat, lon} from anything older; [lon, lat] out.
const lonLat = (pt) => {
  if (Array.isArray(pt)) {
    const lat = Number(pt[0]), lon = Number(pt[1]);
    return Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : null;
  }
  if (pt && Number.isFinite(Number(pt.lat)) && Number.isFinite(Number(pt.lon))) {
    return [Number(pt.lon), Number(pt.lat)];
  }
  return null;
};

const localDay = (d) => {
  const t = d instanceof Date ? d : new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

/**
 * @param {object} p      a saved plan file, as collectPlan() writes it
 * @param {Date}  [now]   today, for "has this day gone by"
 * @returns {{plan:object, launch:{lat:number,lon:number}, date:string, returnTime:string|null,
 *            water:string|null, slug:string|null, positions:number}
 *          | {plan:null, why:string}}
 */
export function alertsFromSaved(p, now = new Date()) {
  const plan = p && p.plan;
  if (!plan || !Array.isArray(plan.legs) || !plan.legs.length) {
    return { plan: null, why: 'the file carries no plan block' };
  }
  const meta = (p && p.meta) || {};
  const date = String(meta.date || (plan.meta && plan.meta.date) || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { plan: null, why: 'the plan has no date' };
  if (date < localDay(now)) return { plan: null, why: `${date} has gone by` };

  const lines = new Map();
  for (const t of ((p.gpx && p.gpx.trackList) || [])) {
    const id = legIdOf(t && t.name);
    if (!id || lines.has(id) || !Array.isArray(t.pts)) continue;
    const co = t.pts.map(lonLat).filter(Boolean);
    if (co.length >= 2) lines.set(id, co);
  }

  const stopsOn = new Map();
  const timeline = (Array.isArray(p.unifiedTimeline) && p.unifiedTimeline.length)
    ? p.unifiedTimeline : (Array.isArray(p.timeline) ? p.timeline : []);
  for (const e of timeline) {
    if (!e || e.type !== 'stop_and_cast') continue;
    const legId = e.parentLegId || e.legId;
    const at = lonLat({ lat: e.lat, lon: e.lon });
    if (!legId || !at) continue;
    if (!stopsOn.has(legId)) stopsOn.set(legId, []);
    stopsOn.get(legId).push({
      id: e.id, at, atM: Number.isFinite(e.atLegM) ? e.atLegM : 0,
      structure: e.name || e.targetStructure || 'stop and cast',
      depthFt: e.targetDepth ?? null,
    });
  }

  const legs = plan.legs.map((l) => ({
    ...l,
    coordinates: lines.get(l.id) || l.coordinates || null,
    stops: stopsOn.get(l.id) || [],
  }));
  const first = legs[0].coordinates;
  const home = legs.filter((l) => l.role === 'return').map((l) => l.coordinates).find(Boolean);
  const ramp = (first && first[0]) || (home && home[home.length - 1]) || null;
  if (!ramp) return { plan: null, why: 'the file carries no line for the first leg' };

  const positions = legs.filter((l) => Array.isArray(l.coordinates)).length;
  return {
    plan: { ...plan, legs },
    launch: { lat: ramp[1], lon: ramp[0] },
    date,
    returnTime: meta.returnTime || (plan.meta && plan.meta.returnTime) || null,
    water: meta.lake || (plan.meta && plan.meta.water) || null,
    slug: (plan.meta && plan.meta.slug) || null,
    positions,
  };
}
