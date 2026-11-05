// A discount on a sale line (public/js/discount.js, routes/sales.js, the «الخصم» permission
// of public/js/permissions.js): money off a whole line, given by the owner or a staff account
// with `discount` (in the «مشرف» preset, not in «كاشير»), never taking the line below what
// its goods cost, a multiple of the step when the shop rounds; the line's lineTotal is after
// it, so the total, profit, change, debt and reports follow; who gave it is who sold; an
// account that does not see costs is refused without the cost or the maximum; a return gives
// back the line's share (or, on a rounded sale, the difference with the discount's share off);
// the report adds the period's discounts, and only when there were some; a sale sent again is
// answered as recorded. Expected values are worked out by hand.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fitsStep, keptAmount, maxDiscount } from '../public/js/discount.js';
import { lineAmount } from '../public/js/rounding.js';
import { PERMISSIONS, PRESETS } from '../public/js/permissions.js';
import { isSaleOf } from '../public/js/idempotency.js';
import { startTestEnv, addStaff } from './support/harness.js';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
// What an account without `reports` must never be sent (test/permissions.test.js has the list)
const COST_KEYS = ['purchasePrice', 'unitCost', 'cost', 'profit', 'returnedCost', 'capital', 'saleValue', 'netProfit'];

let env;
let shop;
let owner;
let supervisor;
let cashier;
let discounter;
let discounterAccount;
let tea;
let juice;
let rice;
let water;
let atCost;
before(async () => {
  env = await startTestEnv();
  shop = await env.createShop('discount-shop');
  owner = shop.client;
  supervisor = (await addStaff(env, shop, { username: 'supervisor', displayName: 'مشرف', permissions: [...PRESETS.supervisor.permissions] })).client;
  cashier = (await addStaff(env, shop, { username: 'cashier', displayName: 'كاشير', permissions: [...PRESETS.cashier.permissions] })).client;
  // Discounts and nothing else: no costs, no reports
  discounterAccount = await addStaff(env, shop, { username: 'discounter', displayName: 'موظف الخصم', permissions: ['discount'] });
  discounter = discounterAccount.client;
  tea = await addProduct(owner, { name: 'شاي', barcode: 'D-TEA', purchasePrice: 300, salePrice: 750 });
  juice = await addProduct(owner, { name: 'عصير', barcode: 'D-JUICE', purchasePrice: 400, salePrice: 600 });
  rice = await addProduct(owner, { name: 'رز', barcode: 'D-RICE', unit: 'kg', purchasePrice: 1000, salePrice: 1500 });
  // A box of 12 at 7,100, bought at 500 a piece (6,000 a box)
  water = await addProduct(owner, { name: 'ماء', barcode: 'D-WATER', purchasePrice: 500, salePrice: 650, hasWholesale: true, wholesaleQty: 12, wholesalePrice: 7100 });
  atCost = await addProduct(owner, { name: 'سكر بسعر الشراء', barcode: 'D-COST', purchasePrice: 900, salePrice: 900 });
});
after(async () => {
  await env?.close();
});

const call = (client, method, path, body) => client.request(method, `/api${path}`, body);
async function ok(client, method, path, body) {
  const res = await call(client, method, path, body);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${res.text}`);
  return res.data;
}
const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));
const sell = (client, items, extra = {}) => call(client, 'POST', '/sales', { items, ...extra });
const line = (product, quantity, discount, mode) => ({ productId: product._id, quantity, ...(mode ? { mode } : {}), ...(discount === undefined ? {} : { discount }) });
const returnFrom = (client, sale, items) => call(client, 'POST', `/sales/${sale._id}/returns`, items === undefined ? {} : { items });
const storedSale = (s, number) => s.db.collection('sales').findOne({ number });
const salesCount = () => shop.db.collection('sales').countDocuments();
const setStep = (roundingStep, client = owner) => ok(client, 'PUT', '/settings', { roundingStep });
async function addProduct(client, body) {
  const general = (await ok(client, 'GET', '/categories'))[0];
  return ok(client, 'POST', '/products', { category: general._id, trackStock: false, ...body });
}
function today() {
  const now = new Date();
  return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()), to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) };
}
// The keys of COST_KEYS found anywhere in a JSON answer, with where
function costsIn(value, at = '') {
  if (Array.isArray(value)) return value.flatMap((item, i) => costsIn(item, `${at}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, inner]) => [...(COST_KEYS.includes(key) ? [`${at}.${key}`] : []), ...costsIn(inner, `${at}.${key}`)]);
}

test('the rule shared by the server and the pages', () => {
  // [amount before, cost, step, the most off]
  for (const [amount, cost, step, most] of [
    [750, 300, 0, 450],
    [750, 300, 250, 250],
    [2000, 1200, 250, 750],
    [1500, 600, 0, 900],
    [499.5, 333, 0, 166.5],
    [7100, 6000, 0, 1100],
    [900, 900, 0, 0],
    [600, 700, 0, 0],
    [750, 300, 1000, 0],
  ]) assert.strictEqual(maxDiscount(amount, cost, step), most, `maxDiscount(${amount}, ${cost}, ${step})`);
  assert.ok(fitsStep(250, 250) && fitsStep(1750, 250) && fitsStep(123.45, 0) && !fitsStep(100, 250) && !fitsStep(250.5, 250));
  // Without a discount, what is left of a line is lineAmount, as returns always worked it out
  for (const [unitPrice, quantity, left, step] of [[600, 3, 2, 250], [1500, 0.4, 0.3, 250], [7100, 2, 1, 100], [1333, 0.333, 0.222, 50]]) {
    const item = { unitPrice, quantity, lineTotal: lineAmount(unitPrice, quantity, step) };
    assert.strictEqual(keptAmount(item, left, step), lineAmount(unitPrice, left, step));
    assert.strictEqual(keptAmount(item, quantity, step), item.lineTotal);
    assert.strictEqual(keptAmount(item, 0, step), 0);
  }
  // 3 x 600 at 250 is 2,000, 250 off is 1,750; 2 left: 1,200 - 166.67 = 1,033.33, so 1,250
  const discounted = { unitPrice: 600, quantity: 3, lineTotal: 1750, discount: 250 };
  assert.deepStrictEqual([3, 2, 1, 0].map((left) => keptAmount(discounted, left, 250)), [1750, 1250, 750, 0]);
  // A discount near the whole line never makes what is left negative
  assert.strictEqual(keptAmount({ unitPrice: 600, quantity: 3, lineTotal: 250, discount: 1750 }, 2, 250), 250);
  assert.strictEqual(keptAmount({ unitPrice: 600, quantity: 3, lineTotal: 0, discount: 2000 }, 2, 250), 0);
});

test('the «الخصم» permission: the owner and the «مشرف» preset give discounts, the «كاشير» preset is refused 403', async () => {
  assert.strictEqual(PERMISSIONS.discount, 'الخصم');
  assert.ok(PRESETS.supervisor.permissions.includes('discount'));
  assert.ok(!PRESETS.cashier.permissions.includes('discount'));
  assert.ok((await ok(owner, 'GET', '/auth/me')).permissions.includes('discount'), 'the owner always has it');

  for (const [client, name] of [[owner, 'owner'], [supervisor, 'مشرف'], [discounter, 'موظف الخصم']]) {
    const sale = await ok(client, 'POST', '/sales', { items: [line(tea, 1, 100)] });
    assert.deepStrictEqual(pick(sale.items[0], ['lineTotal', 'discount']), { lineTotal: 650, discount: 100 }, name);
    // Who gave it is who sold, from the session
    assert.strictEqual(sale.madeBy.name, name);
  }

  const count = await salesCount();
  const refused = await sell(cashier, [line(tea, 1, 100)]);
  assert.deepStrictEqual([refused.status, refused.data.code], [403, 'FORBIDDEN']);
  assert.match(refused.data.error, /«الخصم»/);
  assert.strictEqual(await salesCount(), count, 'nothing recorded');
  // No discount (none, 0, empty) is a plain sale, which every account makes
  for (const discount of [undefined, 0, '', null]) {
    const plain = await ok(cashier, 'POST', '/sales', { items: [line(tea, 1, discount)] });
    assert.ok(!('discount' in plain.items[0]) && plain.total === 750, String(discount));
  }

  // An account given the other five permissions before the discount existed keeps them, without it
  const older = await addStaff(env, shop, { username: 'older', permissions: ['credit', 'returns', 'products', 'purchases', 'reports'] });
  assert.deepStrictEqual((await ok(older.client, 'GET', '/auth/me')).permissions, ['credit', 'returns', 'products', 'purchases', 'reports']);
  assert.strictEqual((await sell(older.client, [line(tea, 1, 100)])).status, 403);
  // and the owner may give it: the next request has it
  await ok(owner, 'PUT', `/staff/${older.id}`, { permissions: ['credit', 'returns', 'discount', 'products', 'purchases', 'reports'] });
  assert.strictEqual((await sell(older.client, [line(tea, 1, 100)])).status, 201);
});

test('the limit: down to the line\'s cost and not a dinar more, line by line', async () => {
  // 1 x 750 costing 300: 450 off leaves the cost exactly, 451 is refused
  const exact = await ok(owner, 'POST', '/sales', { items: [line(tea, 1, 450)] });
  assert.deepStrictEqual(pick(exact, ['total', 'cost', 'profit']), { total: 300, cost: 300, profit: 0 });
  const count = await salesCount();
  const over = await sell(owner, [line(tea, 1, 451)]);
  assert.deepStrictEqual([over.status, over.data.code, over.data.error], [400, 'DISCOUNT_TOO_HIGH', 'أقصى خصم على «شاي» 450']);

  // Two lines with different costs: 2 x 750 costing 600 takes up to 900, 1 x 600 costing 400 up to 200
  const both = await ok(owner, 'POST', '/sales', { items: [line(tea, 2, 900), line(juice, 1, 200)] });
  assert.deepStrictEqual(both.items.map((i) => [i.lineTotal, i.discount]), [[600, 900], [400, 200]]);
  assert.deepStrictEqual(pick(both, ['total', 'cost', 'profit']), { total: 1000, cost: 1000, profit: 0 });
  const juiceOver = await sell(owner, [line(tea, 2, 900), line(juice, 1, 201)]);
  assert.deepStrictEqual([juiceOver.status, juiceOver.data.error], [400, 'أقصى خصم على «عصير» 200']);
  // Not moved between lines: 1,100 off in all fits the invoice's room, but not the tea's
  const moved = await sell(owner, [line(tea, 2, 1000), line(juice, 1, 100)]);
  assert.deepStrictEqual([moved.status, moved.data.error], [400, 'أقصى خصم على «شاي» 900']);
  // The same product twice in the cart is one line, with both discounts
  const merged = await ok(owner, 'POST', '/sales', { items: [line(tea, 1, 400), line(tea, 1, 500)] });
  assert.deepStrictEqual(merged.items.map((i) => pick(i, ['quantity', 'lineTotal', 'discount'])), [{ quantity: 2, lineTotal: 600, discount: 900 }]);
  // A line sold at its cost takes nothing off
  const none = await sell(owner, [line(atCost, 1, 1)]);
  assert.deepStrictEqual([none.status, none.data.code, none.data.error], [400, 'DISCOUNT_TOO_HIGH', '«سكر بسعر الشراء» لا يقبل خصمًا: مبلغه لا يزيد على رأس ماله']);

  // Not an amount above 0, to the fils
  for (const discount of [-5, 'abc', 10.555, true, {}, [100], '1e400']) {
    const res = await sell(owner, [line(tea, 1, discount)]);
    assert.deepStrictEqual([res.status, res.data.code], [400, 'DISCOUNT_INVALID'], JSON.stringify(discount));
  }
  assert.strictEqual(await salesCount(), count + 2, 'only the two sales that fit were recorded');
});

test('a weighed line and a wholesale box', async () => {
  // 0.4 kg x 1,500 = 600, costing 400: up to 200
  const weighed = await ok(owner, 'POST', '/sales', { items: [line(rice, 0.4, 200)] });
  assert.deepStrictEqual(pick(weighed, ['total', 'cost', 'profit']), { total: 400, cost: 400, profit: 0 });
  assert.deepStrictEqual((await sell(owner, [line(rice, 0.4, 200.01)])).data.error, 'أقصى خصم على «رز» 200');
  // 0.333 kg: 499.5, costing 333: up to 166.5, to the fils
  const fraction = await ok(owner, 'POST', '/sales', { items: [line(rice, 0.333, 166.5)] });
  assert.deepStrictEqual(pick(fraction.items[0], ['lineTotal', 'discount', 'unitCost']), { lineTotal: 333, discount: 166.5, unitCost: 1000 });
  // A box of 12 at 7,100 costing 6,000: up to 1,100, beside a loose piece of the same water
  const box = await ok(owner, 'POST', '/sales', { items: [line(water, 1, 1100, 'wholesale'), line(water, 1)] });
  assert.deepStrictEqual(box.items.map((i) => pick(i, ['mode', 'packSize', 'unitCost', 'lineTotal', 'discount'])), [
    { mode: 'wholesale', packSize: 12, unitCost: 6000, lineTotal: 6000, discount: 1100 },
    { mode: 'retail', packSize: 1, unitCost: 500, lineTotal: 650, discount: undefined },
  ]);
  assert.deepStrictEqual(pick(box, ['total', 'cost', 'profit']), { total: 6650, cost: 6500, profit: 150 });
  assert.strictEqual((await sell(owner, [line(water, 1, 1100.5, 'wholesale')])).data.error, 'أقصى خصم على «ماء» 1,100');
});

test('with the shop rounding to 250: multiples of it only, and the most off is a multiple too', async () => {
  await setStep(250);
  try {
    // 1 x 750 costing 300: 450 of room, so 250 at most
    const sale = await ok(owner, 'POST', '/sales', { items: [line(tea, 1, 250)] });
    assert.deepStrictEqual(pick(sale, ['total', 'cost', 'profit', 'roundingStep']), { total: 500, cost: 300, profit: 200, roundingStep: 250 });
    const over = await sell(owner, [line(tea, 1, 500)]);
    assert.deepStrictEqual([over.status, over.data.code, over.data.error], [400, 'DISCOUNT_TOO_HIGH', 'أقصى خصم على «شاي» 250']);
    const odd = await sell(owner, [line(tea, 1, 100)]);
    assert.deepStrictEqual([odd.status, odd.data.code, odd.data.error], [400, 'DISCOUNT_STEP', 'خصم «شاي» يجب أن يكون من مضاعفات 250، كما تُقرَّب أسعار المتجر']);
    // 3 x 600 is 2,000 (cost 1,200): 750 at most, the line stays a multiple
    const three = await ok(owner, 'POST', '/sales', { items: [line(juice, 3, 750)] });
    assert.deepStrictEqual(pick(three.items[0], ['lineTotal', 'discount']), { lineTotal: 1250, discount: 750 });
    assert.strictEqual((await sell(owner, [line(juice, 3, 1000)])).data.error, 'أقصى خصم على «عصير» 750');
    // A weight: 0.4 kg x 1,500 = 600, so 750 (cost 400): 250 off leaves 500
    assert.strictEqual((await ok(owner, 'POST', '/sales', { items: [line(rice, 0.4, 250)] })).total, 500);
  } finally {
    await setStep(0);
  }
});

test('the total, profit, cash change and credit debt are after the discounts; the stored lines', async () => {
  // 2 x 750 = 1,500 with 500 off, and a juice at 600: 1,600, cost 600 + 400 = 1,000
  const cash = await ok(owner, 'POST', '/sales', { items: [line(tea, 2, 500), line(juice, 1)], paid: 2000 });
  assert.deepStrictEqual(pick(cash, ['total', 'cost', 'profit', 'paid', 'change']), { total: 1600, cost: 1000, profit: 600, paid: 2000, change: 400 });
  const stored = await storedSale(shop, cash.number);
  assert.deepStrictEqual(pick(stored.items[0], ['quantity', 'unitPrice', 'unitCost', 'lineTotal', 'discount']), { quantity: 2, unitPrice: 750, unitCost: 300, lineTotal: 1000, discount: 500 });
  assert.ok(!('discount' in stored.items[1]), 'a line without a discount has none stored');
  assert.deepStrictEqual(pick(stored, ['total', 'cost', 'profit']), { total: 1600, cost: 1000, profit: 600 });
  // The exact amount paid, and less than the total after the discount refused
  assert.strictEqual((await ok(owner, 'POST', '/sales', { items: [line(tea, 2, 500)] })).paid, 1000);
  const short = await sell(owner, [line(tea, 2, 500)], { paid: 999 });
  assert.deepStrictEqual([short.status, short.data.error], [400, 'المبلغ المدفوع أقل من إجمالي الفاتورة']);

  // On credit: 1,000 after the discount, 300 paid now, 700 on the account
  const customer = await ok(owner, 'POST', '/customers', { name: 'زبون الخصم' });
  const credit = await ok(owner, 'POST', '/sales', { items: [line(tea, 2, 500)], paymentType: 'credit', customerId: customer._id, paid: 300 });
  assert.deepStrictEqual(pick(credit, ['total', 'paid', 'debt', 'customerBalance']), { total: 1000, paid: 300, debt: 700, customerBalance: 700 });
  assert.strictEqual((await ok(owner, 'GET', `/customers/${customer._id}`)).balance, 700);
  const full = await sell(owner, [line(tea, 2, 500)], { paymentType: 'credit', customerId: customer._id, paid: 1000 });
  assert.deepStrictEqual([full.status, full.data.error], [400, 'المبلغ مدفوع بالكامل، اختر الدفع نقدًا']);
});

test('an account that does not see costs is told neither the cost nor the most it may take off', async () => {
  // What its cashier reads: products without their purchase price
  assert.deepStrictEqual(costsIn(await ok(discounter, 'GET', '/products')), []);
  assert.deepStrictEqual(costsIn(await ok(discounter, 'GET', '/products/barcode/D-TEA')), []);
  const generic = 'خصم «شاي» أكبر من المسموح لهذا الصنف. قلّله أو أزله ثم أتمم البيع';
  for (const discount of [451, 600, 750]) {
    const res = await sell(discounter, [line(tea, 1, discount)]);
    assert.deepStrictEqual([res.status, res.data], [400, { error: generic, code: 'DISCOUNT_TOO_HIGH' }], String(discount));
    assert.doesNotMatch(res.data.error, /\d/, 'no number at all');
  }
  // A line at its cost: the same words, not «لا يقبل خصمًا» (which would say its price is its cost)
  assert.deepStrictEqual((await sell(discounter, [line(atCost, 1, 1)])).data, { error: 'خصم «سكر بسعر الشراء» أكبر من المسموح لهذا الصنف. قلّله أو أزله ثم أتمم البيع', code: 'DISCOUNT_TOO_HIGH' });
  // Two lines: the line over its limit is named, and nothing of the other
  assert.strictEqual((await sell(discounter, [line(juice, 1, 200), line(tea, 2, 901)])).data.error, generic);
  // The sale it makes comes back with its discount, and no cost, unit cost or profit
  const sale = await ok(discounter, 'POST', '/sales', { items: [line(tea, 1, 450), line(juice, 1, 200)] });
  assert.deepStrictEqual(sale.items.map((i) => pick(i, ['lineTotal', 'discount'])), [{ lineTotal: 300, discount: 450 }, { lineTotal: 400, discount: 200 }]);
  assert.deepStrictEqual(costsIn(sale), []);
  assert.deepStrictEqual(sale.madeBy, { user: discounterAccount.id, name: 'موظف الخصم' });
  // At a step, the step is no secret, the cost still is
  await setStep(250);
  try {
    assert.strictEqual((await sell(discounter, [line(tea, 1, 100)])).data.code, 'DISCOUNT_STEP');
    assert.deepStrictEqual((await sell(discounter, [line(tea, 1, 500)])).data, { error: generic, code: 'DISCOUNT_TOO_HIGH' });
  } finally {
    await setStep(0);
  }
});

test('returns of a discounted line: its share without rounding, the difference with the discount\'s share at a step', async () => {
  // No rounding: 3 x 750 = 2,250 with 450 off is 1,800 (cost 900): each piece back gives 600
  const plain = await ok(owner, 'POST', '/sales', { items: [line(tea, 3, 450)] });
  assert.strictEqual(plain.total, 1800);
  const p1 = await returnFrom(owner, plain, [{ line: 0, quantity: 1 }]);
  assert.deepStrictEqual([p1.status, p1.data.refunded, p1.data.sale.returnedCost], [201, 600, 300]);
  const p2 = await returnFrom(owner, plain, [{ line: 0, quantity: 2 }]);
  assert.deepStrictEqual([p2.data.refunded, p2.data.sale.returnedTotal, p2.data.sale.returnedCost, p2.data.sale.returnStatus], [1200, 1800, 900, 'full']);
  // A share that does not divide evenly, as before discounts: 3 x 600 with 100 off is 1,700;
  // 566.67, then 1,133.33 - 566.67 = 566.66, then what is left, 566.67
  const uneven = await ok(owner, 'POST', '/sales', { items: [line(juice, 3, 100)] });
  const shares = [];
  for (let i = 0; i < 3; i += 1) shares.push((await returnFrom(owner, uneven, [{ line: 0, quantity: 1 }])).data.refunded);
  assert.deepStrictEqual(shares, [566.67, 566.66, 566.67]);

  await setStep(250);
  let rounded;
  try {
    // At 250: 3 x 600 is 2,000, 250 off is 1,750 (cost 1,200)
    rounded = await ok(owner, 'POST', '/sales', { items: [line(juice, 3, 250)] });
  } finally {
    // The owner changes the rounding afterwards: the invoice keeps its own step
    await setStep(0);
  }
  assert.deepStrictEqual(pick(rounded, ['total', 'roundingStep']), { total: 1750, roundingStep: 250 });
  // One back leaves 2: 1,200 - 166.67 = 1,033.33, so 1,250: 500 back (cost 400)
  const r1 = await returnFrom(owner, rounded, [{ line: 0, quantity: 1 }]);
  assert.deepStrictEqual([r1.data.refunded, r1.data.sale.returnedTotal, r1.data.sale.returnedCost], [500, 500, 400]);
  // The other two: 1,250 (cost 800), 1,750 in all, what was paid
  const r2 = await returnFrom(owner, rounded, [{ line: 0, quantity: 2 }]);
  assert.deepStrictEqual([r2.data.refunded, r2.data.sale.returnedTotal, r2.data.sale.returnedCost, r2.data.sale.returnStatus], [1250, 1750, 1200, 'full']);

  // A whole sale cancelled gives back all that was paid: 1,000 + 600
  const whole = await ok(owner, 'POST', '/sales', { items: [line(tea, 2, 500), line(juice, 1)] });
  const all = await returnFrom(owner, whole);
  assert.deepStrictEqual([all.data.refunded, all.data.sale.returnedTotal, all.data.sale.returnedCost, all.data.sale.returnStatus], [1600, 1600, 1000, 'full']);

  // On credit, nothing paid: one of two back comes off the account, its share of 1,000
  const customer = await ok(owner, 'POST', '/customers', { name: 'زبون مرتجع الخصم' });
  const credit = await ok(owner, 'POST', '/sales', { items: [line(tea, 2, 500)], paymentType: 'credit', customerId: customer._id });
  const c1 = await returnFrom(owner, credit, [{ line: 0, quantity: 1 }]);
  assert.deepStrictEqual([c1.data.toAccount, c1.data.refunded], [500, 0]);
  assert.strictEqual((await ok(owner, 'GET', `/customers/${customer._id}`)).balance, 500);
});

test('the sales report: the totals after discounts, and the period\'s discounts only when there were some', async () => {
  // A shop of its own, so the day holds only these figures
  const other = await env.createShop('discount-report');
  const client = other.client;
  const t = await addProduct(client, { name: 'شاي', barcode: 'DR-TEA', purchasePrice: 300, salePrice: 750 });
  const j = await addProduct(client, { name: 'عصير', barcode: 'DR-JUICE', purchasePrice: 400, salePrice: 600 });
  /* S1 2 tea, 500 off: 1,000 (cost 600); S2 1 juice: 600 (cost 400); S3 1 tea, 450 off: 300
     (cost 300); then 1 tea back from S1: half of 1,000 = 500 (cost 300). Today: 3 invoices,
     3 pieces, sales 1,400, cost 1,000, profit 400, returns 500, discounts 950 (the return
     leaves them as they were). */
  const s1 = await ok(client, 'POST', '/sales', { items: [line(t, 2, 500)] });
  await ok(client, 'POST', '/sales', { items: [line(j, 1)] });
  await ok(client, 'POST', '/sales', { items: [line(t, 1, 450)] });
  assert.strictEqual((await returnFrom(client, s1, [{ line: 0, quantity: 1 }])).data.refunded, 500);

  const { from, to } = today();
  const expected = { count: 3, pieces: 3, total: 1400, cost: 1000, profit: 400, returns: 500, credit: 0, expenses: 0, collected: 0, netProfit: 400, discounts: 950 };
  const day = await ok(client, 'GET', `/sales?from=${from.toISOString()}&to=${to.toISOString()}`);
  assert.deepStrictEqual(pick(day.summary, Object.keys(expected)), expected);
  const monthFrom = new Date(from.getFullYear(), from.getMonth(), 1);
  const monthTo = new Date(from.getFullYear(), from.getMonth() + 1, 1);
  for (const groupBy of ['day', 'month']) {
    const report = await ok(client, 'GET', `/sales/report?from=${monthFrom.toISOString()}&to=${monthTo.toISOString()}&groupBy=${groupBy}&tz=${TZ}`);
    assert.deepStrictEqual(pick(report.summary, Object.keys(expected)), expected, groupBy);
    assert.strictEqual(report.periods.length, 1);
    assert.deepStrictEqual(pick(report.periods[0], Object.keys(expected)), expected, groupBy);
  }
  // Per product: tea 2 + 1 - 1 = 2 pieces, 1,000 + 300 - 500 = 800, cost 900 - 300 = 600
  const products = await ok(client, 'GET', `/sales/products?from=${from.toISOString()}&to=${to.toISOString()}`);
  assert.deepStrictEqual(products.map((p) => pick(p, ['name', 'quantity', 'total', 'cost', 'profit', 'invoices'])).sort((a, b) => a.name.localeCompare(b.name)), [
    { name: 'شاي', quantity: 2, total: 800, cost: 600, profit: 200, invoices: 2 },
    { name: 'عصير', quantity: 1, total: 600, cost: 400, profit: 200, invoices: 1 },
  ]);

  // A shop that gives no discount reads exactly the figures it always did, with no new field
  const plain = await env.createShop('discount-none');
  const pt = await addProduct(plain.client, { name: 'شاي', barcode: 'DN-TEA', purchasePrice: 300, salePrice: 750 });
  const sale = await ok(plain.client, 'POST', '/sales', { items: [line(pt, 2)] });
  assert.ok(!('discount' in sale.items[0]) && !('discount' in (await storedSale(plain, sale.number)).items[0]));
  const before = ['count', 'pieces', 'total', 'cost', 'profit', 'returns', 'credit', 'expenses', 'collected', 'netProfit'];
  const list = await ok(plain.client, 'GET', `/sales?from=${from.toISOString()}&to=${to.toISOString()}`);
  assert.deepStrictEqual(Object.keys(list.summary), before);
  const report = await ok(plain.client, 'GET', `/sales/report?from=${monthFrom.toISOString()}&to=${monthTo.toISOString()}&groupBy=day&tz=${TZ}`);
  assert.deepStrictEqual(Object.keys(report.summary), before);
  assert.deepStrictEqual(Object.keys(report.periods[0]), ['key', ...before]);
});

test('a sale sent again is answered as it was recorded, discounts and all', async () => {
  const body = { items: [line(tea, 2, 500), line(juice, 1, 100)], clientId: 'cart-discount-repeat-1' };
  const first = await call(owner, 'POST', '/sales', body);
  // Sent again with the discount changed meanwhile: the sale as recorded, and nothing new
  const changed = { ...body, items: [line(tea, 2, 900), line(juice, 1)] };
  const again = await call(owner, 'POST', '/sales', changed);
  assert.deepStrictEqual([first.status, again.status, again.data.repeated], [201, 200, true]);
  for (const key of ['number', 'total', 'cost', 'profit', 'paid', 'change', 'items']) assert.deepStrictEqual(again.data[key], first.data[key], key);
  assert.deepStrictEqual(again.data.items.map((i) => [i.lineTotal, i.discount]), [[1000, 500], [500, 100]]);
  assert.strictEqual(await shop.db.collection('sales').countDocuments({ clientId: body.clientId }), 1);
  // The cashier tells its own cart from one recorded with other discounts under the same id
  assert.ok(isSaleOf(body, again.data));
  assert.ok(!isSaleOf(changed, again.data));
  assert.ok(!isSaleOf({ items: [line(tea, 2), line(juice, 1, 100)] }, again.data), 'a discount left out is another cart');
});
