// Building the admin panel's elements. Text goes in as text only (textContent, text nodes),
// never as HTML: whatever a shop's owner typed (its name, a receipt note), a browser's user
// agent or an audit entry shows as the characters it is. The page's policy enforces it too
// (Trusted Types with no policy: any string given to innerHTML throws), and h() refuses the
// HTML properties outright. No side effects on import, so the tests can run it.

const REFUSED = new Set(['innerHTML', 'outerHTML', 'srcdoc', 'insertAdjacentHTML']);
const SAFE_URL = /^(#|\/(?![/\\])|https?:\/\/|blob:)/;

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    el.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

/*
 * h('a', { className: 'btn', href: '#/new', text: 'متجر جديد' }, ...children)
 *   text      the element's whole text
 *   attrs     attributes ({ 'aria-label': '...', dir: 'ltr' }); true sets an empty one
 *   on        listeners ({ click: fn })
 *   dataset   data-* values
 *   anything else is set as a property (type, value, hidden, disabled, htmlFor, id...)
 * Children are elements or strings (made text nodes); null, false and '' are skipped.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null) continue;
    if (REFUSED.has(key)) throw new Error(`h(): ${key} is not allowed`);
    if (key === 'text') el.textContent = String(value);
    else if (key === 'attrs') {
      for (const [name, v] of Object.entries(value)) if (v !== undefined && v !== null && v !== false) el.setAttribute(name, v === true ? '' : String(v));
    } else if (key === 'on') {
      for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn);
    } else if (key === 'dataset') {
      for (const [name, v] of Object.entries(value)) el.dataset[name] = String(v);
    } else if (key === 'href') {
      if (!SAFE_URL.test(String(value))) throw new Error(`h(): unsafe link ${value}`);
      el.href = String(value);
    } else {
      el[key] = value;
    }
  }
  append(el, children);
  return el;
}

// Replaces an element's children
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

/* Formats: Arabic wording with Latin digits, like the shop's pages */

const dateFormat = new Intl.DateTimeFormat('ar-u-nu-latn', { dateStyle: 'medium' });
const dateTimeFormat = new Intl.DateTimeFormat('ar-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

const asDate = (value) => (value ? new Date(value) : null);
const valid = (d) => d && !Number.isNaN(d.getTime());

export const formatDate = (value) => (valid(asDate(value)) ? dateFormat.format(asDate(value)) : '—');
export const formatDateTime = (value) => (valid(asDate(value)) ? dateTimeFormat.format(asDate(value)) : '—');
export const formatNumber = (n) => (Number.isFinite(Number(n)) && n !== null && n !== undefined ? numberFormat.format(Number(n)) : '—');

// "512 بايت", "12.4 ك.ب", "3.1 م.ب", "1.2 غ.ب"
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || bytes === null || bytes === undefined) return '—';
  if (n < 1024) return `${numberFormat.format(n)} بايت`;
  const units = ['ك.ب', 'م.ب', 'غ.ب'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${numberFormat.format(value)} ${units[unit]}`;
}

// "قبل 5 دقائق", "قبل 3 ساعات", "قبل يومين", else the date
export function formatAgo(value, now = Date.now()) {
  const d = asDate(value);
  if (!valid(d)) return '—';
  const minutes = Math.floor((now - d.getTime()) / 60000);
  if (minutes < 1) return 'الآن';
  if (minutes < 60) return `قبل ${count(minutes, ['دقيقة', 'دقيقتين', 'دقائق', 'دقيقة'])}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `قبل ${count(hours, ['ساعة', 'ساعتين', 'ساعات', 'ساعة'])}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `قبل ${count(days, ['يوم', 'يومين', 'أيام', 'يومًا'])}`;
  return formatDate(d);
}

// The moment `zone`'s clock reads midnight at the start of day y-m-d (month 1 to 12; 13 is
// January of the next year): the zone's offset is read for that day, and read again at the
// moment found, for a day whose clocks change
function zoneMidnight(y, m, d, zone) {
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const offset = (at) => {
    const p = Object.fromEntries(clock.formatToParts(new Date(at)).map((part) => [part.type, Number(part.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at;
  };
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - offset(wall);
  return new Date(wall - offset(first));
}

// A month ('YYYY-MM') of the shop's calendar, midnight to midnight on its own clock (its
// time zone), as the from/to of the API: the owner's figures for that month, wherever the
// admin's own computer is. Null for anything else.
export function monthRange(month, zone) {
  const [y, m] = String(month ?? '').split('-').map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return null;
  return { from: zoneMidnight(y, m, 1, zone), to: zoneMidnight(y, m + 1, 1, zone) };
}

// 1 and 2 have their own words, 3 to 10 the plural, 11 and up the singular
function count(n, [one, two, few, many]) {
  if (n === 1) return one;
  if (n === 2) return two;
  return n % 100 >= 3 && n % 100 <= 10 ? `${n} ${few}` : `${n} ${many}`;
}
