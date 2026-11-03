// A sale, a purchase or a return is sent with an id (clientId) so that sending it again after
// a lost answer records it once (lib/idempotency.js). For an id it knows already, the server
// answers with what it recorded then, whatever the request holds now. These say whether that
// record is what the page sent, or one recorded earlier under the same id from another cart
// or draft: a cart changed after a try whose answer was lost, a tab duplicated with its
// cart, a purchase draft saved from two tabs. The page then keeps what it has, gives it a
// new id and says so, instead of taking the old record for it. No side effects on import,
// so the tests can run it.
import { roundTo } from './rounding.js';

// key -> { quantity, price }, the lines of one key added up as the server adds them
function tally(lines) {
  const out = new Map();
  for (const { key, quantity, price } of lines) {
    const had = out.get(key)?.quantity ?? 0;
    out.set(key, { quantity: roundTo(had + Number(quantity), 3), price: price === undefined ? null : roundTo(Number(price), 2) });
  }
  return out;
}

function same(sent, saved) {
  if (sent.size !== saved.size) return false;
  for (const [key, line] of sent) {
    const other = saved.get(key);
    if (!other || other.quantity !== line.quantity || other.price !== line.price) return false;
  }
  return true;
}

// The cart sent ({ items: [{ productId, quantity, mode }] }) and the sale that came back
export const isSaleOf = (body, sale) =>
  same(
    tally(body.items.map((l) => ({ key: `${l.productId}:${l.mode === 'wholesale' ? 'wholesale' : 'retail'}`, quantity: l.quantity }))),
    tally((sale?.items ?? []).map((i) => ({ key: `${i.product}:${i.mode}`, quantity: i.quantity }))),
  );

// The draft sent ({ items: [{ product, mode, quantity, price }] }) and the purchase that came back
export const isPurchaseOf = (body, purchase) =>
  same(
    tally(body.items.map((l) => ({ key: `${l.product}:${l.mode === 'pack' ? 'pack' : 'unit'}`, quantity: l.quantity, price: l.price }))),
    tally((purchase?.items ?? []).map((i) => ({ key: `${i.product}:${i.mode}`, quantity: i.quantity, price: i.price }))),
  );

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
