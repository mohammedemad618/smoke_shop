// A shop owner's first password, made here in the admin's browser: 12 letters and digits
// that cannot be mistaken for one another when read out or typed (no 0/O, 1/l/I), with
// both cases and a digit. It is shown once to be copied and sent to the owner; the server
// receives it once, keeps only its hash and asks for a new one at the first sign-in. Kept
// in this page's memory only, never in storage.

const READABLE = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// The largest multiple of 55 under 256: bytes above it are dropped, so every character is as likely
const LIMIT = 256 - (256 % READABLE.length);

// `avoid`: words the password must not contain (the username, the shop's address)
export function generatePassword({ length = 12, avoid = [] } = {}) {
  const words = avoid.map((w) => String(w ?? '').toLowerCase()).filter((w) => w.length >= 3);
  for (;;) {
    let out = '';
    while (out.length < length) {
      for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
        if (byte < LIMIT && out.length < length) out += READABLE[byte % READABLE.length];
      }
    }
    const lower = out.toLowerCase();
    if (/[a-z]/.test(out) && /[A-Z]/.test(out) && /\d/.test(out) && !words.some((w) => lower.includes(w))) return out;
  }
}

// A random id for one request, sent again with a retry so the server does it once
export function newRequestId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
