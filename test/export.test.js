// The owner's CSV exports (routes/export.js, services/exports.js): UTF-8 with a BOM and
// Arabic headers so Excel opens them right, a text that looks like a formula kept as text,
// the month's total line equal to the sales report of the same month, and nothing without
// the owner's session.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './support/harness.js';

let env;
let shop;
before(async () => {
  env = await startTestEnv();
  shop = await env.createShop('csv-shop');
});
after(async () => {
  await env?.close();
});

// The cells of one CSV line as written here: quoted text ("" inside), bare numbers
const cells = (line) => {
  const out = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (line[j] === '"' && line[j + 1] === '"') {
          value += '"';
          j += 2;
        } else if (line[j] === '"') break;
        else value += line[j++];
      }
      out.push(value);
      i = j + 2;
    } else {
      const end = line.indexOf(',', i) === -1 ? line.length : line.indexOf(',', i);
      out.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return out;
};
const rows = (text) => {
  assert.ok(text.startsWith('﻿'), 'a byte order mark first');
  assert.ok(text.endsWith('\r\n'));
  return text.slice(1, -2).split('\r\n').map(cells);
};

test('products: Arabic headers, every product, a formula-like name kept as text', async () => {
  const { client } = shop;
  const general = (await client.request('GET', '/api/categories')).data[0];
  await client.request('POST', '/api/products', { name: 'سكر "ناعم"', barcode: 'S1', category: general._id, purchasePrice: 1000, salePrice: 1250, trackStock: true, stock: 7 });
  await client.request('POST', '/api/products', { name: '=HYPERLINK("http://x")', barcode: 'F1', category: general._id, purchasePrice: 10, salePrice: 20 });
  const res = await client.request('GET', '/api/export/products.csv');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/csv; charset=utf-8/);
  assert.match(res.headers['content-disposition'], /^attachment; filename="products-csv-shop-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.strictEqual(res.headers['cache-control'], 'no-store');
  const [head, ...lines] = rows(res.text);
  assert.deepStrictEqual(head.slice(0, 6), ['الاسم', 'الباركود', 'القسم', 'الوحدة', 'سعر الشراء', 'سعر البيع']);
  const sugar = lines.find((l) => l[1] === 'S1');
  assert.deepStrictEqual(sugar.slice(0, 9), ['سكر "ناعم"', 'S1', 'عام', 'قطعة', '1000', '1250', '250', 'نعم', '7']);
  assert.strictEqual(lines.find((l) => l[1] === 'F1')[0], `'=HYPERLINK("http://x")`);
});

test("a month's sales by day: the total line is the sales report of the same month", async () => {
  const { client } = shop;
  const products = (await client.request('GET', '/api/products')).data;
  const sugar = products.find((p) => p.barcode === 'S1');
  const sale = (await client.request('POST', '/api/sales', { items: [{ productId: sugar._id, quantity: 3 }] })).data;
  const customer = (await client.request('POST', '/api/customers', { name: 'زبون' })).data;
  const credit = await client.request('POST', '/api/sales', { items: [{ productId: sugar._id, quantity: 1 }], paymentType: 'credit', customerId: customer._id, paid: 0 });
  assert.strictEqual(credit.status, 201, credit.text);
  const returned = await client.request('POST', `/api/sales/${sale._id}/returns`, { items: [{ line: 0, quantity: 1 }] });
  assert.strictEqual(returned.status, 201, returned.text);
  await client.request('POST', '/api/expenses', { date: new Date().toISOString(), amount: 300, category: 'كهرباء' });
  const now = new Date();
  const range = { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(), tz: 'Asia/Baghdad' };
  const query = new URLSearchParams(range);
  const report = (await client.request('GET', `/api/sales/report?${query}&groupBy=day`)).data;
  const res = await client.request('GET', `/api/export/sales.csv?${query}&label=2026-11`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-disposition'], /filename="sales-csv-shop-2026-11\.csv"/);
  const [head, ...lines] = rows(res.text);
  assert.deepStrictEqual(head, ['اليوم', 'عدد الفواتير', 'القطع', 'المبيعات', 'التكلفة', 'الربح', 'المرتجعات', 'البيع بالدين', 'المصاريف', 'المسدد من ديون المبيعات', 'صافي الربح']);
  const total = lines.at(-1);
  assert.strictEqual(total[0], 'المجموع');
  const s = report.summary;
  assert.deepStrictEqual(total.slice(1).map(Number), [s.count, s.pieces, s.total, s.cost, s.profit, s.returns, s.credit, s.expenses, s.collected, s.netProfit]);
  // And each day is the report's day
  assert.deepStrictEqual(lines.slice(0, -1).map((l) => [l[0], Number(l[3])]), report.periods.map((p) => [p.key, p.total]));
  assert.ok(s.total > 0 && s.returns > 0 && s.credit > 0 && s.expenses === 300);
});

test("debts: each customer with what they owe", async () => {
  const res = await shop.client.request('GET', '/api/export/debts.csv');
  const [head, ...lines] = rows(res.text);
  assert.deepStrictEqual(head, ['الزبون', 'الهاتف', 'الرصيد', 'الحالة', 'آخر حركة', 'ملاحظة']);
  assert.deepStrictEqual(lines.map((l) => [l[0], Number(l[2]), l[3]]), [['زبون', 1250, 'عليه دين']]);
});

test('nothing without the session, and a range that cannot be read is refused', async () => {
  const stranger = env.client(shop.host);
  for (const file of ['products', 'sales', 'debts']) {
    const res = await stranger.request('GET', `/api/export/${file}.csv`);
    assert.deepStrictEqual([res.status, res.data.code], [401, 'AUTH_EXPIRED'], file);
  }
  assert.strictEqual((await shop.client.request('GET', '/api/export/sales.csv?from=x&to=y')).status, 400);
  assert.strictEqual((await shop.client.request('GET', '/api/export/sales.csv?from=2026-01-01&to=2026-02-01&tz=Mars/Base')).status, 400);
});
