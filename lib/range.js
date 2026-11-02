import { httpError } from './errors.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

// The browser sends its own midnight-to-midnight range as ?from=&to= (ISO), so a day
// follows the shop's clock even when the server runs in UTC. Without them, fall back
// to today on the server's clock.
export function requestedRange({ from, to }, maxMs) {
  const start = new Date(String(from ?? ''));
  const end = new Date(String(to ?? ''));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { start: today, end: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1) };
  }
  if (end <= start || end - start > maxMs) throw httpError(400, 'نطاق التاريخ غير صالح');
  return { start, end };
}

// IANA name from the browser (e.g. Asia/Baghdad), used to cut periods at local midnight
export function timeZoneParam(value) {
  const timeZone = String(value ?? 'UTC');
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return timeZone;
  } catch {
    throw httpError(400, 'المنطقة الزمنية غير صالحة');
  }
}
