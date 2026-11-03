// The admin's second factor (lib/totp.js): RFC 6238's own test values, the one-step window,
// a code accepted once, the secret encrypted under TOTP_KEY, and the recovery codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  base32Decode,
  base32Encode,
  counterAt,
  decryptSecret,
  encryptSecret,
  groupedSecret,
  hashRecoveryCode,
  hotp,
  newRecoveryCodes,
  otpauthUri,
  totp,
  verifyTotp,
} from '../lib/totp.js';

// RFC 6238 appendix B: the SHA-1 secret "12345678901234567890" and its 8-digit codes; a
// 6-digit code is the same number modulo 10^6
const RFC_SECRET = Buffer.from('12345678901234567890');
const RFC_CODES = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

test('the codes are those of RFC 6238', () => {
  for (const [seconds, code] of RFC_CODES) {
    assert.strictEqual(hotp(RFC_SECRET, counterAt(seconds * 1000), 8), code, String(seconds));
    assert.strictEqual(totp(RFC_SECRET, seconds * 1000), code.slice(-6), String(seconds));
  }
});

test('base32 both ways, as authenticator apps read it', () => {
  // RFC 4648 test vectors, without padding
  for (const [text, encoded] of [['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']]) {
    assert.strictEqual(base32Encode(Buffer.from(text)), encoded);
    assert.strictEqual(base32Decode(encoded).toString(), text);
  }
  const secret = randomBytes(20);
  assert.deepStrictEqual(base32Decode(groupedSecret(secret).toLowerCase()), secret);
  assert.match(groupedSecret(secret), /^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
  assert.throws(() => base32Decode('AB1C'), /base32/);
  const uri = new URL(otpauthUri({ secret, account: 'boss' }));
  assert.strictEqual(uri.protocol, 'otpauth:');
  assert.strictEqual(uri.searchParams.get('secret'), base32Encode(secret));
  assert.deepStrictEqual([uri.searchParams.get('digits'), uri.searchParams.get('period'), uri.searchParams.get('algorithm')], ['6', '30', 'SHA1']);
});

test('a code is accepted one step early or late, only after the last one used, and only once', () => {
  const secret = randomBytes(20);
  const now = Date.UTC(2026, 10, 3, 12, 0, 15);
  const step = counterAt(now);
  assert.strictEqual(verifyTotp(secret, totp(secret, now), { ms: now }), step);
  assert.strictEqual(verifyTotp(secret, totp(secret, now - 30000), { ms: now }), step - 1);
  assert.strictEqual(verifyTotp(secret, totp(secret, now + 30000), { ms: now }), step + 1);
  assert.strictEqual(verifyTotp(secret, totp(secret, now - 60000), { ms: now }), null);
  assert.strictEqual(verifyTotp(secret, totp(secret, now + 60000), { ms: now }), null);
  // Spaces typed between the groups are fine; anything not six digits is not
  const code = totp(secret, now);
  assert.strictEqual(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { ms: now }), step);
  for (const bad of ['', '12345', '1234567', 'abcdef', null, 123456]) assert.strictEqual(verifyTotp(secret, bad, { ms: now }), null, String(bad));
  // Replay: the step that was accepted, or an earlier one, never again
  assert.strictEqual(verifyTotp(secret, code, { ms: now, lastCounter: step }), null);
  assert.strictEqual(verifyTotp(secret, totp(secret, now - 30000), { ms: now, lastCounter: step - 1 }), null);
  assert.strictEqual(verifyTotp(secret, totp(secret, now + 30000), { ms: now, lastCounter: step }), step + 1);
});

test('the secret is stored encrypted, bound to its admin, and unreadable with another key', () => {
  const key = randomBytes(32);
  const secret = randomBytes(20);
  const stored = encryptSecret(key, secret, 'admin-1');
  assert.match(stored, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(!stored.includes(base32Encode(secret)) && !stored.includes(secret.toString('hex')));
  assert.notStrictEqual(encryptSecret(key, secret, 'admin-1'), stored, 'a new IV each time');
  assert.deepStrictEqual(decryptSecret(key, stored, 'admin-1'), secret);
  assert.throws(() => decryptSecret(randomBytes(32), stored, 'admin-1'));
  assert.throws(() => decryptSecret(key, stored, 'admin-2'), 'moved to another admin');
  const [v, iv, tag, data] = stored.split('.');
  const flipped = Buffer.from(data, 'base64url');
  flipped[0] ^= 1;
  assert.throws(() => decryptSecret(key, [v, iv, tag, flipped.toString('base64url')].join('.')));
  assert.throws(() => encryptSecret(null, secret, 'x'), /TOTP_KEY/);
});

test('ten readable recovery codes, kept as keyed hashes', () => {
  const codes = newRecoveryCodes();
  assert.strictEqual(codes.length, 10);
  assert.strictEqual(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
  const key = randomBytes(32);
  const hash = hashRecoveryCode(key, codes[0]);
  assert.match(hash, /^[0-9a-f]{64}$/);
  // Typed in capitals or without the dash, it is the same code; another key, another hash
  assert.strictEqual(hashRecoveryCode(key, codes[0].toUpperCase().replace('-', '')), hash);
  assert.notStrictEqual(hashRecoveryCode(randomBytes(32), codes[0]), hash);
});
