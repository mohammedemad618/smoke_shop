// Creating shops and changing their status, for the command line and the admin panel. A
// shop is set up by a provision job (services/jobs.js) whose every step can run again
// without harm, so a creation stopped half way (a crash, a lost connection, a certificate
// that failed) is finished by running it again: the same address from the command line, or
// «إعادة المحاولة» in the admin panel. ctx is { db, registry, config, worker?, runner? };
// registry is optional (the command line has none: the server's registry picks the change
// up by polling), worker defaults to the one the config asks for (lib/worker.js).
import mongoose from 'mongoose';
import { httpError } from '../lib/errors.js';
import { checkSlug, SLUG_MESSAGES } from '../lib/slug.js';
import { publicUrl } from '../lib/config.js';
import { checkDns } from '../lib/dnscheck.js';
import { SCHEMAS } from '../models/index.js';
import { USERNAME, USERNAME_MESSAGE } from '../models/User.js';
import { TENANT_STATUSES } from '../control/models/Tenant.js';
import { hashPassword, passwordProblem, verifyPassword } from '../lib/passwords.js';
import { defineJob, runInline, workerOf } from './jobs.js';

export const DEFAULT_CATEGORY = 'عام';
const DAY = 24 * 60 * 60 * 1000;
// How often a step waiting for the root worker looks at its state file again
export const WORKER_POLL_MS = 5000;

// In order, as the admin panel shows them while a shop is set up
export const PROVISION_STEPS = ['host', 'database', 'indexes', 'settings', 'owner', 'dns', 'certificate', 'activate'];

// A shop's address on the first base domain, e.g. amal.pos.localhost
export const primaryHost = (config, slug) => `${slug}.${config.tenantBaseDomains[0]}`;

const nextRev = (db) => db.controlModels.Counter.next('rev');

const ignoreDuplicate = (err) => {
  if (err?.code !== 11000) throw err;
};

// An error the job runner does not try again by itself: only «إعادة المحاولة» does
export const finalError = (message) => Object.assign(new Error(message), { final: true });

// The shop's first settings, checked against the schema before anything is written
export async function settingsFrom(input) {
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

// The owner's account: a username and the first password the admin made (in the admin's
// browser, or by the command line), checked by the same rules as any new password. Only its
// hash is ever stored.
function ownerFrom(value, slug) {
  const username = String(value?.username ?? '').trim().toLowerCase();
  if (!username) throw httpError(400, 'اكتب اسم مستخدم صاحب المتجر');
  if (!USERNAME.test(username)) throw httpError(400, USERNAME_MESSAGE);
  const problem = passwordProblem(value?.password, { username, slug });
  if (problem) throw httpError(400, problem);
  const displayName = String(value?.displayName ?? '').trim().slice(0, 60);
  return { username, password: value.password, displayName };
}

function firstInvoiceFrom(value) {
  if (value === undefined || value === null || value === '') return 1;
  const first = Number(value);
  if (!Number.isInteger(first) || first < 1 || first > 1e9) throw httpError(400, 'رقم أول فاتورة يجب أن يكون عددًا صحيحًا من 1 فأكثر');
  return first;
}

// Whether an address can be given to a new shop or a rename: { ok } or { ok: false, reason }
// with reason invalid, reserved or taken (an address once used is never given again)
export async function slugAvailability(ctx, value, { tenantId = null } = {}) {
  const slug = String(value ?? '').trim().toLowerCase();
  const check = checkSlug(slug);
  if (!check.ok) return { ok: false, slug, reason: check.reason };
  const { Tenant, Host } = ctx.db.controlModels;
  const names = ctx.config.tenantBaseDomains.map((domain) => `${slug}.${domain}`);
  const [owner, host] = await Promise.all([
    Tenant.findOne({ slug }, '_id').lean(),
    Host.findOne({ _id: { $in: names } }, 'tenantId').lean(),
  ]);
  const takenBy = owner?._id ?? host?.tenantId;
  if (takenBy && String(takenBy) !== String(tenantId)) return { ok: false, slug, reason: 'taken' };
  return { ok: true, slug };
}

// The limits on how many shops there are and how many were made today (deleted ones count
// for the day, not for the total). Before a shop is made there must be room for one more;
// once made (made: true) it counts itself.
async function assertRoom(ctx, { made = false } = {}) {
  const { Tenant } = ctx.db.controlModels;
  const { maxTenants, maxNewTenantsPerDay } = ctx.config;
  const room = made ? 0 : 1;
  const count = await Tenant.countDocuments({ status: { $ne: 'deleted' } });
  if (count + room > maxTenants) throw httpError(409, `وصل عدد المتاجر إلى الحد الأقصى (${maxTenants})`, 'MAX_TENANTS');
  const today = await Tenant.countDocuments({ createdAt: { $gt: new Date(Date.now() - DAY) } });
  if (today + room > maxNewTenantsPerDay) {
    throw httpError(409, `وصل عدد المتاجر الجديدة خلال 24 ساعة إلى الحد الأقصى (${maxNewTenantsPerDay}). أعد المحاولة لاحقًا`, 'MAX_NEW_TENANTS');
  }
}

// The shop of this request id, or a creation of this address stopped half way, or a new one
async function findOrCreateTenant(ctx, fields, by, retried = false) {
  const { slug, label, shopName, notes, contact, requestId } = fields;
  const { db, registry, config } = ctx;
  const { Tenant, Host, Job } = db.controlModels;
  let tenant = requestId ? await Tenant.findOne({ createRequestId: requestId }).lean() : null;
  if (tenant && tenant.slug !== slug) throw httpError(409, 'رقم الطلب هذا استُخدم لمتجر آخر');
  if (!tenant) {
    const existing = await Tenant.findOne({ slug }).lean();
    if (existing) {
      // Made a moment ago by the same request; or, without a request id (the command line),
      // the same address again finishes a creation that stopped half way, including one that
      // stopped after the shop became active but before its job was closed
      const sameRequest = requestId && existing.createRequestId === requestId;
      const unfinished = existing.status === 'provisioning' || (await Job.exists({ tenantId: existing._id, type: 'provision', active: true }));
      const resume = !requestId && unfinished;
      if (!sameRequest && !resume) throw httpError(409, SLUG_MESSAGES.taken);
      tenant = existing;
    }
  }
  // An old address of a renamed shop is never given to another one
  const names = config.tenantBaseDomains.map((domain) => `${slug}.${domain}`);
  if (await Host.exists({ _id: { $in: names }, tenantId: { $ne: tenant?._id ?? null } })) throw httpError(409, SLUG_MESSAGES.taken);
  if (tenant) return tenant;

  await assertRoom(ctx);
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
  // Counted again once made: shops made at the same moment all passed the count above. One
  // over a limit takes its record back (nothing else of it exists yet). Each record is made
  // before its own count, so the last count sees every shop still there: never one past the
  // limit. At worst shops made at the same moment are all refused though one of them would
  // have fitted; asking again makes it.
  try {
    await assertRoom(ctx, { made: true });
  } catch (err) {
    await Tenant.deleteOne({ _id: tenant._id, status: 'provisioning' });
    throw err;
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

// The shop's one active provision job, with the latest request's details and any step added
// since it started; a failed step is set to run again. Returns { job, ownerMade }: ownerMade
// when an earlier run already made the owner's account, whose password this request's then
// leaves alone (its hash is not even kept).
async function provisionJob(ctx, tenant, requestId, params, by) {
  const { Job } = ctx.db.controlModels;
  const found = await Job.findOne({ tenantId: tenant._id, active: true }).lean();
  if (found && found.type !== 'provision') throw httpError(409, 'يوجد عمل آخر جارٍ على هذا المتجر');
  if (found) {
    const steps = PROVISION_STEPS.map((key) => found.steps.find((s) => s.key === key) ?? { key, status: 'pending' }).map((s) =>
      s.status === 'failed' ? { key: s.key, status: 'pending', tries: 0, ref: s.ref, note: s.note } : s,
    );
    const status = found.status === 'failed' ? 'queued' : found.status;
    const ownerMade = Boolean(found.result?.owner) || found.steps.some((s) => s.key === 'owner' && s.status === 'done');
    const { owner, ...rest } = params;
    await Job.updateOne({ _id: found._id }, { $set: { steps, status, params: { ...found.params, ...(ownerMade ? rest : params) }, runAfter: new Date(), error: null } });
    return { job: await Job.findById(found._id).lean(), ownerMade };
  }
  try {
    const job = await Job.create({
      type: 'provision',
      tenantId: tenant._id,
      status: 'queued',
      steps: PROVISION_STEPS.map((key) => ({ key, status: 'pending' })),
      params,
      requestId,
      createdBy: by.actor,
      runAfter: new Date(),
    });
    return { job: job.toObject(), ownerMade: false };
  } catch (err) {
    ignoreDuplicate(err); // started at the same moment elsewhere: use that one
    return provisionJob(ctx, tenant, requestId, params, by);
  }
}

// The shop's owner account, if it has one: { username, created: false }
async function existingOwner(db, tenant) {
  const { User } = await db.tenantModels(tenant);
  const owner = await User.findOne({ role: 'owner' }, 'usernameLower').lean();
  return owner ? { username: owner.usernameLower, created: false } : null;
}

// Whether the owner's account, made by an earlier run, has this password: a request sent
// again after a lost answer may carry the same one, or one made again since
async function ownerHasPassword(db, tenant, password) {
  const { User } = await db.tenantModels(tenant);
  const owner = await User.findOne({ role: 'owner' }).select('+passwordHash').lean();
  return Boolean(owner && (await verifyPassword(password, owner.passwordHash)));
}

/*
 * Creates a shop: its record (status provisioning, its own database name) and a provision
 * job that makes its address, its database with every index, its settings, the category
 * «عام», the number of its first invoice if asked, its owner's account with the first
 * password (to be changed at the first sign-in), checks its name in DNS, has its HTTPS
 * certificate issued, and makes it active. The password is hashed here: the job only ever
 * holds the hash.
 *
 * inline (the command line, the tests): the job runs now, as far as it can; a step that has
 * to wait for the root worker (a real certificate) leaves the rest to the server's runner
 * (pending: true). Otherwise (the admin panel) the job is queued for the runner and this
 * returns at once. Returns { tenant, host, url, owner, job, pending, passwordSet }, owner
 * being { username, created } once the account step ran: created is false when an earlier
 * run had already made the account, whose password is then left as it was. passwordSet says
 * whether the account has, or will be given, the password of this request: false when an
 * earlier run made it with another one (the panel must not show this one then).
 * input: { slug, shopName, owner: { username, password, displayName? }, label?, receiptNote?,
 *          timeZone?, currency?, phone?, address?, firstInvoiceNumber?, notes?,
 *          contact?: { person, phone }, requestId? }
 * by: who did it, for the audit log: { actor, ip? }
 */
export async function createTenant(ctx, input, by = {}, { inline = true } = {}) {
  const { db, registry, config } = ctx;
  const { Tenant, Job, AuditLog } = db.controlModels;
  const who = { actor: by.actor ?? 'system', ip: by.ip ?? null };

  const slug = String(input.slug ?? '').trim().toLowerCase();
  const check = checkSlug(slug);
  if (!check.ok) throw httpError(check.reason === 'reserved' ? 409 : 400, SLUG_MESSAGES[check.reason]);
  const settings = await settingsFrom(input);
  const owner = ownerFrom(input.owner, slug);
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
  const result = (fields) => ({ tenant, host, url: publicUrl(config, host), owner: null, job: null, pending: false, ...fields });
  if (tenant.status === 'active') {
    // Created already (the same request again, or a run that stopped just after the last
    // step): close the job it may have left open
    await Job.updateMany({ tenantId: tenant._id, type: 'provision', active: true }, { $set: { status: 'done', active: false, finishedAt: new Date(), leaseUntil: null, leaseOwner: null } });
    const job = await Job.findOne({ tenantId: tenant._id, type: 'provision' }).sort({ createdAt: -1 }).lean();
    return result({ owner: await existingOwner(db, tenant), job, passwordSet: await ownerHasPassword(db, tenant, owner.password) });
  }
  if (tenant.status !== 'provisioning') throw httpError(409, 'هذا المتجر ليس قيد التجهيز');

  const params = {
    slug,
    host,
    settings,
    firstInvoice,
    owner: { username: owner.username, displayName: owner.displayName, passwordHash: await hashPassword(owner.password) },
  };
  const provision = await provisionJob(ctx, tenant, requestId, params, who);
  let { job } = provision;
  const passwordSet = !provision.ownerMade || (await ownerHasPassword(db, tenant, owner.password));
  if (!inline) {
    ctx.runner?.kick();
    return result({ job, pending: true, passwordSet });
  }
  const outcome = await runInline(ctx, job._id);
  tenant = (await Tenant.findById(tenant._id).lean()) ?? tenant;
  if (outcome.failed) throw outcome.error;
  job = await Job.findById(job._id).lean();
  const made = job.result?.owner ?? (await existingOwner(db, tenant));
  return result({ tenant, owner: made && { ...made, created: made.created && passwordSet }, job, pending: Boolean(outcome.waiting), passwordSet });
}

/* The provision job's steps (services/jobs.js runs them) */

// The host's certificate as the worker last reported it, copied to its record for the lists
export async function mirrorCert(ctx, host, state) {
  if (!state) return;
  const cert = {
    status: state.status,
    attempts: state.attempts ?? 0,
    nextAttemptAt: state.nextAttemptAt ? new Date(state.nextAttemptAt) : null,
    expiresAt: state.expiresAt ? new Date(state.expiresAt) : null,
    lastError: state.lastError ?? null,
  };
  await ctx.db.controlModels.Host.updateOne({ _id: host }, { $set: Object.fromEntries(Object.entries(cert).map(([k, v]) => [`cert.${k}`, v])) });
}

// Marks a host retired for ever and asks the worker to remove its certificate (24 hours
// later). The worker's file first (asking twice changes nothing): if it cannot be written,
// the host is left as it was, so the step's retry or the next upkeep asks again, instead of
// a host marked retired whose certificate the worker keeps renewing.
export async function retireHost(ctx, host) {
  const { Host } = ctx.db.controlModels;
  await workerOf(ctx).retireCert(host._id);
  const doc = await Host.findOneAndUpdate(
    { _id: host._id, kind: { $ne: 'retired' } },
    { $set: { kind: 'retired', rev: await nextRev(ctx.db), 'cert.retireRequestedAt': new Date(), 'cert.status': 'retired' } },
    { returnDocument: 'after' },
  ).lean();
  if (doc) ctx.registry?.applyHost(doc);
}

// The name must point at this server (on the server only; .localhost names never leave the machine)
export async function dnsStep(ctx, host) {
  if (workerOf(ctx).mode !== 'spool' || !ctx.config.publicIpv4) return 'skipped';
  await checkDns(host, ctx.config.publicIpv4, ctx.dnsResolver);
  return { note: `يشير إلى ${ctx.config.publicIpv4}` };
}

// Asks the root worker for the host's certificate and waits until it is issued. When this
// step starts again (a retry after a failure) the request is touched, which the worker takes
// as "try again from the start". In development the certificate counts as issued at once.
export async function certificateStep(jc, host) {
  const { ctx, fresh } = jc;
  const worker = workerOf(ctx);
  await worker.wantCert(host, { again: fresh });
  const state = await worker.certState(host);
  await mirrorCert(ctx, host, state);
  if (worker.mode === 'local') return { note: 'وضع التطوير: الشهادة تُعدّ صادرة' };
  if (state?.status === 'issued') return { note: state.expiresAt ? `صالحة حتى ${state.expiresAt.slice(0, 10)}` : null };
  // A failure the worker wrote before this run of the step asked again is not the answer yet
  const current = state?.updatedAt && Date.parse(state.updatedAt) >= new Date(jc.step.startedAt).getTime();
  if (state?.status === 'failed' && current && !fresh) throw finalError(`تعذّر إصدار شهادة الأمان: ${state.lastError ?? 'خطأ غير معروف'}`);
  const note = state?.lastError ? `المحاولة ${state.attempts}: ${state.lastError}` : 'بانتظار عامل الشهادات';
  return { wait: ctx.workerPollMs ?? WORKER_POLL_MS, note };
}

defineJob('provision', {
  steps: PROVISION_STEPS,
  audit: 'tenant.create',
  run: {
    async host({ ctx, tenant, params }) {
      const { db, registry } = ctx;
      const { Host } = db.controlModels;
      try {
        await Host.create({ _id: params.host, tenantId: tenant._id, kind: 'primary', rev: await nextRev(db) });
      } catch (err) {
        ignoreDuplicate(err);
        if (String((await Host.findById(params.host, 'tenantId').lean())?.tenantId) !== String(tenant._id)) throw httpError(409, SLUG_MESSAGES.taken);
      }
      registry?.applyHost(await Host.findById(params.host).lean());
    },
    // The database comes into being with its first collection
    async database({ ctx, tenant }) {
      await ctx.db
        .tenantConnection(tenant)
        .createCollection('settings')
        .catch((err) => {
          if (err?.codeName !== 'NamespaceExists' && err?.code !== 48) throw err;
        });
    },
    // Binds the models and builds every index (unique barcode, invoice numbers...)
    async indexes({ ctx, tenant }) {
      await ctx.db.tenantModels(tenant);
    },
    async settings({ ctx, tenant, params }) {
      const { Setting, Category, Counter } = await ctx.db.tenantModels(tenant);
      if (!(await Setting.exists({ _id: 'shop' }))) await Setting.create(params.settings).catch(ignoreDuplicate);
      await Category.create({ name: DEFAULT_CATEGORY }).catch(ignoreDuplicate);
      // The next sale takes this number; later invoices count on from it
      if (params.firstInvoice > 1) await Counter.updateOne({ _id: 'sale' }, { $setOnInsert: { seq: params.firstInvoice - 1 } }, { upsert: true });
    },
    // Never replaces an owner an earlier run made, nor that owner's password. The hash leaves
    // the job once the account is made.
    async owner(jc) {
      const { ctx, tenant, params, result } = jc;
      result.owner = await existingOwner(ctx.db, tenant);
      if (!result.owner) {
        if (!params.owner?.passwordHash) throw finalError('كلمة المرور الأولى لم تعد محفوظة. أعد إنشاء المتجر بنفس العنوان');
        const { User } = await ctx.db.tenantModels(tenant);
        try {
          await User.create({ usernameLower: params.owner.username, displayName: params.owner.displayName, role: 'owner', passwordHash: params.owner.passwordHash, mustChangePassword: true });
          result.owner = { username: params.owner.username, created: true };
        } catch (err) {
          ignoreDuplicate(err); // made at the same moment by another run of the same creation
          result.owner = await existingOwner(ctx.db, tenant);
        }
      }
      if (params.owner) delete params.owner.passwordHash;
      return { note: result.owner.username };
    },
    dns: ({ ctx, params }) => dnsStep(ctx, params.host),
    certificate: (jc) => certificateStep(jc, jc.params.host),
    async activate({ ctx, tenant, job }) {
      if (tenant.status === 'active') return;
      try {
        await transition(ctx, tenant._id, 'provisioning', 'active', { actor: job.createdBy ?? 'system' });
      } catch (err) {
        // Activated by a run of the same creation at the same moment: this run changed
        // nothing. Any other failure was undone by transition(), so the step fails.
        if (!err.stale) throw err;
        const now = await ctx.db.controlModels.Tenant.findById(tenant._id, 'status').lean();
        if (now?.status !== 'active') throw err;
      }
    },
  },
  // Giving up a shop that never opened (a mistyped address, a certificate that keeps
  // failing): its addresses are retired for ever (never given to another shop) and it stops
  // counting against MAX_TENANTS. A database the job made goes as a deleted shop's does,
  // by the purge (a verified backup, then the worker's drop), which the next upkeep queues
  // at once; «إلغاء الحذف» cannot bring it back as a shop half set up.
  async cancel({ ctx, job, tenant, by: who = {} }) {
    if (tenant?.status !== 'provisioning') throw httpError(409, 'المتجر لم يعد قيد التجهيز');
    const { Host, Job } = ctx.db.controlModels;
    for (const host of await Host.find({ tenantId: tenant._id, kind: { $ne: 'retired' } }).lean()) await retireHost(ctx, host);
    await Job.updateOne({ _id: job._id }, { $unset: { 'params.owner.passwordHash': 1 } });
    const actor = { actor: who.actor ?? job.createdBy ?? 'system', ip: who.ip ?? null, reason: 'أُلغي التجهيز' };
    if (!(await ctx.db.databaseExists(tenant.dbName))) return transition(ctx, tenant._id, 'provisioning', 'deleted', actor);
    const now = new Date();
    const deletion = { requestedAt: now, requestedBy: actor.actor, purgeAfter: now, setupCancelled: true };
    return transition(ctx, tenant._id, 'provisioning', 'pending_deletion', actor, { set: { deletion } });
  },
});

/* Status */

// Moves a shop from one status (or one of several) to another, only if it is still in it
// (two admins at once cannot both act on the same state). `set` and `unset` change other
// fields in the same write (the deletion's details). Returns the shop as it is now. A change
// is in the audit log or not made at all: if its entry cannot be written, the status is put
// back and the error goes on. The 409 for a shop no longer in `from` carries stale: true,
// since that call changed nothing.
export async function transition(ctx, id, from, to, by = {}, { set = {}, unset = [] } = {}) {
  const { db, registry } = ctx;
  const { Tenant, AuditLog } = db.controlModels;
  if (!TENANT_STATUSES.includes(to)) throw new Error(`Unknown tenant status: ${to}`);
  const froms = [from].flat();
  const actor = by.actor ?? 'system';
  const reason = String(by.reason ?? '').slice(0, 200);
  const change = { status: to, statusReason: reason, statusChangedAt: new Date(), statusChangedBy: actor, rev: await nextRev(db), ...set };
  const update = { $set: change, ...(unset.length ? { $unset: Object.fromEntries(unset.map((k) => [k, 1])) } : {}) };
  const before = await Tenant.findOneAndUpdate({ _id: id, status: { $in: froms } }, update, { returnDocument: 'before' }).lean();
  if (!before) throw Object.assign(httpError(409, 'تغيّرت حالة المتجر في نفس اللحظة. حدّث الصفحة وأعد المحاولة'), { stale: true });
  try {
    await AuditLog.record({ actor, ip: by.ip ?? null, action: 'tenant.status', tenantId: before._id, tenantSlug: before.slug, details: { from: before.status, to, reason } });
  } catch (err) {
    // Put back what this call changed, unless the shop has changed again since, with a new
    // rev so the other processes' registries see it too
    try {
      const back = { status: before.status, statusReason: before.statusReason ?? '', statusChangedAt: before.statusChangedAt ?? null, statusChangedBy: before.statusChangedBy ?? null };
      await Tenant.updateOne({ _id: id, rev: change.rev }, { $set: { ...back, rev: await nextRev(db) } });
    } catch (undoErr) {
      console.error(`Could not undo the change of ${before.slug} to ${to}, which is not in the audit log: ${undoErr.message}`);
    }
    throw err;
  }
  const tenant = await Tenant.findById(id).lean();
  registry?.applyTenant(tenant);
  // Leaving active ends every session of the shop: whoever comes back after it is resumed
  // signs in again. The shop is closed to every request meanwhile (lib/tenancy.js), so a
  // failure here is logged rather than undoing a change already in the audit log.
  if (before.status === 'active' && to !== 'active') {
    await revokeSessions(ctx, before._id).catch((err) => console.error(`Could not end the sessions of ${before.slug}: ${err.message}`));
  }
  return tenant;
}

// Opens a suspended shop again, for the admin panel and the command line alike: never while
// a restore has it closed, since what was written meanwhile would go to the database the
// restore is about to replace (the restore opens it again itself when it ends or is cancelled)
export async function resumeTenant(ctx, id, by = {}) {
  if (await ctx.db.controlModels.Job.exists({ tenantId: id, active: true, type: 'restore' })) {
    throw httpError(409, 'تجري استعادة نسخة لهذا المتجر. انتظر حتى تنتهي، أو ألغِها من صفحة العمل', 'RESTORE_RUNNING');
  }
  return transition(ctx, id, 'suspended', 'active', { ...by, reason: '' });
}

// Ends the sessions of a shop, or of one of its accounts. Returns how many ended.
export async function revokeSessions(ctx, tenantId, userId) {
  const filter = { kind: 'tenant', tenantId, ...(userId ? { userId } : {}) };
  const { deletedCount } = await ctx.db.controlModels.Session.deleteMany(filter);
  return deletedCount;
}

// The shop's name as its owner set it, copied to its record for the admin's list
export async function setShopNameCache(ctx, tenantId, shopName) {
  const { db, registry } = ctx;
  const tenant = await db.controlModels.Tenant.findOneAndUpdate(
    { _id: tenantId },
    { $set: { shopNameCache: String(shopName), rev: await nextRev(db) } },
    { returnDocument: 'after' },
  ).lean();
  if (tenant) registry?.applyTenant(tenant);
  return tenant;
}

/*
 * A new first password for one of a shop's accounts, made by the admin (who gives it to the
 * owner, and recovers a forgotten one this way) or by the owner for a staff account
 * (services/staff.js); it must be changed at the next sign-in.
 * Every session of the account ends (authVersion and the sessions themselves) and its failed
 * sign-ins are forgotten. Only the hash is stored, and the audit log names the account,
 * never the password. Returns { username }.
 */
export async function resetUserPassword(ctx, tenantId, userId, password, by = {}) {
  const { db } = ctx;
  const { Tenant, AuditLog, LoginAttempt } = db.controlModels;
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant || tenant.status === 'deleted') throw httpError(404, 'المتجر غير موجود');
  const { User } = await db.tenantModels(tenant);
  const user = mongoose.isObjectIdOrHexString(userId) ? await User.findById(userId).lean() : null;
  if (!user) throw httpError(404, 'الحساب غير موجود');
  const problem = passwordProblem(password, { username: user.usernameLower, slug: tenant.slug });
  if (problem) throw httpError(400, problem, 'WEAK_PASSWORD');
  const passwordHash = await hashPassword(password);
  // The owner gets their shop back; a staff account its owner disabled stays disabled
  const enable = user.role === 'owner' ? { $unset: { disabledAt: 1 } } : {};
  await User.updateOne({ _id: user._id }, { $set: { passwordHash, mustChangePassword: true }, ...enable, $inc: { authVersion: 1 } });
  await revokeSessions(ctx, tenant._id, user._id);
  await LoginAttempt.deleteMany({ scope: String(tenant._id), username: user.usernameLower });
  await AuditLog.record({
    actor: by.actor ?? 'system',
    ip: by.ip ?? null,
    action: user.role === 'owner' ? 'tenant.owner.reset' : 'tenant.user.reset',
    tenantId: tenant._id,
    tenantSlug: tenant.slug,
    details: { username: user.usernameLower },
  });
  return { username: user.usernameLower };
}

/*
 * The same for the shop's owner from the command line (npm run tenant:owner). A shop made
 * before accounts existed gets its owner here, named `username`. Returns { username, created }.
 */
export async function setOwnerPassword(ctx, tenantId, { username, password, displayName } = {}, by = {}) {
  const { db } = ctx;
  const { Tenant, AuditLog, LoginAttempt } = db.controlModels;
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant || tenant.status === 'deleted') throw httpError(404, 'المتجر غير موجود');
  const { User } = await db.tenantModels(tenant);
  const existing = await User.findOne({ role: 'owner' }).lean();
  if (existing) {
    await resetUserPassword(ctx, tenant._id, existing._id, password, { ...by });
    return { username: existing.usernameLower, created: false };
  }
  const name = ownerFrom({ username, password }, tenant.slug).username;
  const passwordHash = await hashPassword(password);
  await User.create({ usernameLower: name, displayName: String(displayName ?? '').trim().slice(0, 60), role: 'owner', passwordHash, mustChangePassword: true });
  await LoginAttempt.deleteMany({ scope: String(tenant._id), username: name });
  await AuditLog.record({
    actor: by.actor ?? 'system',
    ip: by.ip ?? null,
    action: 'tenant.owner.create',
    tenantId: tenant._id,
    tenantSlug: tenant.slug,
    details: { username: name },
  });
  return { username: name, created: true };
}
