// The rules for a shop's address (the <slug> in <slug>.pos.108-61-190-4.sslip.io), in one
// place for the app, the admin panel, the command line and the root worker: an address
// accepted in one cannot be refused in another and leave a shop without a certificate.

export const SLUG_MIN = 3;
export const SLUG_MAX = 30;

// Lower-case letters and digits in parts joined by single hyphens, starting with a letter
const SHAPE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
// sslip.io answers any name holding an IP address with that address, written with hyphens
// (shop-1-2-3-4) or as 8 hex digits (shop-7f000001): such an address would lead elsewhere
const DASHED_IP = /\d{1,3}(-\d{1,3}){3}/;
const HEX_IP = /(^|-)[0-9a-f]{8}(-|$)/;

// Names the system, the server's other sites or common services use. "smoke" is not one.
export const RESERVED_SLUGS = Object.freeze(new Set([
  'admin', 'www', 'api', 'app', 'pos', 'mail', 'smtp', 'ftp', 'ns1', 'ns2', 'static', 'assets', 'cdn',
  'media', 'status', 'health', 'help', 'support', 'billing', 'login', 'auth', 'root', 'system', 'test',
  'dev', 'staging', 'demo', 'localhost', 'autoconfig', 'autodiscover', 'sales', 'erp', 'sites', 'hishin',
  'lapsa', 'urgold', 'niura',
]));

export const SLUG_MESSAGES = Object.freeze({
  invalid: `غير صالح: أحرف إنجليزية صغيرة وأرقام وشرطة، يبدأ بحرف، من ${SLUG_MIN} إلى ${SLUG_MAX}`,
  reserved: 'هذا العنوان محجوز',
  taken: 'هذا العنوان مستخدم',
});

// { ok: true } or { ok: false, reason: 'invalid' | 'reserved' }. Whether it is free is the
// database's to say (services/tenants.js).
export function checkSlug(value) {
  const slug = typeof value === 'string' ? value : '';
  const valid =
    slug.length >= SLUG_MIN &&
    slug.length <= SLUG_MAX &&
    SHAPE.test(slug) &&
    !DASHED_IP.test(slug) &&
    !HEX_IP.test(slug);
  if (!valid) return { ok: false, reason: 'invalid' };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, reason: 'reserved' };
  return { ok: true };
}
