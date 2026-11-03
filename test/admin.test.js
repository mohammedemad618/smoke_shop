// The admin panel (admin/, admin-public/): signing in with a password and an authenticator
// code, a code working once, five wrong codes ending the session, an admin without an
// authenticator refused, the step-up the riskiest actions need, CSRF, the strict policy and
// the panel never turning a shop's text into HTML, creating shops (one per request id, the
// first password made in the browser, the limits), suspending, resetting a password, the
// audit log, and no password in a copy of pos_control.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import { startTestEnv, BASE_DOMAIN, TEST_TOTP_KEY, signInAsOwner } from './support/harness.js';
import { ADMIN_PASSWORD, adminClient, makeAdmin, nextCode, signInAdmin, waitForJob } from './support/admin.js';
import { createTenant } from '../services/tenants.js';
import { unlockAdmins } from '../services/admins.js';
import { hashToken } from '../lib/sessions.js';
import { generatePassword, newRequestId } from '../admin-public/js/password.js';

const MAX = 14;
let env;
let boss;
before(async () => {
  env = await startTestEnv({ env: { MAX_TENANTS: String(MAX) } });
  boss = await makeAdmin(env, 'boss');
});
after(async () => {
  await env?.close();
});

const sessions = (filter = {}) => env.db.controlModels.Session.countDocuments({ kind: 'admin', ...filter });
const audit = (action, filter = {}) => env.db.controlModels.AuditLog.find({ action, ...filter }).sort({ at: 1, _id: 1 }).lean();

// A shop made from the API as the panel makes it: a browser-made password and a request id
async function createFromApi(client, slug, extra = {}) {
  const ownerPassword = generatePassword({ avoid: ['owner', slug] });
  const body = { requestId: newRequestId(), label: `تسمية ${slug}`, shopName: `متجر ${slug}`, slug, ownerUsername: 'owner', ownerPassword, timeZone: 'Asia/Baghdad', currency: 'د.ع', ...extra };
  const res = await client.api('POST', '/tenants', body);
  return { res, body, ownerPassword };
}

test('the admin host serves its page with an enforced strict policy, and its API needs a session', async () => {
  const client = adminClient(env);
  const page = await client.request('GET', '/');
  assert.strictEqual(page.status, 200);
  const csp = page.headers['content-security-policy'];
  assert.ok(csp, 'enforced, not report-only');
  for (const part of ["default-src 'none'", "script-src 'self'", "require-trusted-types-for 'script'", "trusted-types 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) assert.ok(csp.includes(part), part);
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'), csp);
  assert.strictEqual(page.headers['x-frame-options'], 'DENY');
  // The page has no inline script or style and no event attribute
  assert.doesNotMatch(page.text, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(page.text, /\son[a-z]+=|style=|<style/i);
  for (const file of ['/js/app.js', '/js/dom.js', '/admin.css', '/css/style.css']) assert.strictEqual((await client.request('GET', file)).status, 200, file);
  for (const route of ['/me', '/tenants', '/audit', '/overview']) {
    const res = await client.api('GET', route);
    assert.deepStrictEqual([res.status, res.data.code], [401, 'AUTH_EXPIRED'], route);
    assert.strictEqual(res.headers['cache-control'], 'no-store');
  }
  assert.strictEqual((await client.api('POST', '/tenants', {})).status, 401);
});

test('signing in: the password, then a code; the cookie is HttpOnly and SameSite=Strict, renewed at the code', async () => {
  const client = adminClient(env, '10.0.1.1');
  const login = await client.api('POST', '/auth/login', { username: 'BOSS', password: ADMIN_PASSWORD });
  assert.deepStrictEqual([login.status, login.data.stage, typeof login.data.csrf], [200, 'code', 'string']);
  const cookie = [login.headers['set-cookie']].flat()[0];
  assert.match(cookie, /^pos_admin=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  const firstCookie = client.cookie;
  // The password alone opens nothing but the code
  assert.strictEqual((await client.api('GET', '/me')).data.stage, 'code');
  assert.deepStrictEqual([(await client.api('GET', '/tenants')).status, (await client.api('GET', '/tenants')).data.code], [403, 'CODE_REQUIRED']);
  const wrong = await client.api('POST', '/auth/code', { code: '000000' });
  assert.deepStrictEqual([wrong.status, wrong.data.code], [401, 'CODE_FAILED']);
  const code = await nextCode(env, boss);
  const ok = await client.api('POST', '/auth/code', { code });
  assert.deepStrictEqual([ok.status, ok.data.stage, ok.data.admin.username], [200, 'full', 'boss']);
  assert.ok(ok.data.stepUpUntil, 'signing in counts as a step-up');
  assert.notStrictEqual(client.cookie, firstCookie, 'a new session id once fully signed in');
  assert.strictEqual((await client.api('GET', '/tenants')).status, 200);
  // The cookie of the password step opens nothing any more
  const old = adminClient(env, '10.0.1.1');
  old.useCookie(firstCookie);
  assert.strictEqual((await old.api('GET', '/me')).status, 401);

  // The same code again, at another sign-in: refused (a code works once)
  const replay = adminClient(env, '10.0.1.2');
  await replay.api('POST', '/auth/login', { username: 'boss', password: ADMIN_PASSWORD });
  const again = await replay.api('POST', '/auth/code', { code });
  assert.deepStrictEqual([again.status, again.data.code], [401, 'CODE_FAILED']);
  const logins = await audit('admin.login', { result: 'ok' });
  assert.ok(logins.some((e) => e.actor === 'admin:boss' && e.ip === '10.0.1.1' && e.details.method === 'totp'));
  // Signing out ends it
  assert.strictEqual((await client.api('POST', '/auth/logout')).status, 204);
  assert.strictEqual((await client.api('GET', '/me')).status, 401);
});

test('a wrong password and an unknown admin get the same answer, and no session', async () => {
  const client = adminClient(env, '10.0.2.1');
  const before = await sessions();
  for (const [username, password] of [['boss', 'Not the password at all'], ['nobody', ADMIN_PASSWORD]]) {
    const res = await client.api('POST', '/auth/login', { username, password });
    assert.deepStrictEqual([res.status, res.data.code, res.data.error], [401, 'LOGIN_FAILED', 'اسم المستخدم أو كلمة المرور غير صحيحة']);
  }
  for (const body of [{ username: { $ne: '' }, password: 'x' }, { username: 'boss', password: ['x'] }, {}]) {
    assert.strictEqual((await client.api('POST', '/auth/login', body)).status, 400, JSON.stringify(body));
  }
  assert.strictEqual(await sessions(), before);
  // From another site: refused before anything is checked
  const cross = await client.api('POST', '/auth/login', { username: 'boss', password: ADMIN_PASSWORD }, { origin: 'https://evil.example' });
  assert.deepStrictEqual([cross.status, cross.data.code], [403, 'CSRF_FAILED']);
});

test('five wrong codes end the session; the address is then locked until admin:unlock', async () => {
  const ip = '10.0.3.1';
  const client = adminClient(env, ip);
  await client.api('POST', '/auth/login', { username: 'boss', password: ADMIN_PASSWORD });
  for (let i = 1; i <= 4; i++) {
    const res = await client.api('POST', '/auth/code', { code: '123456' });
    assert.deepStrictEqual([res.status, res.data.code], [401, 'CODE_FAILED'], `try ${i}`);
  }
  const fifth = await client.api('POST', '/auth/code', { code: '654321' });
  assert.deepStrictEqual([fifth.status, fifth.data.code], [401, 'SESSION_ENDED']);
  // Even the right code is too late now: the session is gone
  const late = await client.api('POST', '/auth/code', { code: await nextCode(env, boss) });
  assert.deepStrictEqual([late.status, late.data.code], [401, 'AUTH_EXPIRED']);
  assert.strictEqual(await sessions({ stage: 'code', ip }), 0);
  assert.strictEqual((await audit('admin.session.ended')).length, 1);
  // The five failures locked this address for the admin's name, not another address
  const locked = await client.api('POST', '/auth/login', { username: 'boss', password: ADMIN_PASSWORD });
  assert.deepStrictEqual([locked.status, locked.data.code], [429, 'LOGIN_LOCKED']);
  assert.ok(Number(locked.headers['retry-after']) > 0);
  await signInAdmin(env, boss, '10.0.3.2');
  await unlockAdmins(env.ctx, { username: 'boss' }, { actor: 'test' });
  assert.strictEqual((await client.api('POST', '/auth/login', { username: 'boss', password: ADMIN_PASSWORD })).status, 200);
});

test('an admin whose authenticator was never enabled cannot sign in', async () => {
  await makeAdmin(env, 'halfdone', { enable: false });
  const client = adminClient(env, '10.0.4.1');
  const before = await sessions();
  const res = await client.api('POST', '/auth/login', { username: 'halfdone', password: ADMIN_PASSWORD });
  assert.deepStrictEqual([res.status, res.data.code], [403, 'TOTP_REQUIRED']);
  assert.strictEqual(await sessions(), before);
  assert.strictEqual(res.headers['set-cookie'], undefined);
});

test('the riskiest actions need a code given in the last 5 minutes, and wrong ones count', async () => {
  const shop = await env.createShop('stepup');
  const client = await signInAdmin(env, boss, '10.0.5.1');
  const { Session, Tenant } = env.db.controlModels;
  // Ten minutes after the last code
  await Session.updateMany({ kind: 'admin', stage: 'full' }, { $set: { stepUpAt: new Date(Date.now() - 10 * 60 * 1000) } });
  const id = String(shop.tenant._id);
  const refused = await client.api('POST', `/tenants/${id}/suspend`, { reason: 'x' });
  assert.deepStrictEqual([refused.status, refused.data.code], [403, 'STEP_UP_REQUIRED']);
  assert.strictEqual((await Tenant.findById(id).lean()).status, 'active');
  // Every route the plan lists asks for it
  for (const [method, url, body] of [
    ['POST', '/tenants', {}],
    ['POST', `/tenants/${id}/resume`],
    ['POST', `/tenants/${id}/delete`, { confirm: 'stepup' }],
    ['POST', `/tenants/${id}/restore`, { archive: 'x' }],
    ['POST', `/tenants/${id}/rename`, { slug: 'other-name' }],
    ['POST', `/tenants/${id}/users/${new mongoose.Types.ObjectId()}/password`, { password: 'x' }],
    ['POST', `/tenants/${id}/sessions/revoke`],
    ['GET', `/tenants/${id}/export/products`],
  ]) {
    const res = await client.api(method, url, body);
    assert.deepStrictEqual([res.status, res.data?.code], [403, 'STEP_UP_REQUIRED'], url);
  }
  // Settings, notes and a backup do not
  assert.strictEqual((await client.api('PUT', `/tenants/${id}`, { notes: 'ملاحظة' })).status, 200);

  const wrong = await client.api('POST', '/step-up', { code: '111111' });
  assert.deepStrictEqual([wrong.status, wrong.data.code], [401, 'CODE_FAILED']);
  const sid = hashToken(client.cookie.split('=')[1]);
  assert.strictEqual((await Session.findById(sid).lean()).codeFailures, 1, 'the same counter as at sign-in');
  const right = await client.api('POST', '/step-up', { code: await nextCode(env, boss) });
  assert.strictEqual(right.status, 200);
  assert.ok(new Date(right.data.stepUpUntil) > new Date(Date.now() + 4 * 60 * 1000));
  const suspended = await client.api('POST', `/tenants/${id}/suspend`, { reason: 'تجربة' });
  assert.deepStrictEqual([suspended.status, suspended.data.status], [200, 'suspended']);
  assert.strictEqual((await shop.client.request('GET', '/api/shop')).status, 423);
});

test('every admin write needs the session token and the panel\'s own origin', async () => {
  const shop = await env.createShop('csrf-shop');
  const client = await signInAdmin(env, boss, '10.0.6.1');
  const url = `/tenants/${shop.tenant._id}`;
  const noToken = await client.api('PUT', url, { notes: 'x' }, { 'x-csrf-token': undefined });
  assert.deepStrictEqual([noToken.status, noToken.data.code], [403, 'CSRF_FAILED']);
  const otherSite = await client.api('PUT', url, { notes: 'x' }, { origin: `http://csrf-shop.${BASE_DOMAIN}:${env.app.port}` });
  assert.deepStrictEqual([otherSite.status, otherSite.data.code], [403, 'CSRF_FAILED']);
  const crossSite = await client.api('PUT', url, { notes: 'x' }, { 'sec-fetch-site': 'cross-site' });
  assert.strictEqual(crossSite.status, 403);
  assert.strictEqual((await client.api('PUT', url, { notes: 'y' })).status, 200);
  // A shop's session means nothing on the admin host
  const borrowed = adminClient(env, '10.0.6.2');
  borrowed.useCookie(shop.client.cookie.replace('pos_sid', 'pos_admin'), shop.client.csrf);
  assert.strictEqual((await borrowed.api('GET', '/tenants')).status, 401);
});

test('creating a shop from the panel: one shop per request id, set up by its job, its owner signs in with the browser-made password and must change it', async () => {
  const client = await signInAdmin(env, boss, '10.0.7.1');
  const ownerPassword = generatePassword({ avoid: ['owner', 'panel-shop'] });
  assert.match(ownerPassword, /^[A-Za-z2-9]{12}$/);
  const body = { requestId: newRequestId(), label: 'من اللوحة', shopName: 'متجر اللوحة', slug: 'panel-shop', ownerUsername: 'owner', ownerPassword, timeZone: 'Asia/Baghdad', currency: 'د.ع', phone: '0770', firstInvoiceNumber: '100' };
  // The same submit twice at once (a double click, a retry)
  const [first, second] = await Promise.all([client.api('POST', '/tenants', body), client.api('POST', '/tenants', body)]);
  assert.ok([200, 202].includes(first.status) && [200, 202].includes(second.status), `${first.text} ${second.text}`);
  assert.strictEqual(first.data.tenant.id, second.data.tenant.id);
  assert.strictEqual(await env.db.controlModels.Tenant.countDocuments({ slug: 'panel-shop' }), 1);
  assert.ok(!JSON.stringify(first.data).includes(ownerPassword));
  const job = await waitForJob(env, client, first.data.job.id);
  assert.strictEqual(job.status, 'done');
  assert.deepStrictEqual(job.steps.map((s) => [s.key, s.status]), [
    ['host', 'done'], ['database', 'done'], ['indexes', 'done'], ['settings', 'done'], ['owner', 'done'], ['dns', 'skipped'], ['certificate', 'done'], ['activate', 'done'],
  ]);
  assert.deepStrictEqual([job.tenant.status, job.owner.username], ['active', 'owner']);
  // A third submit of the same request: the same shop, nothing new
  const third = await client.api('POST', '/tenants', body);
  assert.deepStrictEqual([third.status, third.data.tenant.id], [200, first.data.tenant.id]);

  const shop = env.client(`panel-shop.${BASE_DOMAIN}:${env.app.port}`);
  const login = await shop.login('owner', ownerPassword);
  assert.deepStrictEqual([login.status, login.data.mustChangePassword], [200, true]);
  assert.strictEqual((await shop.request('GET', '/api/products')).status, 403);
  const changed = await shop.request('POST', '/api/auth/password', { currentPassword: ownerPassword, newPassword: generatePassword({ length: 14 }) });
  assert.strictEqual(changed.status, 200);
  const general = (await shop.request('GET', '/api/categories')).data[0];
  assert.strictEqual(general.name, 'عام');
  const product = (await shop.request('POST', '/api/products', { name: 'شاي', barcode: 'T1', category: general._id, purchasePrice: 1000, salePrice: 1500 })).data;
  const sale = await shop.request('POST', '/api/sales', { items: [{ productId: product._id, quantity: 2 }] });
  assert.deepStrictEqual([sale.status, sale.data.number, sale.data.total], [201, 100, 3000]);
  assert.strictEqual((await shop.request('GET', '/api/shop')).data.phone, '0770');

  const list = await client.api('GET', '/tenants');
  const row = list.data.find((t) => t.slug === 'panel-shop');
  assert.deepStrictEqual([row.label, row.shopName, row.status, row.cert.status, row.host], ['من اللوحة', 'متجر اللوحة', 'active', 'issued', `panel-shop.${BASE_DOMAIN}`]);
  // The hourly figures
  await env.runner.measure();
  const measured = (await client.api('GET', '/tenants')).data.find((t) => t.slug === 'panel-shop');
  assert.strictEqual(measured.usage.salesCount, 1);
  assert.strictEqual(measured.usage.productsCount, 1);
  assert.ok(measured.usage.dataBytes > 0 && measured.lastActivityAt);
});

test('the address is checked while typed: available, taken, reserved, invalid', async () => {
  const client = await signInAdmin(env, boss, '10.0.8.1');
  const check = async (slug) => (await client.api('GET', `/slug-check?slug=${encodeURIComponent(slug)}`)).data;
  assert.deepStrictEqual(await check('fresh-name'), { slug: 'fresh-name', status: 'available', message: 'متاح', host: `fresh-name.${BASE_DOMAIN}` });
  assert.deepStrictEqual([(await check('panel-shop')).status, (await check('panel-shop')).message], ['taken', 'هذا العنوان مستخدم']);
  assert.deepStrictEqual([(await check('admin')).status, (await check('admin')).message], ['reserved', 'هذا العنوان محجوز']);
  for (const bad of ['ab', 'Bad_Name', 'shop-1-2-3-4', '-x-']) assert.strictEqual((await check(bad)).status, 'invalid', bad);
  assert.match((await check('ab')).message, /^غير صالح: أحرف إنجليزية صغيرة وأرقام وشرطة، يبدأ بحرف، من 3 إلى 30$/);
});

test('suspending from the panel: 423 on the shop and its sessions end; resuming opens it again', async () => {
  const shop = await env.createShop('pause-me');
  const client = await signInAdmin(env, boss, '10.0.9.1');
  const id = String(shop.tenant._id);
  assert.strictEqual((await shop.client.request('GET', '/api/products')).status, 200);
  assert.strictEqual(await env.db.controlModels.Session.countDocuments({ tenantId: shop.tenant._id }), 1);
  const res = await client.api('POST', `/tenants/${id}/suspend`, { reason: 'لم يُدفع الاشتراك' });
  assert.strictEqual(res.status, 200);
  const closed = await shop.client.request('GET', '/api/products');
  assert.deepStrictEqual([closed.status, closed.data.code], [423, 'TENANT_SUSPENDED']);
  assert.strictEqual(await env.db.controlModels.Session.countDocuments({ tenantId: shop.tenant._id }), 0);
  const entry = (await audit('tenant.status', { tenantId: shop.tenant._id })).at(-1);
  assert.deepStrictEqual([entry.actor, entry.ip, entry.details.to, entry.details.reason], ['admin:boss', '10.0.9.1', 'suspended', 'لم يُدفع الاشتراك']);
  // Twice is refused as stale, and resuming opens it, signed out
  assert.strictEqual((await client.api('POST', `/tenants/${id}/suspend`, {})).status, 409);
  assert.strictEqual((await client.api('POST', `/tenants/${id}/resume`)).status, 200);
  assert.strictEqual((await shop.client.request('GET', '/api/products')).status, 401);
  assert.strictEqual((await shop.client.login('owner', shop.owner.password)).status, 200);
});

test('the command line can suspend and resume a shop too (npm run tenant:suspend)', async () => {
  const shop = await env.createShop('cli-pause');
  const run = (args) =>
    promisify(execFile)(process.execPath, ['scripts/tenant-suspend.js', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, NODE_ENV: 'test', MONGODB_URI: env.config.mongodbUri, CONTROL_DB: env.config.controlDb, TENANT_DB_PREFIX: env.config.tenantDbPrefix, TENANT_BASE_DOMAINS: BASE_DOMAIN, ADMIN_HOST: env.config.adminHost },
    });
  const out = await run(['--slug', 'cli-pause', '--reason', 'من سطر الأوامر']);
  assert.match(out.stdout, /now suspended/);
  await env.registry.poll();
  assert.strictEqual((await shop.client.request('GET', '/api/products')).status, 423);
  await run(['--slug', 'cli-pause', '--resume']);
  await env.registry.poll();
  assert.strictEqual((await shop.client.request('GET', '/api/auth/shop')).status, 200);
  const entries = await audit('tenant.status', { tenantId: shop.tenant._id });
  assert.deepStrictEqual(entries.slice(-2).map((e) => [e.details.to, e.actor.startsWith('cli:')]), [['suspended', true], ['active', true]]);
});

test('a password reset from the panel: the old sessions end, the new password must be changed', async () => {
  const shop = await env.createShop('forgot');
  const client = await signInAdmin(env, boss, '10.0.10.1');
  const detail = (await client.api('GET', `/tenants/${shop.tenant._id}`)).data;
  const owner = detail.users[0];
  assert.deepStrictEqual([owner.username, owner.role, owner.mustChangePassword], ['owner', 'owner', false]);
  assert.ok(!('passwordHash' in owner));
  assert.strictEqual(detail.sessions.length, 1);
  const weak = await client.api('POST', `/tenants/${shop.tenant._id}/users/${owner.id}/password`, { password: 'owner12345678' });
  assert.strictEqual(weak.status, 400);
  const fresh = generatePassword({ avoid: ['owner', 'forgot'] });
  const res = await client.api('POST', `/tenants/${shop.tenant._id}/users/${owner.id}/password`, { password: fresh });
  assert.deepStrictEqual([res.status, res.data.mustChangePassword], [200, true]);
  assert.strictEqual((await shop.client.request('GET', '/api/products')).status, 401, 'the old session is dead');
  assert.strictEqual((await env.client(shop.host).login('owner', shop.owner.password)).status, 401, 'the old password is gone');
  const again = env.client(shop.host);
  const login = await again.login('owner', fresh);
  assert.deepStrictEqual([login.status, login.data.mustChangePassword], [200, true]);
  const entry = (await audit('tenant.owner.reset', { tenantId: shop.tenant._id })).at(-1);
  assert.deepStrictEqual([entry.actor, entry.details], ['admin:boss', { username: 'owner' }]);
  // Ending every session of a shop
  const revoked = await client.api('POST', `/tenants/${shop.tenant._id}/sessions/revoke`);
  assert.deepStrictEqual([revoked.status, revoked.data.ended], [200, 1]);
  assert.strictEqual((await again.request('GET', '/api/auth/me')).status, 401);
});

// A stand-in for the browser's document: enough for dom.js, and it remembers every element
// made, so a test can see that no <img> or <script> ever was
function fakeDocument() {
  const made = [];
  class Text {
    constructor(text) {
      this.nodeType = 3;
      this.text = text;
    }
    get textContent() {
      return this.text;
    }
  }
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.childNodes = [];
      this.attributes = {};
      this.dataset = {};
      made.push(this);
    }
    append(...nodes) {
      for (const node of nodes) this.childNodes.push(typeof node === 'string' ? new Text(node) : node);
    }
    replaceChildren(...nodes) {
      this.childNodes = [];
      this.append(...nodes);
    }
    set textContent(value) {
      this.childNodes = [new Text(String(value))];
    }
    get textContent() {
      return this.childNodes.map((n) => n.textContent).join('');
    }
    set innerHTML(value) {
      throw new Error(`innerHTML used with ${value}`);
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
    addEventListener() {}
  }
  return { made, document: { createElement: (tag) => new Element(tag), createTextNode: (text) => new Text(text) } };
}

const XSS = '<img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=2</script>';

test('a shop name, receipt note, display name or user agent holding HTML comes back as plain text and is shown as text', async () => {
  const shop = await env.createShop('xss-shop', { shopName: 'عادي' });
  const { db } = shop;
  await db.collection('settings').updateOne({ _id: 'shop' }, { $set: { shopName: XSS, receiptNote: XSS } });
  await db.collection('users').updateOne({}, { $set: { displayName: XSS } });
  await env.db.controlModels.Tenant.updateOne({ _id: shop.tenant._id }, { $set: { shopNameCache: XSS, label: XSS } });
  // A sign-in from a browser whose user agent is the payload
  const visitor = env.client(shop.host);
  assert.strictEqual((await visitor.login('owner', shop.owner.password, { 'user-agent': XSS })).status, 200);

  const client = await signInAdmin(env, boss, '10.0.11.1');
  const detail = await client.api('GET', `/tenants/${shop.tenant._id}`);
  assert.match(detail.headers['content-type'], /^application\/json/);
  assert.strictEqual(detail.data.settings.shopName, XSS);
  assert.strictEqual(detail.data.settings.receiptNote, XSS);
  assert.strictEqual(detail.data.users[0].displayName, XSS);
  assert.ok(detail.data.sessions.some((s) => s.ua === XSS));
  const row = (await client.api('GET', '/tenants')).data.find((t) => t.slug === 'xss-shop');
  assert.deepStrictEqual([row.shopName, row.label], [XSS, XSS]);

  // The panel's own code renders them: as text, never as elements
  const fake = fakeDocument();
  globalThis.document = fake.document;
  try {
    const { shopRow, userRow, sessionRow, auditRow, facts } = await import('../admin-public/js/views.js');
    const nodes = [
      shopRow(row),
      userRow(detail.data.users[0], { onReset: () => {} }),
      ...detail.data.sessions.map((s) => sessionRow(s)),
      facts([['اسم المتجر', detail.data.settings.shopName], ['ملاحظة الإيصال', detail.data.settings.receiptNote]]),
      auditRow({ at: new Date(), actor: 'admin:boss', action: 'tenant.update', tenantSlug: 'xss-shop', details: { label: XSS }, result: 'ok' }),
    ];
    const tags = new Set(fake.made.map((el) => el.tagName));
    for (const tag of ['IMG', 'SCRIPT', 'IFRAME', 'SVG', 'OBJECT']) assert.ok(!tags.has(tag), tag);
    const text = nodes.map((n) => n.textContent).join('\n');
    assert.ok(text.split(XSS).length - 1 >= 5, 'the payload is shown as its characters');
    assert.strictEqual(globalThis.pwned, undefined);
    const { h } = await import('../admin-public/js/dom.js');
    assert.throws(() => h('div', { innerHTML: XSS }), /not allowed/);
    assert.throws(() => h('a', { href: 'javascript:alert(1)' }), /unsafe link/);
  } finally {
    delete globalThis.document;
  }
});

test("the panel's code never writes HTML: no innerHTML, no inline handlers, no eval", async () => {
  const dir = new URL('../admin-public/js/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 5, files.join());
  for (const file of files) {
    const text = await readFile(new URL(file, dir), 'utf8');
    const code = text.replace(/^\s*\/\/.*$/gm, '');
    for (const sink of [/\.innerHTML\s*=/, /\.outerHTML\s*=/, /\.insertAdjacentHTML\(/, /document\.write/, /\beval\(/, /new Function\(/, /setAttribute\(\s*['"]on/, /\.on[a-z]+\s*=/]) {
      assert.doesNotMatch(code, sink, `${file}: ${sink}`);
    }
  }
  const html = await readFile(new URL('../admin-public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /\son[a-z]+=|style=|<script>/i);
});

test('settings and notes edited from the panel reach the shop; the audit log reads back 50 a page with filters', async () => {
  const shop = await env.createShop('edit-me');
  const client = await signInAdmin(env, boss, '10.0.12.1');
  const id = String(shop.tenant._id);
  const saved = await client.api('PUT', `/tenants/${id}/settings`, { shopName: 'الاسم الجديد', receiptNote: 'شكرًا', phone: '0780', currency: 'IQD' });
  assert.deepStrictEqual([saved.status, saved.data.shopName, saved.data.currency], [200, 'الاسم الجديد', 'IQD']);
  assert.strictEqual((await shop.client.request('GET', '/api/shop')).data.shopName, 'الاسم الجديد');
  assert.strictEqual((await client.api('GET', '/tenants')).data.find((t) => t.id === id).shopName, 'الاسم الجديد');
  assert.strictEqual((await client.api('PUT', `/tenants/${id}/settings`, { timeZone: 'Mars/Base' })).status, 400);
  const notes = await client.api('PUT', `/tenants/${id}`, { label: 'تسميتي', phone: '0790', notes: 'زبون قديم' });
  assert.deepStrictEqual(notes.data, { label: 'تسميتي', notes: 'زبون قديم', phone: '0790' });

  // 60 more entries for this shop, then pages of 50, newest first
  const { AuditLog } = env.db.controlModels;
  for (let i = 0; i < 60; i++) await AuditLog.record({ actor: 'test', action: 'tenant.update', tenantId: shop.tenant._id, tenantSlug: 'edit-me', details: { i } });
  const page1 = (await client.api('GET', `/audit?tenant=${id}`)).data;
  assert.deepStrictEqual([page1.entries.length, page1.page, page1.pages], [50, 1, 2]);
  assert.strictEqual(page1.entries[0].details.i, 59);
  const page2 = (await client.api('GET', `/audit?tenant=${id}&page=2`)).data;
  assert.strictEqual(page2.entries.length, page1.total - 50);
  const settingsOnly = (await client.api('GET', `/audit?tenant=${id}&action=tenant.settings`)).data;
  assert.deepStrictEqual(settingsOnly.entries.map((e) => [e.action, e.actor, e.details.fields.join()]), [['tenant.settings', 'admin:boss', 'shopName,receiptNote,currency,phone']]);
  assert.ok(page1.entries.every((e) => e.tenantId === id));
});

test('the panel exports a shop as CSV, with a fresh code', async () => {
  const shop = await env.createShop('export-panel');
  const client = await signInAdmin(env, boss, '10.0.13.1');
  const res = await client.request('GET', `/api/admin/tenants/${shop.tenant._id}/export/products`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/csv; charset=utf-8/);
  assert.match(res.headers['content-disposition'], /attachment; filename="products-export-panel-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.ok(res.text.startsWith('﻿"الاسم"'));
  assert.strictEqual((await audit('tenant.export', { tenantId: shop.tenant._id })).length, 1);
});

test('deleting from the panel in development: a verified backup, 30 days closed, then the purge drops the database (lib/db.js dropTenantDb)', async () => {
  const shop = await env.createShop('local-purge');
  const client = await signInAdmin(env, boss, '10.0.14.1');
  const id = String(shop.tenant._id);
  assert.strictEqual((await client.api('POST', `/tenants/${id}/delete`, { confirm: 'wrong' })).status, 400);
  const asked = await client.api('POST', `/tenants/${id}/delete`, { confirm: 'local-purge' });
  assert.strictEqual(asked.status, 202);
  const job = await waitForJob(env, client, asked.data.job.id);
  assert.strictEqual(job.status, 'done', JSON.stringify(job.steps));
  const { Tenant } = env.db.controlModels;
  let tenant = await Tenant.findById(id).lean();
  assert.strictEqual(tenant.status, 'pending_deletion');
  assert.ok(tenant.deletion.purgeAfter - Date.now() > 29 * 864e5);
  assert.match(tenant.deletion.backupFile, /pre-delete\.archive\.gz$/);
  assert.strictEqual((await shop.client.request('GET', '/api/shop')).status, 423);
  // The 30 days are over
  await Tenant.updateOne({ _id: id }, { $set: { 'deletion.purgeAfter': new Date(Date.now() - 1000) } });
  await env.runner.maintain();
  await env.runner.drain();
  tenant = await Tenant.findById(id).lean();
  assert.strictEqual(tenant.status, 'deleted');
  const names = (await env.db.base.db.admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
  assert.ok(!names.includes(tenant.dbName), 'the database is dropped');
  assert.ok(!env.db.base.otherDbs.some((d) => d.name === tenant.dbName), 'and forgotten');
  assert.strictEqual((await env.db.controlModels.Host.findById(`local-purge.${BASE_DOMAIN}`).lean()).kind, 'retired');
  const gone = await shop.client.request('GET', '/api/shop');
  assert.deepStrictEqual([gone.status, gone.data.code], [410, 'TENANT_DELETED']);
});

test('no password, code or authenticator secret in plain text anywhere in pos_control', async () => {
  const fresh = await makeAdmin(env, 'dumpcheck');
  const client = await signInAdmin(env, boss, '10.0.16.1');
  const { body, ownerPassword } = await createFromApi(client, 'dump-shop');
  assert.ok(ownerPassword && body.slug);
  await env.runner.drain();
  const secrets = [ADMIN_PASSWORD, ownerPassword, fresh.secret.toString('hex'), fresh.secret.toString('base64'), ...fresh.recoveryCodes, ...fresh.recoveryCodes.map((c) => c.replace('-', '')), TEST_TOTP_KEY];
  const { EJSON } = mongoose.mongo.BSON;
  const control = env.db.base.getClient().db(env.config.controlDb);
  let dump = '';
  for (const { name } of await control.listCollections().toArray()) dump += EJSON.stringify(await control.collection(name).find().toArray());
  assert.ok(dump.length > 1000);
  for (const secret of secrets) assert.ok(!dump.includes(secret), `found ${secret.slice(0, 4)}…`);
  const { base32Encode } = await import('../lib/totp.js');
  assert.ok(!dump.includes(base32Encode(fresh.secret)));
  // The job that made the shop no longer holds even the hash of the first password
  const tenant = await env.db.controlModels.Tenant.findOne({ slug: 'dump-shop' }).lean();
  const job = await env.db.controlModels.Job.findOne({ tenantId: tenant._id, type: 'provision' }).lean();
  assert.strictEqual(job.params.owner.passwordHash, undefined);
  // Signing the owner in still works with what only the browser had
  const shop = env.client(`dump-shop.${BASE_DOMAIN}:${env.app.port}`);
  await signInAsOwner(shop, { username: 'owner', password: ownerPassword }, 'dump-shop');
});

test('MAX_TENANTS and MAX_NEW_TENANTS_PER_DAY are enforced on the server', async () => {
  const client = await signInAdmin(env, boss, '10.0.15.1');
  const { Tenant } = env.db.controlModels;
  const live = await Tenant.countDocuments({ status: { $ne: 'deleted' } });
  for (let i = live; i < MAX; i++) await env.createShop(`fill-${i}`, { signIn: false });
  const { res } = await createFromApi(client, 'one-more');
  assert.deepStrictEqual([res.status, res.data.code, res.data.error], [409, 'MAX_TENANTS', `وصل عدد المتاجر إلى الحد الأقصى (${MAX})`]);
  assert.strictEqual(await Tenant.countDocuments({ slug: 'one-more' }), 0);
  // The day's limit counts every shop made in the last 24 hours, deleted ones included
  const made = await Tenant.countDocuments({ createdAt: { $gt: new Date(Date.now() - 864e5) } });
  const ctx = { ...env.ctx, config: { ...env.config, maxTenants: 1000, maxNewTenantsPerDay: made } };
  await assert.rejects(createTenant(ctx, { slug: 'day-limit', shopName: 'x', owner: { username: 'owner', password: generatePassword() } }), (err) => err.status === 409 && err.code === 'MAX_NEW_TENANTS');
  assert.strictEqual(await Tenant.countDocuments({ slug: 'day-limit' }), 0);
});
