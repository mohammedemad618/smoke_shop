// What each account of a shop may do (lib/permissions.js, public/js/permissions.js): every
// /api route declares it as its first handler, and the declarations are the table below
// (a new route fails here until it is added); the owner, a staff account with no
// permission, each permission alone and all five get exactly what the table says, refusals
// being 403 FORBIDDEN in Arabic and changing nothing; pages answer 403 the same way, however
// their path is spelled, but for the shop's address, which sends to the cashier; the summary
// page loads with `reports` alone; an account without `reports` never receives a cost
// price, unit cost, profit, capital or stock value, nor a supplier invoice the purchase
// price it replaced, and without `products` an invoice changes no sale price; each sale,
// return, customer payment and expense records who made it from the session, never from
// the request; and invoices and owners from before staff accounts keep working.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTenantRouter } from '../app.js';
import { PAGES, PERMISSION_KEYS } from '../public/js/permissions.js';
import { startTestEnv, addStaff } from './support/harness.js';

// Route -> what opens it: a permission, or public (no session), account (any session, before
// the first password is changed too), selling (every account) or owner
const EXPECTED = {
  'POST /api/csp-report': ['public'],
  'GET /api/auth/shop': ['public'],
  'POST /api/auth/login': ['public'],
  'GET /api/auth/me': ['account'],
  'POST /api/auth/logout': ['account'],
  'POST /api/auth/logout-all': ['account'],
  'POST /api/auth/password': ['account'],
  'GET /api/shop': ['selling'],
  'GET /api/shop/logo': ['selling'],
  'GET /api/settings': ['owner'],
  'PUT /api/settings': ['owner'],
  'GET /api/settings/product-defaults': ['owner'],
  'POST /api/settings/product-defaults/apply': ['owner'],
  'GET /api/staff': ['owner'],
  'POST /api/staff': ['owner'],
  'PUT /api/staff/:id': ['owner'],
  'POST /api/staff/:id/disable': ['owner'],
  'POST /api/staff/:id/enable': ['owner'],
  'POST /api/staff/:id/password': ['owner'],
  'GET /api/categories': ['selling'],
  'POST /api/categories': ['products'],
  'PUT /api/categories/:id': ['products'],
  'DELETE /api/categories/:id': ['owner'],
  'GET /api/products': ['selling'],
  'GET /api/products/valuation': ['reports'],
  'GET /api/products/barcode/:code': ['selling'],
  'POST /api/products': ['products'],
  'PUT /api/products/:id': ['products'],
  'DELETE /api/products/:id': ['owner'],
  'GET /api/sales': ['reports', 'returns'],
  'GET /api/sales/report': ['reports'],
  'GET /api/sales/products': ['reports'],
  'POST /api/sales': ['selling'],
  'POST /api/sales/:id/returns': ['returns'],
  'GET /api/expenses': ['purchases'],
  'GET /api/expenses/categories': ['purchases'],
  'POST /api/expenses': ['purchases'],
  'PUT /api/expenses/:id': ['purchases'],
  'DELETE /api/expenses/:id': ['owner'],
  'GET /api/customers': ['credit'],
  'GET /api/customers/:id': ['credit'],
  'POST /api/customers': ['credit'],
  'PUT /api/customers/:id': ['credit'],
  'DELETE /api/customers/:id': ['owner'],
  'POST /api/customers/:id/entries': ['credit'],
  'DELETE /api/customers/:id/entries/:entryId': ['owner'],
  'GET /api/stockcounts': ['products'],
  'GET /api/stockcounts/current': ['products'],
  'GET /api/stockcounts/:id': ['products'],
  'POST /api/stockcounts': ['products'],
  'PUT /api/stockcounts/:id/lines/:productId': ['products'],
  'DELETE /api/stockcounts/:id/lines/:productId': ['products'],
  'POST /api/stockcounts/:id/apply': ['products'],
  'DELETE /api/stockcounts/:id': ['products'],
  'GET /api/purchases': ['purchases'],
  'GET /api/purchases/suppliers': ['purchases'],
  'GET /api/purchases/:id': ['purchases'],
  'POST /api/purchases': ['purchases'],
  'POST /api/purchases/:id/payments': ['purchases'],
  'POST /api/purchases/:id/cancel': ['purchases'],
  'GET /api/export/products.csv': ['owner'],
  'GET /api/export/sales.csv': ['owner'],
  'GET /api/export/debts.csv': ['owner'],
};

// What an account without `reports` must never be sent, at any depth. Supplier invoices
// (/api/purchases) are their prices, and are closed to accounts without `purchases`.
const COST_KEYS = ['purchasePrice', 'unitCost', 'cost', 'profit', 'returnedCost', 'capital', 'saleValue', 'shortValue', 'overValue', 'owedToSuppliers', 'prevPurchasePrice', 'netProfit'];

let env;
let shop;
let accounts;
before(async () => {
  env = await startTestEnv();
  shop = await env.createShop('perm-shop');
  // The owner, a staff account with nothing more than selling, one per permission, and one with all five
  accounts = [{ name: 'owner', role: 'owner', permissions: [...PERMISSION_KEYS], client: shop.client }];
  const sets = [['none', []], ...PERMISSION_KEYS.map((key) => [key, [key]]), ['all', [...PERMISSION_KEYS]]];
  for (const [name, permissions] of sets) {
    const staff = await addStaff(env, shop, { username: `staff-${name}`, displayName: `موظف ${name}`, permissions });
    accounts.push({ name, role: 'staff', permissions, client: staff.client, id: staff.id });
  }
});
after(async () => {
  await env?.close();
});

// Every route of the shop's router with the permissions its first handler declares
function declared(router, prefix = '') {
  const out = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const path = prefix + (layer.route.path === '/' ? '' : layer.route.path);
    const first = layer.route.stack[0]?.handle;
    for (const method of Object.keys(layer.route.methods)) {
      if (method !== '_all') out.push({ route: `${method.toUpperCase()} ${path}`, permissions: first?.permissions ?? null });
    }
  }
  for (const { path, router: child } of router.mounts ?? []) if (child?.stack) out.push(...declared(child, prefix + path));
  return out;
}

// Whether an account of the matrix may use what needs any of `keys`
const opens = (account, keys) =>
  keys.some((key) => key === 'public' || key === 'account' || key === 'selling' || account.role === 'owner' || (key !== 'owner' && account.permissions.includes(key)));
// A route as a request: any :param becomes an id that names nothing
const asRequest = (route) => {
  const [method, path] = route.split(' ');
  return [method, path.replace(/:\w+/g, '0123456789abcdef01234567')];
};
const ok = async (client, method, path, body) => {
  const res = await client.request(method, path, body);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${res.text}`);
  return res.data;
};
const owner = () => accounts[0];
const account = (name) => accounts.find((a) => a.name === name);
const today = () => {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  return `from=${from.toISOString()}&to=${new Date(from.getTime() + 864e5).toISOString()}`;
};

// The keys of COST_KEYS found anywhere in a JSON answer, with where
function costsIn(value, at = '') {
  if (Array.isArray(value)) return value.flatMap((item, i) => costsIn(item, `${at}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, inner]) => [...(COST_KEYS.includes(key) ? [`${at}.${key}`] : []), ...costsIn(inner, `${at}.${key}`)]);
}

test('every /api route of a shop declares what it needs, first, and the declarations are the table', () => {
  const routes = declared(createTenantRouter(env.ctx)).filter((r) => r.route.split(' ')[1].startsWith('/api/'));
  assert.ok(routes.length >= 55, `only ${routes.length} routes found`);
  const undeclared = routes.filter((r) => !r.permissions).map((r) => r.route);
  assert.deepStrictEqual(undeclared, [], 'routes with no allow() as their first handler');
  for (const { route, permissions } of routes) assert.deepStrictEqual([...permissions], EXPECTED[route] ?? 'not in the table', route);
  assert.deepStrictEqual(routes.map((r) => r.route).sort(), Object.keys(EXPECTED).sort(), 'the table names no route that is gone');
});

test('each account gets exactly the routes its permissions open; the others answer 403 FORBIDDEN in Arabic', async () => {
  const routes = Object.entries(EXPECTED).filter(([, keys]) => !keys.includes('public') && !keys.includes('account'));
  for (const acc of accounts) {
    for (const [route, keys] of routes) {
      const [method, path] = asRequest(route);
      const res = await acc.client.request(method, path, method === 'GET' ? undefined : {});
      const label = `${acc.name}: ${route} -> ${res.status} ${res.text.slice(0, 120)}`;
      if (opens(acc, keys)) {
        assert.notStrictEqual(res.data?.code, 'FORBIDDEN', label);
        assert.ok(res.status < 500, label);
      } else {
        assert.deepStrictEqual([res.status, res.data?.code], [403, 'FORBIDDEN'], label);
        assert.match(res.data.error, /صاحب المتجر/, label);
      }
    }
  }
  // The empty POST /api/stockcounts above opened a stocktake: thrown away for the tests below
  const open = await ok(owner().client, 'GET', '/api/stockcounts/current');
  if (open) await ok(owner().client, 'DELETE', `/api/stockcounts/${open._id}`);
});

test('a refused write changes nothing, and the session is still there', async () => {
  const none = account('none').client;
  const before = (await ok(owner().client, 'GET', '/api/categories')).length;
  assert.strictEqual((await none.request('POST', '/api/categories', { name: 'قسم الموظف' })).status, 403);
  assert.strictEqual((await ok(owner().client, 'GET', '/api/categories')).length, before);
  assert.strictEqual((await none.request('GET', '/api/auth/me')).status, 200);
  const products = account('products').client;
  const general = (await ok(products, 'GET', '/api/categories'))[0];
  assert.strictEqual((await products.request('DELETE', `/api/categories/${general._id}`)).data.error, 'هذا الإجراء لصاحب المتجر فقط');
});

test('what the account is told it may do: GET /api/auth/me', async () => {
  for (const acc of accounts) {
    const me = await ok(acc.client, 'GET', '/api/auth/me');
    assert.deepStrictEqual([me.role, me.permissions], [acc.role, acc.role === 'owner' ? [...PERMISSION_KEYS] : acc.permissions], acc.name);
  }
});

test('a page the account cannot use answers 403 with the way back to the cashier; the others open', async () => {
  for (const acc of accounts) {
    for (const [path, keys] of Object.entries(PAGES)) {
      const res = await acc.client.request('GET', path);
      if (opens(acc, keys)) {
        assert.strictEqual(res.status, 200, `${acc.name} ${path}`);
      } else if (path === '/' || path === '/index.html') {
        // The shop's address, the one a cashier is given: on to the cashier instead
        assert.deepStrictEqual([res.status, res.headers.location], [302, '/cashier.html'], `${acc.name} ${path}`);
        assert.strictEqual(res.headers['cache-control'], 'no-store');
      } else {
        assert.strictEqual(res.status, 403, `${acc.name} ${path}`);
        assert.match(res.headers['content-type'], /^text\/html/);
        assert.match(res.text, /لا يمكنك فتح هذه الصفحة/);
        assert.match(res.text, /href="\/cashier\.html"/);
        assert.strictEqual(res.headers['cache-control'], 'no-store');
      }
    }
  }
  // A cashier's own pages, and the files every page needs
  const none = account('none').client;
  for (const path of ['/cashier.html', '/settings.html', '/css/style.css', '/js/permissions.js']) assert.strictEqual((await none.request('GET', path)).status, 200, path);
});

test('a page asked for under another spelling is refused all the same', async () => {
  const none = account('none').client;
  // Each of these is summary.html to express.static, which decodes and normalises the path
  // (and on Windows ignores letter case, trailing dots and the ::$DATA stream)
  const spellings = ['/summary%2Ehtml', '/%73ummary.html', '//summary.html', '/./summary.html', '/x/../summary.html', '/js/../summary.html', '/SUMMARY.HTML', '/summary.html.', '/%5Csummary.html', '/summary.html::$DATA'];
  for (const path of [...spellings, '/purchases%2ehtml', '/debts%2ehtml', '/sales%2ehtml', '/stocktake%2ehtml', '/expenses%2ehtml']) {
    const res = await none.request('GET', path);
    assert.strictEqual(res.status, 403, path);
    assert.match(res.text, /لا يمكنك فتح هذه الصفحة/, path);
  }
  for (const path of ['//', '/./', '/index%2Ehtml', '//index.html', '/INDEX.HTML']) {
    const res = await none.request('GET', path);
    assert.deepStrictEqual([res.status, res.headers.location], [302, '/cashier.html'], path);
  }
  // An account that may open the page gets it however it is spelled
  for (const path of ['/summary%2Ehtml', '//summary.html']) {
    const res = await account('reports').client.request('GET', path);
    assert.strictEqual(res.status, 200, path);
    assert.match(res.text, /\/js\/summary\.js/, path);
  }
  // A path that does not decode serves nothing
  const bad = await none.request('GET', '/summary%E0.html');
  assert.ok(bad.status >= 400 && bad.status < 500, String(bad.status));
  assert.doesNotMatch(bad.text, /summary\.js/);
});

// public/js/summary.js loads what it shows from the API; an account with `reports` alone
// must get every source it loads unguarded, and each guarded one (optional(key, path))
// must name the permission its route needs, or the whole page would fail on a 403
test('the summary page loads with `reports` alone', async () => {
  const source = await readFile(new URL('../public/js/summary.js', import.meta.url), 'utf8');
  const loaded = [...source.matchAll(/\bapi\(['`](\/[^'`?$]+)/g)].map((m) => m[1]);
  const guarded = [...source.matchAll(/\boptional\('(\w+)', '(\/[^']+)'/g)].map((m) => [m[1], m[2]]);
  assert.ok(loaded.length >= 4 && guarded.length >= 2, `found ${loaded} and ${guarded}`);
  const reports = account('reports').client;
  for (const path of loaded) {
    const res = await reports.request('GET', `/api${path}${path.startsWith('/sales') ? `?${today()}` : ''}`);
    assert.strictEqual(res.status, 200, `${path} -> ${res.status} ${res.text.slice(0, 120)}`);
  }
  for (const [key, path] of guarded) {
    assert.deepStrictEqual(EXPECTED[`GET /api${path}`], [key], path);
    assert.strictEqual((await reports.request('GET', `/api${path}`)).status, 403, path);
  }
});

test('selling on credit needs `credit`; a debt added by hand is the owner\'s, a payment is `credit`', async () => {
  const general = (await ok(owner().client, 'GET', '/api/categories'))[0];
  const product = await ok(owner().client, 'POST', '/api/products', { name: 'بسكويت', barcode: 'P-CREDIT', category: general._id, purchasePrice: 100, salePrice: 250 });
  const customer = await ok(owner().client, 'POST', '/api/customers', { name: 'زبون الدين' });
  const creditSale = { items: [{ productId: product._id, quantity: 2 }], paymentType: 'credit', customerId: customer._id };
  const refused = await account('returns').client.request('POST', '/api/sales', creditSale);
  assert.deepStrictEqual([refused.status, refused.data.code], [403, 'FORBIDDEN']);
  assert.match(refused.data.error, /البيع بالدين ودفعات العملاء/);
  assert.strictEqual((await ok(owner().client, 'GET', `/api/customers/${customer._id}`)).balance, 0, 'no debt was recorded');
  // Cash is every account's
  assert.strictEqual((await account('none').client.request('POST', '/api/sales', { items: [{ productId: product._id, quantity: 1 }] })).status, 201);
  const sale = await ok(account('credit').client, 'POST', '/api/sales', creditSale);
  assert.strictEqual(sale.debt, 500);

  const credit = account('credit').client;
  const manual = await credit.request('POST', `/api/customers/${customer._id}/entries`, { kind: 'manual', amount: 1000 });
  assert.deepStrictEqual([manual.status, manual.data.code], [403, 'FORBIDDEN']);
  const paid = await ok(credit, 'POST', `/api/customers/${customer._id}/entries`, { kind: 'payment', amount: 200 });
  assert.strictEqual(paid.balance, 300);
  assert.strictEqual((await credit.request('DELETE', `/api/customers/${customer._id}/entries/${paid.entry._id}`)).status, 403);
  assert.strictEqual((await ok(owner().client, 'POST', `/api/customers/${customer._id}/entries`, { kind: 'manual', amount: 50 })).balance, 350);
});

test('without `reports` no answer carries a cost, a profit, capital or a stock value', async () => {
  const own = owner().client;
  const general = (await ok(own, 'GET', '/api/categories'))[0];
  const product = await ok(own, 'POST', '/api/products', { name: 'زيت', barcode: 'P-COST', category: general._id, purchasePrice: 1000, salePrice: 1500, trackStock: true, stock: 50 });
  const customer = await ok(own, 'POST', '/api/customers', { name: 'زبون التكاليف' });
  await ok(own, 'POST', '/api/sales', { items: [{ productId: product._id, quantity: 1 }] });
  await ok(own, 'POST', '/api/expenses', { date: new Date().toISOString(), category: 'كهرباء', amount: 10 });
  // An applied stocktake for the history
  const count = await ok(own, 'POST', '/api/stockcounts');
  await ok(own, 'PUT', `/api/stockcounts/${count._id}/lines/${product._id}`, { counted: 40 });
  await ok(own, 'POST', `/api/stockcounts/${count._id}/apply`);

  // The owner does get them: the test would see them
  assert.ok(costsIn(await ok(own, 'GET', '/api/products')).length);
  assert.ok(costsIn(await ok(own, 'GET', `/api/sales?${today()}`)).length);

  const found = [];
  const check = (label, data) => found.push(...costsIn(data).map((where) => `${label} ${where}`));
  for (const acc of accounts.filter((a) => a.role === 'staff' && !a.permissions.includes('reports'))) {
    const c = acc.client;
    // Every GET it may use, purchases aside
    for (const [route, keys] of Object.entries(EXPECTED)) {
      const [method, path] = route.split(' ');
      if (method !== 'GET' || !opens(acc, keys) || path.startsWith('/api/purchases') || path.includes(':')) continue;
      const res = await c.request('GET', path.startsWith('/api/sales') ? `${path}?${today()}` : path);
      if (res.status === 200) check(`${acc.name} GET ${path}`, res.data);
    }
    check(`${acc.name} barcode`, await ok(c, 'GET', '/api/products/barcode/P-COST'));
    // What its own writes send back
    const sale = await ok(c, 'POST', '/api/sales', { items: [{ productId: product._id, quantity: 1 }] });
    check(`${acc.name} sale`, sale);
    if (acc.permissions.includes('credit')) {
      check(`${acc.name} credit sale`, await ok(c, 'POST', '/api/sales', { items: [{ productId: product._id, quantity: 1 }], paymentType: 'credit', customerId: customer._id }));
      check(`${acc.name} customer`, await ok(c, 'GET', `/api/customers/${customer._id}`));
    }
    if (acc.permissions.includes('returns')) {
      const list = await ok(c, 'GET', `/api/sales?${today()}`);
      assert.strictEqual(list.summary, null, 'no figures without `reports`');
      check(`${acc.name} sales list`, list);
      check(`${acc.name} return`, await ok(c, 'POST', `/api/sales/${sale._id}/returns`, { items: [{ line: 0, quantity: 1 }] }));
    }
    if (acc.permissions.includes('products')) {
      const made = await ok(c, 'POST', '/api/products', { name: `منتج ${acc.name}`, barcode: `P-${acc.name}`, category: general._id, purchasePrice: 700, salePrice: 900 });
      check(`${acc.name} new product`, made);
      // Its purchase price was taken, though never sent back
      assert.strictEqual((await ok(own, 'GET', `/api/products/barcode/P-${acc.name}`)).purchasePrice, 700);
      check(`${acc.name} edited product`, await ok(c, 'PUT', `/api/products/${made._id}`, { salePrice: 950 }));
      assert.strictEqual((await ok(own, 'GET', `/api/products/barcode/P-${acc.name}`)).purchasePrice, 700, 'an edit without it keeps it');
      const open = await ok(c, 'POST', '/api/stockcounts');
      check(`${acc.name} new count`, open);
      check(`${acc.name} count line`, await ok(c, 'PUT', `/api/stockcounts/${open._id}/lines/${product._id}`, { counted: 30 }));
      check(`${acc.name} open count`, await ok(c, 'GET', '/api/stockcounts/current'));
      check(`${acc.name} applied`, await ok(c, 'POST', `/api/stockcounts/${open._id}/apply`));
      check(`${acc.name} count`, await ok(c, 'GET', `/api/stockcounts/${open._id}`));
      check(`${acc.name} history`, await ok(c, 'GET', '/api/stockcounts'));
    }
  }
  assert.deepStrictEqual(found, []);
});

test('each sale and return records who made it, from the session, whatever the request says', async () => {
  const own = owner().client;
  const general = (await ok(own, 'GET', '/api/categories'))[0];
  const product = await ok(own, 'POST', '/api/products', { name: 'شاي', barcode: 'P-WHO', category: general._id, purchasePrice: 100, salePrice: 300 });
  const seller = account('returns');
  const forged = { user: (await ok(own, 'GET', '/api/staff')).staff[0].id, name: 'اسم مزوّر' };
  const sale = await ok(seller.client, 'POST', '/api/sales', { items: [{ productId: product._id, quantity: 3 }], madeBy: forged });
  assert.deepStrictEqual(sale.madeBy, { user: seller.id, name: 'موظف returns' });
  // A return by another account, also with a name of its own choosing
  const { sale: after } = await ok(account('all').client, 'POST', `/api/sales/${sale._id}/returns`, { items: [{ line: 0, quantity: 1 }], madeBy: forged });
  assert.deepStrictEqual(after.madeBy, { user: seller.id, name: 'موظف returns' }, 'the sale keeps its seller');
  assert.deepStrictEqual(after.returns[0].madeBy, { user: account('all').id, name: 'موظف all' });
  // The owner's own sale, and the list shows them
  const mine = await ok(own, 'POST', '/api/sales', { items: [{ productId: product._id, quantity: 1 }] });
  assert.strictEqual(mine.madeBy.name, 'owner');
  const { sales } = await ok(own, 'GET', `/api/sales?${today()}`);
  assert.strictEqual(sales.find((s) => s._id === sale._id).returns[0].madeBy.name, 'موظف all');
  // The name at that moment: renaming the account later leaves the invoice as it was
  await ok(own, 'PUT', `/api/staff/${seller.id}`, { displayName: 'اسم جديد' });
  assert.strictEqual((await ok(own, 'GET', `/api/sales?${today()}`)).sales.find((s) => s._id === sale._id).madeBy.name, 'موظف returns');
  await ok(own, 'PUT', `/api/staff/${seller.id}`, { displayName: 'موظف returns' });
});

test('invoices from before accounts were recorded, and an owner from before staff accounts, still work', async () => {
  const own = owner().client;
  const general = (await ok(own, 'GET', '/api/categories'))[0];
  const product = await ok(own, 'POST', '/api/products', { name: 'قديم', barcode: 'P-OLD', category: general._id, purchasePrice: 100, salePrice: 400 });
  const before = await ok(own, 'GET', `/api/sales/report?${today()}`);
  // An invoice as the app wrote it before: no madeBy, on it or on its return
  const sale = await ok(own, 'POST', '/api/sales', { items: [{ productId: product._id, quantity: 2 }] });
  await ok(own, 'POST', `/api/sales/${sale._id}/returns`, { items: [{ line: 0, quantity: 1 }] });
  const sales = shop.db.collection('sales');
  await sales.updateOne({ number: sale.number }, { $unset: { madeBy: 1, 'returns.0.madeBy': 1 } });
  const stored = await sales.findOne({ number: sale.number });
  assert.ok(!('madeBy' in stored) && !('madeBy' in stored.returns[0]));

  const after = await ok(own, 'GET', `/api/sales/report?${today()}`);
  assert.strictEqual(after.summary.total, before.summary.total + 400);
  assert.strictEqual(after.summary.profit, before.summary.profit + 300);
  const listed = (await ok(own, 'GET', `/api/sales?${today()}`)).sales.find((s) => s.number === sale.number);
  assert.strictEqual(listed.madeBy, undefined);
  // A staff account returns from it, and it can still be found without costs
  const back = await ok(account('returns').client, 'POST', `/api/sales/${sale._id}/returns`, { items: [{ line: 0, quantity: 1 }] });
  assert.deepStrictEqual([back.sale.returnStatus, back.sale.returns[1].madeBy.name], ['full', 'موظف returns']);

  // The owner account as made before staff accounts: no permissions field at all
  const users = shop.db.collection('users');
  await users.updateOne({ role: 'owner' }, { $unset: { permissions: 1 } });
  assert.ok(!('permissions' in (await users.findOne({ role: 'owner' }))));
  const me = await ok(own, 'GET', '/api/auth/me');
  assert.deepStrictEqual([me.role, me.permissions], ['owner', [...PERMISSION_KEYS]]);
  assert.strictEqual((await own.request('GET', '/api/export/products.csv')).status, 200);
  assert.strictEqual((await own.request('GET', '/api/staff')).status, 200);
});

test('a supplier invoice changes a sale price only with `products`; without `reports` it leaves out the purchase price it replaced', async () => {
  const own = owner().client;
  const general = (await ok(own, 'GET', '/api/categories'))[0];
  const product = await ok(own, 'POST', '/api/products', { name: 'رز', barcode: 'P-BUY', category: general._id, purchasePrice: 1000, salePrice: 1500, trackStock: true, stock: 10 });
  const buyer = account('purchases').client;
  const now = async () => {
    const p = await ok(own, 'GET', '/api/products/barcode/P-BUY');
    return [p.salePrice, p.purchasePrice, p.stock];
  };

  // A new sale price from the invoice is a price change: refused, and nothing came in
  const refused = await buyer.request('POST', '/api/purchases', { items: [{ product: product._id, quantity: 1, price: 900, salePrice: 1 }], paid: 0 });
  assert.deepStrictEqual([refused.status, refused.data.code], [403, 'FORBIDDEN']);
  assert.match(refused.data.error, /المنتجات والأقسام والجرد/);
  assert.deepStrictEqual(await now(), [1500, 1000, 10]);

  // The same sale price as now is no change; the invoice's own prices are its to send
  const sent = { items: [{ product: product._id, quantity: 2, price: 900, salePrice: 1500 }], paid: 0, clientId: 'b'.repeat(32) };
  const bought = await ok(buyer, 'POST', '/api/purchases', sent);
  assert.deepStrictEqual([bought.items[0].price, bought.items[0].unitCost, bought.total, bought.items[0].salePrice], [900, 900, 1800, null]);
  assert.deepStrictEqual(await now(), [1500, 900, 12]);
  // The owner sees what the product cost before; the buyer, in nothing it is sent, does not
  assert.strictEqual((await ok(own, 'GET', `/api/purchases/${bought._id}`)).items[0].prevPurchasePrice, 1000);
  const answers = [
    ['saved', bought],
    ['sent again', await ok(buyer, 'POST', '/api/purchases', sent)],
    ['list', await ok(buyer, 'GET', `/api/purchases?${today()}`)],
    ['detail', await ok(buyer, 'GET', `/api/purchases/${bought._id}`)],
    ['paid', await ok(buyer, 'POST', `/api/purchases/${bought._id}/payments`, { amount: 100 })],
    ['cancelled', await ok(buyer, 'POST', `/api/purchases/${bought._id}/cancel`)],
  ];
  for (const [label, data] of answers) {
    assert.deepStrictEqual(costsIn(data).filter((where) => /purchasePrice/i.test(where)), [], label);
  }
  // Supplier debts stay: paying suppliers is the buyer's job
  assert.ok('owedToSuppliers' in answers[2][1]);
  assert.deepStrictEqual(await now(), [1500, 1000, 10], 'the cancelled invoice took its goods and price back');

  // With `products` (and here everything) the invoice may set the sale price
  const all = account('all').client;
  const priced = await ok(all, 'POST', '/api/purchases', { items: [{ product: product._id, quantity: 1, price: 1000, salePrice: 1600 }] });
  assert.strictEqual((await now())[0], 1600);
  await ok(all, 'POST', `/api/purchases/${priced._id}/cancel`);
  assert.strictEqual((await now())[0], 1500);
});

test("a customer's payment and an expense record who made them; a staff account's payment is dated now", async () => {
  const own = owner().client;
  const customer = await ok(own, 'POST', '/api/customers', { name: 'زبون التسديد' });
  await ok(own, 'POST', `/api/customers/${customer._id}/entries`, { kind: 'manual', amount: 1000, note: 'دين قديم' });
  const forged = { user: '0123456789abcdef01234567', name: 'اسم مزوّر' };
  const lastWeek = new Date(Date.now() - 7 * 864e5).toISOString();

  const credit = account('credit');
  const { entry } = await ok(credit.client, 'POST', `/api/customers/${customer._id}/entries`, { kind: 'payment', amount: 100, date: lastWeek, madeBy: forged });
  assert.deepStrictEqual(entry.madeBy, { user: credit.id, name: 'موظف credit' });
  assert.ok(Math.abs(new Date(entry.date) - Date.now()) < 60_000, `dated ${entry.date}, not last week`);
  // The owner dates a payment as it was made
  const { entry: mine } = await ok(own, 'POST', `/api/customers/${customer._id}/entries`, { kind: 'payment', amount: 100, date: lastWeek });
  assert.deepStrictEqual([new Date(mine.date).toISOString(), mine.madeBy.name], [lastWeek, 'owner']);
  // On the account, next to an entry from before accounts were recorded (the hand-added debt,
  // its madeBy removed as an old database has none)
  await shop.db.collection('debtentries').updateOne({ note: 'دين قديم' }, { $unset: { madeBy: 1 } });
  const { entries, balance } = await ok(credit.client, 'GET', `/api/customers/${customer._id}`);
  assert.strictEqual(balance, 800);
  assert.deepStrictEqual(entries.map((e) => [e.kind, e.madeBy?.name]).sort(), [['manual', undefined], ['payment', 'owner'], ['payment', 'موظف credit']]);

  const buyer = account('purchases');
  const expense = await ok(buyer.client, 'POST', '/api/expenses', { date: new Date().toISOString(), category: 'نقل', amount: 25, madeBy: forged });
  assert.deepStrictEqual([expense.madeBy, expense.editedBy], [{ user: buyer.id, name: 'موظف purchases' }, undefined]);
  const edited = await ok(own, 'PUT', `/api/expenses/${expense._id}`, { amount: 30, madeBy: forged, editedBy: forged });
  assert.deepStrictEqual([edited.amount, edited.madeBy.name, edited.editedBy.name], [30, 'موظف purchases', 'owner']);
});
