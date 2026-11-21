import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './support/harness.js';
import { reportCalendar } from '../public/js/report-calendar.js';

let env;
before(async () => { env = await startTestEnv(); });
after(async () => { await env?.close(); });

const at = (date, time = '00:00') => new Date(`${date}T${time}:00+03:00`);
const day = at('2025-02-13');
const nextDay = at('2025-02-14');
const month = at('2025-02-01');
const nextMonth = at('2025-03-01');
const range = (from, to) => new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });

async function shopOf(slug) {
  const { client, db } = await env.createShop(slug);
  const request = async (method, url, body) => {
    const result = await client.request(method, `/api${url}`, body);
    assert.ok(result.status < 300, result.text);
    return result.data;
  };
  return { db, request };
}

test('daily and monthly operating profit, cash and receivables reconcile independently', async () => {
  const { db, request } = await shopOf('summary-cash');
  const [category] = await request('GET', '/categories');
  await request('PUT', '/settings', { openingCashBalance: 1000 });
  const product = await request('POST', '/products', {
    name: 'منتج الملخص', barcode: 'SUMMARY-1', category: category._id, purchasePrice: 80, salePrice: 200, trackStock: true, stock: 100,
  });
  const debtor = await request('POST', '/customers', { name: 'زبون له دين' });
  const advance = await request('POST', '/customers', { name: 'زبون دفع مقدمًا' });
  const returning = await request('POST', '/customers', { name: 'زبون أعاد الشراء' });
  const sale = async (date, quantity, paid, customer) => {
    const invoice = await request('POST', '/sales', {
      items: [{ productId: product._id, quantity }], paid,
      ...(customer ? { paymentType: 'credit', customerId: customer._id } : {}),
    });
    await db.collection('sales').updateOne({ number: invoice.number }, { $set: { createdAt: date } });
    if (customer) {
      await db.collection('debtentries').updateOne({ kind: 'sale', saleNumber: invoice.number }, { $set: { date } });
    }
    return invoice;
  };
  const entry = (customer, kind, amount, date) =>
    request('POST', `/customers/${customer._id}/entries`, { kind, amount, date });
  const expense = (date, amount) => request('POST', '/expenses', { category: 'نفقات', date, amount });
  const refund = async (invoice, date) => {
    const returned = await request('POST', `/sales/${invoice._id}/returns`);
    await db.collection('sales').updateOne({ number: invoice.number }, { $set: { 'returns.0.at': date } });
    await db.collection('debtentries').updateOne({ kind: 'return', saleNumber: invoice.number }, { $set: { date } });
    return returned;
  };

  await entry(debtor, 'manual', 50, at('2025-01-28'));
  const previousCashSale = await sale(at('2025-01-30'), 1, 200);
  await sale(at('2025-01-31'), 1, 0, debtor);
  await expense(at('2025-01-30'), 20);
  const purchase = await request('POST', '/purchases', {
    date: at('2025-01-30'), paid: 100, items: [{ product: product._id, price: 50, quantity: 6 }],
  });
  await request('POST', `/purchases/${purchase._id}/payments`, { date: at('2025-02-13', '11:00'), amount: 75 });
  await request('POST', `/purchases/${purchase._id}/cancel`);
  // A legacy supplier invoice with a paid total but without dated payment rows.
  await db.collection('purchases').insertOne({ number: 91, date: at('2025-02-10'), total: 40, paid: 40, status: 'active', items: [] });

  await expense(at('2025-02-12'), 30);
  await entry(advance, 'payment', 40, at('2025-02-12'));
  await sale(day, 2, 500);
  await sale(at('2025-02-13', '09:30'), 1, 50, debtor);
  await sale(at('2025-02-13', '10:00'), 1, 0, advance);
  const refundToAccount = await sale(at('2025-02-13', '11:00'), 1, 50, returning);
  const returned = await refund(refundToAccount, at('2025-02-13', '12:00'));
  assert.deepEqual([returned.toAccount, returned.refunded], [150, 50]);
  await refund(previousCashSale, at('2025-02-13', '12:30'));
  await entry(debtor, 'payment', 90, at('2025-02-13', '13:00'));
  await entry(debtor, 'payment', 350, at('2025-02-13', '13:30'));
  await expense(at('2025-02-13', '14:00'), 70);
  await expense(nextDay, 10);

  const daily = await request('GET', `/summary/cash?${range(day, nextDay)}`);
  assert.deepEqual(daily, {
    openingBalance: 1050, salesReceived: 500, customerPayments: 440, refunds: 250,
    supplierPayments: 75, expenses: 70, closingBalance: 1595,
  });
  const monthly = await request('GET', `/summary/cash?${range(month, nextMonth)}`);
  assert.deepEqual(monthly, {
    openingBalance: 1080, salesReceived: 500, customerPayments: 480, refunds: 250,
    supplierPayments: 115, expenses: 110, closingBalance: 1585,
  });
  assert.equal((await request('GET', '/products/valuation')).cashBalance, monthly.closingBalance);

  const { payments, next } = await request('GET', `/customers/payments?${range(day, nextDay)}`);
  assert.equal(next, null);
  assert.deepEqual(payments.map((p) => [p.customerName, p.amount, p.appliedToSales, p.appliedToOtherDebt, p.advance, p.balanceAfter]), [
    [debtor.name, 350, 310, 0, 40, -40],
    [debtor.name, 90, 40, 50, 0, 310],
  ]);
  const query = range(month, nextMonth);
  query.set('groupBy', 'day');
  query.set('tz', 'Asia/Baghdad');
  const { periods, summary } = await request('GET', `/sales/report?${query}`);
  const breakdown = periods.find((p) => p.key === '2025-02-13');
  assert.deepEqual([breakdown.total, breakdown.cost, breakdown.profit, breakdown.credit, breakdown.collected, breakdown.netProfit], [600, 240, 360, 350, 440, 290]);
  assert.deepEqual([summary.collected, summary.netProfit], [480, 250]);
  assert.deepEqual([breakdown.returnedCost, summary.returnedCost], [160, 160]);
  const dayReport = await request('GET', `/sales?${range(day, nextDay)}`);
  assert.deepEqual([dayReport.summary.netProfit, dayReport.summary.collected], [290, daily.customerPayments]);
  assert.equal(periods.reduce((total, row) => total + row.netProfit, 0), summary.netProfit);
  const debts = await request('GET', `/summary/debts?${range(month, nextMonth)}`);
  assert.deepEqual(debts, {
    sales: { opening: 200, added: 500, paid: 350, returns: 150, advanceUsed: 40, closing: 160 },
    manual: { opening: 50, added: 0, paid: 50, returns: 0, advanceUsed: 0, closing: 0 },
    advances: { opening: 0, received: 80, returns: 0, used: 40, closing: 40 },
    received: 480,
  });
  const debtDay = await request('GET', `/summary/debts?${range(day, nextDay)}`);
  assert.deepEqual([debtDay.advances.opening, debtDay.advances.used, debtDay.advances.received, debtDay.received], [40, 40, 40, 440]);
  const balances = (await request('GET', '/products/valuation')).debts;
  assert.equal(debts.sales.closing + debts.manual.closing, balances.owedToShop);
  assert.equal(debts.advances.closing, balances.owedByShop);
});

test('payment pages move past a shared timestamp without repeating records', async () => {
  const { db, request } = await shopOf('summary-pages');
  const customer = await request('POST', '/customers', { name: 'زبون' });
  await request('POST', `/customers/${customer._id}/entries`, { kind: 'payment', amount: 1, date: day });
  const collection = db.collection('debtentries');
  const original = await collection.findOne({ kind: 'payment' });
  const { _id, ...record } = original;
  await collection.insertMany(Array.from({ length: 25 }, (_, i) => ({ ...record, note: String(i) })));
  const query = range(day, nextDay);
  const first = await request('GET', `/customers/payments?${query}`);
  assert.equal(first.payments.length, 25);
  assert.ok(first.next);
  query.set('before', first.next);
  const second = await request('GET', `/customers/payments?${query}`);
  assert.equal(second.next, null);
  assert.deepEqual(second.payments.map((p) => p.balanceAfter), [-1]);
  assert.equal(new Set([...first.payments, ...second.payments].map((p) => p.note)).size, 26);
  const monthDebts = await request('GET', `/summary/debts?${range(month, nextMonth)}`);
  assert.equal(monthDebts.received, 26);
  assert.equal(monthDebts.advances.received, 26);
});

test('shop-calendar cutoffs include midnight receipts once, including advances used in another month', async () => {
  const baghdad = reportCalendar('Asia/Baghdad');
  assert.equal(baghdad.dayKey(new Date('2025-01-31T21:00:00Z')), '2025-02-01');
  const february = new URLSearchParams(baghdad.range('2025-02-01', '2025-03-01'));
  assert.deepEqual(Object.fromEntries(february), { from: month.toISOString(), to: nextMonth.toISOString() });
  assert.deepEqual(reportCalendar('America/New_York').range('2025-03-09', '2025-03-10'), {
    from: '2025-03-09T05:00:00.000Z', to: '2025-03-10T04:00:00.000Z',
  });
  const { request } = await shopOf('summary-boundaries');
  await request('PUT', '/settings', { timeZone: 'America/New_York' });
  assert.equal((await request('GET', '/shop')).timeZone, 'America/New_York');
  await request('PUT', '/settings', { timeZone: 'Asia/Baghdad' });
  const customer = await request('POST', '/customers', { name: 'رصيد افتتاحي' });
  const entry = (kind, amount, date) => request('POST', `/customers/${customer._id}/entries`, { kind, amount, date });
  await entry('payment', 25.75, new Date(+month - 1));
  await entry('manual', 100, month);
  await entry('payment', 60, new Date(+nextMonth - 1));
  await entry('payment', 14.25, nextMonth);
  const debts = await request('GET', `/summary/debts?${february}`);
  assert.deepEqual(debts.manual, { opening: 0, added: 100, paid: 60, returns: 0, advanceUsed: 25.75, closing: 14.25 });
  assert.deepEqual(debts.advances, { opening: 25.75, received: 0, returns: 0, used: 25.75, closing: 0 });
  const cash = await request('GET', `/summary/cash?${february}`);
  const report = await request('GET', `/sales/report?${february}&groupBy=day&tz=Asia%2FBaghdad`);
  assert.deepEqual([debts.received, cash.customerPayments, report.summary.collected, report.summary.netProfit], [60, 60, 60, 0]);
  assert.deepEqual(report.periods.map(p => [p.key, p.collected]), [['2025-02-28', 60]]);
  const march = await request('GET', `/summary/debts?${range(nextMonth, at('2025-04-01'))}`);
  assert.deepEqual([march.manual.opening, march.received, march.manual.closing], [14.25, 14.25, 0]);
});
