import { Schema } from 'mongoose';

// A long task on one shop (setting it up, a backup, a restore...), done in steps so a
// failed one can be retried from where it stopped. Only one job per shop can be active,
// like the single open stocktake.
const jobSchema = new Schema(
  {
    type: { type: String, enum: ['provision', 'backup', 'restore', 'rename', 'purge', 'usage'], required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    status: { type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued' },
    active: { type: Boolean, default: true },
    steps: [
      {
        _id: false,
        key: { type: String, required: true },
        status: { type: String, enum: ['pending', 'done', 'skipped', 'failed'], default: 'pending' },
        at: Date,
        error: String,
      },
    ],
    attempts: { type: Number, default: 0 },
    leaseUntil: Date,
    requestId: String,
  },
  { timestamps: true },
);

jobSchema.index({ tenantId: 1 }, { unique: true, partialFilterExpression: { active: true } });

export default jobSchema;
