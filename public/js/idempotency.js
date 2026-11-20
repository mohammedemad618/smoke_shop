// A sale, a purchase or a return is sent with an id (clientId) so that sending it again after
// a lost answer records it once (lib/idempotency.js). For an id it knows already, the server
// answers with what it recorded then, whatever the request holds now. These say whether that
// record is what the page sent, or one recorded earlier under the same id from another cart
// or draft: a cart changed after a try whose answer was lost, a tab duplicated with its
// cart, a purchase draft saved from two tabs. The page then keeps what it has, gives it a
// new id and says so, instead of taking the old record for it. No side effects on import,
// so the tests can run it.
import { roundTo } from './rounding.js';

// key -> { quantity, price, discount }, the lines of one key added up as the server adds
// them (a line's discount too: none is 0)
function tally(lines) {
  const out = new Map();
  for (const { key, quantity, price, discount } of lines) {
    const had = out.get(key);
    out.set(key, {
      quantity: roundTo((had?.quantity ?? 0) + Number(quantity), 3),
      price: price === undefined ? null : roundTo(Number(price), 2),
      discount: roundTo((had?.discount ?? 0) + Number(discount ?? 0), 2),
    });
  }
  return out;
}

function same(sent, saved) {
  if (sent.size !== saved.size) return false;
  for (const [key, line] of sent) {
    const other = saved.get(key);
    if (!other || other.quantity !== line.quantity || other.price !== line.price || other.discount !== line.discount) return false;
  }
  return true;
}

// The cart sent ({ items: [{ productId, quantity, mode, discount? }] }) and the sale that came
// back: the same lines, with the same discounts
export const isSaleOf = (body, sale) =>
  same(
    tally(body.items.map((l) => ({ key: `${l.productId}:${l.mode === 'wholesale' ? 'wholesale' : 'retail'}`, quantity: l.quantity, discount: l.discount }))),
    tally((sale?.items ?? []).map((i) => ({ key: `${i.product}:${i.mode}`, quantity: i.quantity, discount: i.discount }))),
  );

// The purchase has the same lines and the same sale price changes as the draft.
export function isPurchaseOf(body, purchase) {
  const saved = purchase?.items ?? [];
  const sameLines = same(
    tally(body.items.map((l) => ({ key: `${l.product}:${l.mode === 'pack' ? 'pack' : 'unit'}`, quantity: l.quantity, price: l.price }))),
    tally(saved.map((i) => ({ key: `${i.product}:${i.mode}`, quantity: i.quantity, price: i.price }))),
  );
  if (!sameLines) return false;

  const byProduct = new Map(saved.map((item) => [String(item.product), item]));
  return body.items.every(({ product, salePrice }) => {
    const item = byProduct.get(String(product));
    if (salePrice == null || salePrice === '') return item.salePrice == null;
    // An explicitly entered price can equal the existing price at the time of purchase.
    return roundTo(Number(salePrice), 2) === (item.salePrice ?? item.prevSalePrice);
  });
}

// The return sent ({ items: [{ line, quantity }], clientId }, lines of the invoice) and the
// invoice that came back, which holds the return recorded under that id
export function isReturnOf(body, sale) {
  const done = sale?.returns?.find((r) => r.clientId === body.clientId);
  if (!done) return false;
  return same(
    tally(body.items.map((r) => ({ key: `${sale.items[r.line]?.product}:${sale.items[r.line]?.mode}`, quantity: r.quantity }))),
    tally(done.items.map((i) => ({ key: `${i.product}:${i.mode}`, quantity: i.quantity }))),
  );
}
