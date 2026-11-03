// Creating shops and changing their status, for the command line now and the admin panel
// later. Every step of createTenant can run again without harm, so a creation stopped half
// way (a crash, a lost connection) is finished by running it again with the same address
// or request id. ctx is { db, registry, config }; registry is optional (the command line
// has none: the server's registry picks the change up by polling).
import mongoose from 'mongoose';
import { httpError } from '../lib/errors.js';
import { checkSlug, SLUG_MESSAGES } from '../lib/slug.js';
import { publicUrl } from '../lib/config.js';
import { SCHEMAS } from '../models/index.js';
import { TENANT_STATUSES } from '../control/models/Tenant.js';

export const DEFAULT_CATEGORY = 'عام';

// In order. owner and certificate have no work yet and are recorded as skipped: the owner's
// login (a first password made by the admin, changed at first sign-in) comes with shop
// accounts, and the HTTPS certificate with the root worker.
const STEPS = ['host', 'database', 'settings', 'owner', 'certificate', 'activate'];

// A shop's address on the first base domain, e.g. amal.pos.localhost
export const primaryHost = (config, slug) => `${slug}.${config.tenantBaseDomains[0]}`;

const nextRev = (db) => db.controlModels.Counter.next('rev');

const ignoreDuplicate = (err) => {
  if (err?.code !== 11000) throw err;
};

// The shop's first settings, checked against the schema before anything is written
async function settingsFrom(input) {
  const shopName = String(input.shopName ?? '').trim();
  if (!shopName) throw httpError(400, 'اكتب اسم المتجر');
  const values = { _id: 'shop', shopName };
  for (const key of ['receiptNote', 'timeZone', 'currency', 'phone', 'address']) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== '') values[key] = String(input[key]);
  }
  const draft = new mongoose.Document(values, SCHEMAS.Setting);
  try {
    await draft.validate();
  } catch (err) {
    throw httpError(400, Object.values(err.errors ?? {})[0]?.message ?? 'إعدادات المتجر غير صالحة');
  }
  return draft.toObject();
}

function firstInvoiceFrom(value) {
  if (value === undefined || value === null || value === '') return 1;
  const first = Number(value);
  if (!Number.isInteger(first) || first < 1 || first > 1e9) throw httpError(400, 'رقم أول فاتورة يجب أن يكون عددًا صحيحًا من 1 فأكثر');
  return first;
}

// The shop of this request id, or a creation of this address stopped half way, or a new one
async function findOrCreateTenant(ctx, fields, by, retried = false) {
  const { slug, label, shopName, notes, contact, requestId } = fields;
  const { db, registry, config } = ctx;
  const { Tenant, Host } = db.controlModels;
  let tenant = requestId ? await Tenant.findOne({ createRequestId: requestId }).lean() : null;
  if (tenant && tenant.slug !== slug) throw httpError(409, 'رقم الطلب هذا استُخدم لمتجر آخر');
  if (!tenant) {
    const existing = await Tenant.findOne({ slug }).lean();
    if (existing) {
      // Made a moment ago by the same request; or, without a request id (the command line),
      // the same address again finishes a creation that stopped half way
      const sameRequest = requestId && existing.createRequestId === requestId;
      const resume = !requestId && existing.status === 'provisioning';
      if (!sameRequest && !resume) throw httpError(409, SLUG_MESSAGES.taken);
      tenant = existing;
    }
  }
  // An old address of a renamed shop is never given to another one
  const names = config.tenantBaseDomains.map((domain) => `${slug}.${domain}`);
  if (await Host.exists({ _id: { $in: names }, tenantId: { $ne: tenant?._id ?? null } })) throw httpError(409, SLUG_MESSAGES.taken);
  if (tenant) return tenant;

  const count = await Tenant.countDocuments({ status: { $ne: 'deleted' } });
  if (count >= config.maxTenants) throw httpError(409, `وصل عدد المتاجر إلى الحد الأقصى (${config.maxTenants})`);
  // Made here, once, from nothing the request sent
  const dbName = db.assertDbName(`${config.tenantDbPrefix}${new mongoose.Types.ObjectId().toHexString()}`);
  try {
    const created = await Tenant.create({
      slug,
      label,
      dbName,
      status: 'provisioning',
      statusChangedAt: new Date(),
      statusChangedBy: by.actor,
      contact,
      notes,
      shopNameCache: shopName,
      rev: await nextRev(db),
      createRequestId: requestId ?? undefined,
    });
    tenant = created.toObject();
  } catch (err) {
    if (err?.code !== 11000 || retried) throw err?.code === 11000 ? httpError(409, SLUG_MESSAGES.taken) : err;
    // Made at the same moment elsewhere: look again, once. The same request carries on with
    // that shop; another one finds the address taken.
    return findOrCreateTenant(ctx, fields, by, true);
  }
  registry?.applyTenant(tenant);
  return tenant;
}

// The shop's creation in the audit log, written by the run that made the record or, if that
// run stopped before writing it, by the next one. The index on the log allows only one, so
// two runs at the same moment write it once.
async function logCreation(AuditLog, tenant, by) {
  if (await AuditLog.exists({ tenantId: tenant._id, action: 'tenant.create', result: 'ok' })) return;
  await AuditLog.record({
    ...by,
    action: 'tenant.create',
    tenantId: tenant._id,
    tenantSlug: tenant.slug,
    details: { label: tenant.label, dbName: tenant.dbName },
  }).catch(ignoreDuplicate);
}

// The shop's one active provision job, with any step added since it started
async function provisionJob(Job, tenant, requestId) {
  const found = await Job.findOne({ tenantId: tenant._id, active: true }).lean();
  if (found && found.type !== 'provision') throw httpError(409, 'يوجد عمل آخر جارٍ على هذا المتجر');
  if (found) {
    const steps = STEPS.map((key) => found.steps.find((s) => s.key === key) ?? { key, status: 'pending' });
    await Job.updateOne({ _id: found._id }, { $set: { status: 'running', steps }, $inc: { attempts: 1 } });
    return { ...found, steps };
  }
  try {
    const job = await Job.create({
      type: 'provision',
      tenantId: tenant._id,
      status: 'running',
      steps: STEPS.map((key) => ({ key, status: 'pending' })),
      attempts: 1,
      requestId,
    });
    return job.toObject();
  } catch (err) {
    ignoreDuplicate(err); // started at the same moment elsewhere: use that one
    return provisionJob(Job, tenant, requestId);
  }
}

/*
 * Creates a shop: its record (status provisioning, its own database name), its address,
 * its database with every index, its settings, the category «عام» and, if asked, the
 * number of its first invoice; then it becomes active. Returns { tenant, host, url }.
 * input: { slug, shopName, label?, receiptNote?, timeZone?, currency?, phone?, address?,
 *          firstInvoiceNumber?, notes?, contact?: { person, phone }, requestId? }
 * by: who did it, for the audit log: { actor, ip? }
 */
export async function createTenant(ctx, input, by = {}) {
  const { db, registry, config } = ctx;
  const { Tenant, Host, Job, AuditLog } = db.controlModels;
  const who = { actor: by.actor ?? 'system', ip: by.ip ?? null };

  const slug = String(input.slug ?? '').trim().toLowerCase();
  const check = checkSlug(slug);
  if (!check.ok) throw httpError(check.reason === 'reserved' ? 409 : 400, SLUG_MESSAGES[check.reason]);
  const settings = await settingsFrom(input);
  const firstInvoice = firstInvoiceFrom(input.firstInvoiceNumber);
  const label = String(input.label ?? '').trim().slice(0, 80) || settings.shopName;
  const requestId = input.requestId ? String(input.requestId).slice(0, 100) : null;
  const notes = String(input.notes ?? '').trim().slice(0, 1000);
  const contact = { person: String(input.contact?.person ?? '').slice(0, 80), phone: String(input.contact?.phone ?? '').slice(0, 30) };

  let tenant = await findOrCreateTenant(ctx, { slug, label, shopName: settings.shopName, notes, contact, requestId }, who);
  await logCreation(AuditLog, tenant, who);
  // Its address answers "being set up" until the last step
  registry?.applyTenant(tenant);
  const host = primaryHost(config, slug);
  const result = () => ({ tenant, host, url: publicUrl(config, host) });
  if (tenant.status === 'active') {
    // Created already (the same request again): close a job a crash may have left open
    await Job.updateMany({ tenantId: tenant._id, type: 'provision', active: true }, { $set: { status: 'done', active: false } });
    return result();
  }
  if (tenant.status !== 'provisioning') throw httpError(409, 'هذا المتجر ليس قيد التجهيز');

  const run = {
    async host() {
      try {
        await Host.create({ _id: host, tenantId: tenant._id, kind: 'primary', rev: await nextRev(db) });
      } catch (err) {
        ignoreDuplicate(err);
        if (String((await Host.findById(host, 'tenantId').lean())?.tenantId) !== String(tenant._id)) throw httpError(409, SLUG_MESSAGES.taken);
      }
      registry?.applyHost(await Host.findById(host).lean());
    },
    // Binds the models and builds every index (the database comes into being here)
    async database() {
      await db.tenantModels(tenant);
    },
    async settings() {
      const { Setting, Category, Counter } = await db.tenantModels(tenant);
      if (!(await Setting.exists({ _id: 'shop' }))) await Setting.create(settings).catch(ignoreDuplicate);
      await Category.create({ name: DEFAULT_CATEGORY }).catch(ignoreDuplicate);
      // The next sale takes this number; later invoices count on from it
      if (firstInvoice > 1) await Counter.updateOne({ _id: 'sale' }, { $setOnInsert: { seq: firstInvoice - 1 } }, { upsert: true });
    },
    owner: null,
    certificate: null,
    async activate() {
      try {
        tenant = await transition(ctx, tenant._id, 'provisioning', 'active', who);
      } catch (err) {
        // Activated by a run of the same creation at the same moment: this run changed
        // nothing. Any other failure was undone by transition(), so the step fails.
        if (!err.stale) throw err;
        const now = await Tenant.findById(tenant._id).lean();
        if (now?.status !== 'active') throw err;
        tenant = now;
      }
    },
  };

  const job = await provisionJob(Job, tenant, requestId);
  for (const step of job.steps) {
    if (step.status === 'done' || step.status === 'skipped') continue;
    try {
      if (run[step.key]) await run[step.key]();
      Object.assign(step, { status: run[step.key] ? 'done' : 'skipped', at: new Date(), error: undefined });
      await Job.updateOne({ _id: job._id }, { $set: { steps: job.steps } });
    } catch (err) {
      Object.assign(step, { status: 'failed', at: new Date(), error: err.message });
      await Job.updateOne({ _id: job._id }, { $set: { steps: job.steps, status: 'failed' } });
      await AuditLog.record({ ...who, action: 'tenant.create', tenantId: tenant._id, tenantSlug: slug, details: { step: step.key, error: err.message }, result: 'failed' });
      throw err;
    }
  }
  await Job.updateOne({ _id: job._id }, { $set: { status: 'done', active: false } });
  return result();
}

// Moves a shop from one status to another, only if it is still in `from` (two admins at
// once cannot both act on the same state). Returns the shop as it is now. A change is in the
// audit log or not made at all: if its entry cannot be written, the status is put back and
// the error goes on. The 409 for a shop no longer in `from` carries stale: true, since that
// call changed nothing.
export async function transition(ctx, id, from, to, by = {}) {
  const { db, registry } = ctx;
  const { Tenant, AuditLog } = db.controlModels;
  if (!TENANT_STATUSES.includes(to)) throw new Error(`Unknown tenant status: ${to}`);
  const actor = by.actor ?? 'system';
  const reason = String(by.reason ?? '').slice(0, 200);
  const change = { status: to, statusReason: reason, statusChangedAt: new Date(), statusChangedBy: actor, rev: await nextRev(db) };
  const before = await Tenant.findOneAndUpdate({ _id: id, status: from }, { $set: change }, { returnDocument: 'before' }).lean();
  if (!before) throw Object.assign(httpError(409, 'تغيّرت حالة المتجر في نفس اللحظة. حدّث الصفحة وأعد المحاولة'), { stale: true });
  try {
    await AuditLog.record({ actor, ip: by.ip ?? null, action: 'tenant.status', tenantId: before._id, tenantSlug: before.slug, details: { from, to, reason } });
  } catch (err) {
    // Put back what this call changed, unless the shop has changed again since, with a new
    // rev so the other processes' registries see it too
    try {
      const back = { status: from, statusReason: before.statusReason ?? '', statusChangedAt: before.statusChangedAt ?? null, statusChangedBy: before.statusChangedBy ?? null };
      await Tenant.updateOne({ _id: id, rev: change.rev }, { $set: { ...back, rev: await nextRev(db) } });
    } catch (undoErr) {
      console.error(`Could not undo the change of ${before.slug} to ${to}, which is not in the audit log: ${undoErr.message}`);
    }
    throw err;
  }
  const tenant = { ...before, ...change };
  registry?.applyTenant(tenant);
  // Leaving active, a later phase also deletes the shop's sessions here (one deleteMany on tenantId)
  return tenant;
}
