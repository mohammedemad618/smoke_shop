// EAN-13 helpers, shared by the products page and the seed script.

export function ean13(base12) {
  const sum = [...base12].reduce((acc, digit, i) => acc + Number(digit) * (i % 2 ? 3 : 1), 0);
  return base12 + ((10 - (sum % 10)) % 10);
}

// Prefix 200 is the GS1 range reserved for in-store codes, so it never
// collides with a manufacturer's barcode.
export function randomStoreBarcode() {
  let digits = '200';
  while (digits.length < 12) digits += Math.floor(Math.random() * 10);
  return ean13(digits);
}
