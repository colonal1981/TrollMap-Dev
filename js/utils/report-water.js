/**
 * report-water.js -- the depth of WATER a guide report puts a species over, read off its own words.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-10-01: "depth itself shouldn't be weighted i dont think... but guide reports that put
 * fish in certain depth of water should count towards something". This is the reading half of
 * that. Santee Cooper Country's October report says "anglers should start looking for fish in
 * 30-45 feet of water along flats and creek areas"; this returns [30, 45] for Striped Bass with the
 * sentence it came from.
 *
 * ONE PHRASE, AND IT IS DELIBERATELY THAT CRUDE: a number or range followed by "of water" ("30-45
 * feet of water", "35 to 45 foot of water", "less than 15 feet of water", "35-50 ft of open
 * water"). That phrase names the water and nothing else. "20-30 ft on brush", "25-30 foot brush
 * piles", "8-12 foot hills" and "in 15ft on humps" are depths too, but of a structure or of the
 * fish, and which one is language work that can be wrong both ways -- the same line
 * fishDepthEvidence() in plan-inputs.js draws. So they are not read here; the plan still gets
 * every one of them, verbatim, in the report itself.
 *
 * WHICH SPECIES A SENTENCE IS ABOUT comes from the report's own headings ("STRIPERS", "## Striper",
 * SCDNR's "Striped bass: ...") or, where there is none, from the sentence naming the fish or the
 * sentence before it doing so. A heading that names no fish ("GRASS BITE", "REDFISH & TROUT") ends
 * the species it followed, so a sentence there counts only if it names the fish itself. That loses
 * some sentences and attributes none wrongly, which is the right way round for a number that
 * decides which water is offered.
 */

export const SPECIES_WORDS = {
  'Striped Bass': ['striped bass', 'stripers?', 'rockfish'],
  'Hybrid': ['hybrids?', 'hybrid striped bass', 'wipers?'],
  'White Bass': ['white bass'],
  'Largemouth Bass': ['largemouth', 'black bass', '(?<!striped |white |hybrid |rock )bass(?:es)?'],
  'Catfish': ['catfish', 'cats', 'blue cats?', 'channel cats?', 'flatheads?'],
  'Crappie': ['crappie'],
  'Bream': ['bream', 'bluegill', 'shellcracker', 'redear'],
  'White Perch': ['white perch'],
  'Bowfin': ['bowfin', 'mudfish'],
};
const OTHER_FISH = ['redfish', 'reds', 'trout', 'drum', 'sheepshead', 'perch', 'walleye', 'pickerel'];

const wordsRe = (words) => new RegExp(`\\b(?:${words.join('|')})\\b`, 'i');
const speciesRe = (sp) => wordsRe(SPECIES_WORDS[sp]
  || [String(sp).toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '\\s+')]);
const ANY_FISH = wordsRe([...Object.values(SPECIES_WORDS).flat(), ...OTHER_FISH]);

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];

/** Is this line a heading in the report, rather than a sentence of it? */
function isHeading(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^#{1,6}\s+/.test(t)) return true;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && t.length <= 60 && letters === letters.toUpperCase()) return true;
  const words = t.split(/\s+/).length;
  return words <= 8 && !/[.!?:,]$/.test(t) && ANY_FISH.test(t);
}

// A number or range, then "of water". "the top 10 feet of the water column" is not one.
const WATER_RE = /\b(?:(less than|under|shallower than|more than|deeper than)\s+)?(\d{1,3})(?:\s*(?:-|–|—|to)\s*(\d{1,3}))?\s*(\+|plus)?\s*(?:feet|foot|ft)\.?\s+of\s+(?:(?!the\b)[a-z]+\s+)?water\b/gi;

/** Every "N-M feet of water" in one sentence, as [lo, hi]; hi is null where the sentence leaves it open. */
export function waterRangesIn(sentence) {
  const out = [];
  for (const m of String(sentence || '').matchAll(WATER_RE)) {
    const q = (m[1] || '').toLowerCase();
    const a = Number(m[2]);
    const b = m[3] != null ? Number(m[3]) : null;
    const open = !!m[4] || q === 'more than' || q === 'deeper than';
    if (q === 'less than' || q === 'under' || q === 'shallower than') out.push([0, b ?? a]);
    else out.push([Math.min(a, b ?? a), open ? null : Math.max(a, b ?? a)]);
  }
  return out;
}

const sentencesOf = (text) => String(text || '').split(/(?<=[.!?])\s+(?=["“(]?[A-Z0-9])/)
  .map((s) => s.trim()).filter(Boolean);

// ── WHICH OF THE TWO SANTEE COOPER LAKES A SENTENCE IS ABOUT ──────────────────────────────────
//
// Ryan, 2026-10-01, on Santee Cooper Country's October "30-45 feet of water": "i bet more likely
// that depth is discussing lake moultrie... and there is no way to distinguish that". Measured on
// the packs: Marion has 202 acres at 35 ft or more and 2 at 45; Moultrie has 8,128 and 3,226. Then,
// on Angler's Headquarters' October 2023 report: "the difference being that this one calls out
// upper and lower lake". Asked whether a depth should mark lanes only when its sentence says which
// lake, and whether place names should count: "If place names help lock down which lake why
// wouldn't we use them?", then "go ahead".
//
// So on Marion and Moultrie a sentence is about a lake when it:
//   - names it ("Marion", "Moultrie"; "Francis Marion" is the forest by Moultrie, not the lake);
//   - says "upper lake" (Marion) or "lower lake" (Moultrie), but not "lower Lake Marion", which is
//     Marion;
//   - or names a place on only ONE of the two charts (`places`, read off both packs: the Hatchery,
//     Bonneau and Pinopolis are Moultrie's, Jacks Creek, Taw Caw and Pack's Landing Marion's). It
//     counts only as the chart writes it, capitalised, and a one-word name ("Cross") only where it
//     is not the sentence's first word, because the packs' labels include ordinary words.
// The lake carries to the rest of its paragraph, and a heading's to its section. A sentence that
// names both lakes says neither. One that names none, in a paragraph that named none, is about
// neither lake, and its depth goes to the plan as text and on no lane.
export const SANTEE_LAKES = ['lake_marion', 'lake_moultrie'];
const [MARION, MOULTRIE] = SANTEE_LAKES;
const UPPER_LOWER = /\b(upper|lower)\s+lakes?\b(?!\s+(?:Marion|Moultrie)\b)/gi;
const escRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function placeNamed(s, name) {
  const m = new RegExp(`(^|[^A-Za-z'])${escRe(name)}(?![A-Za-z])`).exec(s);
  if (!m) return false;
  if (/\s/.test(name.trim())) return true;
  return /[A-Za-z]/.test(s.slice(0, m.index + m[1].length));   // a one-word name, not the first word
}

/** The Santee Cooper lakes a sentence speaks of, as a Set of slugs. */
export function santeeLakesIn(sentence, places = null) {
  const t = String(sentence || '');
  const found = new Set();
  if (/(?<!Francis\s)\bMarion\b/.test(t)) found.add(MARION);
  if (/\bMoultrie\b/.test(t)) found.add(MOULTRIE);
  for (const m of t.matchAll(UPPER_LOWER)) found.add(m[1].toLowerCase() === 'upper' ? MARION : MOULTRIE);
  for (const slug of SANTEE_LAKES) {
    for (const name of (places && places[slug]) || []) {
      if (placeNamed(t, name)) { found.add(slug); break; }
    }
  }
  return found;
}

const PLACE_KINDS = new Set(['place_name', 'recreation', 'boat_ramp', 'store']);

/**
 * The names a pack puts on its own water: its named places, landings and creek mouths. A label with
 * a digit, a quote, a comma or a slash in it is a buoy, a depth or a road number, not a place.
 */
export function placeNamesIn({ pois, waterFeatures, launches } = {}) {
  const names = new Set();
  const add = (n) => {
    const t = String(n || '').trim();
    if (/[A-Za-z]{3}/.test(t) && !/[\d",/]/.test(t)) names.add(t);
  };
  for (const f of (pois && pois.features) || []) {
    const p = f.properties || {};
    if (PLACE_KINDS.has(p.poi_type)) add(p.name);
  }
  for (const f of (waterFeatures && waterFeatures.features) || []) add((f.properties || {}).name);
  for (const l of (launches && launches.landings) || []) add(l.name);
  return names;
}

/** For each of the two lakes, the names its chart has and the other's does not. */
export function namesOnlyOn(marionNames, moultrieNames) {
  const a = [...(marionNames || [])].filter((n) => !moultrieNames.has(n));
  const b = [...(moultrieNames || [])].filter((n) => !marionNames.has(n));
  return Object.fromEntries([[MARION, a.sort()], [MOULTRIE, b.sort()]]);
}

/**
 * The water a report puts `species` over: [{ ft: [lo, hi|null], quote }].
 *
 * With `lake` ({ slug, places }) on Marion or Moultrie, only a sentence about THAT lake counts, and
 * each row says which lake and how that was known (`lake`, `lakeFrom`) -- see santeeLakesIn().
 *
 * `docLake` is the lake the whole text is about when someone who knows has said so: Ryan, pasting a
 * report (pasted-reports.js). Every paragraph starts on it; a sentence or heading that names the
 * other lake is still the other lake's.
 */
export function reportWaterFor(text, species, lake = null, docLake = null) {
  const target = speciesRe(species);
  const sys = lake && SANTEE_LAKES.includes(lake.slug) ? lake : null;
  const one = (set) => (set.size === 1 ? [...set][0] : null);
  const out = [];
  let heading = null;                 // null: no heading yet; [] : a heading that names no fish
  const said = sys && SANTEE_LAKES.includes(docLake) ? docLake : null;
  const SAID_BY = "Ryan's own note on it";
  let headingLake = said;
  let headingFrom = said ? SAID_BY : null;
  let prevNamed = false;
  for (const raw of String(text || '').split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    if (isHeading(line)) {
      heading = target.test(line) ? ['target'] : ANY_FISH.test(line) ? ['other'] : [];
      const own = sys ? one(santeeLakesIn(line, sys.places)) : null;
      headingLake = own || said;
      headingFrom = own ? 'its heading' : said ? SAID_BY : null;
      prevNamed = false;
      continue;
    }
    let paraLake = headingLake;
    let paraFrom = headingFrom;
    // SCDNR writes each fish as a paragraph that opens with its name: "Striped bass: Captain ...".
    // And each part of a lake the same way: "Upper Lake Marion: At the top of the upper lake, ...".
    const label = line.match(/^([A-Z][A-Za-z &/'-]{2,40}):\s+(.+)$/);
    let local = heading;
    if (label && label[1].split(/\s+/).length <= 4) {
      local = target.test(label[1]) ? ['target'] : ANY_FISH.test(label[1]) ? ['other'] : [];
      const labelLake = sys ? one(santeeLakesIn(label[1], sys.places)) : null;
      if (labelLake) { paraLake = labelLake; paraFrom = 'its paragraph'; }
      line = label[2];
      prevNamed = false;
    }
    for (const s of sentencesOf(line)) {
      const names = target.test(s);
      const about = names || (local && local[0] === 'target')
        || (local === null && prevNamed);
      prevNamed = names;
      // The lake is followed whether or not this sentence is about the fish, so a paragraph that
      // opens "In the upper lake ..." carries Marion to the sentence with the depth in it.
      let lakeOf = null;
      let lakeFrom = null;
      if (sys) {
        const own = santeeLakesIn(s, sys.places);
        if (own.size === 1) { lakeOf = one(own); lakeFrom = 'the sentence'; paraLake = lakeOf; paraFrom = 'its paragraph'; }
        else if (!own.size && paraLake) { lakeOf = paraLake; lakeFrom = paraFrom; }
      }
      if (!about) continue;
      if (sys && lakeOf !== sys.slug) continue;
      const quote = s.length > 300 ? `${s.slice(0, 297)}...` : s;
      for (const ft of waterRangesIn(s)) out.push(sys ? { ft, quote, lake: lakeOf, lakeFrom } : { ft, quote });
    }
  }
  return out;
}

const ym = (d) => String(d || '').slice(0, 7);
const prevYm = (planDate) => {
  const y = Number(planDate.slice(0, 4));
  const m = Number(planDate.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/**
 * IS THIS MONTH'S REPORT? A dated report counts if it was published in the plan's month or the
 * month before it -- these are monthly reports, posted around the turn of the month, so that pair
 * is "the latest one". An undated one (SCDNR) counts if a month it names is one of the same two.
 * A June video in October, or last October's video, is in the plan as reading, not as water.
 */
export function isCurrentReport(r, planDate) {
  if (!r || !/^\d{4}-\d{2}/.test(String(planDate || ''))) return false;
  const want = [ym(planDate), prevYm(planDate)];
  if (r.published) return want.includes(ym(r.published));
  if (r.monthYear) return want.includes(r.monthYear);         // "OCTOBER 2026 FISHING REPORT"
  const names = (r.monthsNamed || (r.monthNamed ? [r.monthNamed] : [])).map((m) => String(m).toLowerCase());
  const months = want.map((w) => MONTH_NAMES[Number(w.slice(5, 7)) - 1]);
  return names.some((n) => months.includes(n));
}

/**
 * THE NEWER REPORT FROM THE SAME GUIDES WINS. Santee Cooper Country's site and its Facebook page
 * carry one report, the post usually days ahead of the site. The older is kept and marked, not
 * dropped, so the trip report can still show it. A same-month-last-year video (`role`) is a
 * different question and is never superseded.
 */
export function supersede(reports) {
  const list = (reports || []).map((r) => ({ ...r }));
  const key = (r) => (r.role && r.role !== 'newest') ? null : r.guides || null;
  // A search preview has no date, only the month it names ("2026-10"), which still sorts against a
  // date ("2026-09-04") the right way round.
  const when = (r) => String(r.published || r.monthYear || '');
  for (const r of list) {
    const k = key(r);
    if (!k) continue;
    // A SEARCH PREVIEW DOES NOT PUSH A REPORT OUT OF THE PROMPT. It is a line or two of a post
    // nobody could read, and on 2026-10-01 it pushed Santee Cooper Country's whole September page
    // out. So the September page is still printed -- but it is no longer this month's word from
    // those guides, so its water does not count for the lanes (`outdatedBy`). Its "10 to 15 ft of
    // water" under "## Striper" was written in a closed season about drifting for catfish at night.
    const newer = list.find((o) => o !== r && !o.preview && key(o) === k && when(o) > when(r));
    if (newer) r.supersededBy = newer.label;
    const newest = list.find((o) => o !== r && key(o) === k && when(o) > when(r));
    if (newest) r.outdatedBy = newest.label;
  }
  return list;
}

/**
 * The water this month's reports put the plan's species over, one row per range per report.
 */
export function reportWaterForPlan(reports, species, planDate, lake = null) {
  const out = [];
  for (const r of reports || []) {
    if (r.supersededBy || r.outdatedBy || !isCurrentReport(r, planDate)) continue;
    for (const sp of [].concat(species || [])) {
      const seen = new Set();
      for (const w of reportWaterFor(r.text, sp, lake, r.aboutLake || null)) {
        const k = `${w.ft[0]}-${w.ft[1]}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ species: sp, ft: w.ft, quote: w.quote, label: r.label, url: r.url || null,
                   published: r.published || null, monthNamed: r.monthNamed || null,
                   ...(w.lake ? { lake: w.lake, lakeFrom: w.lakeFrom } : {}) });
      }
    }
  }
  return out;
}
