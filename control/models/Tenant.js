import { Schema } from 'mongoose';

// provisioning: being set up (503); active: in use; suspended and pending_deletion: closed
// to everyone (423); deleted: gone (410). Every change goes through transition() in
// services/tenants.js.
export const TENANT_STATUSES = ['provisioning', 'active', 'suspended', 'pending_deletion', 'deleted'];

// One shop. Its data lives in its own database, dbName (pos_t_<ObjectId>), made once and
// never derived from anything a user or a request sends; renaming the shop's address leaves
// it alone. `rev` comes from one sequence for tenants and hosts, so lib/registry.js can pick
// up any change with a single rev > lastRev query.
const tenantSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    // The owner of the system's own name for the shop (the shop owner never sees it)
    label: { type: String, trim: true, maxlength: 80, default: '' },
    dbName: { type: String, required: true, unique: true },
    // dbName changes only through a restore (switchDb in services/lifecycle.js); the one before
    // is kept 7 days, with the verified backup taken of it just before, which the root
    // worker needs before it drops a database
    previousDbNames: [{ _id: false, name: String, dropAfter: Date, archive: String }],
    status: { type: String, enum: TENANT_STATUSES, default: 'provisioning' },
    statusReason: { type: String, trim: true, maxlength: 200, default: '' },
    statusChangedAt: Date,
    statusChangedBy: String,
    contact: { person: String, phone: String },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    // The shop's name as its owner wrote it in its settings, for the admin list
    shopNameCache: { type: String, default: '' },
    usage: { salesCount: Number, productsCount: Number, dataBytes: Number, lastSaleAt: Date, measuredAt: Date },
    lastActivityAt: Date,
    schemaVersion: { type: Number, default: 1 },
    // A deletion asked for from the admin panel: the verified backup taken first, and the day
    // the database goes (30 days later); cancelling it clears this
    deletion: { requestedAt: Date, requestedBy: String, purgeAfter: Date, backupFile: String },
    rev: { type: Number, required: true, index: true },
    // Repeating a create request with the same id makes one shop, not two
    createRequestId: String,
  },
  { timestamps: true },
);

tenantSchema.index({ createRequestId: 1 }, { unique: true, sparse: true });

export default tenantSchema;
