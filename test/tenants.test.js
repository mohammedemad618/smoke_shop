// Creating shops (services/tenants.js): every step, the checks before anything is written,
// repeating a request safely, finishing a creation that stopped half way, the audit chain,
// the cap on the number of shops, and the registry seeing changes made elsewhere.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTenant, transition, primaryHost } from '../services/tenants.js';
import { auditHash } from '../control/models/AuditLog.js';
import { startTestEnv, BASE_DOMAIN } from './support/harness.js';

const MAX = 6;
let env;
let control;
before(async () => {
  env = await startTestEnv({ env: { MAX_TENANTS: String(MAX) }, retry: { firstMs: 100, maxMs: 200 } });
  control = env.db.controlModels;
});
after(async () => {
  await env?.close();
});

const create = (input, by = { actor: 'test' }) => createTenant(env.ctx, input, by);
const status = async (promise) => {
  try {
    await promise;
    return 'created';
  } catch (err) {
    return [err.status, err.message];
  }
};

test('a new shop: its record, address, database, settings, «عام», first invoice number, then active', async () => {
  const { tenant, host, url } = await create({
    slug: 'Amal', // the address is lower-cased
    shopName: 'متجر الأمل',
    label: 'الأمل (تجربة)',
    receiptNote: 'البضاعة المباعة لا ترد بعد 3 أيام',
    phone: '0770 000 0000',
    firstInvoiceNumber: 500,
  });
  assert.deepStrictEqual([tenant.slug, tenant.status, tenant.label, tenant.shopNameCache], ['amal', 'active', 'الأمل (تجربة)', 'متجر الأمل']);
  assert.match(tenant.dbName, new RegExp(`^${env.config.tenantDbPrefix}[0-9a-f]{24}$`));
  assert.strictEqual(host, `amal.${BASE_DOMAIN}`);
  assert.strictEqual(url, `http://amal.${BASE_DOMAIN}:3000`);

  const hostDoc = await control.Host.findById(host).lean();
  assert.deepStrictEqual([String(hostDoc.tenantId), hostDoc.kind, hostDoc.cert.status], [String(tenant._id), 'primary', 'none']);

  const models = await env.db.tenantModels(tenant);
  const settings = await models.Setting.findById('shop').lean();
  assert.deepStrictEqual(
    [settings.shopName, settings.receiptNote, settings.timeZone, settings.currency, settings.phone, settings.address],
    ['متجر الأمل', 'البضاعة المباعة لا ترد بعد 3 أيام', 'Asia/Baghdad', 'د.ع', '0770 000 0000', ''],
  );
  assert.deepStrictEqual((await models.Category.find().lean()).map((c) => c.name), ['عام']);
  // Every index is in place before the first request
  const indexes = await models.Product.collection.indexes();
  assert.ok(indexes.some((i) => i.key.barcode === 1 && i.unique));

  // Through its address: the name for the header and the receipt, and invoice 500 first
  const client = env.client(`${host}:${env.app.port}`);
  assert.deepStrictEqual((await client.request('GET', '/api/shop')).data, { shopName: 'متجر الأمل', receiptNote: 'البضاعة المباعة لا ترد بعد 3 أيام' });
  const general = (await client.request('GET', '/api/categories')).data[0];
  const product = (await client.request('POST', '/api/products', { name: 'ماء', barcode: 'W1', category: general._id, purchasePrice: 100, salePrice: 250 })).data;
  const sale = await client.request('POST', '/api/sales', { items: [{ productId: product._id, quantity: 1 }] });
  assert.deepStrictEqual([sale.status, sale.data.number], [201, 500]);

  // The job's steps, the not-yet-built ones skipped
  const job = await control.Job.findOne({ tenantId: tenant._id }).lean();
  assert.deepStrictEqual([job.type, job.status, job.active], ['provision', 'done', false]);
  assert.deepStrictEqual(job.steps.map((s) => [s.key, s.status]), [
    ['host', 'done'], ['database', 'done'], ['settings', 'done'], ['owner', 'skipped'], ['certificate', 'skipped'], ['activate', 'done'],
  ]);
});

test('the registry knows a new shop at once, without waiting for a poll', async () => {
  const { tenant, host } = await create({ slug: 'instant', shopName: 'فوري' });
  assert.strictEqual(String(env.registry.resolve(host).tenant._id), String(tenant._id));
  assert.strictEqual(env.registry.resolve(host).tenant.status, 'active');
});

test('nothing is written when the request is refused', async () => {
  const before = await control.Tenant.countDocuments();
  const cases = [
    [{ slug: 'ab', shopName: 'x' }, 400, /غير صالح/],
    [{ slug: 'shop-1-2-3-4', shopName: 'x' }, 400, /غير صالح/],
    [{ slug: 'admin', shopName: 'x' }, 409, /محجوز/],
    [{ slug: 'hishin', shopName: 'x' }, 409, /محجوز/],
    [{ slug: 'amal', shopName: 'x' }, 409, /مستخدم/],
    [{ slug: 'noname' }, 400, /اسم المتجر/],
    [{ slug: 'longname', shopName: 'م'.repeat(61) }, 400, /اسم المتجر طويل جدًا/],
    [{ slug: 'badzone', shopName: 'x', timeZone: 'Mars/Olympus' }, 400, /المنطقة الزمنية/],
    [{ slug: 'badfirst', shopName: 'x', firstInvoiceNumber: '0' }, 400, /أول فاتورة/],
    [{ slug: 'badfirst', shopName: 'x', firstInvoiceNumber: '12.5' }, 400, /أول فاتورة/],
  ];
  for (const [input, code, message] of cases) {
    const [got, text] = await status(create(input));
    assert.strictEqual(got, code, JSON.stringify(input));
    assert.match(text, message);
  }
  assert.strictEqual(await control.Tenant.countDocuments(), before);
});

test('the same request twice, even at the same moment, makes one shop', async () => {
  const input = { slug: 'twice', shopName: 'مرتين', requestId: 'req-twice-1' };
  const [first, second] = await Promise.all([create(input), create(input)]);
  assert.strictEqual(String(first.tenant._id), String(second.tenant._id));
  const again = await create(input);
  assert.strictEqual(String(again.tenant._id), String(first.tenant._id));
  assert.strictEqual(await control.Tenant.countDocuments({ slug: 'twice' }), 1);
  assert.strictEqual(await control.Host.countDocuments({ tenantId: first.tenant._id }), 1);
  assert.strictEqual(await control.Job.countDocuments({ tenantId: first.tenant._id }), 1);
  assert.strictEqual(await control.AuditLog.countDocuments({ tenantId: first.tenant._id, action: 'tenant.create' }), 1);
  const models = await env.db.tenantModels(first.tenant);
  assert.strictEqual(await models.Setting.countDocuments(), 1);
  assert.strictEqual(await models.Category.countDocuments({ name: 'عام' }), 1);
  // A different request for the same address is refused, and a request id is one shop's only
  assert.deepStrictEqual(await status(create({ ...input, requestId: 'req-twice-2' })), [409, 'هذا العنوان مستخدم']);
  assert.deepStrictEqual((await status(create({ ...input, slug: 'other' })))[0], 409);
});

test('a creation stopped half way is finished by running it again', async () => {
  const { Tenant, Counter } = control;
  // What a crash right after the first write leaves: the record, nothing else
  const dbName = `${env.config.tenantDbPrefix}${'c'.repeat(24)}`;
  await Tenant.create({ slug: 'halfway', label: 'نصف', dbName, status: 'provisioning', rev: await Counter.next('rev') });
  // And a database that cannot get its indexes yet: two products with the same barcode
  const products = env.db.base.getClient().db(dbName).collection('products');
  await products.insertMany([{ barcode: 'DUP' }, { barcode: 'DUP' }]);

  const [code] = await status(create({ slug: 'halfway', shopName: 'نصف الطريق' }));
  assert.strictEqual(code, 503);
  let job = await control.Job.findOne({ type: 'provision', active: true, steps: { $elemMatch: { key: 'database', status: 'failed' } } }).lean();
  assert.ok(job, 'the failed step is recorded');
  assert.deepStrictEqual([job.status, job.steps[0].status], ['failed', 'done']);
  const failure = await control.AuditLog.findOne({ tenantSlug: 'halfway', result: 'failed' }).lean();
  assert.strictEqual(failure.details.step, 'database');
  // The address answers "being set up" meanwhile
  assert.strictEqual((await env.client(`halfway.${BASE_DOMAIN}`).request('GET', '/api/shop')).status, 503);

  await products.deleteOne({});
  await sleep(250);
  const { tenant } = await create({ slug: 'halfway', shopName: 'نصف الطريق' });
  assert.deepStrictEqual([tenant.status, tenant.dbName], ['active', dbName]);
  job = await control.Job.findById(job._id).lean();
  assert.deepStrictEqual([job.status, job.active, job.attempts], ['done', false, 2]);
  assert.strictEqual((await env.client(`halfway.${BASE_DOMAIN}`).request('GET', '/api/shop')).data.shopName, 'نصف الطريق');
});

test('every action is in the audit log, each entry chained to the one before', async () => {
  const entries = await control.AuditLog.find().sort({ at: 1, _id: 1 }).lean();
  assert.ok(entries.length >= 8);
  let prev = '0'.repeat(64);
  for (const entry of entries) {
    assert.strictEqual(entry.prevHash, prev);
    assert.strictEqual(entry.hash, auditHash(entry.prevHash, entry));
    prev = entry.hash;
  }
  const amal = entries.filter((e) => e.tenantSlug === 'amal').map((e) => [e.action, e.actor, e.details.to ?? null]);
  assert.deepStrictEqual(amal, [['tenant.create', 'test', null], ['tenant.status', 'test', 'active']]);
});

test('the registry picks up changes written elsewhere by polling, and on a full reload', async () => {
  const { tenant, host } = await create({ slug: 'elsewhere', shopName: 'من بعيد' });
  const client = env.client(host);
  assert.strictEqual((await client.request('GET', '/api/shop')).status, 200);
  // As another process would: straight to the database, with the next rev
  await control.Tenant.updateOne({ _id: tenant._id }, { $set: { status: 'suspended', rev: await control.Counter.next('rev') } });
  assert.strictEqual((await client.request('GET', '/api/shop')).status, 200, 'not seen before the poll');
  await env.registry.poll();
  assert.strictEqual((await client.request('GET', '/api/shop')).status, 423);
  // A change with an older rev written late (two writers out of order) is still found
  const late = await control.Counter.next('rev');
  await control.Counter.next('rev');
  await control.Tenant.updateOne({ _id: tenant._id }, { $set: { status: 'active', rev: await control.Counter.next('rev') } });
  await env.registry.poll();
  await control.Tenant.updateOne({ _id: tenant._id }, { $set: { statusReason: 'late', rev: late } });
  await env.registry.poll();
  assert.strictEqual((await client.request('GET', '/api/shop')).status, 200);
  await control.Tenant.updateOne({ _id: tenant._id }, { $set: { status: 'suspended' } }); // no rev: only a reload sees it
  await env.registry.poll();
  assert.strictEqual((await client.request('GET', '/api/shop')).status, 200);
  await env.registry.load();
  assert.strictEqual((await client.request('GET', '/api/shop')).status, 423);
});

test(`no more than MAX_TENANTS shops (${MAX} here); deleted ones do not count`, async () => {
  const live = await control.Tenant.countDocuments({ status: { $ne: 'deleted' } });
  for (let i = live; i < MAX; i++) await create({ slug: `fill-${i}`, shopName: `ملء ${i}` });
  assert.deepStrictEqual(await status(create({ slug: 'one-too-many', shopName: 'زيادة' })), [409, `وصل عدد المتاجر إلى الحد الأقصى (${MAX})`]);
  const { _id } = await control.Tenant.findOne({ slug: `fill-${MAX - 1}` }).lean();
  await transition(env.ctx, _id, 'active', 'deleted', { actor: 'test' });
  const { tenant } = await create({ slug: 'one-too-many', shopName: 'زيادة' });
  assert.strictEqual(tenant.status, 'active');
  // A deleted shop's address is never given again
  assert.deepStrictEqual(await status(create({ slug: `fill-${MAX - 1}`, shopName: 'x' })), [409, 'هذا العنوان مستخدم']);
  assert.strictEqual(primaryHost(env.config, 'x-y'), `x-y.${BASE_DOMAIN}`);
});
