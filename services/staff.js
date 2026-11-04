// A shop's staff accounts, made and managed by its owner from the settings page
// (routes/staff.js). A staff account signs in like the owner, with a first password made
// here and shown to the owner once, which it must change at its first sign-in. It sells for
// cash and does what its permissions allow (public/js/permissions.js); the owner's own
// account is never touched from here. Accounts are never deleted, so the invoices they made
// keep their name: they are disabled instead. Every change is written to the audit log of
// the control database under the shop (the admin panel shows it), never with a password.
import mongoose from 'mongoose';
import { httpError } from '../lib/errors.js';
import { PERMISSION_KEYS, permissionsOf } from '../lib/permissions.js';
import { generatePassword, hashPassword } from '../lib/passwords.js';
import { USERNAME, USERNAME_MESSAGE } from '../models/User.js';
import { resetUserPassword, revokeSessions } from './tenants.js';

// Staff accounts in use at once (disabled ones do not count), and ever made, disabled
// included, so the list stays short
export const STAFF_MAX = 20;
export const STAFF_TOTAL_MAX = 100;
const NAME_MAX = 60;

const TAKEN = 'اسم المستخدم هذا مستخدم من قبل. اختر غيره';
const limitReached = () => httpError(409, `الحد الأقصى ${STAFF_MAX} موظفًا في وقت واحد. أوقف حساب موظف لا يعمل أولًا`, 'STAFF_LIMIT');
const notFound = () => httpError(404, 'حساب الموظف غير موجود');

// What the staff card shows of an account; never its hash
export const staffView = (user) => ({
  id: String(user._id),
  username: user.usernameLower,
  displayName: user.displayName || user.usernameLower,
  permissions: permissionsOf(user),
  disabled: Boolean(user.disabledAt),
  mustChangePassword: Boolean(user.mustChangePassword),
  lastLoginAt: user.lastLoginAt ?? null,
  createdAt: user.createdAt ?? null,
});

function usernameFrom(value) {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!name) throw httpError(400, 'اكتب اسم المستخدم', 'BAD_INPUT');
  if (!USERNAME.test(name)) throw httpError(400, USERNAME_MESSAGE, 'BAD_INPUT');
  return name;
}

function displayNameFrom(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw httpError(400, 'اكتب اسم الموظف', 'BAD_INPUT');
  if (name.length > NAME_MAX) throw httpError(400, `اسم الموظف طويل جدًا (${NAME_MAX} حرفًا كحد أقصى)`, 'BAD_INPUT');
  return name;
}

// Known keys only, in the list's own order, each once
function permissionsFrom(value) {
  if (!Array.isArray(value) || value.some((key) => typeof key !== 'string' || !PERMISSION_KEYS.includes(key))) {
    throw httpError(400, 'اختر الصلاحيات من القائمة', 'BAD_INPUT');
  }
  return PERMISSION_KEYS.filter((key) => value.includes(key));
}

// A staff account of this shop; the owner's is refused, whatever the id
async function findStaff(User, id) {
  if (!mongoose.isObjectIdOrHexString(id)) throw notFound();
  const user = await User.findById(id).lean();
  if (!user) throw notFound();
  if (user.role !== 'staff') throw httpError(403, 'حساب صاحب المتجر لا يُعدَّل من هنا', 'FORBIDDEN');
  return user;
}

/*
 * shop is the request's shop and who acts: { tenant, models, by: { actor, ip } }. ctx is
 * { db, registry, config } for the audit log and services/tenants.js.
 */

// What takes a place among the accounts in use (adding, enabling) runs one at a time per
// shop in this process, so two at the same moment cannot both take the last place
const turns = new Map();
async function inTurn(tenantId, fn) {
  const key = String(tenantId);
  const mine = (turns.get(key) ?? Promise.resolve()).then(fn);
  const settled = mine.catch(() => {});
  turns.set(key, settled);
  try {
    return await mine;
  } finally {
    if (turns.get(key) === settled) turns.delete(key);
  }
}
const audit = (ctx, shop, action, details) =>
  ctx.db.controlModels.AuditLog.record({ ...shop.by, action, tenantId: shop.tenant._id, tenantSlug: shop.tenant.slug, details });

// Every staff account, oldest first, with the limit
export async function listStaff(shop) {
  const users = await shop.models.User.find({ role: 'staff' }).sort({ createdAt: 1, _id: 1 }).lean();
  return { staff: users.map(staffView), max: STAFF_MAX };
}

// A new account from { username, displayName, permissions }. Returns { staff, password }:
// the first password, made here like the owner's, shown once and stored only as a hash.
export async function createStaff(ctx, shop, body = {}) {
  const username = usernameFrom(body.username);
  const displayName = displayNameFrom(body.displayName);
  const permissions = permissionsFrom(body.permissions ?? []);
  return inTurn(shop.tenant._id, () => addAccount(ctx, shop, { username, displayName, permissions }));
}

async function addAccount(ctx, shop, { username, displayName, permissions }) {
  const { User } = shop.models;
  // The owner's name is taken like any other (one index for every account of the shop)
  if (await User.exists({ usernameLower: username })) throw httpError(409, TAKEN, 'USERNAME_TAKEN');
  const [active, total] = await Promise.all([
    User.countDocuments({ role: 'staff', disabledAt: null }),
    User.countDocuments({ role: 'staff' }),
  ]);
  if (active >= STAFF_MAX) throw limitReached();
  if (total >= STAFF_TOTAL_MAX) throw httpError(409, `بلغ عدد حسابات الموظفين ${STAFF_TOTAL_MAX}، وهو الحد الأقصى`, 'STAFF_LIMIT');

  const password = generatePassword({ username, slug: shop.tenant.slug });
  const passwordHash = await hashPassword(password, { key: shop.by.ip });
  let user;
  try {
    user = await User.create({ usernameLower: username, displayName, role: 'staff', permissions, passwordHash, mustChangePassword: true });
  } catch (err) {
    if (err?.code === 11000) throw httpError(409, TAKEN, 'USERNAME_TAKEN');
    throw err;
  }
  // Another process may have added one at the same moment: never more than the limit
  if ((await User.countDocuments({ role: 'staff', disabledAt: null })) > STAFF_MAX) {
    await User.deleteOne({ _id: user._id });
    throw limitReached();
  }
  // Wrong guesses at this name from before it was an account are forgotten
  await ctx.db.controlModels.LoginAttempt.deleteMany({ scope: String(shop.tenant._id), username });
  await audit(ctx, shop, 'staff.create', { username, permissions });
  return { staff: staffView(user.toObject()), password };
}

// A new name or new permissions ({ displayName?, permissions? }). A permission taken away
// takes effect on the account's next request (lib/auth.js reads the account every time);
// its sessions go on.
export async function updateStaff(ctx, shop, id, body = {}) {
  const { User } = shop.models;
  const user = await findStaff(User, id);
  const changes = {};
  if (body.displayName !== undefined) changes.displayName = displayNameFrom(body.displayName);
  if (body.permissions !== undefined) changes.permissions = permissionsFrom(body.permissions);
  if (!Object.keys(changes).length) throw httpError(400, 'لا يوجد ما يُحفظ', 'BAD_INPUT');
  const updated = await User.findOneAndUpdate({ _id: user._id, role: 'staff' }, { $set: changes }, { returnDocument: 'after' }).lean();
  if (!updated) throw notFound();
  await audit(ctx, shop, 'staff.update', { username: user.usernameLower, ...changes });
  return { staff: staffView(updated) };
}

// Disabling ends every session of the account at once (authVersion and the sessions
// themselves) and refuses its sign-in; enabling lets it sign in again, within the limit.
export async function setStaffDisabled(ctx, shop, id, disabled) {
  return inTurn(shop.tenant._id, () => switchAccount(ctx, shop, id, disabled));
}

async function switchAccount(ctx, shop, id, disabled) {
  const { User } = shop.models;
  const user = await findStaff(User, id);
  if (Boolean(user.disabledAt) === disabled) return { staff: staffView(user) };
  if (!disabled && (await User.countDocuments({ role: 'staff', disabledAt: null })) >= STAFF_MAX) throw limitReached();
  const update = disabled ? { $set: { disabledAt: new Date() }, $inc: { authVersion: 1 } } : { $unset: { disabledAt: 1 } };
  const updated = await User.findOneAndUpdate({ _id: user._id, role: 'staff' }, update, { returnDocument: 'after' }).lean();
  if (!updated) throw notFound();
  if (disabled) await revokeSessions(ctx, shop.tenant._id, user._id);
  await audit(ctx, shop, disabled ? 'staff.disable' : 'staff.enable', { username: user.usernameLower });
  return { staff: staffView(updated) };
}

// A new first password, shown once: the old one stops working, every session of the account
// ends now, and the new one must be changed at the next sign-in. A disabled account stays
// disabled. Returns { staff, password }.
export async function resetStaffPassword(ctx, shop, id) {
  const { User } = shop.models;
  const user = await findStaff(User, id);
  const password = generatePassword({ username: user.usernameLower, slug: shop.tenant.slug });
  await resetUserPassword(ctx, shop.tenant._id, user._id, password, shop.by);
  return { staff: staffView(await User.findById(user._id).lean()), password };
}
