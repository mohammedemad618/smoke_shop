import { Router } from 'express';
import { httpError } from '../lib/errors.js';
import { AUTH_MESSAGES, sessionInfo } from '../lib/auth.js';
import { requireSameOrigin } from '../lib/csrf.js';
import { minutesText } from '../lib/login-guard.js';
import { PASSWORD_MAX, hashPassword, passwordProblem, verifyDummy, verifyPassword } from '../lib/passwords.js';
import { rateLimit } from '../lib/ratelimit.js';
import { EXACT } from '../lib/routing.js';
import { allow } from '../lib/permissions.js';

const USERNAME_MAX = 64;
// Another attempt of the same name from the same address is being checked (lib/login-guard.js)
const busy = () => httpError(429, 'محاولة دخول أخرى بهذا الاسم جارية الآن. أعد المحاولة بعد لحظة', 'LOGIN_BUSY');

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
 * Signing in and changing the password are also limited per address in this process
 * (config.signInPerMinute, every shop together) behind nginx's own limit, so a variant of the
 * path nginx did not expect skips no limit; their hashes are counted per address too
 * (lib/passwords.js).
 */
export function createAuthRouters({ config, store, guard }) {
  const publicRouter = Router(EXACT);
  const sessionRouter = Router(EXACT);
  const signInLimit = rateLimit({
    windowMs: 60 * 1000,
    max: config.signInPerMinute,
    key: (req) => req.ip ?? '',
    message: 'محاولات دخول كثيرة من هذا العنوان. أعد المحاولة بعد دقيقة',
  });

  publicRouter.get('/shop', allow('public'), async (req, res) => {
    const settings = await req.models.Setting.findById('shop', 'shopName').lean();
    res.json({ shopName: settings?.shopName ?? '' });
  });

  // One answer for an unknown name, a closed account and a wrong password, taking as long
  // in each case. Signing in from another site is refused like any other cross-site write.
  publicRouter.post('/login', allow('public'), signInLimit, requireSameOrigin(config), async (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > USERNAME_MAX || password.length > PASSWORD_MAX) {
      throw httpError(400, AUTH_MESSAGES.badInput, 'BAD_INPUT');
    }
    const name = username.trim().toLowerCase();
    if (!name || !password) throw httpError(400, 'اكتب اسم المستخدم وكلمة المرور', 'BAD_INPUT');

    const key = guardKey(req, name);
    const release = guard.hold(key);
    if (!release) throw busy();
    try {
      const gate = await guard.check(key);
      if (gate.lockedMs) return locked(res, gate.lockedMs);
      if (gate.delayMs) await guard.wait(gate.delayMs);

      const { User } = req.models;
      // The one query of the app built from what a stranger types: no operator can slip in
      const user = await User.findOne({ usernameLower: name }).setOptions({ sanitizeFilter: true }).select('+passwordHash').lean();
      const hashBy = { key: key.ip };
      const ok = user && !user.disabledAt ? await verifyPassword(password, user.passwordHash, hashBy) : await verifyDummy(password, hashBy);
      if (!ok) {
        const { lockedMs } = await guard.failed(key, { known: Boolean(user) });
        if (lockedMs) return locked(res, lockedMs);
        throw httpError(401, AUTH_MESSAGES.wrongLogin, 'LOGIN_FAILED');
      }

      await guard.succeeded(key);
      // A new session every time: the one the browser came with, if any, is deleted
      const session = await store.start(req, res, { tenantId: req.tenant._id, userId: user._id, authVersion: user.authVersion });
      await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
      res.json(sessionInfo(user, session));
    } finally {
      release();
    }
  });

  sessionRouter.get('/me', allow('account'), (req, res) => {
    res.json(sessionInfo(req.user, req.authSession));
  });

  sessionRouter.post('/logout', allow('account'), async (req, res) => {
    await store.end(req, res);
    res.status(204).end();
  });

  // Every session of this account, on every device, this one included
  sessionRouter.post('/logout-all', allow('account'), async (req, res) => {
    await store.endWhere({ tenantId: req.tenant._id, userId: req.user._id });
    store.clearCookie(res);
    res.status(204).end();
  });

  // A new password: the current one first (counted like a sign-in, so a session left open
  // cannot be used to guess it), then the rules. Every other session of the account ends;
  // this one carries on.
  sessionRouter.post('/password', allow('account'), signInLimit, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || currentPassword.length > PASSWORD_MAX) {
      throw httpError(400, AUTH_MESSAGES.badInput, 'BAD_INPUT');
    }
    const { User } = req.models;
    const key = guardKey(req, req.user.usernameLower);
    const hashBy = { key: key.ip };
    const release = guard.hold(key);
    if (!release) throw busy();
    let user;
    try {
      const gate = await guard.check(key);
      if (gate.lockedMs) return locked(res, gate.lockedMs);
      if (gate.delayMs) await guard.wait(gate.delayMs);

      user = await User.findById(req.user._id).select('+passwordHash').lean();
      if (!(await verifyPassword(currentPassword, user.passwordHash, hashBy))) {
        const { lockedMs } = await guard.failed(key, { known: true });
        if (lockedMs) return locked(res, lockedMs);
        throw httpError(400, AUTH_MESSAGES.wrongCurrent, 'WRONG_PASSWORD');
      }
      await guard.succeeded(key);
    } finally {
      release();
    }
    const problem = passwordProblem(newPassword, { username: user.usernameLower, slug: req.tenant.slug });
    if (problem) throw httpError(400, problem, 'WEAK_PASSWORD');
    if (newPassword === currentPassword) throw httpError(400, AUTH_MESSAGES.samePassword, 'WEAK_PASSWORD');

    const passwordHash = await hashPassword(newPassword, hashBy);
    // This session first, marked with the version the account is about to have: its other
    // requests meanwhile (another tab of the same browser) carry on (lib/auth.js)
    await store.update(req.authSession, { nextAuthVersion: user.authVersion + 1 });
    let updated = null;
    try {
      // Only over the password just checked: a change made at the same moment elsewhere wins
      updated = await User.findOneAndUpdate(
        { _id: user._id, authVersion: user.authVersion },
        { $set: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() }, $inc: { authVersion: 1 } },
        { returnDocument: 'after' },
      ).lean();
    } finally {
      if (!updated) await store.update(req.authSession, { nextAuthVersion: null });
    }
    if (!updated) throw httpError(409, 'تغيّرت كلمة المرور في نفس اللحظة من مكان آخر. سجّل الدخول من جديد', 'PASSWORD_CHANGED');
    await store.endWhere({ tenantId: req.tenant._id, userId: user._id, _id: { $ne: req.authSession._id } });
    await store.update(req.authSession, { authVersion: updated.authVersion, nextAuthVersion: null });
    res.json(sessionInfo(updated, req.authSession));
  });

  return { publicRouter, sessionRouter };
}
