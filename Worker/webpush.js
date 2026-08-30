/**
 * Worker/webpush.js — putting the words INSIDE the push.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * Ryan, 2026-08-30, about an alert that reached his phone for a plan he had run that day:
 *
 *   > the alert that i got said that there is a weather alert and to open trollmap for more
 *   > information... but opening trollmap did not show any popup or anything else... that
 *   > notification needs to carry all of the pertinent info, i should not have to open the app
 *   > to get it
 *
 * He read the exact fallback string in sw.js: "A weather alert fired. Open TrollMap for the
 * details." It fires when the service worker wakes, asks the Worker what happened, and is told
 * nothing.
 *
 * THE PUSH WAS DELIBERATELY EMPTY. alerts.js sent a "tickle" -- a POST with VAPID headers and no
 * body -- and the service worker fetched `/alerts/pending` on wake. The note in sw.js says why:
 * a payload means implementing aes128gcm by hand, and fetching on wake means the text is current
 * rather than five minutes old. Both true. But the queue it fetches lives in Workers KV, and
 * KV IS EVENTUALLY CONSISTENT:
 *
 *   "Changes may take up to 60 seconds or more to be visible in other global network locations
 *    as their cached versions of the data time out."
 *
 * and, worse for this exact case:
 *
 *   "Visibility delays are longer in locations that have recently accessed an older version of
 *    the key, including negative lookups."
 *
 * -- developers.cloudflare.com/kv/concepts/how-kv-works/
 *
 * The service worker reads that key on EVERY push, so the edge nearest his phone has an old
 * version of it cached every single time. `runAlertSweep` writes the queue before pushing and
 * says so in a comment, but ordering a write before a push does not buy read-after-write
 * consistency across colos, and KV never offered it. The push arrives in a second or two; the
 * write becomes visible up to a minute later. The wake finds an empty queue and says so.
 *
 * So the words travel with the push. That is RFC 8291 over RFC 8188, and it deletes the whole
 * failure mode rather than narrowing it: no fetch on wake, no queue, no race, and no network
 * needed at the moment the notification is drawn.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS ACTUALLY BEING DONE HERE
 *
 * The browser's subscription hands over two things this needs: `p256dh`, the device's public
 * P-256 point, and `auth`, sixteen bytes of shared secret. A one-off ECDH keypair is made per
 * message, the two publics are exchanged, and the agreed secret is run through HKDF twice to
 * give a content-encryption key and a nonce. The plaintext gets one padding byte and is sealed
 * with AES-128-GCM. The record header carries the salt and the ephemeral public key so the
 * phone can do the same derivation in reverse.
 *
 * NOTHING HERE IS INVENTED AND NOTHING IS TESTED BY MY OWN OUTPUT. Cryptography that only agrees
 * with itself is the easiest kind to get confidently wrong, so the test in
 * test/the-push-carries-the-words.test.js runs RFC 8291 section 5's worked example -- its keys,
 * its salt, its plaintext -- and checks this file reproduces the ciphertext the RFC prints. The
 * ephemeral key and salt are arguments for exactly that reason; in production they are absent
 * and generated fresh per message, which is what makes the nonce reuse impossible.
 */

const b64urlToBytes = (s) => {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const cat = (...parts) => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

const utf8 = (s) => new TextEncoder().encode(s);

/** HKDF-SHA256, the two-step form RFC 8291 uses: extract with a salt, expand with an info. */
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/** A raw uncompressed P-256 point (0x04 ‖ x ‖ y) as a WebCrypto public key. */
const importPoint = (raw) => crypto.subtle.importKey(
  'raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);

/**
 * Seal one message for one subscription.
 *
 * @param {string} plaintext        what the phone should show. Keep it under ~3,900 bytes: push
 *                                  services are only required to carry a 4,096-byte record, and
 *                                  the header and the GCM tag come out of that budget.
 * @param {string} p256dh           subscription.keys.p256dh, base64url
 * @param {string} auth             subscription.keys.auth, base64url
 * @param {object} [fixed]          TEST ONLY -- RFC 8291's own ephemeral key and salt, so the
 *                                  output can be checked against the RFC's printed ciphertext.
 * @returns {Promise<Uint8Array>}   the aes128gcm record, ready to POST as the body
 */
export async function encryptPush(plaintext, p256dh, auth, fixed) {
  const uaPublic = b64urlToBytes(p256dh);
  const authSecret = b64urlToBytes(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) {
    throw new Error('p256dh is not a 65-byte uncompressed P-256 point');
  }
  if (authSecret.length !== 16) throw new Error('auth secret is not 16 bytes');

  // ONE KEYPAIR PER MESSAGE. Reusing it across messages would reuse the nonce derived from it,
  // and AES-GCM under a repeated key and nonce leaks the plaintext. `fixed` exists only so the
  // RFC's vector can be reproduced in a test.
  let asPublicRaw, ecdhBits;
  if (fixed && fixed.asPrivateJwk) {
    const priv = await crypto.subtle.importKey(
      'jwk', fixed.asPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    asPublicRaw = b64urlToBytes(fixed.asPublic);
    ecdhBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: await importPoint(uaPublic) }, priv, 256);
  } else {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    ecdhBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: await importPoint(uaPublic) }, pair.privateKey, 256);
  }
  const shared = new Uint8Array(ecdhBits);

  // RFC 8291 section 3.4. The info string binds the derivation to BOTH public keys, which is
  // what stops a message encrypted for one device being replayed at another.
  const prk = await hkdf(authSecret, shared,
    cat(utf8('WebPush: info\0'), uaPublic, asPublicRaw), 32);

  const salt = fixed && fixed.salt ? b64urlToBytes(fixed.salt)
                                   : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, prk, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, utf8('Content-Encoding: nonce\0'), 12);

  // 0x02 is the LAST-RECORD delimiter of RFC 8188. One record is sent, so it is always this and
  // never 0x01; sending 0x01 makes the phone wait for a continuation that never comes.
  const padded = cat(utf8(plaintext), new Uint8Array([2]));
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, padded));

  // RFC 8188 section 2: salt(16) ‖ record size(4, big-endian) ‖ key id length(1) ‖ key id.
  // The key id here IS the ephemeral public key, which is how RFC 8291 ships it.
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, new Uint8Array([asPublicRaw.length]), asPublicRaw, sealed);
}

/** The headers a payload push needs on top of VAPID. */
export const payloadHeaders = (len) => ({
  'Content-Encoding': 'aes128gcm',
  'Content-Type': 'application/octet-stream',
  'Content-Length': String(len),
});
