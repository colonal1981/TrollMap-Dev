// A FIX BUILT ON A PREMISE NOBODY MEASURED.
//
// On 2026-08-21 this line in assembleAndSaveProfile was rewritten:
//
//   const allFacts = agentResults.flatMap(r => r.data?._extractedFacts || []);
//
// The reading was that a targeted rerun of two agents discards the facts of the other five,
// because "every agent extracts its own facts from its own documents". That reading was wrong,
// the rewrite was reverted, and this file exists so it is not written a third time.
//
// Ryan settled it by having watched the run: *"I watched the entire run last night only 2 agents
// ran."* Lake Norman's saved v12.0 profile kept 54 facts across the same SEVENTEEN categories as
// v11 -- including stocking, speciesAbundance and primaryForage, which no identity or limnology
// agent produces -- with only re-extraction drift (summary 16 -> 14, oxygen 3 -> 2, secchi 3 -> 2).
// Nothing was lost, because there was nothing agent-shaped to lose.
//
// The two facts that make that true are asserted below, on the BEHAVIOUR rather than on a name:
// the document corpus an agent analyses is the LAKE's, and the extractor is not told which agent
// asked. Either one changing would make the fact ledger genuinely agent-partitioned, and would
// make the reverted fix correct after all -- so both are tripwires worth having.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACT = readFileSync(path.join(ROOT, 'Worker/research/extract.js'), 'utf8')
  .replace(/\r\n/g, '\n');

// FOUR TESTS OF THE RESEARCH TAB'S ENGINE STOOD HERE -- that it read the lake-wide document
// cache, that it never told the extractor which agent asked, that no agent result wrote evidence,
// and that the reasoning sat above `allFacts`. The tab was deleted on 2026-09-25 and the batch
// (Scripts/research_lakes.py) is the one writer; the Worker half of the question is below.

test('the extractor prompt covers every section, not one agent worth of categories', () => {
  const line = EXTRACT.split('\n').find((l) => l.trim().startsWith('Categories:'));
  assert.ok(line, 'extract.js must carry the category list in its prompt');
  // One from each section that a rerun of identity + limnology could never own.
  for (const category of ['stocking', 'speciesAbundance', 'primaryForage', 'ramp', 'hazard',
                          'habitatCover', 'structuralElement', 'closedSeason']) {
    assert.ok(line.includes(category),
      `${category} must stay in the one shared category list -- if the list is ever split per `
      + 'agent, the fact ledger becomes agent-partitioned and this whole question reopens');
  }
});
