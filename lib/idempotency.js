// Writes that must happen once even when sent twice: a sale, a purchase, a return. The
// browser makes an id for each one (body.clientId, e.g. one per cart) and sends the same id
// again when the answer was lost (the network, a session that ended mid-sale). The id is
// unique in the database, so the second request finds the first one's record and answers
// with it (200), changing nothing; requests without an id (older pages, scripts) are
// recorded as before.
import { httpError } from './errors.js';

const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

// The request's id, or null when it has none
export function clientIdOf(body) {
  const value = body?.clientId;
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !CLIENT_ID.test(value)) throw httpError(400, 'رقم الطلب غير صالح. حدّث الصفحة وأعد المحاولة');
  return value;
}

// A unique index refused the write because of `field` (another request with the same id
// got there first)
export const isDuplicateOf = (err, field) => err?.code === 11000 && Object.hasOwn(err.keyPattern ?? {}, field);
