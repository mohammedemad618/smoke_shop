// Rules that keep shops apart by construction, checked on the source and the running app:
// routes take models only from req.models, nothing is registered on mongoose's default or
// base connection, every ref names a known model, the host comes only from the Host header,
// a shop whose database cannot be prepared does not pile up connection objects, and a full
// shared pool answers «busy» rather than an error.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import mongoose from 'mongoose';
import { SCHEMAS } from '../models/index.js';
import { CONTROL_SCHEMAS } from '../control/models/index.js';
import { startTestEnv, BASE_DOMAIN } from './support/harness.js';

const ROOT = new URL('../', import.meta.url);
// The app's own code: everything but the tests, the docs and node_modules
const SOURCE_DIRS = ['', 'admin/', 'control/', 'control/models/', 'lib/', 'models/', 'routes/', 'scripts/', 'services/', 'public/js/'];

async function sourceFiles(dirs = SOURCE_DIRS) {
  const files = [];
  for (const dir of dirs) {
    for (const entry of await readdir(new URL(dir, ROOT), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push({ name: dir + entry.name, text: await readFile(new URL(dir + entry.name, ROOT), 'utf8') });
      }
    }
  }
  return files;
}

let env;
let shops;
before(async () => {
  // Fast retries for the shop whose indexes cannot be built
  env = await startTestEnv({ retry: { firstMs: 200, maxMs: 400 } });
  shops = [await env.createShop('guard-a'), await env.createShop('guard-b')];
});
after(async () => {
  await env?.close();
});

test("no route imports a model: they all come from req.models", async () => {
  const routes = await sourceFiles(['routes/']);
  assert.ok(routes.length >= 8);
  for (const { name, text } of routes) {
    assert.doesNotMatch(text, /from '\.\.\/models\//, name);
    assert.doesNotMatch(text, /from '\.\.\/control\//, name);
  }
});

test('nothing compiles a model but bindModels()', async () => {
  for (const { name, text } of await sourceFiles()) {
    if (name === 'models/index.js') continue;
    assert.doesNotMatch(text, /\bmodel\(/, name);
  }
});

test("the default mongoose connection and the base one have no models, after serving two shops", async () => {
  for (const { client } of shops) {
    assert.strictEqual((await client.request('GET', '/api/products')).status, 200);
    assert.strictEqual((await client.request('GET', '/api/sales')).status, 200);
  }
  assert.deepStrictEqual(mongoose.modelNames(), []);
  assert.deepStrictEqual(Object.keys(mongoose.connection.models), []);
  assert.deepStrictEqual(Object.keys(env.db.base.models), []);
  // Each shop's models live on its own connection only
  const [a, b] = await Promise.all(shops.map(({ tenant }) => env.db.tenantModels(tenant)));
  assert.notStrictEqual(a.Product, b.Product);
  assert.notStrictEqual(a.Product.db, b.Product.db);
  assert.strictEqual(a.Product.db.name, shops[0].tenant.dbName);
});

// Every ref in a schema, its subdocuments and arrays included
function refsOf(schema, seen = new Set()) {
  const refs = [];
  if (seen.has(schema)) return refs;
  seen.add(schema);
  schema.eachPath((path, type) => {
    if (type.options?.ref) refs.push([path, type.options.ref]);
    const inner = type.embeddedSchemaType ?? type.caster;
    if (inner?.options?.ref) refs.push([path, inner.options.ref]);
    if (type.schema) for (const [sub, ref] of refsOf(type.schema, seen)) refs.push([`${path}.${sub}`, ref]);
  });
  return refs;
}

test('every ref names a model of the same database', () => {
  let count = 0;
  for (const [schemas, label] of [[SCHEMAS, 'shop'], [CONTROL_SCHEMAS, 'control']]) {
    for (const [model, schema] of Object.entries(schemas)) {
      for (const [path, ref] of refsOf(schema)) {
        count++;
        assert.ok(Object.hasOwn(schemas, ref), `${label} ${model}.${path} refers to ${ref}`);
      }
    }
  }
  // Product.category, Sale.items.product, DebtEntry.customer... are all found
  assert.ok(count >= 10, `only ${count} refs found`);
});

test('the host comes only from the Host header: no req.hostname, req.host or forwarded headers', async () => {
  for (const { name, text } of await sourceFiles()) {
    assert.doesNotMatch(text, /\breq\.(hostname|host)\b/, name);
    assert.doesNotMatch(text, /x-forwarded-host|\bforwarded\b/i, name);
  }
});

test("1000 requests to a shop whose database cannot be prepared add no connection objects", async () => {
  const { Tenant, Host, Counter } = env.db.controlModels;
  const dbName = `${env.config.tenantDbPrefix}${'b'.repeat(24)}`;
  // Two products with the same barcode: the unique index cannot be built
  const products = env.db.base.getClient().db(dbName).collection('products');
  await products.insertMany([{ barcode: 'DUP', name: 'x' }, { barcode: 'DUP', name: 'y' }]);
  const broken = await Tenant.create({ slug: 'broken', label: 'x', dbName, status: 'active', rev: await Counter.next('rev') });
  await Host.create({ _id: `broken.${BASE_DOMAIN}`, tenantId: broken._id, rev: await Counter.next('rev') });
  await env.registry.poll();
  const client = env.client(`broken.${BASE_DOMAIN}`);

  const views = env.db.base.otherDbs.length;
  const cached = Object.keys(env.db.base.relatedDbs).length;
  const first = await client.request('GET', '/api/shop');
  assert.strictEqual(first.status, 503);
  assert.match(first.data.error, /تعذّر فتح بيانات المتجر/);
  const afterFirst = env.db.base.otherDbs.length;
  assert.strictEqual(afterFirst, views + 1, 'one view on the database, once');
  for (let i = 0; i < 1000; i++) {
    const res = await client.request('GET', '/api/products');
    assert.strictEqual(res.status, 503);
  }
  assert.strictEqual(env.db.base.otherDbs.length, afterFirst);
  assert.strictEqual(Object.keys(env.db.base.relatedDbs).length, cached + 1);

  // Once the data is fixed, the next try after the wait succeeds on the same connection
  await products.deleteOne({ name: 'y' });
  await sleep(450);
  const fixed = await client.request('GET', '/api/products');
  assert.strictEqual(fixed.status, 200);
  assert.strictEqual(env.db.base.otherDbs.length, afterFirst);
});

test('a full shared pool answers 503 «الخادم مشغول الآن» with Retry-After, then serves again', async () => {
  // Ten slow queries hold every connection of the pool (maxPoolSize 10) for 4 s, longer
  // than the 2 s a request waits for one
  const hold = env.db.base.getClient().db(env.config.controlDb).collection('pool_hold');
  await hold.insertOne({ x: 1 });
  const held = Array.from({ length: 10 }, () => hold.find({ $where: 'sleep(4000) || true' }).toArray());
  await sleep(500);
  const { client } = shops[0];
  const busy = await client.request('GET', '/api/products');
  assert.deepStrictEqual(
    [busy.status, busy.headers['retry-after'], busy.data.error],
    [503, '5', 'الخادم مشغول الآن. أعد المحاولة بعد لحظات'],
  );
  await Promise.all(held);
  assert.strictEqual((await client.request('GET', '/api/products')).status, 200);
});
