// The shop's receipt and printing, and its sales and stock defaults (routes/settings.js,
// routes/shop.js, lib/logo.js): a new shop and a settings document from before these
// settings read as the receipt and the product form always were; only the owner changes
// them, and every account reads what the cashier needs to print; each value is checked
// (the logo must really be a small PNG, JPEG or WebP); a default applied to the products
// already there changes that one field of tracked products and nothing else; and a sale
// sent again is marked as such, so the cashier does not print it again by itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { PERMISSION_KEYS } from '../public/js/permissions.js';
import { startTestEnv, addStaff } from './support/harness.js';

let env;
let shop;
let owner;
let cashier;
let supervisor;
before(async () => {
  env = await startTestEnv();
  shop = await env.createShop('settings-shop');
  owner = shop.client;
  cashier = (await addStaff(env, shop, { username: 'cashier', displayName: 'علي', permissions: ['credit', 'returns'] })).client;
  supervisor = (await addStaff(env, shop, { username: 'supervisor', permissions: [...PERMISSION_KEYS] })).client;
});
after(async () => {
  await env?.close();
});

const call = (client, method, path, body) => client.request(method, `/api${path}`, body);
async function ok(client, method, path, body) {
  const res = await call(client, method, path, body);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${res.text}`);
  return res.data;
}
// A refusal: its status and its Arabic message
async function refused(client, method, path, body, status = 400) {
  const res = await call(client, method, path, body);
  assert.strictEqual(res.status, status, `${method} ${path} ${JSON.stringify(body)?.slice(0, 80)} -> ${res.status} ${res.text.slice(0, 120)}`);
  assert.match(res.data.error, /[؀-ۿ]/, 'an Arabic message');
  return res.data;
}

/* Images, made here byte by byte */

const u32be = (n) => Buffer.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u32le = (n) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24]);
const pngChunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  return Buffer.concat([u32be(data.length), body, u32be(crc32(body))]);
};
// A real grey PNG; `comment` bytes of text make it as heavy as needed
function png(width, height, comment = 0) {
  const header = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 0, 0, 0, 0])]);
  const pixels = deflateSync(Buffer.alloc((width + 1) * height));
  const text = comment ? [pngChunk('tEXt', Buffer.concat([Buffer.from('Comment\0'), Buffer.alloc(comment, 0x61)]))] : [];
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), pngChunk('IDAT', pixels), ...text, pngChunk('IEND', Buffer.alloc(0))]);
}
// A JPEG's start, JFIF header, frame header with the size, and end
const jpeg = (width, height) =>
  Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
// A lossless WebP's header with the size
function webp(width, height) {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const payload = Buffer.concat([Buffer.from([0x2f]), u32le(bits), Buffer.alloc(5)]);
  const body = Buffer.concat([Buffer.from('WEBP'), Buffer.from('VP8L'), u32le(payload.length), payload]);
  return Buffer.concat([Buffer.from('RIFF'), u32le(body.length), body]);
}
const dataUrl = (type, bytes) => `data:${type};base64,${bytes.toString('base64')}`;

/* Reading */

const DEFAULTS = {
  receiptPaper: '80',
  receiptShowPhone: true,
  receiptShowAddress: true,
  receiptShowCashier: false,
  autoPrint: false,
  currency: 'د.ع',
  defaultTrackStock: true,
  defaultLowStockAlert: 5,
  defaultBlockWhenOut: false,
};
const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));
const omit = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

test('a new shop prints as before: 80 mm, phone and address shown, no seller, no logo, no printing by itself', async () => {
  const settings = await ok(owner, 'GET', '/settings');
  assert.deepStrictEqual(pick(settings, Object.keys(DEFAULTS)), DEFAULTS);
  assert.deepStrictEqual([settings.receiptLogo, settings.logoVersion, settings.receiptNote], ['', '', '']);
  for (const client of [owner, cashier, supervisor]) {
    const read = await ok(client, 'GET', '/shop');
    assert.deepStrictEqual(pick(read, Object.keys(DEFAULTS)), DEFAULTS);
    assert.strictEqual(read.logoVersion, '');
    assert.ok(!('receiptLogo' in read), 'the logo itself comes from /shop/logo');
    assert.deepStrictEqual(await ok(client, 'GET', '/shop/logo'), { receiptLogo: '' });
  }
});

test('only the owner changes the settings; every account reads what the cashier prints', async () => {
  for (const client of [cashier, supervisor]) {
    for (const [method, path, body] of [
      ['GET', '/settings'],
      ['PUT', '/settings', { autoPrint: true, currency: '$' }],
      ['GET', '/settings/product-defaults'],
      ['POST', '/settings/product-defaults/apply', { field: 'lowStockAlert', value: 5 }],
    ]) {
      const res = await call(client, method, path, body);
      assert.deepStrictEqual([res.status, res.data.code, res.data.error], [403, 'FORBIDDEN', 'هذا الإجراء لصاحب المتجر فقط'], `${method} ${path}`);
    }
  }
  assert.deepStrictEqual(pick(await ok(owner, 'GET', '/settings'), ['autoPrint', 'currency']), { autoPrint: false, currency: 'د.ع' }, 'nothing changed');

  const saved = await ok(owner, 'PUT', '/settings', {
    receiptPaper: '58',
    receiptShowPhone: false,
    receiptShowCashier: true,
    autoPrint: true,
    receiptNote: '  البضاعة المباعة لا ترد بعد 3 أيام  ',
    currency: ' $ ',
  });
  const expected = { receiptPaper: '58', receiptShowPhone: false, receiptShowAddress: true, receiptShowCashier: true, autoPrint: true, receiptNote: 'البضاعة المباعة لا ترد بعد 3 أيام', currency: '$' };
  assert.deepStrictEqual(pick(saved, Object.keys(expected)), expected);
  assert.deepStrictEqual(pick(await ok(cashier, 'GET', '/shop'), Object.keys(expected)), expected);
  // A card sends its own fields: the others stay
  await ok(owner, 'PUT', '/settings', { defaultLowStockAlert: 3 });
  assert.deepStrictEqual(pick(await ok(cashier, 'GET', '/shop'), [...Object.keys(expected), 'defaultLowStockAlert']), { ...expected, defaultLowStockAlert: 3 });
  // Back as a new shop has it, for the tests below
  await ok(owner, 'PUT', '/settings', { ...DEFAULTS, receiptNote: '' });
});

test('each setting is checked, and a refused change changes nothing', async () => {
  const before = await ok(owner, 'GET', '/settings');
  const bad = [
    [{ receiptPaper: 'letter' }, 'مقاس الورق غير صالح'],
    [{ receiptPaper: 80 }, 'مقاس الورق غير صالح'],
    [{ autoPrint: 'yes' }, 'البيانات المرسلة غير صالحة'],
    [{ receiptShowCashier: 1 }, 'البيانات المرسلة غير صالحة'],
    [{ defaultTrackStock: null }, 'البيانات المرسلة غير صالحة'],
    [{ defaultBlockWhenOut: 'true' }, 'البيانات المرسلة غير صالحة'],
    [{ defaultLowStockAlert: -1 }, /حد التنبيه/],
    [{ defaultLowStockAlert: 2.5 }, /حد التنبيه/],
    [{ defaultLowStockAlert: '5' }, /حد التنبيه/],
    [{ defaultLowStockAlert: 100001 }, /حد التنبيه/],
    [{ currency: '' }, 'اكتب العملة، مثل: د.ع'],
    [{ currency: '   ' }, 'اكتب العملة، مثل: د.ع'],
    [{ currency: 'دينار عراقي جديد' }, 'اسم العملة طويل جدًا'],
    [{ currency: 5 }, 'البيانات المرسلة غير صالحة'],
    [{ receiptNote: 'ن'.repeat(121) }, 'ملاحظة الإيصال طويلة جدًا'],
    // One bad field refuses the whole request
    [{ autoPrint: true, receiptPaper: 'a5' }, 'مقاس الورق غير صالح'],
  ];
  for (const [body, message] of bad) {
    const { error } = await refused(owner, 'PUT', '/settings', body);
    if (message instanceof RegExp) assert.match(error, message, JSON.stringify(body));
    else assert.strictEqual(error, message, JSON.stringify(body));
  }
  assert.deepStrictEqual(await ok(owner, 'GET', '/settings'), before);
  // The three papers, and the stock alert at its limits
  for (const receiptPaper of ['a4', '58', '80']) assert.strictEqual((await ok(owner, 'PUT', '/settings', { receiptPaper })).receiptPaper, receiptPaper);
  for (const value of [0, 100000, 5]) assert.strictEqual((await ok(owner, 'PUT', '/settings', { defaultLowStockAlert: value })).defaultLowStockAlert, value);
});

test('the logo: a small PNG, JPEG or WebP that really is one; anything else is refused', async () => {
  const accepted = [
    dataUrl('image/png', png(120, 40)),
    dataUrl('image/png', png(384, 384)),
    dataUrl('image/jpeg', jpeg(384, 100)),
    dataUrl('image/webp', webp(200, 384)),
  ];
  const versions = new Set();
  for (const logo of accepted) {
    const saved = await ok(owner, 'PUT', '/settings', { receiptLogo: logo });
    assert.strictEqual(saved.receiptLogo, logo);
    // Every account gets it for the receipt, and a new tag says it changed
    const { logoVersion } = await ok(cashier, 'GET', '/shop');
    assert.match(logoVersion, /^[\w-]{16}$/);
    assert.strictEqual(logoVersion, saved.logoVersion);
    versions.add(logoVersion);
    assert.deepStrictEqual(await ok(cashier, 'GET', '/shop/logo'), { receiptLogo: logo });
  }
  assert.strictEqual(versions.size, accepted.length);

  // Exactly 64 KB is taken; one byte more is not
  const plain = png(10, 10, 1).length - 1;
  const atLimit = png(10, 10, 64 * 1024 - plain);
  assert.strictEqual(atLimit.length, 64 * 1024);
  await ok(owner, 'PUT', '/settings', { receiptLogo: dataUrl('image/png', atLimit) });
  const kept = await ok(owner, 'GET', '/settings');

  const TYPE = 'الشعار يجب أن يكون صورة PNG أو JPEG أو WebP';
  const NOT_IMAGE = 'ملف الشعار ليس صورة صالحة من النوع الذي يذكره';
  const BIG = 'صورة الشعار كبيرة جدًا. الحد 64 كيلوبايت';
  const SIDE = 'أبعاد الشعار يجب ألا تزيد على 384 × 384 نقطة';
  const bad = [
    [dataUrl('image/png', png(10, 10, 64 * 1024 - plain + 1)), BIG],
    [dataUrl('image/png', png(10, 10, 80 * 1024)), BIG],
    [dataUrl('image/png', png(385, 10)), SIDE],
    [dataUrl('image/jpeg', jpeg(10, 400)), SIDE],
    [dataUrl('image/webp', webp(1000, 50)), SIDE],
    // Another type than it says, or no image at all
    [dataUrl('image/png', jpeg(10, 10)), NOT_IMAGE],
    [dataUrl('image/jpeg', png(10, 10)), NOT_IMAGE],
    [dataUrl('image/webp', Buffer.from('RIFF0000WEBPVP8 nothing here at all')), NOT_IMAGE],
    [dataUrl('image/png', Buffer.from('not a picture, just some text')), NOT_IMAGE],
    [dataUrl('image/png', png(10, 10).subarray(0, 20)), NOT_IMAGE],
    // Not one of the three types, or not a base64 data: URL
    [dataUrl('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), TYPE],
    [dataUrl('image/gif', Buffer.from('GIF89a')), TYPE],
    [dataUrl('text/html', Buffer.from('<b>hi</b>')), TYPE],
    ['https://example.com/logo.png', TYPE],
    [`data:image/png,${png(10, 10).toString('latin1')}`, TYPE],
    [`data:image/png;base64,${png(10, 10).toString('base64')}"><script>`, TYPE],
    [`data:image/png;base64,${png(10, 10).toString('base64').slice(1)}`, TYPE],
    [`data:image/png;base64, ${png(10, 10).toString('base64')}`, TYPE],
  ];
  for (const [logo, message] of bad) assert.strictEqual((await refused(owner, 'PUT', '/settings', { receiptLogo: logo })).error, message, logo.slice(0, 60));
  for (const logo of [5, null, { src: 'x' }]) await refused(owner, 'PUT', '/settings', { receiptLogo: logo });
  assert.deepStrictEqual(await ok(owner, 'GET', '/settings'), kept, 'a refused logo leaves the one there');
  // A body past the JSON limit says so in Arabic
  const huge = await refused(owner, 'PUT', '/settings', { receiptLogo: `data:image/png;base64,${'A'.repeat(300 * 1024)}` }, 413);
  assert.strictEqual(huge.error, 'البيانات المرسلة كبيرة جدًا');

  // '' takes it away
  const removed = await ok(owner, 'PUT', '/settings', { receiptLogo: '' });
  assert.deepStrictEqual([removed.receiptLogo, removed.logoVersion], ['', '']);
  assert.deepStrictEqual(await ok(cashier, 'GET', '/shop/logo'), { receiptLogo: '' });
  assert.strictEqual((await ok(cashier, 'GET', '/shop')).logoVersion, '');
});

test('a default saved for new products leaves the products already there as they are', async () => {
  const general = (await ok(owner, 'GET', '/categories'))[0];
  const made = await ok(owner, 'POST', '/products', { name: 'قبل', barcode: 'DEF-0', category: general._id, purchasePrice: 100, salePrice: 150, trackStock: true, stock: 7 });
  await ok(owner, 'PUT', '/settings', { defaultLowStockAlert: 12, defaultBlockWhenOut: true, defaultTrackStock: false });
  const after = await ok(owner, 'GET', '/products/barcode/DEF-0');
  assert.deepStrictEqual(pick(after, ['lowStockAlert', 'blockWhenOut', 'trackStock', 'stock', 'updatedAt']), pick(made, ['lowStockAlert', 'blockWhenOut', 'trackStock', 'stock', 'updatedAt']));
  // The product form starts with them: the server keeps whatever a new product is sent
  const fresh = await ok(owner, 'POST', '/products', { name: 'بعد', barcode: 'DEF-00', category: general._id, purchasePrice: 100, salePrice: 150, trackStock: false, lowStockAlert: 12, blockWhenOut: true });
  assert.deepStrictEqual(pick(fresh, ['trackStock', 'lowStockAlert', 'blockWhenOut']), { trackStock: false, lowStockAlert: 12, blockWhenOut: true });
  await ok(owner, 'PUT', '/settings', { defaultLowStockAlert: 5, defaultBlockWhenOut: false, defaultTrackStock: true });
  await ok(owner, 'DELETE', `/products/${made._id}`);
  await ok(owner, 'DELETE', `/products/${fresh._id}`);
});

test('applying a default to the products already there: tracked ones only, that field only', async () => {
  const general = (await ok(owner, 'GET', '/categories'))[0];
  const add = (body) => ok(owner, 'POST', '/products', { category: general._id, purchasePrice: 100, salePrice: 150, ...body });
  const products = {
    a: await add({ name: 'أ', barcode: 'APPLY-A', trackStock: true, stock: 10 }),
    b: await add({ name: 'ب', barcode: 'APPLY-B', trackStock: true, stock: 4, lowStockAlert: 3, blockWhenOut: true }),
    kg: await add({ name: 'رز', barcode: 'APPLY-KG', unit: 'kg', trackStock: true, stock: 2.5, lowStockAlert: 1.5, purchasePrice: 1000, salePrice: 1250 }),
    untracked: await add({ name: 'خدمة', barcode: 'APPLY-U', trackStock: false, lowStockAlert: 5 }),
    old: await add({ name: 'قديم', barcode: 'APPLY-OLD', trackStock: true, stock: 1 }),
  };
  // A product from before the fields existed: neither is stored, and it reads as 5 and off
  await shop.db.collection('products').updateOne({ barcode: 'APPLY-OLD' }, { $unset: { lowStockAlert: 1, blockWhenOut: 1 } });
  // The products as stored, by key
  const stored = async () => Object.fromEntries(await Promise.all(Object.entries(products).map(async ([key, p]) => [key, await shop.db.collection('products').findOne({ barcode: p.barcode })])));
  const before = await stored();

  // Saved at 5 and off, as a new shop: a product without the field already has them
  let counts = await ok(owner, 'GET', '/settings/product-defaults');
  assert.deepStrictEqual(counts, { tracked: 4, lowStockAlert: { value: 5, toChange: 2 }, blockWhenOut: { value: false, toChange: 1 } });

  // The page sends the value it shows: one saved meanwhile elsewhere is refused, nothing changes
  await ok(owner, 'PUT', '/settings', { defaultLowStockAlert: 10 });
  const stale = await refused(owner, 'POST', '/settings/product-defaults/apply', { field: 'lowStockAlert', value: 5 }, 409);
  assert.deepStrictEqual([stale.code, stale.error], ['SETTING_CHANGED', 'تغيّرت قيمة «حد التنبيه» المحفوظة من مكان آخر. حدّث الصفحة ثم أعد المحاولة']);
  for (const body of [{}, { field: 'stock', value: 0 }, { field: 'salePrice', value: 1 }, { field: '__proto__', value: 10 }, { field: 'lowStockAlert', value: '10' }]) {
    await refused(owner, 'POST', '/settings/product-defaults/apply', body, body.field === 'lowStockAlert' ? 409 : 400);
  }
  assert.deepStrictEqual(await stored(), before, 'nothing changed yet');

  counts = await ok(owner, 'GET', '/settings/product-defaults');
  assert.deepStrictEqual(counts.lowStockAlert, { value: 10, toChange: 4 });
  assert.deepStrictEqual(await ok(owner, 'POST', '/settings/product-defaults/apply', { field: 'lowStockAlert', value: 10 }), { field: 'lowStockAlert', value: 10, changed: 4 });
  let now = await stored();
  for (const key of ['a', 'b', 'kg', 'old']) {
    assert.strictEqual(now[key].lowStockAlert, 10, key);
    // Nothing else: the stock, the prices, the other default, the unit
    assert.deepStrictEqual(omit(now[key], ['lowStockAlert', 'updatedAt']), omit(before[key], ['lowStockAlert', 'updatedAt']), key);
  }
  assert.deepStrictEqual(now.untracked, before.untracked, 'a product whose stock is not tracked is left alone');
  // Once more: nothing left to change
  assert.strictEqual((await ok(owner, 'POST', '/settings/product-defaults/apply', { field: 'lowStockAlert', value: 10 })).changed, 0);

  // Selling stops at none left, on every tracked product
  await ok(owner, 'PUT', '/settings', { defaultBlockWhenOut: true });
  assert.deepStrictEqual((await ok(owner, 'GET', '/settings/product-defaults')).blockWhenOut, { value: true, toChange: 3 });
  assert.strictEqual((await ok(owner, 'POST', '/settings/product-defaults/apply', { field: 'blockWhenOut', value: true })).changed, 3);
  now = await stored();
  for (const key of ['a', 'b', 'kg', 'old']) assert.deepStrictEqual([now[key].blockWhenOut, now[key].stock, now[key].salePrice, now[key].lowStockAlert], [true, before[key].stock, before[key].salePrice, 10], key);
  assert.deepStrictEqual(now.untracked, before.untracked);
  // and the sale is refused past the stock, as for a product set so by hand
  const over = await refused(owner, 'POST', '/sales', { items: [{ productId: products.old._id, quantity: 2 }] }, 409);
  assert.match(over.error, /قديم/);

  await ok(owner, 'PUT', '/settings', { defaultLowStockAlert: 5, defaultBlockWhenOut: false });
  for (const p of Object.values(products)) await ok(owner, 'DELETE', `/products/${p._id}`);
});

test('a sale sent again is marked repeated and recorded once, with the seller from the session', async () => {
  const general = (await ok(owner, 'GET', '/categories'))[0];
  const product = await ok(owner, 'POST', '/products', { name: 'عصير', barcode: 'REPEAT-1', category: general._id, purchasePrice: 500, salePrice: 750 });
  const body = { items: [{ productId: product._id, quantity: 2 }], clientId: 'cart-repeat-print-01' };
  const first = await call(cashier, 'POST', '/sales', body);
  const again = await call(cashier, 'POST', '/sales', body);
  assert.deepStrictEqual([first.status, again.status], [201, 200]);
  assert.ok(!('repeated' in first.data), 'a new sale is not marked');
  assert.deepStrictEqual([again.data.repeated, again.data.number, again.data.total], [true, first.data.number, 1500]);
  // What the receipt shows as the seller, from the session
  assert.strictEqual(first.data.madeBy.name, 'علي');
  // No more than one invoice
  const { sales } = await ok(owner, 'GET', `/sales?from=${new Date(Date.now() - 864e5).toISOString()}&to=${new Date(Date.now() + 864e5).toISOString()}`);
  assert.strictEqual(sales.filter((s) => s.clientId === body.clientId).length, 1);
});

test('a settings document from before these settings reads as the receipt always was, and saves', async () => {
  await ok(owner, 'PUT', '/settings', { receiptNote: 'أهلًا', phone: '07700000000' });
  const fields = [...Object.keys(DEFAULTS).filter((key) => key !== 'currency'), 'receiptLogo'];
  await shop.db.collection('settings').updateOne({ _id: 'shop' }, { $unset: Object.fromEntries(fields.map((key) => [key, 1])) });
  const doc = await shop.db.collection('settings').findOne({ _id: 'shop' });
  assert.ok(fields.every((key) => !(key in doc)));

  const read = await ok(cashier, 'GET', '/shop');
  assert.deepStrictEqual(pick(read, Object.keys(DEFAULTS)), DEFAULTS);
  assert.deepStrictEqual([read.receiptNote, read.phone, read.logoVersion], ['أهلًا', '07700000000', '']);
  assert.deepStrictEqual(await ok(cashier, 'GET', '/shop/logo'), { receiptLogo: '' });
  assert.deepStrictEqual(pick(await ok(owner, 'GET', '/settings'), Object.keys(DEFAULTS)), DEFAULTS);
  assert.deepStrictEqual((await ok(owner, 'GET', '/settings/product-defaults')).lowStockAlert.value, 5);
  // One field saved; the rest still read as before
  const saved = await ok(owner, 'PUT', '/settings', { autoPrint: true });
  assert.deepStrictEqual(pick(saved, Object.keys(DEFAULTS)), { ...DEFAULTS, autoPrint: true });
  await ok(owner, 'PUT', '/settings', { autoPrint: false });
});
