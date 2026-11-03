// Guessing passwords, counted in the database (control/models/LoginAttempt.js) so a restart
// forgets nothing. Three counts per failed sign-in, each with its own rule:
//   (scope, username, IP)  5 failures in 15 minutes lock that triple for 15 minutes; each
//                          lock after that is twice as long, up to 4 hours. A success
//                          clears it. Another address is not locked, so nobody can lock
//                          the owner out of their own shop on purpose.
//   (scope, username)      from every address: past 10 failures in 15 minutes each attempt
//                          waits, 0.5 s doubling up to 5 s, but is never locked.
//   scope                  past 50 failures in an hour, every sign-in to it waits 2 s more.
// The scope is the shop's id (or 'admin', for the admin panel later). A locked attempt is
// refused before the password is even hashed. One (scope, username, IP) is checked one
// attempt at a time (hold): a burst sent at once would otherwise all pass check() before the
// first failure is counted, and get more tries than the lock allows.
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const MINUTE = 60 * 1000;

export const LOGIN_RULES = Object.freeze({
  lockAfter: 5,
  lockWindowMs: 15 * MINUTE,
  lockMs: 15 * MINUTE,
  maxLockMs: 4 * 60 * MINUTE,
  slowAfter: 10,
  slowWindowMs: 15 * MINUTE,
  slowFirstMs: 500,
  slowMaxMs: 5000,
  scopeAfter: 50,
  scopeWindowMs: 60 * MINUTE,
  scopeDelayMs: 2000,
  // A record is forgotten this long after its last failure, strikes included
  forgetMs: 24 * 60 * MINUTE,
});

const idOf = (kind, parts) => `${kind}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;

export function createLoginGuard(LoginAttempt, { rules = LOGIN_RULES, now = () => Date.now(), wait = sleep } = {}) {
  const ids = ({ scope, username, ip }) => ({
    ip: idOf('ip', [scope, username, ip]),
    user: idOf('user', [scope, username]),
    scope: idOf('scope', [scope]),
  });
  const inWindow = (doc, windowMs, at) => doc?.windowStart && doc.windowStart.getTime() > at - windowMs;

  // The triples being checked right now, in this process (the only one that serves sign-ins)
  const holding = new Set();
  /*
   * Before check(): a function that lets the triple go (called once the attempt is over, in
   * a finally), or null while another attempt of the same triple is being checked.
   */
  function hold(key) {
    const id = ids(key).ip;
    if (holding.has(id)) return null;
    holding.add(id);
    return () => holding.delete(id);
  }

  /*
   * Before checking a password: { lockedMs } when this (scope, username, IP) is locked, else
   * { delayMs }, how long to wait first because of the other two counts.
   */
  async function check(key) {
    const at = now();
    const id = ids(key);
    const docs = await LoginAttempt.find({ _id: { $in: Object.values(id) } }).lean();
    const byId = new Map(docs.map((d) => [d._id, d]));
    const ipDoc = byId.get(id.ip);
    if (ipDoc?.lockedUntil && ipDoc.lockedUntil.getTime() > at) return { lockedMs: ipDoc.lockedUntil.getTime() - at };
    let delayMs = 0;
    const userDoc = byId.get(id.user);
    if (inWindow(userDoc, rules.slowWindowMs, at) && userDoc.count >= rules.slowAfter) {
      delayMs += Math.min(rules.slowFirstMs * 2 ** (userDoc.count - rules.slowAfter), rules.slowMaxMs);
    }
    const scopeDoc = byId.get(id.scope);
    if (inWindow(scopeDoc, rules.scopeWindowMs, at) && scopeDoc.count > rules.scopeAfter) delayMs += rules.scopeDelayMs;
    return { delayMs };
  }

  // One more failure in a window that starts at the first failure and ends windowMs later.
  // `fields` are written as literals: a typed username such as "$count" is a name, not a
  // field of the pipeline.
  async function count(_id, fields, windowMs, at) {
    const open = { $gt: ['$windowStart', new Date(at - windowMs)] };
    const literals = Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, { $literal: value }]));
    return LoginAttempt.findOneAndUpdate(
      { _id },
      [
        {
          $set: {
            ...literals,
            count: { $cond: [open, { $add: ['$count', 1] }, 1] },
            windowStart: { $cond: [open, '$windowStart', new Date(at)] },
            expiresAt: new Date(at + rules.forgetMs),
          },
        },
      ],
      { upsert: true, returnDocument: 'after', updatePipeline: true },
    ).lean();
  }

  // After a wrong password. Returns { lockedMs } when this failure locked the triple. The
  // name is written beside the counts only when it is an account's (known): anything else
  // typed in the username box, often the password itself, stays only in the hashed _id.
  async function failed(key, { known = false } = {}) {
    const at = now();
    const id = ids(key);
    const { scope, ip } = key;
    const username = known ? { username: key.username } : {};
    const [ipDoc] = await Promise.all([
      count(id.ip, { kind: 'ip', scope, ...username, ip }, rules.lockWindowMs, at),
      count(id.user, { kind: 'user', scope, ...username }, rules.slowWindowMs, at),
      count(id.scope, { kind: 'scope', scope }, rules.scopeWindowMs, at),
    ]);
    if (ipDoc.count < rules.lockAfter) return {};
    const lockedMs = Math.min(rules.lockMs * 2 ** (ipDoc.strikes ?? 0), rules.maxLockMs);
    // The count starts again after the lock
    await LoginAttempt.updateOne(
      { _id: id.ip },
      { $set: { lockedUntil: new Date(at + lockedMs), count: 0, expiresAt: new Date(at + lockedMs + rules.forgetMs) }, $unset: { windowStart: 1 }, $inc: { strikes: 1 } },
    );
    return { lockedMs };
  }

  // After the right password: this address starts again from nothing. The username's count
  // from every address is left to run out, so a success from one place does not let a
  // guesser elsewhere go faster.
  async function succeeded(key) {
    await LoginAttempt.deleteOne({ _id: ids(key).ip });
  }

  return { hold, check, failed, succeeded, wait };
}

// "15 دقيقة", "3 دقائق", "دقيقتين": the wait before trying again, in whole minutes
export function minutesText(ms) {
  const n = Math.max(1, Math.ceil(ms / MINUTE));
  if (n === 1) return 'دقيقة واحدة';
  if (n === 2) return 'دقيقتين';
  return n % 100 >= 3 && n % 100 <= 10 ? `${n} دقائق` : `${n} دقيقة`;
}
