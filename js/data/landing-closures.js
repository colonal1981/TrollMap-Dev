/**
 * landing-closures.js -- whether a landing is closed: from the operator's own alerts first, and a short list for what no
 * feed carries.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 11/8, of the area bar on Wateree: "for taylor creek or colonel creek this should tell you to launch at those
 * instead maybe?", and "i think taylors landing is closed temporarily because of a invasive grass". So an area names
 * the landing nearest it by water when that is not his ramp (plan-areas.js), and a closure known for it is said beside
 * it with its source and the date.
 *
 * FROM DUKE, NOT FROM A LIST. Ryan, 11/22, with a screenshot of Duke's Lake Views alerts (Taylors Creek closed 9/18 for
 * up to 12 months, Buck Hill closed 3/2 for about a year): "The app should be pulling these from duke?", and then "area
 * box check should be as automated as possible... you know i despise hand written lists if we can avoid it... i know
 * somethings are things i just know that aren't as available... even a google search didn't directly show lakeside as
 * closed". The app already reads Duke's access-alerts for every Duke water (Worker/conditions.js, `accessAlerts` on the
 * water's state); `dukeClosureFor()` reads a landing's closure out of them, so one closes and reopens with Duke's notice.
 * LANDING_CLOSURES keeps only what no feed carries, each with who said so; one that comes back open is a line taken out.
 */

export const NEAR_M = 300;

export const LANDING_CLOSURES = Object.freeze([
  // Ryan, 2026-11-22: "lakeside went out of business and is for sale". A private marina: in no operator's feed.
  Object.freeze({
    water: 'wateree_lake', name: 'Lakeside Marina', at: [-80.6993, 34.3641],
    why: 'out of business and for sale', source: 'Ryan', read: '2026-11-22',
    // and the listing he pasted the same night: "formerly operating as a Lakeside Marina Bait & Tackle Shop", MLS 636646
    url: 'https://www.carolinaone.com/p/2163-John-G-Richards-Road-Camden-SC-29020/dmgid_187573307',
  }),
]);

const metres = (a, b) => {
  const kx = 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110540);
};

// ── A LANDING'S NAME, AS TWO SOURCES SPELL IT ─────────────────────────────────────────────────────────────────────────
// Duke writes "Taylors Creek Access Area" and "Buck Hill Access Area"; the landings list has "Taylor Creek" and
// "Buckhill Landing". The words that only say what kind of place it is go, a trailing s goes, and the spaces go.
const KIND_WORDS = new Set(['access', 'area', 'landing', 'boat', 'ramp', 'public', 'launch', 'site', 'the', 'park', 'recreation']);
export function landingKey(name) {
  return String(name || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((w) => w && !KIND_WORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join('');
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const isoOf = (m, d, y) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Whether one of Duke's alerts says its place is shut on `date` (YYYY-MM-DD; today when absent), as a closure
 * {why, source, read, url?, duke}; null when it says nothing of a closure, says the place has reopened, or closes later.
 */
export function closureInAlert(alert, date = null) {
  const text = String((alert && alert.text) || '').replace(/\s+/g, ' ').trim();
  if (!/\bclos(e|ed|es|ing|ure)\b/i.test(text)) return null;
  if (/\b(has|have|is now|are now) re-?opened\b|\bnow (re-?)?open\b/i.test(text)) return null;
  // "The boat ramp will remain open, though brief closures may occur" (Riverbend, Mountain Island, 11/22) is open.
  if (/\b(ramp|access area|landing)s? (will )?remains? open\b/i.test(text)) return null;
  // "will close on March 2, 2026" (Buck Hill), "will be closed beginning November 30, 2026" (Conley Creek): shut from
  // that day, not before it.
  const m = /(?:will close on|closed? beginning|closing on)\s+(?:approximately\s+)?([A-Za-z]+)\.? (\d{1,2}),? (\d{4})/i.exec(text);
  const day = date || new Date().toISOString().slice(0, 10);
  if (m) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    if (mo > 0 && isoOf(mo, Number(m[2]), Number(m[3])) > day) return null;
  }
  // What it says: its first sentence, with any "Place: Mon D, YYYY -" heading taken off the front.
  const body = text.replace(/^[^:]{0,80}:\s*[A-Za-z]{3,9} \d{1,2}, \d{4}\s*-\s*/, '');
  const first = (body.match(/^.*?[.!?](?=\s|$)/) || [body])[0].trim();
  const updated = String((alert && alert.last_updated) || '').slice(0, 10);
  return {
    why: first.length > 160 ? `${first.slice(0, 157)}…` : first,
    source: 'Duke Energy', read: updated || day,
    ...(alert && Array.isArray(alert.links) && alert.links[0] ? { url: alert.links[0] } : {}),
    duke: true,
  };
}

/** The closure Duke's alerts give for this landing ({name}), or null. `alerts` are the water's own (`accessAlerts`). */
export function dukeClosureFor(alerts, landing, date = null) {
  const key = landingKey(landing && landing.name);
  if (!key || !Array.isArray(alerts)) return null;
  for (const a of alerts) {
    const k = landingKey(a && a.place);
    if (!k) continue;
    const same = k === key || (Math.min(k.length, key.length) >= 6 && (k.includes(key) || key.includes(k)));
    if (!same) continue;
    const c = closureInAlert(a, date);
    if (c) return c;
  }
  return null;
}

/**
 * The closure known for this landing ({name, lon, lat} or {name, at}) on this water, or null: Duke's alerts first
 * (`o.alerts`, the water's `accessAlerts`, on `o.date`), then LANDING_CLOSURES.
 */
export function closureFor(slug, landing, o = {}) {
  const duke = dukeClosureFor(o.alerts, landing, o.date || null);
  if (duke) return duke;
  const at = Array.isArray(landing && landing.at) ? landing.at
    : landing && Number.isFinite(Number(landing.lon)) && Number.isFinite(Number(landing.lat)) ? [Number(landing.lon), Number(landing.lat)] : null;
  if (!slug || !at) return null;
  return LANDING_CLOSURES.find((c) => c.water === slug && metres(c.at, at) <= NEAR_M) || null;
}
