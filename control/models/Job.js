import { Schema } from 'mongoose';

// A long task on one shop (setting it up, a backup, a restore, a rename, a deletion...),
// done in steps so a failed one can be retried from where it stopped (services/jobs.js runs
// them). Only one job per shop can be active, like the single open stocktake: a job stays
// active until it is done or cancelled, a failed one included, so nothing else starts on a
// shop half way through. Whoever runs a job holds its lease; a lease left by a crash runs
// out and the job is taken up again. Never holds a password: an owner's first password
// reaches it as its hash, which is removed once the account is made.
const jobSchema = new Schema(
  {
    type: { type: String, enum: ['provision', 'backup', 'restore', 'rename', 'delete', 'purge', 'cleanup'], required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    status: { type: String, enum: ['queued', 'running', 'done', 'failed', 'cancelled'], default: 'queued' },
    active: { type: Boolean, default: true },
    steps: [
      {
        _id: false,
        key: { type: String, required: true },
        status: { type: String, enum: ['pending', 'done', 'skipped', 'failed'], default: 'pending' },
        at: Date,
        error: String,
        // When this run of the step began, and how many times it failed and was tried again
        startedAt: Date,
        tries: { type: Number, default: 0 },
        // The root worker's request made by this step: its own id (SPOOL_DIR/requests/<ref>.json)
        ref: String,
        // What the step waits for or found, for the progress screen (never a secret)
        note: String,
      },
    ],
    // What the job works on (the new address, the archive to restore...) and what it made
    params: { type: Schema.Types.Mixed, default: {} },
    result: { type: Schema.Types.Mixed, default: {} },
    attempts: { type: Number, default: 0 },
    leaseUntil: Date,
    leaseOwner: String,
    // Not taken up again before this: a step waiting for the worker, a retry's back-off
    runAfter: Date,
    error: String,
    requestId: String,
    createdBy: String,
    finishedAt: Date,
  },
  { timestamps: true, minimize: false },
);

jobSchema.index({ tenantId: 1 }, { unique: true, partialFilterExpression: { active: true } });
// What the runner looks for, and a shop's last jobs
jobSchema.index({ active: 1, runAfter: 1 });
jobSchema.index({ tenantId: 1, createdAt: -1 });

export default jobSchema;
