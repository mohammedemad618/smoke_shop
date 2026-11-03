// One JSON line per request in the server's journal: {tenant, reqId, route, status, ms},
// never a body, a query string or a cookie. pos-monitor counts the 5xx among them. On in
// production (config.requestLog), off in development and the tests.
import { performance } from 'node:perf_hooks';

export function requestLog() {
  return function logRequest(req, res, next) {
    const started = performance.now();
    res.on('finish', () => {
      const line = {
        tenant: req.tenant?.slug ?? null,
        reqId: typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'].slice(0, 64) : null,
        route: `${req.method} ${(req.originalUrl ?? req.url).split('?')[0].slice(0, 200)}`,
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
      };
      process.stdout.write(`${JSON.stringify(line)}\n`);
    });
    next();
  };
}
