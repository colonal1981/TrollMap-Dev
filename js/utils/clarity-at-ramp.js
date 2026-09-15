/**
 * clarity-at-ramp.js — WHICH CLARITY ZONE HE IS LAUNCHING IN, AND THEREFORE WHAT THE PLAN IS BUILT ON.
 *
 * Ryan, 2026-09-14, reading a CAUTION line that said the lake was muddy: *"this is probably correct
 * in the creeks or the northern section of the lake but i highly doubt it is applicable near
 * clearwater cove... what is it using to calculate the clarity??? i thought we made it location
 * aware?"*
 *
 * It is location aware and two readers were not using that half. `/lake-clarity` returns a score per
 * zone — Wateree has six, the upper river and Dutchmans Creek at sensitivity 1.45 and 1.35 over clay
 * banks, the dam basin at 0.70 — and an `overall` that is the MEAN of them. His ramp, "Clearwater
 * Cove", is named in the dam basin's own ramp list, the clearest zone on the lake.
 *
 * ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────────────────────────
 *
 * My first answer to him added an AT YOUR RAMP sentence to the briefing and left the line below it
 * writing `d.overall.select` into the Water Clarity select. That select is not a label:
 * smart-plan-v2-wiring.js reads it as `clarity`, it reaches the model as `conditions.clarity`, and
 * getLureColor() picks every colour off it. Measured on his 2026-09-14 Wateree bench, the prompt
 * carried `"clarity": "Muddy"` two lines above the profile's own `Typical clarity: stained` — two
 * clarity verdicts for one lake in one prompt, the same defect shape as the two water temperatures
 * fixed in bd48bcf, and the one that read as TODAY was an average of water he was not fishing.
 *
 * So the resolution lives here, as one pure function with no DOM in it, and the sentence and the
 * PLAN'S INPUT both read it. One answer, two readers — rather than a sentence that knew and a
 * number that did not.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */

const list = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/**
 * The zone whose own ramp list names this launch, or null.
 *
 * MATCHED BOTH WAYS ON PURPOSE. The zone profile says "Clearwater Cove Marina" and the plan's ramp
 * select says "Clearwater Cove"; the registry and the clarity profile are two hand-kept lists of the
 * same places and neither is the other's canonical spelling. Containment in either direction is what
 * makes those two agree without a third list mapping one onto the other.
 *
 * A one-or-two character value cannot match by containment — "SC" is inside a dozen ramp names — so
 * anything shorter than three characters is treated as no answer rather than as a wildcard.
 */
export function zoneForRamp(zones, rampName) {
  const want = norm(rampName);
  if (want.length < 3) return null;
  return list(zones).find((z) => list(z && z.ramps)
    .some((r) => {
      const have = norm(r);
      return have.length >= 3 && (have.includes(want) || want.includes(have));
    })) || null;
}

/**
 * WHAT THE PLAN SHOULD BE BUILT ON: `{ select, clarity, score, source, zone, why }`.
 *
 * `source` is 'ramp' when a zone names his launch and 'lake' when none does, and it is part of the
 * answer rather than something a caller infers — an unattributed clarity is how the mean came to be
 * read as a fact about his ramp in the first place.
 *
 * The mean is still the answer when no zone names the ramp. It is the only answer there is, and the
 * briefing says so out loud instead of implying the number is about here.
 */
export function clarityForPlan(payload, rampName) {
  const d = payload || {};
  const zone = zoneForRamp(d.zones, rampName);
  if (zone && zone.select) {
    return { select: zone.select, clarity: zone.clarity ?? null, score: zone.score ?? null,
             source: 'ramp', zone, why: `${rampName} is in ${zone.name}` };
  }
  const o = d.overall || null;
  if (o && o.select) {
    return { select: o.select, clarity: o.clarity ?? null, score: o.score ?? null,
             source: 'lake', zone: null,
             why: `no zone in this lake's model names ${rampName || 'the launch'}, so the lake-wide `
                + `mean of ${list(d.zones).length || '?'} zones is all there is` };
  }
  // NOT a default of 'Clear'. The select keeps whatever Ryan or a previous run put in it, because
  // guessing clear on a failed forecast is the one wrong answer that reads as a measurement.
  return { select: null, clarity: null, score: null, source: 'none', zone: null,
           why: 'the clarity model returned nothing to go on' };
}

// ── WHAT THIS WATER ORDINARILY IS, AND HOW FAR TODAY SITS OFF IT ────────────────────────────────
//
// Ryan, 2026-09-15: "i just need to know what 'normal' is and how far it is off from that normal...
// stained water means more on say lake murray than it does on wateree."
//
// The word cannot carry that by itself. STAINED on Wateree, whose 583 measured readings average
// 2.4 ft, is Tuesday; STAINED on a lake that usually reads eight feet is an event. So the word
// travels with the water's own baseline, and the baseline is not a new number: /lake-clarity runs
// its own model with the rainfall taken out and returns each zone's `normalClarity` beside its
// `clarity`. Rain is the only input describing TODAY, so the gap between the two is exactly what
// the weather did — a subtraction, with no threshold to choose.
const BANDS = ['Clear', 'Slight stain', 'Stained', 'Muddy', 'Muddy / debris risk'];
const bandIndex = (c) => {
  const i = BANDS.indexOf(String(c || ''));
  return i < 0 ? null : i;
};

/**
 * `{ bands, dirtier, normalClarity, sentence }` for the water he is actually launching in, or null
 * when the payload predates this and carries no `normalClarity`.
 *
 * ZONE FIRST, LAKE SECOND, for the same reason the clarity itself is resolved that way: the lake's
 * mean is an average of water he is not fishing. Falls back to the payload's lake-wide
 * `versusNormal` only when no zone named his ramp.
 */
export function versusNormalAt(payload, rampName) {
  const d = payload || {};
  const zone = zoneForRamp(d.zones, rampName);
  const now = zone ? bandIndex(zone.clarity) : null;
  const usual = zone ? bandIndex(zone.normalClarity) : null;
  if (zone && now != null && usual != null) {
    const bands = now - usual;
    const where = zone.name;
    return {
      bands,
      dirtier: bands > 0,
      normalClarity: zone.normalClarity,
      scope: 'ramp',
      sentence: bands === 0
        ? `${zone.clarity} is NORMAL for ${where}.`
        : `${where} is usually ${zone.normalClarity}; today ${zone.clarity} — `
          + `${Math.abs(bands)} band${Math.abs(bands) === 1 ? '' : 's'} `
          + `${bands > 0 ? 'DIRTIER' : 'CLEANER'} than normal.`,
    };
  }
  // The Worker's own lake-wide comparison, which carries the measured basis in its sentence.
  const v = d.versusNormal;
  if (v && typeof v.sentence === 'string') {
    return { bands: v.bands, dirtier: !!v.dirtier,
             normalClarity: (d.normally && d.normally.clarity) || null,
             scope: 'lake', sentence: v.sentence };
  }
  return null;
}
