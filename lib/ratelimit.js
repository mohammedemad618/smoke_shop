// A small in-memory limit on how often something may be asked for, per key (an address, a
// shop...): `max` requests per `windowMs`, then 429 with Retry-After until the window ends.
// It lives in this process only, which is the one process that serves everything (nginx
// has its own limits in front). For cheap endpoints that must not be flooded, such as the
// CSP reports; failed sign-ins are counted in the database instead (lib/login-guard.js).
import { httpError } from './errors.js';

// Keys kept at most; past that the expired ones are dropped, then the oldest
const MAX_KEYS = 10000;

export function createRateLimit({ windowMs, max, now = () => Date.now() }) {
  const windows = new Map(); // key -> { count, resetAt }

  function prune(at) {
    for (const [key, w] of windows) if (w.resetAt <= at) windows.delete(key);
    while (windows.size >= MAX_KEYS) windows.delete(windows.keys().next().value);
  }

  // { allowed, retryAfterMs } for one more request under `key`, counting it
  function hit(key) {
    const at = now();
    let w = windows.get(key);
    if (!w || w.resetAt <= at) {
      if (windows.size >= MAX_KEYS) prune(at);
      w = { count: 0, resetAt: at + windowMs };
      windows.set(key, w);
    }
    w.count += 1;
    return { allowed: w.count <= max, retryAfterMs: w.resetAt - at };
  }

  return { hit, reset: (key) => windows.delete(key) };
}

// The limit as middleware: key(req) names what is counted
export function rateLimit({ windowMs, max, key, message = 'طلبات كثيرة. أعد المحاولة بعد قليل' }) {
  const limit = createRateLimit({ windowMs, max });
  return function limitRate(req, res, next) {
    const { allowed, retryAfterMs } = limit.hit(key(req));
    if (allowed) return next();
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    next(httpError(429, message, 'RATE_LIMITED'));
  };
}
