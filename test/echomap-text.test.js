// THE TARGET DISPLAY IS A CHARTPLOTTER, NOT A PHONE TRAY.
//
// Ryan photographed a live notification on the Echomap on 2026-08-26: a title line and two body
// lines in plain marine type. EVERY notification this app raises relays there through Garmin
// Connect, and a Garmin marine unit renders a limited glyph set — a leading emoji costs the
// first and most-read position on the line to draw an empty box.
//
// Both halves of the alert path are covered, in the two ways each can be:
//   - the PUSH path strips at its boundary, because those strings come from a plan (see
//     Worker/alerts.js forEchomap, tested in push-alerts.test.js);
//   - the LOCAL path cannot strip what it never writes, so this refuses the characters at the
//     source. It is a lint, not a runtime guard, which is the right shape for a literal.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('no notification this app raises carries a glyph the Echomap cannot draw', () => {
  const src = readFileSync(join(ROOT, 'js/modules/notifications.js'), 'utf8');
  const bad = [];
  for (const [i, line] of src.split('\n').entries()) {
    // Only the calls that become notifications. Comments explaining this rule are allowed to
    // quote the characters, which is why the test reads calls rather than the whole file.
    if (!/\bfire\s*\(/.test(line)) continue;
    for (const ch of line) {
      if (ch.codePointAt(0) > 255) { bad.push(`${i + 1}: ${line.trim().slice(0, 70)}`); break; }
    }
  }
  assert.deepEqual(bad, [], 'these reach a marine display and must be plain text');
});

test('degrees and the rest of Latin-1 are still allowed', () => {
  // The rule is "what the plotter can draw", not "ASCII". 72°F is the point of the message.
  assert.ok('°'.codePointAt(0) <= 255);
  assert.ok('–'.codePointAt(0) > 255, 'an en dash is NOT Latin-1 and would box');
});

test('the worker URL is imported, never guessed at off `state`', () => {
  // CF_WORKER_URL is a NAMED EXPORT of js/core/state.js. `state.CF_WORKER_URL` is undefined, and
  // reading it fails the way undefined always fails in this app: silently, at a call that then
  // returns early. It cost three rounds of Ryan toggling the notification bell on his phone
  // against a correctly configured Worker while `devices` stayed at 0.
  //
  // Every other module imports the constant. This asserts none of them stops.
  const files = ['js/modules/notifications.js', 'js/modules/plan-water-ui.js',
                 'js/modules/smart-plan-v2-wiring.js', 'js/modules/cloud-sync.js'];
  const bad = [];
  for (const f of files) {
    let src;
    try { src = readFileSync(join(ROOT, f), 'utf8'); } catch (_) { continue; }
    for (const [i, line] of src.split('\n').entries()) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;            // the comment explaining this rule
      if (/\bstate\s*\.\s*CF_WORKER_URL\b/.test(line)) bad.push(`${f}:${i + 1}`);
    }
  }
  assert.deepEqual(bad, [], 'CF_WORKER_URL is a named export, not a property of state');
});
