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
const ENGINE = readFileSync(path.join(ROOT, 'js/modules/lake-research-engine.js'), 'utf8');
const EXTRACT = readFileSync(path.join(ROOT, 'Worker/research/extract.js'), 'utf8');

test('an agent analyses the LAKE document cache, not a set of its own', () => {
  // Both branches ask for the whole lake and neither narrows by agent -- resume prefers
  // agent-tagged docs but falls back to all of them, with a comment saying why.
  const asks = ENGINE.match(/research\/get-normalized\?lake=/g) || [];
  assert.ok(asks.length >= 2,
    'runAgent must load the lake-wide normalized cache in both full and resume mode');
  assert.ok(ENGINE.includes('existingDocs = tagged.length > 0 ? tagged : allDocs'),
    'the resume branch must fall back to the full cache when no doc carries this agent tag');
});

test('the fact extractor is never told which agent asked', () => {
  const call = ENGINE.slice(ENGINE.indexOf("`${CF_WORKER_URL}/research/analyze-facts`"));
  const body = call.slice(call.indexOf('body:'), call.indexOf('})', call.indexOf('body:')));
  for (const forbidden of ['agent:', 'agentKey', 'agent_key']) {
    assert.ok(!body.includes(forbidden),
      `the analyze-facts request must not carry ${forbidden} -- facts belong to the lake's `
      + 'corpus, and scoping them by agent is what makes the ledger look partitioned');
  }
  assert.ok(body.includes('documents:') && body.includes('lakeName'),
    'the request is documents plus lake identity, nothing else');
});

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

test('no agent result contributes an evidence entry', () => {
  // The other half of the same wrong diagnosis: `evidence` is rebuilt from the deterministic pass
  // and WQP on every save, and that is complete because nothing else ever writes it. Measured on
  // Lake Norman across the two-agent rerun: habitat 11 sub-keys, identity 3, limnology 2,
  // navigation 1, summary 1 -- identical before and after.
  const fn = ENGINE.slice(ENGINE.indexOf('async function assembleAndSaveProfile('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!/r\.data\??\.evidence|agentResults[\s\S]{0,80}evidence/.test(body),
    'if an agent ever starts returning evidence, this merge stops being complete');
  assert.ok(body.includes('mergeEvidenceMaps(det.evidence || {}, buildWqpEvidence(wqp))'),
    'evidence is det + WQP, deliberately, and the reasoning is in the comment above it');
});

test('the reasoning is recorded where the question gets asked', () => {
  const anchor = ENGINE.indexOf('const allFacts = agentResults.flatMap(');
  assert.ok(anchor > 0, 'the line must still be here');
  const preceding = ENGINE.slice(Math.max(0, anchor - 2000), anchor);
  assert.ok(/NOT OF THE AGENTS THAT RAN/.test(preceding),
    'a future session reading this line will see what looks like a bug -- the answer has to '
    + 'arrive with the question, or it gets "fixed" again');
});
