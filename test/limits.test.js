// What one shop may take of what every shop shares (lib/limits.js): turns per key that wait a
// little and then refuse, 4 API requests of a shop at a time (503 SHOP_BUSY with Retry-After
// past a 2 s wait, other shops untouched), and the reports one at a time per shop and three
// in the whole process, each turn given back whatever the report did.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTurns, runReport, reportTurns, SHOP_REQUESTS, SHOP_WAIT_MS } from '../lib/limits.js';
import { startTestEnv } from './support/harness.js';

let env;
let a;
let b;
before(async () => {
  env = await startTestEnv();
  a = await env.createShop('limit-a');
  b = await env.createShop('limit-b');
});
after(async () => {
  await env?.close();
});

// A promise with its resolve outside, to hold work until the test lets it go
const gate = () => {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
};

test('turns: per key and in all, the next waiting one served first, none after the wait', async () => {
  const turns = createTurns({ perKey: 2, total: 3, waitMs: 80 });
  assert.deepStrictEqual(await Promise.all([turns.acquire('a'), turns.acquire('a')]), [true, true]);
  const third = turns.acquire('a');
  const otherKey = await turns.acquire('b');
  assert.strictEqual(otherKey, true, 'another key has its own');
  const fourth = turns.acquire('c');
  assert.deepStrictEqual(turns.state(), { held: 3, waiting: 2 });
  // One of a's ends: the turn goes to a's waiting one (the total is full, and a was first)
  turns.release('a');
  assert.strictEqual(await third, true);
  assert.strictEqual(await fourth, false, 'c waited 80 ms for the total and got nothing');
  for (const key of ['a', 'a', 'b']) turns.release(key);
  assert.deepStrictEqual(turns.state(), { held: 0, waiting: 0 });
  assert.strictEqual(await turns.acquire('c'), true);
});

test("a shop's fifth request at once waits for a turn, then is refused 503 with Retry-After; other shops go on", async () => {
  const models = await env.db.tenantModels(a.tenant);
  const held = gate();
  const real = models.Category.find;
  let waiting = 0;
  // Every list of categories of shop A waits until the test lets it go
  const spy = mock.method(models.Category, 'find', function (...args) {
    const query = real.apply(this, args);
    const exec = query.exec.bind(query);
    query.exec = async () => {
      waiting++;
      await held.promise;
      return exec();
    };
    return query;
  });
  try {
    const first = Array.from({ length: SHOP_REQUESTS }, () => a.client.request('GET', '/api/categories'));
    while (waiting < SHOP_REQUESTS) await sleep(10);
    // Shop B is not held up by A's four
    assert.strictEqual((await b.client.request('GET', '/api/products')).status, 200);
    const started = Date.now();
    const fifth = await a.client.request('GET', '/api/products');
    assert.deepStrictEqual([fifth.status, fifth.data.code, fifth.headers['retry-after']], [503, 'SHOP_BUSY', '2']);
    assert.match(fifth.data.error, /المتجر مشغول/);
    assert.ok(Date.now() - started >= SHOP_WAIT_MS - 50, 'it waited for a turn first');
    // A request that waits gets the first turn given back
    const sixth = a.client.request('GET', '/api/products');
    await sleep(50);
    held.open();
    assert.ok((await Promise.all(first)).every((r) => r.status === 200));
    assert.strictEqual((await sixth).status, 200);
  } finally {
    held.open();
    spy.mock.restore();
  }
  // Every turn was given back
  const again = await Promise.all(Array.from({ length: SHOP_REQUESTS }, () => a.client.request('GET', '/api/categories')));
  assert.ok(again.every((r) => r.status === 200));
});

test('reports: one at a time per shop and three in all, each turn given back whatever happened', async () => {
  const work = Array.from({ length: 5 }, () => gate());
  const order = [];
  const report = (shop, i) =>
    runReport(shop, async () => {
      order.push(i);
      await work[i].promise;
      if (i === 0) throw new Error('the report failed');
      return i;
    });
  const runs = [report('s1', 0), report('s1', 1), report('s2', 2), report('s3', 3), report('s4', 4)];
  await sleep(20);
  assert.deepStrictEqual(order, [0, 2, 3], "s1's second waits for its first, s4 for the total");
  assert.deepStrictEqual(reportTurns(), { held: 3, waiting: 2 });
  work[0].open();
  await assert.rejects(runs[0], /the report failed/);
  await sleep(20);
  // The failed one's turn went to the first waiting one that may have it: s1's second
  assert.deepStrictEqual(order, [0, 2, 3, 1]);
  for (const w of work) w.open();
  assert.deepStrictEqual(await Promise.all(runs.slice(1)), [1, 2, 3, 4]);
  assert.deepStrictEqual(reportTurns(), { held: 0, waiting: 0 });
  // The sales report of a shop goes through its turn too
  const res = await a.client.request('GET', `/api/sales/report?${new URLSearchParams({ from: new Date(Date.now() - 864e5).toISOString(), to: new Date().toISOString() })}`);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(reportTurns(), { held: 0, waiting: 0 });
});
