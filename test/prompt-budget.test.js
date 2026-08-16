// The prompt budget guard, which used to report success and do nothing.
//
// FROM THE LIVE WORKER, wrangler tail, 2026-08-16 21:27, twice with the identical number:
//
//   (warn) handleResearchAgent: habitat prompt too large (402757 chars) — truncating facts
//
// Identical both times because the truncation never reached the wire: userPrompt was a const
// built from groundedPrev, the guard reassigned groundedPrev, and the payload sent the string
// it had already built. 402,757 characters is roughly 100,000 tokens against a free-tier
// Flash-Lite budget of 250,000 per minute, and wave 1 issues five of these at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitPromptToBudget } from '../Worker/research/agents.js';

// A fact roughly the size the extractor produces — a sentence, a quote and a source label.
const fact = (i) => ({
  fact: `Fact number ${i} about the reservoir, its habitat and its management. `.repeat(6),
  quote: `Verbatim quote number ${i}. `.repeat(10),
  source: `Source document ${i}`,
  category: 'habitat',
});
const grounded = (n) => ({ _extractedFacts: Array.from({ length: n }, (_, i) => fact(i)) });

// Stands in for agent.userTemplate: the prompt is the facts plus a fixed body.
const build = (bodyChars) => (g) =>
  'x'.repeat(bodyChars) + JSON.stringify(g._extractedFacts || []);

const SYS = 'You are the habitat agent. '.repeat(20);

test('a prompt already inside budget is left alone', () => {
  const r = fitPromptToBudget(SYS, build(1000), grounded(3), 80000);
  assert.equal(r.truncatedTo, null);
  assert.equal(r.over, false);
  assert.equal(r.size, r.before);
});

test('an oversized prompt actually shrinks — the string, not just the context', () => {
  const r = fitPromptToBudget(SYS, build(1000), grounded(400), 80000);
  assert.ok(r.before > 80000, `fixture must start over budget, was ${r.before}`);
  assert.ok(r.size <= 80000, `expected a prompt under budget, got ${r.size}`);
  assert.equal(r.over, false);
  assert.equal(r.grounded._extractedFacts.length, r.truncatedTo);
  // The returned prompt is the one built AFTER the cut. This is the bug: the old code
  // returned the pre-cut string and logged a truncation that had not happened.
  assert.equal(r.userPrompt.length, build(1000)(r.grounded).length);
  assert.ok(r.userPrompt.length < build(1000)(grounded(400)).length);
});

test('it keeps cutting until it fits rather than stopping at five', () => {
  // A body big enough that five facts still overflow, so five is not the answer. The old
  // guard's single slice(0, 5) was a guess at the right number rather than a measurement.
  const big = { _extractedFacts: Array.from({ length: 40 }, (_, i) => fact(i * 1000)) };
  const r = fitPromptToBudget(SYS, build(78000), big, 80000);
  assert.equal(r.over, false);
  assert.ok(r.truncatedTo < 5, `expected it to go below five facts, kept ${r.truncatedTo}`);
});

test('when the bulk is NOT the facts it says so instead of pretending', () => {
  // The 402,757-char habitat prompt is this case: a profile blob and injected document text
  // that dropping every fact cannot fix. Silence here is what made it look like a mystery.
  const r = fitPromptToBudget(SYS, build(400000), grounded(50), 80000);
  assert.equal(r.over, true);
  assert.equal(r.truncatedTo, 0);
  assert.equal(r.grounded._extractedFacts.length, 0);
  assert.ok(r.size > 80000);
});

test('a context with no facts at all does not throw', () => {
  const r = fitPromptToBudget(SYS, build(200000), {}, 80000);
  assert.equal(r.over, true);
  assert.equal(r.before, r.size);
});
