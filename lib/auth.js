// Who is signed in to a shop. Every request past the public files and endpoints must carry a
// session (lib/sessions.js) that is of kind tenant, belongs to the shop of the request's
// address and was made with the user's current authVersion; otherwise /api answers 401 and a
// page sends the browser to the sign-in page, coming back afterwards. A request without a
// cookie is refused before the shop's database is opened. While the first password has not
// been changed, nothing but the account's own routes can be used (403).
import { httpError } from './errors.js';

export const AUTH_MESSAGES = Object.freeze({
  expired: 'انتهت الجلسة. سجّل الدخول من جديد',
  wrongLogin: 'اسم المستخدم أو كلمة المرور غير صحيحة',
  mustChange: 'غيّر كلمة المرور المؤقتة أولًا',
  badInput: 'البيانات المرسلة غير صالحة',
  wrongCurrent: 'كلمة المرور الحالية غير صحيحة',
  samePassword: 'كلمة المرور الجديدة يجب أن تختلف عن الحالية',
});

export const isApiPath = (req) => req.path === '/api' || req.path.startsWith('/api/');

// A path on this address to come back to after signing in, or null: one leading slash
// (never "//" or "/\", which browsers read as another site) and nothing odd
export function localPath(value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  if (!/^\/(?![/\\])/.test(value) || /[\u0000-\u001f\\]/.test(value)) return null;
  return value;
}

const signInUrl = (req) => `/login.html?next=${encodeURIComponent(localPath(req.originalUrl) ?? '/')}`;

// /api gets 401 JSON; asking for a page goes to the sign-in page
function notSignedIn(req, res, next) {
  if (!isApiPath(req) && (req.method === 'GET' || req.method === 'HEAD')) return res.redirect(302, signInUrl(req));
  next(httpError(401, AUTH_MESSAGES.expired, 'AUTH_EXPIRED'));
}

export function requireTenantSession({ db, store }) {
  return async function checkSession(req, res, next) {
    const session = await store.find(req);
    if (!session || String(session.tenantId) !== String(req.tenant._id)) {
      // A cookie that names no session of this shop is of no use to keep
      if (session || req.headers.cookie?.includes(store.cookieName)) store.clearCookie(res);
      return notSignedIn(req, res, next);
    }
    req.models ??= await db.tenantModels(req.tenant);
    const user = await req.models.User.findById(session.userId).lean();
    // The password was changed or reset since (authVersion), or the account was closed. A
    // version the session does not have may be its own change under way (routes/auth.js
    // marks the session before the user), so it is read again before it is ended.
    const current = (s) => Boolean(s) && (s.authVersion === user.authVersion || s.nextAuthVersion === user.authVersion);
    const live = user && !user.disabledAt ? (current(session) ? session : await store.find(req)) : null;
    if (!current(live)) {
      await store.endWhere({ _id: session._id });
      store.clearCookie(res);
      return notSignedIn(req, res, next);
    }
    req.authSession = await store.touch(live);
    req.user = user;
    next();
  };
}

// After the account's own routes (routes/auth.js): a first password still unchanged keeps
// everything else closed, the pages included
export function requirePasswordChanged() {
  return function checkPasswordChanged(req, res, next) {
    if (!req.user?.mustChangePassword) return next();
    if (!isApiPath(req) && (req.method === 'GET' || req.method === 'HEAD')) return res.redirect(302, signInUrl(req));
    next(httpError(403, AUTH_MESSAGES.mustChange, 'PASSWORD_CHANGE_REQUIRED'));
  };
}

// What the browser knows of its session (GET /api/auth/me and the sign-in answers)
export const sessionInfo = (user, session) => ({
  user: { username: user.usernameLower, displayName: user.displayName || user.usernameLower },
  role: user.role,
  csrf: session.csrf,
  expiresAt: session.expiresAt,
  mustChangePassword: Boolean(user.mustChangePassword),
});
