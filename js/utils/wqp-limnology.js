/**
 * js/utils/wqp-limnology.js — what the Water Quality Portal pull means, in one place.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS IS ITS OWN FILE. These functions were written inside
 * `js/modules/lake-research-engine.js`, which only the browser's Research tab loads. The batch
 * that replaced that tab -- `Scripts/research_lakes.py`, 2026-09-01 -- drives the Worker's
 * endpoints instead, so it could not reach them. It saved profiles with a null thermocline, a
 * null anoxic depth, a null Secchi and a null trophic status, and `/research/save` replaces
 * rather than merges, so every one of the 64 researched waters LOST those numbers.
 *
 * Measured 2026-09-02 on LAKE WATEREE, SC, straight off the Worker:
 *
 *     limnology.thermocline.summerDepthFt   null
 *     limnology.oxygen.anoxicBelowFt        null
 *     limnology.waterClarity.secchiFt       null
 *     limnology.trophicStatus               null
 *     limnology.seasonalDrawdownFt          2.5      <- the one field deterministic.js writes
 *
 * `researchIntel()` prints the first four into the plan prompt, and `clampToOxygen()` squeezes
 * the depth band against the anoxic boundary -- so with these null the plan lost the two lines
 * the code itself calls "the two that decide where the fish can physically be", and the clamp
 * quietly stopped clamping.
 *
 * Ryan's plan, written 2026-09-01 in THE_PROFILE_BECAME_A_CACHE_AND_NOBODY_MOVED_THE_READS:
 * step 3 "write the sequencer" and step 4 "give WQP a TTL and put its refresh on the existing
 * cron". Step 3 shipped the same day; step 4 did not, and step 5 said the profile keeps "the WQP
 * limnology block with its dates". Running 3 without 4 deleted what 5 keeps.
 *
 * So the rule lives here, imported by the Worker's `/research/limnology-data` -- which serves the
 * batch and the tab alike -- and by the browser engine. `Worker/research/limnology.js` already
 * imports from `js/data/` and `js/utils/`, so this is the established shape and not a new one.
 */

/** The evidence row shape. One definition, because a citation that drifts is worse than none. */
export function buildEvidenceEntry(sourceType, sourceLabel, sourceUrl, quote, method, extra = {}) {
  return { sourceType, sourceLabel, sourceUrl, quote: quote || null, method, ...extra };
}

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

// WQP WINS WHERE WQP HAS AN ANSWER.
//
// These values were once written ONLY INTO A HOLE -- `!hasResearchValue(...)` -- so the retired
// limnology agent's answer won whenever it had one. The consequence was not just a worse number:
// buildWqpEvidence() stamps `limnology.thermocline` with "Water Quality Portal / SCDES
// monitoring" and the derivation method, so a model's recalled depth was stored under a citation
// to state monitoring data that did not produce it. A wrong number is a wrong number; a wrong
// number wearing an official source is how it never gets caught.
//
// `waterClarity.typical` rides the same Carlson boundaries as `trophicStatus` because it is the
// same measurement in words -- one scale, two labels, rather than a second set of cut-offs.
// Lakes with turbidity and no Secchi keep a null `typical` and carry the measured NTU in `note`;
// there is no published NTU-to-adjective scale to bucket those against, and guessing one is the
// thing this refactor is removing.
export function applyWqpToLimnology(base = {}, wqp = null) {
  const out = clone(base) || {};
  if (!wqp?.ok) return out;
  out.surfaceWater = out.surfaceWater || {};
  if (wqp.surfaceWater) {
    Object.assign(out.surfaceWater, wqp.surfaceWater);
  }
  out.waterClarity = out.waterClarity || {};
  if (wqp.surfaceWater?.recentTurbidityNTU != null && !out.waterClarity.note) {
    out.waterClarity.note = `Recent WQP/SCDES surface turbidity around ${wqp.surfaceWater.recentTurbidityNTU} NTU.`;
  }
  const secchiFt = wqp.secchi?.avgSecchiDepthFt;
  if (secchiFt != null) {
    out.waterClarity.secchiFt = secchiFt;
    // Carlson TSI(SD) boundaries, in feet. One set of thresholds, read twice.
    if (wqp.secchi.sampleCount >= 5) {
      if (secchiFt < 1.6)       { out.trophicStatus = 'hypereutrophic'; out.waterClarity.typical = 'muddy'; }
      else if (secchiFt < 6.6)  { out.trophicStatus = 'eutrophic';      out.waterClarity.typical = 'stained'; }
      else if (secchiFt < 13.0) { out.trophicStatus = 'mesotrophic';    out.waterClarity.typical = 'clear'; }
      else                      { out.trophicStatus = 'oligotrophic';   out.waterClarity.typical = 'very clear'; }
    }
  }
  if (wqp.thermocline?.depthFt != null) {
    out.thermocline = out.thermocline || {};
    out.thermocline.summerDepthFt = wqp.thermocline.depthFt;
    out.thermocline.method = wqp.thermocline.method || null;
    out.thermocline.note = wqp.note || out.thermocline.note || null;
  }
  if (wqp.oxygen) {
    out.oxygen = out.oxygen || {};
    if (wqp.oxygen.anoxicBelowFt != null) out.oxygen.anoxicBelowFt = wqp.oxygen.anoxicBelowFt;
    if (wqp.oxygen.depletionDepthFt != null) out.oxygen.depletionDepthFt = wqp.oxygen.depletionDepthFt;
    out.oxygen.note = wqp.oxygen.note || out.oxygen.note || null;
  }

  // A REFUSAL IS AN ANSWER, AND IT HAS TO TRAVEL TO THE FIELD IT REFUSED.
  //
  // The pull says WHY it could not derive a depth -- `surfaceOnlyNote` on the cache object reads
  // "Monitoring data were found, but available records are surface/grab samples only -- no
  // vertical depth profiles. Thermocline cannot be derived from this source." Until now that
  // sentence was written into `limnology-cache/<id>.json` and stopped there: both branches above
  // are gated on a value existing, so a water WQP honestly refused ended up with
  // `thermocline: { summerDepthFt: null, method: null, note: null }` in its profile.
  //
  // Measured 2026-09-05 on Lake Moultrie (Berkeley Co, SC): 5,227 records, `depthProfileCount: 0`,
  // the note above sitting in the cache, and a profile carrying three nulls and no reason. Checked
  // at record level against WQP -- every published visit from both organisations that monitor the
  // lake is one activity with one dissolved-oxygen value and a companion `Depth = 0.3 m` row, and
  // not one row in the bucket carries `ActivityDepthHeightMeasure`. There is nothing to parse.
  //
  // A null with no reason beside it is the hole a model fills from its own recall. Lake Wateree
  // carried a fabricated thermocline of 27 ft for months in exactly that shape. "We asked and the
  // data cannot answer" and "nobody has asked" have to look different to whoever reads this next,
  // and one of those two readers is a language model.
  //
  // Written only where the value is still missing, so a depth that came from a document is never
  // annotated with a sentence about a source that did not produce it. `limnologyGaps` keys on the
  // value fields alone, so the water still counts as needing research.
  const refusal = wqp.surfaceOnlyNote || wqp.note || null;
  if (refusal) {
    out.thermocline = out.thermocline || {};
    if (out.thermocline.summerDepthFt == null) out.thermocline.note = refusal;
    out.oxygen = out.oxygen || {};
    if (out.oxygen.anoxicBelowFt == null && out.oxygen.depletionDepthFt == null) {
      out.oxygen.note = refusal;
    }
  }
  return out;
}

// THE CASTS WE HOLD, WRITTEN ONLY INTO WHAT WQP LEFT NULL.
//
// `_registry/document_limnology.json` collapses the EPA National Lakes Assessment profiles and
// the 1973 National Eutrophication Survey casts into the fields above, keyed by registry slug.
// Built by Scripts/build_document_limnology.py, loaded by Worker/registry.js.
//
// SEVENTH FILE ADDRESSED TO NOBODY. `fetch_nla_limnology.py` has written its source since
// 2026-09-04 and `upload_garmin_to_r2.py` has shipped it to R2 since the same day; the only file
// that opened it was the audit that COUNTS what it would fix. Measured by that audit on
// 2026-09-05: thirteen waters hold a measured thermocline or anoxic depth while their stored
// profile carries null -- Wateree, Brandt, Quaker Creek, Bear Creek, Cooley, Yonah, Little
// Ocmulgee, Edwin Johnson, Mott, Lee, Russell, Southern Pines Waterworks, Kings Mountain No. 1.
//
// HOLES ONLY, AND THE ORDER IS NOT ARBITRARY. WQP is this water, sampled by the agency that
// monitors it, usually within the last few years. A National Lakes Assessment cast is one visit
// to a statistically selected site, and the 1973 survey is fifty-three years old. Where the
// measurement of record exists it stands; where it is null, an old cast beats nothing, and the
// note says which cast and when so nobody mistakes 1973 for last summer.
//
// It also has to beat the REFUSAL that applyWqpToLimnology() writes. That function puts
// "available records are surface/grab samples only -- no vertical depth profiles" into
// `thermocline.note` when it cannot derive a depth, and Lake Wateree's profile carries exactly
// that sentence beside a null while `nla_limnology.json` holds an anoxic depth of 19.7 ft from an
// actual cast. A note explaining why we have no answer must not survive next to an answer, so
// the note is REPLACED wherever this writes a value.
//
// `offered: false` rows are skipped. The SC DES lake-program statements ride in the same file
// and are held: the 2021 and 2022 Lake Murray reports state a boundary below 3-4 m at S-326, in
// the Clouds Creek arm, whose average total depth those reports print as 5.1 m, in a lake our
// chart takes to 192 ft. Whether an arm may speak for a lake is a fishing judgment, not a
// threshold, and until someone makes it that number is not a profile field.
export function applyDocumentsToLimnology(base = {}, doc = null) {
  const out = clone(base) || {};
  if (!doc || doc.offered === false) return out;
  if (doc.thermoclineFt != null) {
    out.thermocline = out.thermocline || {};
    if (out.thermocline.summerDepthFt == null) {
      out.thermocline.summerDepthFt = doc.thermoclineFt;
      out.thermocline.method = 'document_vertical_profile';
      out.thermocline.note = doc.thermoclineNote || null;
    }
  }
  if (doc.anoxicBelowFt != null || doc.depletionDepthFt != null) {
    out.oxygen = out.oxygen || {};
    const wrote = [];
    if (doc.anoxicBelowFt != null && out.oxygen.anoxicBelowFt == null) {
      out.oxygen.anoxicBelowFt = doc.anoxicBelowFt;
      wrote.push(doc.anoxicNote);
    }
    if (doc.depletionDepthFt != null && out.oxygen.depletionDepthFt == null) {
      out.oxygen.depletionDepthFt = doc.depletionDepthFt;
      wrote.push(doc.depletionNote);
    }
    const note = wrote.filter(Boolean)[0];
    if (note) out.oxygen.note = note;
  }
  return out;
}

// The citation for what the documents actually supplied, in the same shape buildWqpEvidence()
// writes and for the same reason: a value stored without a row saying where it came from is how
// Lake Wateree carried a fabricated 27 ft thermocline for months.
export function buildDocumentEvidence(doc, applied) {
  if (!doc || doc.offered === false || !applied) return {};
  const sourceUrl = 'registry:_registry/document_limnology.json';
  const LABEL = (doc.sources || []).join(' / ') || 'EPA vertical profile survey';
  const evidence = { limnology: {} };
  const row = (quote) => [buildEvidenceEntry('official_structured', LABEL, sourceUrl, quote || null,
    'document_vertical_profile', { castCount: doc.castCount || null })];
  if (applied.thermocline) evidence.limnology.thermocline = row(doc.thermoclineNote);
  if (applied.oxygen) evidence.limnology.oxygen = row(doc.anoxicNote || doc.depletionNote);
  return Object.keys(evidence.limnology).length ? evidence : {};
}

// Which fields this pass actually wrote, so the evidence rows describe stored values and no
// others. Compared before and after rather than re-deriving the conditions in two places.
export function documentFieldsApplied(before, after) {
  const at = (o, a, b) => (o && o[a] ? o[a][b] : undefined);
  return {
    thermocline: at(before, 'thermocline', 'summerDepthFt') == null
              && at(after, 'thermocline', 'summerDepthFt') != null,
    oxygen: (at(before, 'oxygen', 'anoxicBelowFt') == null
             && at(after, 'oxygen', 'anoxicBelowFt') != null)
         || (at(before, 'oxygen', 'depletionDepthFt') == null
             && at(after, 'oxygen', 'depletionDepthFt') != null),
  };
}

// An evidence row is a claim about where a stored value came from, so it is written for the
// fields this pass actually stores and no others. `waterClarity` and `trophicStatus` were once
// derived and cited nowhere, while `thermocline` was cited whether or not the derived depth
// survived the agent merge.
export function buildWqpEvidence(wqp) {
  if (!wqp?.ok) return {};
  const sourceUrl = 'worker:/research/limnology-data';
  const LABEL = 'Water Quality Portal / SCDES monitoring';
  const entry = buildEvidenceEntry('official_structured', LABEL, sourceUrl, null, 'structured_surface_monitoring', { lastObserved: wqp.lastObserved, recordCount: wqp.recordCount });
  const evidence = { limnology: {} };
  if (wqp.surfaceWater) evidence.limnology.surfaceWater = [entry];
  if (wqp.thermocline?.depthFt != null) {
    evidence.limnology.thermocline = [buildEvidenceEntry('official_structured', LABEL, sourceUrl, null, wqp.thermocline.method || 'depth_profile_derivation', { lastObserved: wqp.lastObserved, evidenceCount: wqp.thermocline.evidenceCount })];
  }
  if (wqp.oxygen && (wqp.oxygen.anoxicBelowFt != null || wqp.oxygen.depletionDepthFt != null)) {
    evidence.limnology.oxygen = [buildEvidenceEntry('official_structured', LABEL, sourceUrl, null, 'do_depth_profile_thresholds', { lastObserved: wqp.lastObserved, evidenceCount: wqp.oxygen.evidenceCount })];
  }
  if (wqp.secchi?.avgSecchiDepthFt != null) {
    const clarity = buildEvidenceEntry('official_structured', LABEL, sourceUrl, null, wqp.secchi.basis === 'turbidity' ? 'turbidity_samples' : 'secchi_samples', { lastObserved: wqp.secchi.lastObserved || wqp.lastObserved, evidenceCount: wqp.secchi.sampleCount });
    evidence.limnology.waterClarity = [clarity];
    // The trophic bucket IS the secchi reading, read against Carlson's boundaries.
    if (wqp.secchi.sampleCount >= 5) evidence.limnology.trophicStatus = [buildEvidenceEntry('official_structured', LABEL, sourceUrl, null, 'carlson_tsi_from_secchi', { lastObserved: wqp.secchi.lastObserved || wqp.lastObserved, evidenceCount: wqp.secchi.sampleCount })];
  }
  return evidence;
}

/**
 * Which limnology fields the WQP pull did NOT answer.
 *
 * Ryan, 2026-09-02: *"we need the wqp to be there so as to know whether limnology information is
 * needed to be pulled from the facts."* That is the three-bucket rule applied to one section --
 * a document is asked only for what the measured pull could not supply, instead of being asked
 * for all of it on every run and having the answer thrown away.
 */
export const WQP_LIMNOLOGY_FIELDS = [
  'limnology.thermocline.summerDepthFt',
  'limnology.oxygen.anoxicBelowFt',
  'limnology.oxygen.depletionDepthFt',
  'limnology.waterClarity.secchiFt',
  'limnology.trophicStatus',
];

export function limnologyGaps(limnology) {
  const at = (path) => path.split('.').slice(1)
    .reduce((o, k) => (o == null ? o : o[k]), limnology || {});
  return WQP_LIMNOLOGY_FIELDS.filter((p) => {
    const v = at(p);
    return v === null || v === undefined || v === '';
  });
}
