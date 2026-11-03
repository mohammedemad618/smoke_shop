// Server-side sessions in pos_control, for the shops now and the admin panel later. The
// browser holds only a random value in an HttpOnly cookie; the database holds its SHA-256,
// so a session ends the moment its record is deleted, and a copy of the collection opens
// nothing. Over https the cookie is __Host-<name>: Secure, Path=/ and no Domain, so no other
// site under sslip.io can set or read it. Only in development over plain http (PUBLIC_SCHEME
// http) does it drop the prefix and Secure, which http cannot carry.
import { createHash, randomBytes } from 'node:crypto';

const HOUR = 60 * 60 * 1000;

// What each kind of session allows. A shop's stays signed in for 72 hours without use and
// 14 days at most; the admin's for 30 minutes and 8 hours, with SameSite=Strict.
export const SESSION_KINDS = Object.freeze({
  tenant: Object.freeze({ cookie: 'pos_sid', idleMs: 72 * HOUR, absoluteMs: 14 * 24 * HOUR, sameSite: 'lax' }),
  admin: Object.freeze({ cookie: 'pos_admin', idleMs: HOUR / 2, absoluteMs: 8 * HOUR, sameSite: 'strict' }),
});
// lastSeenAt is written at most this often, not on every request
const TOUCH_MS = 5 * 60 * 1000;

export const hashToken = (value) => createHash('sha256').update(value).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

// The value of one cookie from the Cookie header, or null. The first one wins, as browsers
// send the most specific first.
export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || null;
  }
  return null;
}

/*
 * The sessions of one kind. config gives the scheme (the cookie's name and Secure);
 * `now` is for the tests. Returns:
 *   cookieName
 *   find(req) -> the session the request's cookie names, if it is of this kind and has not
 *     expired (an expired one is deleted), else null. Its _id is the hash, never the cookie.
 *   touch(session) -> moves the idle limit on, at most every 5 minutes
 *   start(req, res, fields) -> a new session with its own CSRF token, the cookie set; the
 *     session the request came with, if any, is deleted (a new id at every sign-in)
 *   end(req, res) -> deletes the request's session and clears the cookie
 *   update(session, fields) -> changes fields of a session (its authVersion after a new
 *     password)
 *   endWhere(filter) -> deletes the sessions of this kind matching filter
 */
export function createSessionStore({ Session, config, kind, now = () => Date.now() }) {
  const rules = SESSION_KINDS[kind];
  if (!rules) throw new Error(`Unknown session kind: ${kind}`);
  const secure = config.publicScheme === 'https';
  const cookieName = secure ? `__Host-${rules.cookie}` : rules.cookie;
  const cookieOptions = { httpOnly: true, secure, sameSite: rules.sameSite, path: '/' };
  const expiresAt = (createdAt, at) => new Date(Math.min(at + rules.idleMs, createdAt.getTime() + rules.absoluteMs));

  async function find(req) {
    const value = readCookie(req, cookieName);
    // A real value is 43 characters; anything far off is not worth a query
    if (!value || value.length > 100) return null;
    const session = await Session.findById(hashToken(value)).lean();
    if (!session || session.kind !== kind) return null;
    if (session.expiresAt.getTime() <= now()) {
      await Session.deleteOne({ _id: session._id });
      return null;
    }
    return session;
  }

  async function touch(session) {
    const at = now();
    if (at - session.lastSeenAt.getTime() < TOUCH_MS) return session;
    const changes = { lastSeenAt: new Date(at), expiresAt: expiresAt(session.createdAt, at) };
    await Session.updateOne({ _id: session._id }, { $set: changes });
    return { ...session, ...changes };
  }

  async function start(req, res, fields) {
    const previous = readCookie(req, cookieName);
    if (previous && previous.length <= 100) await Session.deleteOne({ _id: hashToken(previous) });
    const value = newToken();
    const at = new Date(now());
    const session = await Session.create({
      ...fields,
      _id: hashToken(value),
      kind,
      csrf: newToken(),
      createdAt: at,
      lastSeenAt: at,
      expiresAt: expiresAt(at, at.getTime()),
      ip: req.ip ?? null,
      ua: String(req.headers['user-agent'] ?? '').slice(0, 200),
    });
    // The browser keeps it no longer than the absolute limit; the server decides the rest
    res.cookie(cookieName, value, { ...cookieOptions, maxAge: rules.absoluteMs });
    return session.toObject();
  }

  async function end(req, res) {
    const value = readCookie(req, cookieName);
    if (value && value.length <= 100) await Session.deleteOne({ _id: hashToken(value) });
    res.clearCookie(cookieName, cookieOptions);
  }

  const update = (session, fields) => Session.updateOne({ _id: session._id, kind }, { $set: fields });
  const endWhere = (filter) => Session.deleteMany({ ...filter, kind });

  return { cookieName, find, touch, start, end, update, endWhere, clearCookie: (res) => res.clearCookie(cookieName, cookieOptions) };
}
