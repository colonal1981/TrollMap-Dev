// Personal use only, not for distribution or resale; not for navigation.
/**
 * EVERY FISH ID GOES TO CLAUDE ON THIS PC FIRST, AND GEMINI WHEN IT IS NOT THERE.
 *
 * Ryan, 2026-10-08. The Gemini ID called both rig shots and the deck shot at his 0007 triple "on
 * the board", because the yellow board was in the frame behind them: *"what AI did you use... it
 * should be using Claude Opus 5.5 same as what i am talking to you on and you can tell the
 * difference lol"*, *"if its not then use the same route that smartplan now uses for the plans"*,
 * and, asked whether that was every fish or only a mark with several, *"All fish to claude"*.
 *
 * The route is the plan bridge (Scripts/claude_plan_bridge.py, POST /look; claudeLook() in
 * js/modules/claude-bridge.js). The questions are claude_fish_sorter.py's, which sorted and
 * measured his 2023-2026 photos: the same day's 7 photos went to it on Opus 5.5 on his PC and it
 * named the two rig shots and the deck shot as not on the board and the other four as four fish.
 * The sizes are its too. This file only builds the questions and reads the answers; nothing here
 * touches the network or the page.
 */

// The sorter's sizes (claude_fish_sorter.py SORT_PX, MEASURE_PX): enough to see a fish, a board and
// a lure; and the size Claude reads an image at -- anything larger is scaled down to it.
export const SORT_PX = 768;
export const MEASURE_PX = 1568;

/** The first JSON object in an answer, or an Error saying there was none. */
export function jsonOf(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error(`no JSON object in the answer: ${s.split(/\s+/).join(' ').slice(0, 300)}`);
  return JSON.parse(s.slice(a, b + 1));
}

/**
 * WHICH PHOTOS AT A MARK ARE ON THE BOARD: claude_fish_sorter.py's SORT_ASK, for the photos after one
 * waypoint. Each photo is sent after a label from photoLabel().
 */
export function sortPrompt(n, day, species) {
  return `These are ${n} photos from Ryan's phone, taken on ${day} after one waypoint he marked at a bite, in the order taken. Each one is
labelled just before it with its number and the time it was taken.

He fishes from a kayak and photographs what he catches: often the fish with the lure still in its
mouth, then the fish lying on a yellow bump board (a measuring board with printed inch numbers),
sometimes the fish held in his hand. Several fish can share one mark (a multi-hook A-rig): a photo
of fish on the rig or on the deck is not a board shot, even with the board somewhere in the frame.
The other photos are anything else -- the water, the kayak, gear, people, screens, scenery.

Return ONE JSON object and nothing else:
{"photos": [{"i": 1, "fish": true, "board": false, "held": true, "lure_shot": false, "what": "up to 12 words"}],
  "fish": [{"photos": [1, 2], "board_photo": 2, "best_photo": 2, "species_guess": "...", "why_same_fish": "up to 15 words"}]}

- "photos": every photo, by its number. "board" is true only for a fish lying on the bump board.
- "fish": ONE entry for each fish caught. Photos of the same fish -- several angles, a burst, the
  lure shot and then the board shot -- go in one entry. A second fish is its own entry even if it
  looks alike and was minutes apart: tell them apart by size, markings, the lure, the setting and
  the time. A photo with no fish is in no entry.
- "board_photo": the clearest photo of that fish on the bump board, mouth at the bump; null if none.
- "species_guess": one of ${JSON.stringify(species)}, or "Unknown".
`;
}

/** "Photo 3 -- 15:03:37", the label each photo goes after. */
export const photoLabel = (i, hms) => `Photo ${i} -- ${hms}`;

/** The 1-based numbers of the photos the sort answer put on the board. */
export function boardsOf(answer, n) {
  const out = new Set();
  for (const p of (answer && answer.photos) || []) {
    if (Number.isInteger(p.i) && p.i >= 1 && p.i <= n && p.board === true && p.fish !== false) out.add(p.i);
  }
  return out;
}

/**
 * ONE FISH'S SPECIES AND LENGTH: claude_fish_sorter.py's MEASURE_ASK. Photo A is the board shot, and
 * the lure shot, when there is one, goes after it as Photo B.
 */
export function measurePrompt({ day, time, lat, lon, species }) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const where = num(lat) && num(lon) ? ` near ${lat.toFixed(5)}, ${lon.toFixed(5)}` : '';
  return `Photo A is the board shot of one fish Ryan caught on ${day} at ${time}${where}. The
other photos, if any, are the same fish from other angles.

Read two things:
- "species": one of ${JSON.stringify(species)}.
- "length_in": the length on the bump board -- mouth against the bump, read where the tip of the
  tail reaches on the board's printed inch numbers -- to the nearest 0.25 inch. null if the numbers
  at the tail cannot be read, the mouth is off the bump, or the tail is off the board.

Return ONE JSON object and nothing else:
{"species": "...", "length_in": 22.25, "confidence": "high|medium|low",
  "how_read": "which printed numbers you read the tail against, up to 25 words",
  "problems": ["anything that makes the length or the species doubtful"]}
`;
}

/**
 * The measure answer in the shape the review queue already reads from the Gemini ID
 * (`species`, `lengthInches`, `confidence`, `notes`, `on_bump_board`, ...), plus the model that
 * answered. A species not on the app's list is kept in the notes and comes in as "Other Fish", so the
 * review form can show it.
 */
export function aiFromMeasure(answer, model, species) {
  const a = answer || {};
  const named = typeof a.species === 'string' ? a.species.trim() : '';
  const known = species.includes(named);
  const len = Number(a.length_in);
  const problems = Array.isArray(a.problems) ? a.problems.filter(Boolean) : [];
  return {
    species: known ? named : 'Other Fish',
    lengthInches: a.length_in == null || !Number.isFinite(len) ? null : len,
    confidence: ['high', 'medium', 'low'].includes(a.confidence) ? a.confidence : 'low',
    notes: [
      known || !named ? '' : `Claude named it "${named}", which is not on the list.`,
      a.how_read ? `Read off the board: ${a.how_read}` : '',
      problems.length ? `Doubts: ${problems.join('; ')}` : '',
    ].filter(Boolean).join(' '),
    has_fish: true,
    on_bump_board: true,
    board_detected: true,
    length_source: a.length_in == null ? '' : 'board',
    model: model ? `Claude ${model} (this PC)` : 'Claude (this PC)',
  };
}
