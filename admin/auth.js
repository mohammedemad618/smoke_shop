// Signing in to the admin panel: nginx's basic auth in front, then the admin's password,
// then a code from the authenticator app (or a recovery code). The password alone opens a
// session of stage code, good for 5 minutes and for nothing but giving the code; the code
// turns it into a full session (a new cookie: __Host-pos_admin, SameSite=Strict, 30
// minutes idle, 8 hours at most, lib/sessions.js). The riskiest actions also need a code
// given within the last 5 minutes (step-up). Codes are counted on the session, at sign-in
// and at step-up alike, each one before it is checked, so a burst sent at once gets no more
// tries than one sent in turn: the fifth wrong one ends it. An admin has one session at the
// code stage at a time. Each wrong password or code also counts in lib/login-guard.js
// (scope 'admin'): five in 15 minutes from one address lock that address out for a while,
// codes included (npm run admin:unlock clears it). Nothing here ever returns a password
// hash, a secret or a recovery code, and a name typed at a failed sign-in is kept only when
// it is an admin's (a password typed in the wrong box must not land in the audit log).
import { Router } from 'express';
import { httpError } from '../lib/errors.js';
import { requireCsrf, requireSameOrigin } from '../lib/csrf.js';
import { minutesText } from '../lib/login-guard.js';
import { PASSWORD_MAX, verifyDummy, verifyPassword } from '../lib/passwords.js';
import { rateLimit } from '../lib/ratelimit.js';
import { EXACT } from '../lib/routing.js';
import { checkSecondFactor, recoveryCodesLeft } from '../services/admins.js';

const MINUTE = 60 * 1000;
export const CODE_STAGE_MS = 5 * MINUTE;
export const STEP_UP_MS = 5 * MINUTE;
export const MAX_CODE_FAILURES = 5;
const USERNAME_MAX = 64;

export const ADMIN_MESSAGES = Object.freeze({
  expired: 'انتهت الجلسة. سجّل الدخول من جديد',
  wrongLogin: 'اسم المستخدم أو كلمة المرور غير صحيحة',
  wrongCode: 'رمز التحقق غير صحيح',
  tooManyCodes: 'رموز خاطئة كثيرة، فانتهت الجلسة. سجّل الدخول من جديد',
  noTotp: 'هذا الحساب بلا رمز تحقق مفعّل، فلا يمكنه الدخول. فعّله من سطر الأوامر على الخادم (create-admin --reset)',
  codeFirst: 'أدخل رمز التحقق أولًا',
  stepUp: 'أدخل رمز التحقق لتأكيد هذا الإجراء',
  noKey: 'لوحة الإدارة غير مهيأة: مفتاح رموز التحقق (TOTP_KEY) غير مضبوط',
});

const by = (req) => ({ actor: `admin:${req.admin?.username ?? '?'}`, ip: req.ip ?? null });

function locked(res, lockedMs) {
  res.set('Retry-After', String(Math.ceil(lockedMs / 1000)));
  return res.status(429).json({ error: `محاولات خاطئة كثيرة. أعد المحاولة بعد ${minutesText(lockedMs)}`, code: 'LOGIN_LOCKED' });
}

// What the panel knows of its session
export const meView = (admin, session, extra = {}) => ({
  admin: { username: admin.username },
  stage: session.stage,
  csrf: session.csrf,
  expiresAt: session.expiresAt,
  stepUpUntil: session.stage === 'full' && session.stepUpAt ? new Date(session.stepUpAt.getTime() + STEP_UP_MS) : null,
  ...extra,
});

/*
 * store: the admin sessions (lib/sessions.js, kind admin); guard: lib/login-guard.js.
 * Returns { publicRouter, session, codeRouter, requireFull, requireStepUp, router }:
 *   publicRouter  POST /auth/login (before any session)
 *   session       middleware: the request's admin session or 401 (req.adminSession, req.admin)
 *   codeRouter    POST /auth/code (stage code), GET /me and POST /auth/logout (either stage)
 *   requireFull   middleware: a full session only (403 for stage code)
 *   router        POST /step-up (full sessions)
 *   requireStepUp middleware for the riskiest routes: 403 STEP_UP_REQUIRED without a code
 *                 given in the last 5 minutes
 */
export function createAdminAuth({ db, config, store, guard, now = () => Date.now() }) {
  const { Admin, Session, AuditLog } = db.controlModels;
  const guardKey = (req, username) => ({ scope: 'admin', username, ip: req.ip ?? '' });
  const record = (req, action, details = {}, result = 'ok') =>
    AuditLog.record({ ...by(req), action, details, result }).catch((err) => console.error(`Could not log ${action}: ${err.message}`));
  // Passwords and codes per address per minute, in this process (config.adminSignInPerMinute),
  // behind nginx's own limit: a variant of the path nginx did not expect skips neither
  const signInLimit = rateLimit({
    windowMs: MINUTE,
    max: config.adminSignInPerMinute,
    key: (req) => req.ip ?? '',
    message: 'محاولات كثيرة من هذا العنوان. أعد المحاولة بعد دقيقة',
  });

  const publicRouter = Router(EXACT);
  publicRouter.post('/auth/login', signInLimit, requireSameOrigin(config), async (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > USERNAME_MAX || password.length > PASSWORD_MAX) {
      throw httpError(400, 'البيانات المرسلة غير صالحة', 'BAD_INPUT');
    }
    const name = username.trim().toLowerCase();
    if (!name || !password) throw httpError(400, 'اكتب اسم المستخدم وكلمة المرور', 'BAD_INPUT');
    if (!config.totpKey) throw httpError(503, ADMIN_MESSAGES.noKey, 'NOT_CONFIGURED');

    const key = guardKey(req, name);
    // One attempt of a name from an address at a time, so a burst cannot outrun the lock
    const release = guard.hold(key);
    if (!release) throw httpError(429, 'محاولة دخول أخرى بهذا الاسم جارية الآن. أعد المحاولة بعد لحظة', 'LOGIN_BUSY');
    let admin;
    try {
      const gate = await guard.check(key);
      if (gate.lockedMs) return locked(res, gate.lockedMs);
      if (gate.delayMs) await guard.wait(gate.delayMs);

      admin = await Admin.findOne({ username: name }).setOptions({ sanitizeFilter: true }).select('+passwordHash').lean();
      const hashBy = { key: key.ip };
      const ok = admin ? await verifyPassword(password, admin.passwordHash, hashBy) : await verifyDummy(password, hashBy);
      if (!ok) {
        const { lockedMs } = await guard.failed(key, { known: Boolean(admin) });
        // An admin's name, never what else was typed there (often the password itself)
        req.admin = { username: admin ? admin.username : '?' };
        await record(req, 'admin.login', { step: 'password' }, 'failed');
        if (lockedMs) return locked(res, lockedMs);
        throw httpError(401, ADMIN_MESSAGES.wrongLogin, 'LOGIN_FAILED');
      }
    } finally {
      release();
    }
    req.admin = admin;
    if (!admin.totp?.enabledAt) {
      await record(req, 'admin.login', { step: 'totp-not-enabled' }, 'failed');
      throw httpError(403, ADMIN_MESSAGES.noTotp, 'TOTP_REQUIRED');
    }
    // The failures of this address are cleared only once the code is right too
    const session = await store.start(req, res, { userId: admin._id, authVersion: admin.authVersion, stage: 'code', codeFailures: 0 });
    // One session at the code stage per admin: the others end, so sessions opened ahead
    // cannot add up to more tries. Deleted after this one is made, so sign-ins at the same
    // moment leave one at most.
    await store.endWhere({ userId: admin._id, stage: 'code', _id: { $ne: session._id } });
    const expiresAt = new Date(now() + CODE_STAGE_MS);
    await store.update(session, { expiresAt });
    res.json(meView(admin, { ...session, expiresAt }));
  });

  // The admin of a live session: there, with the same authVersion and an authenticator
  async function session(req, res, next) {
    const found = await store.find(req);
    const admin = found && (await Admin.findById(found.userId).lean());
    const valid = admin && admin.authVersion === found.authVersion && admin.totp?.enabledAt && (found.stage !== 'code' || found.createdAt.getTime() + CODE_STAGE_MS > now());
    if (!valid) {
      if (found) await store.endWhere({ _id: found._id });
      if (found || req.headers.cookie?.includes(store.cookieName)) store.clearCookie(res);
      return next(httpError(401, ADMIN_MESSAGES.expired, 'AUTH_EXPIRED'));
    }
    // A look the panel takes by itself (X-Poll: a job's progress) is not the admin at work:
    // it leaves the 30 minutes idle where they were
    req.adminSession = found.stage === 'full' && req.get('x-poll') !== '1' ? await store.touch(found) : found;
    // requireCsrf reads the token from here, as on the shops
    req.authSession = req.adminSession;
    req.admin = admin;
    next();
  }

  // Before a code is checked: the address's lock (it covers codes, not only passwords),
  // then one try taken from the session's five in the same write that finds one left, so
  // codes sent at once are never checked more than five times. Returns the session with
  // its count, or answers 429 (null).
  async function takeCodeTry(req, res) {
    const gate = await guard.check(guardKey(req, req.admin.username));
    if (gate.lockedMs) {
      locked(res, gate.lockedMs);
      return null;
    }
    if (gate.delayMs) await guard.wait(gate.delayMs);
    const taken = await Session.findOneAndUpdate(
      { _id: req.adminSession._id, codeFailures: { $lt: MAX_CODE_FAILURES } },
      { $inc: { codeFailures: 1 } },
      { returnDocument: 'after' },
    ).lean();
    if (!taken) {
      await store.end(req, res);
      throw httpError(401, ADMIN_MESSAGES.tooManyCodes, 'SESSION_ENDED');
    }
    return taken;
  }

  // A wrong code, its try already counted on the session: counted in the guard too; the
  // fifth ends the session
  async function wrongCode(req, res, taken) {
    const { lockedMs } = await guard.failed(guardKey(req, req.admin.username), { known: true });
    if (taken.codeFailures >= MAX_CODE_FAILURES) {
      await store.end(req, res);
      await record(req, 'admin.session.ended', { reason: 'wrong-codes' }, 'failed');
      throw httpError(401, ADMIN_MESSAGES.tooManyCodes, 'SESSION_ENDED');
    }
    await record(req, 'admin.code', { stage: req.adminSession.stage }, 'failed');
    if (lockedMs) return locked(res, lockedMs);
    throw httpError(401, `${ADMIN_MESSAGES.wrongCode}. بقيت ${MAX_CODE_FAILURES - taken.codeFailures} محاولات`, 'CODE_FAILED');
  }

  const codeOf = (body) => ({
    code: typeof body.code === 'string' ? body.code.slice(0, 20) : undefined,
    recoveryCode: typeof body.recoveryCode === 'string' ? body.recoveryCode.slice(0, 40) : undefined,
  });

  const codeRouter = Router(EXACT);
  codeRouter.get('/me', (req, res) => {
    res.json(meView(req.admin, req.adminSession));
  });
  codeRouter.post('/auth/code', signInLimit, async (req, res) => {
    if (req.adminSession.stage !== 'code') return res.json(meView(req.admin, req.adminSession));
    const taken = await takeCodeTry(req, res);
    if (!taken) return;
    const method = await checkSecondFactor({ db, config }, req.admin._id, codeOf(req.body));
    if (!method) return wrongCode(req, res, taken);
    await guard.succeeded(guardKey(req, req.admin.username));
    // A new session id once fully signed in, with the step-up already given
    const full = await store.start(req, res, { userId: req.admin._id, authVersion: req.admin.authVersion, stage: 'full', stepUpAt: new Date(now()), codeFailures: 0 });
    await Admin.updateOne({ _id: req.admin._id }, { $set: { lastLoginAt: new Date() } });
    await record(req, 'admin.login', { method });
    const extra = method === 'recovery' ? { recoveryCodesLeft: await recoveryCodesLeft({ db }, req.admin._id) } : {};
    res.json(meView(req.admin, full, extra));
  });
  // Either stage: «الدخول بحساب آخر» at the code stage ends the session the password opened
  codeRouter.post('/auth/logout', async (req, res) => {
    await store.end(req, res);
    await record(req, 'admin.logout');
    res.status(204).end();
  });

  function requireFull(req, res, next) {
    if (req.adminSession?.stage === 'full') return next();
    next(httpError(403, ADMIN_MESSAGES.codeFirst, 'CODE_REQUIRED'));
  }

  function requireStepUp(req, res, next) {
    const at = req.adminSession?.stepUpAt?.getTime() ?? 0;
    if (now() - at <= STEP_UP_MS) return next();
    next(httpError(403, ADMIN_MESSAGES.stepUp, 'STEP_UP_REQUIRED'));
  }

  const router = Router(EXACT);
  router.post('/step-up', signInLimit, async (req, res) => {
    const taken = await takeCodeTry(req, res);
    if (!taken) return;
    const method = await checkSecondFactor({ db, config }, req.admin._id, codeOf(req.body));
    if (!method) return wrongCode(req, res, taken);
    const stepUpAt = new Date(now());
    await store.update(req.adminSession, { stepUpAt, codeFailures: 0 });
    res.json(meView(req.admin, { ...req.adminSession, stepUpAt }));
  });

  return { publicRouter, session, codeRouter, requireFull, requireStepUp, router, csrf: requireCsrf(config) };
}
