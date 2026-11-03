import { Schema } from 'mongoose';

// Lower-case Latin letters, digits and . _ -, starting with a letter or digit: easy to type
// on a phone and to read out over the phone
export const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const USERNAME_MESSAGE = 'اسم المستخدم: أحرف إنجليزية صغيرة وأرقام ونقطة وشرطة، من 3 إلى 32';

// A sign-in account of this shop. Kept in the shop's own database, so its backup carries
// its accounts. The first password is made by the admin and must be changed at the first
// sign-in (mustChangePassword); changing or resetting it raises authVersion, which ends
// every session made before (lib/auth.js compares them on each request). The hash never
// leaves the server: it is not selected unless asked for.
const userSchema = new Schema(
  {
    usernameLower: { type: String, required: true, unique: true, match: [USERNAME, USERNAME_MESSAGE] },
    displayName: { type: String, trim: true, maxlength: [60, 'الاسم طويل جدًا'], default: '' },
    // Owner only for now; a cashier role comes later (permissions in lib/permissions.js)
    role: { type: String, enum: ['owner'], default: 'owner' },
    passwordHash: { type: String, required: true, select: false },
    mustChangePassword: { type: Boolean, default: true },
    authVersion: { type: Number, default: 1 },
    disabledAt: Date,
    lastLoginAt: Date,
    passwordChangedAt: Date,
  },
  { timestamps: true },
);

export default userSchema;
