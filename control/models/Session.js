import { Schema } from 'mongoose';

// A signed-in browser. The cookie holds a random value that is never stored: _id is its
// SHA-256, so a copy of this collection opens no session. kind tenant: a shop's account
// (userId in that shop's own database, so no ref); kind admin: the admin panel (userId an
// Admin). Kept on the server so a session ends the moment it is deleted: at sign-out, when
// the password changes, or when the shop is suspended (one deleteMany on tenantId).
const sessionSchema = new Schema(
  {
    _id: { type: String, required: true },
    kind: { type: String, enum: ['tenant', 'admin'], required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' },
    userId: { type: Schema.Types.ObjectId, required: true },
    // The user's authVersion when the session began; a change ends it
    authVersion: { type: Number, required: true },
    // Only while this session changes its own password: the version the user is about to
    // have, so its other requests meanwhile are not ended as sessions of the old password
    nextAuthVersion: Number,
    // The token every request that changes something must send back (X-CSRF-Token)
    csrf: { type: String, required: true },
    createdAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    // The idle limit from lastSeenAt, never past the absolute one from createdAt
    expiresAt: { type: Date, required: true },
    ip: String,
    ua: String,
    // Admin only. stage code: the password was right and the authenticator code is awaited
    // (nothing else is open); full: signed in. stepUpAt: when a code was last given, which
    // the riskiest actions need within 5 minutes. codeFailures: codes tried since the last
    // right one, at sign-in and at step-up alike, each counted before it is checked; a fifth
    // wrong one ends the session, and no sixth is checked (admin/auth.js).
    stage: { type: String, enum: ['code', 'full'] },
    stepUpAt: Date,
    codeFailures: { type: Number, default: 0 },
  },
  { versionKey: false },
);

// MongoDB removes a session once it has expired (lib/sessions.js also refuses it before then)
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Every session of a shop, or of one of its users, in one query
sessionSchema.index({ tenantId: 1, userId: 1 });

export default sessionSchema;
