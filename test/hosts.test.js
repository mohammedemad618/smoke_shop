// A request's shop comes from its Host header only. Unknown, odd and reserved hosts are
// refused before any database is opened, a shop's status decides what its address answers,
// and the admin host has its own (placeholder) router.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHost } from '../lib/tenancy.js';
import { transition } from '../services/tenants.js';
import { startTestEnv, DB_PREFIX, BASE_DOMAIN } from './support/harness.js';

let env;
let shop;
before(async () => {
  env = await startTestEnv();
  shop = await env.createShop('gate');
});
after(async () => {
  await env?.close();
});

const databaseNames = async () => (await env.db.base.db.admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);

test('normalizeHost lower-cases, takes off the port and a trailing dot, and refuses anything odd', () => {
  const cases = [
    ['Shop-A.POS.localhost:3000', 'shop-a.pos.localhost'],
    ['shop-a.pos.localhost.', 'shop-a.pos.localhost'],
    ['shop-a.pos.localhost.:80', 'shop-a.pos.localhost'],
    ['127.0.0.1:3000', '127.0.0.1'],
    ['xn--mgbh0fb.pos.localhost', 'xn--mgbh0fb.pos.localhost'],
    ['[::1]:3000', null],
    ['a..pos.localhost', null],
    ['.pos.localhost', null],
    ['', null],
    [undefined, null],
    [['a.pos.localhost'], null],
    ['a b.pos.localhost', null],
    ['user@gate.pos.localhost', null],
    ['gate.pos.localhost:99999', null],
    ['gate.pos.localhost:', null],
    ['gate.pos.localhost:80:80', null],
    ['متجر.pos.localhost', null],
    ['-a.pos.localhost', null],
    ['a-.pos.localhost', null],
    ['a_b.pos.localhost', null],
    [`${'a'.repeat(64)}.pos.localhost`, null],
    [`${'a.'.repeat(130)}com`, null],
  ];
  for (const [raw, expected] of cases) assert.strictEqual(normalizeHost(raw), expected, JSON.stringify(raw));
});

test("a shop's address works with any case, a port and a trailing dot", async () => {
  for (const host of ['gate.pos.localhost', 'GATE.Pos.LocalHost:3000', 'gate.pos.localhost.', 'gate.pos.localhost.:8080']) {
    const res = await env.client(host).request('GET', '/api/auth/shop');
    assert.deepStrictEqual([res.status, res.data.shopName], [200, 'متجر gate'], host);
  }
});

test('the admin host serves the panel only: its API needs a session, and no shop is reached', async () => {
  const admin = env.client(`admin.${BASE_DOMAIN}`);
  const page = await admin.request('GET', '/');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /لوحة الإدارة/);
  const api = await admin.request('GET', '/api/admin/tenants');
  assert.deepStrictEqual([api.status, api.data.code], [401, 'AUTH_EXPIRED']);
  // A shop's own routes and scripts are not there
  for (const path of ['/api/products', '/api/auth/shop', '/js/common.js', '/cashier.html']) {
    assert.strictEqual((await admin.request('GET', path)).status, 404, path);
  }
});

test('/healthz and /readyz answer for Host localhost only, and say nothing about the shops', async () => {
  for (const host of ['localhost', '127.0.0.1:3401']) {
    const healthz = await env.client(host).request('GET', '/healthz');
    assert.deepStrictEqual([healthz.status, healthz.data], [200, { ok: true }], host);
    const readyz = await env.client(host).request('GET', '/readyz');
    assert.strictEqual(readyz.status, 200);
    assert.strictEqual(readyz.data.ok, true);
    assert.ok('sha' in readyz.data && Number.isInteger(readyz.data.eventLoopP99Ms));
    assert.strictEqual(readyz.headers['cache-control'], 'no-store');
  }
  // On a shop's or the admin's address they are just unknown paths
  assert.notStrictEqual((await shop.client.request('GET', '/healthz')).status, 200);
  assert.strictEqual((await env.client(`admin.${BASE_DOMAIN}`).request('GET', '/readyz')).status, 404);
  assert.strictEqual((await env.client('example.com').request('GET', '/healthz')).status, 404);
});

test('unknown and reserved hosts: 404, an Arabic page for pages and JSON for /api', async () => {
  for (const host of [`nosuch.${BASE_DOMAIN}`, `www.${BASE_DOMAIN}`, `admin2.${BASE_DOMAIN}`, BASE_DOMAIN, 'localhost', 'example.com']) {
    const page = await env.client(host).request('GET', '/cashier.html');
    assert.strictEqual(page.status, 404, host);
    assert.match(page.headers['content-type'], /html/);
    assert.match(page.text, /lang="ar" dir="rtl"/);
    assert.match(page.text, /لا يوجد متجر بهذا العنوان/);
    const api = await env.client(host).request('GET', '/api/products');
    assert.deepStrictEqual([api.status, api.data.code], [404, 'TENANT_NOT_FOUND'], host);
  }
  // A malformed host is refused as such
  const bad = await env.client('a..b').request('GET', '/api/products');
  assert.deepStrictEqual([bad.status, bad.data.code], [400, 'BAD_HOST']);
});

test('50 random and odd hosts create no database', async () => {
  const known = new Set([`gate.${BASE_DOMAIN}`]);
  const odd = [
    `gate.gate.${BASE_DOMAIN}`, `x.gate.${BASE_DOMAIN}`, `gate.${BASE_DOMAIN}.evil.com`, `evil.com.${BASE_DOMAIN}x`,
    `1-2-3-4.${BASE_DOMAIN}`, `shop-10-0-0-1.${BASE_DOMAIN}`, `cafe-7f000001.${BASE_DOMAIN}`, `ab.${BASE_DOMAIN}`,
    `${'a'.repeat(31)}.${BASE_DOMAIN}`, `a--b.${BASE_DOMAIN}`, `9shop.${BASE_DOMAIN}`, `test.${BASE_DOMAIN}`,
    `localhost.${BASE_DOMAIN}`, `gate_.${BASE_DOMAIN}`, `%67ate.${BASE_DOMAIN}`, `gate%2e${BASE_DOMAIN}`,
    `[::1]`, `[::1]:3000`, '127.0.0.1', '0.0.0.0', 'gate', `gate.${BASE_DOMAIN}:abc`, `gate.${BASE_DOMAIN}:-1`,
    `gate@${BASE_DOMAIN}`, `gate.${BASE_DOMAIN}/x`, ' ', '.', '..', `.${BASE_DOMAIN}`,
  ];
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789-._:@[]%/';
  const suffixes = ['', `.${BASE_DOMAIN}`, `.${BASE_DOMAIN}:3000`, '.localhost', `.${BASE_DOMAIN}.`];
  const random = Array.from({ length: 50 - odd.length }, () => {
    const length = 1 + Math.floor(Math.random() * 40);
    const label = Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return label + suffixes[Math.floor(Math.random() * suffixes.length)];
  });
  const hosts = [...odd, ...random].filter((h) => !known.has(normalizeHost(h)));
  assert.ok(hosts.length >= 49);

  const before = await databaseNames();
  const views = env.db.base.otherDbs.length;
  for (const host of hosts) {
    for (const path of ['/api/shop', '/api/products', '/cashier.html']) {
      const res = await env.client(host).request('GET', path);
      assert.ok([400, 404, 410].includes(res.status), `${host} ${path} -> ${res.status}`);
    }
  }
  const created = (await databaseNames()).filter((name) => !before.includes(name));
  // Other test files run at the same time and make their own pos_test_ databases
  assert.deepStrictEqual(created.filter((name) => !name.startsWith('pos_test_') || name.startsWith(DB_PREFIX)), []);
  assert.strictEqual(env.db.base.otherDbs.length, views, 'no database was even opened');
});

test("a shop's status decides what its address answers", async () => {
  const { tenant } = shop;
  // Signed out: the status decides before any session is looked at (the sessions themselves
  // end when the shop is suspended, test/auth.test.js)
  const page = () => shop.client.request('GET', '/login.html');
  const api = () => shop.client.request('GET', '/api/auth/shop');
  assert.strictEqual((await api()).status, 200);

  await transition(env.ctx, tenant._id, 'active', 'suspended', { actor: 'test', reason: 'لم يُدفع الاشتراك' });
  let res = await api();
  assert.deepStrictEqual([res.status, res.data.code, res.data.error], [423, 'TENANT_SUSPENDED', 'هذا المتجر موقوف مؤقتًا، تواصل مع الإدارة.']);
  assert.strictEqual(res.headers['cache-control'], 'no-store');
  res = await page();
  assert.strictEqual(res.status, 423);
  assert.match(res.text, /هذا المتجر موقوف مؤقتًا/);
  // Even the files: nothing of a suspended shop is served
  assert.strictEqual((await shop.client.request('GET', '/js/common.js')).status, 423);

  await transition(env.ctx, tenant._id, 'suspended', 'pending_deletion', { actor: 'test' });
  assert.strictEqual((await api()).status, 423);
  await transition(env.ctx, tenant._id, 'pending_deletion', 'suspended', { actor: 'test' });
  await transition(env.ctx, tenant._id, 'suspended', 'active', { actor: 'test' });
  assert.strictEqual((await api()).status, 200);

  // A change from a stale state is refused, and leaves the status as it was
  await assert.rejects(transition(env.ctx, tenant._id, 'suspended', 'active', { actor: 'test' }), (err) => err.status === 409);
  assert.strictEqual((await api()).status, 200);
});

test('a shop being set up answers 503 and opens no database; a deleted one 410', async () => {
  const { Tenant, Host, Counter } = env.db.controlModels;
  const dbName = `${env.config.tenantDbPrefix}${'a'.repeat(24)}`;
  const pending = await Tenant.create({ slug: 'halfway', label: 'x', dbName, status: 'provisioning', rev: await Counter.next('rev') });
  await Host.create({ _id: `halfway.${BASE_DOMAIN}`, tenantId: pending._id, rev: await Counter.next('rev') });
  // Written straight to the control database, as the command line does: the poll finds it
  await env.registry.poll();
  const res = await env.client(`halfway.${BASE_DOMAIN}`).request('GET', '/api/shop');
  assert.deepStrictEqual([res.status, res.data.code, res.headers['retry-after']], [503, 'TENANT_PROVISIONING', '30']);
  assert.ok(!(await databaseNames()).includes(dbName));

  const gone = await env.createShop('gone');
  await transition(env.ctx, gone.tenant._id, 'active', 'deleted', { actor: 'test' });
  const deleted = await gone.client.request('GET', '/api/shop');
  assert.deepStrictEqual([deleted.status, deleted.data.code], [410, 'TENANT_DELETED']);
  assert.match((await gone.client.request('GET', '/')).text, /هذا المتجر لم يعد موجودًا/);

  // A retired address stays out of use for ever
  await Host.create({ _id: `old-gate.${BASE_DOMAIN}`, tenantId: shop.tenant._id, kind: 'retired', rev: await Counter.next('rev') });
  await env.registry.poll();
  assert.strictEqual((await env.client(`old-gate.${BASE_DOMAIN}`).request('GET', '/api/shop')).status, 410);
});
