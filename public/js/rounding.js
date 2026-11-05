// Rounds half away from zero on the number as written, not on its binary value: 10.075
// is stored as 10.07499999..., which multiplying by 100 would round down to 10.07.
// lib/util.js and public/js/common.js both import this one function, so the screen and
// the server agree.
export function roundTo(n, digits) {
  const x = Number(n);
  if (!Number.isFinite(x)) return x;
  const written = Math.abs(x).toString();
  const rounded = written.includes('e')
    ? Math.round(Math.abs(x) * 10 ** digits) / 10 ** digits
    : Number(`${Math.round(Number(`${written}e${digits}`))}e-${digits}`);
  return Math.sign(x) * rounded || 0; // || 0: never -0
}

// Up to the shop's smallest note (its «أصغر فئة نقدية», 250 for example): the smallest
// multiple of `step` not below `amount`, so 600 is 750 and 1,200 is 1,250. An amount already
// a multiple stays as it is, binary noise and all (3 x 0.1 x 1000 is 300.00000000000006,
// which up to 100 is 300, not 400). No step (0) leaves the amount as it is.
export function roundUpTo(amount, step) {
  const x = Number(amount);
  if (!step || !Number.isFinite(x)) return x;
  return Math.ceil(roundTo(x / step, 6)) * step || 0; // || 0: never -0
}

// A sale line's amount: its price x quantity to the cent, then the whole line up to the
// step (0: as priced), so 3 x 600 is 2,000 at 250, not 3 x 750. The server prices each line
// with it and the cashier shows the same, for a weight too (0.4 kg x 1,500 = 600, so 750)
// and a wholesale box.
export const lineAmount = (price, quantity, step) => roundUpTo(roundTo(price * quantity, 2), step);
