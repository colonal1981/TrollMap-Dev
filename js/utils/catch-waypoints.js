/**
 * catch-waypoints.js -- the waypoint marked at the bite is the catch, and the photos after it are
 * that fish's pictures.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-09-27, after his two Bates Old River bowfin:
 *
 *   "my standard process from here on is going to be to mark a waypoint when the fish bites and
 *   then reel it in and take the photos like said above... the reason for the waypoint is because
 *   of the phone location issue and it gives water depth for the fish"
 *
 * and on the photos themselves:
 *
 *   "i do normally shoot the lure first because i take a pic of the fish with the lure in its
 *   mouth... then remove the lure and stow the rod then take a pic of the fish and then return the
 *   fish to water"
 *
 * WHAT THE NIGHTLY DROP DID BEFORE. It paired photos taken within 90 seconds of each other and
 * called the EARLIER one the fish. On his 9/27 fish both halves were wrong: he shoots the lure
 * first, and the second bowfin's photos were 112 s apart because the hook was stuck behind its
 * teeth -- "it all depends on how hard it is to remove the hook". The window would have split
 * that fish into two, and sent the lure shot of the first one to the fish ID.
 *
 * A waypoint needs no window. The rules, and where each one comes from:
 *
 *   - A photo belongs to the LATEST MARKED WAYPOINT BEFORE IT, on the same day. The waypoint is
 *     marked at the bite and the photos come after he lands it, so "after this mark and before
 *     the next" is his own process, not a tolerance. The same-day rule is there because the unit
 *     keeps old marks and exports them every time: a fish he forgets to mark next trip must not
 *     land on a 9/27 waypoint.
 *
 *   - A waypoint that SHARES ITS TIMESTAMP with another was LOADED onto the unit, not marked on
 *     the water. His 9/27 export has 59 waypoints; 57 of them are stamped 2026-09-26T02:23:01Z,
 *     the moment a TrollMap plan went onto the chartplotter. Only 0002 and 0003 have a time of
 *     their own. A loaded waypoint is never a catch.
 *
 *   - The FIRST photo after a waypoint is the lure shot and the SECOND is the board shot. The
 *     board shot is the one that goes to the fish ID.
 *
 *   - MORE THAN TWO PHOTOS AFTER ONE MARK IS SEVERAL FISH AT THAT MARK. Ryan, 2026-10-08, three
 *     fish at once on A-rigs at 0007 ("2 of them on the same A-rig and the third was on its own"):
 *     *"will trollmap be able to assign waypoint 0007 to the 3 fish since i caught them all at
 *     once"*. His five photos were rig, rig, board, board, board -- so ORDER cannot say which is
 *     which, and the third photo is not a lure shot. Such a mark comes back with `several: true`
 *     and all its `photos`; the drop asks the fish ID which of them are on the board, and
 *     `fishAtMark()` makes one fish per board shot. Until 2026-10-08 the third photo was handed
 *     back unanchored as `after_waypoint_pair`, which turned his triple into one catch whose
 *     "board shot" was three fish on the deck, plus two rows with no position.
 *     A forgotten mark now lands its fish on the mark before it, with that mark's position; the
 *     row says how many fish shared the mark, so it is checked rather than hidden.
 *
 *   - Depth and water temperature are the SOUNDER'S AT THE MARK. Garmin writes them into the
 *     waypoint's <extensions> in metres and degrees C (`parseGPX()` reads them).
 *
 * Nothing here touches the DOM. Times are epoch seconds; the photo times come from EXIF read in
 * the phone's local clock, which is the browser's clock on the PC he drops them from.
 */

/** Local wall-clock ISO, no zone: 2026-09-27T14:53:27. The journal stores local date and time. */
export function localIso(epochS) {
  const d = new Date(epochS * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
       + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function localDay(epochS) {
  return localIso(epochS).slice(0, 10);
}

/**
 * Split a GPX's waypoints into the ones marked on the water and the ones that were loaded.
 * `marked` is sorted by time and each carries `epochS`.
 */
export function markedWaypoints(waypoints) {
  const at = (w) => Date.parse(w && w.time ? w.time : '');
  const count = new Map();
  for (const w of waypoints || []) {
    const t = at(w);
    if (Number.isFinite(t)) count.set(t, (count.get(t) || 0) + 1);
  }
  const marked = [], loaded = [], untimed = [];
  for (const w of waypoints || []) {
    const t = at(w);
    if (!Number.isFinite(t)) untimed.push(w);
    else if (count.get(t) > 1) loaded.push(w);
    else marked.push({ ...w, epochS: t / 1000 });
  }
  marked.sort((a, b) => a.epochS - b.epochS);
  return { marked, loaded, untimed };
}

/**
 * Group photos under the waypoint each one follows.
 *
 * photos:    [{ timestamp (epoch s), ... }]   -- extractExif()'s items
 * waypoints: [{ time (ISO), name, lat, lon, depthM, tempC, ... }]  -- parseGPX()'s waypoints
 *
 * Returns
 *   catches:    [{ waypoint, lure, board, onePhoto, several, photos }]  in waypoint order. `lure`
 *               is null when only one photo followed the mark; that photo is then the one sent to
 *               the ID. With more than two photos, `several` is true, `lure` and `board` are null,
 *               and `photos` holds them all in time order -- see fishAtMark().
 *   unanchored: [{ photo, reason, waypoint? }]  every photo not in a catch, with why:
 *               'no_photo_time', 'no_waypoint_before', 'waypoint_other_day'
 *   marked, loaded, untimed: counts, for the status line.
 *
 * `dayOf` is the local-day function; a parameter only so a test can pin it.
 */
export function groupPhotosByWaypoint(photos, waypoints, dayOf = localDay) {
  const { marked, loaded, untimed } = markedWaypoints(waypoints);
  const sorted = [...(photos || [])].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const byMark = new Map();
  const unanchored = [];

  for (const photo of sorted) {
    const ts = photo.timestamp;
    if (!Number.isFinite(ts)) { unanchored.push({ photo, reason: 'no_photo_time' }); continue; }
    let mark = null;
    for (const m of marked) {
      if (m.epochS <= ts) mark = m; else break;
    }
    if (!mark) { unanchored.push({ photo, reason: 'no_waypoint_before' }); continue; }
    if (dayOf(mark.epochS) !== dayOf(ts)) {
      unanchored.push({ photo, reason: 'waypoint_other_day', waypoint: mark });
      continue;
    }
    if (!byMark.has(mark)) byMark.set(mark, []);
    byMark.get(mark).push(photo);
  }

  const catches = [];
  for (const [waypoint, ps] of byMark) {
    if (ps.length > 2) {
      catches.push({ waypoint, lure: null, board: null, onePhoto: false, several: true, photos: ps });
      continue;
    }
    const two = ps.length === 2;
    catches.push({ waypoint, lure: two ? ps[0] : null, board: two ? ps[1] : ps[0], onePhoto: !two,
                   several: false, photos: ps });
  }
  catches.sort((a, b) => a.waypoint.epochS - b.waypoint.epochS);
  unanchored.sort((a, b) => (a.photo.timestamp ?? 0) - (b.photo.timestamp ?? 0));
  return { catches, unanchored, marked: marked.length, loaded: loaded.length, untimed: untimed.length };
}

/**
 * Several fish at one mark: one fish per BOARD SHOT, each with a lure shot taken before it.
 *
 * photos:  the mark's photos (any order; sorted here by time)
 * isBoard: photo -> true when the fish ID saw a fish on the bump board
 *
 * The k-th board shot gets the k-th lure shot taken before it, or the last one before it when
 * there are more fish than lure shots -- his 10/08 triple was rig, rig, board, board, board, with
 * two fish on one rig. Which lure shot goes with which fish is not knowable from the photos and
 * does not need to be: he names the lure himself in review, looking at the shot.
 *
 * Returns [{ board, lure }] in time order, or null when no photo is a board shot -- the caller
 * then keeps every photo as its own row at the mark, so nothing is dropped on a missed board.
 */
export function fishAtMark(photos, isBoard) {
  const ps = [...(photos || [])].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const boards = ps.filter(p => isBoard(p));
  if (!boards.length) return null;
  const lures = ps.filter(p => !boards.includes(p));
  return boards.map((board, k) => {
    const before = lures.filter(l => (l.timestamp ?? 0) <= (board.timestamp ?? 0));
    return { board, lure: before.length ? before[Math.min(k, before.length - 1)] : null };
  });
}

const round1 = (x) => Math.round(x * 10) / 10;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * The sounder's readings at the mark, in the units the journal uses. A missing reading is null,
 * never 0: 0 m is not a depth anyone fished and 0 C is a real water temperature.
 */
export function waypointReadings(w) {
  return {
    depthFt: w && isNum(w.depthM) ? round1(w.depthM / 0.3048) : null,
    waterTempF: w && isNum(w.tempC) ? round1(w.tempC * 9 / 5 + 32) : null,
  };
}

/** "71 s", "2 min 35 s", "1 h 12 min" -- how long after the mark a photo was taken. */
export function fmtGap(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m} min ${r} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
