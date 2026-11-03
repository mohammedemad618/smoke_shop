import { Schema } from 'mongoose';

// A host name that leads to a shop, e.g. amal.pos.108-61-190-4.sslip.io. primary: the shop's
// address; reserved: the new address of a rename, taken while its certificate is issued (it
// answers nothing yet); redirect: an old address sending people to the new one until
// redirectUntil; retired: never given to another shop. `cert` only mirrors the root
// worker's state files (SPOOL_DIR/state/certs/<host>.json), for display.
const hostSchema = new Schema(
  {
    _id: { type: String, required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    kind: { type: String, enum: ['primary', 'reserved', 'redirect', 'retired'], default: 'primary' },
    redirectUntil: Date,
    cert: {
      status: { type: String, enum: ['none', 'pending', 'issued', 'failed', 'retired'], default: 'none' },
      attempts: { type: Number, default: 0 },
      nextAttemptAt: Date,
      expiresAt: Date,
      lastError: String,
      // When retire/<host> was written for it, so that is done once
      retireRequestedAt: Date,
    },
    rev: { type: Number, required: true, index: true },
  },
  { timestamps: true },
);

export default hostSchema;
