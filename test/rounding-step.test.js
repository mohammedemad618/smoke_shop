// «أصغر فئة نقدية» (roundingStep: lib/shop-settings.js, routes/settings.js, routes/sales.js,
// public/js/rounding.js): off in every shop until its owner turns it on, and off means every
// figure as before; only the owner sets it, to one of the steps; each sale line is then
// rounded up to a multiple of it (the line, not each piece, nor the invoice), for pieces,
// weights and boxes alike, with the cost as it was, so the profit takes the rounding; the
// sale keeps its step, so a partial return gives back the difference between the rounded
// amounts of what was left before and after, and changing the setting later changes nothing
// on it; the reports read the rounded totals. Expected values are worked out by hand.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { roundUpTo, lineAmount } from '../public/js/rounding.js';
import * as util from '../lib/util.js';
import { PERMISSION_KEYS } from '../public/js/permissions.js';
import { startTestEnv, addStaff } from './support/harness.js';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

let env;
let shop;
let owner;
let supervisor;
before(async () => {
  env = await startTestEnv();
  shop = await env.createShop('rounding-shop');
  owner = shop.client;
  supervisor = (await addStaff(env, shop, { username: 'supervisor', permissions: [...PERMISSION_KEYS] })).client;
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
const setStep = (roundingStep, client = owner) => ok(client, 'PUT', '/settings', { roundingStep });
const sell = (client, items, extra = {}) => call(client, 'POST', '/sales', { items, ...extra });
const returnFrom = (client, sale, items) => call(client, 'POST', `/sales/${sale._id}/returns`, items === undefined ? {} : { items });
const storedSale = (s, number) => s.db.collection('sales').findOne({ number });

// The shop's day, and a product in its first category
function today() {
  const now = new Date();
  return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()), to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) };
}
async function addProduct(client, body) {
  const general = (await ok(client, 'GET', '/categories'))[0];
  return ok(client, 'POST', '/products', { category: general._id, trackStock: false, ...body });
}

test('roundUpTo: up to a multiple of the step, a multiple stays, no step leaves the amount', () => {
  // [amount, step, expected]; strictEqual tells -0 from 0
  const cases = [
    [600, 250, 750],
    [1200, 250, 1250],
    [1800, 250, 2000],
    [750, 250, 750],
    [0, 250, 0],
    [0.4 * 1500, 250, 750], // a weight: 600
    [0.35 * 1500, 250, 750], // 525
    [3 * 0.1 * 1000, 100, 300], // 300.00000000000006 is 300, not 400
    [1.1 * 1000, 100, 1100], // 1100.0000000000002
    [7100, 250, 7250],
    [120, 50, 150],
    [2400, 1000, 3000],
    [-0.4, 250, 0], // never -0
    [600, 0, 600],
    [600, undefined, 600],
    [443.89, 0, 443.89],
  ];
  for (const [amount, step, expected] of cases) assert.strictEqual(roundUpTo(amount, step), expected, `roundUpTo(${amount}, ${step})`);
  // A line: price x quantity to the cent, then the whole line up to the step
  assert.strictEqual(lineAmount(600, 3, 250), 2000);
  assert.strictEqual(lineAmount(1500, 0.4, 250), 750);
  assert.strictEqual(lineAmount(1333, 0.333, 0), 443.89);
  assert.strictEqual(lineAmount(1333, 0.333, 50), 450);
  // The server's copy is the same function
  assert.strictEqual(util.roundUpTo, roundUpTo);
  assert.strictEqual(util.lineAmount, lineAmount);
});

test('off in a new shop: the owner reads 0, the other pages read nothing of it, and lines are as priced', async () => {
  assert.strictEqual((await ok(owner, 'GET', '/settings')).roundingStep, 0);
  for (const client of [owner, supervisor]) assert.ok(!('roundingStep' in (await ok(client, 'GET', '/shop'))), 'GET /api/shop as before');
  const tea = await addProduct(owner, { name: 'شاي بلا تقريب', barcode: 'OFF-1', purchasePrice: 400, salePrice: 600 });
  const rice = await addProduct(owner, { name: 'رز بلا تقريب', barcode: 'OFF-2', unit: 'kg', purchasePrice: 1000, salePrice: 1333 });
  // 3 x 600 = 1800; 0.333 kg x 1333 = 443.889 -> 443.89; total 2243.89, cost 1200 + 333 = 1533
  const sale = await ok(owner, 'POST', '/sales', { items: [{ productId: tea._id, quantity: 3 }, { productId: rice._id, quantity: 0.333 }], paid: 2300 });
  assert.deepStrictEqual(sale.items.map((i) => i.lineTotal), [1800, 443.89]);
  assert.deepStrictEqual(pick(sale, ['total', 'cost', 'profit', 'paid', 'change']), { total: 2243.89, cost: 1533, profit: 710.89, paid: 2300, change: 56.11 });
  assert.ok(!('roundingStep' in sale));
  assert.ok(!('roundingStep' in (await storedSale(shop, sale.number))), 'nothing new on the invoice');
  // A return is proportional as always: 1 of 3 gives back 600
  const back = await returnFrom(owner, sale, [{ line: 0, quantity: 1 }]);
  assert.deepStrictEqual([back.status, back.data.refunded], [201, 600]);
});

test('only the owner sets it, to one of the steps; anything else is refused and changes nothing', async () => {
  const forbidden = await call(supervisor, 'PUT', '/settings', { roundingStep: 250 });
  assert.deepStrictEqual([forbidden.status, forbidden.data.code], [403, 'FORBIDDEN']);
  const before = await ok(owner, 'GET', '/settings');
  for (const roundingStep of [25, 200, 2000, -250, 249.5, '250', null, true, [250], { step: 250 }]) {
    const res = await call(owner, 'PUT', '/settings', { roundingStep });
    assert.deepStrictEqual([res.status, res.data.error], [400, 'أصغر فئة نقدية غير صالحة'], JSON.stringify(roundingStep));
  }
  // One bad field refuses the whole request
  assert.strictEqual((await call(owner, 'PUT', '/settings', { autoPrint: true, roundingStep: 300 })).status, 400);
  assert.deepStrictEqual(await ok(owner, 'GET', '/settings'), before);

  for (const step of [50, 100, 250, 500, 1000]) {
    assert.strictEqual((await setStep(step)).roundingStep, step);
    // Every account's cashier reads it
    assert.strictEqual((await ok(supervisor, 'GET', '/shop')).roundingStep, step);
  }
  // The card sends its own fields: the step stays when another card saves
  await ok(owner, 'PUT', '/settings', { receiptNote: 'شكرًا' });
  assert.strictEqual((await ok(owner, 'GET', '/settings')).roundingStep, 1000);
  assert.strictEqual((await setStep(0)).roundingStep, 0);
  assert.ok(!('roundingStep' in (await ok(supervisor, 'GET', '/shop'))), 'off again: as before');
  await ok(owner, 'PUT', '/settings', { receiptNote: '' });
});

test('on at 250: each line goes up, for pieces, weights and boxes; cash change and credit debt from the rounded total', async () => {
  const tea = await addProduct(owner, { name: 'شاي', barcode: 'R-TEA', purchasePrice: 400, salePrice: 600 });
  const juice = await addProduct(owner, { name: 'عصير', barcode: 'R-JUICE', purchasePrice: 450, salePrice: 600 });
  const sugar = await addProduct(owner, { name: 'سكر', barcode: 'R-SUGAR', unit: 'kg', purchasePrice: 1000, salePrice: 1500 });
  // A box of 12 at 7,100, bought at 500 a piece (6,000 a box)
  const water = await addProduct(owner, { name: 'ماء', barcode: 'R-WATER', purchasePrice: 500, salePrice: 650, hasWholesale: true, wholesaleQty: 12, wholesalePrice: 7100 });
  await setStep(250);

  // 1, 2, 3 pieces of 600: 750, 1,250, 2,000 (not 750, 1,500, 2,250); the cost is the goods'
  for (const [quantity, total] of [[1, 750], [2, 1250], [3, 2000]]) {
    const sale = await ok(owner, 'POST', '/sales', { items: [{ productId: tea._id, quantity }] });
    const cost = 400 * quantity;
    assert.deepStrictEqual(pick(sale, ['total', 'cost', 'profit', 'paid', 'change', 'roundingStep']), { total, cost, profit: total - cost, paid: total, change: 0, roundingStep: 250 }, `${quantity} pieces`);
    assert.deepStrictEqual(pick(sale.items[0], ['unitPrice', 'quantity', 'lineTotal']), { unitPrice: 600, quantity, lineTotal: total });
    assert.strictEqual((await storedSale(shop, sale.number)).roundingStep, 250, 'the invoice keeps its step');
  }
  // A weight: 0.4 kg x 1,500 = 600 -> 750, cost 400
  const weighed = await ok(owner, 'POST', '/sales', { items: [{ productId: sugar._id, quantity: 0.4 }] });
  assert.deepStrictEqual(pick(weighed, ['total', 'cost', 'profit']), { total: 750, cost: 400, profit: 350 });
  // Boxes: 1 x 7,100 -> 7,250; 2 x 7,100 = 14,200 -> 14,250 (cost 6,000 a box)
  const boxes = await ok(owner, 'POST', '/sales', { items: [{ productId: water._id, mode: 'wholesale', quantity: 1 }, { productId: water._id, quantity: 1 }] });
  assert.deepStrictEqual(boxes.items.map((i) => [i.mode, i.lineTotal]), [['wholesale', 7250], ['retail', 750]]);
  assert.deepStrictEqual(pick(boxes, ['total', 'cost', 'profit']), { total: 8000, cost: 6500, profit: 1500 });
  const twoBoxes = await ok(owner, 'POST', '/sales', { items: [{ productId: water._id, mode: 'wholesale', quantity: 2 }] });
  assert.strictEqual(twoBoxes.total, 14250);
  // Two products of 600, one each: each line goes up, 750 + 750 = 1,500 (not 1,200 -> 1,250)
  const two = await ok(owner, 'POST', '/sales', { items: [{ productId: tea._id, quantity: 1 }, { productId: juice._id, quantity: 1 }] });
  assert.deepStrictEqual([two.items.map((i) => i.lineTotal), two.total, two.cost, two.profit], [[750, 750], 1500, 850, 650]);
  // The same product twice in the cart is one line: 1 + 2 = 3 pieces, 2,000
  assert.strictEqual((await ok(owner, 'POST', '/sales', { items: [{ productId: tea._id, quantity: 1 }, { productId: tea._id, quantity: 2 }] })).total, 2000);

  // Cash: 2 pieces are 1,250; 2,000 paid gives 750 back, and the 1,200 shown before rounding is short
  const cash = await ok(owner, 'POST', '/sales', { items: [{ productId: tea._id, quantity: 2 }], paid: 2000 });
  assert.deepStrictEqual(pick(cash, ['total', 'paid', 'change']), { total: 1250, paid: 2000, change: 750 });
  const short = await sell(owner, [{ productId: tea._id, quantity: 2 }], { paid: 1200 });
  assert.deepStrictEqual([short.status, short.data.error], [400, 'المبلغ المدفوع أقل من إجمالي الفاتورة']);

  // Credit: 3 pieces are 2,000; 500 paid now puts 1,500 on the account, and 2,000 is paying in full
  const customer = await ok(owner, 'POST', '/customers', { name: 'زبون التقريب' });
  const credit = await ok(owner, 'POST', '/sales', { items: [{ productId: tea._id, quantity: 3 }], paymentType: 'credit', customerId: customer._id, paid: 500 });
  assert.deepStrictEqual(pick(credit, ['total', 'paid', 'debt', 'customerBalance', 'roundingStep']), { total: 2000, paid: 500, debt: 1500, customerBalance: 1500, roundingStep: 250 });
  assert.strictEqual((await ok(owner, 'GET', `/customers/${customer._id}`)).balance, 1500);
  const full = await sell(owner, [{ productId: tea._id, quantity: 3 }], { paymentType: 'credit', customerId: customer._id, paid: 2000 });
  assert.deepStrictEqual([full.status, full.data.error], [400, 'المبلغ مدفوع بالكامل، اختر الدفع نقدًا']);
  await setStep(0);
});

test('a sale sent again is answered as it was recorded, whatever the step now', async () => {
  const tea = await ok(owner, 'GET', '/products/barcode/R-TEA');
  await setStep(250);
  const body = { items: [{ productId: tea._id, quantity: 3 }], clientId: 'cart-rounding-repeat-1' };
  const first = await call(owner, 'POST', '/sales', body);
  await setStep(1000);
  const again = await call(owner, 'POST', '/sales', body);
  assert.deepStrictEqual([first.status, again.status, again.data.repeated], [201, 200, true]);
  for (const key of ['number', 'total', 'cost', 'profit', 'paid', 'change', 'roundingStep']) assert.deepStrictEqual(again.data[key], first.data[key], key);
  assert.deepStrictEqual([again.data.total, again.data.roundingStep, again.data.items.map((i) => i.lineTotal)], [2000, 250, [2000]]);
  // and recorded once
  assert.strictEqual(await shop.db.collection('sales').countDocuments({ clientId: body.clientId }), 1);
  await setStep(0);
});

test('returns give back the difference between the rounded amounts, at the step of the sale', async () => {
  const tea = await ok(owner, 'GET', '/products/barcode/R-TEA');
  const juice = await ok(owner, 'GET', '/products/barcode/R-JUICE');
  const sugar = await ok(owner, 'GET', '/products/barcode/R-SUGAR');
  await setStep(250);
  const three = await ok(owner, 'POST', '/sales', { items: [{ productId: tea._id, quantity: 3 }] });
  const weighed = await ok(owner, 'POST', '/sales', { items: [{ productId: sugar._id, quantity: 0.4 }] });
  const two = await ok(owner, 'POST', '/sales', { items: [{ productId: tea._id, quantity: 1 }, { productId: juice._id, quantity: 1 }] });
  const customer = await ok(owner, 'POST', '/customers', { name: 'زبون مرتجع التقريب' });
  const credit = await ok(owner, 'POST', '/sales', { items: [{ productId: tea._id, quantity: 3 }], paymentType: 'credit', customerId: customer._id });
  // The owner changes the rounding afterwards: the invoices made at 250 stay at 250
  await setStep(1000);

  // 3 x 600 sold for 2,000. One back leaves 2 = 1,250: 750 back (cost 400); the other two: 1,250 (cost 800)
  const r1 = await returnFrom(owner, three, [{ line: 0, quantity: 1 }]);
  assert.deepStrictEqual([r1.status, r1.data.refunded, r1.data.toAccount], [201, 750, 0]);
  assert.deepStrictEqual(pick(r1.data.sale, ['returnedTotal', 'returnedCost', 'returnStatus', 'total', 'roundingStep']), { returnedTotal: 750, returnedCost: 400, returnStatus: 'partial', total: 2000, roundingStep: 250 });
  assert.deepStrictEqual(r1.data.sale.returns[0].items.map((i) => i.amount), [750]);
  const r2 = await returnFrom(owner, three, [{ line: 0, quantity: 2 }]);
  assert.deepStrictEqual([r2.data.refunded, r2.data.sale.returnedTotal, r2.data.sale.returnedCost, r2.data.sale.returnStatus], [1250, 2000, 1200, 'full']);

  // A weight: 0.4 kg sold for 750. 100 g back leaves 0.3 kg = 450 -> 500: 250 back; the rest: 500
  const w1 = await returnFrom(owner, weighed, [{ line: 0, quantity: 0.1 }]);
  assert.strictEqual(w1.data.refunded, 250);
  const w2 = await returnFrom(owner, weighed);
  assert.deepStrictEqual([w2.data.refunded, w2.data.sale.returnedTotal, w2.data.sale.returnedCost], [500, 750, 400]);

  // A full return gives back all that was paid: 1,500 for two lines of 750
  const all = await returnFrom(owner, two);
  assert.deepStrictEqual([all.data.refunded, all.data.sale.returnedTotal, all.data.sale.returnStatus], [1500, 1500, 'full']);

  // On credit, nothing paid: one back comes off the account, 750, leaving 1,250 owed
  const c1 = await returnFrom(owner, credit, [{ line: 0, quantity: 1 }]);
  assert.deepStrictEqual([c1.data.toAccount, c1.data.refunded], [750, 0]);
  assert.strictEqual((await ok(owner, 'GET', `/customers/${customer._id}`)).balance, 1250);

  // And a sale made with no rounding stays proportional once the shop rounds: 1 of 3 x 600 = 600
  await setStep(0);
  const plain = await ok(owner, 'POST', '/sales', { items: [{ productId: tea._id, quantity: 3 }] });
  await setStep(250);
  const p1 = await returnFrom(owner, plain, [{ line: 0, quantity: 1 }]);
  assert.deepStrictEqual([plain.total, p1.data.refunded], [1800, 600]);
  await setStep(0);
});

test('the reports read the rounded totals, and the profit takes the rounding', async () => {
  // A shop of its own, so the day holds only these figures
  const other = await env.createShop('rounding-report');
  const client = other.client;
  const tea = await addProduct(client, { name: 'شاي', barcode: 'REP-TEA', purchasePrice: 400, salePrice: 600 });
  const sugar = await addProduct(client, { name: 'سكر', barcode: 'REP-SUGAR', unit: 'kg', purchasePrice: 1000, salePrice: 1500 });
  await setStep(250, client);
  /* S1 3 tea 2,000 (cost 1,200); S2 0.4 kg sugar 750 (cost 400); S3 1 tea 750 (cost 400);
     then 1 tea back from S1: 750 (cost 400). Today: 3 invoices, 3 pieces, sales 2,750, cost
     1,600, profit 1,150 (as priced it would have been 2,400 - 1,600 = 800), returns 750. */
  const s1 = await ok(client, 'POST', '/sales', { items: [{ productId: tea._id, quantity: 3 }] });
  await ok(client, 'POST', '/sales', { items: [{ productId: sugar._id, quantity: 0.4 }] });
  await ok(client, 'POST', '/sales', { items: [{ productId: tea._id, quantity: 1 }] });
  assert.strictEqual((await returnFrom(client, s1, [{ line: 0, quantity: 1 }])).data.refunded, 750);
  // Changing the rounding now changes none of it
  await setStep(1000, client);

  const { from, to } = today();
  const expected = { count: 3, pieces: 3, total: 2750, cost: 1600, profit: 1150, returns: 750, credit: 0, expenses: 0, collected: 0, netProfit: 1150 };
  const day = await ok(client, 'GET', `/sales?from=${from.toISOString()}&to=${to.toISOString()}`);
  assert.deepStrictEqual(pick(day.summary, Object.keys(expected)), expected);
  const monthFrom = new Date(from.getFullYear(), from.getMonth(), 1);
  const monthTo = new Date(from.getFullYear(), from.getMonth() + 1, 1);
  const report = await ok(client, 'GET', `/sales/report?from=${monthFrom.toISOString()}&to=${monthTo.toISOString()}&groupBy=day&tz=${TZ}`);
  assert.deepStrictEqual(pick(report.summary, Object.keys(expected)), expected);
  assert.strictEqual(report.periods.length, 1);
  assert.deepStrictEqual(pick(report.periods[0], Object.keys(expected)), expected);
  const byMonth = await ok(client, 'GET', `/sales/report?from=${monthFrom.toISOString()}&to=${monthTo.toISOString()}&groupBy=month&tz=${TZ}`);
  assert.deepStrictEqual(pick(byMonth.summary, Object.keys(expected)), expected);

  /* Per product: tea 3 + 1 - 1 = 3 pieces, 2,000 + 750 - 750 = 2,000, cost 1,200, in 2
     invoices; sugar 0.4 kg, 750, cost 400 */
  const products = await ok(client, 'GET', `/sales/products?from=${from.toISOString()}&to=${to.toISOString()}`);
  assert.deepStrictEqual(products.map((p) => pick(p, ['name', 'quantity', 'total', 'cost', 'profit', 'invoices'])).sort((a, b) => a.name.localeCompare(b.name)), [
    { name: 'سكر', quantity: 0.4, total: 750, cost: 400, profit: 350, invoices: 1 },
    { name: 'شاي', quantity: 3, total: 2000, cost: 1200, profit: 800, invoices: 2 },
  ]);
});
