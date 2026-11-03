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
