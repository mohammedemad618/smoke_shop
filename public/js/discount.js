// A discount on a sale line (the «الخصم» permission, public/js/permissions.js): a money
// amount off the whole line, never taking the line below what its goods cost. One copy for
// the server (routes/sales.js) and the pages (the cashier, the returns of the sales page),
// so the screen helps by the server's own rule; the server alone decides. No side effects
// on import.
import { roundTo, roundUpTo } from './rounding.js';

// Whether `amount` is a multiple of the shop's «أصغر فئة نقدية» (always, when it does not
// round), so a line rounded up to it stays a multiple after its discount
export const fitsStep = (amount, step) => !step || Number.isInteger(roundTo(amount / step, 6));

// The most a line may take off: its amount before the discount (price x quantity, up to the
// step) less what its goods cost, down to a multiple of the step when the shop rounds; 0 for
// a line sold at or below its cost. 750 costing 300 may take 450 off, or 250 at a step of 250.
export function maxDiscount(amount, cost, step) {
  const room = roundTo(amount - cost, 2);
  if (!(room > 0)) return 0;
  return step ? Math.floor(roundTo(room / step, 6)) * step : room;
}

// What a line of a sale made at `step` is still worth with `left` of it kept: all it was sold
// for when all of it is, nothing when none is, and otherwise its price for what is left less
// the same share of its discount, rounded up as the line was sold. Without a discount that is
// lineAmount(unitPrice, left, step). A partial return gives back the difference between this
// before and after: 3 x 600 sold for 2,000 at 250 with 250 off (1,750), one back leaves
// 1,200 - 166.67 = 1,033.33, so 1,250, and 500 comes back.
export const keptAmount = (item, left, step) =>
  left >= item.quantity
    ? item.lineTotal
    : left > 0
      ? roundUpTo(roundTo(item.unitPrice * left - ((item.discount ?? 0) * left) / item.quantity, 2), step)
      : 0;
