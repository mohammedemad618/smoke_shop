// What each account of a shop may do: one list for the server (lib/permissions.js imports
// it, as lib/util.js imports rounding.js) and the pages (the menu, the staff card), so both
// read the same names. The owner may do everything. A staff account always sells for cash
// (the cashier page, the products and sections it sells, the shop's details for the
// receipt) and does the rest only with the permissions its owner gave it. Settings, staff
// accounts, the CSV files and deleting anything stay the owner's. No side effects on import.

// key -> what the staff card calls it
export const PERMISSIONS = Object.freeze({
  credit: 'البيع بالدين ودفعات العملاء',
  returns: 'المرتجعات',
  products: 'المنتجات والأقسام والجرد',
  purchases: 'المشتريات والمصاريف',
  reports: 'المبيعات والتقارير والأرباح',
});
export const PERMISSION_KEYS = Object.freeze(Object.keys(PERMISSIONS));

// What each one opens, said on the staff card under its name
export const PERMISSION_HINTS = Object.freeze({
  credit: 'البيع على حساب زبون، وصفحة الديون، وإضافة زبون، وتسجيل تسديده',
  returns: 'إرجاع أصناف من فاتورة أو إلغاؤها وإعادة المبلغ',
  products: 'إضافة المنتجات وتعديل أسعارها وأقسامها، والجرد',
  purchases: 'فواتير الموردين ودفعاتها، والمصاريف',
  reports: 'المبيعات والتقارير والملخص، وأسعار الشراء والأرباح أينما ظهرت',
});

// The two quick choices on the staff card
export const PRESETS = Object.freeze({
  cashier: Object.freeze({ label: 'كاشير', permissions: Object.freeze(['credit', 'returns']) }),
  supervisor: Object.freeze({ label: 'مشرف', permissions: PERMISSION_KEYS }),
});

// Besides the keys above, a route or a page names one of these:
//   public   no session at all (the shop's name, signing in, CSP reports)
//   account  any signed-in account, even before its first password is changed
//   selling  any signed-in account: the cashier and what it needs
//   owner    the owner alone
export const SPECIAL = Object.freeze(['public', 'account', 'selling', 'owner']);

// The pages and what opens each one (any of the keys). A page not listed is open to every
// signed-in account.
export const PAGES = Object.freeze({
  '/': Object.freeze(['products']),
  '/index.html': Object.freeze(['products']),
  '/cashier.html': Object.freeze(['selling']),
  '/purchases.html': Object.freeze(['purchases']),
  '/expenses.html': Object.freeze(['purchases']),
  '/summary.html': Object.freeze(['reports']),
  '/sales.html': Object.freeze(['reports', 'returns']),
  '/debts.html': Object.freeze(['credit']),
  '/stocktake.html': Object.freeze(['products']),
  '/settings.html': Object.freeze(['selling']),
});

// The permissions an account has: every one for the owner, its own list for a staff account
// (anything unknown in it ignored). An owner made before staff accounts existed has no list.
export function permissionsOf(account) {
  if (!account) return [];
  if (account.role === 'owner') return [...PERMISSION_KEYS];
  const own = Array.isArray(account.permissions) ? account.permissions : [];
  return PERMISSION_KEYS.filter((key) => own.includes(key));
}

// Whether an account ({ role, permissions }) may use what needs `key`
export function allows(account, key) {
  if (key === 'public') return true;
  if (!account) return false;
  if (key === 'account' || key === 'selling') return true;
  if (account.role === 'owner') return true;
  if (key === 'owner') return false;
  return permissionsOf(account).includes(key);
}

// Whether the account may open the page at `path`
export const allowsPage = (account, path) => (PAGES[path] ?? ['selling']).some((key) => allows(account, key));
