/**
 * research/behaviour.js — reading fishing behaviour out of already-extracted facts.
 *
 * Ryan, 2026-08-10: "why do we need the agent at all for this... the information is there why not
 * just use a parser for the articles that contain the information" — and then, on what to do with
 * the result: "pass the parsed info to the agent to put into the right place."
 *
 * That is the split this file exists to make. THE PARSER OWNS THE VALUES. THE AGENT OWNS THE
 * PLACEMENT. A holding pattern is three words and a depth is two numbers and a unit; neither needs
 * judgement, and asking a language model for them bought nothing but variance. Striper summer came
 * back [15,40], then [16,20], then [16,25], then [15,40] across four runs of the same documents,
 * and `holding` came back null every time while the same model wrote "anchoring cut bait on the
 * bottom" into the notes field beside it.
 *
 * What the agent is genuinely good at, and what a regex cannot do, is deciding that a sentence
 * about pre-spawn staging in March belongs to striped bass in SPRING when the document labels
 * neither. So it keeps that job and loses the other one.
 *
 * IT READS FACTS, NOT DOCUMENTS. `_extractedFacts` already carries one claim per entry with a
 * verbatim quote and a source title attached, produced per-document by the extraction pass. That
 * is a far better input than raw article text: the sentences are already isolated, already
 * attributed to this lake, and already carry the evidence string that has to travel with any
 * value the app later acts on.
 *
 * EVERY OBSERVATION CARRIES ITS QUOTE. A number with no sentence behind it is exactly what got us
 * here — see claude/WHAT_SMARTPLAN_IS_2026-08-09.md on measurements versus decisions. When
 * SmartPlan eventually says the fish are at 20 ft, this is what lets it say why.
 */

// ── the vocabulary ──────────────────────────────────────────────────────────────────────────
//
// HOW THE FISH ARE FISHED, NOT WHERE THEY ARE. An earlier cut of this included `flats` and
// `mussel beds` and immediately mislabelled White Perch as bottom-relating: those are structures,
// they say where the boat is, and they are silent on whether the fish are on the bottom or up in
// the column. Presentation and explicit behaviour language are the only reliable signals, and
// dropping structure terms took the classifier from wrong-in-places to right-where-it-fires.

const BOTTOM = [
  /on the bottom/i, /\bbottom[- ]?hugging\b/i, /hugging the bottom/i, /\bbottom rigs?\b/i,
  /relat\w+ to the bottom/i, /\bdragging\b/i, /bumping bottom/i, /\bon the floor\b/i,
  /anchor\w*/i, /tight[- ]?lin\w+/i, /vertical jig\w*/i, /\bbottom\b/i,
  // NOT `cut bait`. It names a bait, not a position, and "his go-to baits are white perch and
  // gizzard shad" duly came back as White Perch holding on the bottom. The words that carry the
  // signal are anchoring, dragging and bottom itself; bait type carries none of it.
];

const SUSPENDED = [
  /suspend\w*/i, /thermocline/i, /water column/i, /above the thermocline/i, /open water/i,
  /top ?water/i, /surface schooling/i, /surface activity/i, /schooling/i, /down ?lines?\b/i,
  /free ?lines?\b/i, /planer boards?/i, /long[- ]?line troll\w*/i, /up off the bottom/i,
  /push\w* bait to the surface/i, /blanketing/i,
];

const SEASONS = { spring: /\bspring|march|april|may\b/i, summer: /\bsummer|june|july|august\b/i,
                  fall: /\bfall|autumn|september|october|november\b/i,
                  winter: /\bwinter|december|january|february\b/i };

// Deliberately loose and deliberately only a HINT. The agent decides which species a fact belongs
// to; this only narrows the field for it, and a wrong guess here costs nothing because the agent
// sees the quote and can overrule it.
const SPECIES_HINT = [
  ['Striped Bass', /strip\w*\s*bass|striper/i], ['Hybrid', /hybrid/i], ['White Bass', /white bass/i],
  ['Largemouth Bass', /largemouth/i], ['Smallmouth Bass', /smallmouth/i], ['Spotted Bass', /spotted bass/i],
  ['Blue Catfish', /blue ?cat/i], ['Channel Catfish', /channel ?cat/i], ['Flathead Catfish', /flathead/i],
  ['Catfish', /\bcat(?:fish|s)\b/i], ['Crappie', /crappie/i], ['White Perch', /white perch/i],
  ['Bluegill', /bluegill|bream/i], ['Redear Sunfish (Shellcracker)', /redear|shellcracker/i],
  ['Warmouth', /warmouth/i], ['Redbreast Sunfish', /redbreast/i],
];

const first = (text, pats) => {
  for (const p of pats) { const m = p.exec(text); if (m) return m[0].toLowerCase(); }
  return null;
};

/**
 * Categories that are about the LAKE, not about fish.
 *
 * "Maximum Depth: Approximately 225 feet" and "Full pond elevation is 225.5 feet" are facts, and
 * they are not behaviour. Reading a depth out of them produced a 225 ft fish and a 5 ft one -- the
 * second because a regex written as \d{1,3} happily matched the "5" inside "225.5".
 */
const NOT_BEHAVIOUR = new Set([
  'surfacearea', 'maxdepthft', 'averagedepthft', 'poollevel', 'drawdownschedule', 'secchi',
  'trophicstatus', 'hydraulicretentiondays', 'yearimpounded', 'damname', 'county',
  'reservoirowner', 'riversystem', 'ramp', 'hazard', 'consumptionadvisory', 'stocking',
  'creellimit_general', 'creellimit_lakespecific', 'sizelimit_general', 'sizelimit_lakespecific',
  'closedseason',
]);

// A depth only counts if the sentence is about fish doing something. Without this, every
// bathymetry line in every agency PDF becomes a behaviour observation.
const FISHY = /fish|bass|crappie|cat(?:fish)?|striper|perch|bream|bluegill|bite|troll|drift|anchor|hold|suspend|spawn|school|feed|angler|caught|target/i;

/** A depth range in feet, and whether the sentence frames it as the WATER or as the FISH. */
function depths(text) {
  const out = [];
  if (!FISHY.test(text)) return out;
  // DECIMAL-AWARE, AND NOT MID-NUMBER. `(?<![\d.])` is what stops "225.5 feet" yielding a 5, and
  // the optional fraction is what stops "6.9 feet" yielding a 9. Both shipped in the first cut of
  // this file and both were caught by running it over Ryan's real profile instead of trusting it.
  const re = /(?<![\d.])(\d{1,3}(?:\.\d+)?)\s*(?:to|-|–|—)\s*(\d{1,3}(?:\.\d+)?)\s*(?:feet|ft|foot)\b|(?<![\d.])(\d{1,3}(?:\.\d+)?)\s*(?:feet|ft|foot)\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const lo = Math.round(Number(m[1] !== undefined ? m[1] : m[3]));
    const hi = Math.round(Number(m[2] !== undefined ? m[2] : m[3]));
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi || hi > 200 || hi < 1) continue;
    // THE DISTINCTION THAT STARTED ALL OF THIS. "in 35 feet of water" is the bottom; "20 feet
    // down" is the fish. A sentence carrying both gives us both, and collapsing them into one
    // number is the error that had the app matching fish depth against the lake bed.
    const tail = text.slice(m.index, m.index + m[0].length + 24);
    const isWater = /of water|deep water|water deep|depth of water/i.test(tail);
    const isFish = /\bdown\b|holding|suspend|hold at|target depth|ideal/i
      .test(text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20));
    out.push({ range: [lo, hi], kind: isWater ? 'water' : (isFish ? 'fish' : 'ambiguous') });
  }
  return out;
}

/**
 * Turn `_extractedFacts` into typed observations the fisheries agent can be told to place.
 *
 * Returns [] rather than throwing on anything malformed — this runs inside a research pass that
 * must degrade rather than fail, the same rule every other source in this tree follows.
 *
 * @param {Array<{fact:string, quote:string, source:string, category:string}>} facts
 * @returns {Array<{kind:string, value:*, speciesHint:?string, seasonHint:?string,
 *                  quote:string, source:string}>}
 */
export function parseBehaviour(facts) {
  if (!Array.isArray(facts)) return [];
  const out = [];
  for (const f of facts) {
    if (!f || typeof f !== 'object') continue;
    if (NOT_BEHAVIOUR.has(String(f.category || '').toLowerCase().trim())) continue;
    const text = `${f.fact || ''} ${f.quote || ''}`.trim();
    if (text.length < 12) continue;

    const speciesHint = (SPECIES_HINT.find(([, re]) => re.test(text)) || [null])[0];
    let seasonHint = null;
    for (const [s, re] of Object.entries(SEASONS)) if (re.test(text)) { seasonHint = s; break; }

    const b = first(text, BOTTOM), s = first(text, SUSPENDED);
    const holding = (b && s) ? 'both' : b ? 'bottom' : s ? 'suspended' : null;

    const base = { speciesHint, seasonHint,
                   quote: String(f.quote || f.fact || '').slice(0, 300),
                   source: String(f.source || '').slice(0, 120) };

    if (holding) out.push({ kind: 'holding', value: holding, evidence: b || s, ...base });
    for (const d of depths(text)) {
      if (d.kind === 'water') out.push({ kind: 'waterDepthFt', value: d.range, ...base });
      else if (d.kind === 'fish') out.push({ kind: 'fishDepthFt', value: d.range, ...base });
      else out.push({ kind: 'depthFt_unclear', value: d.range, ...base });
    }
  }
  // The same sentence reaches here more than once -- a fact and its own quote overlap, and two
  // documents often carry the same claim -- so identical observations are collapsed. A duplicate
  // in the prompt reads as corroboration and it is not.
  const seen = new Set();
  return out.filter((o) => {
    const k = `${o.kind}|${JSON.stringify(o.value)}|${o.speciesHint}|${o.seasonHint}|${o.quote.slice(0, 60)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The observations as a prompt block: one line each, quote attached.
 *
 * Capped, because this rides inside a prompt that has already been too large once. The cap is
 * STATED in the block rather than applied silently -- an agent told "here is the evidence" and
 * handed a truncated list without being told will fill the gap from its own knowledge, which is
 * the failure this whole design is meant to remove.
 */
export function behaviourBlock(observations, cap = 60) {
  const obs = Array.isArray(observations) ? observations : [];
  if (!obs.length) return '';
  const shown = obs.slice(0, cap);
  const lines = shown.map((o, i) => {
    const val = Array.isArray(o.value) ? `${o.value[0]}-${o.value[1]} ft` : String(o.value);
    const who = o.speciesHint || 'species not stated';
    const when = o.seasonHint || 'season not stated';
    return `[${i + 1}] ${o.kind} = ${val} · ${who} · ${when} · "${o.quote}" (${o.source})`;
  });
  const dropped = obs.length - shown.length;
  return `\n\nPARSED OBSERVATIONS — these are the VALUES. Do not invent alternatives to them.\n`
    + `Each line was read out of a source document by a deterministic parser, and the verbatim\n`
    + `sentence it came from is quoted. Your job for these is PLACEMENT, not extraction: decide\n`
    + `which species and which season each one belongs to, using the quote to judge, and copy the\n`
    + `value across unchanged. The species and season shown are hints from the same parser and are\n`
    + `often absent or wrong -- overrule them from the quote whenever it is clearer.\n`
    + `A value you cannot confidently place belongs nowhere. Leave it out rather than guessing.\n`
    + lines.join('\n')
    + (dropped > 0 ? `\n... and ${dropped} further observation(s) not shown here.` : '');
}
