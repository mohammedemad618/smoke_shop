// Talking to /api/admin. Every write sends the session's CSRF token; an answer that needs
// the authenticator code again (STEP_UP_REQUIRED) asks for it once (the page's handler) and
// sends the same request again; an ended session hands over to the sign-in screen.

export class ApiError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

let csrfToken = null;
let handlers = { stepUp: null, signedOut: null };

export const setCsrf = (token) => {
  csrfToken = typeof token === 'string' ? token : null;
};
export const setHandlers = (next) => {
  handlers = { ...handlers, ...next };
};

const SAFE = new Set(['GET', 'HEAD']);

async function send(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!SAFE.has(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  try {
    return await fetch(`/api/admin${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError('تعذّر الاتصال بالخادم. تحقق من الاتصال وأعد المحاولة.', { code: 'NETWORK' });
  }
}

async function failure(res) {
  const data = await res.json().catch(() => null);
  return new ApiError(data?.error || `تعذّر إتمام الطلب (${res.status})`, { status: res.status, code: data?.code || '' });
}

// One JSON request. Returns the answer's data (null for 204); throws ApiError.
export async function request(path, options = {}, retried = false) {
  const res = await send(path, options);
  if (res.status === 204) return null;
  if (!res.ok) {
    const err = await failure(res);
    if (err.code === 'STEP_UP_REQUIRED' && !retried && handlers.stepUp && (await handlers.stepUp())) return request(path, options, true);
    if ((err.code === 'AUTH_EXPIRED' || err.code === 'SESSION_ENDED') && handlers.signedOut) handlers.signedOut(err);
    throw err;
  }
  const data = await res.json().catch(() => null);
  if (typeof data?.csrf === 'string') csrfToken = data.csrf;
  return data;
}

// A file from the API (the CSV exports), saved through a link the page clicks itself
export async function download(path, retried = false) {
  const res = await send(path);
  if (!res.ok) {
    const err = await failure(res);
    if (err.code === 'STEP_UP_REQUIRED' && !retried && handlers.stepUp && (await handlers.stepUp())) return download(path, true);
    if ((err.code === 'AUTH_EXPIRED' || err.code === 'SESSION_ENDED') && handlers.signedOut) handlers.signedOut(err);
    throw err;
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'export.csv';
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
