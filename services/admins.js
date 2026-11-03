// The admin accounts (control/models/Admin.js), made and reset only from the command line
// (scripts/create-admin.js, scripts/admin-unlock.js) and checked at sign-in (admin/auth.js).
// The authenticator secret is encrypted under TOTP_KEY and leaves this module only once, to
// be shown on the terminal that enrols the app; recovery codes likewise, then only their
// keyed hashes remain.
import mongoose from 'mongoose';
import { httpError } from '../lib/errors.js';
import { ADMIN_PASSWORD_MIN, hashPassword, passwordProblem } from '../lib/passwords.js';
import {
  cleanCode,
  cleanRecoveryCode,
  decryptSecret,
  encryptSecret,
  groupedSecret,
  hashRecoveryCode,
  newRecoveryCodes,
  newSecret,
  otpauthUri,
  verifyTotp,
} from '../lib/totp.js';
import { ADMIN_USERNAME } from '../control/models/Admin.js';

export const ADMIN_USERNAME_MESSAGE = 'اسم المسؤول: أحرف إنجليزية صغيرة وأرقام ونقطة وشرطة، من 3 إلى 32';

export function adminUsernameProblem(value) {
  return typeof value === 'string' && ADMIN_USERNAME.test(value) ? null : ADMIN_USERNAME_MESSAGE;
}

export const adminPasswordProblem = (password, username) => passwordProblem(password, { username, min: ADMIN_PASSWORD_MIN });

/*
 * Makes an admin, or with reset replaces an existing one's password and authenticator (a
 * lost phone without its recovery codes): every session of that admin ends. The new
 * authenticator is not enabled until enableTotp() sees a right code from it, so an admin
 * whose enrolment was not finished cannot sign in. Returns what the terminal shows once:
 * { admin, secret (grouped base32), uri (otpauth://), recoveryCodes }.
 */
export async function createAdmin(ctx, { username, password, reset = false }, by = {}) {
  const { db, config } = ctx;
  if (!config.totpKey) throw new Error('TOTP_KEY is not set: add it to .env (64 hex characters)');
  const name = String(username ?? '').trim().toLowerCase();
  const nameProblem = adminUsernameProblem(name);
  if (nameProblem) throw httpError(400, nameProblem);
  const problem = adminPasswordProblem(password, name);
  if (problem) throw httpError(400, problem);

  const { Admin, Session, AuditLog } = db.controlModels;
  const existing = await Admin.findOne({ username: name }).lean();
  if (existing && !reset) throw httpError(409, `يوجد مسؤول بالاسم ${name}. لتغيير كلمة مروره ورمز التحقق شغّل الأمر مع --reset`);
  const _id = existing?._id ?? new mongoose.Types.ObjectId();
  const secret = newSecret();
  const recoveryCodes = newRecoveryCodes();
  const fields = {
    passwordHash: await hashPassword(password),
    totp: { secretEnc: encryptSecret(config.totpKey, secret, String(_id)), enabledAt: null, lastCounter: -1 },
    recoveryCodes: recoveryCodes.map((code) => ({ hash: hashRecoveryCode(config.totpKey, code), usedAt: null })),
  };
  let admin;
  if (existing) {
    admin = await Admin.findOneAndUpdate({ _id }, { $set: fields, $inc: { authVersion: 1 } }, { returnDocument: 'after' }).lean();
    await Session.deleteMany({ kind: 'admin', userId: _id });
  } else {
    admin = (await Admin.create({ _id, username: name, ...fields })).toObject();
  }
  await AuditLog.record({ actor: by.actor ?? 'system', action: existing ? 'admin.reset' : 'admin.create', details: { username: name } });
  return { admin: { _id: admin._id, username: admin.username }, secret: groupedSecret(secret), uri: otpauthUri({ secret, account: name }), recoveryCodes };
}

// The enrolment's last step: a right code from the app turns the authenticator on
export async function enableTotp(ctx, adminId, code) {
  const { Admin } = ctx.db.controlModels;
  const admin = await Admin.findById(adminId).select('+totp.secretEnc').lean();
  if (!admin) throw httpError(404, 'المسؤول غير موجود');
  const counter = verifyTotp(decryptSecret(ctx.config.totpKey, admin.totp.secretEnc, String(admin._id)), code, { lastCounter: admin.totp.lastCounter ?? -1 });
  if (counter === null) return false;
  await Admin.updateOne({ _id: admin._id }, { $set: { 'totp.enabledAt': new Date(), 'totp.lastCounter': counter } });
  return true;
}

/*
 * A second factor at sign-in or step-up: a code from the app, or one of the recovery codes.
 * Each works once: the app's code by its step (lastCounter, moved on only if still behind,
 * so two requests with the same code cannot both pass), a recovery code by being marked
 * used in the same write that finds it unused. Returns 'totp', 'recovery' or null.
 */
export async function checkSecondFactor(ctx, adminId, { code, recoveryCode } = {}) {
  const { Admin } = ctx.db.controlModels;
  const key = ctx.config.totpKey;
  if (!key) throw httpError(503, 'لوحة الإدارة غير مهيأة: مفتاح رموز التحقق (TOTP_KEY) غير مضبوط');
  if (typeof recoveryCode === 'string' && recoveryCode) {
    const clean = cleanRecoveryCode(recoveryCode);
    if (clean.length !== 10) return null;
    const { modifiedCount } = await Admin.updateOne(
      { _id: adminId, recoveryCodes: { $elemMatch: { hash: hashRecoveryCode(key, clean), usedAt: null } } },
      { $set: { 'recoveryCodes.$.usedAt': new Date() } },
    );
    return modifiedCount ? 'recovery' : null;
  }
  if (typeof code !== 'string' || !/^\d{6}$/.test(cleanCode(code))) return null;
  const admin = await Admin.findById(adminId).select('+totp.secretEnc').lean();
  if (!admin?.totp?.enabledAt || !admin.totp.secretEnc) return null;
  let secret;
  try {
    secret = decryptSecret(key, admin.totp.secretEnc, String(admin._id));
  } catch {
    throw httpError(503, 'تعذّر قراءة سر رمز التحقق: مفتاح TOTP_KEY ليس المفتاح الذي أُنشئ به. أعد تسجيل التطبيق بسطر الأوامر');
  }
  const counter = verifyTotp(secret, code, { lastCounter: admin.totp.lastCounter ?? -1 });
  if (counter === null) return null;
  const { modifiedCount } = await Admin.updateOne({ _id: admin._id, 'totp.lastCounter': { $lt: counter } }, { $set: { 'totp.lastCounter': counter } });
  return modifiedCount ? 'totp' : null;
}

// How many recovery codes are left unused
export async function recoveryCodesLeft(ctx, adminId) {
  const admin = await ctx.db.controlModels.Admin.findById(adminId).select('+recoveryCodes').lean();
  return (admin?.recoveryCodes ?? []).filter((c) => !c.usedAt).length;
}

// Clears the failed sign-ins of the admin panel (all of them, or one username's), so a
// locked admin can try again at once
export async function unlockAdmins(ctx, { username } = {}, by = {}) {
  const { LoginAttempt, AuditLog } = ctx.db.controlModels;
  const filter = { scope: 'admin', ...(username ? { $or: [{ username }, { kind: 'scope' }] } : {}) };
  const { deletedCount } = await LoginAttempt.deleteMany(filter);
  await AuditLog.record({ actor: by.actor ?? 'system', action: 'admin.unlock', details: { username: username ?? null, cleared: deletedCount } });
  return deletedCount;
}
