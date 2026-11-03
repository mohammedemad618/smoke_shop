// A shop's lifecycle with the root worker's spool (SPOOL_DIR), the worker itself played by a
// stand-in that answers the files as ops/sbin/pos-root-worker.mjs would (test/support/
// admin.js): provisioning waits for the certificate, a failed certificate is retried, a
// backup on demand, a deletion with its 30 days and the purge, a rename with its redirects,
// and a restore that switches databases and keeps the accounts as they are now.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { startTestEnv, BASE_DOMAIN, DB_PREFIX, signInAsOwner } from './support/harness.js';
import { fakeRootWorker, makeAdmin, signInAdmin, waitForJob } from './support/admin.js';
import { createTenant, resumeTenant, transition } from '../services/tenants.js';
import { generatePassword } from '../lib/passwords.js';

const ROOT = path.join(os.tmpdir(), `${DB_PREFIX}spool`);
const SPOOL = path.join(ROOT, 'spool');
const BACKUPS = path.join(ROOT, 'backups');

let env;
let boss;
let worker;
let admin;
before(async () => {
  for (const dir of ['desired', 'retire', 'requests', 'state']) await fs.mkdir(path.join(SPOOL, dir), { recursive: true });
  env = await startTestEnv({ env: { SPOOL_DIR: SPOOL, POS_BACKUP_DIR: BACKUPS } });
  worker = fakeRootWorker(env, { spoolDir: SPOOL, backupDir: BACKUPS });
  boss = await makeAdmin(env, 'boss');
  admin = await signInAdmin(env, boss, '10.1.0.1');
});
after(async () => {
  await env?.close();
  await fs.rm(ROOT, { recursive: true, force: true });
});

const tick = () => worker.tick();
const control = () => env.db.controlModels;
const databaseNames = async () => (await env.db.base.db.admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
const exists = (file) => fs.stat(file).then(() => true, () => false);

// A shop made as the command line makes it (inline): with a spool, it waits for the worker
async function provisioned(slug) {
  const owner = { username: 'owner', password: generatePassword({ username: 'owner', slug }) };
  const made = await createTenant(env.ctx, { slug, shopName: `متجر ${slug}`, owner }, { actor: 'test' });
  assert.strictEqual(made.pending, true, 'waits for the certificate');
  const job = await waitForJob(env, admin, String(made.job._id), { tick });
  assert.strictEqual(job.status, 'done', JSON.stringify(job.steps));
  const client = env.client(`${slug}.${BASE_DOMAIN}:${env.app.port}`);
  owner.password = await signInAsOwner(client, owner, slug);
  return { tenant: await control().Tenant.findById(made.tenant._id).lean(), client, owner, host: `${slug}.${BASE_DOMAIN}` };
}

test('provisioning asks the worker for the certificate and waits until it is issued', async () => {
  const owner = { username: 'owner', password: generatePassword({ username: 'owner', slug: 'spool-shop' }) };
  const made = await createTenant(env.ctx, { slug: 'spool-shop', shopName: 'متجر', owner }, { actor: 'test' });
  assert.deepStrictEqual([made.pending, made.tenant.status], [true, 'provisioning']);
  const host = `spool-shop.${BASE_DOMAIN}`;
  assert.ok(await exists(path.join(SPOOL, 'desired', host)), 'desired/<host> written');
  assert.strictEqual((await fs.stat(path.join(SPOOL, 'desired', host))).size, 0);
  let job = (await admin.api('GET', `/jobs/${made.job._id}`)).data;
  const cert = job.steps.find((s) => s.key === 'certificate');
  assert.deepStrictEqual([job.status, cert.status, cert.note], ['running', 'pending', 'بانتظار عامل الشهادات']);
  assert.strictEqual(job.steps.find((s) => s.key === 'owner').status, 'done', 'the account is made before the wait');
  assert.strictEqual((await env.client(host).request('GET', '/api/auth/shop')).status, 503);

  job = await waitForJob(env, admin, String(made.job._id), { tick });
  assert.strictEqual(job.status, 'done');
  const hostDoc = await control().Host.findById(host).lean();
  assert.strictEqual(hostDoc.cert.status, 'issued');
  assert.ok(hostDoc.cert.expiresAt > new Date());
  assert.strictEqual((await control().Tenant.findById(made.tenant._id).lean()).status, 'active');
  assert.strictEqual((await env.client(host).request('GET', '/api/auth/shop')).status, 200);
});

test('a certificate the worker could not issue fails the step; «إعادة المحاولة» asks again', async () => {
  const host = `cert-fail.${BASE_DOMAIN}`;
  worker.failHosts.add(host);
  const owner = { username: 'owner', password: generatePassword({ username: 'owner', slug: 'cert-fail' }) };
  const made = await createTenant(env.ctx, { slug: 'cert-fail', shopName: 'متجر', owner }, { actor: 'test' });
  let job = await waitForJob(env, admin, String(made.job._id), { tick });
  assert.strictEqual(job.status, 'failed');
  const step = job.steps.find((s) => s.key === 'certificate');
  assert.deepStrictEqual([step.status, step.error], ['failed', 'تعذّر إصدار شهادة الأمان: DNS problem: NXDOMAIN looking up A']);
  assert.strictEqual((await control().Host.findById(host).lean()).cert.status, 'failed');
  const failed = await control().AuditLog.findOne({ tenantId: made.tenant._id, action: 'tenant.create', result: 'failed' }).lean();
  assert.strictEqual(failed.details.step, 'certificate');

  const before = (await fs.stat(path.join(SPOOL, 'desired', host))).mtimeMs;
  await sleep(20);
  const retried = await admin.api('POST', `/jobs/${made.job._id}/retry`);
  assert.strictEqual(retried.status, 200);
  job = await waitForJob(env, admin, String(made.job._id), { tick });
  assert.strictEqual(job.status, 'done');
  assert.ok((await fs.stat(path.join(SPOOL, 'desired', host))).mtimeMs > before, 'desired/<host> touched again');
  assert.strictEqual((await control().Tenant.findById(made.tenant._id).lean()).status, 'active');
  assert.strictEqual((await admin.api('POST', `/jobs/${made.job._id}/retry`)).status, 409, 'only a failed job is retried');
});

test('«نسخة الآن»: a request in requests/, the verified archive in the shop\'s list', async () => {
  const shop = await provisioned('backup-me');
  const asked = await admin.api('POST', `/tenants/${shop.tenant._id}/backups`);
  assert.strictEqual(asked.status, 202);
  await env.runner.drain();
  // While the worker has not run, the request waits in the spool, written whole
  const pending = (await fs.readdir(path.join(SPOOL, 'requests'))).filter((f) => f.endsWith('.json'));
  assert.strictEqual(pending.length, 1);
  assert.match(pending[0], /^[0-9a-f]{24}\.json$/);
  const request = JSON.parse(await fs.readFile(path.join(SPOOL, 'requests', pending[0]), 'utf8'));
  assert.deepStrictEqual(request, { type: 'backup', tenantId: String(shop.tenant._id), dbName: shop.tenant.dbName, reason: 'manual' });
  // A second job on the same shop meanwhile: refused
  assert.deepStrictEqual((await admin.api('POST', `/tenants/${shop.tenant._id}/backups`)).data.code, 'JOB_ACTIVE');
  const job = await waitForJob(env, admin, asked.data.job.id, { tick });
  assert.strictEqual(job.status, 'done');
  const detail = (await admin.api('GET', `/tenants/${shop.tenant._id}`)).data;
  assert.strictEqual(detail.backups.length, 1);
  assert.deepStrictEqual([detail.backups[0].kind, detail.backups[0].current], ['manual', true]);
  assert.match(detail.backups[0].path, /manual\.archive\.gz$/);
  assert.ok(detail.backups[0].path.startsWith(path.join(BACKUPS, shop.tenant.dbName)));
  assert.strictEqual((await control().AuditLog.findOne({ action: 'tenant.backup', tenantId: shop.tenant._id }).lean()).details.archive, path.basename(detail.backups[0].path));
});

test('deleting: a verified backup, 30 days closed (cancellable), then the purge: database dropped by the worker, addresses retired, 410', async () => {
  const shop = await provisioned('delete-me');
  const id = String(shop.tenant._id);
  const asked = await admin.api('POST', `/tenants/${id}/delete`, { confirm: 'delete-me' });
  assert.strictEqual(asked.status, 202);
  let job = await waitForJob(env, admin, asked.data.job.id, { tick });
  assert.strictEqual(job.status, 'done');
  let tenant = await control().Tenant.findById(id).lean();
  assert.strictEqual(tenant.status, 'pending_deletion');
  assert.ok(Math.abs(tenant.deletion.purgeAfter - Date.now() - 30 * 864e5) < 60000);
  assert.match(tenant.deletion.backupFile, /pre-delete\.archive\.gz$/);
  const closed = await shop.client.request('GET', '/api/products');
  assert.deepStrictEqual([closed.status, closed.data.code], [423, 'TENANT_SUSPENDED']);
  assert.strictEqual(await control().Session.countDocuments({ tenantId: tenant._id }), 0);

  // Changing one's mind within the 30 days: back to suspended, then deleted again
  assert.strictEqual((await admin.api('POST', `/tenants/${id}/cancel-deletion`)).data.status, 'suspended');
  assert.strictEqual((await control().Tenant.findById(id).lean()).deletion, undefined);
  job = await waitForJob(env, admin, (await admin.api('POST', `/tenants/${id}/delete`, { confirm: 'delete-me' })).data.job.id, { tick });
  assert.strictEqual(job.status, 'done');

  // Not before the 30 days
  await env.runner.maintain();
  assert.strictEqual(await control().Job.countDocuments({ tenantId: tenant._id, type: 'purge' }), 0);
  await control().Tenant.updateOne({ _id: id }, { $set: { 'deletion.purgeAfter': new Date(Date.now() - 1000) } });
  await env.runner.maintain();
  const purge = await control().Job.findOne({ tenantId: tenant._id, type: 'purge' }).lean();
  assert.ok(purge, 'the purge is queued');
  assert.strictEqual((await admin.api('POST', `/tenants/${id}/cancel-deletion`)).status, 409, 'too late to cancel');
  job = await waitForJob(env, admin, String(purge._id), { tick });
  assert.strictEqual(job.status, 'done', JSON.stringify(job.steps));
  assert.deepStrictEqual(job.steps.map((s) => s.key), ['backup', 'drop', 'retire', 'deleted']);

  tenant = await control().Tenant.findById(id).lean();
  assert.strictEqual(tenant.status, 'deleted');
  assert.ok(!(await databaseNames()).includes(tenant.dbName), 'dropped');
  const hostDoc = await control().Host.findById(shop.host).lean();
  assert.deepStrictEqual([hostDoc.kind, hostDoc.cert.status], ['retired', 'retired']);
  // retire/<host> was written for the worker, which removes the certificate
  assert.ok(await exists(path.join(SPOOL, 'retire', shop.host)));
  await worker.tick();
  const certState = JSON.parse(await fs.readFile(path.join(SPOOL, 'state', 'certs', `${shop.host}.json`), 'utf8'));
  assert.strictEqual(certState.status, 'retired');
  const gone = await shop.client.request('GET', '/api/products');
  assert.deepStrictEqual([gone.status, gone.data.code], [410, 'TENANT_DELETED']);
  // Both verified archives stay: the one before the wait and the last one
  const kinds = (await fs.readdir(path.join(BACKUPS, tenant.dbName))).filter((f) => f.endsWith('.archive.gz')).map((f) => f.split('-').at(-1)).sort();
  assert.ok(kinds.some((k) => k.startsWith('purge')) && kinds.some((k) => k.startsWith('delete')), kinds.join());
  // The address is never given again
  assert.strictEqual((await admin.api('GET', '/slug-check?slug=delete-me')).data.status, 'taken');
  assert.ok(await control().AuditLog.exists({ action: 'tenant.purge', tenantId: tenant._id }));
});

test('renaming: the new address with its certificate becomes the primary; the old one redirects (301, 410 TENANT_MOVED) and is retired after 90 days', async () => {
  const shop = await provisioned('old-name');
  const id = String(shop.tenant._id);
  const newHost = `new-name.${BASE_DOMAIN}`;
  assert.strictEqual((await admin.api('POST', `/tenants/${id}/rename`, { slug: 'old-name' })).status, 400);
  assert.strictEqual((await admin.api('POST', `/tenants/${id}/rename`, { slug: 'backup-me' })).status, 409);
  const asked = await admin.api('POST', `/tenants/${id}/rename`, { slug: 'new-name' });
  assert.strictEqual(asked.status, 202);
  // Taken at once, answering nothing until it is the primary
  assert.strictEqual((await control().Host.findById(newHost).lean()).kind, 'reserved');
  assert.strictEqual((await admin.api('GET', '/slug-check?slug=new-name')).data.status, 'taken');
  assert.strictEqual((await env.client(newHost).request('GET', '/api/auth/shop')).status, 404);
  assert.ok(await exists(path.join(SPOOL, 'desired', newHost)));
  const job = await waitForJob(env, admin, asked.data.job.id, { tick });
  assert.strictEqual(job.status, 'done', JSON.stringify(job.steps));

  const tenant = await control().Tenant.findById(id).lean();
  assert.strictEqual(tenant.slug, 'new-name');
  assert.strictEqual(tenant.dbName, shop.tenant.dbName, 'the data stays where it was');
  const old = await control().Host.findById(shop.host).lean();
  assert.strictEqual(old.kind, 'redirect');
  assert.ok(Math.abs(old.redirectUntil - Date.now() - 90 * 864e5) < 60000);
  // A page on the old address goes to the same page on the new one
  const page = await env.client(shop.host).request('GET', '/sales.html?day=2026-11-03');
  assert.deepStrictEqual([page.status, page.headers.location], [301, `http://${newHost}:3000/sales.html?day=2026-11-03`]);
  // The API says where, so a page left open shows it in its banner and keeps its cart
  const api = await shop.client.request('POST', '/api/sales', { items: [] });
  assert.deepStrictEqual([api.status, api.data.code, api.data.url], [410, 'TENANT_MOVED', `http://${newHost}:3000`]);
  assert.match(api.data.error, /تم نقل المتجر إلى عنوان جديد/);
  // On the new address everyone signs in again (cookies belonged to the old one)
  const fresh = env.client(`${newHost}:${env.app.port}`);
  assert.strictEqual((await fresh.request('GET', '/api/products')).status, 401);
  assert.strictEqual((await fresh.login('owner', shop.owner.password)).status, 200);
  assert.strictEqual((await fresh.request('GET', '/api/products')).status, 200);
  assert.strictEqual(await control().Session.countDocuments({ tenantId: tenant._id }), 1);
  const list = (await admin.api('GET', '/tenants')).data.find((t) => t.id === id);
  assert.deepStrictEqual([list.slug, list.host, list.cert.status], ['new-name', newHost, 'issued']);

  // 90 days later the old address is retired, and its certificate goes
  await control().Host.updateOne({ _id: shop.host }, { $set: { redirectUntil: new Date(Date.now() - 1000) } });
  await env.runner.maintain();
  assert.strictEqual((await control().Host.findById(shop.host).lean()).kind, 'retired');
  assert.ok(await exists(path.join(SPOOL, 'retire', shop.host)), 'retire/<old host> written');
  assert.strictEqual((await env.client(shop.host).request('GET', '/api/auth/shop')).status, 410);
  assert.strictEqual((await env.client(`${newHost}`).request('GET', '/api/auth/shop')).status, 200);
});

test('restoring: into a new database, the current accounts kept, sessions ended; the old database kept 7 days then dropped', async () => {
  const shop = await provisioned('restore-me');
  const id = String(shop.tenant._id);
  const general = (await shop.client.request('GET', '/api/categories')).data[0];
  const add = (name, barcode) => shop.client.request('POST', '/api/products', { name, barcode, category: general._id, purchasePrice: 100, salePrice: 150 });
  assert.strictEqual((await add('قبل النسخة', 'A1')).status, 201);
  const backup = await admin.api('POST', `/tenants/${id}/backups`);
  await waitForJob(env, admin, backup.data.job.id, { tick });
  const archive = (await admin.api('GET', `/tenants/${id}`)).data.backups[0];

  // After the backup: another product, and the owner's password changed
  assert.strictEqual((await add('بعد النسخة', 'B2')).status, 201);
  const newPassword = generatePassword({ username: 'owner', slug: 'restore-me' });
  assert.strictEqual((await shop.client.request('POST', '/api/auth/password', { currentPassword: shop.owner.password, newPassword })).status, 200);

  assert.strictEqual((await admin.api('POST', `/tenants/${id}/restore`, { archive: '/etc/passwd' })).status, 400);
  const asked = await admin.api('POST', `/tenants/${id}/restore`, { archive: archive.path });
  assert.strictEqual(asked.status, 202);
  const job = await waitForJob(env, admin, asked.data.job.id, { tick });
  assert.strictEqual(job.status, 'done', JSON.stringify(job.steps));
  assert.deepStrictEqual(job.steps.map((s) => [s.key, s.status]), [['suspend', 'done'], ['backup', 'done'], ['restore', 'done'], ['users', 'done'], ['switch', 'done'], ['resume', 'done']]);

  const tenant = await control().Tenant.findById(id).lean();
  assert.notStrictEqual(tenant.dbName, shop.tenant.dbName, 'a new database');
  assert.strictEqual(tenant.status, 'active', 'resumed');
  assert.deepStrictEqual(tenant.previousDbNames.map((p) => p.name), [shop.tenant.dbName]);
  assert.match(tenant.previousDbNames[0].archive, /pre-restore\.archive\.gz$/);
  assert.ok((await databaseNames()).includes(shop.tenant.dbName), 'the old database is kept');
  // Every session ended; the password is today's, not the one in the backup
  assert.strictEqual((await shop.client.request('GET', '/api/products')).status, 401);
  const client = env.client(`restore-me.${BASE_DOMAIN}:${env.app.port}`);
  assert.strictEqual((await client.login('owner', shop.owner.password)).status, 401, 'the old password does not come back');
  assert.strictEqual((await client.login('owner', newPassword)).status, 200);
  const names = (await client.request('GET', '/api/products')).data.map((p) => p.name);
  assert.deepStrictEqual(names, ['قبل النسخة'], 'the data is the backup\'s');
  const entry = await control().AuditLog.findOne({ action: 'tenant.restore', tenantId: tenant._id }).lean();
  assert.deepStrictEqual([entry.details.previousDb, entry.details.dbName], [shop.tenant.dbName, tenant.dbName]);

  // Seven days later the old database is dropped, by the worker, with its verified backup
  await control().Tenant.updateOne({ _id: id }, { $set: { 'previousDbNames.0.dropAfter': new Date(Date.now() - 1000) } });
  await env.runner.maintain();
  const cleanup = await control().Job.findOne({ tenantId: tenant._id, type: 'cleanup' }).lean();
  assert.ok(cleanup);
  assert.strictEqual((await waitForJob(env, admin, String(cleanup._id), { tick })).status, 'done');
  assert.ok(!(await databaseNames()).includes(shop.tenant.dbName));
  assert.deepStrictEqual((await control().Tenant.findById(id).lean()).previousDbNames, []);
  assert.strictEqual((await client.request('GET', '/api/products')).status, 200);
});

test('a shop whose setup keeps failing can be given up: its address retired for ever, its database purged at once', async () => {
  const host = `give-up.${BASE_DOMAIN}`;
  worker.failHosts.add(host);
  const owner = { username: 'owner', password: generatePassword({ username: 'owner', slug: 'give-up' }) };
  const made = await createTenant(env.ctx, { slug: 'give-up', shopName: 'متجر', owner }, { actor: 'test' });
  let job = await waitForJob(env, admin, String(made.job._id), { tick });
  assert.deepStrictEqual([job.status, job.cancellable], ['failed', true]);
  const live = () => control().Tenant.countDocuments({ status: { $ne: 'deleted' } });
  const before = await live();

  const cancelled = await admin.api('POST', `/jobs/${made.job._id}/cancel`);
  assert.deepStrictEqual([cancelled.status, cancelled.data.status, cancelled.data.active], [200, 'cancelled', false]);
  let tenant = await control().Tenant.findById(made.tenant._id).lean();
  assert.deepStrictEqual([tenant.status, tenant.deletion.setupCancelled], ['pending_deletion', true]);
  const hostDoc = await control().Host.findById(host).lean();
  assert.deepStrictEqual([hostDoc.kind, hostDoc.cert.status], ['retired', 'retired']);
  assert.ok(await exists(path.join(SPOOL, 'retire', host)), 'retire/<host> written for the worker');
  const back = await admin.api('POST', `/tenants/${made.tenant._id}/cancel-deletion`);
  assert.strictEqual(back.status, 409, 'never back as a shop half set up');

  // The next upkeep purges it: a verified backup, then the worker's drop
  await env.runner.maintain();
  const purge = await control().Job.findOne({ tenantId: made.tenant._id, type: 'purge' }).lean();
  job = await waitForJob(env, admin, String(purge._id), { tick });
  assert.strictEqual(job.status, 'done', JSON.stringify(job.steps));
  tenant = await control().Tenant.findById(made.tenant._id).lean();
  assert.strictEqual(tenant.status, 'deleted');
  assert.ok(!(await databaseNames()).includes(tenant.dbName), 'dropped');
  assert.strictEqual(await live(), before - 1, 'no longer counted against MAX_TENANTS');
  assert.strictEqual((await admin.api('GET', '/slug-check?slug=give-up')).data.status, 'taken');
});

test('a new-shop request sent again with a password made again: the panel learns the account kept the first one', async () => {
  const first = generatePassword({ username: 'owner', slug: 'sent-twice' });
  const again = generatePassword({ username: 'owner', slug: 'sent-twice' });
  const body = (ownerPassword) => ({ requestId: 'sent-twice-request-1', label: 'مكرر', shopName: 'مكرر', slug: 'sent-twice', ownerUsername: 'owner', ownerPassword, timeZone: 'Asia/Baghdad', currency: 'د.ع' });
  const one = await admin.api('POST', '/tenants', body(first));
  assert.deepStrictEqual([one.status, one.data.passwordSet], [202, true]);
  // Its account made, waiting for the certificate; the answer was lost and the form sent again
  await env.runner.drain();
  const two = await admin.api('POST', '/tenants', body(again));
  assert.deepStrictEqual([two.status, two.data.tenant.id, two.data.passwordSet], [202, one.data.tenant.id, false]);
  assert.strictEqual((await admin.api('POST', '/tenants', body(first))).data.passwordSet, true, 'the same password again is the right one');
  assert.strictEqual((await control().Job.findById(one.data.job.id).lean()).params.owner.passwordHash, undefined, 'no unused hash kept');
  assert.strictEqual((await waitForJob(env, admin, one.data.job.id, { tick })).status, 'done');
  const shop = env.client(`sent-twice.${BASE_DOMAIN}:${env.app.port}`);
  assert.strictEqual((await shop.login('owner', again)).status, 401);
  assert.strictEqual((await shop.login('owner', first)).status, 200);
});

test('an address retired while the worker\'s folder cannot be written is retired later, not left with its certificate', async () => {
  const { _id: tenantId } = await control().Tenant.findOne({ status: 'active' }).lean();
  const name = `long-gone.${BASE_DOMAIN}`;
  await control().Host.create({ _id: name, tenantId, kind: 'redirect', redirectUntil: new Date(Date.now() - 1000), rev: await control().Counter.next('rev') });
  const retireDir = path.join(SPOOL, 'retire');
  await fs.rm(retireDir, { recursive: true, force: true });
  // A file where the folder was: nothing can be written into it
  await fs.writeFile(retireDir, '');
  try {
    await env.runner.maintain();
    assert.strictEqual((await control().Host.findById(name).lean()).kind, 'redirect', 'left as it was, to be asked again');
  } finally {
    await fs.rm(retireDir, { force: true });
    await fs.mkdir(retireDir, { recursive: true });
  }
  await env.runner.maintain();
  const hostDoc = await control().Host.findById(name).lean();
  assert.deepStrictEqual([hostDoc.kind, hostDoc.cert.status], ['retired', 'retired']);
  assert.ok(await exists(path.join(retireDir, name)));
});

test('a shop purged within 7 days of a restore still has the database the restore replaced dropped', async () => {
  const shop = await provisioned('restore-purge');
  const id = String(shop.tenant._id);
  const backup = await admin.api('POST', `/tenants/${id}/backups`);
  await waitForJob(env, admin, backup.data.job.id, { tick });
  const archive = (await admin.api('GET', `/tenants/${id}`)).data.backups[0];
  const restored = await admin.api('POST', `/tenants/${id}/restore`, { archive: archive.path });
  assert.strictEqual((await waitForJob(env, admin, restored.data.job.id, { tick })).status, 'done');
  const deleted = await admin.api('POST', `/tenants/${id}/delete`, { confirm: 'restore-purge' });
  assert.strictEqual((await waitForJob(env, admin, deleted.data.job.id, { tick })).status, 'done');
  // npm run tenant:purge -- --confirm: due at once
  await control().Tenant.updateOne({ _id: id }, { $set: { 'deletion.purgeAfter': new Date(Date.now() - 1000) } });
  await env.runner.maintain();
  const purge = await control().Job.findOne({ tenantId: id, type: 'purge' }).lean();
  assert.strictEqual((await waitForJob(env, admin, String(purge._id), { tick })).status, 'done');
  const tenant = await control().Tenant.findById(id).lean();
  assert.strictEqual(tenant.status, 'deleted');
  assert.deepStrictEqual(tenant.previousDbNames.map((p) => p.name), [shop.tenant.dbName]);
  assert.ok((await databaseNames()).includes(shop.tenant.dbName), 'kept its 7 days');

  await control().Tenant.updateOne({ _id: id }, { $set: { 'previousDbNames.0.dropAfter': new Date(Date.now() - 1000) } });
  await env.runner.maintain();
  const cleanup = await control().Job.findOne({ tenantId: id, type: 'cleanup' }).lean();
  assert.ok(cleanup, 'queued for a deleted shop too');
  assert.strictEqual((await waitForJob(env, admin, String(cleanup._id), { tick })).status, 'done');
  assert.ok(!(await databaseNames()).includes(shop.tenant.dbName));
  assert.deepStrictEqual((await control().Tenant.findById(id).lean()).previousDbNames, []);
});

test('a restore keeps the shop closed: resuming waits for it, and a shop opened all the same is not switched', async () => {
  const shop = await provisioned('reopened');
  const id = String(shop.tenant._id);
  const backup = await admin.api('POST', `/tenants/${id}/backups`);
  await waitForJob(env, admin, backup.data.job.id, { tick });
  const archive = (await admin.api('GET', `/tenants/${id}`)).data.backups[0];
  const asked = await admin.api('POST', `/tenants/${id}/restore`, { archive: archive.path });
  assert.strictEqual(asked.status, 202);
  // Closed, its backup waiting for the worker
  await env.runner.drain();
  assert.strictEqual((await control().Tenant.findById(id).lean()).status, 'suspended');
  const refused = await admin.api('POST', `/tenants/${id}/resume`);
  assert.deepStrictEqual([refused.status, refused.data.code], [409, 'RESTORE_RUNNING']);
  // The command line goes through the same check (npm run tenant:suspend -- --resume)
  await assert.rejects(resumeTenant(env.ctx, id, { actor: 'cli:test' }), (err) => err.code === 'RESTORE_RUNNING');

  // Opened some other way all the same, and written to: the restore stops before the switch
  await transition(env.ctx, id, 'suspended', 'active', { actor: 'test' });
  const owner = env.client(`reopened.${BASE_DOMAIN}:${env.app.port}`);
  assert.strictEqual((await owner.login('owner', shop.owner.password)).status, 200);
  assert.strictEqual((await owner.request('POST', '/api/categories', { name: 'كُتب أثناء الاستعادة' })).status, 201);
  const job = await waitForJob(env, admin, asked.data.job.id, { tick });
  assert.strictEqual(job.status, 'failed');
  assert.deepStrictEqual(job.steps.find((s) => s.key === 'switch').status, 'failed');
  const tenant = await control().Tenant.findById(id).lean();
  assert.strictEqual(tenant.dbName, shop.tenant.dbName, 'still the database those writes went to');
  assert.ok((await owner.request('GET', '/api/categories')).data.some((c) => c.name === 'كُتب أثناء الاستعادة'));
  assert.strictEqual((await admin.api('POST', `/jobs/${asked.data.job.id}/cancel`)).status, 200);
});

test('a request the worker refuses fails its step; nothing outside the backup folder is ever asked for', async () => {
  const shop = await provisioned('bad-request');
  const { checkRequest, archiveAllowed } = await import('../lib/worker.js');
  const pattern = new RegExp(`^${env.config.tenantDbPrefix}[0-9a-f]{24}$`);
  assert.throws(() => checkRequest(env.config, pattern, { type: 'drop', tenantId: String(shop.tenant._id), dbName: shop.tenant.dbName, verifiedArchive: '/etc/passwd' }), /archive/);
  assert.throws(() => checkRequest(env.config, pattern, { type: 'backup', tenantId: 'x', dbName: shop.tenant.dbName, reason: 'manual' }), /tenantId/);
  assert.throws(() => checkRequest(env.config, pattern, { type: 'backup', tenantId: String(shop.tenant._id), dbName: 'salim_pos', reason: 'manual' }), /database/);
  assert.throws(() => checkRequest(env.config, pattern, { type: 'backup', tenantId: String(shop.tenant._id), dbName: shop.tenant.dbName, reason: 'manual', extra: 'x' }), /exactly/);
  assert.ok(!archiveAllowed(env.config, path.join(BACKUPS, shop.tenant.dbName, '..', 'x', '20261103T000000Z-manual.archive.gz'), shop.tenant.dbName));
  assert.ok(archiveAllowed(env.config, path.join(BACKUPS, shop.tenant.dbName, '20261103T000000Z-manual.archive.gz'), shop.tenant.dbName));
  // The worker answers a job with failed: the step fails with its Arabic message
  const job = (await admin.api('POST', `/tenants/${shop.tenant._id}/backups`)).data.job;
  await env.runner.drain();
  const [name] = (await fs.readdir(path.join(SPOOL, 'requests'))).filter((f) => f.endsWith('.json'));
  await fs.rm(path.join(SPOOL, 'requests', name));
  await fs.writeFile(path.join(SPOOL, 'state', 'jobs', name), JSON.stringify({ jobId: name.slice(0, 24), type: 'backup', status: 'failed', result: null, error: 'قاعدة بيانات المتجر غير موجودة', updatedAt: new Date().toISOString() }));
  const failed = await waitForJob(env, admin, job.id);
  assert.deepStrictEqual([failed.status, failed.steps[0].error], ['failed', 'قاعدة بيانات المتجر غير موجودة']);
  // Cancelled, the shop is free for another job
  assert.strictEqual((await admin.api('POST', `/jobs/${job.id}/cancel`)).data.status, 'cancelled');
  assert.strictEqual((await admin.api('POST', `/tenants/${shop.tenant._id}/backups`)).status, 202);
});
