// Talking to the shop's server, for every page and for the sign-in page. Nothing runs on
// load, so the sign-in page can use it without common.js (whose start-up would send a
// signed-out browser back to the sign-in page). Errors are ApiError with a code the pages
// act on: AUTH_EXPIRED (401, sign in again), PASSWORD_CHANGE_REQUIRED (403), CSRF_FAILED
// (403), TENANT_SUSPENDED (423), TENANT_MOVED or TENANT_DELETED (410), NETWORK (no answer).

export class ApiError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// What a status means when the answer did not say
const CODE_BY_STATUS = { 401: 'AUTH_EXPIRED', 410: 'TENANT_MOVED', 423: 'TENANT_SUSPENDED' };
const SAFE_METHODS = new Set(['GET', 'HEAD']);

// The session's token, sent with every request that changes something (X-CSRF-Token). It
// comes with signing in and with GET /api/auth/me.
let csrfToken = null;
export const hasCsrf = () => Boolean(csrfToken);

// The account's role and permissions (public/js/permissions.js), kept in this browser so the
// next page hides what the account cannot use before the server answers (common.js). Only
// names of permissions: the server checks every request anyway.
const ACCESS_KEY = 'pos.access';
export function rememberAccess(me) {
  try {
    if (me) localStorage.setItem(ACCESS_KEY, JSON.stringify({ role: me.role, permissions: me.permissions ?? [] }));
    else localStorage.removeItem(ACCESS_KEY);
  } catch {
    // storage blocked (or not a browser): the page waits for the server
  }
}
export function rememberedAccess() {
  try {
    const access = JSON.parse(localStorage.getItem(ACCESS_KEY));
    return typeof access?.role === 'string' && Array.isArray(access.permissions) ? access : null;
  } catch {
    return null;
  }
}

// One JSON request to /api. Returns the answer's data (null for 204); throws ApiError.
export async function request(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!SAFE_METHODS.has(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('تعذر الاتصال بالخادم. تأكد أن التطبيق يعمل.', { code: 'NETWORK' });
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(data?.error || `تعذر إتمام الطلب (${res.status})`, { status: res.status, code: data?.code || CODE_BY_STATUS[res.status] || '' });
  }
  if (typeof data?.csrf === 'string') {
    csrfToken = data.csrf;
    if (typeof data.role === 'string') rememberAccess(data);
  }
  return data;
}

export const fetchMe = () => request('/auth/me');
export const signIn = (username, password) => request('/auth/login', { method: 'POST', body: { username, password } });
export const changePassword = (currentPassword, newPassword) => request('/auth/password', { method: 'POST', body: { currentPassword, newPassword } });

// Answers that say this browser has no session left: ended already, or the shop is closed,
// moved or gone (each of which ended every session)
const NO_SESSION = new Set(['AUTH_EXPIRED', 'TENANT_SUSPENDED', 'TENANT_MOVED', 'TENANT_DELETED']);

// Ends this browser's session. A token made stale by signing in again in another tab is
// fetched again and the sign-out sent once more. Resolves once no session is left; throws
// (ApiError) when one may still be there (offline, refused), so the page stays as it is.
export async function signOut() {
  const send = () => request('/auth/logout', { method: 'POST' });
  try {
    await send().catch(async (err) => {
      if (err.code !== 'CSRF_FAILED') throw err;
      await fetchMe();
      return send();
    });
  } catch (err) {
    if (!NO_SESSION.has(err.code)) throw err;
  }
  csrfToken = null;
  rememberAccess(null);
}

// Where to go after signing in: a path on this address only (never "//" or "/\", which
// browsers read as another site), and never back to the sign-in page
export function safeNext(value, fallback = '/cashier.html') {
  const next = String(value ?? '');
  const local = /^\/(?![/\\])/.test(next) && !/[\u0000-\u001f\\]/.test(next) && next.length <= 512;
  return local && !next.startsWith('/login.html') ? next : fallback;
}

export const loginUrl = (next = `${location.pathname}${location.search}`) => `/login.html?next=${encodeURIComponent(safeNext(next, '/'))}`;

// The rules the server checks again (lib/passwords.js): letters, Arabic included, not bytes
export const PASSWORD_MIN = 10;
export const passwordLength = (value) => [...String(value ?? '')].length;
