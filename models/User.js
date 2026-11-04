import { Schema } from 'mongoose';
import { PERMISSION_KEYS } from '../public/js/permissions.js';

// Lower-case Latin letters, digits and . _ -, starting with a letter or digit: easy to type
// on a phone and to read out over the phone
export const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const USERNAME_MESSAGE = 'اسم المستخدم: أحرف إنجليزية صغيرة وأرقام ونقطة وشرطة، من 3 إلى 32';

// A sign-in account of this shop: its owner (one, made with the shop) or a staff account the
// owner adds from the settings page (routes/staff.js). Kept in the shop's own database, so
// its backup carries its accounts. The first password is made by the admin or the owner and
// must be changed at the first sign-in (mustChangePassword); changing or resetting it raises
// authVersion, which ends every session made before (lib/auth.js compares them on each
// request). The hash never leaves the server: it is not selected unless asked for. Staff
// accounts are never deleted, so their sales keep a name: they are disabled (disabledAt).
const userSchema = new Schema(
  {
    usernameLower: { type: String, required: true, unique: true, match: [USERNAME, USERNAME_MESSAGE] },
    displayName: { type: String, trim: true, maxlength: [60, 'الاسم طويل جدًا'], default: '' },
    role: { type: String, enum: ['owner', 'staff'], default: 'owner' },
    // A staff account's permissions (public/js/permissions.js); the owner's are all of them,
    // whatever this holds, and an owner made before staff accounts existed has none here
    permissions: { type: [{ type: String, enum: PERMISSION_KEYS }], default: undefined },
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
