// One rounding function for the server and the browser (public/js/common.js imports it
// too), so the screen and the server agree
import { roundTo, roundUpTo, lineAmount } from '../public/js/rounding.js';

export { roundTo, roundUpTo, lineAmount };

// Money to the cent, so totals like 0.1 + 0.2 don't drift
export const money = (n) => roundTo(n, 2);

// Unit costs keep more decimals than money, so a box price shared over its pieces adds
// back up to the box price (10,000 for 24 pieces is 416.666667 a piece, not 416.67)
export const precise = (n) => roundTo(n, 6);

// Weights are kept to the gram
export const roundQty = (n) => roundTo(n, 3);

// A stock change as an update pipeline that rounds to the gram, so weights never drift
// (9.667 kg + 3 x 0.111 kg is 10, not 10.000000000000002). `set` adds other fields.
// updateOne needs { updatePipeline: true } to accept it; bulkWrite takes it as is.
export const stockChange = (delta, set = {}) => [
  { $set: { ...set, stock: { $round: [{ $add: [{ $ifNull: ['$stock', 0] }, delta] }, 3] } } },
];

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
