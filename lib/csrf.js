// Cross-site request forgery, for the shops and the admin panel alike: every request that
// changes something must come from a page of the same address (Origin exactly
// PUBLIC_SCHEME://<host>, and Sec-Fetch-Site same-origin when the browser sends it) and,
// once signed in, carry the session's own token in X-CSRF-Token. GET and HEAD never change
// anything, so they need neither. No CORS header is ever sent, so another site's page can
// neither read an answer nor send the JSON these routes expect without being refused here.
import { timingSafeEqual } from 'node:crypto';
import { httpError } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const isSafeMethod = (req) => SAFE_METHODS.has(req.method);

const refused = () => httpError(403, 'تعذّر التحقق من الطلب. حدّث الصفحة وأعد المحاولة', 'CSRF_FAILED');

// The page that sent the request is on this very address. The Host header is the one the
// shop was found by (lib/tenancy.js), so a request for another address never matches.
export function sameOrigin(req, config) {
  const host = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : '';
  if (!host || req.headers.origin !== `${config.publicScheme}://${host}`) return false;
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin';
}

// For every state-changing request, signed in or not (signing in itself included)
export function requireSameOrigin(config) {
  return function checkOrigin(req, res, next) {
    if (isSafeMethod(req) || sameOrigin(req, config)) return next();
    next(refused());
  };
}

const sameToken = (sent, expected) => {
  if (typeof sent !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// After the session is known (req.authSession): the origin as above and the session's token
export function requireCsrf(config) {
  return function checkCsrf(req, res, next) {
    if (isSafeMethod(req)) return next();
    if (!sameOrigin(req, config) || !sameToken(req.headers['x-csrf-token'], req.authSession?.csrf)) return next(refused());
    next();
  };
}
