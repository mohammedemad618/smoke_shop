// Two shops on one server never see each other's data: the same barcode lives in both, an
// id from one shop means nothing in the other, invoice numbers count separately, and sales
// made in both at once leave exact counts in each.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './support/harness.js';

let env;
let a;
let b;
before(async () => {
  env = await startTestEnv();
  // Shop A's invoices start at 1000, shop B's at 1
  a = await env.createShop('shop-a', { firstInvoiceNumber: 1000 });
  b = await env.createShop('shop-b');
});
after(async () => {
  await env?.close();
});

async function ok(shop, method, path, body) {
  const res = await shop.client.request(method, `/api${path}`, body);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}
const call = (shop, method, path, body) => shop.client.request(method, `/api${path}`, body);

// A category and a tracked product with `stock` pieces, in one shop
async function product(shop, { barcode, name, salePrice, stock = 0 }) {
  const categories = await ok(shop, 'GET', '/categories');
  const category = categories.find((c) => c.name === 'عام');
  return ok(shop, 'POST', '/products', { name, barcode, category: category._id, purchasePrice: 100, salePrice, trackStock: true, stock });
}

test('each shop starts with its own settings and the category «عام»', async () => {
  assert.deepStrictEqual(await ok(a, 'GET', '/shop'), { shopName: 'متجر shop-a', receiptNote: '', phone: '', address: '' });
  assert.deepStrictEqual(await ok(b, 'GET', '/shop'), { shopName: 'متجر shop-b', receiptNote: '', phone: '', address: '' });
  assert.deepStrictEqual((await ok(a, 'GET', '/categories')).map((c) => c.name), ['عام']);
  assert.deepStrictEqual((await ok(b, 'GET', '/categories')).map((c) => c.name), ['عام']);
});

test('the same barcode in both shops: each finds its own product', async () => {
  const inA = await product(a, { barcode: 'SAME-1', name: 'شاي أ', salePrice: 1000 });
  const inB = await product(b, { barcode: 'SAME-1', name: 'شاي ب', salePrice: 2500 });
  assert.notStrictEqual(inA._id, inB._id);
  const foundA = await ok(a, 'GET', '/products/barcode/SAME-1');
  const foundB = await ok(b, 'GET', '/products/barcode/SAME-1');
  assert.deepStrictEqual([foundA._id, foundA.name, foundA.salePrice], [inA._id, 'شاي أ', 1000]);
  assert.deepStrictEqual([foundB._id, foundB.name, foundB.salePrice], [inB._id, 'شاي ب', 2500]);
  // Still unique within a shop
  assert.strictEqual((await call(a, 'POST', '/products', { name: 'x', barcode: 'SAME-1', category: foundA.category._id, purchasePrice: 1, salePrice: 2 })).status, 409);
});

test("shop A's ids mean nothing in shop B", async () => {
  const pA = await product(a, { barcode: 'ONLY-A', name: 'منتج أ', salePrice: 500, stock: 10 });
  const customerA = await ok(a, 'POST', '/customers', { name: 'زبون أ' });
  const saleA = await ok(a, 'POST', '/sales', { items: [{ productId: pA._id, quantity: 1 }] });
  const purchaseA = await ok(a, 'POST', '/purchases', { items: [{ product: pA._id, quantity: 2, price: 100 }] });
  const countA = await ok(a, 'POST', '/stockcounts');
  const expenseA = await ok(a, 'POST', '/expenses', { date: new Date().toISOString(), category: 'إيجار', amount: 50 });
  const catA = pA.category._id;
  const pB = await product(b, { barcode: 'ONLY-B', name: 'منتج ب', salePrice: 700, stock: 5 });

  const refused = [
    ['PUT', `/products/${pA._id}`, { salePrice: 1 }, 404],
    ['DELETE', `/products/${pA._id}`, undefined, 404],
    ['GET', '/products/barcode/ONLY-A', undefined, 404],
    ['POST', '/sales', { items: [{ productId: pA._id, quantity: 1 }] }, 400],
    ['POST', `/sales/${saleA._id}/returns`, {}, 404],
    ['GET', `/customers/${customerA._id}`, undefined, 404],
    ['POST', `/customers/${customerA._id}/entries`, { kind: 'payment', amount: 10 }, 404],
    ['POST', '/sales', { paymentType: 'credit', customerId: customerA._id, items: [{ productId: pB._id, quantity: 1 }] }, 400],
    ['GET', `/purchases/${purchaseA._id}`, undefined, 404],
    ['POST', `/purchases/${purchaseA._id}/cancel`, undefined, 404],
    ['POST', '/purchases', { items: [{ product: pA._id, quantity: 1, price: 1 }] }, 400],
    ['GET', `/stockcounts/${countA._id}`, undefined, 404],
    ['PUT', `/expenses/${expenseA._id}`, { amount: 1 }, 404],
    ['PUT', `/categories/${catA}`, { name: 'مسروق' }, 404],
    ['POST', '/products', { name: 'y', barcode: 'Y1', category: catA, purchasePrice: 1, salePrice: 2 }, 400],
  ];
  for (const [method, path, body, status] of refused) {
    assert.strictEqual((await call(b, method, path, body)).status, status, `${method} ${path} in shop B`);
  }
  // Nothing in A moved: the product, its stock (10 - 1 sold + 2 bought) and its price
  const stillA = await ok(a, 'GET', '/products/barcode/ONLY-A');
  assert.deepStrictEqual([stillA._id, stillA.stock, stillA.salePrice], [pA._id, 11, 500]);
  assert.strictEqual((await ok(a, 'GET', `/purchases/${purchaseA._id}`)).status, 'active');
  assert.strictEqual((await ok(a, 'GET', '/categories')).find((c) => c._id === catA).name, 'عام');
  // Nor in B: the refused credit sale took nothing
  assert.strictEqual((await ok(b, 'GET', '/products/barcode/ONLY-B')).stock, 5);
});

test('invoice numbers count separately in each shop', async () => {
  const pA = await product(a, { barcode: 'NUM-A', name: 'عداد أ', salePrice: 10 });
  const pB = await product(b, { barcode: 'NUM-B', name: 'عداد ب', salePrice: 10 });
  const sale = (shop, p) => ok(shop, 'POST', '/sales', { items: [{ productId: p._id, quantity: 1 }] });
  // Shop A sold one invoice above (1000); shop B none yet
  const a1 = await sale(a, pA);
  const b1 = await sale(b, pB);
  const a2 = await sale(a, pA);
  const b2 = await sale(b, pB);
  assert.deepStrictEqual([a1.number, a2.number], [1001, 1002]);
  assert.deepStrictEqual([b1.number, b2.number], [1, 2]);
  const purchaseB = await ok(b, 'POST', '/purchases', { items: [{ product: pB._id, quantity: 1, price: 5 }] });
  assert.strictEqual(purchaseB.number, 1, "shop A's purchase does not move shop B's purchase numbers");
});

test('50 sales at once across both shops leave exact counts', async () => {
  const pA = await product(a, { barcode: 'RUSH', name: 'زحمة أ', salePrice: 100, stock: 500 });
  const pB = await product(b, { barcode: 'RUSH', name: 'زحمة ب', salePrice: 200, stock: 500 });
  const before = { a: (await ok(a, 'GET', '/sales')).sales.length, b: (await ok(b, 'GET', '/sales')).sales.length };
  // Sale i goes to shop A when i is even, with i % 3 + 1 pieces
  const jobs = Array.from({ length: 50 }, (_, i) => {
    const [shop, p] = i % 2 === 0 ? [a, pA] : [b, pB];
    return ok(shop, 'POST', '/sales', { items: [{ productId: p._id, quantity: (i % 3) + 1 }] });
  });
  const sales = await Promise.all(jobs);
  const expected = { a: { count: 0, pieces: 0 }, b: { count: 0, pieces: 0 } };
  for (let i = 0; i < 50; i++) {
    const side = i % 2 === 0 ? 'a' : 'b';
    expected[side].count += 1;
    expected[side].pieces += (i % 3) + 1;
  }
  assert.strictEqual((await ok(a, 'GET', '/products/barcode/RUSH')).stock, 500 - expected.a.pieces);
  assert.strictEqual((await ok(b, 'GET', '/products/barcode/RUSH')).stock, 500 - expected.b.pieces);
  const listA = (await ok(a, 'GET', '/sales')).sales;
  const listB = (await ok(b, 'GET', '/sales')).sales;
  assert.strictEqual(listA.length - before.a, expected.a.count);
  assert.strictEqual(listB.length - before.b, expected.b.count);
  // Every invoice of the rush has its own number, with no gap, in its own shop
  for (const [side, list] of [['a', sales.filter((_, i) => i % 2 === 0)], ['b', sales.filter((_, i) => i % 2 === 1)]]) {
    const numbers = list.map((s) => s.number).sort((x, y) => x - y);
    assert.strictEqual(new Set(numbers).size, expected[side].count);
    assert.strictEqual(numbers.at(-1) - numbers[0] + 1, expected[side].count, `shop ${side} numbers have no gap`);
  }
  // Each shop's sales are its own product only, at its own price
  assert.ok(listA.every((s) => s.items.every((i) => i.name !== 'زحمة ب')));
  assert.ok(listB.filter((s) => s.items[0].barcode === 'RUSH').every((s) => s.items[0].unitPrice === 200));
});
