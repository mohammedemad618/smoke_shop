// A shop's staff accounts (routes/staff.js, services/staff.js): only the owner manages them;
// a new account gets a first password shown once, which it must change at its first
// sign-in; names are unique in the shop whatever their case, the owner's included; the
// owner's own account cannot be touched from here; at most 20 are in use at once, even when
// two are added at the same moment; disabling ends the account's sessions at once and
// refuses its sign-in; a new password ends them too and must be changed again; a permission
// taken away applies to the next request; and every change is in the audit log, never with
// a password.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetUserPassword } from '../services/tenants.js';
import { STAFF_MAX } from '../services/staff.js';
import { startTestEnv, addStaff, signInAsOwner } from './support/harness.js';

let env;
let shop;
before(async () => {
  env = await startTestEnv();
  shop = await env.createShop('staff-shop');
});
after(async () => {
  await env?.close();
});

const owner = () => shop.client;
const stranger = () => env.client(shop.host);
const ok = async (client, method, path, body) => {
  const res = await client.request(method, path, body);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${res.text}`);
  return res.data;
};
const sessions = (userId) => env.db.controlModels.Session.countDocuments({ tenantId: shop.tenant._id, ...(userId ? { userId } : {}) });
const models = () => env.db.tenantModels(shop.tenant);

test('the owner adds an account: a first password shown once, stored hashed, changed at the first sign-in', async () => {
  assert.deepStrictEqual(await ok(owner(), 'GET', '/api/staff'), { staff: [], max: STAFF_MAX });
  const res = await owner().request('POST', '/api/staff', { username: '  Ali.H ', displayName: ' علي حسن ', permissions: ['returns', 'credit', 'credit'] });
  assert.strictEqual(res.status, 201);
  const { staff, password } = res.data;
  assert.match(password, /^[A-Za-z2-9]{14}$/);
  assert.deepStrictEqual(
    { ...staff, id: undefined, createdAt: undefined },
    { id: undefined, username: 'ali.h', displayName: 'علي حسن', permissions: ['credit', 'returns'], disabled: false, mustChangePassword: true, lastLoginAt: null, createdAt: undefined },
  );
  assert.ok(!JSON.stringify(await ok(owner(), 'GET', '/api/staff')).includes(password), 'the list never shows it again');
  const { User } = await models();
  const stored = await User.findById(staff.id).select('+passwordHash').lean();
  assert.match(stored.passwordHash, /^\$scrypt\$/);
  assert.deepStrictEqual([stored.role, stored.permissions], ['staff', ['credit', 'returns']]);

  // The first sign-in: nothing but changing the password until it is changed
  const browser = stranger();
  const login = await browser.login('ALI.H', password);
  assert.deepStrictEqual([login.status, login.data.role, login.data.mustChangePassword, login.data.permissions], [200, 'staff', true, ['credit', 'returns']]);
  const blocked = await browser.request('GET', '/api/products');
  assert.deepStrictEqual([blocked.status, blocked.data.code], [403, 'PASSWORD_CHANGE_REQUIRED']);
  await signInAsOwner(browser, { username: 'ali.h', password }, shop.tenant.slug);
  assert.strictEqual((await browser.request('GET', '/api/products')).status, 200);
  const listed = (await ok(owner(), 'GET', '/api/staff')).staff[0];
  assert.deepStrictEqual([listed.mustChangePassword, typeof listed.lastLoginAt], [false, 'string']);

  // In the shop's audit log, with the account and never the password
  const entry = await env.db.controlModels.AuditLog.findOne({ tenantId: shop.tenant._id, action: 'staff.create' }).lean();
  assert.deepStrictEqual([entry.actor, entry.details], ['shop:owner', { username: 'ali.h', permissions: ['credit', 'returns'] }]);
  assert.ok(!JSON.stringify(await env.db.controlModels.AuditLog.find({ tenantId: shop.tenant._id }).lean()).includes(password));
});

test('names are unique in the shop whatever their case, the owner\'s too; what is sent is checked', async () => {
  await addStaff(env, shop, { username: 'sara', displayName: 'سارة', signIn: false });
  const refused = [
    [{ username: 'SARA', displayName: 'سارة 2' }, 409, 'USERNAME_TAKEN'],
    [{ username: 'owner', displayName: 'ليس المالك' }, 409, 'USERNAME_TAKEN'],
    [{ username: 'ab', displayName: 'قصير' }, 400, 'BAD_INPUT'],
    [{ username: 'علي', displayName: 'بالعربية' }, 400, 'BAD_INPUT'],
    [{ username: { $ne: '' }, displayName: 'حقن' }, 400, 'BAD_INPUT'],
    [{ username: 'noname' }, 400, 'BAD_INPUT'],
    [{ username: 'longname', displayName: 'ن'.repeat(61) }, 400, 'BAD_INPUT'],
    [{ username: 'perms', displayName: 'صلاحية', permissions: ['settings'] }, 400, 'BAD_INPUT'],
    [{ username: 'perms', displayName: 'صلاحية', permissions: 'credit' }, 400, 'BAD_INPUT'],
  ];
  for (const [body, status, code] of refused) {
    const res = await owner().request('POST', '/api/staff', body);
    assert.deepStrictEqual([res.status, res.data.code], [status, code], JSON.stringify(body));
    assert.match(res.data.error, /[؀-ۿ]/, 'said in Arabic');
  }
  assert.match((await owner().request('POST', '/api/staff', { username: 'Sara', displayName: 'x' })).data.error, /مستخدم من قبل/);
});

test('only the owner manages accounts, and the owner\'s own cannot be touched from here', async () => {
  const supervisor = await addStaff(env, shop, { username: 'boss', displayName: 'مشرف', permissions: ['credit', 'returns', 'products', 'purchases', 'reports'] });
  for (const [method, path] of [['GET', '/api/staff'], ['POST', '/api/staff'], ['PUT', `/api/staff/${supervisor.id}`], ['POST', `/api/staff/${supervisor.id}/password`], ['POST', `/api/staff/${supervisor.id}/disable`]]) {
    const res = await supervisor.client.request(method, path, method === 'GET' ? undefined : { username: 'sneaky', displayName: 'x', permissions: [] });
    assert.deepStrictEqual([res.status, res.data.code], [403, 'FORBIDDEN'], `${method} ${path}`);
  }
  const { User } = await models();
  assert.strictEqual(await User.countDocuments({ usernameLower: 'sneaky' }), 0);

  const ownerId = String((await User.findOne({ role: 'owner' }).lean())._id);
  for (const [method, path, body] of [
    ['PUT', `/api/staff/${ownerId}`, { displayName: 'مالك آخر', permissions: [] }],
    ['POST', `/api/staff/${ownerId}/disable`],
    ['POST', `/api/staff/${ownerId}/enable`],
    ['POST', `/api/staff/${ownerId}/password`],
  ]) {
    const res = await owner().request(method, path, body);
    assert.deepStrictEqual([res.status, res.data.code], [403, 'FORBIDDEN'], `${method} ${path}`);
  }
  const stored = await User.findById(ownerId).lean();
  assert.deepStrictEqual([stored.role, stored.disabledAt, stored.mustChangePassword, stored.authVersion], ['owner', undefined, false, 2]);
  assert.strictEqual((await owner().request('GET', '/api/staff')).status, 200, 'still signed in');
  assert.strictEqual((await owner().request('PUT', '/api/staff/0123456789abcdef01234567', { displayName: 'x' })).status, 404);
});

test('a permission taken away applies to the next request; the session goes on', async () => {
  const cashier = await addStaff(env, shop, { username: 'cashier1', displayName: 'كاشير', permissions: ['credit', 'returns'] });
  assert.strictEqual((await cashier.client.request('GET', '/api/customers')).status, 200);
  const { staff } = await ok(owner(), 'PUT', `/api/staff/${cashier.id}`, { permissions: ['returns'] });
  assert.deepStrictEqual(staff.permissions, ['returns']);
  const res = await cashier.client.request('GET', '/api/customers');
  assert.deepStrictEqual([res.status, res.data.code], [403, 'FORBIDDEN']);
  assert.deepStrictEqual((await ok(cashier.client, 'GET', '/api/auth/me')).permissions, ['returns']);
  // A name and permissions given back
  await ok(owner(), 'PUT', `/api/staff/${cashier.id}`, { displayName: 'كاشير الصباح', permissions: ['credit', 'returns'] });
  assert.strictEqual((await cashier.client.request('GET', '/api/customers')).status, 200);
  assert.strictEqual((await ok(cashier.client, 'GET', '/api/auth/me')).user.displayName, 'كاشير الصباح');
  assert.strictEqual((await owner().request('PUT', `/api/staff/${cashier.id}`, {})).status, 400, 'nothing to save');
  const entry = await env.db.controlModels.AuditLog.findOne({ tenantId: shop.tenant._id, action: 'staff.update' }).sort({ at: -1 }).lean();
  assert.deepStrictEqual(entry.details, { username: 'cashier1', displayName: 'كاشير الصباح', permissions: ['credit', 'returns'] });
});

test('disabling ends every session of the account at once and refuses its sign-in; enabling lets it back', async () => {
  const worker = await addStaff(env, shop, { username: 'worker', displayName: 'عامل' });
  const second = stranger();
  assert.strictEqual((await second.login('worker', worker.password)).status, 200);
  assert.strictEqual(await sessions(worker.id), 2);

  const { staff } = await ok(owner(), 'POST', `/api/staff/${worker.id}/disable`);
  assert.strictEqual(staff.disabled, true);
  assert.strictEqual(await sessions(worker.id), 0);
  for (const client of [worker.client, second]) assert.strictEqual((await client.request('GET', '/api/products')).status, 401);
  const login = await stranger().login('worker', worker.password);
  assert.deepStrictEqual([login.status, login.data.code], [401, 'LOGIN_FAILED'], 'the same answer as a wrong password');
  // Disabling again changes nothing
  assert.strictEqual((await ok(owner(), 'POST', `/api/staff/${worker.id}/disable`)).staff.disabled, true);

  assert.strictEqual((await ok(owner(), 'POST', `/api/staff/${worker.id}/enable`)).staff.disabled, false);
  assert.strictEqual((await stranger().login('worker', worker.password)).status, 200, 'with the password it had');
  const actions = (await env.db.controlModels.AuditLog.find({ tenantId: shop.tenant._id, 'details.username': 'worker' }).sort({ at: 1 }).lean()).map((e) => e.action);
  assert.deepStrictEqual(actions, ['staff.create', 'staff.disable', 'staff.enable']);
});

test('a new password: the old one stops, every session ends, and the new one must be changed first', async () => {
  const worker = await addStaff(env, shop, { username: 'nightshift', displayName: 'المسائي' });
  const { password, staff } = await ok(owner(), 'POST', `/api/staff/${worker.id}/password`);
  assert.notStrictEqual(password, worker.password);
  assert.strictEqual(staff.mustChangePassword, true);
  assert.strictEqual(await sessions(worker.id), 0);
  assert.strictEqual((await worker.client.request('GET', '/api/products')).status, 401);
  assert.strictEqual((await stranger().login('nightshift', worker.password)).status, 401);
  const browser = stranger();
  const login = await browser.login('nightshift', password);
  assert.deepStrictEqual([login.status, login.data.mustChangePassword], [200, true]);
  assert.strictEqual((await browser.request('GET', '/api/products')).data.code, 'PASSWORD_CHANGE_REQUIRED');
  await signInAsOwner(browser, { username: 'nightshift', password }, shop.tenant.slug);
  assert.strictEqual((await browser.request('GET', '/api/products')).status, 200);
  const entry = await env.db.controlModels.AuditLog.findOne({ tenantId: shop.tenant._id, action: 'tenant.user.reset', 'details.username': 'nightshift' }).lean();
  assert.deepStrictEqual([entry.actor, entry.details], ['shop:owner', { username: 'nightshift' }]);

  // A disabled account given a new password, by the owner or by the admin, stays disabled
  await ok(owner(), 'POST', `/api/staff/${worker.id}/disable`);
  const again = await ok(owner(), 'POST', `/api/staff/${worker.id}/password`);
  assert.strictEqual(again.staff.disabled, true);
  assert.strictEqual((await stranger().login('nightshift', again.password)).status, 401);
  await resetUserPassword(env.ctx, shop.tenant._id, worker.id, 'Admin-Gave-This-1', { actor: 'test' });
  assert.strictEqual((await stranger().login('nightshift', 'Admin-Gave-This-1')).status, 401);
  assert.strictEqual((await ok(owner(), 'GET', '/api/staff')).staff.find((s) => s.id === worker.id).disabled, true);
});

test(`at most ${STAFF_MAX} accounts in use, even two added at the same moment; a disabled one makes room`, async () => {
  const { User } = await models();
  const active = () => User.countDocuments({ role: 'staff', disabledAt: null });
  let n = 0;
  while ((await active()) < STAFF_MAX - 1) {
    await ok(owner(), 'POST', '/api/staff', { username: `filler${++n}`, displayName: `موظف ${n}` });
  }
  // One place left, asked for twice at once: one gets it
  const both = await Promise.all(['race-a', 'race-b'].map((username) => owner().request('POST', '/api/staff', { username, displayName: username })));
  assert.deepStrictEqual(both.map((r) => r.status).sort(), [201, 409]);
  assert.strictEqual(both.find((r) => r.status === 409).data.code, 'STAFF_LIMIT');
  assert.strictEqual(await active(), STAFF_MAX);
  const over = await owner().request('POST', '/api/staff', { username: 'one-more', displayName: 'واحد زيادة' });
  assert.deepStrictEqual([over.status, over.data.code], [409, 'STAFF_LIMIT']);
  assert.match(over.data.error, new RegExp(`${STAFF_MAX}`));

  // Disabling one makes room, and enabling it again is then refused
  const filler = await User.findOne({ usernameLower: 'filler1' }).lean();
  await ok(owner(), 'POST', `/api/staff/${filler._id}/disable`);
  await ok(owner(), 'POST', '/api/staff', { username: 'one-more', displayName: 'واحد زيادة' });
  const back = await owner().request('POST', `/api/staff/${filler._id}/enable`);
  assert.deepStrictEqual([back.status, back.data.code], [409, 'STAFF_LIMIT']);
  assert.strictEqual((await ok(owner(), 'GET', '/api/staff')).staff.length, (await User.countDocuments({ role: 'staff' })));
});
