// What each account of a shop may do (public/js/permissions.js has the names, shared with the
// pages): the owner everything, a staff account selling plus the permissions its owner gave
// it. Every /api route of a shop declares what it needs with allow(...), as its first
// handler, and is refused (403 FORBIDDEN) to an account that has none of it; a route that
// declares nothing is caught by test/permissions.test.js, so nothing is open by default.
// Permissions are read from the account on every request (lib/auth.js loads it), so a
// change takes effect on the next request of every session.
//
// Cost prices, unit costs, profits, capital and stock values belong to `reports`: answers
// for an account without it are stripped of them here, on the server, not just hidden by
// the page. Supplier invoices are the one exception: their prices, and what is still owed to
// each supplier (owedToSuppliers, suppliers[].owed, for paying them), are what `purchases`
// is for, and that route is closed to everyone else; the catalogue price a line replaced
// (prevPurchasePrice) is not part of the invoice and goes (purchaseFor). Changing a sale
// price from a supplier's invoice also needs `products`, as in the product form.
import { posix } from 'node:path';
import { httpError } from './errors.js';
import { PAGES, PERMISSIONS, PERMISSION_KEYS, SPECIAL, allows, permissionsOf } from '../public/js/permissions.js';

export { PERMISSIONS, PERMISSION_KEYS, permissionsOf };

export const isOwner = (user) => user?.role === 'owner';
export const can = (user, key) => allows(user, key);
export const seesCosts = (user) => allows(user, 'reports');

export const OWNER_ONLY = 'هذا الإجراء لصاحب المتجر فقط';
const refusal = (key) =>
  key === 'owner' ? OWNER_ONLY : `هذا يحتاج صلاحية «${PERMISSIONS[key]}». اطلبها من صاحب المتجر`;
export const forbidden = (key) => httpError(403, refusal(key), 'FORBIDDEN');

// The route goes on for an account that has any of `keys` (permission keys, or 'public',
// 'account', 'selling', 'owner'). The keys stay on the handler for the tests to read.
export function allow(...keys) {
  if (!keys.length || keys.some((key) => !PERMISSION_KEYS.includes(key) && !SPECIAL.includes(key))) {
    throw new Error(`allow(): unknown permission ${keys.join(', ')}`);
  }
  const checkPermission = function checkPermission(req, res, next) {
    if (keys.some((key) => allows(req.user, key))) return next();
    next(forbidden(keys[0]));
  };
  checkPermission.permissions = Object.freeze([...keys]);
  return checkPermission;
}

/* Pages */

// What a page the account may not open answers: 403 and a short page, in the look of the
// sign-in page, with the way back to the cashier
const pageRefusal = (key) => `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1C2530">
<title>لا يمكنك فتح هذه الصفحة | نقطة البيع</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Readex+Pro:wght@300..700&display=swap">
<link rel="stylesheet" href="/css/style.css">
</head>
<body class="auth-page">
<main class="auth">
<div class="auth-card">
<div class="auth-brand"><span class="brand-mark" aria-hidden="true"></span><span>نقطة البيع</span></div>
<div class="auth-form">
<h1>لا يمكنك فتح هذه الصفحة</h1>
<p class="auth-lead">${refusal(key)}.</p>
<a class="btn btn-primary btn-xl auth-submit" href="/cashier.html">العودة إلى الكاشير</a>
</div>
</div>
</main>
</body>
</html>
`;

// The page a request's path names, spelled as PAGES spells it. express.static decodes the
// path and resolves its dot segments and repeated slashes before it looks for the file, so
// /summary%2Ehtml, /%73ummary.html, //summary.html and /x/../summary.html all serve
// summary.html: each is looked up here as /summary.html. Windows (where the tests run) also
// ignores letter case, trailing dots and spaces, and a ::$DATA stream name. null for a path
// that does not decode, which express.static refuses anyway (400).
export function pagePath(raw) {
  let path;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return posix.normalize(path.replace(/\\/g, '/')).toLowerCase().replace(/:.*$/, '').replace(/(.)[. ]+$/, '$1');
}

// The shop's own address and the products page: an account that cannot open them (a
// cashier, given the shop's address by its owner, signing in) goes on to the cashier
const HOME = new Set(['/', '/index.html']);

// Before the pages are served: a page (public/js/permissions.js PAGES) the account may not
// open answers 403 instead. Its data is refused by the API anyway; this keeps the page from
// opening empty.
export function requirePage() {
  return function checkPage(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const path = pagePath(req.path);
    const keys = PAGES[path];
    if (!keys || keys.some((key) => allows(req.user, key))) return next();
    res.set('Cache-Control', 'no-store');
    if (HOME.has(path)) return res.redirect(302, '/cashier.html');
    res.status(403).type('html').send(pageRefusal(keys[0]));
  };
}

/* Answers without costs */

const plain = (value) => (typeof value?.toJSON === 'function' ? value.toJSON() : value);
const omit = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

// A product without its purchase price
export function productFor(user, product) {
  if (!product || seesCosts(user)) return product;
  return omit(plain(product), ['purchasePrice']);
}

// An invoice without what it cost or earned: its cost and profit, each line's unit cost and
// what each return took back at cost. What it was sold for, who sold it and what came back
// stay, for the receipt and for returns.
export function saleFor(user, sale) {
  if (!sale || seesCosts(user)) return sale;
  const s = omit(plain(sale), ['cost', 'profit', 'returnedCost']);
  if (Array.isArray(s.items)) s.items = s.items.map((item) => omit(item, ['unitCost']));
  if (Array.isArray(s.returns)) s.returns = s.returns.map((r) => omit(r, ['cost']));
  return s;
}

// A supplier's invoice keeps its own prices, totals and what is owed on it (they are what
// `purchases` is for), but not what each product cost before it (prevPurchasePrice): that is
// the products' purchase price, set perhaps outside any invoice, and an invoice of one piece
// at price 0, cancelled at once, would read it without changing anything
export function purchaseFor(user, purchase) {
  if (!purchase || seesCosts(user)) return purchase;
  const p = plain(purchase);
  return Array.isArray(p.items) ? { ...p, items: p.items.map((item) => omit(item, ['prevPurchasePrice'])) } : p;
}

// A stocktake without values: no purchase price on its lines, no shortage or surplus value,
// no capital after it
export function stockCountFor(user, count) {
  if (!count || seesCosts(user)) return count;
  const c = plain(count);
  const out = { ...c };
  if (Array.isArray(c.lines)) out.lines = c.lines.map((line) => omit(line, ['purchasePrice']));
  if (c.summary) out.summary = omit(c.summary, ['shortValue', 'overValue', 'capital', 'saleValue']);
  return out;
}
