// A FISH IN A BORROW PIT, FILED ON LAKE MARION, AT A DEPTH MEASURED A QUARTER MILE AWAY.
//
// Ryan read this off his own map popup:
//
//     🐟 Catfish 24.5"   Depth: 11 ft · Lead: — ft   12:12 PM · 2025-09-26
//     ... | Depth lookup: ~11ft contour (near, 0.17 mi)
//
// and said: "but the one i just posted isn't on lake marion LOL its in the borrow pit". Then,
// about a second one: "i have no idea where that fish was... its near anywhere i have fished"
// -- a 31.5" catfish carrying "Depth: 1 ft" from a contour 0.27 mi off.
//
// Two different faults wearing the same clothes. The borrow-pit fish has a GOOD position and a
// wrong LAKE, because nearestLakeAndContour() names a catch by the closest waterbody in the
// registry within its radius and a borrow pit is in no registry. The 31.5" has a bad position
// outright. But both printed a confident depth, and in both cases that depth was the depth of
// the nearest charted contour VERTEX -- 274 m and 435 m away respectively -- not of the water
// the fish came out of.
//
// The reach was recorded in the note from the first day and no screen ever showed it. Worse,
// the writer could not have shown it: the qualifier read
//
//     closestDist < 0.10 ? 'on' : closestDist < 0.25 ? 'near' : 'near'
//
// where both arms of the second branch say the same word, so 0.27 mi and 0.11 mi were
// described identically. Of the 57 looked-up depths in the journal, 52 are within 0.10 mi and
// honest; 5 are not, and the two fish Ryan could not place are both in those 5.
//
// A depth is a claim about a spot. It now needs the fix to be ON the contour to be made.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ON_CONTOUR_MI, parseDepthLookup, catchDepthLookupMi, isDepthCharted, describeCatchDepth
} from '../js/utils/catch-depth.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');

describe('the lookup distance survives the round trip through the CSV', () => {
  it('parses the note the journal writes', () => {
    const got = parseDepthLookup('The fish is clearly a Catfish | Depth lookup: ~11ft contour (near, 0.17 mi)');
    expect(got.depthFt).toBe(11);
    expect(got.distanceMi).toBe(0.17);
    expect(got.relation).toBe('near');
  });

  it('accepts the new "off" qualifier as well as the two already in the journal', () => {
    expect(parseDepthLookup('Depth lookup: ~3ft contour (on, 0.01 mi)').relation).toBe('on');
    expect(parseDepthLookup('Depth lookup: ~3ft contour (off, 0.612 mi)').distanceMi).toBe(0.612);
  });

  it('returns null for a depth nobody looked up', () => {
    expect(parseDepthLookup('Caught on a crankbait in the timber.')).toBe(null);
    expect(parseDepthLookup('')).toBe(null);
    expect(parseDepthLookup(undefined)).toBe(null);
  });

  it('reads the stored object when there is one and the note when there is not', () => {
    // exportJournalCsv() keeps `notes` and drops `structure`, so every one of the 157 rows
    // came back with structure: null. The note has to be a first-class source, not a fallback.
    expect(catchDepthLookupMi({ structure: { contourDistanceMi: 0.04 }, notes: '' })).toBe(0.04);
    expect(catchDepthLookupMi({ structure: null, notes: 'Depth lookup: ~11ft contour (near, 0.17 mi)' })).toBe(0.17);
    expect(catchDepthLookupMi({ notes: 'nothing here' })).toBe(null);
  });
});

describe('a depth is only stated when it was measured at the spot', () => {
  it('prints the borrow-pit fish without claiming 11 ft', () => {
    const d = describeCatchDepth({
      depth: '11',
      notes: 'laid correctly on a yellow bump board | Depth lookup: ~11ft contour (near, 0.17 mi)'
    });
    expect(d.trusted).toBe(false);
    expect(d.ft).toBe(null);
    expect(d.text.includes('0.17 mi away')).toBe(true);
    // The number is not hidden -- it is attributed. Ryan still gets to see what the chart said.
    expect(d.text.includes('11 ft')).toBe(true);
  });

  it('prints the 31.5" catfish the same way at 0.27 mi', () => {
    const d = describeCatchDepth({ depth: '1', notes: 'Depth lookup: ~1ft contour (near, 0.27 mi)' });
    expect(d.trusted).toBe(false);
    expect(d.text.includes('0.27 mi away')).toBe(true);
  });

  it('keeps the honest ones, which are 52 of the 57', () => {
    const d = describeCatchDepth({ depth: '22', notes: 'Depth lookup: ~22ft contour (on, 0.01 mi)' });
    expect(d.trusted).toBe(true);
    expect(d.ft).toBe('22 ft');
    expect(d.text).toBe('22 ft (charted)');
  });

  it('leaves a hand-entered depth entirely alone', () => {
    const d = describeCatchDepth({ depth: '8', notes: 'jig, 8 ft on the sounder' });
    expect(d.charted).toBe(false);
    expect(d.trusted).toBe(true);
    expect(d.text).toBe('8 ft');
  });

  it('does not trust a charted depth whose distance has been lost', () => {
    // The flag survives where the note does not. An unknown reach is still not a measurement.
    const d = describeCatchDepth({ depth: '9', reviewFlags: ['depth_from_contours'] });
    expect(isDepthCharted(d === null ? {} : { depth: '9', reviewFlags: ['depth_from_contours'] })).toBe(true);
    expect(d.trusted).toBe(false);
    expect(d.text).toBe('9 ft (charted)');
  });

  it('says nothing at all when there is no depth', () => {
    expect(describeCatchDepth({}).text).toBe('—');
    expect(describeCatchDepth({ depth: '' }).ft).toBe(null);
  });

  it('draws the line at the word the writer was already using', () => {
    // 0.10 mi is not a number invented for this fix -- it is where nearestLakeAndContour() has
    // always stopped saying "on".
    expect(ON_CONTOUR_MI).toBe(0.10);
    expect(describeCatchDepth({ depth: '5', notes: 'Depth lookup: ~5ft contour (on, 0.10 mi)' }).trusted).toBe(true);
    expect(describeCatchDepth({ depth: '5', notes: 'Depth lookup: ~5ft contour (near, 0.11 mi)' }).trusted).toBe(false);
  });
});

describe('every screen that shows a catch depth asks the same question', () => {
  const files = ['js/modules/catch-journal.js', 'js/modules/catch-photo.js', 'js/modules/catch-plot.js'];

  it('imports the one rule instead of restating it', () => {
    for (const f of files) {
      expect(src(f).includes("from '../utils/catch-depth.js'")).toBe(true);
      expect(src(f).includes('describeCatchDepth(c)')).toBe(true);
    }
  });

  it('no longer prints a bare c.depth anywhere', () => {
    for (const f of files) {
      const s = src(f);
      expect(/Depth:[^`$]*\$\{esc\(c\.depth/.test(s)).toBe(false);
      expect(s.includes("esc(c.depth ? c.depth + 'ft'")).toBe(false);
    }
  });

  it('kept the map popup a popup -- lead is still printed next to it', () => {
    // The fix is to the depth, not to the card. Regression guard against a cull.
    expect(src('js/modules/catch-plot.js').includes('<b>Lead:</b>')).toBe(true);
  });
});

describe('the writer stopped calling a quarter mile "near"', () => {
  const journal = src('js/modules/catch-journal.js');

  it('has no arm of the qualifier that duplicates another', () => {
    // Asserted against the executable line only: the comment above it quotes the old broken
    // ternary on purpose, so a substring search of the whole file would match forever.
    const line = journal.split(/\r?\n/).find(l => l.includes('const relation ='));
    expect(typeof line).toBe('string');
    expect(line.includes("'near' : 'near'")).toBe(false);
    expect(line.includes("'near' : 'off'")).toBe(true);
    expect(line.includes('ON_CONTOUR_MI')).toBe(true);
  });

  it('gates the depth claim on the contour distance', () => {
    // The old line was unconditional: `if (!item.depth && spatial.depth) item.depth = ...`
    expect(/if \(!item\.depth && spatial\.depth\) item\.depth/.test(journal)).toBe(false);
    expect(journal.includes('spatial.contourDistanceMi <= ON_CONTOUR_MI')).toBe(true);
  });

  it('still records the band and the flag, because that is the information', () => {
    expect(journal.includes('item.structure = { depthBand: spatial.depthBand')).toBe(true);
    expect(journal.includes("reviewFlags.push('depth_from_contours')")).toBe(true);
  });
});

// ── AND THEN HE SAID THE PART THAT MOVED IT FROM "UNCHARTED" TO "THE WRONG CHART" ──────────────
//
// Told the Santee tailrace probably just was not charted, Ryan said: "santee river is charted...".
// Measured against the packs on disk, nearest contour VERTEX to each of the five far lookups:
//
//                            journal said   lake_marion   the fish's own water
//     shad, Santee River       0.24 mi        0.234 mi      0.001 mi  (santee_river)
//     bowfin, borrow pit       0.20 mi        0.002 mi      0.256 mi  (santee_river)
//     catfish, borrow pit      0.17 mi        0.001 mi      0.738 mi  (santee_river)
//     striper                  0.12 mi        0.049 mi      5.208 mi
//     catfish 31.5"            0.27 mi        0.275 mi     17.016 mi
//
// The shad settles it: its own chart has a contour 1.6 m away and the app read one a quarter mile
// off, because nearestLakeAndContour() asks `state.ACTIVE_CONTOUR` -- whatever pack is loaded in the
// app -- and Lake Marion was on screen. Every far lookup in the journal is Marion's chart.
//
// So the depth was never only imprecise; some of it is a different body of water. Refused now, and
// the chart is named in the note either way so the question can be asked of the rest.
describe('a depth off the wrong water is not a depth', () => {
  const journal = src('js/modules/catch-journal.js');

  it('names the chart in the note the CSV carries', () => {
    expect(journal.includes('${out.chart ? `, ${out.chart} chart` : \'\'}')).toBe(true);
    expect(journal.includes('chart: spatial.chart || null')).toBe(true);
  });

  it('refuses the lookup when the loaded chart is another water', () => {
    expect(journal.includes('state.ACTIVE_CONTOUR_KEY')).toBe(true);
    expect(journal.includes('chartSlug !== waterSlug')).toBe(true);
    expect(journal.includes('out.chartMismatch')).toBe(true);
    // Refused, not approximated: the early return happens BEFORE the contour scan.
    const iGuard = journal.indexOf('chartSlug !== waterSlug');
    const iScan = journal.indexOf('const contourData = state.ACTIVE_CONTOUR;');
    expect(iGuard > 0 && iScan > iGuard).toBe(true);
  });

  it('flags the refusal as its own thing, not as an uncharted water', () => {
    expect(journal.includes("reviewFlags.push('depth_chart_not_this_water')")).toBe(true);
    expect(journal.includes("reviewFlags.push('depth_not_found')")).toBe(true);
  });

  it('resolves the water with the tolerant registry lookup, not an exact name match', () => {
    // out.lake comes from the access index and is not always a registry displayName.
    expect(journal.includes('lakeRecordFor(out.lake)')).toBe(true);
  });

  it('reads the chart back off the note and says which one it was', () => {
    const d = describeCatchDepth({
      depth: '11', notes: 'Depth lookup: ~11ft contour (near, 0.17 mi, lake_marion chart)'
    });
    expect(d.chart).toBe('lake_marion');
    expect(d.trusted).toBe(false);
    expect(d.text.includes('lake_marion')).toBe(true);
  });

  it('attributes a good depth to its chart too', () => {
    const d = describeCatchDepth({
      depth: '1', notes: 'Depth lookup: ~1ft contour (on, 0.00 mi, santee_river chart)'
    });
    expect(d.trusted).toBe(true);
    expect(d.text).toBe('1 ft (santee_river chart)');
  });

  it('still parses every note written before the chart was recorded', () => {
    const d = describeCatchDepth({ depth: '22', notes: 'Depth lookup: ~22ft contour (on, 0.01 mi)' });
    expect(d.lookupMi).toBe(0.01);
    expect(d.chart).toBe(null);
    expect(d.text).toBe('22 ft (charted)');
  });
});
