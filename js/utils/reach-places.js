/**
 * reach-places.js -- where a piece of a river is, in the words a web page would use, and which of
 * its facts and documents are about a different piece.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS EXISTS. Ryan, 2026-09-24, on the upper Saluda's research profile: "how do we fix the
 * slim upper saluda research then? How do we ensure we get facts for the correct area". Measured
 * the same day by this file's own sort: of the 76 facts on saluda_river_sc, 28 name a place on the
 * LOWER Saluda -- "Lower Saluda" itself, Columbia, Riverbanks, Saluda Shoals Park -- and 10 name
 * one of the mountain forks. Every discovery query was `"Saluda River" ...`, and on the web that
 * phrase mostly means the tailwater in Columbia.
 *
 * THE REGISTRY ALREADY KNOWS WHERE EACH PIECE IS. Each river row carries its launches, and
 * water_bindings.json its gauges, and a USGS/NWS gauge is named in a fixed grammar -- river,
 * locative, place: "Saluda River near WARE SHOALS", "SALUDA RIVER NEAR PELZER, S. C.". Run by hand
 * the same day, `"Saluda River" "Ware Shoals" fishing` returned the Upper Saluda River Blueway map,
 * gopaddlesc's Maddox Bridge to Ware Shoals Dam trip and two catfish threads; `"Saluda River"
 * Chappells fishing` returned the Buzzard's Roost to Chappells spotted-bass trips; the plain
 * seasonal query returned the Lower Saluda, the North Saluda's trout and Lake Murray.
 *
 * SO THREE THINGS, ALL DERIVED, NONE TYPED IN:
 *   researchGroup()   the registry rows that are ONE piece of research -- the rows whose names
 *                     store to the same research id (js/data/research-ids.js decides that).
 *   siblingsOf()      the other rows of the same river that are NOT in the group.
 *   reachPlaces()     the group's own places (to search on) and each sibling's (to sort by).
 * and two sorters that use them:
 *   sortFacts()       a fact that names a sibling's place and none of the group's is the
 *                     sibling's fact, not this water's.
 *   sortDocuments()   the same test on a document's TITLE -- "Lower Saluda River - Congaree
 *                     Riverkeeper" is the Lower Saluda's document, whatever else it mentions.
 *
 * NOTHING HERE DELETES. The sorters return what belongs elsewhere, with the sibling and the place
 * that decided it, so the caller can report it and nothing disappears unexplained.
 *
 * Pure: no DOM, no fetch, no registry loading. Scripts/reach_places.mjs runs it for
 * research_lakes.py, the way gate_documents() runs doc-relevance.js.
 */

// USGS and NWS station names: `<river> <locative> <place>[, <locative> <place>]*`. The
// abbreviations are the agencies' own -- NR, AB, BL, ABV, BLW -- not a guess at them.
const LOCATIVE = /\b(?:at|near|nr|above|abv|ab|below|blw|bl|upstream of|downstream of)\b/i;
// `in` splits but never starts: "Dan River at Central Blvd in Danville" is on the Dan at a street,
// in a town. Measured over the 57 rivers, leaving it out gave queries for "in Hot Springs".
const LOCATIVE_SPLIT =
  /\s*(?:,|\b(?:at|near|nr|above|abv|ab|below|blw|bl|upstream of|downstream of|in)\b)\s*/i;
// The shape a place name has: letters, spaces, and the punctuation proper names carry. A piece
// with a digit in it is a road or a station number -- "I-85", "SC 124", "#5", "GE PLANT 1".
const PLACE_SHAPE = /^[A-Za-z][A-Za-z' .&-]{2,}$/;
const STATE_CODES = new Set(['sc', 'nc', 'ga', 'tn', 'va', 'al']);

const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** "SALUDA RIVER NEAR PELZER" -> "PELZER"; ALL CAPS becomes Title Case, anything else is kept. */
function tidy(s) {
  const t = String(s || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^[\s,.;:-]+|[\s,;:-]+$/g, '');
  if (!t) return '';
  if (t === t.toUpperCase()) {
    // After a space or at the start, not after every word boundary -- `\b` sits between an
    // apostrophe and the letter after it, and wrote "GRAY'S BRIDGE" as "Gray'S Bridge".
    return t.toLowerCase().replace(/(^|[\s/-])([a-z])/g, (_, a, c) => a + c.toUpperCase());
  }
  return t;
}

function isStateCode(s) {
  return STATE_CODES.has(flat(s).replace(/\s+/g, ''));
}

/** The river a station name is ON: everything before its first locative, "R" read as river. */
export function riverPart(stationName) {
  const s = String(stationName || '');
  const m = LOCATIVE.exec(s);
  if (!m) return '';
  return flat(s.slice(0, m.index)).replace(/\br\b/g, 'river');
}

/**
 * The places a station name gives, if it is a station ON this river; otherwise none.
 * "Saluda River near WARE SHOALS" on the Saluda -> ["Ware Shoals"].
 * "WILSON CREEK AT NINETY SIX, SC" on the Saluda -> [] -- a tributary's gauge names its creek.
 */
export function placesInStationName(stationName, riverName) {
  const s = String(stationName || '');
  if (!s || riverPart(s) !== flat(riverName)) return [];
  const m = LOCATIVE.exec(s);
  const rest = s.slice(m.index + m[0].length);
  const out = [];
  for (const piece of rest.split(LOCATIVE_SPLIT)) {
    const t = tidy(piece);
    if (!t || isStateCode(t) || !PLACE_SHAPE.test(t)) continue;
    // The river is not a place on itself: "DAN RIVER AT ... DAN RIVER" gave the Dan a query for
    // "Dan River" "Dan River".
    if (flat(t) === flat(riverName)) continue;
    out.push(t);
  }
  return out;
}

/**
 * The places a launch's own name gives: the name, split where it lists two ("Ware
 * Shoals/Irvin Pitts Park") and where it carries an alias in brackets ("James R. Metts (Hope
 * Ferry)"). TWO WORDS OR MORE -- a launch is a proper name, and the one-word leftovers of a split
 * ("Lower", from "Saluda Shoals (Lower)") are ordinary words that would match any sentence.
 */
export function placesInLaunchName(launchName) {
  const s = String(launchName || '');
  const pieces = [];
  s.replace(/\(([^)]*)\)/g, (_, inner) => { pieces.push(inner); return ' '; });
  pieces.push(...s.replace(/\([^)]*\)/g, ' ').split('/'));
  const out = [];
  for (const piece of pieces) {
    const t = tidy(piece);
    if (!t || !PLACE_SHAPE.test(t)) continue;
    if (t.split(/\s+/).filter(Boolean).length < 2) continue;
    out.push(t);
  }
  return out;
}

/**
 * The words in a display name's brackets that tell two same-named rows apart: "(Lower Saluda)".
 * A county, a state stamp, a number and a road are not that -- "(Lexington Co, SC)", "(2)",
 * "(to SC-601)".
 */
export function qualifiersOf(displayName) {
  const out = [];
  String(displayName || '').replace(/\(([^)]*)\)/g, (_, inner) => {
    const t = tidy(inner);
    if (t && PLACE_SHAPE.test(t) && !/\bco\b|\bcounty\b/i.test(t) && !isStateCode(t)
        && !/,\s*[A-Z]{2}\s*$/.test(inner)) out.push(t);
    return '';
  });
  return out;
}

function rowNames(row) {
  const r = row || {};
  return [r.display_name, r.name, r.legacy_display_name, ...(r.legacy_display_names || [])]
    .filter(Boolean).map(String);
}

/**
 * The rows that are ONE piece of research: every row whose names store to the id `lakeName`
 * stores to. research-ids.js is where that is decided -- two waters are researched together
 * because a canonical row says so, and this reads that rather than a second list.
 *
 * `slug` is the row the caller already resolved the name to; it is always in the group, so a
 * water with no canonical rows is simply a group of one.
 */
export function researchGroup(index, lakeName, slug, storageId) {
  const target = storageId(lakeName);
  const group = new Set(slug && index[slug] ? [slug] : []);
  for (const [s, row] of Object.entries(index || {})) {
    if (rowNames(row).some((n) => storageId(n) === target)) group.add(s);
  }
  return { target, group: [...group].sort() };
}

/**
 * The other rows of the same river: same feature_type as the group, the same name once the
 * brackets and state are stripped, and not in the group. For the upper Saluda that is
 * saluda_river_lower_saluda and nothing else.
 */
export function siblingsOf(index, group, lakeName, stripQualifiers) {
  const bare = flat(stripQualifiers(lakeName));
  const types = new Set(group.map((s) => (index[s] || {}).feature_type).filter(Boolean));
  const inGroup = new Set(group);
  const out = [];
  for (const [s, row] of Object.entries(index || {})) {
    if (inGroup.has(s) || !types.has(row.feature_type)) continue;
    if (flat(stripQualifiers(row.display_name || row.name)) === bare) out.push(s);
  }
  return out.sort();
}

function stationNamesOf(binding) {
  const b = binding || {};
  const pool = b.pool || {};
  return [pool.name, pool.usgs_name, ...((b.gauges || []).map((g) => g && g.name))]
    .filter(Boolean).map(String);
}

function launchNamesOf(row) {
  const out = [];
  for (const items of Object.values((row || {}).ramps || {})) {
    for (const r of items || []) if (r && r.name) out.push(String(r.name));
  }
  return out;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const k = flat(p);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/**
 * Everything the caller needs, from the registry it already has.
 *
 * @param {object} o
 * @param {object} o.index          lake_index.json, slug -> row
 * @param {object} [o.bindings]     water_bindings.json's `bindings`, slug -> binding
 * @param {string} o.lakeName       the name being researched
 * @param {string} [o.slug]         the row that name resolved to
 * @param {function} o.storageId    researchStorageId from js/data/research-ids.js
 * @param {function} o.stripQualifiers  stripLakeQualifiers from the same file
 * @returns {{target, group, siblings, search, own, other}}
 *   search  the group's STATION places -- towns, in the grammar a gauge is named in. What the
 *           discovery queries anchor on. Launch names are too particular to search on.
 *   own     every place of the group, stations and launches both
 *   other   {siblingSlug: [places]}, each list minus anything the group also has; and
 *           {slug or name: [name]} for each water whose name is this river's with a word in front
 * @param {string[]} [o.feedNames]  the waterbody names in the state ramp and paddle feeds
 */
export function reachPlaces({ index, bindings = {}, lakeName, slug, storageId, stripQualifiers,
                              feedNames = [] }) {
  const { target, group } = researchGroup(index, lakeName, slug, storageId);
  const siblings = siblingsOf(index, group, lakeName, stripQualifiers);
  const river = stripQualifiers(lakeName);
  // A PLACE THAT CARRIES THE RIVER'S WHOLE NAME TELLS NO PIECE FROM ANOTHER. A launch called
  // "Saluda River Access" would make every sentence about the Saluda "name" this piece, and the
  // fact sort would keep everything.
  const distinct = (p) => !flat(p).includes(flat(river));
  const placesOf = (s) => {
    const stations = stationNamesOf(bindings[s]).flatMap((n) => placesInStationName(n, river))
      .filter(distinct);
    const launches = launchNamesOf(index[s]).flatMap(placesInLaunchName).filter(distinct);
    const quals = qualifiersOf((index[s] || {}).display_name);
    return { stations: dedupe(stations), all: dedupe([...quals, ...stations, ...launches]) };
  };
  const mine = group.map(placesOf);
  const search = dedupe(mine.flatMap((p) => p.stations));
  const own = dedupe(mine.flatMap((p) => p.all));
  const ownKeys = new Set(own.map(flat));
  const other = {};
  for (const s of siblings) {
    const keep = placesOf(s).all.filter((p) => !ownKeys.has(flat(p)));
    if (keep.length) other[s] = keep;
  }
  // AND THE WATERS WHOSE NAME IS THIS ONE WITH A WORD IN FRONT. South Carolina's own ramp and
  // paddle feeds list "North Saluda River", "Middle Saluda River" and "South Saluda River" beside
  // "Saluda River": the mountain forks, other rivers, with their trout. 10 of the upper Saluda's 76
  // facts name one of them, and every one says "Saluda River" in the middle of its name. The names
  // are the state's and the registry's -- `feedNames` and the index -- never a list typed here, and
  // a name the group itself answers to is never one of them.
  const riverKey = flat(river);
  const groupKeys = new Set(group.flatMap((s) => rowNames(index[s]))
    .map((n) => flat(stripQualifiers(n))));
  const longer = (n) => {
    const k = flat(stripQualifiers(n));
    return k !== riverKey && k.endsWith(` ${riverKey}`) && !groupKeys.has(k);
  };
  const inGroupOrSib = new Set([...group, ...siblings]);
  for (const [s, row] of Object.entries(index || {})) {
    if (inGroupOrSib.has(s)) continue;
    const hit = rowNames(row).find(longer);
    if (hit) other[s] = dedupe([stripQualifiers(hit), ...(other[s] || [])]);
  }
  for (const n of feedNames || []) {
    if (!longer(n)) continue;
    const name = tidy(stripQualifiers(n));
    if (!Object.values(other).some((list) => list.some((p) => flat(p) === flat(name)))) {
      other[name] = [name];
    }
  }
  return { target, group, siblings, search, own, other };
}

/** Does `text` name `place` as a phrase? Word-bounded and case-blind, never a substring. */
export function names(text, place) {
  const t = ` ${flat(text)} `;
  const p = flat(place);
  return !!p && t.includes(` ${p} `);
}

function elsewhere(text, reach) {
  if (!reach || !reach.other) return null;
  if ((reach.own || []).some((p) => names(text, p))) return null;
  for (const [s, places] of Object.entries(reach.other)) {
    const hit = places.find((p) => names(text, p));
    if (hit) return { belongs_to: s, because: hit };
  }
  return null;
}

/**
 * Facts that name a sibling's place and none of the group's go to `elsewhere`, with the sibling
 * and the place; everything else is kept. A fact naming BOTH is kept -- "from Ware Shoals down to
 * Columbia" is about this water too.
 */
export function sortFacts(facts, reach) {
  const keep = [];
  const other = [];
  for (const f of facts || []) {
    const hit = elsewhere(`${(f && f.fact) || ''} ${(f && f.quote) || ''}`, reach);
    if (hit) other.push({ ...f, ...hit });
    else keep.push(f);
  }
  return { keep, elsewhere: other };
}

/** How many times `text` names `place` as a phrase. water-scope.js counts with it too. */
export function mentions(text, place) {
  const t = ` ${flat(text)} `;
  const p = flat(place);
  if (!p) return 0;
  let n = 0;
  for (let at = t.indexOf(` ${p} `); at !== -1; at = t.indexOf(` ${p} `, at + p.length + 1)) n += 1;
  return n;
}

/**
 * The piece a document's BODY names more than it names this one, or null.
 *
 * A PAGE CAN BE ABOUT ANOTHER PIECE WITHOUT SAYING SO IN ITS TITLE. Mt. Yonder's "French Broad
 * River Fly Fishing Guide" -- one of the pages the French Broad, TN run was handed on 2026-09-25
 * -- is a guide service in Asheville: Rosman, Brevard, downtown Asheville, and one "Tennessee" at
 * the end. Its title names no place, so the title test keeps it, and it never writes "North
 * Carolina", so the state count in water-scope.js keeps it too.
 *
 * The body is read the way the state is: every place of each piece counted, and a document goes to
 * the piece it names MORE OFTEN than this one. A page about the whole river names every piece and
 * is sorted to none of them unless another piece is named more often -- a tie, or no place at all,
 * stays.
 */
function busiestElsewhere(text, reach) {
  if (!text || !reach || !reach.other) return null;
  const count = (list) => (list || []).reduce((n, p) => n + mentions(text, p), 0);
  const own = count(reach.own);
  let best = null;
  for (const [s, places] of Object.entries(reach.other)) {
    const n = count(places);
    if (n > own && (!best || n > best.n)) {
      const top = places.reduce((a, p) => (mentions(text, p) > mentions(text, a) ? p : a), places[0]);
      best = { belongs_to: s, because: top, n };
    }
  }
  return best && { belongs_to: best.belongs_to, because: best.because,
                   in: `body: ${best.n} mention(s) of that piece, ${own} of this one` };
}

/**
 * The title test first, unchanged: a title that names another piece and none of this one's is that
 * piece's document. Then, for a document that carries its text, the body test above. A document
 * with no text is judged on its title alone, as it always was.
 */
export function sortDocuments(documents, reach) {
  const keep = [];
  const other = [];
  for (const d of documents || []) {
    const title = String((d && d.title) || '');
    const titleNamesOwn = ((reach && reach.own) || []).some((p) => names(title, p));
    const hit = elsewhere(title, reach)
      || (titleNamesOwn ? null : busiestElsewhere(d && d.text, reach));
    if (hit) other.push({ title: d.title, url: d.url, ...hit });
    else keep.push(d);
  }
  return { keep, elsewhere: other };
}
