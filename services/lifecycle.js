// A shop's life after it is made: a backup on demand, a restore, a rename, a deletion with
// 30 days to change one's mind and then the purge, and the old databases a restore leaves.
// Each is a job (services/jobs.js) whose steps ask the root worker (lib/worker.js) for what
// needs root: backups, restores and drops of databases, and certificates. Every request to
// the worker gets its own id, saved on its step before it is sent, so a run taken up again
// after a crash looks for that request's state instead of sending a second one.
//
// maintain() runs every minute in the server: purges that are due, redirects of renamed
// shops that have run out, databases kept after a restore whose 7 days are over, and the
// certificates' state copied from the worker's files. measure() runs every hour: invoices,
// products, data size and last activity of each shop, for the admin's list.
import path from 'node:path';
import mongoose from 'mongoose';
import { httpError } from '../lib/errors.js';
import { checkSlug, SLUG_MESSAGES } from '../lib/slug.js';
import { createJobRunner, defineJob, enqueueJob, workerOf } from './jobs.js';
import { WORKER_POLL_MS, certificateStep, dnsStep, finalError, mirrorCert, primaryHost, revokeSessions, slugAvailability, transition } from './tenants.js';

const DAY = 24 * 60 * 60 * 1000;
export const PURGE_AFTER_MS = 30 * DAY;
export const REDIRECT_MS = 90 * DAY;
export const KEEP_PREVIOUS_DB_MS = 7 * DAY;

const nextRev = (db) => db.controlModels.Counter.next('rev');
const archiveName = (archive) => (archive ? path.basename(archive) : null);

// Sends one request to the worker, once, and gives its result when it is done (null while
// it is not). A request the worker refused or failed fails the step; its id is let go, so a
// retry sends a new one.
async function workerRequest(jc, request) {
  const { ctx, step, tenant } = jc;
  const worker = workerOf(ctx);
  if (!step.ref) {
    step.ref = new mongoose.Types.ObjectId().toHexString();
    await jc.save();
  }
  let state = await worker.jobState(step.ref);
  if (!state && !(await worker.requestPending(step.ref))) {
    await worker.submit(step.ref, { ...request, tenantId: String(tenant._id) });
    state = await worker.jobState(step.ref);
  }
  if (state?.status === 'done') return state.result;
  if (state?.status === 'failed') {
    step.ref = undefined;
    throw finalError(state.error || 'فشلت المهمة عند عامل النسخ');
  }
  return null;
}

const waitForWorker = (jc, note) => ({ wait: jc.ctx.workerPollMs ?? WORKER_POLL_MS, note });

// A backup of the shop's current database, verified by the worker (a full test restore)
async function backupStep(jc, reason) {
  const result = await workerRequest(jc, { type: 'backup', dbName: jc.tenant.dbName, reason });
  if (!result) return waitForWorker(jc, 'بانتظار عامل النسخ الاحتياطي');
  jc.result.archive = result.archive;
  jc.result.bytes = result.bytes;
  return { note: archiveName(result.archive) };
}

const by = (job) => ({ actor: job.createdBy ?? 'system' });

async function audit(ctx, job, tenant, action, details) {
  await ctx.db.controlModels.AuditLog.record({ actor: job.createdBy ?? 'system', action, tenantId: tenant?._id ?? job.tenantId, tenantSlug: tenant?.slug, details });
}

/* Backup now */

defineJob('backup', {
  steps: ['backup'],
  audit: 'tenant.backup',
  run: { backup: (jc) => backupStep(jc, 'manual') },
  done: ({ ctx, job, tenant, result }) => audit(ctx, job, tenant, 'tenant.backup', { archive: archiveName(result.archive), bytes: result.bytes ?? null }),
  cancel: async () => {},
});

/* Deletion: a verified backup, then 30 days closed (pending_deletion), then the purge */

defineJob('delete', {
  steps: ['backup', 'pending'],
  audit: 'tenant.delete',
  run: {
    async backup(jc) {
      if (!['active', 'suspended'].includes(jc.tenant.status)) throw finalError('لا يمكن حذف متجر في هذه الحالة');
      return backupStep(jc, 'pre-delete');
    },
    async pending({ ctx, job, tenant, result }) {
      if (tenant.status === 'pending_deletion') return;
      const now = new Date();
      const deletion = { requestedAt: now, requestedBy: job.createdBy ?? 'system', purgeAfter: new Date(now.getTime() + PURGE_AFTER_MS), backupFile: result.archive };
      await transition(ctx, tenant._id, ['active', 'suspended'], 'pending_deletion', { ...by(job), reason: 'طلب حذف' }, { set: { deletion } });
      return { note: `يُحذف نهائيًا بعد ${deletion.purgeAfter.toISOString().slice(0, 10)}` };
    },
  },
  cancel: async () => {},
});

// Back to suspended within the 30 days, unless the purge has begun
export async function cancelDeletion(ctx, tenantId, who) {
  const { Job } = ctx.db.controlModels;
  if (await Job.exists({ tenantId, active: true, type: 'purge' })) throw httpError(409, 'بدأ الحذف النهائي لهذا المتجر ولا يمكن إلغاؤه');
  const tenant = await transition(ctx, tenantId, 'pending_deletion', 'suspended', { ...who, reason: 'أُلغي الحذف' }, { unset: ['deletion'] });
  await ctx.db.controlModels.AuditLog.record({ ...who, action: 'tenant.delete.cancel', tenantId, tenantSlug: tenant.slug, details: {} });
  return tenant;
}

// Marks a host retired for ever and asks the worker to remove its certificate (24 hours later)
async function retireHost(ctx, host) {
  const { Host } = ctx.db.controlModels;
  const doc = await Host.findOneAndUpdate(
    { _id: host._id, kind: { $ne: 'retired' } },
    { $set: { kind: 'retired', rev: await nextRev(ctx.db), 'cert.retireRequestedAt': new Date() } },
    { returnDocument: 'after' },
  ).lean();
  if (!doc) return;
  ctx.registry?.applyHost(doc);
  await workerOf(ctx).retireCert(doc._id);
  await Host.updateOne({ _id: doc._id }, { $set: { 'cert.status': 'retired' } });
}

defineJob('purge', {
  steps: ['backup', 'drop', 'retire', 'deleted'],
  audit: 'tenant.purge',
  run: {
    async backup(jc) {
      if (jc.tenant.status !== 'pending_deletion') throw finalError('المتجر لم يعد بانتظار الحذف');
      return backupStep(jc, 'purge');
    },
    // The worker drops only a database that no live shop uses, with the archive it verified
    async drop(jc) {
      const { ctx, tenant, result } = jc;
      if (tenant.status !== 'pending_deletion') throw finalError('المتجر لم يعد بانتظار الحذف');
      const dropped = await workerRequest(jc, { type: 'drop', dbName: tenant.dbName, verifiedArchive: result.archive });
      if (!dropped) return waitForWorker(jc, 'بانتظار حذف قاعدة البيانات');
      ctx.db.forgetTenantDb(tenant.dbName);
      return { note: tenant.dbName };
    },
    async retire({ ctx, tenant }) {
      const hosts = await ctx.db.controlModels.Host.find({ tenantId: tenant._id, kind: { $ne: 'retired' } }).lean();
      for (const host of hosts) await retireHost(ctx, host);
    },
    async deleted({ ctx, job, tenant }) {
      if (tenant.status === 'deleted') return;
      await transition(ctx, tenant._id, 'pending_deletion', 'deleted', { ...by(job), reason: 'حذف نهائي بعد المهلة' });
    },
  },
  done: ({ ctx, job, tenant, result }) => audit(ctx, job, tenant, 'tenant.purge', { archive: archiveName(result.archive), dbName: tenant?.dbName }),
});

/* Rename: the new address with its certificate, then it becomes the primary and the old one
   redirects for 90 days before it is retired */

export async function startRename(ctx, tenantId, newSlug, who) {
  const { Tenant, Host } = ctx.db.controlModels;
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant || !['active', 'suspended'].includes(tenant.status)) throw httpError(409, 'لا يمكن تغيير عنوان متجر في هذه الحالة');
  const slug = String(newSlug ?? '').trim().toLowerCase();
  if (slug === tenant.slug) throw httpError(400, 'هذا هو العنوان الحالي');
  const check = checkSlug(slug);
  if (!check.ok) throw httpError(check.reason === 'reserved' ? 409 : 400, SLUG_MESSAGES[check.reason]);
  const free = await slugAvailability(ctx, slug);
  if (!free.ok) throw httpError(409, SLUG_MESSAGES[free.reason]);
  const host = primaryHost(ctx.config, slug);
  // Taken now, so no other shop or rename can have it while its certificate is issued
  try {
    await Host.create({ _id: host, tenantId: tenant._id, kind: 'reserved', rev: await nextRev(ctx.db) });
  } catch (err) {
    if (err?.code === 11000) throw httpError(409, SLUG_MESSAGES.taken);
    throw err;
  }
  try {
    const job = await enqueueJob(ctx, { type: 'rename', tenantId: tenant._id, params: { fromSlug: tenant.slug, slug, host }, createdBy: who.actor });
    await ctx.db.controlModels.AuditLog.record({ ...who, action: 'tenant.rename.request', tenantId: tenant._id, tenantSlug: tenant.slug, details: { to: slug } });
    return job;
  } catch (err) {
    await Host.deleteOne({ _id: host, kind: 'reserved' });
    throw err;
  }
}

defineJob('rename', {
  steps: ['dns', 'certificate', 'switch'],
  audit: 'tenant.rename',
  run: {
    dns: ({ ctx, params }) => dnsStep(ctx, params.host),
    certificate: (jc) => certificateStep(jc, jc.params.host),
    async switch({ ctx, job, tenant, params }) {
      const { db, registry } = ctx;
      const { Host, Tenant } = db.controlModels;
      const until = new Date(Date.now() + REDIRECT_MS);
      const old = await Host.find({ tenantId: tenant._id, kind: 'primary', _id: { $ne: params.host } }).lean();
      // The new address first, so the shop is never without one
      const primary = await Host.findOneAndUpdate({ _id: params.host, tenantId: tenant._id }, { $set: { kind: 'primary', rev: await nextRev(db) } }, { returnDocument: 'after' }).lean();
      if (!primary) throw finalError('العنوان الجديد لم يعد محجوزًا لهذا المتجر');
      registry?.applyHost(primary);
      for (const host of old) {
        const moved = await Host.findOneAndUpdate({ _id: host._id }, { $set: { kind: 'redirect', redirectUntil: until, rev: await nextRev(db) } }, { returnDocument: 'after' }).lean();
        registry?.applyHost(moved);
      }
      const renamed = await Tenant.findOneAndUpdate({ _id: tenant._id }, { $set: { slug: params.slug, rev: await nextRev(db) } }, { returnDocument: 'after' }).lean();
      registry?.applyTenant(renamed);
      // Cookies belong to the old address; nobody stays signed in across the move
      await revokeSessions(ctx, tenant._id);
      return { note: `${params.host} (التوجيه من القديم حتى ${until.toISOString().slice(0, 10)})` };
    },
  },
  done: ({ ctx, job, tenant, params }) => audit(ctx, job, tenant, 'tenant.rename', { from: params.fromSlug, to: params.slug }),
  // The reserved address is retired, never given out again: its certificate may exist already
  async cancel({ ctx, params }) {
    const host = await ctx.db.controlModels.Host.findOne({ _id: params.host, kind: 'reserved' }).lean();
    if (host) await retireHost(ctx, host);
  },
});

/* Restore: into a new database, the current accounts copied in, then switched to; the
   database it replaced is kept 7 days */

// The archives of a shop's databases (the current one and those kept after a restore), newest first
export async function backupsOf(ctx, tenant) {
  const names = [tenant.dbName, ...(tenant.previousDbNames ?? []).map((p) => p.name)];
  const lists = await Promise.all(names.map(async (dbName) => (await workerOf(ctx).backups(dbName)).map((a) => ({ ...a, dbName }))));
  return lists.flat().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function startRestore(ctx, tenantId, archive, who) {
  const { Tenant } = ctx.db.controlModels;
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant || !['active', 'suspended'].includes(tenant.status)) throw httpError(409, 'لا يمكن استعادة نسخة لمتجر في هذه الحالة');
  const found = (await backupsOf(ctx, tenant)).find((a) => a.path === archive);
  if (!found) throw httpError(400, 'هذه النسخة غير موجودة في قائمة نسخ المتجر');
  const targetDb = ctx.db.assertDbName(`${ctx.config.tenantDbPrefix}${new mongoose.Types.ObjectId().toHexString()}`);
  const job = await enqueueJob(ctx, { type: 'restore', tenantId: tenant._id, params: { archive: found.path, fromDb: found.dbName, targetDb }, createdBy: who.actor });
  await ctx.db.controlModels.AuditLog.record({ ...who, action: 'tenant.restore.request', tenantId: tenant._id, tenantSlug: tenant.slug, details: { archive: archiveName(found.path) } });
  return job;
}

// The shop's database becomes `to`, only if it is still `from`; `from` is kept 7 days with
// the verified backup taken of it just before
export async function switchDb(ctx, tenantId, from, to, archive) {
  const { db, registry } = ctx;
  db.assertDbName(from);
  db.assertDbName(to);
  const tenant = await db.controlModels.Tenant.findOneAndUpdate(
    { _id: tenantId, dbName: from },
    { $set: { dbName: to, rev: await nextRev(db) }, $push: { previousDbNames: { name: from, dropAfter: new Date(Date.now() + KEEP_PREVIOUS_DB_MS), archive } } },
    { returnDocument: 'after' },
  ).lean();
  if (!tenant) throw finalError('تغيّرت قاعدة بيانات المتجر أثناء الاستعادة');
  registry?.applyTenant(tenant);
  return tenant;
}

defineJob('restore', {
  steps: ['suspend', 'backup', 'restore', 'users', 'switch', 'resume'],
  audit: 'tenant.restore',
  run: {
    // Closed while it happens: nothing written to the old database is lost on the way
    async suspend(jc) {
      const { ctx, job, tenant, params } = jc;
      if (tenant.status === 'active') {
        params.wasActive = true;
        await jc.save();
        await transition(ctx, tenant._id, 'active', 'suspended', { ...by(job), reason: 'استعادة نسخة احتياطية' });
      } else if (tenant.status !== 'suspended') {
        throw finalError('لا يمكن استعادة نسخة لمتجر في هذه الحالة');
      }
    },
    async backup(jc) {
      const done = await backupStep(jc, 'pre-restore');
      if (!done.wait) jc.result.preRestoreArchive = jc.result.archive;
      return done;
    },
    async restore(jc) {
      const { params, tenant } = jc;
      if (tenant.dbName === params.targetDb) return 'skipped';
      const restored = await workerRequest(jc, { type: 'restore', archive: params.archive, fromDb: params.fromDb, targetDb: params.targetDb });
      if (!restored) return waitForWorker(jc, 'بانتظار عامل الاستعادة');
      jc.result.counts = restored.counts;
      return { note: Object.entries(restored.counts ?? {}).map(([name, n]) => `${name}: ${n}`).join('، ') };
    },
    // The accounts as they are now, not as they were in the backup: a password changed or
    // reset since must not come back
    async users({ ctx, tenant, params }) {
      if (tenant.dbName === params.targetDb) return 'skipped';
      const client = ctx.db.base.getClient();
      const current = await client.db(ctx.db.assertDbName(tenant.dbName)).collection('users').find().toArray();
      const target = client.db(ctx.db.assertDbName(params.targetDb)).collection('users');
      await target.deleteMany({});
      if (current.length) await target.insertMany(current);
      // Every index in place before the first request to the restored database
      await ctx.db.tenantModels({ dbName: params.targetDb });
      return { note: `${current.length}` };
    },
    async switch({ ctx, tenant, params, result }) {
      if (tenant.dbName !== params.targetDb) {
        await switchDb(ctx, tenant._id, tenant.dbName, params.targetDb, result.preRestoreArchive);
        result.previousDb = tenant.dbName;
      }
      await revokeSessions(ctx, tenant._id);
    },
    async resume({ ctx, job, tenant, params }) {
      if (params.wasActive && tenant.status === 'suspended') await transition(ctx, tenant._id, 'suspended', 'active', { ...by(job), reason: 'انتهت الاستعادة' });
    },
  },
  done: ({ ctx, job, tenant, params, result }) =>
    audit(ctx, job, tenant, 'tenant.restore', { archive: archiveName(params.archive), previousDb: result.previousDb ?? null, dbName: params.targetDb, counts: result.counts ?? {} }),
  // Open again if the restore had closed it; a restored database not switched to stays
  // where it is (its name is in the job) until dropped by hand
  async cancel({ ctx, job, tenant, params }) {
    if (params.wasActive && tenant?.status === 'suspended') await transition(ctx, tenant._id, 'suspended', 'active', { ...by(job), reason: 'أُلغيت الاستعادة' });
  },
});

/* An old database kept after a restore, dropped once its 7 days are over */

defineJob('cleanup', {
  steps: ['drop', 'forget'],
  audit: 'tenant.cleanup',
  run: {
    async drop(jc) {
      const { params } = jc;
      const dropped = await workerRequest(jc, { type: 'drop', dbName: params.dbName, verifiedArchive: params.archive });
      if (!dropped) return waitForWorker(jc, 'بانتظار حذف القاعدة القديمة');
    },
    async forget({ ctx, tenant, params }) {
      await ctx.db.controlModels.Tenant.updateOne({ _id: tenant._id }, { $pull: { previousDbNames: { name: params.dbName } } });
      ctx.db.forgetTenantDb(params.dbName);
    },
  },
  cancel: async () => {},
});

/* On a clock */

export async function maintain(ctx, now = new Date()) {
  const { Tenant, Host, Job } = ctx.db.controlModels;
  const busy = async (tenantId) => Job.exists({ tenantId, active: true });
  const quietly = (promise) => promise.catch((err) => (err.code === 'JOB_ACTIVE' ? null : Promise.reject(err)));

  for (const tenant of await Tenant.find({ status: 'pending_deletion', 'deletion.purgeAfter': { $lte: now } }, '_id').lean()) {
    if (!(await busy(tenant._id))) await quietly(enqueueJob(ctx, { type: 'purge', tenantId: tenant._id }));
  }
  for (const host of await Host.find({ kind: 'redirect', redirectUntil: { $lte: now } }).lean()) await retireHost(ctx, host);
  for (const tenant of await Tenant.find({ status: { $ne: 'deleted' }, 'previousDbNames.dropAfter': { $lte: now } }, 'previousDbNames').lean()) {
    const due = tenant.previousDbNames.find((p) => p.dropAfter <= now && p.archive);
    if (due && !(await busy(tenant._id))) await quietly(enqueueJob(ctx, { type: 'cleanup', tenantId: tenant._id, params: { dbName: due.name, archive: due.archive } }));
  }
  // A shop made since the last hourly figures gets its first ones now
  for (const tenant of await Tenant.find({ status: 'active', 'usage.measuredAt': null }, 'dbName lastActivityAt slug').lean()) {
    await measureTenant(ctx, tenant).catch((err) => console.error(`Could not measure ${tenant.slug}: ${err.message}`));
  }
  // The certificates as the worker last wrote them, for the lists
  const worker = workerOf(ctx);
  if (worker.mode === 'spool') {
    for (const host of await Host.find({ kind: { $in: ['primary', 'reserved', 'redirect'] } }, '_id cert').lean()) {
      const state = await worker.certState(host._id);
      if (state && (state.status !== host.cert?.status || state.lastError !== (host.cert?.lastError ?? null) || state.expiresAt !== (host.cert?.expiresAt?.toISOString() ?? null))) {
        await mirrorCert(ctx, host._id, state);
      }
    }
  }
}

// One shop's figures for the admin's list. Last activity is the later of its last sale and
// the last request of any of its sessions.
export async function measureTenant(ctx, tenant) {
  const { db } = ctx;
  const models = await db.tenantModels(tenant);
  const [salesCount, productsCount, lastSale, stats, lastSession] = await Promise.all([
    models.Sale.estimatedDocumentCount(),
    models.Product.estimatedDocumentCount(),
    models.Sale.findOne({}, 'createdAt').sort({ createdAt: -1 }).lean(),
    db.tenantConnection(tenant).db.stats(),
    db.controlModels.Session.findOne({ kind: 'tenant', tenantId: tenant._id }, 'lastSeenAt').sort({ lastSeenAt: -1 }).lean(),
  ]);
  const lastSaleAt = lastSale?.createdAt ?? null;
  const times = [lastSaleAt, lastSession?.lastSeenAt, tenant.lastActivityAt].filter(Boolean).map((d) => new Date(d).getTime());
  const usage = { salesCount, productsCount, dataBytes: stats.dataSize ?? 0, lastSaleAt, measuredAt: new Date() };
  await db.controlModels.Tenant.updateOne({ _id: tenant._id }, { $set: { usage, ...(times.length ? { lastActivityAt: new Date(Math.max(...times)) } : {}) } });
  return usage;
}

export async function measure(ctx) {
  const tenants = await ctx.db.controlModels.Tenant.find({ status: { $in: ['active', 'suspended', 'pending_deletion'] } }, 'dbName lastActivityAt slug').lean();
  for (const tenant of tenants) {
    await measureTenant(ctx, tenant).catch((err) => console.error(`Could not measure ${tenant.slug}: ${err.message}`));
  }
}

// The server's job runner with the lifecycle's upkeep (server.js and the tests)
export const createRunner = (ctx, options = {}) => createJobRunner(ctx, { maintain, measure, ...options });
