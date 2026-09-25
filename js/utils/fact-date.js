// utils/fact-date.js — how a prompt says when a fact's text was written, in one place.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Every extracted fact carries `textDate` (Worker/research/text-date.js): "YYYY-MM-DD", "YYYY",
// "--MM-DD" when the page wrote no year, or null. plan-prompt.js's factLine() was the one prompt
// that printed it. The Worker's agents print facts too -- identity, navigation, regulations,
// fisheries' parsed observations, the coastal agents, map-facts and the validation pass -- and a
// second way of writing a date is a second thing a model has to learn to read. So the words live
// here and every one of those prompts calls this.
//
// TWO FACTS THAT DISAGREE. `/research/dedupe-contradictions` keeps both sides of a disagreement
// now, and a prompt that prints facts prints both. Where both carry a full date, the line says
// which is the newer -- and prints the older too: a regulation that changed is two facts, and the
// planner has to see both to know it changed. "Disagree" is the dedupe's own test, moved here so
// the prompt and the dedupe cannot come to mean different things by it.

const FULL = /^\d{4}-\d{2}-\d{2}$/;
const isFullDate = (d) => typeof d === 'string' && FULL.test(d);

// The categories whose facts can conflict at all: identity (acreage, depth, elevation) and
// regulations (creel/size limits). Built once, not on every comparison.
const IMPORTANT_CATEGORIES = new Set(['identity', 'surfacearea', 'maxdepth', 'averagedepth', 'elevation', 'regulations', 'creellimit_lakespecific', 'sizelimit_lakespecific', 'creellimit', 'sizelimit']);
const catOf = (f) => String((f && f.category) || 'general').toLowerCase().trim();
const canConflict = (cat) => IMPORTANT_CATEGORIES.has(cat) || cat.includes('identity') || cat.includes('regulation');

// THE WORKER HAS 10 MS OF CPU A REQUEST (the Cloudflare free plan; see research/shared.js). Asking
// every printed fact about every other one was 417 x 417 comparisons on Lake Wateree's facts, 13.8 ms
// on a desktop with every fact dated -- over the budget on its own. Only facts of the SAME category
// that can conflict, and that carry a full date, can ever be named "newer" or "older", so each
// prompt's facts are grouped that way once and a fact is compared only with its own group. The
// groups are kept against the `shown` array itself: every caller builds that array for one prompt
// and does not change it while it prints. Measured on the same four lakes' facts, every one given
// a full date: Wateree 13.7 ms -> 0.8 ms, with the same words on every line.
const _datedByCategory = new WeakMap();
function datedPeers(shown, f) {
  let groups = _datedByCategory.get(shown);
  if (!groups) {
    groups = new Map();
    for (const g of shown) {
      if (!g || !isFullDate(g.textDate)) continue;
      const c = catOf(g);
      if (!canConflict(c)) continue;
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(g);
    }
    _datedByCategory.set(shown, groups);
  }
  return groups.get(catOf(f)) || [];
}

/**
 * Do two facts make mutually exclusive numeric claims on the same attribute?
 *
 * Verbatim the test handleResearchDedupeContradictions() has always applied, taken out of its loop:
 * the same category, a category that can conflict at all (identity and regulations -- biology and
 * forage facts are almost always complementary), and different first numbers about the same
 * measurable attribute, not about different species, not both seasonal, and not the same numbers
 * phrased twice.
 */
function factsDisagree(a, b) {
  if (!a || !b || a === b) return false;
  const cat = catOf(a);
  if (cat !== catOf(b)) return false;
  if (!canConflict(cat)) return false;

  const prevText = String(a.fact).toLowerCase();
  const currText = String(b.fact).toLowerCase();
  // Only look for direct numeric conflicts on the exact same attribute
  // e.g. "13,710 acres" vs "13,025 acres" for surface area, or two different creel limits
  const numsPrev = prevText.match(/\d+(?:\.\d+)?/g) || [];
  const numsCurr = currText.match(/\d+(?:\.\d+)?/g) || [];
  if (!numsPrev.length || !numsCurr.length) return false;
  const nPrev = parseFloat(numsPrev[0]);
  const nCurr = parseFloat(numsCurr[0]);
  if (!isFinite(nPrev) || !isFinite(nCurr) || nPrev === nCurr) return false;
  // Require the facts to be talking about the exact same measurable attribute
  // (surface area, max depth, creel limit, size limit, elevation, etc.)
  const sameAttr = /acre|surface|depth|elevation|pool|creel|limit|size/i.test(prevText) &&
                   /acre|surface|depth|elevation|pool|creel|limit|size/i.test(currText);
  const relDiff = Math.abs(nPrev - nCurr) / Math.max(1, Math.min(nPrev, nCurr));
  // Don't flag as contradiction if facts mention different species
  const speciesNames = /largemouth|striped|hybrid|crappie|catfish|bream|walleye|pickerel|perch|bass|bluegill|redear|muskellunge|muskie/i;
  const prevSpecies = (prevText.match(speciesNames) || [])[0] || '';
  const currSpecies = (currText.match(speciesNames) || [])[0] || '';
  const differentSpecies = prevSpecies && currSpecies && prevSpecies.toLowerCase() !== currSpecies.toLowerCase();
  // Don't flag seasonal rules as contradictions (Oct-May vs Jun-Sep etc)
  const seasonPattern = /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d+\s*-\s*(may|sept|oct)|spring|summer|fall|winter|seasonal/i;
  const bothSeasonal = seasonPattern.test(prevText) && seasonPattern.test(currText);
  // Skip if both facts contain the same set of numbers — different phrasing of same fact
  const allNumsPrev = new Set((prevText.match(/\d+(?:\.\d+)?/g) || []).map(Number));
  const allNumsCurr = new Set((currText.match(/\d+(?:\.\d+)?/g) || []).map(Number));
  const sameNumbers = [...allNumsPrev].every(n => allNumsCurr.has(n)) && [...allNumsCurr].every(n => allNumsPrev.has(n));
  // 15% threshold filters rounding noise (48k vs 51k acres = 6.25%) while
  // catching real conflicts (13k vs 51k acres = 292%)
  return Boolean(sameAttr && relDiff > 0.15 && !differentSpecies && !bothSeasonal && !sameNumbers);
}

/**
 * " (written 2026-02-25)", " (written 10-02, year not stated)", or "" for a fact with no date --
 * the words factLine() has printed since the dates arrived. `shown` is every fact the same prompt
 * prints: against each one that disagrees with this fact, where both dates are full and differ,
 * the parenthesis says which of the two is the newer. Nothing is left out for being older.
 */
function writtenOf(f, shown = []) {
  const d = f && typeof f.textDate === 'string' && f.textDate ? f.textDate : '';
  if (!d) return '';
  const parts = [d.startsWith('--') ? `written ${d.slice(2)}, year not stated` : `written ${d}`];
  if (isFullDate(d) && Array.isArray(shown)) {
    for (const g of datedPeers(shown, f)) {
      if (!g || g === f || !isFullDate(g.textDate) || g.textDate === d || !factsDisagree(f, g)) continue;
      parts.push(`${d > g.textDate ? 'newer' : 'older'} than the fact written ${g.textDate} that disagrees with it`);
    }
  }
  return ` (${parts.join('; ')})`;
}

export { writtenOf, factsDisagree };
