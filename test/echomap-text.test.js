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
