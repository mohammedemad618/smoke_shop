import { Schema } from 'mongoose';

// Failed sign-ins, counted by lib/login-guard.js in three ways: per (shop, username, IP),
// which locks; per (shop, username) from every address, which only slows down, so nobody
// can lock an owner out on purpose; and per shop. _id is the kind and a hash of the key, so
// any username typed stays a fixed size; the readable key is kept beside it for the admin.
const loginAttemptSchema = new Schema(
  {
    _id: { type: String, required: true },
    kind: { type: String, enum: ['ip', 'user', 'scope'], required: true },
    // The shop's id, or 'admin'
    scope: { type: String, required: true },
    username: String,
    ip: String,
    // Failures since windowStart
    count: { type: Number, default: 0 },
    windowStart: Date,
    // Locks so far (kind ip): each one twice as long as the one before
    strikes: { type: Number, default: 0 },
    lockedUntil: Date,
    // Forgotten a day after the last failure
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

loginAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default loginAttemptSchema;
