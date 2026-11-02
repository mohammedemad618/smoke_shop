const moneyFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
// Arabic wording with Latin digits, matching prices and barcodes
const dateTimeFormat = new Intl.DateTimeFormat('ar-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
const timeFormat = new Intl.DateTimeFormat('ar-u-nu-latn', { timeStyle: 'short' });

export const formatMoney = (n) => moneyFormat.format(Number(n) || 0);
export const formatDateTime = (d) => dateTimeFormat.format(new Date(d));
export const formatTime = (d) => timeFormat.format(new Date(d));
export const roundMoney = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

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

export const PRODUCTS = { one: 'منتج واحد', two: 'منتجان', few: 'منتجات', many: 'منتجًا', single: 'منتج' };
export const INVOICES = { one: 'فاتورة واحدة', two: 'فاتورتان', few: 'فواتير', many: 'فاتورة', single: 'فاتورة' };
export const PIECES = { one: 'قطعة واحدة', two: 'قطعتان', few: 'قطع', many: 'قطعة', single: 'قطعة' };
