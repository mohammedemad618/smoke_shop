import { roundTo } from './rounding.js';

const qty = (value) => roundTo(value, 3);

// Read a span of base units (pieces or kilos) in the order they were allocated.
export function lotPortion(lots, quantity, skip = 0) {
  const portion = [];
  for (const lot of lots) {
    if (quantity <= 0) break;
    const skipped = Math.min(skip, lot.quantity);
    skip = qty(skip - skipped);
    const used = qty(Math.min(quantity, lot.quantity - skipped));
    if (used <= 0) continue;
    portion.push({ ...lot, quantity: used });
    quantity = qty(quantity - used);
  }
  return portion;
}

export const lotCost = (lots) => lots.reduce((cost, lot) => cost + lot.quantity * lot.unitCost, 0);

// Products with untracked or not yet itemized stock use the saved purchase price.
export function estimatedStockCost(product, quantity, skip = 0) {
  const portion = lotPortion(product.trackStock ? product.stockLots ?? [] : [], qty(quantity), qty(skip));
  const missing = qty(quantity - portion.reduce((total, lot) => total + lot.quantity, 0));
  return roundTo(lotCost(portion) + missing * product.purchasePrice, 2);
}
