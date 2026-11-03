import { Schema } from 'mongoose';

// A host name that leads to a shop, e.g. amal.pos.108-61-190-4.sslip.io. primary: the shop's
// address; redirect: an old address sending people to the new one; retired: never given to
// another shop. `cert` only mirrors the root worker's state files, for display.
const hostSchema = new Schema(
  {
    _id: { type: String, required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    kind: { type: String, enum: ['primary', 'redirect', 'retired'], default: 'primary' },
    redirectUntil: Date,
    cert: {
      status: { type: String, enum: ['none', 'pending', 'issued', 'failed'], default: 'none' },
      attempts: { type: Number, default: 0 },
      expiresAt: Date,
      lastError: String,
    },
    rev: { type: Number, required: true, index: true },
  },
  { timestamps: true },
);

export default hostSchema;
