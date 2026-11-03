// What one shop may take of what every shop shares (one process, one pool of 10 MongoDB
// connections), docs/multitenant-plan.md section 6:
//   - How long one query may run, so a slow one cannot hold the shared pool for long: 5 s by
//     default (models/index.js sets it on every query and aggregate), 15 s for the reports,
//     which set it themselves with .maxTimeMS(REPORT_MS) or .option({ maxTimeMS: REPORT_MS }).
//   - At most 4 API requests of one shop at a time (shopRequests, app.js). One page asks for
//     several things at once (the summary page six), so a request past the four waits up to
//     2 s for a turn before it is refused 503 with Retry-After.
//   - At most one report of a shop at a time, and 3 in the whole process (runReport): the
//     sales figures, the products report and the CSV exports, the admin's included. A report
//     waits for its turn as long as a report may run.
// The product quota of the plan (20,000, read-only past it) is not built yet.
import { httpError } from './errors.js';

export const QUERY_MS = 5000;
export const REPORT_MS = 15000;

export const SHOP_REQUESTS = 4;
export const SHOP_WAIT_MS = 2000;
export const REPORTS_PER_SHOP = 1;
export const REPORTS_IN_ALL = 3;

/*
 * Turns, per key: at most perKey at a time for one key and total for all keys together. A
 * request with no turn free waits, first come first served among those its turn can go to,
 * up to waitMs; past that, or with maxWaiting already waiting for that key, it gets none.
 * acquire(key) -> true once it holds a turn, false when it gets none; release(key) gives
 * the turn back (once per acquire that returned true). state() is for the tests.
 */
export function createTurns({ perKey, total = Infinity, waitMs, maxWaiting = 32 }) {
  const running = new Map(); // key -> turns held
  let held = 0;
  const queue = []; // { key, resolve, timer }
  const waitingFor = (key) => queue.reduce((n, w) => n + (w.key === key), 0);
  const free = (key) => (running.get(key) ?? 0) < perKey && held < total;
  const take = (key) => {
    running.set(key, (running.get(key) ?? 0) + 1);
    held++;
  };

  function acquire(key) {
    if (free(key)) {
      take(key);
      return Promise.resolve(true);
    }
    if (waitingFor(key) >= maxWaiting) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter = { key, resolve };
      waiter.timer = setTimeout(() => {
        queue.splice(queue.indexOf(waiter), 1);
        resolve(false);
      }, waitMs);
      queue.push(waiter);
    });
  }

  function release(key) {
    const left = (running.get(key) ?? 1) - 1;
    if (left > 0) running.set(key, left);
    else running.delete(key);
    held = Math.max(0, held - 1);
    // The turn goes to the first one waiting that may have it: the same key, or any key
    // when it was the total that was full
    for (let i = 0; i < queue.length && held < total; ) {
      const waiter = queue[i];
      if (!free(waiter.key)) {
        i++;
        continue;
      }
      queue.splice(i, 1);
      clearTimeout(waiter.timer);
      take(waiter.key);
      waiter.resolve(true);
    }
  }

  return { acquire, release, state: () => ({ held, waiting: queue.length }) };
}

// The API of one shop, per shop, for the requests of its own signed-in devices (mounted
// after the session check, so nobody outside the shop can take its turns). The turn is
// given back when the answer is sent or the connection closes.
export function shopRequests({ perShop = SHOP_REQUESTS, waitMs = SHOP_WAIT_MS } = {}) {
  const turns = createTurns({ perKey: perShop, waitMs, maxWaiting: 64 });
  return async function limitShop(req, res, next) {
    const key = String(req.tenant._id);
    if (!(await turns.acquire(key))) {
      res.set('Retry-After', '2');
      return next(httpError(503, 'المتجر مشغول بطلبات أخرى الآن. أعد المحاولة بعد لحظات', 'SHOP_BUSY'));
    }
    let given = false;
    res.once('close', () => {
      if (given) return;
      given = true;
      turns.release(key);
    });
    next();
  };
}

// The reports of every shop, for the whole process
const reports = createTurns({ perKey: REPORTS_PER_SHOP, total: REPORTS_IN_ALL, waitMs: REPORT_MS, maxWaiting: 8 });

// Runs one report of a shop (shopId) when its turn comes, and gives the turn back once it is
// done, whatever happened. 503 when no turn came within REPORT_MS.
export async function runReport(shopId, work) {
  const key = String(shopId);
  if (!(await reports.acquire(key))) {
    throw Object.assign(httpError(503, 'تقارير أخرى قيد الإعداد الآن. أعد المحاولة بعد لحظات', 'REPORTS_BUSY'), { retryAfter: 5 });
  }
  try {
    return await work();
  } finally {
    reports.release(key);
  }
}

// For the tests: how many reports run and wait right now
export const reportTurns = () => reports.state();
