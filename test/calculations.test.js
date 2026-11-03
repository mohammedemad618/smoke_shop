// Characterization test of every calculation, ported from the hand-worked end-to-end check
// of the audit (commit bbff4c2). Expected values are worked out by hand in the comments, not
// taken from the code under test: when this fails, fix the code, never these numbers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startTestEnv } from './support/harness.js';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
// The same checks run in two shops at once, each through its own address: every figure must
// come out as worked by hand in both, so neither shop sees the other's sales or stock
const SHOPS = ['shop-a', 'shop-b'];

let env;
const shops = {};
before(async () => {
  // Databases of their own (each shop's empty but for its settings and «عام»), the app on a free port
  env = await startTestEnv();
  for (const slug of SHOPS) shops[slug] = await env.createShop(slug);
});
after(async () => {
  await env?.close();
});

test('every calculation, worked by hand, in two shops at once', { concurrency: true }, async (t) => {
  await Promise.all(SHOPS.map((slug) => t.test(slug, (shop) => everyCalculation(shop, shops[slug].client, shops[slug].db))));
});

// `app` sends requests to one shop's address and `db` is that shop's database
async function everyCalculation(t, app, db) {
  // Each check is a subtest, so a wrong figure is reported and the next checks still run
  const check = (label, actual, expected) => t.test(label, () => assert.deepStrictEqual(actual, expected));
  async function call(method, path, body) {
    const res = await app.request(method, `/api${path}`, body);
    return { status: res.status, data: res.data };
  }
  const ok = async (method, path, body) => {
    const r = await call(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));
  const products = async () => new Map((await ok('GET', '/products')).map((p) => [p.barcode, p]));
  const stockOf = async (barcode) => (await products()).get(barcode).stock;

  /* Setup */
  const cat = await ok('POST', '/categories', { name: 'اختبار' });
  const base = { category: cat._id, trackStock: true, lowStockAlert: 5 };
  const P1 = await ok('POST', '/products', { ...base, name: 'P1', barcode: 'A1', purchasePrice: 700, salePrice: 1000, unit: 'piece', hasWholesale: true, wholesaleQty: 10, wholesalePrice: 9000, stock: 100 });
  const P2 = await ok('POST', '/products', { ...base, name: 'P2', barcode: 'A2', purchasePrice: 4000, salePrice: 5000, unit: 'kg', hasWholesale: true, wholesaleQty: 5, wholesalePrice: 23000, stock: 20 });
  const P3 = await ok('POST', '/products', { category: cat._id, name: 'P3', barcode: 'A3', purchasePrice: 333.33, salePrice: 500, unit: 'piece', trackStock: false });
  const P4 = await ok('POST', '/products', { ...base, name: 'P4', barcode: 'A4', purchasePrice: 100, salePrice: 150, stock: 2, blockWhenOut: true });
  const P5 = await ok('POST', '/products', { ...base, name: 'P5', barcode: 'A5', purchasePrice: 1000, salePrice: 1333, unit: 'kg', stock: 10 });

  /* Sale validation: nothing invalid may be saved or move stock */
  const sell = (items, extra = {}) => call('POST', '/sales', { items, ...extra });
  await check('empty invoice refused', (await sell([])).status, 400);
  await check('quantity 0 refused', (await sell([{ productId: P1._id, quantity: 0 }])).status, 400);
  await check('negative quantity refused', (await sell([{ productId: P1._id, quantity: -1 }])).status, 400);
  await check('half a piece refused', (await sell([{ productId: P1._id, quantity: 1.5 }])).status, 400);
  await check('half a box refused', (await sell([{ productId: P1._id, mode: 'wholesale', quantity: 1.5 }])).status, 400);
  await check('wholesale without a box refused', (await sell([{ productId: P3._id, mode: 'wholesale', quantity: 1 }])).status, 400);
  await check('cash paid short refused', (await sell([{ productId: P1._id, quantity: 1 }], { paid: 100 })).status, 400);
  await check('credit without customer refused', (await sell([{ productId: P1._id, quantity: 1 }], { paymentType: 'credit' })).status, 400);
  await check('blocked oversell refused', (await sell([{ productId: P4._id, quantity: 3 }])).status, 409);
  const tiny = await sell([{ productId: P2._id, quantity: 0.0004 }]);
  await check('weight below one gram refused', tiny.status, 400);
  await check('stock untouched by refused sales', [await stockOf('A1'), await stockOf('A2'), await stockOf('A4')], [100, 20, 2]);

  /* S1: mixed cash sale
     P1 3 pieces       3 x 1000 = 3000     cost 3 x 700        = 2100
     P1 2 boxes        2 x 9000 = 18000    cost 2 x (700x10)   = 14000
     P2 0.75 kg        0.75 x 5000 = 3750  cost 0.75 x 4000    = 3000
     P2 1 sack         1 x 23000 = 23000   cost 1 x (4000x5)   = 20000
     P3 1 piece        500                 cost 333.33
     total 48250, cost 39433.33, profit 8816.67, paid 100000, change 51750
     stock: P1 100-3-20 = 77, P2 20-0.75-5 = 14.25 */
  const S1 = await ok('POST', '/sales', {
    paid: 100000,
    items: [
      { productId: P1._id, quantity: 3 },
      { productId: P1._id, mode: 'wholesale', quantity: 2 },
      { productId: P2._id, quantity: 0.75 },
      { productId: P2._id, mode: 'wholesale', quantity: 1 },
      { productId: P3._id, quantity: 1 },
    ],
  });
  await check('S1 totals', pick(S1, ['total', 'cost', 'profit', 'paid', 'change']), { total: 48250, cost: 39433.33, profit: 8816.67, paid: 100000, change: 51750 });
  await check('S1 line totals', S1.items.map((i) => i.lineTotal), [3000, 18000, 3750, 23000, 500]);
  await check('S1 stock', [await stockOf('A1'), await stockOf('A2')], [77, 14.25]);

  /* S_m: two lines of the same weighed product merge: 0.2 + 0.133 = 0.333 kg
     0.333 x 1333 = 443.889 -> 443.89 ; cost 0.333 x 1000 = 333 ; P5 10 - 0.333 = 9.667 */
  const SM = await ok('POST', '/sales', { items: [{ productId: P5._id, quantity: 0.2 }, { productId: P5._id, quantity: 0.133 }] });
  await check('merged weight line', pick(SM, ['total', 'cost', 'profit']), { total: 443.89, cost: 333, profit: 110.89 });
  await check('merged weight stock', await stockOf('A5'), 9.667);

  /* P4 2 pieces: 300, cost 200; blocked product now at 0 refuses one more */
  const S4p = await ok('POST', '/sales', { items: [{ productId: P4._id, quantity: 2 }] });
  await check('P4 sale', pick(S4p, ['total', 'cost', 'profit']), { total: 300, cost: 200, profit: 100 });
  await check('blocked at zero', (await sell([{ productId: P4._id, quantity: 1 }])).status, 409);

  /* Returns on S1
     r1: 1 box of P1 (9000, cost 7000) + 0.25 kg of P2 (1250, cost 1000) = 10250, cost 8000
         stock P1 77 + 10 = 87, P2 14.25 + 0.25 = 14.5 */
  const ret = (sale, items) => call('POST', `/sales/${sale._id}/returns`, items === undefined ? {} : { items });
  const r1 = await ret(S1, [{ line: 1, quantity: 1 }, { line: 2, quantity: 0.25 }]);
  await check('r1 refund', [r1.status, r1.data.refunded, r1.data.toAccount], [201, 10250, 0]);
  await check('r1 sale totals', pick(r1.data.sale, ['returnedTotal', 'returnedCost', 'returnStatus']), { returnedTotal: 10250, returnedCost: 8000, returnStatus: 'partial' });
  await check('r1 stock', [await stockOf('A1'), await stockOf('A2')], [87, 14.5]);
  await check('returning more than left refused', (await ret(S1, [{ line: 2, quantity: 0.6 }])).status, 400);
  await check('returning half a piece refused', (await ret(S1, [{ line: 0, quantity: 1.5 }])).status, 400);
  await check('returning a negative quantity refused', (await ret(S1, [{ line: 0, quantity: -1 }])).status, 400);
  // r2: the rest of P2 by weight, 0.5 kg = 2500, cost 2000
  const r2 = await ret(S1, [{ line: 2, quantity: 0.5 }]);
  await check('r2 refund', r2.data.refunded, 2500);
  // r3: everything left: 3 P1 (3000/2100) + 1 box (9000/7000) + 1 sack (23000/20000) + P3 (500/333.33)
  const r3 = await ret(S1);
  await check('r3 cancels the rest', [r3.data.refunded, r3.data.sale.returnStatus], [35500, 'full']);
  await check('S1 fully returned adds up', pick(r3.data.sale, ['returnedTotal', 'returnedCost']), { returnedTotal: 48250, returnedCost: 39433.33 });
  await check('S1 stock back', [await stockOf('A1'), await stockOf('A2')], [100, 20]);
  await check('nothing left to return', (await ret(S1)).status, 400);

  /* Returning a weighed line in three parts must give back exactly what was paid:
     443.89 in total, not 3 x money(0.111 x 1333) = 3 x 147.96 = 443.88 */
  for (let i = 0; i < 3; i++) await ret(SM, [{ line: 0, quantity: 0.111 }]);
  const smAfter = (await ok('GET', `/sales?from=${new Date(Date.now() - 864e5).toISOString()}&to=${new Date(Date.now() + 864e5).toISOString()}`)).sales.find((s) => s._id === SM._id);
  await check('weight returned in parts adds up to the sale', pick(smAfter, ['returnedTotal', 'returnedCost', 'returnStatus']), { returnedTotal: 443.89, returnedCost: 333, returnStatus: 'full' });
  await check('weight stock back', await stockOf('A5'), 10);

  /* Credit */
  const C1 = await ok('POST', '/customers', { name: 'زبون اختبار' });
  const balance = async (c) => (await ok('GET', `/customers/${c._id}`)).balance;
  await check('credit paid in full refused', (await sell([{ productId: P1._id, quantity: 1 }], { paymentType: 'credit', customerId: C1._id, paid: 1000 })).status, 400);
  // S2: 5 x P1 = 5000 (cost 3500), paid 1000 now -> debt 4000
  const S2 = await ok('POST', '/sales', { paymentType: 'credit', customerId: C1._id, paid: 1000, items: [{ productId: P1._id, quantity: 5 }] });
  await check('S2 debt', [S2.debt, S2.customerBalance], [4000, 4000]);
  await ok('POST', `/customers/${C1._id}/entries`, { kind: 'payment', amount: 1500 });
  await check('balance after payment', await balance(C1), 2500);
  /* Return 3 of S2 (3000, cost 2100) after the customer paid 1500 of the 4000:
     they owe 2500, so 2500 comes off the debt and 500 is paid back in cash; owing 0 after.
     (Putting all 3000 on the account would leave the shop owing them 500.) */
  const r4 = await ret(S2, [{ line: 0, quantity: 3 }]);
  await check('return after a payment: account then cash', [r4.data.toAccount, r4.data.refunded], [2500, 500]);
  await check('balance after that return', await balance(C1), 0);
  // S3: 2 x P1 = 2000 (cost 1400), nothing paid -> debt 2000; return 1 (1000/700) -> all off the debt
  const S3 = await ok('POST', '/sales', { paymentType: 'credit', customerId: C1._id, items: [{ productId: P1._id, quantity: 2 }] });
  const r5 = await ret(S3, [{ line: 0, quantity: 1 }]);
  await check('credit return within the debt', [r5.data.toAccount, r5.data.refunded], [1000, 0]);
  await check('balance 1000', await balance(C1), 1000);
  await ok('POST', `/customers/${C1._id}/entries`, { kind: 'payment', amount: 1000 });
  // S4: 4 x P1 = 4000 (cost 2800), paid 1000 -> debt 3000; full return: 3000 off the debt, 1000 cash back
  const S4 = await ok('POST', '/sales', { paymentType: 'credit', customerId: C1._id, paid: 1000, items: [{ productId: P1._id, quantity: 4 }] });
  const r6 = await ret(S4);
  await check('full return of a part-paid credit sale', [r6.data.toAccount, r6.data.refunded], [3000, 1000]);
  await check('customer owes nothing at the end', await balance(C1), 0);
  await check('P1 stock after credit sales', await stockOf('A1'), 100 - 5 + 3 - 2 + 1 - 4 + 4);

  /* Expenses: 700 today */
  await ok('POST', '/expenses', { date: new Date().toISOString(), category: 'طعام', amount: 700 });

  /* Today's figures, by hand:
     kept sales: P4 sale 300/200, S2 2000/1400 (credit left 4000-2500 = 1500), S3 1000/700 (credit left 2000-1000 = 1000)
     S1, S_m, S4 fully returned
     count 3, total 3300, cost 2300, profit 1000
     returns 48250 + 443.89 + 3000 + 1000 + 4000 = 56693.89
     credit 1500 + 1000 + 0 = 2500, expenses 700, collected 1500 + 1000 = 2500
     net = 1000 - 700 - 2500 + 2500 = 300
     Cash check: in 300 + (1000 - 500) + 0 + (1000 - 1000) + 2500 payments - 700 = 2600; cost of goods kept 2300;
     2600 - 2300 = 300, and nobody owes anything: net profit 300 is right. */
  const now = new Date();
  const dayFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayTo = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const expectedDay = { count: 3, total: 3300, cost: 2300, profit: 1000, returns: 56693.89, credit: 2500, expenses: 700, collected: 2500, netProfit: 300 };
  const day = await ok('GET', `/sales?from=${dayFrom.toISOString()}&to=${dayTo.toISOString()}`);
  await check("today's list summary", pick(day.summary, Object.keys(expectedDay)), expectedDay);
  const monthFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthTo = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const report = await ok('GET', `/sales/report?from=${monthFrom.toISOString()}&to=${monthTo.toISOString()}&groupBy=day&tz=${TZ}`);
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const row = report.periods.find((p) => p.key === todayKey);
  await check("today's report row = list", pick(row, Object.keys(expectedDay)), expectedDay);
  await check('month summary = today (only day with data)', pick(report.summary, Object.keys(expectedDay)), expectedDay);
  await check('pieces sold today (P4 2 + S2 2 + S3 1)', row.pieces, 5);
  /* Products report: P1 kept 2 (S2) + 1 (S3) = 3 pieces, 3000/2100 in 2 invoices; P4 2 pieces 300/200 */
  const byProduct = await ok('GET', `/sales/products?from=${dayFrom.toISOString()}&to=${dayTo.toISOString()}`);
  await check('products report', byProduct.map((p) => pick(p, ['name', 'quantity', 'total', 'cost', 'profit', 'invoices'])).sort((a, b) => a.name.localeCompare(b.name)), [
    { name: 'P1', quantity: 3, total: 3000, cost: 2100, profit: 900, invoices: 2 },
    { name: 'P4', quantity: 2, total: 300, cost: 200, profit: 100, invoices: 1 },
  ]);

  /* Time-zone boundaries, written straight to the database in March 2025 (Asia/Baghdad, UTC+3):
     20:59Z = 23:59 on 31 March, 21:01Z = 00:01 on 1 April */
  const Sale = db.collection('sales');
  const one = (number, createdAt) => ({
    number, createdAt, updatedAt: createdAt, paymentType: 'cash', debt: 0, returns: [], returnedTotal: 0, returnedCost: 0,
    total: 100, cost: 60, profit: 40, paid: 100, change: 0,
    items: [{ product: P1._id ? new mongoose.Types.ObjectId(P1._id) : null, name: 'P1', barcode: 'A1', unit: 'piece', mode: 'retail', packSize: 1, quantity: 1, unitPrice: 100, unitCost: 60, lineTotal: 100, returnedQuantity: 0 }],
  });
  await Sale.insertMany([one(900001, new Date('2025-03-31T20:59:00Z')), one(900002, new Date('2025-03-31T21:01:00Z'))]);
  await db.collection('expenses').insertOne({ date: new Date('2025-03-31T20:30:00Z'), amount: 10, category: 'x', note: '', createdAt: new Date(), updatedAt: new Date() });
  const tzDays = await ok('GET', `/sales/report?from=2025-03-30T21:00:00Z&to=2025-04-01T21:00:00Z&groupBy=day&tz=Asia/Baghdad`);
  await check('day boundary in the shop time zone', tzDays.periods.map((p) => [p.key, p.total, p.expenses]), [['2025-03-31', 100, 10], ['2025-04-01', 100, 0]]);
  const tzMonths = await ok('GET', `/sales/report?from=2025-02-28T21:00:00Z&to=2025-04-30T21:00:00Z&groupBy=month&tz=Asia/Baghdad`);
  await check('month boundary in the shop time zone', tzMonths.periods.map((p) => [p.key, p.total]), [['2025-03', 100], ['2025-04', 100]]);
  const tzList = await ok('GET', `/sales?from=2025-03-31T21:00:00Z&to=2025-04-01T21:00:00Z`);
  await check('1 April list has only the 00:01 sale', [tzList.summary.count, tzList.summary.total, tzList.summary.expenses], [1, 100, 0]);
  await Sale.deleteMany({ number: { $gte: 900001 } });
  await db.collection('expenses').deleteMany({ category: 'x' });

  /* Purchases
     I1: P1 3 boxes x 6500 = 19500 -> +30 pieces, cost per piece 650 (was 700)
         P2 2 sacks x 21000 = 42000 -> +10 kg, cost per kg 4200 (was 4000), new sale price 5200
         P3 4 pieces x 0 (free) -> starts tracking at 4, purchase price stays 333.33
         total 61500, paid 20000 -> owed 41500 */
  const p1Before = await stockOf('A1');
  const p2Before = await stockOf('A2');
  const I1 = await ok('POST', '/purchases', {
    supplier: 'مورد', paid: 20000,
    items: [
      { product: P1._id, mode: 'pack', quantity: 3, price: 6500 },
      { product: P2._id, mode: 'pack', quantity: 2, price: 21000, salePrice: 5200 },
      { product: P3._id, quantity: 4, price: 0 },
    ],
  });
  await check('I1 totals', [I1.total, I1.paid, I1.remaining], [61500, 20000, 41500]);
  let ps = await products();
  await check('I1 stock', [ps.get('A1').stock, ps.get('A2').stock, ps.get('A3').stock, ps.get('A3').trackStock], [p1Before + 30, p2Before + 10, 4, true]);
  await check('I1 prices', [ps.get('A1').purchasePrice, ps.get('A2').purchasePrice, ps.get('A2').salePrice, ps.get('A3').purchasePrice], [650, 4200, 5200, 333.33]);
  await check('pay more than owed refused', (await call('POST', `/purchases/${I1._id}/payments`, { amount: 41500.01 })).status, 400);
  const pay1 = await ok('POST', `/purchases/${I1._id}/payments`, { amount: 41500 });
  await check('paid off', [pay1.paid, pay1.remaining], [61500, 0]);
  /* A price typed with more than two decimals is kept to the cent: 333.33 x 3 = 999.99 */
  const odd = await ok('POST', '/purchases', { items: [{ product: P1._id, quantity: 3, price: 1000 / 3 }] });
  await check('odd price line total', [odd.items[0].price, odd.total], [333.33, 999.99]);
  await ok('POST', `/purchases/${odd._id}/cancel`);
  ps = await products();
  await check('cancel restores stock and price', [ps.get('A1').stock, ps.get('A1').purchasePrice], [p1Before + 30, 650]);

  /* Stocktake: count P1 2 short and P4 1 over; a sale of P1 between counting and applying stays */
  const sc = await ok('POST', '/stockcounts');
  const p1Now = await stockOf('A1');
  const p1pp = (await products()).get('A1').purchasePrice; // 650
  await ok('PUT', `/stockcounts/${sc._id}/lines/${P1._id}`, { counted: p1Now - 2 });
  await ok('PUT', `/stockcounts/${sc._id}/lines/${P4._id}`, { counted: 1 }); // P4 was 0
  await ok('POST', '/sales', { items: [{ productId: P1._id, quantity: 1 }] });
  const applied = await ok('POST', `/stockcounts/${sc._id}/apply`);
  await check('stocktake summary', pick(applied.summary, ['shortItems', 'shortValue', 'overItems', 'overValue']), { shortItems: 1, shortValue: 2 * p1pp, overItems: 1, overValue: 100 });
  await check('stocktake keeps the sale made meanwhile', [await stockOf('A1'), await stockOf('A4')], [p1Now - 2 - 1, 1]);

  /* ---------- Second round: the cases found by the review ---------- */
  const todaySummary = async () => (await ok('GET', `/sales?from=${dayFrom.toISOString()}&to=${dayTo.toISOString()}`)).summary;

  /* Returns are booked on the day of the refund. A sale made on 10 May 2025 (2 x P1 = 2000,
     cost 1400) and returned today: May 2025 still shows 2000; today shows the return. */
  const before = await todaySummary();
  await Sale.insertOne({
    ...one(910001, new Date('2025-05-10T09:00:00Z')),
    total: 2000, cost: 1400, profit: 600, paid: 2000,
    items: [{ product: new mongoose.Types.ObjectId(P1._id), name: 'P1', barcode: 'A1', unit: 'piece', mode: 'retail', packSize: 1, quantity: 2, unitPrice: 1000, unitCost: 700, lineTotal: 2000, returnedQuantity: 0 }],
  });
  const oldSale = await Sale.findOne({ number: 910001 });
  const oldReturn = await ret(oldSale, [{ line: 0, quantity: 2 }]);
  await check('old sale refunded in full', [oldReturn.status, oldReturn.data.refunded], [201, 2000]);
  const after = await todaySummary();
  await check("today's figures take the refund", [after.total - before.total, after.cost - before.cost, after.profit - before.profit, after.returns - before.returns, after.pieces - before.pieces, after.count - before.count], [-2000, -1400, -600, 2000, -2, 0]);
  const may = await ok('GET', `/sales/report?from=2025-04-30T21:00:00Z&to=2025-05-31T21:00:00Z&groupBy=month&tz=Asia/Baghdad`);
  await check('May 2025 stays as it closed', may.periods.map((p) => [p.key, p.total, p.profit, p.returns, p.count]), [['2025-05', 2000, 600, 0, 1]]);
  const todayProducts = await ok('GET', `/sales/products?from=${dayFrom.toISOString()}&to=${dayTo.toISOString()}`);
  // P1 today before the refund: S2 kept 2 (2000/1400), S3 kept 1 (1000/700), the stocktake sale 1 (1000/650)
  // = 4 pieces, 4000, 2750; less the refund of 2 (2000/1400) = 2 pieces, 2000, 1350
  await check('products report takes the refund too', pick(todayProducts.find((p) => p.name === 'P1'), ['quantity', 'total', 'cost']), { quantity: 2, total: 2000, cost: 1350 });
  await Sale.deleteOne({ number: 910001 });

  /* Only payments towards credit sales count as collected.
     C2: a debt added by hand (1000, money lent) and paid back: collected unchanged.
     C3: pays 500 in advance, then buys 1 x P1 on credit (1000, cost 700): the 500 settles the
         sale the day it is made, so collected +500 and credit +1000 today, net -200
         (cash 500 in, goods costing 700 out). */
  const s0 = await todaySummary();
  const C2 = await ok('POST', '/customers', { name: 'زبون سلفة' });
  await ok('POST', `/customers/${C2._id}/entries`, { kind: 'manual', amount: 1000 });
  await ok('POST', `/customers/${C2._id}/entries`, { kind: 'payment', amount: 1000 });
  const s1 = await todaySummary();
  await check('repaying money lent is not profit', [s1.collected - s0.collected, s1.netProfit - s0.netProfit], [0, 0]);
  const C3 = await ok('POST', '/customers', { name: 'زبون دفع مقدمًا' });
  await ok('POST', `/customers/${C3._id}/entries`, { kind: 'payment', amount: 500 });
  const s2 = await todaySummary();
  await check('money paid ahead is not profit yet', [s2.collected - s1.collected, s2.netProfit - s1.netProfit], [0, 0]);
  await ok('POST', '/sales', { paymentType: 'credit', customerId: C3._id, items: [{ productId: P1._id, quantity: 1 }] });
  const s3 = await todaySummary();
  // P1 now costs 650: profit 350, net 350 - 1000 + 500 = -150 (cash 500 in, goods costing 650 out)
  await check('advance used by a credit sale', [s3.credit - s2.credit, s3.collected - s2.collected, s3.profit - s2.profit, s3.netProfit - s2.netProfit], [1000, 500, 350, -150]);
  await check('C3 owes 500', await balance(C3), 500);
  // Paying a debt partly made by hand: C4 owes 300 by hand (older) and 1000 on a sale; pays 800:
  // the hand debt is settled first, so only 500 counts as collected
  const C4 = await ok('POST', '/customers', { name: 'زبون مختلط' });
  await ok('POST', `/customers/${C4._id}/entries`, { kind: 'manual', amount: 300, date: new Date(Date.now() - 60000).toISOString() });
  await ok('POST', '/sales', { paymentType: 'credit', customerId: C4._id, items: [{ productId: P1._id, quantity: 1 }] });
  const s4 = await todaySummary();
  await ok('POST', `/customers/${C4._id}/entries`, { kind: 'payment', amount: 800 });
  const s5 = await todaySummary();
  await check('payment settles the oldest debt first', s5.collected - s4.collected, 500);

  /* A refund larger than what is still owed: C5 buys 1 x P1 on credit (1000), pays 1000, then
     returns it: all 1000 back in cash, nothing to the account */
  const C5 = await ok('POST', '/customers', { name: 'زبون سدد' });
  const S5 = await ok('POST', '/sales', { paymentType: 'credit', customerId: C5._id, items: [{ productId: P1._id, quantity: 1 }] });
  await ok('POST', `/customers/${C5._id}/entries`, { kind: 'payment', amount: 1000 });
  const r7 = await ret(S5);
  await check('fully paid credit sale returned in cash', [r7.data.toAccount, r7.data.refunded, await balance(C5)], [0, 1000, 0]);

  /* Impossible numbers are refused */
  await check('payment of 1e400 refused', (await call('POST', `/customers/${C5._id}/entries`, { kind: 'payment', amount: '1e400' })).status, 400);
  await check('expense of 1e400 refused', (await call('POST', '/expenses', { date: new Date().toISOString(), category: 'x', amount: '1e400' })).status, 400);
  await check('price of 1e400 refused', (await call('PUT', `/products/${P1._id}`, { salePrice: '1e400' })).status, 400);
  await check('box size 0 on a wholesale product refused', (await call('PUT', `/products/${P1._id}`, { wholesaleQty: 0 })).status, 400);
  await check('unreadable date range refused', (await call('GET', '/sales?from=nonsense&to=2025-01-01T00:00:00Z')).status, 400);
  const exp = await ok('POST', '/expenses', { date: new Date().toISOString(), category: 'تقريب', amount: 10.075 });
  await check('expense kept to the cent', exp.amount, 10.08);
  await ok('DELETE', `/expenses/${exp._id}`);

  /* Editing a price leaves the stock alone */
  const stockBeforeEdit = await stockOf('A1');
  await ok('PUT', `/products/${P1._id}`, { salePrice: 1000 });
  await check('price edit keeps stock', await stockOf('A1'), stockBeforeEdit);

  /* Weighed stock stays exact: 5 kg of a new product, sold in eight weights that drift as floats */
  const P6 = await ok('POST', '/products', { ...base, name: 'P6', barcode: 'A6', purchasePrice: 100, salePrice: 200, unit: 'kg', stock: 5, blockWhenOut: true });
  for (const kg of [0.25, 0.35, 0.4, 0.75, 1.1, 0.6, 0.45]) await ok('POST', '/sales', { items: [{ productId: P6._id, quantity: kg }] });
  await check('weight left exactly', await stockOf('A6'), 1.1);
  const lastWeights = await sell([{ productId: P6._id, quantity: 1.1 }]);
  await check('the last 1.1 kg can be sold', [lastWeights.status, await stockOf('A6')], [201, 0]);

  /* A box price shared over its pieces adds back up: P7 has a box of 3, bought at 1000 a box.
     Cost per piece 333.333333; selling one box costs 1000.00, not 3 x 333.33 = 999.99 */
  const P7 = await ok('POST', '/products', { ...base, name: 'P7', barcode: 'A7', purchasePrice: 300, salePrice: 400, hasWholesale: true, wholesaleQty: 3, wholesalePrice: 1100, stock: 0 });
  await ok('POST', '/purchases', { items: [{ product: P7._id, mode: 'pack', quantity: 2, price: 1000 }] });
  const boxSale = await ok('POST', '/sales', { items: [{ productId: P7._id, mode: 'wholesale', quantity: 1 }] });
  await check('box costed at its purchase price', [boxSale.cost, boxSale.profit], [1000, 100]);
  await check('one product twice in a purchase refused', (await call('POST', '/purchases', { items: [{ product: P7._id, quantity: 1, price: 1 }, { product: P7._id, mode: 'pack', quantity: 1, price: 1 }] })).status, 400);

  /* Supplier payments add up: 0.005 is kept as 0.01 in both the payment and the invoice */
  const small = await ok('POST', '/purchases', { paid: 0, items: [{ product: P7._id, quantity: 1, price: 1 }] });
  const smallPaid = await ok('POST', `/purchases/${small._id}/payments`, { amount: 0.005 });
  await check('payment rounding consistent', [smallPaid.paid, smallPaid.payments.reduce((s, p) => s + p.amount, 0)], [0.01, 0.01]);
  await ok('POST', `/purchases/${small._id}/cancel`);

  /* Cancelling invoices out of order puts back the right price.
     P8 starts at 90. A sets 100, B sets 120. Cancel A (B stands: stays 120), cancel B: 90. */
  const P8 = await ok('POST', '/products', { ...base, name: 'P8', barcode: 'A8', purchasePrice: 90, salePrice: 150, stock: 0 });
  const pA = await ok('POST', '/purchases', { items: [{ product: P8._id, quantity: 1, price: 100 }] });
  const pB = await ok('POST', '/purchases', { items: [{ product: P8._id, quantity: 1, price: 120 }] });
  await ok('POST', `/purchases/${pA._id}/cancel`);
  await check('A cancelled, B stands', (await products()).get('A8').purchasePrice, 120);
  await ok('POST', `/purchases/${pB._id}/cancel`);
  await check('both cancelled: price before both', (await products()).get('A8').purchasePrice, 90);
  // A sets 100, a later free invoice C does not change the price; cancel A: back to 90
  const pA2 = await ok('POST', '/purchases', { items: [{ product: P8._id, quantity: 1, price: 100 }] });
  await ok('POST', '/purchases', { items: [{ product: P8._id, quantity: 1, price: 0 }] });
  await ok('POST', `/purchases/${pA2._id}/cancel`);
  await check('a later free invoice does not keep a cancelled price', (await products()).get('A8').purchasePrice, 90);

  /* An invoice that started tracking a product, cancelled: the product is untracked again */
  const P9 = await ok('POST', '/products', { category: cat._id, name: 'P9', barcode: 'A9', purchasePrice: 50, salePrice: 80, trackStock: false });
  const p9 = await ok('POST', '/purchases', { items: [{ product: P9._id, quantity: 12, price: 50 }] });
  await check('purchase starts tracking', [(await products()).get('A9').trackStock, await stockOf('A9')], [true, 12]);
  await ok('POST', `/purchases/${p9._id}/cancel`);
  await check('cancel stops tracking again', (await products()).get('A9').trackStock, false);

  /* Counted while untracked (10 on the shelf), then a purchase of 24 starts tracking, 4 sell:
     applying the count gives 10 + 24 - 4 = 30, not 10 */
  const sc2 = await ok('POST', '/stockcounts');
  await ok('PUT', `/stockcounts/${sc2._id}/lines/${P9._id}`, { counted: 10 });
  await ok('POST', '/purchases', { items: [{ product: P9._id, quantity: 24, price: 50 }] });
  await ok('POST', '/sales', { items: [{ productId: P9._id, quantity: 4 }] });
  await ok('POST', `/stockcounts/${sc2._id}/apply`);
  await check('count before tracking adds to what came after', await stockOf('A9'), 30);

  /* Valuation, summed here product by product */
  ps = await products();
  let capital = 0;
  let saleValue = 0;
  for (const p of ps.values()) {
    if (p.trackStock && p.stock > 0) {
      capital += p.stock * p.purchasePrice;
      saleValue += p.stock * p.salePrice;
    }
  }
  const v = await ok('GET', '/products/valuation');
  await check('capital', v.capital, Math.round(capital * 100) / 100);
  await check('sale value', v.saleValue, Math.round(saleValue * 100) / 100);
  // C3 owes 500, C4 owes 300 + 1000 - 800 = 500; nothing owed to suppliers (all paid or cancelled... except
  // the purchases made above without "paid", which default to fully paid)
  await check('debts in capital', v.debts, { owedToShop: 1000, owedByShop: 0, owedToSuppliers: 0 });
}
