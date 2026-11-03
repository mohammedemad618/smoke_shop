// /healthz and /readyz, for the server's own checks: pos-monitor and the uptime check ask
// /healthz, the deploy script waits on /readyz until it reports the release it installed
// (ops/deploy.sh writes the commit to REVISION at the release's root). They answer only a
// request whose Host is localhost or 127.0.0.1, which nginx sends for /healthz alone, so
// no shop address and no outsider reaches them, and they say nothing about any shop.
import { readFile } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { normalizeHost } from './tenancy.js';

const LOCAL = new Set(['localhost', '127.0.0.1']);
const REVISION = new URL('../REVISION', import.meta.url);

export function health({ db }) {
  let sha = null;
  const loaded = readFile(REVISION, 'utf8').then(
    (text) => {
      sha = text.trim().slice(0, 64) || null;
    },
    () => {},
  );
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();

  return async function answerHealth(req, res, next) {
    if ((req.path !== '/healthz' && req.path !== '/readyz') || !LOCAL.has(normalizeHost(req.headers.host))) return next();
    res.set('Cache-Control', 'no-store');
    if (req.path === '/healthz') return res.json({ ok: true });
    await loaded;
    const p99 = Math.round(lag.percentile(99) / 1e6);
    lag.reset();
    try {
      await db.control.db.command({ ping: 1 });
      res.json({ ok: true, sha, eventLoopP99Ms: p99 });
    } catch (err) {
      res.status(503).json({ ok: false, sha, error: err.message });
    }
  };
}
