// One rounding function for the screen and the server (lib/util.js imports it too), so
// the screen shows exactly what the server saves
import { roundTo } from './rounding.js';
import { ApiError, request, fetchMe, hasCsrf, signIn, signOut, loginUrl, rememberedAccess } from './auth.js';
import { PERMISSION_KEYS, allows, allowsPage } from './permissions.js';

const moneyFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
// Arabic wording with Latin digits, matching prices and barcodes
const dateTimeFormat = new Intl.DateTimeFormat('ar-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
const timeFormat = new Intl.DateTimeFormat('ar-u-nu-latn', { timeStyle: 'short' });

export { roundTo };
export const roundMoney = (n) => roundTo(n, 2);
// A sale line's amount, up to the shop's «أصغر فئة نقدية» when it rounds: the server's own
// function, so the cashier shows what the server charges
export { roundUpTo, lineAmount } from './rounding.js';
// Whether a line's unit price times its quantity is its amount. A line rounded up shows its
// quantity and amount only: never a unit price that does not multiply to the amount shown.
export const priceAddsUp = (unitPrice, quantity, amount) => roundMoney(unitPrice * quantity) === amount;

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

export { ApiError };

// The page cannot be used signed out: to the sign-in page, and back here afterwards
function goToLogin() {
  location.assign(loginUrl());
  return new Promise(() => {}); // the page is leaving: whoever waits on this waits for ever
}

/*
 * A request to the shop's API. Every write sends the session's CSRF token. A read that
 * finds the session over (401) or the first password unchanged goes to the sign-in page;
 * a write never leaves the page: it throws an ApiError whose code says why (AUTH_EXPIRED,
 * TENANT_SUSPENDED, TENANT_MOVED...), so the page keeps what was typed and can sign in
 * again in place (signInAgain) and send the same request again. A closed shop also shows
 * a banner at the top of the page.
 */
export async function api(path, { method = 'GET', body } = {}) {
  const write = method !== 'GET' && method !== 'HEAD';
  if (write && !hasCsrf()) await session;
  try {
    const data = await sendOnce(path, method, body, write);
    hideBanner();
    return data;
  } catch (err) {
    if (err.code === 'TENANT_SUSPENDED' || err.code === 'TENANT_MOVED' || err.code === 'TENANT_DELETED') showBanner(err.message);
    if (!write && (err.code === 'AUTH_EXPIRED' || err.code === 'PASSWORD_CHANGE_REQUIRED')) return goToLogin();
    throw err;
  }
}

// Signed in again in another tab, this one's token is stale: fetch the current one and send
// the write once more (it was refused before doing anything)
async function sendOnce(path, method, body, write) {
  try {
    return await request(path, { method, body });
  } catch (err) {
    if (!write || err.code !== 'CSRF_FAILED') throw err;
    const fresh = await fetchMe().catch(() => null);
    if (!fresh) throw err;
    account = fresh;
    setAccess(fresh);
    return request(path, { method, body });
  }
}

// A random id for one sale, purchase or return, sent again with the same request so the
// server records it once (lib/idempotency.js). From getRandomValues, which works on any
// address, unlike randomUUID.
export function newClientId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
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

/* The signed-in account */

// GET /api/auth/me: the account's name for the menu, its role and permissions, and the CSRF token
let account = null;
const EXPIRY_WARNING_MS = 8 * 60 * 60 * 1000;

function showAccount() {
  const name = account?.user?.displayName || account?.user?.username || '';
  for (const el of document.querySelectorAll('[data-username]')) el.textContent = name;
}

/*
 * What the account may use (public/js/permissions.js), as last known: from the server once
 * it answers, and until then as this browser last saw it (auth.js), so a staff account's
 * page does not show the owner's menu first. The page is marked for the styles: <html>
 * gets lacks-<key> for each permission the account does not have (lacks-owner for anyone
 * but the owner), which hides every element with data-need naming it (style.css). Links to
 * pages the account cannot open leave the menu. Unknown (offline at the first page) hides
 * nothing: the server refuses what is not allowed either way.
 */
let access = rememberedAccess();
export const can = (key) => (access ? allows(access, key) : true);
// Whether the account may open the page at `path` (a link to it is worth showing)
export const canOpen = (path) => (access ? allowsPage(access, path) : true);
export const isOwnerAccount = () => access?.role === 'owner';

function applyAccess() {
  const root = document.documentElement;
  for (const key of [...PERMISSION_KEYS, 'owner']) root.classList.toggle(`lacks-${key}`, Boolean(access) && !allows(access, key));
  for (const link of document.querySelectorAll('.nav a[href], .more-menu a[href]')) {
    link.hidden = Boolean(access) && !allowsPage(access, new URL(link.href, location.href).pathname);
  }
}
applyAccess();

function setAccess(me) {
  if (!me?.role) return;
  access = { role: me.role, permissions: me.permissions ?? [] };
  applyAccess();
}

async function loadSession() {
  try {
    account = await fetchMe();
  } catch (err) {
    if (err.code === 'AUTH_EXPIRED' || err.code === 'PASSWORD_CHANGE_REQUIRED') return goToLogin();
    return null; // offline: the page works with what it has, and writes say so
  }
  showAccount();
  setAccess(account);
  // A session lasts 14 days at most: say so before it ends in the middle of a sale
  if (new Date(account.expiresAt) - Date.now() < EXPIRY_WARNING_MS) {
    setTimeout(() => toast('تنتهي جلستك بعد أقل من 8 ساعات. سجّل الخروج ثم الدخول لتبدأ جلسة جديدة'), 1500);
  }
  return account;
}
export const session = loadSession();

// Signing out ends the shift on this tab: its cart and the rest it kept go with it. Only
// once the server has ended the session: a sign-out that did not get through leaves the
// page as it is and says so, rather than the sign-in page sending a live session back in.
for (const button of document.querySelectorAll('[data-logout]')) {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await signOut();
    } catch {
      button.disabled = false;
      toast('تعذّر تسجيل الخروج، أعد المحاولة', 'error');
      return;
    }
    try {
      sessionStorage.clear();
    } catch {
      // storage blocked: nothing was kept
    }
    location.assign('/login.html');
  });
}

// One line across the top while the shop is closed (suspended, moved), over the page,
// which keeps everything as it was
function showBanner(message) {
  let banner = document.getElementById('statusBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'statusBanner';
    banner.className = 'status-banner';
    banner.setAttribute('role', 'alert');
    document.body.prepend(banner);
  }
  banner.textContent = message;
}
function hideBanner() {
  document.getElementById('statusBanner')?.remove();
}

/*
 * Signing in again without leaving the page, when a write found the session over. Resolves
 * true once signed in (the write can then be sent again, with the same id), false if
 * cancelled. Several writes waiting at once share one window. Built with textContent only.
 */
let signingIn = null;
export function signInAgain() {
  signingIn ??= openSignIn().finally(() => {
    signingIn = null;
  });
  return signingIn;
}

function openSignIn() {
  return new Promise((resolve) => {
    const make = (tag, props = {}) => Object.assign(document.createElement(tag), props);
    const dialog = make('dialog', { className: 'dialog signin-dialog' });
    dialog.setAttribute('aria-labelledby', 'signinTitle');
    const form = make('form', { noValidate: true });
    const title = make('h2', { id: 'signinTitle', textContent: 'انتهت الجلسة' });
    const lead = make('p', { className: 'hint signin-lead', textContent: 'سجّل الدخول للمتابعة. ما في الصفحة باقٍ كما هو.' });
    const error = make('p', { className: 'form-error', hidden: true });
    error.setAttribute('role', 'alert');
    const field = (id, label, input) => {
      const wrap = make('div', { className: 'field' });
      wrap.append(make('label', { htmlFor: id, textContent: label }), Object.assign(input, { id, className: 'input' }));
      return wrap;
    };
    const username = make('input', { autocomplete: 'username', autocapitalize: 'none', spellcheck: false, maxLength: 64, dir: 'ltr', value: account?.user?.username ?? '' });
    const password = make('input', { type: 'password', autocomplete: 'current-password', maxLength: 128 });
    const submit = make('button', { type: 'submit', className: 'btn btn-primary', textContent: 'دخول' });
    const cancel = make('button', { type: 'button', className: 'btn btn-ghost', textContent: 'إلغاء' });
    const actions = make('div', { className: 'dialog-actions' });
    actions.append(submit, cancel);
    form.append(title, lead, error, field('signinUser', 'اسم المستخدم', username), field('signinPassword', 'كلمة المرور', password), actions);
    dialog.append(form);

    let signedIn = false;
    const finish = () => {
      dialog.remove();
      resolve(signedIn);
    };
    dialog.addEventListener('close', finish, { once: true });
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!username.value.trim() || !password.value) {
        Object.assign(error, { textContent: 'اكتب اسم المستخدم وكلمة المرور', hidden: false });
        return;
      }
      submit.disabled = true;
      try {
        account = await signIn(username.value, password.value);
        showAccount();
        setAccess(account);
        // A new first password from the admin: changed on the sign-in page (the cart is kept in this tab)
        if (account.mustChangePassword) {
          goToLogin();
          return;
        }
        signedIn = true;
        dialog.close();
      } catch (err) {
        Object.assign(error, { textContent: err.message, hidden: false });
        password.select();
      } finally {
        submit.disabled = false;
      }
    });
    document.body.append(dialog);
    dialog.showModal();
    (username.value ? password : username).focus();
  });
}

// Runs a write; if the session had ended, signs in again in place and runs it once more
// (with the same body and id, so it is still recorded once). Cancelling throws the error.
export async function withSignIn(write) {
  for (;;) {
    try {
      return await write();
    } catch (err) {
      if (err.code !== 'AUTH_EXPIRED' || !(await signInAgain())) throw err;
    }
  }
}

/*
 * The shop's settings every page reads (GET /api/shop): its name in the header and at the
 * end of the tab title, instead of «نقطة البيع»; its currency in every [data-currency]
 * element, next to the totals people read (formatMoney stays a plain number, for the
 * figures); and for the pages that need them, the receipt's details and how it prints, and
 * what a new product starts with. The last answer is kept for this tab so pages do not
 * flash the defaults; pages that need more than the name await shopInfo.
 */
const SHOP_KEY = 'pos.shop';
const DEFAULT_SHOP_NAME = 'نقطة البيع';
// What a shop has before its owner changes anything (models/Setting.js SETTING_DEFAULTS),
// for an answer kept from before a setting existed
const SHOP_DEFAULTS = Object.freeze({
  shopName: '',
  receiptNote: '',
  phone: '',
  address: '',
  currency: 'د.ع',
  receiptPaper: '80',
  receiptShowPhone: true,
  receiptShowAddress: true,
  receiptShowCashier: false,
  autoPrint: false,
  defaultTrackStock: true,
  defaultLowStockAlert: 5,
  defaultBlockWhenOut: false,
  // Sent only while the shop rounds sale lines up (routes/shop.js)
  roundingStep: 0,
  logoVersion: '',
});
const shopFields = (shop) =>
  Object.fromEntries(
    Object.entries(SHOP_DEFAULTS).map(([key, fallback]) => {
      const value = shop?.[key];
      if (typeof fallback === 'string') return [key, String(value ?? fallback).trim()];
      return [key, typeof value === typeof fallback ? value : fallback];
    }),
  );

function showShop(shop) {
  const name = shop.shopName || DEFAULT_SHOP_NAME;
  for (const el of document.querySelectorAll('.brand-name')) el.textContent = name;
  document.title = `${document.title.split(' | ')[0]} | ${name}`;
  for (const el of document.querySelectorAll('[data-currency]')) el.textContent = shop.currency;
}

// The settings from the server, kept for this tab and shown; null when it cannot answer
async function fetchShop() {
  let shop;
  try {
    shop = shopFields(await api('/shop'));
  } catch {
    return null; // offline: keep what is shown
  }
  try {
    sessionStorage.setItem(SHOP_KEY, JSON.stringify(shop));
  } catch {
    // storage blocked: the next page asks the server
  }
  showShop(shop);
  return shop;
}

async function loadShop() {
  let kept = null;
  try {
    kept = JSON.parse(sessionStorage.getItem(SHOP_KEY));
  } catch {
    // storage blocked or empty: the page's own default name stays until the server answers
  }
  if (kept) showShop(shopFields(kept));
  return (await fetchShop()) ?? shopFields(kept);
}
export const shopInfo = loadShop();

// The settings again, for a page open a long time (the cashier coming back to its tab): the
// owner may have changed the receipt meanwhile. Null when the server cannot answer.
export const refreshShop = fetchShop;

// After the settings page saves: the new name and currency at once, here and in the next
// pages of this tab
export function rememberShop(shop) {
  const fields = shopFields(shop);
  try {
    sessionStorage.setItem(SHOP_KEY, JSON.stringify(fields));
  } catch {
    // storage blocked: the next page asks the server
  }
  showShop(fields);
}

export const PRODUCTS = { one: 'منتج واحد', two: 'منتجان', few: 'منتجات', many: 'منتجًا', single: 'منتج' };
export const INVOICES = { one: 'فاتورة واحدة', two: 'فاتورتان', few: 'فواتير', many: 'فاتورة', single: 'فاتورة' };
export const PIECES = { one: 'قطعة واحدة', two: 'قطعتان', few: 'قطع', many: 'قطعة', single: 'قطعة' };
export const EXPENSES = { one: 'مصروف واحد', two: 'مصروفان', few: 'مصاريف', many: 'مصروفًا', single: 'مصروف' };
