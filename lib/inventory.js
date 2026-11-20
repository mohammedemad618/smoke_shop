import { httpError } from './errors.js';
import { roundQty } from './util.js';
import { lotPortion } from '../public/js/stock-cost.js';

// The app runs one server process. Serialize inventory writes per shop while the stock
// and its invoice or stocktake are being saved on standalone MongoDB.
const pendingWrites = new WeakMap();

export function inventoryWrite(handler) {
  return async (req, res) => {
    const { Product } = req.models;
    const previous = pendingWrites.get(Product);
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    pendingWrites.set(Product, current);
    await previous;
    try {
      return await handler(req, res);
    } finally {
      release();
      if (pendingWrites.get(Product) === current) pendingWrites.delete(Product);
    }
  };
}

export function inventoryOf(product) {
  const stock = product.stock ?? 0;
  const opening = stock > 0 ? [{ order: 0, quantity: stock, unitCost: product.purchasePrice }] : [];
  return {
    stock,
    stockLots: product.trackStock ? (product.stockLots ?? opening).map((lot) => ({ ...lot })) : [],
    lotSequence: product.lotSequence ?? 0,
  };
}

export function takeStock(inventory, quantity, unitCost) {
  const used = lotPortion(inventory.stockLots, quantity);
  const byOrder = new Map(used.map((lot) => [lot.order, lot.quantity]));
  for (const lot of inventory.stockLots) lot.quantity = roundQty(lot.quantity - (byOrder.get(lot.order) ?? 0));
  inventory.stockLots = inventory.stockLots.filter((lot) => lot.quantity > 0);
  inventory.stock = roundQty(inventory.stock - quantity);

  // A product may be sold past zero. The uncovered quantity keeps its cost on the sale.
  const missing = roundQty(quantity - used.reduce((sum, lot) => sum + lot.quantity, 0));
  if (missing > 0) used.push({ quantity: missing, unitCost });
  return used;
}

export function addStock(inventory, quantity, unitCost, order) {
  const lotOrder = order ?? inventory.lotSequence + 1;
  inventory.lotSequence = Math.max(inventory.lotSequence, lotOrder);
  const before = Math.max(0, inventory.stock);
  inventory.stock = roundQty(inventory.stock + quantity);
  const onHand = roundQty(Math.max(0, inventory.stock) - before);
  if (onHand > 0) {
    const lot = inventory.stockLots.find((lot) => lot.order === lotOrder);
    if (lot) lot.quantity = roundQty(lot.quantity + onHand);
    else {
      inventory.stockLots.push({ order: lotOrder, quantity: onHand, unitCost });
      inventory.stockLots.sort((a, b) => a.order - b.order);
    }
  }
  return lotOrder;
}

export function removeStockLot(inventory, order, quantity, name) {
  if (quantity === 0) return;
  const lot = inventory.stockLots.find((lot) => lot.order === order);
  if (!lot || lot.quantity < quantity) {
    throw httpError(409, `تعذّر إلغاء الفاتورة. الكمية المتبقية من دفعة «${name}» لا تكفي.`, 'STOCK_LOT_USED');
  }
  lot.quantity = roundQty(lot.quantity - quantity);
  inventory.stockLots = inventory.stockLots.filter((lot) => lot.quantity > 0);
  inventory.stock = roundQty(inventory.stock - quantity);
}

// Restore the previous values if a write or the associated invoice fails. The caller
// holds the inventory lock until the invoice and its stock have been saved or restored.
export async function commitInventory(Product, changes) {
  const update = (product, fields) => ({ updateOne: { filter: { _id: product._id }, update: fields } });
  const undo = async () => {
    if (!changes.length) return;
    await Product.bulkWrite(changes.map(({ product, set }) => {
      const previous = {};
      const absent = {};
      for (const field of Object.keys(set)) {
        if (product[field] === undefined) absent[field] = 1;
        else previous[field] = product[field];
      }
      return update(product, { $set: previous, ...(Object.keys(absent).length ? { $unset: absent } : {}) });
    }));
  };
  if (!changes.length) return undo;
  try {
    const result = await Product.bulkWrite(changes.map(({ product, set }) => update(product, { $set: set })));
    if (result.matchedCount !== changes.length) throw httpError(409, 'تغيّرت قائمة المنتجات. حدّث الصفحة وأعد المحاولة');
  } catch (err) {
    await undo();
    throw err;
  }
  return undo;
}
