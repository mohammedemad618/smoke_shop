import { createHash } from 'node:crypto';
import { Schema } from 'mongoose';

const GENESIS = '0'.repeat(64);

// Everything done to the shops, by the admin panel or the command line. Nothing in the code
// changes or deletes an entry (old ones expire after 400 days), and each one carries the
// hash of the one before it: the unique prevHash keeps the chain a single line, since two
// entries written at once cannot both follow the same one. Never put secrets in details.
const auditLogSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    actor: { type: String, required: true },
    ip: { type: String, default: null },
    action: { type: String, required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', index: true },
    tenantSlug: String,
    details: { type: Schema.Types.Mixed, default: {} },
    result: { type: String, enum: ['ok', 'failed'], default: 'ok' },
    prevHash: { type: String, required: true, unique: true },
    hash: { type: String, required: true },
  },
  // minimize off: an empty details ({}) is stored as hashed, not dropped
  { versionKey: false, minimize: false },
);

auditLogSchema.index({ at: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });
// A shop's creation is logged once, however many runs it took (services/tenants.js)
auditLogSchema.index({ tenantId: 1, action: 1 }, { unique: true, partialFilterExpression: { action: 'tenant.create', result: 'ok' } });

export const auditHash = (prevHash, entry) =>
  createHash('sha256')
    .update(prevHash)
    .update(JSON.stringify([entry.at.toISOString(), entry.actor, entry.ip, entry.action, String(entry.tenantId ?? ''), entry.tenantSlug ?? '', entry.details, entry.result]))
    .digest('hex');

// Adds an entry at the end of the chain. The newest entry by time is only where the search
// starts, not the end: two processes (the command line and the server) can write in the same
// millisecond, and ObjectIds made by different processes do not sort in the order they were
// made. The unique prevHash keeps the chain a single line, so following it from any entry
// reaches its end. Losing the race for the end means another entry was just added there:
// follow on to it and try again, so every lost race is someone else's progress.
auditLogSchema.statics.record = async function record({ actor, ip = null, action, tenantId, tenantSlug, details = {}, result = 'ok' }) {
  let prevHash = (await this.findOne({}, 'hash').sort({ at: -1, _id: -1 }).lean())?.hash ?? GENESIS;
  for (let attempt = 1; ; attempt++) {
    let next;
    while ((next = await this.findOne({ prevHash }, 'hash').lean())) prevHash = next.hash;
    const entry = { at: new Date(), actor, ip, action, tenantId, tenantSlug, details, result };
    try {
      return await this.create({ ...entry, prevHash, hash: auditHash(prevHash, entry) });
    } catch (err) {
      // A hundred races lost in a row does not happen with a few writers: something else is wrong
      if (err?.code !== 11000 || !err.keyPattern?.prevHash || attempt >= 100) throw err;
    }
  }
};

export default auditLogSchema;
