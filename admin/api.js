// The admin panel's API, /api/admin/* past a full session (admin/auth.js): the shops and
// their lifecycle, the jobs that carry it out, and the audit log. Every write is CSRF
// checked and logged; the riskiest ones (create, suspend, resume, delete, restore, rename,
// a password reset, ending sessions, exports) also need a code given in the last 5 minutes.
// Answers carry plain strings only, and never a password hash, a TOTP secret or a job's
// params (they can hold an owner's first password hash).
import path from 'node:path';
import { Router } from 'express';
import mongoose from 'mongoose';
import { httpError } from '../lib/errors.js';
import { publicUrl } from '../lib/config.js';
import { SLUG_MESSAGES } from '../lib/slug.js';
import { sendCsv } from '../lib/csv.js';
import { DAY_MS, requestedRange, timeZoneParam } from '../lib/range.js';
import { createTenant, primaryHost, resetUserPassword, resumeTenant, revokeSessions, setShopNameCache, slugAvailability, transition } from '../services/tenants.js';
import { backupsOf, cancelDeletion, startRename, startRestore } from '../services/lifecycle.js';
import { cancelJob, enqueueJob, jobView, retryJob, workerOf } from '../services/jobs.js';
import { EXPORT_KINDS, exportCsv } from '../services/exports.js';
import { runReport } from '../lib/limits.js';

const PAGE_SIZE = 50;
const SETTINGS_FIELDS = ['shopName', 'receiptNote', 'timeZone', 'currency', 'phone', 'address'];
// Shops whose own database can be read (made, and not purged)
const OPEN_DB = ['active', 'suspended', 'pending_deletion'];

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export function createAdminApi(ctx, { requireStepUp }) {
  const { db, config } = ctx;
  const { Tenant, Host, Job, AuditLog, Session } = db.controlModels;
  const router = Router();
  const by = (req) => ({ actor: `admin:${req.admin.username}`, ip: req.ip ?? null });
  const log = (req, action, tenant, details = {}) => AuditLog.record({ ...by(req), action, tenantId: tenant?._id, tenantSlug: tenant?.slug, details });

  async function tenantOf(req) {
    const tenant = mongoose.isObjectIdOrHexString(req.params.id) ? await Tenant.findById(req.params.id).lean() : null;
    if (!tenant) throw httpError(404, 'المتجر غير موجود');
    return tenant;
  }

  // Before the shop's database is opened: a state that has one, and no purge under way (its
  // database may be dropped already, and opening it would make it again, empty, for good)
  async function assertOpenable(tenant, message) {
    if (!OPEN_DB.includes(tenant.status) || (await Job.exists({ tenantId: tenant._id, active: true, type: 'purge' }))) throw httpError(409, message);
  }

  const certView = (cert) => (cert ? { status: cert.status ?? 'none', attempts: cert.attempts ?? 0, nextAttemptAt: cert.nextAttemptAt ?? null, expiresAt: cert.expiresAt ?? null, lastError: cert.lastError ?? null } : null);

  function tenantView(t, hosts, job) {
    const primary = hosts.find((h) => h.kind === 'primary') ?? hosts.find((h) => h.kind === 'reserved');
    const host = primary?._id ?? primaryHost(config, t.slug);
    return {
      id: String(t._id),
      slug: t.slug,
      label: t.label ?? '',
      shopName: t.shopNameCache ?? '',
      status: t.status,
      statusReason: t.statusReason ?? '',
      statusChangedAt: t.statusChangedAt ?? null,
      host,
      url: publicUrl(config, host),
      cert: certView(primary?.cert),
      usage: t.usage ?? null,
      lastActivityAt: t.lastActivityAt ?? null,
      createdAt: t.createdAt ?? null,
      deletion: t.deletion?.purgeAfter ? { requestedAt: t.deletion.requestedAt ?? null, purgeAfter: t.deletion.purgeAfter, setupCancelled: Boolean(t.deletion.setupCancelled) } : null,
      job: job ? { id: String(job._id), type: job.type, status: job.status } : null,
    };
  }

  /* The shops */

  router.get('/overview', async (req, res) => {
    const [live, today] = await Promise.all([
      Tenant.countDocuments({ status: { $ne: 'deleted' } }),
      Tenant.countDocuments({ createdAt: { $gt: new Date(Date.now() - DAY_MS) } }),
    ]);
    const monitor = await workerOf(ctx).monitor?.().catch(() => null);
    res.json({
      mode: workerOf(ctx).mode,
      baseDomain: config.tenantBaseDomains[0],
      limits: { maxTenants: config.maxTenants, tenants: live, maxNewPerDay: config.maxNewTenantsPerDay, newToday: today },
      monitor: monitor ? { ok: Boolean(monitor.ok), at: monitor.at ?? monitor.checkedAt ?? null, problems: (monitor.problems ?? []).map((p) => ({ level: String(p.level ?? ''), message: String(p.message ?? p.ar ?? '') })) } : null,
    });
  });

  router.get('/tenants', async (req, res) => {
    const filter = {};
    const status = text(req.query.status, 20);
    if (status) filter.status = status;
    const tenants = await Tenant.find(filter).sort({ createdAt: -1 }).limit(500).lean();
    const ids = tenants.map((t) => t._id);
    const [hosts, jobs] = await Promise.all([Host.find({ tenantId: { $in: ids } }).lean(), Job.find({ tenantId: { $in: ids }, active: true }).lean()]);
    const q = text(req.query.q, 60).toLowerCase();
    const list = tenants
      .map((t) => tenantView(t, hosts.filter((h) => String(h.tenantId) === String(t._id)), jobs.find((j) => String(j.tenantId) === String(t._id))))
      .filter((t) => !q || [t.slug, t.label, t.shopName].some((v) => v.toLowerCase().includes(q)));
    res.json(list);
  });

  // While the new address is typed: available, taken, reserved or invalid
  router.get('/slug-check', async (req, res) => {
    const result = await slugAvailability(ctx, req.query.slug, { tenantId: mongoose.isObjectIdOrHexString(req.query.tenant) ? req.query.tenant : null });
    const status = result.ok ? 'available' : result.reason;
    res.json({ slug: result.slug, status, message: result.ok ? 'متاح' : SLUG_MESSAGES[result.reason], host: result.ok ? primaryHost(config, result.slug) : null });
  });

  // A new shop: its record and its provision job, which the runner carries out while the
  // panel follows it (GET /jobs/:id). The owner's first password was made in the browser and
  // is hashed at once; requestId makes a repeated submit the same shop.
  router.post('/tenants', requireStepUp, async (req, res) => {
    const b = req.body;
    const input = {
      slug: text(b.slug, 40),
      label: text(b.label, 80),
      shopName: text(b.shopName, 80),
      timeZone: text(b.timeZone, 60) || undefined,
      currency: text(b.currency, 20) || undefined,
      phone: text(b.phone, 40) || undefined,
      notes: text(b.notes, 1000),
      contact: { phone: text(b.phone, 30) },
      firstInvoiceNumber: b.firstInvoiceNumber === '' || b.firstInvoiceNumber == null ? undefined : b.firstInvoiceNumber,
      owner: { username: text(b.ownerUsername, 40), password: typeof b.ownerPassword === 'string' ? b.ownerPassword : undefined },
      requestId: typeof b.requestId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(b.requestId) ? b.requestId : undefined,
    };
    if (!input.requestId) throw httpError(400, 'رقم الطلب غير صالح. حدّث الصفحة وأعد المحاولة');
    const made = await createTenant(ctx, input, by(req), { inline: false });
    const hosts = await Host.find({ tenantId: made.tenant._id }).lean();
    // passwordSet false: an earlier run of this request made the account with another
    // password (sent again after a lost answer, with the password made again)
    res.status(made.pending ? 202 : 200).json({ tenant: tenantView(made.tenant, hosts, made.pending ? made.job : null), job: jobView(made.job), passwordSet: made.passwordSet });
  });

  router.get('/tenants/:id', async (req, res) => {
    const tenant = await tenantOf(req);
    const [hosts, active, recent, sessions] = await Promise.all([
      Host.find({ tenantId: tenant._id }).sort({ createdAt: 1 }).lean(),
      Job.findOne({ tenantId: tenant._id, active: true }).lean(),
      Job.find({ tenantId: tenant._id }).sort({ createdAt: -1 }).limit(8).lean(),
      Session.find({ kind: 'tenant', tenantId: tenant._id }).sort({ lastSeenAt: -1 }).limit(50).lean(),
    ]);
    let settings = null;
    let users = [];
    // Not while it is purged: its database may be dropped already, and opening it would make it again
    if (OPEN_DB.includes(tenant.status) && active?.type !== 'purge') {
      const models = await db.tenantModels(tenant);
      const [s, accounts] = await Promise.all([models.Setting.findById('shop').lean(), models.User.find().sort({ createdAt: 1 }).lean()]);
      settings = Object.fromEntries(SETTINGS_FIELDS.map((key) => [key, s?.[key] ?? '']));
      users = accounts.map((u) => ({
        id: String(u._id),
        username: u.usernameLower,
        displayName: u.displayName ?? '',
        role: u.role,
        mustChangePassword: Boolean(u.mustChangePassword),
        disabled: Boolean(u.disabledAt),
        lastLoginAt: u.lastLoginAt ?? null,
        passwordChangedAt: u.passwordChangedAt ?? null,
      }));
    }
    const names = new Map(users.map((u) => [u.id, u.username]));
    const backups = tenant.status === 'deleted' ? [] : await backupsOf(ctx, tenant).catch(() => []);
    res.json({
      ...tenantView(tenant, hosts, active),
      dbName: tenant.dbName,
      notes: tenant.notes ?? '',
      phone: tenant.contact?.phone ?? '',
      hosts: hosts.map((h) => ({ host: h._id, kind: h.kind, redirectUntil: h.redirectUntil ?? null, cert: certView(h.cert), url: publicUrl(config, h._id) })),
      previousDbNames: (tenant.previousDbNames ?? []).map((p) => ({ name: p.name, dropAfter: p.dropAfter ?? null })),
      settings,
      users,
      sessions: sessions.map((s) => ({ username: names.get(String(s.userId)) ?? '', createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt, ip: s.ip ?? '', ua: s.ua ?? '' })),
      backups: backups.map((a) => ({ path: a.path, name: path.basename(a.path), kind: a.kind, bytes: a.bytes ?? null, createdAt: a.createdAt ?? null, dbName: a.dbName, current: a.dbName === tenant.dbName })),
      activeJob: jobView(active),
      jobs: recent.map(jobView),
    });
  });

  // The system's own notes on the shop: the name only the admin sees, a phone, notes
  router.put('/tenants/:id', async (req, res) => {
    const tenant = await tenantOf(req);
    const set = {};
    if (typeof req.body.label === 'string') set.label = text(req.body.label, 80) || tenant.label;
    if (typeof req.body.notes === 'string') set.notes = text(req.body.notes, 1000);
    if (typeof req.body.phone === 'string') set['contact.phone'] = text(req.body.phone, 30);
    const updated = await Tenant.findOneAndUpdate({ _id: tenant._id }, { $set: { ...set, rev: await db.controlModels.Counter.next('rev') } }, { returnDocument: 'after', runValidators: true }).lean();
    ctx.registry?.applyTenant(updated);
    await log(req, 'tenant.update', tenant, { fields: Object.keys(set).map((k) => k.replace('contact.', '')) });
    res.json({ label: updated.label, notes: updated.notes ?? '', phone: updated.contact?.phone ?? '' });
  });

  // The shop's own settings document, as its owner edits it on its settings page
  router.put('/tenants/:id/settings', async (req, res) => {
    const tenant = await tenantOf(req);
    await assertOpenable(tenant, 'لا يمكن تعديل إعدادات متجر في هذه الحالة');
    const changes = {};
    for (const key of SETTINGS_FIELDS) {
      const value = req.body[key];
      if (value === undefined) continue;
      if (typeof value !== 'string') throw httpError(400, 'البيانات المرسلة غير صالحة');
      changes[key] = value.trim();
    }
    if ('shopName' in changes && !changes.shopName) throw httpError(400, 'اكتب اسم المتجر');
    for (const key of ['timeZone', 'currency']) if (key in changes && !changes[key]) delete changes[key];
    const { Setting } = await db.tenantModels(tenant);
    const settings = await Setting.findOneAndUpdate({ _id: 'shop' }, { $set: changes }, { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true }).lean();
    if ('shopName' in changes) await setShopNameCache(ctx, tenant._id, settings.shopName);
    await log(req, 'tenant.settings', tenant, { fields: Object.keys(changes) });
    res.json(Object.fromEntries(SETTINGS_FIELDS.map((key) => [key, settings[key] ?? ''])));
  });

  router.post('/tenants/:id/suspend', requireStepUp, async (req, res) => {
    const tenant = await tenantOf(req);
    const reason = text(req.body.reason, 200);
    const updated = await transition(ctx, tenant._id, 'active', 'suspended', { ...by(req), reason });
    res.json({ status: updated.status });
  });

  router.post('/tenants/:id/resume', requireStepUp, async (req, res) => {
    const tenant = await tenantOf(req);
    const updated = await resumeTenant(ctx, tenant._id, by(req));
    res.json({ status: updated.status });
  });

  // A new first password, made in the admin's browser: the owner must change it at the next
  // sign-in, and every session of the account ends now
  router.post('/tenants/:id/users/:userId/password', requireStepUp, async (req, res) => {
    const tenant = await tenantOf(req);
    await assertOpenable(tenant, 'لا يمكن تعديل حسابات متجر في هذه الحالة');
    const password = typeof req.body.password === 'string' ? req.body.password : undefined;
    const { username } = await resetUserPassword(ctx, tenant._id, req.params.userId, password, by(req));
    res.json({ username, mustChangePassword: true });
  });

  router.post('/tenants/:id/sessions/revoke', requireStepUp, async (req, res) => {
    const tenant = await tenantOf(req);
    const ended = await revokeSessions(ctx, tenant._id);
    await log(req, 'tenant.sessions.revoke', tenant, { ended });
    res.json({ ended });
  });

  router.post('/tenants/:id/backups', async (req, res) => {
    const tenant = await tenantOf(req);
    if (!OPEN_DB.includes(tenant.status)) throw httpError(409, 'لا يمكن نسخ متجر في هذه الحالة');
    const job = await enqueueJob(ctx, { type: 'backup', tenantId: tenant._id, createdBy: by(req).actor });
    res.status(202).json({ job: jobView(job) });
  });

  router.post('/tenants/:id/restore', requireStepUp, async (req, res) => {
    const tenant = await tenantOf(req);
    const job = await startRestore(ctx, tenant._id, typeof req.body.archive === 'string' ? req.body.archive : '', by(req));
    res.status(202).json({ job: jobView(job) });
  });

  router.post('/tenants/:id/rename', requireStepUp, async (req, res) => {
    const tenant = await tenantOf(req);
    const job = await startRename(ctx, tenant._id, text(req.body.slug, 40), by(req));
    res.status(202).json({ job: jobView(job) });
  });

  // Deleting: the shop's address typed again to confirm. A verified backup first, then 30
  // days closed before the database goes.
  router.post('/tenants/:id/delete', requireStepUp, async (req, res) => {
    const tenant = await tenantOf(req);
    if (text(req.body.confirm, 40).toLowerCase() !== tenant.slug) throw httpError(400, 'اكتب عنوان المتجر كما هو لتأكيد الحذف');
    if (!['active', 'suspended'].includes(tenant.status)) throw httpError(409, 'لا يمكن حذف متجر في هذه الحالة');
    const job = await enqueueJob(ctx, { type: 'delete', tenantId: tenant._id, createdBy: by(req).actor });
    await log(req, 'tenant.delete', tenant, {});
    res.status(202).json({ job: jobView(job) });
  });

  router.post('/tenants/:id/cancel-deletion', async (req, res) => {
    const tenant = await tenantOf(req);
    const updated = await cancelDeletion(ctx, tenant._id, by(req));
    res.json({ status: updated.status });
  });

  router.get('/tenants/:id/export/:kind', requireStepUp, async (req, res) => {
    const tenant = await tenantOf(req);
    const kind = req.params.kind;
    if (!EXPORT_KINDS.includes(kind)) throw httpError(404, 'المسار غير موجود');
    await assertOpenable(tenant, 'لا يمكن تصدير بيانات متجر في هذه الحالة');
    const range = kind === 'sales' ? { ...requestedRange(req.query, 3 * 366 * DAY_MS), timeZone: timeZoneParam(req.query.tz) } : null;
    // A report of that shop's, in turn with the owner's own (lib/limits.js)
    const csv = await runReport(tenant._id, async () => exportCsv(await db.tenantModels(tenant), kind, range));
    await log(req, 'tenant.export', tenant, { kind, ...(range ? { from: range.start, to: range.end } : {}) });
    sendCsv(res, `${kind}-${tenant.slug}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  });

  /* Jobs */

  async function jobOf(req) {
    const job = mongoose.isObjectIdOrHexString(req.params.id) ? await Job.findById(req.params.id).lean() : null;
    if (!job) throw httpError(404, 'العمل غير موجود');
    return job;
  }

  router.get('/jobs/:id', async (req, res) => {
    const job = await jobOf(req);
    const tenant = await Tenant.findById(job.tenantId).lean();
    const hosts = tenant ? await Host.find({ tenantId: tenant._id }).lean() : [];
    res.json({ ...jobView(job), tenant: tenant ? tenantView(tenant, hosts, job.active ? job : null) : null, owner: job.result?.owner ? { username: job.result.owner.username } : null });
  });

  router.post('/jobs/:id/retry', async (req, res) => {
    const job = await jobOf(req);
    const retried = await retryJob(ctx, job._id);
    const tenant = await Tenant.findById(job.tenantId, 'slug').lean();
    await log(req, 'job.retry', tenant ?? { _id: job.tenantId }, { job: job.type });
    res.json(jobView(retried));
  });

  router.post('/jobs/:id/cancel', async (req, res) => {
    const job = await jobOf(req);
    const cancelled = await cancelJob(ctx, job._id, by(req));
    const tenant = await Tenant.findById(job.tenantId, 'slug').lean();
    await log(req, 'job.cancel', tenant ?? { _id: job.tenantId }, { job: job.type });
    res.json(jobView(cancelled));
  });

  /* The audit log, newest first, 50 a page */

  router.get('/audit', async (req, res) => {
    const filter = {};
    if (mongoose.isObjectIdOrHexString(req.query.tenant)) filter.tenantId = new mongoose.Types.ObjectId(String(req.query.tenant));
    const action = text(req.query.action, 60);
    if (action) filter.action = action;
    const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
    const [total, entries] = await Promise.all([
      AuditLog.countDocuments(filter),
      AuditLog.find(filter).sort({ at: -1, _id: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
    ]);
    res.json({
      page,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      total,
      entries: entries.map((e) => ({ at: e.at, actor: e.actor, ip: e.ip ?? '', action: e.action, tenantId: e.tenantId ? String(e.tenantId) : null, tenantSlug: e.tenantSlug ?? '', details: e.details ?? {}, result: e.result })),
    });
  });

  return router;
}
