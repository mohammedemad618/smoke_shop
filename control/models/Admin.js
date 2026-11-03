import { Schema } from 'mongoose';

// Lower-case letters, digits and . _ -, like a shop's usernames (models/User.js)
export const ADMIN_USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;

// The owner of the system, who signs in to the admin panel with a password and a code from
// an authenticator app. Made only from the command line (scripts/create-admin.js), which
// also enrols the app: an admin whose totp.enabledAt is not set cannot sign in. Nothing
// secret leaves the server: the password's hash and the encrypted authenticator secret are
// never selected unless asked for, and the recovery codes are keyed hashes (lib/totp.js).
const adminSchema = new Schema(
  {
    username: { type: String, required: true, unique: true, match: ADMIN_USERNAME },
    passwordHash: { type: String, required: true, select: false },
    totp: {
      // AES-256-GCM under TOTP_KEY, bound to this admin's id
      secretEnc: { type: String, select: false },
      // Set once the app has shown a right code at enrolment
      enabledAt: Date,
      // The last step a code was accepted for: no code of it or before works again
      lastCounter: { type: Number, default: -1 },
    },
    recoveryCodes: { type: [{ _id: false, hash: String, usedAt: Date }], select: false, default: [] },
    // Raised when the password or the authenticator is replaced: every session ends
    authVersion: { type: Number, default: 1 },
    lastLoginAt: Date,
  },
  { timestamps: true },
);

export default adminSchema;
