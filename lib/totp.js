// The admin's second factor: time-based codes from an authenticator app (RFC 6238 over
// RFC 4226, HMAC-SHA1, 6 digits every 30 seconds, as Google Authenticator and the others
// expect), on node:crypto alone. The shared secret is stored encrypted with AES-256-GCM
// under TOTP_KEY, which lives in the environment and never in the database, so a copy of
// pos_control alone makes no codes. A code is accepted one step early or late (a phone's
// clock a little off) and only once: the step it matched is kept (lastCounter) and no
// code of that step or an earlier one works again. Ten recovery codes, each usable once,
// are kept as keyed hashes for a lost phone.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const STEP_SECONDS = 30;
export const DIGITS = 6;
// One step either side of now
export const WINDOW = 1;
export const RECOVERY_CODES = 10;

/* Base32 (RFC 4648, no padding), the form authenticator apps take a secret in */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/* Codes */

// 20 random bytes (160 bits), the size RFC 4226 recommends for HMAC-SHA1
export const newSecret = () => randomBytes(20);

export const counterAt = (ms) => Math.floor(ms / 1000 / STEP_SECONDS);

// The code of one step (RFC 4226 dynamic truncation)
export function hotp(secret, counter, digits = DIGITS) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const number = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(number).padStart(digits, '0');
}

export const totp = (secret, ms = Date.now()) => hotp(secret, counterAt(ms));

// Spaces and dashes are what people type between the groups of a code
export const cleanCode = (value) => (typeof value === 'string' ? value.replace(/[\s-]/g, '') : '');

/*
 * The step a code matches, within one step of `ms` and after `lastCounter`, or null. Every
 * step of the window is compared, in constant time, so the answer takes as long whichever
 * matched. The caller stores the step returned (only if still greater, which settles two
 * requests with the same code at the same moment).
 */
export function verifyTotp(secret, code, { lastCounter = -1, ms = Date.now() } = {}) {
  const typed = cleanCode(code);
  if (!/^\d{6}$/.test(typed)) return null;
  const now = counterAt(ms);
  let found = null;
  for (let counter = now - WINDOW; counter <= now + WINDOW; counter++) {
    const same = timingSafeEqual(Buffer.from(hotp(secret, counter)), Buffer.from(typed));
    if (same && counter > lastCounter && found === null) found = counter;
  }
  return found;
}

// What the authenticator app is given: the QR code holds this, and it can be typed in
export function otpauthUri({ secret, account, issuer = 'POS Admin' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: base32Encode(secret), issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

// "ABCD EFGH IJKL ...", easier to type into the app by hand
export const groupedSecret = (secret) => base32Encode(secret).match(/.{1,4}/g).join(' ');

/* The stored secret: "v1.<iv>.<tag>.<ciphertext>", base64url, bound to the admin's id */

export function encryptSecret(key, secret, adminId) {
  if (!key) throw new Error('TOTP_KEY is not set');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`pos-admin-totp:${adminId}`));
  const data = Buffer.concat([cipher.update(secret), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.');
}

// The secret, or an error if the key is not the one it was stored with or the value was changed
export function decryptSecret(key, stored, adminId) {
  if (!key) throw new Error('TOTP_KEY is not set');
  const [version, iv, tag, data] = String(stored).split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unreadable TOTP secret');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(`pos-admin-totp:${adminId}`));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]);
}

/* Recovery codes: "k7m2p-x9q4r", lower-case letters and digits that cannot be confused */

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function newRecoveryCodes(count = RECOVERY_CODES) {
  const one = () => Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
  return Array.from({ length: count }, () => {
    const code = one();
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

export const cleanRecoveryCode = (value) => (typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '');

// Keyed with TOTP_KEY, so the hashes in a copy of the database cannot be tried offline
export function hashRecoveryCode(key, code) {
  if (!key) throw new Error('TOTP_KEY is not set');
  return createHmac('sha256', key).update(`pos-admin-recovery:${cleanRecoveryCode(code)}`).digest('hex');
}
