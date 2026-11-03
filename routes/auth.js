import { Router } from 'express';
import { httpError } from '../lib/errors.js';
import { AUTH_MESSAGES, sessionInfo } from '../lib/auth.js';
import { requireSameOrigin } from '../lib/csrf.js';
import { minutesText } from '../lib/login-guard.js';
import { PASSWORD_MAX, hashPassword, passwordProblem, verifyDummy, verifyPassword } from '../lib/passwords.js';

const USERNAME_MAX = 64;

// Wrong guesses from this address have locked the account here for a while: said plainly,
// with when to try again, since the address doing the guessing already knows it
function locked(res, lockedMs) {
  res.set('Retry-After', String(Math.ceil(lockedMs / 1000)));
  return res.status(429).json({ error: `محاولات دخول خاطئة كثيرة. أعد المحاولة بعد ${minutesText(lockedMs)}`, code: 'LOGIN_LOCKED' });
}

const guardKey = (req, username) => ({ scope: String(req.tenant._id), username, ip: req.ip ?? '' });

/*
 * The shop's accounts (lib/auth.js has the rules). Two routers, mounted at /api/auth:
 *   publicRouter, before the session check: GET /shop (the shop's name for the sign-in
 *     page, nothing else) and POST /login
 *   sessionRouter, after it and before the first-password gate: GET /me, POST /logout,
 *     POST /logout-all and POST /password
 * store is the shop sessions (lib/sessions.js), guard the failed sign-ins (lib/login-guard.js).
 */
export function createAuthRouters({ config, store, guard }) {
  const publicRouter = Router();
  const sessionRouter = Router();

  publicRouter.get('/shop', async (req, res) => {
    const settings = await req.models.Setting.findById('shop', 'shopName').lean();
    res.json({ shopName: settings?.shopName ?? '' });
  });

  // One answer for an unknown name, a closed account and a wrong password, taking as long
  // in each case. Signing in from another site is refused like any other cross-site write.
  publicRouter.post('/login', requireSameOrigin(config), async (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > USERNAME_MAX || password.length > PASSWORD_MAX) {
      throw httpError(400, AUTH_MESSAGES.badInput, 'BAD_INPUT');
    }
    const name = username.trim().toLowerCase();
    if (!name || !password) throw httpError(400, 'اكتب اسم المستخدم وكلمة المرور', 'BAD_INPUT');

    const key = guardKey(req, name);
    const gate = await guard.check(key);
    if (gate.lockedMs) return locked(res, gate.lockedMs);
    if (gate.delayMs) await guard.wait(gate.delayMs);

    const { User } = req.models;
    // The one query of the app built from what a stranger types: no operator can slip in
    const user = await User.findOne({ usernameLower: name }).setOptions({ sanitizeFilter: true }).select('+passwordHash').lean();
    const ok = user && !user.disabledAt ? await verifyPassword(password, user.passwordHash) : await verifyDummy(password);
    if (!ok) {
      const { lockedMs } = await guard.failed(key);
      if (lockedMs) return locked(res, lockedMs);
      throw httpError(401, AUTH_MESSAGES.wrongLogin, 'LOGIN_FAILED');
    }

    await guard.succeeded(key);
    // A new session every time: the one the browser came with, if any, is deleted
    const session = await store.start(req, res, { tenantId: req.tenant._id, userId: user._id, authVersion: user.authVersion });
    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
    res.json(sessionInfo(user, session));
  });

  sessionRouter.get('/me', (req, res) => {
    res.json(sessionInfo(req.user, req.authSession));
  });

  sessionRouter.post('/logout', async (req, res) => {
    await store.end(req, res);
    res.status(204).end();
  });

  // Every session of this account, on every device, this one included
  sessionRouter.post('/logout-all', async (req, res) => {
    await store.endWhere({ tenantId: req.tenant._id, userId: req.user._id });
    store.clearCookie(res);
    res.status(204).end();
  });

  // A new password: the current one first (counted like a sign-in, so a session left open
  // cannot be used to guess it), then the rules. Every other session of the account ends;
  // this one carries on.
  sessionRouter.post('/password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || currentPassword.length > PASSWORD_MAX) {
      throw httpError(400, AUTH_MESSAGES.badInput, 'BAD_INPUT');
    }
    const { User } = req.models;
    const key = guardKey(req, req.user.usernameLower);
    const gate = await guard.check(key);
    if (gate.lockedMs) return locked(res, gate.lockedMs);
    if (gate.delayMs) await guard.wait(gate.delayMs);

    const user = await User.findById(req.user._id).select('+passwordHash').lean();
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      const { lockedMs } = await guard.failed(key);
      if (lockedMs) return locked(res, lockedMs);
      throw httpError(400, AUTH_MESSAGES.wrongCurrent, 'WRONG_PASSWORD');
    }
    await guard.succeeded(key);
    const problem = passwordProblem(newPassword, { username: user.usernameLower, slug: req.tenant.slug });
    if (problem) throw httpError(400, problem, 'WEAK_PASSWORD');
    if (newPassword === currentPassword) throw httpError(400, AUTH_MESSAGES.samePassword, 'WEAK_PASSWORD');

    const passwordHash = await hashPassword(newPassword);
    // Only over the password just checked: a change made at the same moment elsewhere wins
    const updated = await User.findOneAndUpdate(
      { _id: user._id, authVersion: user.authVersion },
      { $set: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() }, $inc: { authVersion: 1 } },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw httpError(409, 'تغيّرت كلمة المرور في نفس اللحظة من مكان آخر. سجّل الدخول من جديد', 'PASSWORD_CHANGED');
    await store.endWhere({ tenantId: req.tenant._id, userId: user._id, _id: { $ne: req.authSession._id } });
    await store.update(req.authSession, { authVersion: updated.authVersion });
    res.json(sessionInfo(updated, req.authSession));
  });

  return { publicRouter, sessionRouter };
}
