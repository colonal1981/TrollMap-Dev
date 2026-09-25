/**
 * water-scope.js -- where a water is, for a water whose name does not say.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * THE RULE, IN ONE SENTENCE. When a water's name does not pick out one water -- every river, and
 * any water another registry row also answers to -- discovery asks for it IN ITS OWN COUNTY, and
 * the off-lake gate refuses a document that names some other state (or, for a lake, the other
 * namesake's county) more often than it names this water's own.
 *
 * WHY THIS EXISTS. The Claude step of 2026-09-24/25 ran 53 rivers and 14 of its 17 failures were
 * documents about a different water: Johns River, NC was handed Florida's St. Johns; New River,
 * NC the Virginia and West Virginia New River; Black River, SC Black Rivers in New York, Arizona
 * and Michigan; French Broad, TN the Asheville stretch; Pee Dee, NC the South Carolina one; Lake
 * Robinson, SC (H.B. Robinson, Chesterfield County) the Greer Lake Robinson's real estate.
 *
 * THE STATE WAS ALREADY IN THE QUERY. discover.js appends the spelled-out state to every open-web
 * query. It does not hold: the provider treats it as one more word, and a St. Johns page that
 * mentions "North Carolina" once in a sidebar satisfies it. Quoting it changes nothing. Measured
 * in TinyFish 2026-09-25, results about THIS water in the top ten:
 *
 *                         "<name>" ... <State>      "<name>" "<County> County" fishing
 *     Johns River, NC      3 of 10                   10 of 10   (Burke)
 *     New River, NC        6 of 10                   10 of 10   (Ashe)
 *     Black River, SC      6 of 10                    8 of 8    (Williamsburg)
 *     Lake Robinson, SC    5 of 10                   10 of 10   (Chesterfield)
 *     French Broad, TN        --                      6 of 7    (Knox)
 *     Pee Dee River, NC       --                      7 of 7    (Anson)
 *     Catawba River, SC       --                     10 of 10   (Chester)
 *
 * THE COUNTY IS THE REGISTRY'S OWN ANSWER TO THIS QUESTION. consolidate_lake_index.py stamped a
 * county on every row because, on 2026-08-02, the state cut name collisions from 66 groups to 40
 * and every one of the 40 was inside a state; the county separated 35 of them. Search has the same
 * problem one level out, and the same field answers it. Nothing here is typed in per water.
 *
 * WHY RIVERS ALWAYS, AND LAKES ONLY ON A NAMESAKE. A river's namesakes are mostly outside the
 * registry -- St. Johns is in Florida, the other Black Rivers in five other states -- so the
 * registry cannot see them, and all seven rivers measured above had one. A lake's name is
 * checked against the registry: "Lake Robinson" is two rows, "Lake Murray" is one, and a lake
 * with no namesake is left exactly as it was.
 *
 * NO THRESHOLD. The gate compares two counts and takes the larger. A tie, or a page that names no
 * state at all, is not "plainly about another state" and falls through to the rules below it.
 */
import { stripLakeQualifiers } from '../data/research-ids.js';
import { qualifiersOf } from './reach-places.js';

const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The app's four states. Their codes count as mentions; no other state's does -- see below. */
const OUR_CODES = new Map([['sc', 'SC'], ['nc', 'NC'], ['ga', 'GA'], ['tn', 'TN']]);

/**
 * Every state by its spelled-out name. Two-letter codes for the other 46 are NOT counted, for the
 * reason doc-relevance.js already gives: `in`, `or`, `me`, `de`, `ok`, `hi`, `la`, `pa`, `co` are
 * words. SC, NC, GA and TN are not, and a page about Hyco Lake says "NC" more than it says "North
 * Carolina".
 *
 * A MAP, NOT AN OBJECT LITERAL. `STATE_NAMES[word]` on a plain object answers for "constructor" and
 * "toString" too -- inherited members, not states. Measured on the desktop corpora 2026-09-25: a
 * Saluda River land listing was refused with the state `"function Object() { [native code] }": 2`.
 */
const STATE_NAMES = new Map(Object.entries({
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
}));

/**
 * A state's name followed by one of these is not the state: "Washington County" is in NC, GA and
 * TN, and "Texas rig" and "Carolina rig" are bass fishing -- the reason the title-only
 * other-state check in doc-relevance.js never read the body.
 */
const NOT_A_STATE_AFTER = new Set(['county', 'co', 'counties', 'parish', 'rig', 'rigs', 'rigged',
  'street', 'avenue', 'ave', 'road', 'rd']);
// "st" is not on it: "Florida St. Johns" and a URL's "florida/st-johns-river" are Saint far more
// often, on a fishing page, than they are a street.

/** The state term that starts at word `i`, as [code, words used], or null. Two words first. */
function stateAt(words, i) {
  const two = i + 1 < words.length ? `${words[i]} ${words[i + 1]}` : '';
  if (two === 'n c' || two === 's c') return [two[0] === 'n' ? 'NC' : 'SC', 2];
  if (two && STATE_NAMES.has(two)) return [STATE_NAMES.get(two), 2];
  if (STATE_NAMES.has(words[i])) return [STATE_NAMES.get(words[i]), 1];
  if (OUR_CODES.has(words[i])) return [OUR_CODES.get(words[i]), 1];
  return null;
}

/**
 * How many times the text names each state, as {code: count}.
 *
 * A name immediately followed by ANOTHER state term is a town in that state, not a state:
 * "Washington, NC" is on the Pamlico, "Florence, SC" is not in Italy either. The trailing state is
 * the one counted.
 */
export function stateMentions(text) {
  const words = flat(text).split(' ').filter(Boolean);
  const out = new Map();
  for (let i = 0; i < words.length;) {
    const hit = stateAt(words, i);
    if (!hit) { i += 1; continue; }
    const [code, n] = hit;
    const next = words[i + n];
    if (!NOT_A_STATE_AFTER.has(next) && !stateAt(words, i + n)) out.set(code, (out.get(code) || 0) + 1);
    i += n;
  }
  return Object.fromEntries(out);
}

/** How many times `text` names `place` as a whole phrase. */
function mentions(text, place) {
  const t = ` ${flat(text)} `;
  const p = flat(place);
  if (!p) return 0;
  let n = 0;
  for (let at = t.indexOf(` ${p} `); at !== -1; at = t.indexOf(` ${p} `, at + p.length + 1)) n += 1;
  return n;
}

/**
 * The phrases that name this water in a sentence: every name the row answers to, stripped of its
 * brackets and state, and -- where it is two words or more -- the same name without its trailing
 * water noun. "Little Tennessee River" and "the Little Tennessee"; "Pee Dee River" and "the Great
 * Pee Dee". A ONE-WORD remainder is not kept: "Johns", "New", "Black", "Deep" and "Dan" are words
 * before they are rivers, the same reason doc-relevance.js asks a one-word base for a water noun.
 */
export function namesOf(row) {
  const r = row || {};
  const out = new Set();
  for (const n of [r.display_name, r.name, r.legacy_display_name, ...(r.legacy_display_names || [])]) {
    const full = flat(stripLakeQualifiers(n || ''));
    if (!full) continue;
    out.add(full);
    const core = full.replace(/^lake /, '').replace(/ (river|lake|reservoir|creek|canal)$/, '').trim();
    if (core.includes(' ')) out.add(core);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * THE SENTENCES THAT TIE THIS NAME TO A PLACE, with the name itself taken out.
 *
 * Two defects the desktop review of 2026-09-25 measured on the stored corpora, and one rule for both:
 *
 *   THE WATER'S OWN NAME WAS COUNTED AS A STATE. Little Tennessee River lost 10 of its 19 documents,
 *   every one about the NC river: "The Little Tennessee is arguably North Carolina's best stream for
 *   smallmouth bass" counted {TN: 8, NC: 4}. So the water's own names are taken out before counting.
 *
 *   ONE STRAY MENTION BEAT ZERO. A local page often never names its own state, and a nav link
 *   ("Northwest NC", on both Diversion Canal pages), a football score ("the Dawgs ... take on
 *   Tennessee at 3:30", on an Ohoopee River post) or a commenter's handle ("Reel NC Angler", on a
 *   Congaree thread) then outvoted nothing. None of those sentences names the water.
 *
 * So only a sentence that names the water -- or a namesake of its name, which is what "St. Johns
 * River" is to "Johns River" -- is read, and that is where a page says which state it means: "the
 * St Johns River (Fl) (Florida)", "the New River in southwest Virginia". The title and the URL are
 * sentences of their own. Still no threshold: the counts are compared as before, only over these.
 */
export function nameSentences(text, names) {
  const keys = (names || []).map(flat).filter(Boolean);
  if (!keys.length) return '';
  const out = [];
  for (const piece of splitSentences(text)) {
    let t = ` ${flat(piece)} `;
    if (!keys.some((k) => t.includes(` ${k} `))) continue;
    for (const k of keys) t = t.split(` ${k} `).join(' xname ');
    out.push(t.trim());
  }
  return out.join(' xbreak ');
}

/**
 * Sentences: a stop followed by space, a line break, or a " | " separator. NOT after a one- or
 * two-letter capitalised abbreviation -- "St. Johns", "Mt. Airy", "N.C.", "H. B. Robinson" -- or
 * "Florida's St." and "Johns River" land in different sentences and the tie between them is lost.
 */
const splitSentences = (text) => String(text || '')
  .split(/(?<!\b[A-Z][a-z]?)[.!?]+(?=\s)|\n+|\s[|•·]\s/);

/**
 * The words that make a capitalised phrase the name of a water: "the New River", "Lake Wylie",
 * "South Fork Holston River". Read off the page's own capitals, so no list of waters is needed.
 */
const WATER_WORDS = new Set(['river', 'lake', 'reservoir', 'creek', 'fork', 'canal', 'dam',
  'tailrace', 'tailwater']);

/**
 * THE STATES A PAGE GIVES TO THIS WATER, as {code: count} -- not every state in a sentence that names it.
 *
 * The desktop re-measure of eee0d06 on 726 stored documents: of the 24 refusals left, four were real
 * pages refused over a state that belongs to ANOTHER water in the same sentence:
 *
 *   Deep River    "...fishing on the New River in Virginia, but Deep River Fly Fishing..."
 *   Holston       "The Watauga River, which originates in North Carolina, flows ... South Fork Holston River"
 *   Catawba, NC   "...the Catawba River in relation to Lake Norman, ... and below Lake Wylie in South Carolina."
 *   Tuckasegee    "...on the Tuckasegee River at Dillsboro and the Chattahoochee River in Georgia, ..."
 *
 * So each state goes to one water: the nearest water named BEFORE it ("the New River in Virginia"),
 * or, where none is, the next one ("Florida ... St. Johns River"). A possessive goes forward first --
 * "Florida's St. Johns" is Florida's -- and back where nothing follows ("the Little Tennessee is North
 * Carolina's best stream"). Only the states that land on this water are counted.
 */
export function statesTiedToWater(text, names) {
  const keys = (names || []).map((n) => flat(n).split(' ')).filter((k) => k.length && k[0]);
  const out = new Map();
  if (!keys.length) return {};
  keys.sort((a, b) => b.length - a.length);
  for (const piece of splitSentences(text)) {
    const raw = piece.replace(/[’‘]/g, "'").split(/[^A-Za-z0-9]+/).filter(Boolean);
    const toks = [];
    for (let i = 0; i < raw.length;) {
      const k = keys.find((key) => key.every((w, j) => (raw[i + j] || '').toLowerCase() === w));
      if (k) { toks.push({ w: 'xname', water: 'own' }); i += k.length; continue; }
      const w = raw[i].toLowerCase();
      toks.push({ w, water: /^[A-Z]/.test(raw[i]) && WATER_WORDS.has(w) ? 'other' : null });
      i += 1;
    }
    if (!toks.some((t) => t.water === 'own')) continue;
    const words = toks.map((t) => t.w);
    const at = (from, step) => {
      for (let j = from; j >= 0 && j < toks.length; j += step) if (toks[j].water) return toks[j].water;
      return null;
    };
    for (let i = 0; i < words.length;) {
      const hit = stateAt(words, i);
      if (!hit) { i += 1; continue; }
      const [code, n] = hit;
      const next = words[i + n];
      // "the Mississippi River", "the Tennessee River": a state's name before a capitalised water
      // word is that water's name, not the state.
      const namesAWater = toks[i + n] && toks[i + n].water === 'other';
      if (!namesAWater && !NOT_A_STATE_AFTER.has(next) && !stateAt(words, i + n)) {
        const possessive = next === 's';
        const owner = possessive ? (at(i + n, 1) || at(i - 1, -1)) : (at(i - 1, -1) || at(i + n, 1));
        if (owner === 'own') out.set(code, (out.get(code) || 0) + 1);
      }
      i += n;
    }
  }
  return Object.fromEntries(out);
}

/**
 * "Burke" / "Burke County" / "Richland/Calhoun" / "(Richland/Calhoun Co, SC)" -> county names.
 * The row's `county` field first; the display name's county stamp when the row has none.
 */
export function countiesOf(row) {
  const r = row || {};
  let raw = r.county;
  if (Array.isArray(raw)) raw = raw.join('/');
  if (!raw) {
    const m = /\(([^()]*?)\s+Co(?:unty)?\.?\s*,\s*[A-Z]{2}(?:\/[A-Z]{2})*\s*\)/.exec(String(r.display_name || ''));
    raw = m ? m[1] : '';
  }
  const seen = new Set();
  const out = [];
  for (const piece of String(raw || '').split(/\s*(?:\/|&|,|\band\b)\s*/i)) {
    const c = piece.replace(/\s+(?:County|Co\.?)$/i, '').replace(/\s+/g, ' ').trim();
    if (!/^[A-Za-z][A-Za-z' .-]{1,}$/.test(c) || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    out.push(c);
  }
  return out;
}

/** The row's states: `states` where label_water_states.py measured them, else its `state`. */
export function statesOf(row) {
  const r = row || {};
  if (Array.isArray(r.states) && r.states.length) return r.states.map((s) => String(s).toUpperCase());
  return String(r.state || '').toUpperCase().split(/[^A-Z]+/).filter(Boolean);
}

const bareName = (row) => flat(stripLakeQualifiers((row && (row.display_name || row.name)) || ''));

/** The other rows answering to this row's bare name: same words once brackets and state go. */
export function namesakesOf(index, slug) {
  const row = index && index[slug];
  const key = bareName(row);
  if (!key) return [];
  const out = [];
  for (const [s, r] of Object.entries(index || {})) {
    if (s === slug || !r || typeof r !== 'object') continue;
    if (bareName(r) === key || flat(stripLakeQualifiers(r.name || '')) === key) out.push(s);
  }
  return out.sort();
}

/**
 * The scope of one registry row, or null when its name already picks it out.
 *
 *   why          'river' or 'namesake'
 *   states       this water's states -- a document is refused only for naming ANOTHER one more
 *   counties     this water's counties, which discovery anchors on
 *   namesakes    the other rows with this name
 *   ownPlaces    this row's counties and bracket words ("Greer")
 *   rivalPlaces  a LAKE's same-state namesakes' counties and bracket words, minus its own
 *   names        the phrases that name this water in a sentence -- see namesOf()
 *
 * RIVAL PLACES ARE FOR LAKES ONLY. A lake sits in a county or two, so its county is where it is.
 * A river piece crosses several and the row carries the centroid's, so an adjacent piece's
 * county is often this piece's too; reach-places.js already sorts a river's pieces apart by the
 * towns on their gauges and launches, which is the better evidence for that.
 */
export function waterScope(index, slug) {
  const row = index && slug ? index[slug] : null;
  if (!row || typeof row !== 'object') return null;
  const river = String(row.feature_type || '').toLowerCase() === 'river';
  const namesakes = namesakesOf(index, slug);
  if (!river && !namesakes.length) return null;
  const states = statesOf(row);
  const counties = countiesOf(row);
  const ownPlaces = [...counties, ...qualifiersOf(row.display_name)];
  const own = new Set(ownPlaces.map(flat));
  const rivalPlaces = [];
  if (!river) {
    for (const s of namesakes) {
      const r = index[s];
      if (!statesOf(r).some((st) => states.includes(st))) continue;
      for (const p of [...countiesOf(r), ...qualifiersOf(r.display_name)]) {
        const k = flat(p);
        if (k && !own.has(k)) { own.add(k); rivalPlaces.push(p); }
      }
    }
  }
  return { why: river ? 'river' : 'namesake', states, counties, namesakes, ownPlaces, rivalPlaces,
           names: namesOf(row) };
}

/**
 * Why a document is about another place than this water's, or null.
 *
 *   another_state     in the sentences that name this water, some state not this water's is given
 *                     to it more often than every one of its own -- see statesTiedToWater()
 *   namesake_place    in the same sentences, a same-state namesake's county or bracket word
 *                     outnumbers this water's own
 *
 * Both are one comparison of two counts. Equal counts, none at all, or a page whose sentences never
 * name the water decide nothing. A page wrongly refused here is gone for the run, while one wrongly
 * kept is still read by the Claude step, which takes only text about THIS water -- so the rule is
 * tuned to refuse only what a page itself ties to somewhere else.
 */
export function elsewhereReason(text, scope) {
  if (!scope) return null;
  const tied = nameSentences(text, scope.names);
  if (!tied) return null;
  const ours = new Set((scope.states || []).map((s) => String(s).toUpperCase()));
  if (ours.size) {
    let mine = 0;
    let theirs = 0;
    for (const [code, n] of Object.entries(statesTiedToWater(text, scope.names))) {
      if (ours.has(code)) mine = Math.max(mine, n);
      else theirs = Math.max(theirs, n);
    }
    if (theirs > mine) return 'another_state';
  }
  if ((scope.rivalPlaces || []).length) {
    const most = (list) => Math.max(0, ...list.map((p) => mentions(tied, p)));
    if (most(scope.rivalPlaces) > most(scope.ownPlaces || [])) return 'namesake_place';
  }
  return null;
}

/**
 * The extra discovery queries: one per county, `"<name>" "<County> County" fishing`. The name is
 * the search anchor discover.js already cleans (no brackets, no state).
 */
export function countyQueries(name, scope) {
  const n = String(name || '').trim();
  if (!n || !scope) return [];
  return (scope.counties || []).map((c) => `"${n}" "${c} County" fishing`);
}
