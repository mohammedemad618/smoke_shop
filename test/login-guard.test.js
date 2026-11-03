// Failed sign-ins (lib/login-guard.js), on a clock the test moves: 5 failures in 15 minutes
// lock (shop, name, address) for 15 minutes, then 30, 60, 120 and at most 4 hours; another
// address is never locked; a success starts again from nothing; the name from every address
// only slows down; and a shop with more than 50 failures in an hour adds 2 s to every try.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createLoginGuard, minutesText } from '../lib/login-guard.js';
import { startTestEnv } from './support/harness.js';

const MIN = 60 * 1000;
let env;
before(async () => {
  env = await startTestEnv();
});
after(async () => {
  await env?.close();
});

// A guard on its own clock, for one scope of its own. The clock starts a day ahead of the
// real one: the records expire 24 hours after the guard's "now", and an expiry already past
// in real time would let MongoDB's TTL monitor (every 60 s) delete them in the middle of a test.
function guardAt(start = Date.now() + 24 * 60 * MIN) {
  const clock = { now: start };
  const guard = createLoginGuard(env.db.controlModels.LoginAttempt, { now: () => clock.now });
  return { guard, clock };
}
let scopes = 0;
const keyFor = (ip = '10.1.1.1', username = 'owner') => ({ scope: `test-${++scopes}`, username, ip });
const failTimes = async (guard, key, n) => {
  let last = {};
  for (let i = 0; i < n; i++) last = await guard.failed(key);
  return last;
};

test('5 failures in 15 minutes lock for 15 minutes, then 30, 60, 120 and never more than 4 hours', async () => {
  const { guard, clock } = guardAt();
  const key = keyFor();
  assert.deepStrictEqual(await failTimes(guard, key, 4), {});
  assert.deepStrictEqual(await guard.check(key), { delayMs: 0 });
  assert.deepStrictEqual(await guard.failed(key), { lockedMs: 15 * MIN });

  for (const minutes of [15, 30, 60, 120, 240, 240]) {
    assert.strictEqual((await guard.check(key)).lockedMs, minutes * MIN, `locked ${minutes} min`);
    clock.now += minutes * MIN - 1000;
    assert.strictEqual((await guard.check(key)).lockedMs, 1000, 'one second before the end');
    clock.now += 1000;
    assert.deepStrictEqual(await guard.check(key), { delayMs: 0 }, 'open again at the end');
    const next = await failTimes(guard, key, 5);
    assert.strictEqual(next.lockedMs, Math.min(minutes * 2, 240) * MIN);
  }
});

test('failures spread over more than 15 minutes do not lock; another address never does', async () => {
  const { guard, clock } = guardAt();
  const key = keyFor();
  await failTimes(guard, key, 4);
  clock.now += 15 * MIN + 1;
  assert.deepStrictEqual(await failTimes(guard, key, 4), {}, 'a new window began');
  assert.ok(!(await guard.check(key)).lockedMs);
  assert.deepStrictEqual(await guard.failed(key), { lockedMs: 15 * MIN });
  // The owner from home, or the same name from the phone's network
  assert.deepStrictEqual(await guard.check({ ...key, ip: '10.9.9.9' }), { delayMs: 0 });
  assert.ok(!(await guard.check({ ...key, username: 'cashier' })).lockedMs);
});

test('the right password starts the address again from nothing, strikes included', async () => {
  const { guard, clock } = guardAt();
  const key = keyFor();
  await failTimes(guard, key, 5);
  clock.now += 15 * MIN;
  await failTimes(guard, key, 5);
  assert.strictEqual((await guard.check(key)).lockedMs, 30 * MIN);
  clock.now += 30 * MIN;
  await guard.succeeded(key);
  assert.deepStrictEqual(await failTimes(guard, key, 4), {});
  assert.deepStrictEqual(await guard.failed(key), { lockedMs: 15 * MIN }, 'back to the first length');
});

test('a name guessed from many addresses is slowed down, never locked', async () => {
  const { guard, clock } = guardAt();
  const base = keyFor();
  // One failure each from 10 addresses: none is locked
  for (let i = 0; i < 10; i++) assert.deepStrictEqual(await guard.failed({ ...base, ip: `10.2.0.${i}` }), {});
  const fresh = { ...base, ip: '10.2.1.1' };
  assert.deepStrictEqual(await guard.check(fresh), { delayMs: 500 });
  await guard.failed({ ...base, ip: '10.2.0.50' });
  assert.deepStrictEqual(await guard.check(fresh), { delayMs: 1000 });
  for (let i = 0; i < 10; i++) await guard.failed({ ...base, ip: `10.2.2.${i}` });
  assert.deepStrictEqual(await guard.check(fresh), { delayMs: 5000 }, 'at most 5 s');
  assert.ok(!(await guard.check(fresh)).lockedMs);
  clock.now += 15 * MIN + 1;
  assert.deepStrictEqual(await guard.check(fresh), { delayMs: 0 }, 'gone with the window');
});

test('a shop past 50 failures in an hour makes every sign-in to it wait 2 s more', async () => {
  const { guard, clock } = guardAt();
  const { scope } = keyFor();
  for (let i = 0; i < 50; i++) await guard.failed({ scope, username: `name-${i}`, ip: `10.3.0.${i}` });
  assert.deepStrictEqual(await guard.check({ scope, username: 'owner', ip: '10.3.9.9' }), { delayMs: 0 }, '50 is not past 50');
  await guard.failed({ scope, username: 'name-50', ip: '10.3.0.200' });
  assert.deepStrictEqual(await guard.check({ scope, username: 'owner', ip: '10.3.9.9' }), { delayMs: 2000 });
  assert.deepStrictEqual(await guard.check({ scope: `${scope}-other`, username: 'owner', ip: '10.3.9.9' }), { delayMs: 0 }, 'other shops are not slowed');
  clock.now += 60 * MIN + 1;
  assert.deepStrictEqual(await guard.check({ scope, username: 'owner', ip: '10.3.9.9' }), { delayMs: 0 });
});

test('a typed name is stored as typed, not read as part of the query', async () => {
  const { guard } = guardAt();
  const key = { scope: `test-${++scopes}`, username: '$count', ip: '10.4.0.1' };
  await guard.failed(key, { known: true });
  const stored = await env.db.controlModels.LoginAttempt.findOne({ scope: key.scope, kind: 'ip' }).lean();
  assert.deepStrictEqual([stored.username, stored.count], ['$count', 1]);
});

test('a name that is no account (often the password, typed in the wrong box) is counted but never written down', async () => {
  const { guard } = guardAt();
  const key = { scope: `test-${++scopes}`, username: 'my shop password 99', ip: '10.4.0.2' };
  assert.deepStrictEqual(await failTimes(guard, key, 4), {});
  assert.deepStrictEqual(await guard.failed(key), { lockedMs: 15 * MIN }, 'it still locks');
  const stored = await env.db.controlModels.LoginAttempt.find({ scope: key.scope }).lean();
  assert.strictEqual(stored.length, 3);
  assert.ok(!JSON.stringify(stored).includes('password'), JSON.stringify(stored));
});

test('one attempt of a name from an address is checked at a time; another name or address is not held', () => {
  const { guard } = guardAt();
  const key = keyFor('10.4.0.3');
  const release = guard.hold(key);
  assert.strictEqual(typeof release, 'function');
  assert.strictEqual(guard.hold({ ...key }), null, 'the same triple waits');
  const other = [guard.hold({ ...key, ip: '10.4.0.4' }), guard.hold({ ...key, username: 'cashier' })];
  assert.ok(other.every((r) => typeof r === 'function'));
  release();
  const again = guard.hold(key);
  assert.strictEqual(typeof again, 'function', 'free again once let go');
  for (const r of [again, ...other]) r();
});

test('the wait in Arabic', () => {
  assert.deepStrictEqual([1, 2, 3, 10, 11, 15, 103, 240].map((m) => minutesText(m * MIN)), [
    'دقيقة واحدة', 'دقيقتين', '3 دقائق', '10 دقائق', '11 دقيقة', '15 دقيقة', '103 دقائق', '240 دقيقة',
  ]);
  assert.strictEqual(minutesText(14 * MIN + 1), '15 دقيقة');
});
