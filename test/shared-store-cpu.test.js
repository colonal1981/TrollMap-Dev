// Tagging a document's sections, on a 10 ms CPU budget.
//
// From wrangler tail against the live Worker, 2026-08-16:
//
//     POST /research/shared/store - Exceeded CPU Limit
//     ✘ [ERROR] Error: Worker exceeded CPU time limit.
//
// This Worker is on the Cloudflare Free plan: 10 ms per request, not configurable. The tagger
// rebuilt its name list on every call and constructed a `new RegExp` INSIDE the per-section
// loop, so a document segmenting into three hundred sections compiled 25,200 regexes and ran
// 50,400 tests just to label them.
//
// The matching itself is unchanged and that is what these tests are for -- the regexes are the
// same regexes, built once for the life of the isolate instead of once per section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagSectionsWithLakes, tagSectionsWithCategories, LAKE_CATALOG } from '../Worker/research/shared.js';

const sec = (heading, body) => ({ heading, chunks: [{ text: body }] });

test('a lake named in the heading outranks one named only in the body', () => {
  const anyLake = Object.entries(LAKE_CATALOG)[0];
  const [slug, entry] = anyLake;
  const out = tagSectionsWithLakes([sec(entry.canonical, 'some prose')]);
  const m = out[0].lakeMatches.find((x) => x.lakeSlug === slug);
  assert.ok(m, `expected a match for ${entry.canonical}`);
  assert.equal(m.matchLocation, 'heading');
  assert.equal(m.confidence, 1.0);
});

test('a body-only mention is tagged, at lower confidence', () => {
  const [slug, entry] = Object.entries(LAKE_CATALOG)[0];
  const out = tagSectionsWithLakes([sec('Chapter 3', `Conditions on ${entry.canonical} were stable.`)]);
  const m = out[0].lakeMatches.find((x) => x.lakeSlug === slug);
  assert.ok(m);
  assert.equal(m.matchLocation, 'body');
  assert.equal(m.confidence, 0.85);
});

test('an alias matches and is marked as one', () => {
  const withAlias = Object.entries(LAKE_CATALOG).find(([, e]) => (e.aliases || []).length);
  assert.ok(withAlias, 'catalog must have at least one alias to exercise');
  const [slug, entry] = withAlias;
  const out = tagSectionsWithLakes([sec('Chapter 3', `Notes on ${entry.aliases[0]} follow.`)]);
  const m = out[0].lakeMatches.find((x) => x.lakeSlug === slug);
  assert.ok(m, `expected a match for alias ${entry.aliases[0]}`);
  assert.equal(m.isAlias, true);
  assert.equal(m.confidence, 0.7);
});

test('a section naming no lake gets no matches, not a guess', () => {
  const out = tagSectionsWithLakes([sec('Appendix B', 'Tables of contents and figure captions.')]);
  assert.deepEqual(out[0].lakeMatches, []);
});

test('word boundaries hold — a name inside a longer word is not a match', () => {
  const [, entry] = Object.entries(LAKE_CATALOG)[0];
  const glued = `x${entry.canonical.replace(/\s+/g, '')}x`;
  const out = tagSectionsWithLakes([sec('Appendix', glued)]);
  assert.deepEqual(out[0].lakeMatches, []);
});

test('categories still come off the keyword rules', () => {
  const out = tagSectionsWithCategories([
    sec('Fisheries', 'Gill net surveys measured species abundance and spawning success.'),
    sec('Water quality', 'Dissolved oxygen and thermocline depth were recorded.'),
    sec('Nothing', 'Front matter.'),
  ]);
  assert.ok(out[0].categories.includes('biology'));
  assert.ok(out[1].categories.includes('limnology'));
  assert.deepEqual(out[2].categories, ['general']);
});

test('three hundred sections is work the free plan can actually afford', () => {
  // The shape that was dying: a long PDF segmented into hundreds of sections. This is not a
  // CPU-limit assertion — node is not a Worker — it is a guard against the per-section regex
  // construction coming back, which is what made the cost scale with section count.
  const [, entry] = Object.entries(LAKE_CATALOG)[0];
  const many = Array.from({ length: 300 }, (_, i) =>
    sec(`Section ${i}`, i === 7 ? `Discussion of ${entry.canonical}.` : 'Unrelated prose about culverts.'));
  const t0 = process.hrtime.bigint();
  const out = tagSectionsWithLakes(many);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(out.length, 300);
  assert.equal(out.filter((s) => s.lakeMatches.length).length, 1);
  assert.ok(ms < 250, `300 sections took ${ms.toFixed(1)} ms — the per-section compile is back`);
});
