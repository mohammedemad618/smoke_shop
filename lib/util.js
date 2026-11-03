// Rounds half away from zero on the number as written, not on its binary value: 10.075
// is stored as 10.07499999..., which multiplying by 100 would round down to 10.07.
// The same function is in public/js/common.js, so the screen and the server agree.
export function roundTo(n, digits) {
  const x = Number(n);
  if (!Number.isFinite(x)) return x;
  const written = Math.abs(x).toString();
  const rounded = written.includes('e')
    ? Math.round(Math.abs(x) * 10 ** digits) / 10 ** digits
    : Number(`${Math.round(Number(`${written}e${digits}`))}e-${digits}`);
  return Math.sign(x) * rounded || 0; // || 0: never -0
}

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
