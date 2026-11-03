const moneyFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
// Arabic wording with Latin digits, matching prices and barcodes
const dateTimeFormat = new Intl.DateTimeFormat('ar-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
const timeFormat = new Intl.DateTimeFormat('ar-u-nu-latn', { timeStyle: 'short' });

// Rounds half away from zero on the number as written, not on its binary value (10.075 is
// stored as 10.07499999...). The same function is in lib/util.js, so the screen shows
// exactly what the server saves.
export function roundTo(n, digits) {
  const x = Number(n);
  if (!Number.isFinite(x)) return x;
  const written = Math.abs(x).toString();
  const rounded = written.includes('e')
    ? Math.round(Math.abs(x) * 10 ** digits) / 10 ** digits
    : Number(`${Math.round(Number(`${written}e${digits}`))}e-${digits}`);
  return Math.sign(x) * rounded || 0; // || 0: never -0
}
export const roundMoney = (n) => roundTo(n, 2);

// Rounded first, so a figure shows what is saved and never as "-0"
export const formatMoney = (n) => moneyFormat.format(roundMoney(Number(n) || 0));
export const formatDateTime = (d) => dateTimeFormat.format(new Date(d));
export const formatTime = (d) => timeFormat.format(new Date(d));

// A number as people type it: Arabic-Indic digits, the Arabic decimal mark and thousands
// separators are read ("١٬٥٠٠" and "1,500" are 1500, "٢٫٥" is 2.5). Anything else is NaN,
// never quietly 0.
export const latinDigits = (text) =>
  String(text ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/٫/g, '.');
export function parseNumber(text) {
  const s = latinDigits(text).trim().replace(/[,٬\s]/g, '');
  return /^(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
}

// For searching Arabic names: أ/إ/آ count as ا, ة as ه, ى as ي, and diacritics are ignored
export const normalizeArabic = (s) =>
  s.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[ً-ْ]/g, '');

// Calendar dates in this browser's time zone, keyed as YYYY-MM-DD and YYYY-MM
const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export const parseKey = (key) => {
  const [y, m, d = 1] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);

// Quantities: pieces are whole, weights are kept to the gram
const qtyFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
export const roundQty = (n) => roundTo(n, 3);
export const formatQty = (n) => qtyFormat.format(roundQty(Number(n) || 0));
// Under a kilo reads better in grams: 0.06 -> "60 غ", 1.5 -> "1.5 كغم"
export const formatWeight = (kg) => {
  const q = roundQty(Number(kg) || 0);
  return q < 1 ? `${formatQty(Math.round(q * 1000))} غ` : `${formatQty(q)} كغم`;
};

// "علبة (10 قطع)" for a box of pieces, "كيس (10 كغم)" for a wholesale weight
export function packName(unit, size) {
  return unit === 'kg' ? `كيس (${formatQty(size)} كغم)` : `علبة (${arCount(size, PIECES)})`;
}

// A quantity in its unit, e.g. "250 غ", "1.5 كغم", "3 × علبة (10 قطع)", "4"
export function qtyLabel({ unit, mode, packSize, quantity }) {
  if (mode === 'wholesale') return `${formatQty(quantity)} × ${packName(unit, packSize)}`;
  return unit === 'kg' ? formatWeight(quantity) : formatQty(quantity);
}

// Midnight to midnight of `date` in this browser's time zone, as the sales API's
// from/to query. The server may run in another time zone (UTC on the VPS).
export function dayQuery(date) {
  const from = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const to = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return new URLSearchParams({ from: from.toISOString(), to: to.toISOString() }).toString();
}

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('تعذر الاتصال بالخادم. تأكد أن التطبيق يعمل.');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw Object.assign(new Error(data?.error || `تعذر إتمام الطلب (${res.status})`), { status: res.status });
  }
  return data;
}

// What happens to the money of a return: off a credit customer's debt, back in cash, or both
export function refundMessage(cash, toAccount, customerName) {
  const parts = [];
  if (toAccount > 0) parts.push(`خُصم ${formatMoney(toAccount)} من دين ${customerName}`);
  if (cash > 0) parts.push(`أعد للزبون ${formatMoney(cash)} نقدًا`);
  return parts.join('، و') || 'لا يوجد مبلغ يُعاد';
}

export function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = type === 'error' ? 'toast is-error' : 'toast';
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 4500 : 2600);
}

// Arabic counted nouns: 1 and 2 have their own forms, 3-10 plural, 11-99 singular accusative
export function arCount(n, forms) {
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  const rest = n % 100;
  const noun = rest >= 3 && rest <= 10 ? forms.few : rest >= 11 ? forms.many : forms.single;
  return `${formatMoney(n)} ${noun}`;
}

// On phones, tables are shown as cards (see style.css): every cell gets its column name
// as a label, and a row's first cell becomes the card's title. Tables are re-rendered
// often, so this follows DOM changes instead of being called by each page.
let labelQueued = false;
function labelTableCells() {
  labelQueued = false;
  for (const table of document.querySelectorAll('table.ptable:not(.keep-table)')) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    for (const row of table.querySelectorAll('tbody tr, tfoot tr')) {
      const cells = [...row.children];
      if (cells.some((td) => td.colSpan > 1)) continue; // detail rows span the whole table
      cells.forEach((td, i) => {
        if (heads[i] && !td.dataset.label) td.dataset.label = heads[i];
      });
      cells.find((td) => !td.classList.contains('rank'))?.classList.add('cell-title');
    }
  }
}
new MutationObserver(() => {
  if (labelQueued) return;
  labelQueued = true;
  requestAnimationFrame(labelTableCells);
}).observe(document.body, { childList: true, subtree: true });

// The menu's "المزيد" button opens the pages used less often; a click elsewhere or
// Escape closes it
const more = document.querySelector('.nav-more');
if (more) {
  const button = more.querySelector('.nav-more-btn');
  const menu = more.querySelector('.more-menu');
  const setOpen = (open) => {
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', () => setOpen(menu.hidden));
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !more.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      setOpen(false);
      button.focus();
    }
  });
}

export const PRODUCTS = { one: 'منتج واحد', two: 'منتجان', few: 'منتجات', many: 'منتجًا', single: 'منتج' };
export const INVOICES = { one: 'فاتورة واحدة', two: 'فاتورتان', few: 'فواتير', many: 'فاتورة', single: 'فاتورة' };
export const PIECES = { one: 'قطعة واحدة', two: 'قطعتان', few: 'قطع', many: 'قطعة', single: 'قطعة' };
export const EXPENSES = { one: 'مصروف واحد', two: 'مصروفان', few: 'مصاريف', many: 'مصروفًا', single: 'مصروف' };
