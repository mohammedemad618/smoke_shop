// The demo shop (scripts/demo-shop.js, services/demo-shop.js): made by the script without
// any password being shown or kept, its figures rebuilt here from the raw records and found
// equal to the app's own answers (the sales report by day and by month, the day's figures,
// the stock and its value, what customers owe and what is owed to suppliers), no date in
// the future and every record in its place in time, the same history from the same seed on
// the same day, nothing done twice by a second run, a stopped run finished by the next one,
// a write made to the shop during a run reported, the shop's first invoice number kept, the
// month so far never a loss, and a reset that keeps the owner's account, ends the staff's
// sessions and touches nothing else. A short history (DAYS) keeps it quick.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import { startTestEnv, BASE_DOMAIN, LOCAL_DIR, FIRST_PASSWORD, signInAsOwner } from './support/harness.js';
import { DEMO_AGENT, fillDemoShop, readMarker, resetDemoShop, waitUntilActive } from '../services/demo-shop.js';
import { CUTOFF_MS, addDays, dayOf as planDayOf, demoPlan, zonedTime } from '../services/demo-plan.js';
import { DEMO_OWNER_NAME, DEMO_SHOP_NAME, PRODUCTS } from '../services/demo-data.js';
import { createTenant, resetUserPassword, setOwnerPassword } from '../services/tenants.js';
import { generatePassword, verifyPassword } from '../lib/passwords.js';
import { roundTo } from '../public/js/rounding.js';

const TZ = 'Asia/Baghdad';
const SLUG = 'demo-market';
const DAYS = 10;
const money = (n) => roundTo(n, 2);
const qty = (n) => roundTo(n, 3);
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = (d) => dayFormat.format(d);
// Baghdad keeps +03:00 all year
const midnight = (day) => new Date(`${day}T00:00:00+03:00`);
const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

let env;
let demo; // { tenant, models, client, out, createdHash, marker }

// The script, run as npm run would, against this file's databases
const runScript = (args) =>
  promisify(execFile)(process.execPath, ['scripts/demo-shop.js', ...args], {
    cwd: new URL('..', import.meta.url),
    timeout: 120000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MONGODB_URI: env.config.mongodbUri,
      CONTROL_DB: env.config.controlDb,
      TENANT_DB_PREFIX: env.config.tenantDbPrefix,
      TENANT_BASE_DOMAINS: BASE_DOMAIN,
      ADMIN_HOST: env.config.adminHost,
      POS_LOCAL_DIR: LOCAL_DIR,
      MAX_NEW_TENANTS_PER_DAY: '1000',
    },
  });

const tenantOf = (slug) => env.db.controlModels.Tenant.findOne({ slug }).lean();
const ownerOf = async (models) => models.User.findOne({ role: 'owner' }).select('+passwordHash').lean();
const ok = async (client, method, path, body) => {
  const res = await client.request(method, path, body);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${res.text}`);
  return res.data;
};
// A browser on a shop, signed in as an account given a password here (FIRST_PASSWORD, then changed)
async function signedIn(tenant, user) {
  const client = env.client(`${tenant.slug}.${BASE_DOMAIN}:${env.app.port}`);
  await signInAsOwner(client, { username: user, password: FIRST_PASSWORD }, tenant.slug);
  return client;
}

before(async () => {
  env = await startTestEnv();
  const out = await runScript(['create', '--slug', SLUG, '--days', String(DAYS)]);
  await env.registry.poll();
  const tenant = await tenantOf(SLUG);
  const models = await env.db.tenantModels(tenant);
  // The owner's password as the script left it, to look for in what it printed and logged
  const createdOwner = await ownerOf(models);
  const marker = await readMarker(env.ctx, tenant);
  // Then the owner gets a password, as from the admin panel, to read the shop through the app
  await setOwnerPassword(env.ctx, tenant._id, { password: FIRST_PASSWORD }, { actor: 'test' });
  demo = { tenant, models, out, createdOwner, marker, client: await signedIn(tenant, 'owner') };
});
after(async () => {
  await env?.close();
});

const raw = async (models) => {
  const [sales, entries, expenses, purchases, products, counts, customers] = await Promise.all([
    models.Sale.find().sort({ number: 1 }).lean(),
    models.DebtEntry.find().lean(),
    models.Expense.find().lean(),
    models.Purchase.find().sort({ number: 1 }).lean(),
    models.Product.find().lean(),
    models.StockCount.find().lean(),
    models.Customer.find().lean(),
  ]);
  return { sales, entries, expenses, purchases, products, counts, customers };
};

test('create makes and fills the shop without a password ever shown or logged', async () => {
  const { out, tenant, createdOwner, marker } = demo;
  assert.match(out.stdout, /address: {2}http:\/\/demo-market\.pos\.localhost/);
  assert.match(out.stdout, /«إعادة تعيين كلمة المرور»/);
  assert.match(out.stdout, /npm run tenant:owner -- --slug demo-market/);
  assert.doesNotMatch(out.stdout + out.stderr, /password:\s*\S/i);
  // The owner was made with a first password nobody saw: no word printed is it
  assert.deepStrictEqual([createdOwner.usernameLower, createdOwner.displayName, createdOwner.mustChangePassword], ['owner', DEMO_OWNER_NAME, true]);
  const { AuditLog, Session } = env.db.controlModels;
  const entries = await AuditLog.find({ tenantId: tenant._id }).sort({ at: 1, _id: 1 }).lean();
  const words = new Set(`${out.stdout} ${out.stderr} ${JSON.stringify(entries)}`.match(/\b[A-Za-z0-9]{10,40}\b/g));
  for (const word of words) assert.strictEqual(await verifyPassword(word, createdOwner.passwordHash), false, 'a printed or logged word is the password');
  // What the run wrote to the audit log, and no session left behind
  const actions = entries.map((e) => [e.action, e.actor.replace(/^cli:.*/, 'cli'), e.result]);
  assert.deepStrictEqual(actions.slice(0, 8), [
    ['tenant.create', 'cli', 'ok'],
    ['tenant.status', 'cli', 'ok'],
    // Before anything is changed, so a run killed on the way leaves a trace
    ['demo.fill.start', 'cli', 'ok'],
    ['staff.create', 'shop:owner', 'ok'],
    ['staff.create', 'shop:owner', 'ok'],
    ['staff.create', 'shop:owner', 'ok'],
    ['staff.disable', 'shop:owner', 'ok'],
    ['demo.fill', 'cli', 'ok'],
  ]);
  const fill = entries[7];
  assert.deepStrictEqual([fill.details.seed, fill.details.days, fill.details.to, fill.details.foreign], [2026, DAYS, marker.lastDay, undefined]);
  assert.strictEqual(await Session.countDocuments({ ua: DEMO_AGENT }), 0);
  assert.deepStrictEqual([marker.state, marker.seed, marker.days, marker.leaseUntil, marker.saleStart, marker.warning], ['filled', 2026, DAYS, null, 0, undefined]);
  assert.doesNotMatch(out.stderr, /Warning/);
  assert.strictEqual(tenant.shopNameCache, DEMO_SHOP_NAME);
  // Every request of the plan made its record once
  const plan = demoPlan({ seed: marker.seed, days: marker.days, now: marker.until.getTime() + CUTOFF_MS });
  const planned = (kind) => plan.steps.filter((s) => s.kind === kind).length;
  assert.deepStrictEqual(
    [marker.counts.sales, marker.counts.purchases, marker.counts.expenses, marker.counts.returns, marker.counts.products],
    [planned('sale'), planned('purchase'), planned('expense'), planned('return'), planned('product')],
  );
});

/* The figures, rebuilt from the raw records */

// What customers paid towards credit sales, dated when it counts, replayed oldest first per
// customer: payments settle the oldest debts, a return its own invoice first, and money paid
// ahead counts when a later credit sale uses it
function collectedFrom(entries) {
  const events = [];
  const byCustomer = Map.groupBy(entries, (e) => String(e.customer));
  for (const list of byCustomer.values()) {
    list.sort((a, b) => a.date - b.date || a.createdAt - b.createdAt);
    let open = [];
    let ahead = 0;
    for (const e of list) {
      if (e.amount > 0) {
        const used = Math.min(ahead, e.amount);
        ahead = money(ahead - used);
        if (used > 0 && e.kind === 'sale') events.push({ date: e.date, amount: used });
        if (e.amount - used > 0) open.push({ kind: e.kind, sale: String(e.sale ?? ''), left: money(e.amount - used) });
        continue;
      }
      let rest = -e.amount;
      const order = e.kind === 'return' ? [...open.filter((d) => d.sale === String(e.sale)), ...open.filter((d) => d.sale !== String(e.sale))] : open;
      for (const debt of order) {
        const used = Math.min(debt.left, rest);
        debt.left = money(debt.left - used);
        rest = money(rest - used);
        if (used > 0 && e.kind === 'payment' && debt.kind === 'sale') events.push({ date: e.date, amount: used });
      }
      open = open.filter((d) => d.left > 0);
      ahead = money(ahead + rest);
    }
  }
  return events;
}

// A period's figures by keyOf(date) (a day, a month or 'all'): an invoice on the day it was
// made, a return on the day it was made, an invoice cancelled within its own period not counted
function figures({ sales, entries, expenses }, keyOf, start, end) {
  const rows = new Map();
  const row = (key) => {
    if (!rows.has(key)) rows.set(key, { key, count: 0, pieces: 0, total: 0, cost: 0, profit: 0, returns: 0, credit: 0, expenses: 0, collected: 0 });
    return rows.get(key);
  };
  const inRange = (d) => d >= start && d < end;
  const pieces = (lines) => lines.reduce((sum, l) => sum + (l.unit === 'kg' ? 0 : l.quantity * (l.packSize ?? 1)), 0);
  for (const s of sales) {
    if (inRange(s.createdAt)) {
      const r = row(keyOf(s.createdAt));
      const lastReturn = s.returns.reduce((latest, x) => (x.at > latest ? x.at : latest), new Date(0));
      const cancelled = s.returnStatus === 'full' && lastReturn < end && keyOf(lastReturn) === keyOf(s.createdAt);
      r.count += cancelled ? 0 : 1;
      r.pieces += pieces(s.items);
      r.total += s.total;
      r.cost += s.cost;
      r.profit += s.profit;
      r.credit += s.debt ?? 0;
    }
    for (const x of s.returns) {
      if (!inRange(x.at)) continue;
      const r = row(keyOf(x.at));
      r.pieces -= pieces(x.items);
      r.total -= x.amount;
      r.cost -= x.cost;
      r.profit -= x.amount - x.cost;
      r.returns += x.amount;
      r.credit -= x.toAccount ?? 0;
    }
  }
  for (const e of expenses) if (inRange(e.date)) row(keyOf(e.date)).expenses += e.amount;
  for (const ev of collectedFrom(entries)) if (inRange(ev.date)) row(keyOf(ev.date)).collected += ev.amount;
  return [...rows.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((r) => {
      const f = { ...r, pieces: qty(r.pieces) };
      for (const k of ['total', 'cost', 'profit', 'returns', 'credit', 'expenses', 'collected']) f[k] = money(r[k]);
      return { ...f, netProfit: money(f.profit - f.expenses - f.credit + f.collected) };
    });
}

// Each tracked product's stock replayed from its purchases, sales, returns and stocktake,
// checking on the way that the stocktake found what the replay had
function replayStock({ sales, purchases, products, counts }) {
  const tracked = new Set(products.filter((p) => p.trackStock).map((p) => String(p._id)));
  const events = [];
  for (const p of purchases) for (const i of p.items) events.push([p.createdAt, String(i.product), i.quantity * i.packSize]);
  for (const s of sales) {
    for (const i of s.items) events.push([s.createdAt, String(i.product), -i.quantity * i.packSize]);
    for (const x of s.returns) for (const i of x.items) events.push([x.at, String(i.product), i.quantity * (i.packSize ?? 1)]);
  }
  const checks = [];
  for (const c of counts) {
    for (const l of c.lines) {
      checks.push([l.countedAt, String(l.product), l.expected]);
      events.push([c.appliedAt, String(l.product), l.counted - l.expected]);
    }
  }
  const stock = new Map([...tracked].map((id) => [id, 0]));
  const all = [...events.map((e) => ['move', ...e]), ...checks.map((c) => ['check', ...c])].sort((a, b) => a[1] - b[1] || (a[0] === 'check' ? -1 : 1));
  for (const [kind, , id, value] of all) {
    if (!tracked.has(id)) continue;
    if (kind === 'check') assert.strictEqual(qty(stock.get(id)), value, 'the stocktake expected what the replay has');
    else stock.set(id, qty(stock.get(id) + value));
  }
  return stock;
}

test("the shop's figures, rebuilt from its records, are exactly the app's", async () => {
  const { models, client, marker } = demo;
  const data = await raw(models);
  const { sales, entries, purchases, products } = data;
  assert.ok(sales.length > 200 && purchases.length >= 3 && data.expenses.length >= 3 && entries.length >= 2, 'a shop in use');

  // Each invoice adds up, at the prices of its moment: the product's sale price, and its
  // purchase price from the last supplier invoice before it (a dish: its own)
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const lastCost = (id, at) => purchases.filter((p) => p.createdAt <= at).flatMap((p) => p.items).filter((i) => String(i.product) === id).at(-1)?.unitCost;
  const prices = new Map();
  for (const s of sales) {
    for (const i of s.items) {
      const p = productById.get(String(i.product));
      assert.strictEqual(i.lineTotal, money(i.unitPrice * i.quantity));
      assert.strictEqual(i.unitCost, p.trackStock ? lastCost(String(i.product), s.createdAt) : p.purchasePrice, `${i.name} on invoice ${s.number}`);
      if (s.createdAt >= p.updatedAt || p.trackStock) assert.strictEqual(i.unitPrice, p.salePrice, `${i.name} on invoice ${s.number}`);
      prices.set(i.name, new Set([...(prices.get(i.name) ?? []), i.unitPrice]));
    }
    assert.strictEqual(s.total, money(s.items.reduce((sum, i) => sum + i.lineTotal, 0)));
    assert.strictEqual(s.cost, money(s.items.reduce((sum, i) => sum + money(i.unitCost * i.quantity), 0)));
    assert.strictEqual(s.profit, money(s.total - s.cost));
    assert.strictEqual(s.returnedTotal ?? 0, money(s.returns.reduce((sum, x) => sum + x.amount, 0)));
  }
  // One price change at most per item (the lamb tikka's, part way through)
  for (const [name, seen] of prices) assert.ok(seen.size <= 2, name);

  // The sales report, by day and by month, for the whole history
  const first = midnight(marker.firstDay);
  const end = midnight(nextDay(marker.lastDay));
  const report = (from, to, groupBy) => ok(client, 'GET', `/api/sales/report?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), groupBy, tz: TZ })}`);
  const byDay = await report(first, end, 'day');
  assert.deepStrictEqual(byDay.periods, figures(data, dayOf, first, end));
  const [year, month] = marker.lastDay.split('-').map(Number);
  const monthStart = midnight(`${marker.firstDay.slice(0, 7)}-01`);
  const monthEnd = midnight(new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10));
  const byMonth = await report(monthStart, monthEnd, 'month');
  assert.deepStrictEqual(byMonth.periods, figures(data, (d) => dayOf(d).slice(0, 7), monthStart, monthEnd));
  // A healthy restaurant: no month at a loss, nor the month so far at the end of any day
  // (the summary's «هذا الشهر»)
  for (const p of byMonth.periods) assert.ok(p.netProfit >= 0, `${p.key}: ${p.netProfit}`);
  const soFar = new Map();
  for (const p of byDay.periods) {
    soFar.set(p.key.slice(0, 7), money((soFar.get(p.key.slice(0, 7)) ?? 0) + p.netProfit));
    assert.ok(soFar.get(p.key.slice(0, 7)) >= 0, `${p.key}: the month so far ${soFar.get(p.key.slice(0, 7))}`);
  }
  // A grill burns charcoal; a restaurant sells its drinks one at a time
  assert.ok(data.expenses.some((e) => e.category === 'فحم'));
  assert.ok(products.every((p) => !p.hasWholesale) && sales.every((s) => s.items.every((i) => i.mode === 'retail')));
  // The whole history at once adds up the same, every dish sold above its cost
  const [all] = figures(data, () => 'all', first, end);
  for (const k of ['total', 'cost', 'profit', 'returns', 'credit', 'expenses', 'collected', 'netProfit']) assert.strictEqual(byDay.summary[k], all[k], k);
  assert.ok(all.total > 0 && all.cost / all.total > 0.3 && all.cost / all.total < 0.45, `food cost ${all.cost / all.total}`);

  // Each day's own page (the summary's «اليوم»): the figures of that day alone
  for (const day of [marker.firstDay, marker.lastDay, dayOf(sales.at(-1).createdAt)]) {
    const from = midnight(day);
    const to = midnight(nextDay(day));
    const { summary, sales: list } = await ok(client, 'GET', `/api/sales?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`);
    const [expected = { count: 0, pieces: 0, total: 0, cost: 0, profit: 0, returns: 0, credit: 0, expenses: 0, collected: 0, netProfit: 0 }] = figures(data, () => 'all', from, to);
    delete expected.key;
    assert.deepStrictEqual(summary, expected, day);
    assert.strictEqual(list.length, sales.filter((s) => s.createdAt >= from && s.createdAt < to).length);
  }

  // The stock, replayed, is the products' and the stock page's; their value and the debts both ways
  const stock = replayStock(data);
  const listed = new Map((await ok(client, 'GET', '/api/products')).map((p) => [String(p._id), p]));
  let capital = 0;
  let saleValue = 0;
  for (const p of products.filter((x) => x.trackStock)) {
    const id = String(p._id);
    assert.strictEqual(p.stock, stock.get(id), p.name);
    assert.strictEqual(listed.get(id).stock, stock.get(id), p.name);
    assert.strictEqual(p.purchasePrice, lastCost(id, new Date()), p.name);
    if (stock.get(id) > 0) {
      capital += stock.get(id) * p.purchasePrice;
      saleValue += stock.get(id) * p.salePrice;
    }
  }
  // What each customer owes, from the invoices themselves and the payments
  const balances = new Map(data.customers.map((c) => [String(c._id), 0]));
  for (const s of sales.filter((x) => x.customer)) {
    balances.set(String(s.customer), money(balances.get(String(s.customer)) + (s.debt ?? 0) - s.returns.reduce((sum, x) => sum + (x.toAccount ?? 0), 0)));
    if (s.debt > 0) assert.ok(entries.some((e) => e.kind === 'sale' && String(e.sale) === String(s._id) && e.amount === s.debt && +e.date === +s.createdAt), `the debt of invoice ${s.number}`);
  }
  for (const e of entries.filter((x) => x.kind === 'payment' || x.kind === 'manual')) balances.set(String(e.customer), money(balances.get(String(e.customer)) + e.amount));
  const customers = await ok(client, 'GET', '/api/customers');
  assert.deepStrictEqual(new Map(customers.map((c) => [String(c._id), c.balance])), balances);
  // What is owed to each supplier, from the invoices' lines and payments
  const owed = new Map();
  for (const p of purchases.filter((x) => x.status === 'active')) {
    const total = money(p.items.reduce((sum, i) => sum + money(i.quantity * i.price), 0));
    const paid = money(p.payments.reduce((sum, x) => sum + x.amount, 0));
    assert.deepStrictEqual([p.total, p.paid], [total, paid], `purchase ${p.number}`);
    owed.set(p.supplier, money((owed.get(p.supplier) ?? 0) + total - paid));
  }
  const suppliers = await ok(client, 'GET', '/api/purchases/suppliers');
  assert.deepStrictEqual(new Map(suppliers.map((s) => [s.name, s.owed])), owed);
  const valuation = await ok(client, 'GET', '/api/products/valuation');
  const positive = [...balances.values()];
  assert.deepStrictEqual(
    [valuation.capital, valuation.saleValue, valuation.debts, +new Date(valuation.lastCountAt)],
    [
      money(capital),
      money(saleValue),
      {
        owedToShop: money(positive.filter((b) => b > 0).reduce((a, b) => a + b, 0)),
        owedByShop: money(-positive.filter((b) => b < 0).reduce((a, b) => a + b, 0)),
        owedToSuppliers: money([...owed.values()].reduce((a, b) => a + b, 0)),
      },
      +data.counts[0].appliedAt,
    ],
  );
  // The water and juice are bought on account: something is always owed to a supplier
  assert.ok(valuation.debts.owedToSuppliers > 0);
});

test('no date is in the future, every record is in its window, and time follows the invoice numbers', async () => {
  const { models, marker, tenant } = demo;
  const now = Date.now();
  const start = midnight(marker.firstDay).getTime();
  const until = marker.until.getTime();
  const datesOf = (value, out = []) => {
    if (value instanceof Date) out.push(value.getTime());
    else if (Array.isArray(value)) value.forEach((v) => datesOf(v, out));
    else if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) Object.values(value).forEach((v) => datesOf(v, out));
    return out;
  };
  const conn = env.db.tenantConnection(tenant).db;
  for (const { name } of await conn.listCollections().toArray()) {
    for (const doc of await conn.collection(name).find().toArray()) {
      for (const t of datesOf(doc)) assert.ok(t <= now, `${name}: a date in the future`);
      // The shop's own records (not its settings' or its owner's, made with the shop)
      const own = !['settings', 'demo_meta'].includes(name) && !(name === 'users' && doc.role === 'owner');
      if (own) for (const t of datesOf(doc)) assert.ok(t >= start && t <= until, `${name}: ${new Date(t).toISOString()} outside the history`);
    }
  }
  const { sales, purchases, entries } = await raw(models);
  const users = new Map((await models.User.find().lean()).map((u) => [String(u._id), u]));
  for (let i = 0; i < sales.length; i++) {
    const s = sales[i];
    assert.strictEqual(s.number, i + 1);
    if (i) assert.ok(s.createdAt > sales[i - 1].createdAt, `invoice ${s.number} after ${s.number - 1}`);
    for (const x of s.returns) assert.ok(x.at > s.createdAt);
    // Sold by an account that existed then and was not yet disabled
    const seller = users.get(String(s.madeBy.user));
    assert.ok(seller.role === 'owner' || (seller.createdAt < s.createdAt && !(seller.disabledAt <= s.createdAt)), `the seller of invoice ${s.number}`);
  }
  for (let i = 0; i < purchases.length; i++) {
    assert.strictEqual(purchases[i].number, i + 1);
    assert.strictEqual(+purchases[i].date, +purchases[i].createdAt);
    if (i) assert.ok(purchases[i].createdAt > purchases[i - 1].createdAt);
  }
  // A payment or a return is dated when it was recorded
  for (const e of entries.filter((x) => x.kind !== 'sale')) assert.strictEqual(+e.date, +e.createdAt);
  // The staff chose their own password before their first sale, and signed in last after it
  for (const u of users.values()) {
    if (u.role !== 'staff') continue;
    const theirs = sales.filter((s) => String(s.madeBy.user) === String(u._id));
    assert.ok(theirs.length > 0 && !u.mustChangePassword, u.usernameLower);
    assert.ok(u.createdAt < u.passwordChangedAt && u.passwordChangedAt < theirs[0].createdAt && u.lastLoginAt >= u.passwordChangedAt && u.lastLoginAt <= marker.until, u.usernameLower);
  }
  // Days are cut in Baghdad: the restaurant opens at 11:30 and closes at half past midnight
  for (const s of sales) {
    const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(s.createdAt).split(':').map(Number);
    const minutes = h * 60 + m;
    assert.ok(minutes >= 11 * 60 + 30 || minutes <= 60, `invoice ${s.number} at ${h}:${m}`);
  }
});

// A shop's records with their ids replaced by what they name, for comparing two shops
async function normalized(models) {
  const labels = new Map();
  const [categories, products, customers, users, sales, purchases] = await Promise.all(
    ['Category', 'Product', 'Customer', 'User', 'Sale', 'Purchase'].map((name) => models[name].find().lean()),
  );
  categories.forEach((d) => labels.set(String(d._id), `category ${d.name}`));
  products.forEach((d) => labels.set(String(d._id), `product ${d.barcode}`));
  customers.forEach((d) => labels.set(String(d._id), `customer ${d.name}`));
  users.forEach((d) => labels.set(String(d._id), `user ${d.usernameLower}`));
  sales.forEach((d) => labels.set(String(d._id), `sale ${d.number}`));
  purchases.forEach((d) => labels.set(String(d._id), `purchase ${d.number}`));
  const plain = (value) => {
    if (value instanceof mongoose.Types.ObjectId) return labels.get(String(value)) ?? 'an id of its own';
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(plain);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
    return value;
  };
  const out = {};
  for (const name of ['Category', 'Product', 'Customer', 'Sale', 'Purchase', 'DebtEntry', 'Expense', 'StockCount', 'Counter', 'Setting', 'User']) {
    const docs = (await models[name].find().select(name === 'User' ? '+passwordHash' : {}).lean()).filter((d) => !(name === 'User' && d.role === 'owner'));
    out[name] = docs.map((d) => {
      const { passwordHash, createdAt, ...rest } = d;
      // A setting's own creation is the shop's; everything else counts
      return plain(name === 'Setting' ? rest : { ...rest, createdAt });
    });
    out[name].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return out;
}

test('the same seed on the same day gives the same history', async () => {
  const now = demo.marker.until.getTime() + CUTOFF_MS;
  // The plan itself, made twice; and made later the same day, it only adds what came since
  assert.deepStrictEqual(demoPlan({ seed: 7, days: 10, now }), demoPlan({ seed: 7, days: 10, now }));
  const later = demoPlan({ seed: 7, days: 10, now: now + 3 * 3600000 });
  const earlier = demoPlan({ seed: 7, days: 10, now });
  if (later.lastDay === earlier.lastDay) assert.deepStrictEqual(later.steps.filter((s) => s.at < earlier.cutoff), earlier.steps);
  assert.notDeepStrictEqual(demoPlan({ seed: 8, days: 10, now }).steps, earlier.steps);

  // A second shop filled with the same seed for the same moment holds the very same records
  const owner = { username: 'owner', password: generatePassword({ slug: 'demo-twin' }), displayName: DEMO_OWNER_NAME };
  const { tenant } = await createTenant(env.ctx, { slug: 'demo-twin', shopName: DEMO_SHOP_NAME, owner, timeZone: TZ }, { actor: 'test' });
  const twin = await fillDemoShop(env.ctx, { slug: 'demo-twin', days: DAYS, now, actor: 'test', confirmUnmarked: async () => true });
  // Nothing but the run's own requests wrote to the shop
  assert.deepStrictEqual([twin.filled, twin.foreign], [true, []]);
  const [a, b] = await Promise.all([normalized(demo.models), normalized(await env.db.tenantModels(tenant))]);
  for (const name of Object.keys(a)) assert.deepStrictEqual(b[name], a[name], name);
});

test('create run again on the demo shop adds nothing', async () => {
  const before = await raw(demo.models);
  const out = await runScript(['create', '--slug', SLUG, '--days', String(DAYS)]);
  assert.match(out.stdout, /already filled/);
  const after = await raw(demo.models);
  for (const key of Object.keys(before)) assert.strictEqual(after[key].length, before[key].length, key);
  const { AuditLog } = env.db.controlModels;
  for (const action of ['demo.fill.start', 'demo.fill']) assert.strictEqual(await AuditLog.countDocuments({ tenantId: demo.tenant._id, action }), 1, action);
});

test('reset and fill refuse a shop that is not the demo, and change nothing in it', async () => {
  const plain = await env.createShop('plain-shop');
  const category = (await ok(plain.client, 'GET', '/api/categories'))[0];
  await ok(plain.client, 'POST', '/api/products', { name: 'شاي', barcode: 'T1', purchasePrice: 100, salePrice: 250, category: category._id });
  const models = await env.db.tenantModels(plain.tenant);
  await assert.rejects(resetDemoShop(env.ctx, { slug: 'plain-shop', actor: 'test' }), /is not a demo shop/);
  await assert.rejects(fillDemoShop(env.ctx, { slug: 'plain-shop', actor: 'test', confirmUnmarked: async () => true }), /already has products/);
  await assert.rejects(runScript(['reset', '--slug', 'plain-shop', '--yes']), (err) => err.code === 1 && /is not a demo shop/.test(err.stderr));
  await assert.rejects(runScript(['create', '--slug', 'plain-shop']), (err) => err.code === 1 && /is not a demo shop/.test(err.stderr));
  assert.deepStrictEqual([await models.Product.countDocuments(), await models.Category.countDocuments(), await models.Sale.countDocuments()], [1, 1, 0]);
  assert.strictEqual(await readMarker(env.ctx, plain.tenant), null);
  // An empty shop is filled only when that is confirmed; refused, it is left as it was
  const empty = await env.createShop('empty-shop', { signIn: false });
  await assert.rejects(fillDemoShop(env.ctx, { slug: 'empty-shop', actor: 'test', confirmUnmarked: async () => false }), /Not confirmed/);
  assert.strictEqual(await readMarker(env.ctx, empty.tenant), null);
  await assert.rejects(runScript(['fill', '--slug', 'empty-shop']), (err) => err.code === 1 && /add --yes/.test(err.stderr));
  // An address that is reserved, and one that is free but not a shop
  await assert.rejects(runScript(['create', '--slug', 'demo']), (err) => err.code === 1 && /محجوز/.test(err.stderr));
  await assert.rejects(runScript(['reset', '--slug', 'no-such-shop', '--yes']), (err) => err.code === 1 && /No shop/.test(err.stderr));
});

test('a run stopped half way leaves no session, the next one finishes it without doubling anything, and the first invoice number stays', async () => {
  // A shop whose invoices start at 1001, filled with a history that ends early on the 2nd
  // of last month: the first hours of a month
  const shop = await env.createShop('demo-stop', { signIn: false, firstInvoiceNumber: 1001 });
  const stop = new AbortController();
  const [y, m] = dayOf(new Date()).split('-').map(Number);
  const now = zonedTime(TZ, new Date(Date.UTC(y, m - 2, 2)).toISOString().slice(0, 10), 5 * 60 + 40);
  // Stopped at its first progress line
  await assert.rejects(
    fillDemoShop(env.ctx, { slug: 'demo-stop', days: 7, now, actor: 'test', confirmUnmarked: async () => true, signal: stop.signal, log: (line) => /%/.test(line) && stop.abort() }),
    /Stopped/,
  );
  const { Session, AuditLog } = env.db.controlModels;
  assert.strictEqual(await Session.countDocuments({ tenantId: shop.tenant._id }), 0);
  const marker = await readMarker(env.ctx, shop.tenant);
  assert.deepStrictEqual([marker.state, marker.leaseUntil, marker.saleStart], ['filling', null, 1000]);
  const models = await env.db.tenantModels(shop.tenant);
  assert.ok((await models.Product.countDocuments()) > 0, 'some of it was made');
  // The owner never changed the first password: the gate the run opened is closed again
  assert.strictEqual((await models.User.findOne({ role: 'owner' }).lean()).mustChangePassword, true);
  // Its start was logged before anything changed, then that it failed
  const logged = await AuditLog.find({ tenantId: shop.tenant._id, action: /^demo\./ }).sort({ at: 1, _id: 1 }).lean();
  assert.deepStrictEqual(logged.map((e) => [e.action, e.result]), [['demo.fill.start', 'ok'], ['demo.fill', 'failed']]);
  assert.match(logged[1].details.error, /Stopped/);

  // The next run starts it again from nothing, and ends with the plan's records once each.
  // Meanwhile something else adds an expense to the shop: the run says so
  const lines = [];
  let written = null;
  const write = () => models.Expense.collection.insertOne({ date: new Date(), category: 'غير ذلك', amount: 1000, note: '', createdAt: new Date(), updatedAt: new Date() });
  const done = await fillDemoShop(env.ctx, { slug: 'demo-stop', days: 7, now, actor: 'test', log: (line) => lines.push(line) && /%/.test(line) && (written ??= write()) });
  await written;
  assert.match(lines[0], /the last run stopped before the end \(Stopped\): starting again/);
  assert.ok(done.foreign.some((line) => /^Expense: (\d+) from the run, (\d+) in the shop$/.test(line)), done.foreign.join('; '));
  assert.deepStrictEqual((await readMarker(env.ctx, shop.tenant)).warning, done.foreign);
  const plan = demoPlan({ seed: 2026, days: 7, now });
  assert.deepStrictEqual(
    [done.counts.sales, done.counts.products, done.counts.staff, done.counts.purchases],
    [plan.steps.filter((s) => s.kind === 'sale').length, 55, 3, plan.steps.filter((s) => s.kind === 'purchase').length],
  );
  assert.strictEqual(await Session.countDocuments({ tenantId: shop.tenant._id }), 0);
  // The wipe kept the shop's own numbering
  assert.strictEqual((await models.Sale.findOne().sort({ number: 1 }).lean()).number, 1001);

  // A reset, with nobody else using the shop: still from 1001, and nothing to report
  const again = await resetDemoShop(env.ctx, { slug: 'demo-stop', now, actor: 'test' });
  assert.deepStrictEqual(again.foreign, []);
  assert.strictEqual((await readMarker(env.ctx, shop.tenant)).warning, undefined);
  const numbers = (await models.Sale.find({}, 'number').sort({ number: 1 }).lean()).map((s) => s.number);
  assert.deepStrictEqual(numbers, numbers.map((_, i) => 1001 + i));
  const audited = await AuditLog.find({ tenantId: shop.tenant._id, action: /^demo\./ }).sort({ at: 1, _id: 1 }).lean();
  assert.deepStrictEqual(
    audited.slice(2).map((e) => [e.action, e.result, Boolean(e.details.foreign)]),
    [['demo.fill.start', 'ok', false], ['demo.fill', 'ok', true], ['demo.reset.start', 'ok', false], ['demo.reset', 'ok', false]],
  );

  // On the app's own report, neither month is at a loss, nor the month so far on any day
  await setOwnerPassword(env.ctx, shop.tenant._id, { password: FIRST_PASSWORD }, { actor: 'test' });
  const client = await signedIn(shop.tenant, 'owner');
  const fresh = await readMarker(env.ctx, shop.tenant);
  const from = midnight(`${fresh.firstDay.slice(0, 7)}-01`).toISOString();
  const to = midnight(nextDay(fresh.lastDay)).toISOString();
  const report = (groupBy) => ok(client, 'GET', `/api/sales/report?${new URLSearchParams({ from, to, groupBy, tz: TZ })}`);
  const months = (await report('month')).periods;
  assert.deepStrictEqual(months.map((p) => p.key), [fresh.firstDay.slice(0, 7), fresh.lastDay.slice(0, 7)]);
  for (const p of months) assert.ok(p.netProfit >= 0, `${p.key}: ${p.netProfit}`);
  const soFar = new Map();
  for (const p of (await report('day')).periods) {
    soFar.set(p.key.slice(0, 7), money((soFar.get(p.key.slice(0, 7)) ?? 0) + p.netProfit));
    assert.ok(soFar.get(p.key.slice(0, 7)) >= 0, `${p.key}: the month so far ${soFar.get(p.key.slice(0, 7))}`);
  }
});

// The month so far, as the summary shows it, from the plan alone and on the safe side: what
// customers paid on their accounts is left out. Returns each month's figure at the end of the
// history, and the lowest the last day's month reaches at any hour of the last day.
function monthsOf(plan) {
  const cost = new Map(PRODUCTS.map((p) => [p.key, p.cost]));
  // A packaged item at the dearest price the shop paid for it
  for (const s of plan.steps) if (s.kind === 'purchase') for (const l of s.lines) cost.set(l.product, Math.max(cost.get(l.product), l.price));
  const price = new Map(PRODUCTS.map((p) => [p.key, p.price]));
  const sales = new Map();
  const booked = []; // { at: when it is there, month, amount }
  const book = (at, when, amount) => booked.push({ at, month: planDayOf(TZ, when).slice(0, 7), amount });
  for (const s of plan.steps) {
    if (s.kind === 'price') price.set(s.product, s.salePrice);
    else if (s.kind === 'sale') {
      const lines = s.lines.map((l) => ({ ...l, price: price.get(l.product), cost: cost.get(l.product) }));
      const sale = { lines, total: s.total, debt: s.customer ? s.total - s.paid : 0 };
      sales.set(s.key, sale);
      book(s.at, s.at, s.total - lines.reduce((sum, l) => sum + l.cost * l.quantity, 0) - sale.debt);
    } else if (s.kind === 'return') {
      // The profit given back; on an account, the refund comes off what the invoice owes
      const sale = sales.get(s.sale);
      const lines = s.lines ? s.lines.map((l) => ({ ...sale.lines[l.line], quantity: l.quantity })) : sale.lines;
      const amount = s.lines ? lines.reduce((sum, l) => sum + l.price * l.quantity, 0) : sale.total;
      const toAccount = Math.min(amount, sale.debt);
      sale.debt -= toAccount;
      book(s.at, s.at, toAccount - amount + lines.reduce((sum, l) => sum + l.cost * l.quantity, 0));
    } else if (s.kind === 'expense') book(s.at, Date.parse(s.body.date), -s.body.amount);
  }
  const months = new Map();
  for (const b of booked) months.set(b.month, (months.get(b.month) ?? 0) + b.amount);
  const current = plan.lastDay.slice(0, 7);
  let lowest = Infinity;
  for (let hour = 0; hour <= 24; hour++) {
    const t = Math.min(zonedTime(TZ, plan.lastDay, hour * 60), plan.cutoff);
    lowest = Math.min(lowest, booked.filter((b) => b.at <= t && b.month === current).reduce((sum, b) => sum + b.amount, 0));
  }
  return { months, lowest };
}

test('the history never shows a loss, for a whole month or for the month so far, whatever day it ends', () => {
  // Histories starting on every day from late January to early March (a 31-day month, then
  // the 28 days of February), and long ones starting on the days the month's costs turn on
  const firsts = Array.from({ length: 43 }, (_, i) => addDays('2026-01-22', i));
  const runs = [
    ...firsts.flatMap((first) => [7, 10].map((days) => [first, days])),
    ...['2026-01-29', '2026-02-01', '2026-02-10', '2026-02-24', '2026-03-02'].map((first) => [first, 30]),
    ...['2026-01-01', '2026-01-02', '2026-01-08', '2026-01-15', '2026-01-16', '2026-01-25', '2026-01-29', '2026-01-31', '2026-02-24'].map((first) => [first, 90]),
  ];
  for (const [first, days] of runs) {
    // Ended late on its last day: every hour of that day is a moment the history could end at
    const plan = demoPlan({ days, now: zonedTime(TZ, addDays(first, days - 1), 24 * 60 - 1 / 60) });
    assert.strictEqual(plan.firstDay, first);
    const { months, lowest } = monthsOf(plan);
    for (const [month, net] of months) assert.ok(net >= 0, `${days} days from ${first}: ${month} ${net}`);
    assert.ok(lowest >= 0, `${days} days from ${first}: the month so far ${lowest} on ${plan.lastDay}`);
    // The monthly payments on their days, none in the history's first week, the first
    // month's wages for its days only, each month's rent once
    const expenses = plan.steps.filter((s) => s.kind === 'expense').map((s) => ({ ...s.body, day: planDayOf(TZ, Date.parse(s.body.date)) }));
    const index = (day) => Math.round((Date.parse(day) - Date.parse(first)) / 86400000);
    for (const e of expenses.filter((x) => ['إيجار', 'اشتراك مولدة', 'رواتب'].includes(x.category))) {
      assert.ok(index(e.day) >= 7, `${e.category} on ${e.day}, in the first week of ${first}`);
      const dueOn = { إيجار: '15', 'اشتراك مولدة': '05', رواتب: addDays(e.day, 1).endsWith('-01') && e.day.slice(8) };
      assert.strictEqual(e.day.slice(8), dueOn[e.category], `${e.category} on ${e.day}`);
      if (e.category === 'رواتب' && first.slice(0, 7) === e.day.slice(0, 7) && !first.endsWith('-01')) assert.match(e.note, new RegExp(`\\(من ${Number(first.slice(8))} `));
    }
    const rents = expenses.filter((x) => x.category === 'إيجار').map((x) => x.day.slice(0, 7));
    assert.strictEqual(new Set(rents).size, rents.length);
  }
});

test('Ctrl+C while create waits for the shop to open, or before a fill, stops at once and changes nothing', async () => {
  // A shop still being set up, as the control database shows it
  const ctx = {
    db: {
      controlModels: {
        Tenant: { findById: () => ({ lean: async () => ({ slug: 'demo-wait', status: 'provisioning' }) }) },
        Job: { findOne: () => ({ sort: () => ({ lean: async () => null }) }) },
      },
    },
  };
  const stop = new AbortController();
  const started = Date.now();
  setTimeout(() => stop.abort(), 50);
  await assert.rejects(waitUntilActive(ctx, 'id', { pollMs: 60000, timeoutMs: 120000, signal: stop.signal }), (err) => err.stoppedWaiting && /Stopped while "demo-wait" is still being set up/.test(err.message));
  assert.ok(Date.now() - started < 5000, 'without waiting out the poll');
  await assert.rejects(waitUntilActive(ctx, 'id', { signal: AbortSignal.abort() }), /Stopped while/);
  // A fill stopped before it starts takes no lease and writes nothing
  const { AuditLog } = env.db.controlModels;
  const marker = await readMarker(env.ctx, demo.tenant);
  const audited = await AuditLog.countDocuments();
  await assert.rejects(resetDemoShop(env.ctx, { slug: SLUG, actor: 'test', signal: AbortSignal.abort() }), /Stopped: nothing was changed/);
  assert.deepStrictEqual(await readMarker(env.ctx, demo.tenant), marker);
  assert.strictEqual(await AuditLog.countDocuments(), audited);
});

test("reset keeps the owner's account, ends the staff's sessions, touches nothing else and gives a fresh history", async () => {
  const { tenant, models, client } = demo;
  const { Tenant, Host, Job, Session, LoginAttempt, AuditLog } = env.db.controlModels;
  // A cashier signed in on their own device, with a password from the staff card
  const ali = await models.User.findOne({ usernameLower: 'ali' }).lean();
  await resetUserPassword(env.ctx, tenant._id, ali._id, FIRST_PASSWORD, { actor: 'test' });
  const cashier = await signedIn(tenant, 'ali');
  assert.strictEqual((await cashier.request('GET', '/api/auth/me')).status, 200);
  const owner = await ownerOf(models);
  const marker = await readMarker(env.ctx, tenant);
  const others = await Promise.all(['plain-shop', 'demo-twin'].map(async (slug) => normalized(await env.db.tenantModels(await tenantOf(slug)))));
  const control = async () => ({
    tenants: await Tenant.find().lean(),
    hosts: await Host.find().lean(),
    jobs: await Job.find().lean(),
    attempts: await LoginAttempt.find().lean(),
    sessions: (await Session.find().lean()).map((s) => s._id).sort(),
  });
  const before = await control();
  const audited = await AuditLog.countDocuments();

  const out = await runScript(['reset', '--slug', SLUG, '--yes', '--days', '7']);
  assert.match(out.stdout, /Resetting the demo shop "demo-market"/);

  // The owner's account as it was, and still signed in; the cashier signed out
  const ownerAfter = await ownerOf(models);
  assert.deepStrictEqual([ownerAfter.passwordHash, ownerAfter.authVersion, ownerAfter.mustChangePassword, +ownerAfter.updatedAt], [owner.passwordHash, owner.authVersion, owner.mustChangePassword, +owner.updatedAt]);
  assert.strictEqual((await client.request('GET', '/api/auth/me')).status, 200);
  assert.strictEqual((await cashier.request('GET', '/api/auth/me')).status, 401);
  const aliAfter = await models.User.findOne({ usernameLower: 'ali' }).lean();
  assert.notStrictEqual(String(aliAfter._id), String(ali._id));

  // A new history of 7 days ending today, made like the first
  const fresh = await readMarker(env.ctx, tenant);
  assert.deepStrictEqual([fresh.state, fresh.days, fresh.seed], ['filled', 7, marker.seed]);
  assert.ok(fresh.filledAt > marker.filledAt && fresh.lastDay >= marker.lastDay);
  const { sales } = await raw(models);
  assert.strictEqual(sales[0].number, 1);
  assert.ok(sales[0].createdAt >= midnight(fresh.firstDay) && sales.at(-1).createdAt <= fresh.until);

  // The control database: the cashier's session gone, the reset and its staff in the log, nothing else
  const after = await control();
  const cashierSessions = before.sessions.filter((id) => !after.sessions.includes(id));
  assert.strictEqual(cashierSessions.length, 1);
  assert.deepStrictEqual({ ...after, sessions: null }, { ...before, sessions: null });
  assert.deepStrictEqual(after.sessions, before.sessions.filter((id) => id !== cashierSessions[0]));
  const added = await AuditLog.find().sort({ at: 1, _id: 1 }).skip(audited).lean();
  assert.deepStrictEqual(
    added.map((e) => [e.action, e.actor.replace(/^cli:.*/, 'cli'), String(e.tenantId)]),
    [
      ['demo.reset.start', 'cli', String(tenant._id)],
      ['staff.create', 'shop:owner', String(tenant._id)],
      ['staff.create', 'shop:owner', String(tenant._id)],
      ['staff.create', 'shop:owner', String(tenant._id)],
      ['staff.disable', 'shop:owner', String(tenant._id)],
      ['demo.reset', 'cli', String(tenant._id)],
    ],
  );
  assert.doesNotMatch(out.stderr, /Warning/);
  // The other shops' records are as they were
  const othersAfter = await Promise.all(['plain-shop', 'demo-twin'].map(async (slug) => normalized(await env.db.tenantModels(await tenantOf(slug)))));
  assert.deepStrictEqual(othersAfter, others);
});
