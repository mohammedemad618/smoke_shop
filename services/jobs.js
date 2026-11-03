// The long tasks on a shop (control/models/Job.js): setting it up, a backup, a restore, a
// rename, a deletion and its purge. Each type is a list of steps (defineJob); a job runs its
// steps in order and records each one, so a failure stops where it happened and a retry goes
// on from there. A step can also wait (for the root worker, for a certificate), which frees
// the job until it is due again. Only one job per shop can be active (the partial unique
// index), so two actions never work on the same shop at once.
//
// Whoever runs a job holds its lease: the server's runner (createJobRunner, every 2 s) or a
// command run inline (createTenant from the command line or the tests). A lease left by a
// crash runs out after a minute and the job is taken up again from the step it was on;
// every step can run again without harm. Inside the runner, a step that fails for a
// passing reason (the database busy, DNS not answering) is tried again a few times with a
// growing wait before the job is marked failed; a refusal (4xx) fails it at once.
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { httpError } from '../lib/errors.js';
import { createWorker } from '../lib/worker.js';

const LEASE_MS = 60 * 1000;
const RETRY_WAITS_MS = [10 * 1000, 30 * 1000, 60 * 1000, 2 * 60 * 1000];
const INLINE_WAIT_MS = 60 * 1000;
// ctx.retryWaitsMs and ctx.workerPollMs replace these in the tests

export const JOB_MESSAGES = Object.freeze({
  busy: 'يوجد عمل آخر جارٍ على هذا المتجر. انتظر حتى ينتهي، أو أعد محاولته أو ألغِه من صفحة المتجر',
  notFailed: 'لا يمكن إعادة محاولة عمل لم يفشل',
  noCancel: 'لا يمكن إلغاء هذا العمل',
});

// The root worker, or its local stand-in (lib/worker.js), made once per context
export const workerOf = (ctx) => (ctx.worker ??= createWorker(ctx.config, ctx.db));

/*
 * type -> { steps: [key...], run: { key: async (job context) => outcome }, audit, done?, cancel? }
 * A step's outcome: nothing or 'done'; 'skipped'; { note } (done, with a line for the screen);
 * { wait: ms, note } (not done yet: look again after ms). The job context is
 * { ctx, job, step, tenant, params, result, inline, save() }: params and result are the
 * job's own, changed in place and stored by save() (called after each step anyway).
 * audit names the action failures are logged under; done(jc) runs once the last step is;
 * cancel({ ctx, job, tenant, params, result, by }) undoes a failed job given up (cancelJob),
 * and may refuse with an error, which leaves the job failed.
 */
const HANDLERS = new Map();
export function defineJob(type, handler) {
  HANDLERS.set(type, handler);
}

const newOwner = (kind) => `${kind}:${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;

// The job's steps in the order of its type, with any step added since it was made
function stepsOf(job) {
  const handler = HANDLERS.get(job.type);
  return handler.steps.map((key) => job.steps.find((s) => s.key === key) ?? { key, status: 'pending', tries: 0 });
}

// A new job for a shop, queued now. 409 when the shop already has an active one.
export async function enqueueJob(ctx, { type, tenantId, params = {}, requestId, createdBy = 'system' }) {
  const handler = HANDLERS.get(type);
  if (!handler) throw new Error(`Unknown job type ${type}`);
  const { Job } = ctx.db.controlModels;
  try {
    const job = await Job.create({
      type,
      tenantId,
      status: 'queued',
      steps: handler.steps.map((key) => ({ key, status: 'pending' })),
      params,
      requestId,
      createdBy,
      runAfter: new Date(),
    });
    ctx.runner?.kick();
    return job.toObject();
  } catch (err) {
    if (err?.code === 11000 && err.keyPattern?.tenantId) throw httpError(409, JOB_MESSAGES.busy, 'JOB_ACTIVE');
    throw err;
  }
}

// Takes the job's lease if nobody holds it, it is still to do and it is due. Starting it
// from the queue counts an attempt; taking it up after a wait does not.
async function claim(ctx, jobId, owner, { due = true } = {}) {
  const now = new Date();
  const filter = {
    _id: jobId,
    active: true,
    status: { $in: ['queued', 'running'] },
    $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }, { leaseOwner: owner }],
  };
  if (due) filter.$and = [{ $or: [{ runAfter: null }, { runAfter: { $lte: now } }] }];
  return ctx.db.controlModels.Job.findOneAndUpdate(
    filter,
    [
      {
        $set: {
          attempts: { $cond: [{ $eq: ['$status', 'queued'] }, { $add: [{ $ifNull: ['$attempts', 0] }, 1] }, '$attempts'] },
          status: 'running',
          leaseUntil: new Date(now.getTime() + LEASE_MS),
          leaseOwner: owner,
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  ).lean();
}

class LeaseLost extends Error {}

// Runs a claimed job's steps until it is done, a step waits or one fails
async function runSteps(ctx, claimed, owner, { inline }) {
  const { Job, Tenant, AuditLog } = ctx.db.controlModels;
  const handler = HANDLERS.get(claimed.type);
  const job = { ...claimed, steps: stepsOf(claimed), params: claimed.params ?? {}, result: claimed.result ?? {} };

  // Every write checks the lease is still ours, and renews it
  async function write(fields) {
    const lease = new Date(Date.now() + LEASE_MS);
    const { matchedCount } = await Job.updateOne({ _id: job._id, leaseOwner: owner }, { $set: { steps: job.steps, params: job.params, result: job.result, leaseUntil: lease, ...fields } });
    if (!matchedCount) throw new LeaseLost(`Lost the lease of job ${job._id}`);
  }

  for (const step of job.steps) {
    if (step.status === 'done' || step.status === 'skipped') continue;
    const fresh = !step.startedAt;
    if (fresh) step.startedAt = new Date();
    const tenant = await Tenant.findById(job.tenantId).lean();
    const jc = { ctx, job, step, tenant, params: job.params, result: job.result, inline, fresh, save: () => write({}) };
    let outcome;
    try {
      if (fresh) await write({});
      outcome = await handler.run[step.key](jc);
    } catch (err) {
      if (err instanceof LeaseLost) return { lost: true };
      step.tries = (step.tries ?? 0) + 1;
      const refused = err.final || (err.status >= 400 && err.status < 500);
      const waits = ctx.retryWaitsMs ?? RETRY_WAITS_MS;
      if (!inline && !refused && step.tries <= waits.length) {
        step.note = err.message;
        await write({ leaseUntil: null, leaseOwner: null, runAfter: new Date(Date.now() + waits[step.tries - 1]) });
        return { waiting: true, job };
      }
      Object.assign(step, { status: 'failed', at: new Date(), error: err.message });
      await write({ status: 'failed', error: err.message, leaseUntil: null, leaseOwner: null });
      await AuditLog.record({
        actor: job.createdBy ?? 'system',
        action: handler.audit,
        tenantId: job.tenantId,
        tenantSlug: tenant?.slug,
        details: { job: job.type, step: step.key, error: err.message },
        result: 'failed',
      }).catch((e) => console.error(`Could not log the failure of job ${job._id}: ${e.message}`));
      return { failed: true, error: err, job };
    }
    if (outcome?.wait) {
      if (outcome.note !== undefined) step.note = outcome.note;
      await write({ leaseUntil: null, leaseOwner: null, runAfter: new Date(Date.now() + outcome.wait) });
      return { waiting: true, job };
    }
    Object.assign(step, { status: outcome === 'skipped' ? 'skipped' : 'done', at: new Date(), error: undefined });
    if (outcome?.note !== undefined) step.note = outcome.note;
    await write({});
  }

  const tenant = await Tenant.findById(job.tenantId).lean();
  await handler.done?.({ ctx, job, tenant, params: job.params, result: job.result, inline });
  await write({ status: 'done', active: false, finishedAt: new Date(), leaseUntil: null, leaseOwner: null, error: null });
  return { done: true, job };
}

// Runs one job here and now, as far as it can go: the command line and the tests. Another
// holder's lease is waited for (up to a minute); a step that waits ends the run, and the
// server's runner finishes the job. Returns { done } / { waiting } / { failed, error }.
export async function runInline(ctx, jobId) {
  const owner = newOwner('inline');
  const { Job } = ctx.db.controlModels;
  const until = Date.now() + INLINE_WAIT_MS;
  for (;;) {
    const claimed = await claim(ctx, jobId, owner, { due: false });
    if (claimed) {
      const outcome = await runSteps(ctx, claimed, owner, { inline: true });
      if (!outcome.lost) return outcome;
    }
    const job = await Job.findById(jobId).lean();
    if (!job || !job.active) return { done: job?.status === 'done', cancelled: job?.status === 'cancelled', job };
    if (job.status === 'failed') return { failed: true, error: httpError(409, job.error ?? 'فشل العمل'), job };
    if (!job.leaseUntil || job.leaseUntil <= new Date()) {
      if (job.runAfter && job.runAfter > new Date()) return { waiting: true, job };
      continue;
    }
    if (Date.now() > until) return { waiting: true, job };
    await sleep(100);
  }
}

// A failed job again, from its failed step
export async function retryJob(ctx, jobId) {
  const { Job } = ctx.db.controlModels;
  const job = await Job.findById(jobId).lean();
  if (!job || !job.active || job.status !== 'failed') throw httpError(409, JOB_MESSAGES.notFailed);
  const steps = stepsOf(job).map((s) => (s.status === 'failed' ? { key: s.key, status: 'pending', tries: 0, ref: s.ref, note: s.note } : s));
  const { modifiedCount } = await Job.updateOne({ _id: job._id, status: 'failed', active: true }, { $set: { steps, status: 'queued', runAfter: new Date(), error: null } });
  if (!modifiedCount) throw httpError(409, JOB_MESSAGES.notFailed);
  ctx.runner?.kick();
  return Job.findById(job._id).lean();
}

// Gives up a failed job: its type undoes what it must (a reserved address, a suspension),
// then the shop is free for another job. The job is taken first, in the same write that
// finds it failed, so a retry at the same moment can neither start it nor be undone by this
// while the runner carries it out. by: who, for the audit entries the undoing writes.
export async function cancelJob(ctx, jobId, by = {}) {
  const { Job, Tenant } = ctx.db.controlModels;
  const job = await Job.findById(jobId).lean();
  const handler = job && HANDLERS.get(job.type);
  if (!job || !handler?.cancel) throw httpError(409, JOB_MESSAGES.noCancel);
  const taken = await Job.findOneAndUpdate({ _id: job._id, active: true, status: 'failed' }, { $set: { status: 'cancelled' } }, { returnDocument: 'after' }).lean();
  if (!taken) throw httpError(409, JOB_MESSAGES.noCancel);
  const tenant = await Tenant.findById(taken.tenantId).lean();
  try {
    await handler.cancel({ ctx, job: taken, tenant, params: taken.params ?? {}, result: taken.result ?? {}, by });
  } catch (err) {
    // Not undone: failed as it was, to retry or cancel again
    await Job.updateOne({ _id: job._id, status: 'cancelled', active: true }, { $set: { status: 'failed' } });
    throw err;
  }
  await Job.updateOne({ _id: job._id }, { $set: { active: false, finishedAt: new Date(), leaseUntil: null, leaseOwner: null } });
  return Job.findById(job._id).lean();
}

/*
 * The server's runner: every pollMs it takes up the jobs that are due, one at a time; kick()
 * looks at once (after a job is queued). maintain() and measure() are what the lifecycle
 * needs on a clock (services/lifecycle.js): purges due, redirects expired, old databases to
 * drop, certificates to mirror; and the hourly usage figures.
 */
export function createJobRunner(ctx, { pollMs = 2000, maintainMs = 60 * 1000, measureMs = 60 * 60 * 1000, maintain, measure } = {}) {
  const owner = newOwner('runner');
  const { Job } = ctx.db.controlModels;
  let timers = [];
  let busy = null;
  let again = false;

  async function runDue() {
    for (;;) {
      const now = new Date();
      const due = await Job.find(
        { active: true, status: { $in: ['queued', 'running'] }, $and: [{ $or: [{ runAfter: null }, { runAfter: { $lte: now } }] }, { $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }] },
        '_id',
      )
        .sort({ runAfter: 1 })
        .limit(10)
        .lean();
      let ran = 0;
      for (const { _id } of due) {
        const claimed = await claim(ctx, _id, owner);
        if (!claimed) continue;
        ran += 1;
        try {
          await runSteps(ctx, claimed, owner, { inline: false });
        } catch (err) {
          // A database error while recording: the lease runs out and the job is taken up again
          console.error(`Job ${_id} (${claimed.type}): ${err.message}`);
        }
      }
      if (!ran) return;
    }
  }

  // One pass at a time; a kick during a pass makes another one right after it
  function tick() {
    if (busy) {
      again = true;
      return busy;
    }
    busy = runDue()
      .catch((err) => console.error(`Job runner: ${err.message}`))
      .finally(() => {
        busy = null;
        if (again) {
          again = false;
          tick();
        }
      });
    return busy;
  }

  const safely = (name, fn) => () =>
    Promise.resolve()
      .then(() => fn?.(ctx))
      .catch((err) => console.error(`${name}: ${err.message}`));

  const runner = {
    owner,
    tick,
    kick: () => {
      setImmediate(tick);
    },
    maintain: safely('Lifecycle upkeep', maintain),
    measure: safely('Usage figures', measure),
    // For the tests: one pass of its own after any running one, until no job is due now
    async drain() {
      while (busy) await busy;
      await tick();
      while (busy) await busy;
    },
    start() {
      if (pollMs) timers.push(setInterval(tick, pollMs).unref());
      if (maintainMs) timers.push(setInterval(runner.maintain, maintainMs).unref());
      if (measureMs) {
        timers.push(setTimeout(runner.measure, 15 * 1000).unref());
        timers.push(setInterval(runner.measure, measureMs).unref());
      }
      setImmediate(tick);
    },
    stop() {
      timers.forEach((t) => clearInterval(t));
      timers = [];
      return busy ?? Promise.resolve();
    },
  };
  return runner;
}

// What the admin panel shows of a job: no params (they may hold an owner's password hash)
export function jobView(job) {
  if (!job) return null;
  return {
    id: String(job._id),
    type: job.type,
    tenantId: String(job.tenantId),
    status: job.status,
    active: job.active,
    // Its type can be given up once failed (cancelJob); the panel offers it only then
    cancellable: Boolean(HANDLERS.get(job.type)?.cancel),
    attempts: job.attempts ?? 0,
    error: job.error ?? null,
    steps: (HANDLERS.has(job.type) ? stepsOf(job) : (job.steps ?? [])).map((s) => ({ key: s.key, status: s.status, at: s.at ?? null, error: s.error ?? null, note: s.note ?? null })),
    createdAt: job.createdAt ?? null,
    finishedAt: job.finishedAt ?? null,
    waitingUntil: job.status === 'running' && !job.leaseUntil ? (job.runAfter ?? null) : null,
  };
}
