/*
 * The demo shop (scripts/demo-shop.js): one shop filled with the history of a made-up
 * restaurant, for showing the app to prospective customers.
 *
 * Every record is made by the app itself. The app runs here, in this process, on a port of
 * 127.0.0.1 against the real databases (as test/support/harness.js runs it), and receives,
 * one at a time and in the order of the plan (services/demo-plan.js), the requests the
 * owner and the staff would have sent from their pages: settings, staff, the menu, the
 * suppliers' invoices and what was paid on them, the sales and returns, the customers'
 * payments, the expenses, a stocktake. Stock, unit costs, invoice numbers, balances and
 * every figure of the reports are therefore the app's own. The sessions are made here
 * through the app's own session store, so no password is needed or known; they are deleted
 * at the end, whatever happened.
 *
 * Then each record is moved to the moment it was planned for. Each request is a window of
 * real time, and the windows never overlap: every date the app wrote into the shop's
 * database during a window (createdAt and updatedAt, returns[].at, a debt entry's date,
 * appliedAt, a stocktake line's countedAt, a staff account's disabledAt...) becomes exactly
 * that request's planned moment, so the same plan always gives the same dates. Dates the
 * requests sent themselves (a supplier invoice's date, an expense's day) are already planned
 * moments, all before the run, and stay. Two requests are always at least a second apart in
 * the plan, so the order of everything is kept: the history reads exactly as if it had been
 * entered day by day.
 *
 * Nothing else may write to the shop during a run: the requests follow each other with
 * almost no gap, so a record someone makes meanwhile (on the shop's page, say) falls inside
 * one of the run's windows and moves with it, to a day in the past. Such records cannot be
 * told apart by their dates. The run counts what it made and compares that with what the
 * shop holds at the end, so a record added or removed meanwhile is reported (an edit of one
 * of the run's own records is not); the command line then says to run reset again.
 *
 * The shop's own database carries the marker { _id: 'demo' } in its demo_meta collection:
 * created, filling or filled. Only a shop with the marker is ever wiped (reset, or a fill
 * that stopped half way); a shop without it and with business data is refused. The owner's
 * account is never replaced: its password and authVersion stay as they are. A wipe keeps
 * the number the shop's invoices start from (createTenant can start them above 1).
 */
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import mongoose from 'mongoose';
import { createApp } from '../app.js';
import { createRegistry } from '../lib/registry.js';
import { createSessionStore } from '../lib/sessions.js';
import { createWorker } from '../lib/worker.js';
import { generatePassword } from '../lib/passwords.js';
import { publicUrl } from '../lib/config.js';
import { DEFAULT_CATEGORY, createTenant, primaryHost, revokeSessions } from './tenants.js';
import { DEFAULT_DAYS, DEFAULT_SEED, dayOf, demoPlan } from './demo-plan.js';
import { DEMO_LABEL, DEMO_OWNER_NAME, DEMO_SETTINGS, DEMO_SHOP_NAME, PRODUCTS } from './demo-data.js';

export const DEMO_VERSION = 1;
export const DEMO_META = 'demo_meta';
const MARKER = 'demo';
// What the sessions made here say they are (Session.ua), so a run killed before its clean-up
// leaves nothing the next run cannot find
export const DEMO_AGENT = 'pos-demo-shop';
// A run holds the shop this long, renewed as it goes: a run that died lets go by itself
const LEASE_MS = 2 * 60 * 1000;
const BEAT_MS = 30 * 1000;
// Two requests are at least this far apart in the history
const STEP_MS = 1000;
// The shop's own data, emptied by a reset (the settings stay, and every account but the owner's goes)
const BUSINESS = ['Category', 'Product', 'Sale', 'Counter', 'Expense', 'Customer', 'DebtEntry', 'StockCount', 'Purchase'];

const fail = (message, fields = {}) => Object.assign(new Error(message), fields);
const metaOf = (ctx, tenant) => ctx.db.tenantConnection(tenant).db.collection(DEMO_META);

// The shop's marker, or null: a shop without one was never filled by this
export const readMarker = (ctx, tenant) => metaOf(ctx, tenant).findOne({ _id: MARKER });

// Anything a shop's owner or staff made: every shop starts with its settings, its owner and
// the category «عام», and nothing else
export async function hasBusinessData(models) {
  const found = await Promise.all([
    ...['Product', 'Sale', 'Purchase', 'Expense', 'Customer', 'DebtEntry', 'StockCount'].map((name) => models[name].exists({})),
    models.User.exists({ role: 'staff' }),
    models.Category.exists({ name: { $ne: DEFAULT_CATEGORY } }),
  ]);
  return found.some(Boolean);
}

// What the shop's invoice counter stood at before its first sale: the next invoice is this
// plus one (createTenant starts it at the first invoice number the admin chose, less one)
async function saleStartOf(models) {
  const first = await models.Sale.findOne({}, 'number').sort({ number: 1 }).lean();
  if (first) return first.number - 1;
  return (await models.Counter.findById('sale').lean())?.seq ?? 0;
}

// Empties the shop's business data, ends the staff accounts' sessions and removes them. The
// owner's account and the settings stay, and the invoices start again from the shop's own
// first number (saleStart, kept in the marker).
async function wipe(ctx, tenant, models, saleStart) {
  for (const name of BUSINESS) await models[name].deleteMany({});
  if (saleStart > 0) await models.Counter.updateOne({ _id: 'sale' }, { $set: { seq: saleStart } }, { upsert: true });
  const staff = await models.User.find({ role: 'staff' }, '_id').lean();
  for (const { _id } of staff) await revokeSessions(ctx, tenant._id, _id);
  await models.User.deleteMany({ role: 'staff' });
}

// What the shop holds, counted the ways a run adds to it: the records, the returns on the
// invoices, the customers' payments (a debt by hand counts too: a run makes none) and the
// payments on the suppliers' invoices
async function tally(models) {
  const sizes = async (model, field) => (await model.aggregate([{ $group: { _id: null, n: { $sum: { $size: { $ifNull: [`$${field}`, []] } } } } }]))[0]?.n ?? 0;
  const [Category, Product, staff, Customer, Sale, returns, payments, Purchase, purchasePayments, Expense, StockCount] = await Promise.all([
    models.Category.countDocuments(),
    models.Product.countDocuments(),
    models.User.countDocuments({ role: 'staff' }),
    models.Customer.countDocuments(),
    models.Sale.countDocuments(),
    sizes(models.Sale, 'returns'),
    models.DebtEntry.countDocuments({ kind: { $in: ['payment', 'manual'] } }),
    models.Purchase.countDocuments(),
    sizes(models.Purchase, 'payments'),
    models.Expense.countDocuments(),
    models.StockCount.countDocuments(),
  ]);
  return { Category, Product, staff, Customer, Sale, returns, payments, Purchase, purchasePayments, Expense, StockCount };
}

/* Running the plan through the app */

// One request to the app on this machine; the answer as { status, data }
function call(agent, port, method, path, body, headers) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, agent, headers: { ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = text;
          try {
            data = res.statusCode === 204 ? null : JSON.parse(text);
          } catch {
            // not JSON: kept as text for the error message
          }
          resolve({ status: res.statusCode, data });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/*
 * Sends the plan to the app, request after request. Returns { windows, made }: the windows,
 * { start, end, at } in the order sent (real start and end, planned moment), for the move
 * that follows, and what the requests added to the shop, counted as tally() counts. `beat`
 * is called every BEAT_MS while it runs (the lease); `signal` stops it.
 */
async function runPlan(ctx, tenant, models, plan, { log, beat, signal }) {
  const { db, config } = ctx;
  const { Session } = db.controlModels;
  // The app as the server runs it, but without its request log (one line per request)
  const registry = createRegistry(db.controlModels, { pollMs: 0, reloadMs: 0 });
  await registry.start();
  const app = createApp({ db, registry, config: Object.freeze({ ...config, requestLog: false }), worker: createWorker(config, db) });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const host = primaryHost(config, tenant.slug);
  const origin = `${config.publicScheme}://${host}`;
  const store = createSessionStore({ Session, config, kind: 'tenant' });
  const sessions = new Map(); // who -> { cookie, csrf }
  const minted = [];
  const windows = [];
  // What the app made, by the plan's names for it
  const ids = { category: new Map(), product: new Map(), customer: new Map(), sale: new Map(), purchase: new Map(), user: new Map() };
  const made = { Category: 0, Product: 0, staff: 0, Customer: 0, Sale: 0, returns: 0, payments: 0, Purchase: 0, purchasePayments: 0, Expense: 0, StockCount: 0 };
  let last = { end: 0, at: 0 };
  let lastBeat = Date.now();

  // A session of the account, made as signing in makes one: no password, no cookie leaves here
  async function signIn(who) {
    const id = who === 'owner' ? (await models.User.findOne({ role: 'owner' }, '_id').lean())._id : ids.user.get(who);
    const user = await models.User.findById(id, 'authVersion').lean();
    let value = null;
    const session = await store.start({ headers: { 'user-agent': DEMO_AGENT }, ip: '127.0.0.1' }, { cookie: (name, v) => (value = v) }, { tenantId: tenant._id, userId: user._id, authVersion: user.authVersion });
    minted.push(session._id);
    const signedIn = { cookie: `${store.cookieName}=${value}`, csrf: session.csrf };
    sessions.set(who, signedIn);
    return signedIn;
  }

  // One request of `who` at the planned moment `at`, in a window of its own
  async function send(who, at, method, path, body) {
    if (signal?.aborted) throw fail('Stopped');
    const session = sessions.get(who) ?? (await signIn(who));
    const headers = { host, cookie: session.cookie, 'user-agent': DEMO_AGENT, ...(method === 'GET' ? {} : { origin, 'x-csrf-token': session.csrf }) };
    // Strictly after the last window: no moment belongs to two requests
    let start = Date.now();
    while (start <= last.end) start = Date.now();
    const res = await call(agent, port, method, path, body, headers);
    last = { start, end: Date.now(), at };
    windows.push(last);
    if (res.status >= 400) {
      throw fail(`${method} ${path} -> ${res.status} ${typeof res.data === 'object' ? res.data?.error : String(res.data).slice(0, 200)}`);
    }
    if (Date.now() - lastBeat > BEAT_MS) {
      lastBeat = Date.now();
      await beat();
    }
    return res.data;
  }

  // Each request of a step gets its own moment: the step's, then a few seconds apart
  const momentsOf = (step) => {
    let k = 0;
    return () => {
      const at = Math.max(step.at + 2000 * k++, last.at + STEP_MS);
      if (at >= plan.now) throw fail('The plan ran past its own time');
      return at;
    };
  };
  const iso = (ms) => new Date(ms).toISOString();
  const product = (key) => ids.product.get(key);

  const kinds = {
    settings: (step, next) => send(step.as, next(), 'PUT', '/api/settings', step.body),
    // The «عام» every shop starts with: a restaurant has no use for it
    async dropDefaultCategory(step, next) {
      const general = (await send(step.as, next(), 'GET', '/api/categories')).find((c) => c.name === DEFAULT_CATEGORY && c.productCount === 0);
      if (general) {
        await send(step.as, next(), 'DELETE', `/api/categories/${general._id}`);
        made.Category--;
      }
    },
    async category(step, next) {
      ids.category.set(step.key, (await send(step.as, next(), 'POST', '/api/categories', step.body))._id);
      made.Category++;
    },
    async product(step, next) {
      ids.product.set(step.key, await send(step.as, next(), 'POST', '/api/products', { ...step.body, category: ids.category.get(step.body.category) }));
      made.Product++;
    },
    // The first password in the answer is not kept: the owner gives a new one from the staff
    // card when he wants to show the employee's side. The account is marked as an employee's
    // who has signed in and chosen their own password, when their first shift began.
    async staff(step, next) {
      const { staff } = await send(step.as, next(), 'POST', '/api/staff', step.body);
      ids.user.set(step.key, staff.id);
      made.staff++;
      const days = plan.staffDays[step.key];
      await models.User.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(staff.id) },
        { $set: { mustChangePassword: false, ...(days ? { passwordChangedAt: new Date(days.first), lastLoginAt: new Date(days.last) } : {}) } },
      );
    },
    async disableStaff(step, next) {
      await send(step.as, next(), 'POST', `/api/staff/${ids.user.get(step.key)}/disable`);
      sessions.delete(step.key);
    },
    async customer(step, next) {
      ids.customer.set(step.key, (await send(step.as, next(), 'POST', '/api/customers', step.body))._id);
      made.Customer++;
    },
    // As the cashier sends it: an empty «paid» is the exact amount (or, on account, nothing now)
    async sale(step, next) {
      const exact = step.customer ? step.paid === 0 : step.paid === step.total;
      const body = {
        items: step.lines.map((l) => ({ productId: product(l.product)._id, quantity: l.quantity, mode: 'retail' })),
        paid: exact ? undefined : step.paid,
        ...(step.customer ? { paymentType: 'credit', customerId: ids.customer.get(step.customer) } : {}),
        clientId: step.clientId,
      };
      const sale = await send(step.as, next(), 'POST', '/api/sales', body);
      if (sale.total !== step.total) throw fail(`Invoice ${sale.number}: the plan expected ${step.total}, the app made ${sale.total}`);
      ids.sale.set(step.key, sale._id);
      made.Sale++;
    },
    async return(step, next) {
      await send(step.as, next(), 'POST', `/api/sales/${ids.sale.get(step.sale)}/returns`, { ...(step.lines ? { items: step.lines } : {}), clientId: step.clientId });
      made.returns++;
    },
    // A share of what the customer owes, as read on their account first, or a set amount
    async payment(step, next) {
      const id = ids.customer.get(step.customer);
      let amount = step.amount;
      if (amount === undefined) {
        const { balance } = await send(step.as, next(), 'GET', `/api/customers/${id}`);
        amount = Math.floor((balance * step.share) / step.step) * step.step;
      }
      if (amount <= 0) return;
      const at = next();
      await send(step.as, at, 'POST', `/api/customers/${id}/entries`, { kind: 'payment', amount, note: step.note, date: iso(at) });
      made.payments++;
    },
    async purchase(step, next) {
      const at = next();
      const body = {
        supplier: step.supplier,
        reference: step.reference,
        date: iso(at),
        note: '',
        items: step.lines.map((l) => ({ product: product(l.product)._id, quantity: l.quantity, mode: l.mode, price: l.price })),
        paid: step.paid,
        clientId: step.clientId,
      };
      const purchase = await send(step.as, at, 'POST', '/api/purchases', body);
      if (purchase.total !== step.total) throw fail(`Purchase ${purchase.number}: the plan expected ${step.total}, the app made ${purchase.total}`);
      ids.purchase.set(step.key, purchase._id);
      made.Purchase++;
      // What was paid with the invoice is its first payment
      if (purchase.paid > 0) made.purchasePayments++;
    },
    // What is left on a supplier's invoice, as its page shows it
    async purchasePayment(step, next) {
      const id = ids.purchase.get(step.purchase);
      const { remaining } = await send(step.as, next(), 'GET', `/api/purchases/${id}`);
      if (remaining <= 0) return;
      const at = next();
      await send(step.as, at, 'POST', `/api/purchases/${id}/payments`, { amount: remaining, date: iso(at) });
      made.purchasePayments++;
    },
    async expense(step, next) {
      await send(step.as, next(), 'POST', '/api/expenses', step.body);
      made.Expense++;
    },
    // The product form as it sends an edit of a dish: its fields, without any stock
    async price(step, next) {
      const p = product(step.product);
      const body = { barcode: p.barcode, name: p.name, category: p.category._id, purchasePrice: p.purchasePrice, salePrice: step.salePrice, unit: p.unit, hasWholesale: p.hasWholesale, trackStock: p.trackStock };
      ids.product.set(step.product, await send(step.as, next(), 'PUT', `/api/products/${p._id}`, body));
    },
    // Every packaged item counted, some found a little short or over, then applied
    async stocktake(step, next) {
      const count = await send(step.as, next(), 'POST', '/api/stockcounts');
      made.StockCount++;
      const onShelf = new Map((await send(step.as, next(), 'GET', '/api/products')).map((p) => [String(p._id), p.stock]));
      const deltas = new Map(step.deltas);
      for (const p of PRODUCTS.filter((x) => x.tracked)) {
        const id = String(product(p.key)._id);
        await send(step.as, next(), 'PUT', `/api/stockcounts/${count._id}/lines/${id}`, { counted: Math.max(0, onShelf.get(id) + (deltas.get(p.key) ?? 0)) });
      }
      await send(step.as, next(), 'POST', `/api/stockcounts/${count._id}/apply`);
    },
  };

  try {
    const tenth = Math.ceil(plan.steps.length / 10);
    for (const [i, step] of plan.steps.entries()) {
      await kinds[step.kind](step, momentsOf(step));
      if ((i + 1) % tenth === 0 && i + 1 < plan.steps.length) log(`  ${((i + 1) / tenth) * 10}% (${dayOf(plan.timeZone, step.at)})`);
    }
    return { windows, made };
  } finally {
    agent.destroy();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    registry.stop();
    await Session.deleteMany({ _id: { $in: minted } });
  }
}

/*
 * Moves every date written during the run to its request's planned moment (see the top of
 * this file). The owner's account is left as it is: only what the run made moves. Returns
 * how many records moved and how many dates fell after one request ended and before the
 * next began, or after the last. That is no proof the shop was left alone: the gaps are a
 * millisecond or so, and a date someone else wrote meanwhile is almost always inside a
 * request's window, where it moves unnoticed (fillDemoShop counts the records for that).
 */
async function moveToPlannedMoments(models, windows) {
  if (!windows.length) return { moved: 0, between: 0 };
  const first = windows[0].start;
  let between = 0;
  const momentOf = (t) => {
    let lo = 0;
    let hi = windows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (windows[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    if (t > windows[lo].end) between++;
    return windows[lo].at;
  };
  // Every date in a record, its arrays and subdocuments included: [value, changed]
  const walk = (value) => {
    if (value instanceof Date) {
      const t = value.getTime();
      return t >= first ? [new Date(momentOf(t)), true] : [value, false];
    }
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((v) => {
        const [moved, c] = walk(v);
        changed ||= c;
        return moved;
      });
      return [out, changed];
    }
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      let changed = false;
      const out = {};
      for (const [key, v] of Object.entries(value)) {
        const [moved, c] = walk(v);
        changed ||= c;
        out[key] = moved;
      }
      return [out, changed];
    }
    return [value, false];
  };
  let moved = 0;
  const targets = [...BUSINESS.map((name) => [models[name], {}]), [models.Setting, {}], [models.User, { role: 'staff' }]];
  for (const [model, filter] of targets) {
    let batch = [];
    const flush = async () => {
      if (batch.length) await model.collection.bulkWrite(batch, { ordered: false });
      moved += batch.length;
      batch = [];
    };
    for await (const doc of model.collection.find(filter)) {
      const [out, changed] = walk(doc);
      if (!changed) continue;
      batch.push({ replaceOne: { filter: { _id: doc._id }, replacement: out } });
      if (batch.length >= 500) await flush();
    }
    await flush();
  }
  return { moved, between };
}

/* The shop's figures, for the marker, the audit log and the command line */

export async function demoCounts(models) {
  const [products, sales, returns, customers, purchases, expenses, staff, stocktakes] = await Promise.all([
    models.Product.countDocuments(),
    models.Sale.countDocuments(),
    models.Sale.aggregate([{ $group: { _id: null, n: { $sum: { $size: '$returns' } } } }]),
    models.Customer.countDocuments(),
    models.Purchase.countDocuments(),
    models.Expense.countDocuments(),
    models.User.countDocuments({ role: 'staff' }),
    models.StockCount.countDocuments({ status: 'applied' }),
  ]);
  return { products, sales, returns: returns[0]?.n ?? 0, customers, purchases, expenses, staff, stocktakes };
}

/*
 * Fills the shop at `slug` with the demo history, or (reset) replaces the demo history it
 * has with a new one dated up to now. Returns { tenant, filled: false, marker } when the shop
 * was filled already (reset to start again), else { tenant, filled: true, plan: { firstDay,
 * lastDay, seed, days }, counts, moved, foreign, ms }. foreign lists what changed in the shop
 * besides the run's own requests (empty when nothing did): someone used the shop meanwhile,
 * those records sit on wrong days, and a reset puts it right.
 *   seed, days: the history's (default: the shop's last ones for a reset, else the defaults)
 *   now: the moment it ends at (the tests); actor: who, for the audit log
 *   confirmUnmarked: for a fill, a shop without the marker and without business data is
 *     filled only when this says yes (the command line asks)
 *   log: progress lines; signal: an AbortSignal to stop at the next request
 */
export async function fillDemoShop(ctx, { slug, reset = false, seed, days, now, actor = 'system', confirmUnmarked = null, log = () => {}, signal } = {}) {
  const started = Date.now();
  if (signal?.aborted) throw fail('Stopped: nothing was changed');
  if (now !== undefined && !(now <= started)) throw fail('The history cannot end in the future');
  const { db } = ctx;
  const { Tenant, AuditLog } = db.controlModels;
  const tenant = await Tenant.findOne({ slug: String(slug ?? '').trim().toLowerCase() }).lean();
  if (!tenant) throw fail(`No shop with the address "${slug}"`);
  if (tenant.status !== 'active') throw fail(`"${tenant.slug}" is ${tenant.status}: only an active shop can be filled`);
  const models = await db.tenantModels(tenant);
  const marker = await readMarker(ctx, tenant);

  if (reset && !marker) throw fail(`"${tenant.slug}" is not a demo shop (no demo marker in its database): nothing was changed`);
  if (!reset && marker?.state === 'filled') return { tenant, filled: false, marker };
  if (!marker) {
    if (await hasBusinessData(models)) throw fail(`"${tenant.slug}" already has products, sales or staff and is not a demo shop: nothing was changed`);
    if (confirmUnmarked && !(await confirmUnmarked(tenant))) throw fail('Not confirmed: nothing was changed');
  }
  const owner = await models.User.findOne({ role: 'owner' }).lean();
  if (!owner) throw fail(`"${tenant.slug}" has no owner account (npm run tenant:owner makes one)`);
  if (owner.disabledAt) throw fail(`The owner's account of "${tenant.slug}" is disabled`);

  seed = seed ?? (reset ? marker.seed : undefined) ?? DEFAULT_SEED;
  days = days ?? (reset ? marker.days : undefined) ?? DEFAULT_DAYS;
  // The owner's «must change the password» as it was before any run touched it: a run that
  // died with it lifted kept the original in the marker
  const ownerFlag =
    marker?.ownerFlag && marker.ownerFlag.authVersion === owner.authVersion ? marker.ownerFlag : { mustChangePassword: Boolean(owner.mustChangePassword), authVersion: owner.authVersion };
  // The number before the shop's first invoice, as it was before the demo's first sale
  const saleStart = marker?.saleStart ?? (await saleStartOf(models));

  // The shop is this run's until it ends: another run at the same time is refused
  if (signal?.aborted) throw fail('Stopped: nothing was changed');
  const meta = metaOf(ctx, tenant);
  const lease = () => new Date(Date.now() + LEASE_MS);
  try {
    await meta.updateOne(
      { _id: MARKER, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: new Date() } }] },
      { $set: { version: DEMO_VERSION, state: 'filling', seed, days, startedAt: new Date(), by: actor, ownerFlag, saleStart, leaseUntil: lease() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
  } catch (err) {
    if (err?.code === 11000) throw fail(`Another run is filling "${tenant.slug}" right now (or one stopped less than ${LEASE_MS / 60000} minutes ago): try again in a moment`);
    throw err;
  }
  const action = reset ? 'demo.reset' : 'demo.fill';
  const audit = (result, details, suffix = '') =>
    AuditLog.record({ actor, action: `${action}${suffix}`, tenantId: tenant._id, tenantSlug: tenant.slug, details: { seed, days, ...details }, result });

  try {
    // Logged before anything changes: a run killed on the way (its terminal closed) still
    // leaves who started it and when
    await audit('ok', marker?.state === 'filling' ? { resumes: true } : {}, '.start');
    if (marker?.state === 'filling') log(`  the last run stopped before the end${marker.error ? ` (${marker.error})` : ''}: starting again from nothing`);
    // Sessions a run killed before its clean-up left behind
    await forgetDemoSessions(ctx, tenant);
    // Leftovers of the demo only: a shop without the marker has no business data (above)
    if (marker) await wipe(ctx, tenant, models, saleStart);
    // The run's owner session needs the first-password gate open; it closes again below
    if (ownerFlag.mustChangePassword) await models.User.collection.updateOne({ _id: owner._id }, { $set: { mustChangePassword: false } });
    const plan = demoPlan({ seed, days, now: now ?? Date.now() });
    log(`  ${plan.steps.length} steps, ${plan.firstDay} to ${plan.lastDay}`);
    const before = await tally(models);
    const { windows, made } = await runPlan(ctx, tenant, models, plan, { log, signal, beat: () => meta.updateOne({ _id: MARKER }, { $set: { leaseUntil: lease() } }) });
    log('  moving each record to its day');
    const { moved, between } = await moveToPlannedMoments(models, windows);
    // What else changed the shop meanwhile: records the run did not make, or removed
    const after = await tally(models);
    const foreign = Object.keys(made)
      .filter((key) => after[key] !== before[key] + made[key])
      .map((key) => `${key}: ${before[key] + made[key]} from the run, ${after[key]} in the shop`);
    if (between) foreign.push(`${between} dates written between the run's requests or after them`);
    const counts = await demoCounts(models);
    const range = { firstDay: plan.firstDay, lastDay: plan.lastDay, until: new Date(plan.cutoff) };
    await meta.updateOne(
      { _id: MARKER },
      { $set: { state: 'filled', filledAt: new Date(), ...range, counts, leaseUntil: null, ...(foreign.length ? { warning: foreign } : {}) }, $unset: { error: 1, ...(foreign.length ? {} : { warning: 1 }) } },
    );
    await audit('ok', { from: plan.firstDay, to: plan.lastDay, ...counts, ...(foreign.length ? { foreign } : {}) });
    return { tenant, filled: true, plan: { seed, days, ...range }, counts, moved, foreign, ms: Date.now() - started };
  } catch (err) {
    await meta.updateOne({ _id: MARKER }, { $set: { leaseUntil: null, error: String(err.message).slice(0, 300) } }).catch(() => {});
    await audit('failed', { error: String(err.message).slice(0, 200) }).catch(() => {});
    throw err;
  } finally {
    if (ownerFlag.mustChangePassword) {
      // Only over the account as this run found it: a new password given meanwhile set its own
      await models.User.collection.updateOne({ _id: owner._id, authVersion: ownerFlag.authVersion }, { $set: { mustChangePassword: true } }).catch(() => {});
    }
  }
}

export const resetDemoShop = (ctx, options) => fillDemoShop(ctx, { ...options, reset: true });

// Ends the sessions a run killed before its clean-up left behind (they would expire anyway)
export async function forgetDemoSessions(ctx, tenant) {
  const { deletedCount } = await ctx.db.controlModels.Session.deleteMany({ kind: 'tenant', tenantId: tenant._id, ua: DEMO_AGENT });
  return deletedCount;
}

/* Creating the shop */

// Waits until the shop is open: on the server its certificate comes from the root worker
// (within about a minute) and the running server finishes the setting up. `signal` (Ctrl+C)
// stops the wait at once; the shop goes on being set up, and the same create fills it later.
export async function waitUntilActive(ctx, tenantId, { timeoutMs = 5 * 60 * 1000, pollMs = 3000, signal } = {}) {
  const { Tenant, Job } = ctx.db.controlModels;
  const until = Date.now() + timeoutMs;
  const stopped = (slug) => fail(`Stopped while "${slug}" is still being set up: nothing was filled`, { stoppedWaiting: true });
  for (;;) {
    if (signal?.aborted) throw stopped((await Tenant.findById(tenantId, 'slug').lean())?.slug);
    const tenant = await Tenant.findById(tenantId).lean();
    if (tenant?.status === 'active') return tenant;
    if (tenant?.status !== 'provisioning') throw fail(`"${tenant?.slug}" is ${tenant?.status ?? 'gone'}`);
    const job = await Job.findOne({ tenantId, type: 'provision' }).sort({ createdAt: -1 }).lean();
    if (job?.status === 'failed') throw fail(`Setting the shop up failed: ${job.error ?? 'unknown error'}`, { setupFailed: true });
    if (Date.now() >= until) throw fail(`"${tenant.slug}" is still being set up`, { timedOut: true });
    try {
      await sleep(pollMs, undefined, { signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw stopped(tenant.slug);
      throw err;
    }
  }
}

/*
 * Creates the demo shop and fills it. Its owner's first password is made here, in memory,
 * and never shown, kept or written anywhere but as its hash: the owner takes a new one from
 * the admin panel. Run again, it finishes a creation or a fill that stopped half way, and
 * leaves a shop already filled as it is. Returns fillDemoShop's answer with { url, created }.
 *   name: the shop's name (default DEMO_SHOP_NAME); waitMs: how long to wait for the shop to open
 */
export async function createDemoShop(ctx, { slug, name = DEMO_SHOP_NAME, seed, days, now, actor = 'system', waitMs, log = () => {}, signal } = {}) {
  const { db, config } = ctx;
  const { Tenant } = db.controlModels;
  slug = String(slug ?? '').trim().toLowerCase();
  let tenant = await Tenant.findOne({ slug }).lean();
  let created = false;
  const notDemo = () => fail(`A shop with the address "${slug}" exists and is not a demo shop: nothing was changed. To fill a shop made otherwise, use: fill --slug ${slug}`);
  if (tenant && tenant.status !== 'provisioning') {
    if (tenant.status !== 'active') throw fail(`"${slug}" is ${tenant.status}: nothing was changed`);
    if (!(await readMarker(ctx, tenant))) throw notDemo();
  } else {
    // Only a creation of this script's is finished here, never another shop being set up
    if (tenant && tenant.label !== DEMO_LABEL) throw notDemo();
    // A new shop, or one whose creation stopped half way (createTenant finishes it)
    const owner = { username: 'owner', password: generatePassword({ length: 24, username: 'owner', slug }), displayName: DEMO_OWNER_NAME };
    const made = await createTenant(
      ctx,
      { slug, shopName: name, label: DEMO_LABEL, owner, timeZone: DEMO_SETTINGS.timeZone, currency: DEMO_SETTINGS.currency, notes: 'متجر عرض للزبائن، كل بياناته وهمية (scripts/demo-shop.js)' },
      { actor },
    );
    tenant = made.tenant;
    created = true;
    // Its database is there by now: it is marked as the demo's before anything else happens
    await metaOf(ctx, tenant).updateOne({ _id: MARKER }, { $setOnInsert: { version: DEMO_VERSION, state: 'created', createdAt: new Date(), by: actor } }, { upsert: true });
  }
  const url = publicUrl(config, primaryHost(config, slug));
  if (tenant.status !== 'active') {
    log('  waiting for the shop to open (its HTTPS certificate comes from the root worker within about a minute)');
    tenant = await waitUntilActive(ctx, tenant._id, { timeoutMs: waitMs, signal });
  }
  const result = await fillDemoShop(ctx, { slug, seed, days, now, actor, log, signal });
  return { ...result, url, created };
}
