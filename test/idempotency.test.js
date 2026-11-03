// A sale, a purchase or a return sent again with the same clientId (an answer lost on the
// network, a session that ended mid-sale) is recorded once: the second request gets the
// first one's record with 200, the same invoice number, and stock and debts move once,
// also when both arrive at the same moment.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './support/harness.js';
import { isPurchaseOf, isReturnOf, isSaleOf } from '../public/js/idempotency.js';

let env;
let shop;
let category;
before(async () => {
  env = await startTestEnv();
  shop = await env.createShop('again');
  category = (await ok('GET', '/categories'))[0];
});
after(async () => {
  await env?.close();
});

const call = (method, path, body) => shop.client.request(method, `/api${path}`, body);
async function ok(method, path, body) {
  const res = await call(method, path, body);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}
const product = (barcode, stock) => ok('POST', '/products', { name: `منتج ${barcode}`, barcode, category: category._id, purchasePrice: 100, salePrice: 250, trackStock: true, stock });
const stockOf = async (barcode) => (await ok('GET', `/products/barcode/${barcode}`)).stock;
const countSales = () => shop.db.collection('sales').countDocuments();

test('the same clientSaleId twice: the same invoice number, the stock taken once', async () => {
  const p = await product('ONCE-1', 20);
  const body = { items: [{ productId: p._id, quantity: 3 }], paid: 1000, clientId: 'cart-0001-aaaa' };
  const salesBefore = await countSales();
  const first = await call('POST', '/sales', body);
  const second = await call('POST', '/sales', body);
  assert.deepStrictEqual([first.status, second.status], [201, 200]);
  assert.deepStrictEqual([second.data._id, second.data.number, second.data.total, second.data.change], [first.data._id, first.data.number, 750, 250]);
  assert.strictEqual(await stockOf('ONCE-1'), 17);
  assert.strictEqual(await countSales(), salesBefore + 1);
  // Changed in between, the cart's id still names the sale it made: nothing more is sold
  const changed = await call('POST', '/sales', { ...body, items: [{ productId: p._id, quantity: 5 }] });
  assert.deepStrictEqual([changed.status, changed.data.number], [200, first.data.number]);
  assert.strictEqual(await stockOf('ONCE-1'), 17);
  // The next sale takes the next number: the repeats used none
  const next = await ok('POST', '/sales', { items: [{ productId: p._id, quantity: 1 }], clientId: 'cart-0002-bbbb' });
  assert.strictEqual(next.number, first.data.number + 1);
});

test('the same sale five times at once is still one invoice, with the stock taken once', async () => {
  const p = await product('ONCE-2', 10);
  const salesBefore = await countSales();
  const body = { items: [{ productId: p._id, quantity: 2 }], clientId: 'cart-rush-0001' };
  const answers = await Promise.all(Array.from({ length: 5 }, () => call('POST', '/sales', body)));
  assert.deepStrictEqual(answers.map((a) => a.status).sort(), [200, 200, 200, 200, 201]);
  assert.strictEqual(new Set(answers.map((a) => a.data.number)).size, 1);
  assert.strictEqual(await stockOf('ONCE-2'), 8);
  assert.strictEqual(await countSales(), salesBefore + 1);
});

test('a credit sale sent twice puts its debt on the account once', async () => {
  const p = await product('ONCE-3', 10);
  const customer = await ok('POST', '/customers', { name: 'زبون مكرر' });
  const body = { items: [{ productId: p._id, quantity: 4 }], paymentType: 'credit', customerId: customer._id, paid: 200, clientId: 'cart-credit-01' };
  const [first, second] = [await call('POST', '/sales', body), await call('POST', '/sales', body)];
  assert.deepStrictEqual([first.status, second.status, second.data.number], [201, 200, first.data.number]);
  assert.deepStrictEqual([second.data.debt, second.data.customerBalance], [800, 800]);
  assert.strictEqual((await ok('GET', `/customers/${customer._id}`)).balance, 800);
  assert.strictEqual(await shop.db.collection('debtentries').countDocuments({ kind: 'sale', saleNumber: first.data.number }), 1);
});

test('without a clientId every request is a new sale, as before; a malformed one is refused', async () => {
  const p = await product('ONCE-4', 10);
  const body = { items: [{ productId: p._id, quantity: 1 }] };
  const [one, two] = [await ok('POST', '/sales', body), await ok('POST', '/sales', body)];
  assert.notStrictEqual(one.number, two.number);
  assert.strictEqual(await stockOf('ONCE-4'), 8);
  for (const clientId of ['short', 'has space in it', 'x'.repeat(65), 12345678, { $ne: null }]) {
    const res = await call('POST', '/sales', { ...body, clientId });
    assert.strictEqual(res.status, 400, JSON.stringify(clientId));
  }
  assert.strictEqual(await stockOf('ONCE-4'), 8);
});

test('a purchase saved twice is one invoice, its goods added once', async () => {
  const p = await product('ONCE-5', 5);
  const body = { items: [{ product: p._id, quantity: 10, price: 90 }], clientId: 'purchase-0001' };
  const answers = [await call('POST', '/purchases', body), ...(await Promise.all([call('POST', '/purchases', body), call('POST', '/purchases', body)]))];
  assert.deepStrictEqual(answers.map((a) => a.status), [201, 200, 200]);
  assert.strictEqual(new Set(answers.map((a) => a.data.number)).size, 1);
  assert.strictEqual(await stockOf('ONCE-5'), 15);
  assert.strictEqual(await shop.db.collection('purchases').countDocuments({ clientId: 'purchase-0001' }), 1);
});

test('a purchase sent twice at the same moment, with no earlier request: its goods once, and its prices stand', async () => {
  for (let round = 0; round < 4; round++) {
    // Every other round a product whose quantity was not counted yet: the purchase starts it
    const p = await ok('POST', '/products', { name: `منتج معًا ${round}`, barcode: `TWICE-${round}`, category: category._id, purchasePrice: 100, salePrice: 250, trackStock: round % 2 === 0, stock: 5 });
    const body = { items: [{ product: p._id, quantity: 10, price: 90, salePrice: 300 }], clientId: `purchase-twice-${round}` };
    const answers = await Promise.all([call('POST', '/purchases', body), call('POST', '/purchases', body)]);
    assert.deepStrictEqual(answers.map((a) => a.status).sort(), [200, 201], `round ${round}`);
    assert.strictEqual(answers[0].data.number, answers[1].data.number);
    const after = await ok('GET', `/products/barcode/TWICE-${round}`);
    assert.deepStrictEqual([after.purchasePrice, after.salePrice, after.trackStock, after.stock], [90, 300, true, round % 2 === 0 ? 15 : 10], `round ${round}`);
    assert.strictEqual(await shop.db.collection('purchases').countDocuments({ clientId: body.clientId }), 1);
  }
});

test('a return sent twice gives the money and the stock back once, at once or one after the other', async () => {
  const p = await product('ONCE-6', 10);
  const sale = await ok('POST', '/sales', { items: [{ productId: p._id, quantity: 4 }] });
  const body = { items: [{ line: 0, quantity: 1 }], clientId: 'return-0001' };
  const first = await call('POST', `/sales/${sale._id}/returns`, body);
  const second = await call('POST', `/sales/${sale._id}/returns`, body);
  assert.deepStrictEqual([first.status, first.data.refunded, second.status, second.data.refunded], [201, 250, 200, 250]);
  assert.strictEqual(second.data.sale.returns.length, 1);
  assert.strictEqual(await stockOf('ONCE-6'), 7);

  // The rest cancelled, sent three times at once
  const cancel = { clientId: 'return-0002' };
  const answers = await Promise.all(Array.from({ length: 3 }, () => call('POST', `/sales/${sale._id}/returns`, cancel)));
  assert.deepStrictEqual(answers.map((a) => a.status).sort(), [200, 200, 201]);
  assert.ok(answers.every((a) => a.data.refunded === 750));
  const after = await shop.db.collection('sales').findOne({ number: sale.number });
  assert.deepStrictEqual([after.returns.length, after.returnedTotal, after.returnStatus], [2, 1000, 'full']);
  assert.strictEqual(await stockOf('ONCE-6'), 10);
});

test('the pages tell the record of their own request from one made earlier under the same id from another cart', async () => {
  const sugar = await product('SAME-1', 50);
  const tea = await product('SAME-2', 50);
  // A cart with a line repeated: the server merges it, and it is still this cart's sale
  const cart = { items: [{ productId: sugar._id, quantity: 1 }, { productId: sugar._id, quantity: 2 }], clientId: 'cart-same-0001' };
  const sold = await call('POST', '/sales', cart);
  assert.strictEqual(sold.status, 201);
  assert.ok(isSaleOf(cart, sold.data));
  // Its answer lost, the cart changed, sent again: the server gives back the sale it made,
  // which the cashier must not take for this cart (it would be emptied, the tea never sold)
  const changed = { ...cart, items: [...cart.items, { productId: tea._id, quantity: 3 }] };
  const replay = await call('POST', '/sales', changed);
  assert.deepStrictEqual([replay.status, replay.data.number], [200, sold.data.number]);
  assert.ok(!isSaleOf(changed, replay.data));
  assert.ok(isSaleOf(cart, replay.data), 'the same cart again is the same sale');
  assert.ok(!isSaleOf({ items: [{ productId: sugar._id, quantity: 3, mode: 'wholesale' }] }, replay.data), 'sold by the pack is another line');

  const draft = { items: [{ product: tea._id, quantity: 4, price: 80.004 }], clientId: 'purchase-same-01' };
  const bought = await call('POST', '/purchases', draft);
  assert.ok(isPurchaseOf(draft, bought.data));
  const edited = { ...draft, items: [{ product: tea._id, quantity: 4, price: 85 }] };
  const again = await call('POST', '/purchases', edited);
  assert.deepStrictEqual([again.status, again.data.number], [200, bought.data.number]);
  assert.ok(!isPurchaseOf(edited, again.data));

  const back = { items: [{ line: 0, quantity: 1 }], clientId: 'return-same-001' };
  const returned = await call('POST', `/sales/${sold.data._id}/returns`, back);
  assert.ok(isReturnOf(back, returned.data.sale));
  const more = { ...back, items: [{ line: 0, quantity: 2 }] };
  const repeated = await call('POST', `/sales/${sold.data._id}/returns`, more);
  assert.deepStrictEqual([repeated.status, repeated.data.refunded], [200, returned.data.refunded]);
  assert.ok(!isReturnOf(more, repeated.data.sale));
  assert.strictEqual(await stockOf('SAME-1'), 48);
});
