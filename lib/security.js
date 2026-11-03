// The security headers, set here and nowhere else (nginx adds only HSTS). Every answer of
// the app gets the same base: no sniffing of types, the referrer kept to this address, the
// camera for this address only, no framing, and windows and files kept to this origin.
// A shop's pages also get a Content-Security-Policy, in report-only mode first: browsers
// report what it would block to /api/csp-report (routes/csp-report.js) instead of blocking
// it, until a week without reports from the shop's own devices (camera scanner included)
// shows it can be enforced. The admin panel enforces a stricter one from day one.

const BASE_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

// What a shop's pages load: their own scripts and styles, the camera decoder's WebAssembly
// (compiled from /vendor, hence wasm-unsafe-eval), and the Readex Pro font from Google Fonts.
// Icons in the CSS are data: images.
export const SHOP_CSP = Object.freeze({
  'default-src': ["'self'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'style-src': ["'self'", 'https://fonts.googleapis.com'],
  'font-src': ['https://fonts.gstatic.com'],
  'img-src': ["'self'", 'data:', 'blob:'],
  'media-src': ["'self'", 'blob:'],
  'connect-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
});

// The admin panel's, enforced: its own scripts only, no inline anything, and Trusted Types
// required with no policy allowed, so no string can ever become HTML or script (the panel
// builds every element with textContent; admin-public/js/dom.js)
export const ADMIN_CSP = Object.freeze({
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", 'https://fonts.googleapis.com'],
  'font-src': ['https://fonts.gstatic.com'],
  'img-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'manifest-src': ["'none'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'require-trusted-types-for': ["'script'"],
  'trusted-types': ["'none'"],
});

export const cspValue = (directives, reportUri) =>
  [...Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`), ...(reportUri ? [`report-uri ${reportUri}`] : [])].join('; ');

// The base headers on every answer, and no X-Powered-By (app.js turns that off)
export function securityHeaders() {
  return function setSecurityHeaders(req, res, next) {
    res.set(BASE_HEADERS);
    next();
  };
}

// A Content-Security-Policy, enforced or report-only
export function contentSecurityPolicy({ directives, reportOnly = false, reportUri = null }) {
  const name = reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
  const value = cspValue(directives, reportUri);
  return function setCsp(req, res, next) {
    res.set(name, value);
    next();
  };
}

// API answers are about one signed-in shop at one moment: never kept by a browser or a proxy
export function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}
