// The demo shop's restaurant (scripts/demo-shop.js): a small grill restaurant in Baghdad,
// with every name made up. Prices are Iraqi dinars at Baghdad 2026 levels. A dish is made to
// order, so its stock is not tracked and its purchase price is the estimated cost of its
// ingredients (a food cost of 30-45%); packaged drinks and the ice cream come from suppliers
// by invoice and are tracked. Plain data and one pure function (the logo); no side effects
// on import.
import { deflateSync, crc32 } from 'node:zlib';
import { ean13 } from '../public/js/barcode.js';

export const DEMO_TIME_ZONE = 'Asia/Baghdad';
export const DEMO_SHOP_NAME = 'مطعم ومشويات النخيل';
// The admin's own name for the shop (its label in the admin panel)
export const DEMO_LABEL = 'متجر عرض - مطعم';
// The owner's name on the invoices he makes, since the owner's account is never edited later
export const DEMO_OWNER_NAME = 'المدير';

// What the owner sets on the settings page on the first morning. An obviously unreal phone.
export const DEMO_SETTINGS = Object.freeze({
  phone: '0770 000 0000',
  address: 'بغداد - شارع المطاعم، قرب الساحة',
  receiptNote: 'شكرًا لزيارتكم، بالعافية. الطلبات الخارجية على الرقم أعلاه',
  timeZone: DEMO_TIME_ZONE,
  currency: 'د.ع',
  receiptPaper: '80',
  receiptShowPhone: true,
  receiptShowAddress: true,
  receiptShowCashier: true,
  autoPrint: false,
  // Most new items of a restaurant are dishes, whose quantity is not counted
  defaultTrackStock: false,
  defaultLowStockAlert: 12,
  defaultBlockWhenOut: false,
  // The history is priced as is: a reset after the owner turned rounding on starts it off again
  roundingStep: 0,
});

/*
 * The menu, by category in the order the owner adds them. Each item: key (the plan's own
 * name for it), name, code (a dish's short menu number, typed at the cashier; a packaged
 * drink gets an EAN-13 code below), unit, cost (purchase price per piece or kilo), price.
 * Tracked items also have: alert (the low-stock line), carton (how many come in a
 * supplier's carton) and supplier. A restaurant sells them one at a time: no wholesale pack.
 */
const MENU = [
  ['المشويات', [
    { key: 'kebabKg', name: 'كباب لحم (كيلو)', code: '101', unit: 'kg', cost: 11000, price: 28000 },
    { key: 'tikkaKg', name: 'تكة لحم (كيلو)', code: '102', unit: 'kg', cost: 12000, price: 30000 },
    { key: 'chickenTikkaKg', name: 'تكة دجاج (كيلو)', code: '103', unit: 'kg', cost: 6600, price: 18000 },
    { key: 'chickenKebabKg', name: 'كباب دجاج (كيلو)', code: '104', unit: 'kg', cost: 5900, price: 16000 },
    { key: 'kebabSkewer', name: 'شيش كباب لحم', code: '105', cost: 1150, price: 3000 },
    { key: 'tikkaSkewer', name: 'شيش تكة لحم', code: '106', cost: 1350, price: 3500 },
    { key: 'chickenSkewer', name: 'شيش تكة دجاج', code: '107', cost: 820, price: 2250 },
    { key: 'liver', name: 'معلاق مشوي (نفر)', code: '108', cost: 2300, price: 6000 },
    { key: 'mixedGrill', name: 'مشويات مشكلة (نفر)', code: '109', cost: 6400, price: 16000 },
  ]],
  ['الدجاج', [
    { key: 'halfChicken', name: 'نصف دجاجة مشوية', code: '201', cost: 2750, price: 7000 },
    { key: 'wholeChicken', name: 'دجاجة مشوية كاملة', code: '202', cost: 5200, price: 13000 },
    { key: 'broasted4', name: 'بروستد 4 قطع', code: '203', cost: 2900, price: 7500 },
    { key: 'broasted8', name: 'بروستد 8 قطع', code: '204', cost: 5500, price: 14000 },
  ]],
  ['السندويشات', [
    { key: 'shawarmaMeat', name: 'لفة شاورما لحم', code: '301', cost: 1350, price: 3500 },
    { key: 'shawarmaChicken', name: 'لفة شاورما دجاج', code: '302', cost: 1100, price: 3000 },
    { key: 'kebabSandwich', name: 'صمونة كباب', code: '303', cost: 900, price: 2500 },
    { key: 'tikkaSandwich', name: 'صمونة تكة دجاج', code: '304', cost: 880, price: 2500 },
    { key: 'falafel', name: 'لفة فلافل', code: '305', cost: 330, price: 1000 },
    { key: 'burger', name: 'برغر لحم', code: '306', cost: 1750, price: 4500 },
    { key: 'crispy', name: 'برغر دجاج كرسبي', code: '307', cost: 1500, price: 4000 },
  ]],
  ['الأكلات', [
    { key: 'beans', name: 'تمن ومرق فاصوليا', code: '401', cost: 1750, price: 5000 },
    { key: 'okra', name: 'تمن ومرق باميا', code: '402', cost: 2000, price: 5500 },
    { key: 'quzi', name: 'قوزي على تمن', code: '403', cost: 6300, price: 15000 },
    { key: 'biryaniChicken', name: 'برياني دجاج', code: '404', cost: 2650, price: 7000 },
    { key: 'biryaniMeat', name: 'برياني لحم', code: '405', cost: 3600, price: 9000 },
    { key: 'dolma', name: 'دولمة (نفر)', code: '406', cost: 2250, price: 6000 },
    { key: 'tashreeb', name: 'تشريب دجاج', code: '407', cost: 2150, price: 6000 },
  ]],
  ['المقبلات والسلطات', [
    { key: 'hummus', name: 'حمص', code: '501', cost: 620, price: 2000 },
    { key: 'mutabbal', name: 'متبل', code: '502', cost: 650, price: 2000 },
    { key: 'salad', name: 'سلطة خضراء', code: '503', cost: 480, price: 1500 },
    { key: 'fattoush', name: 'فتوش', code: '504', cost: 820, price: 2500 },
    { key: 'tabbouleh', name: 'تبولة', code: '505', cost: 850, price: 2500 },
    { key: 'fries', name: 'بطاطا مقلية', code: '506', cost: 640, price: 2000 },
    { key: 'lentilSoup', name: 'شوربة عدس', code: '507', cost: 420, price: 1500 },
    { key: 'kubba', name: 'كبة حلب (قطعة)', code: '508', cost: 380, price: 1000 },
    { key: 'pickles', name: 'طرشي', code: '509', cost: 160, price: 500 },
  ]],
  ['الخبز', [
    { key: 'samoon', name: 'صمون حجري', code: '601', cost: 95, price: 250 },
    { key: 'tannour', name: 'خبز تنور', code: '602', cost: 190, price: 500 },
  ]],
  ['المشروبات الساخنة', [
    { key: 'tea', name: 'شاي', code: '701', cost: 110, price: 500 },
    { key: 'limeTea', name: 'شاي نومي بصرة', code: '702', cost: 170, price: 750 },
    { key: 'coffee', name: 'قهوة', code: '703', cost: 420, price: 1500 },
  ]],
  ['المشروبات الباردة', [
    { key: 'water', name: 'ماء 500 مل', unit: 'piece', cost: 200, price: 500, alert: 24, carton: 12, supplier: 'water' },
    { key: 'waterLarge', name: 'ماء 1.5 لتر', cost: 375, price: 1000, alert: 12, carton: 6, supplier: 'water' },
    { key: 'cola', name: 'مشروب غازي كولا علبة 330 مل', cost: 450, price: 1000, alert: 24, carton: 24, supplier: 'soda' },
    { key: 'orangeSoda', name: 'مشروب غازي برتقال علبة 330 مل', cost: 450, price: 1000, alert: 24, carton: 24, supplier: 'soda' },
    { key: 'lemonSoda', name: 'مشروب غازي ليمون علبة 330 مل', cost: 450, price: 1000, alert: 24, carton: 24, supplier: 'soda' },
    { key: 'colaFamily', name: 'مشروب غازي كولا 1.25 لتر', cost: 1000, price: 2000, alert: 6, carton: 6, supplier: 'soda' },
    { key: 'orangeJuice', name: 'عصير برتقال علبة 250 مل', cost: 375, price: 750, alert: 12, carton: 24, supplier: 'water' },
    { key: 'mangoJuice', name: 'عصير مانجو علبة 250 مل', cost: 375, price: 750, alert: 12, carton: 24, supplier: 'water' },
    { key: 'laban', name: 'لبن (شنينة) 250 مل', cost: 350, price: 750, alert: 12, carton: 12, supplier: 'dairy' },
    { key: 'freshOrange', name: 'عصير برتقال طازج', code: '801', cost: 900, price: 2500 },
    { key: 'lemonMint', name: 'ليمون بالنعناع', code: '802', cost: 620, price: 2000 },
  ]],
  ['الحلويات', [
    { key: 'kunafa', name: 'كنافة', code: '901', cost: 1150, price: 3000 },
    { key: 'custard', name: 'كاسترد', code: '902', cost: 520, price: 1500 },
    { key: 'iceCream', name: 'آيس كريم كوب', cost: 550, price: 1000, alert: 10, carton: 24, supplier: 'dairy' },
  ]],
];

// Internal EAN-13 codes (GS1 prefix 200, in-store) for the packaged items, as scripts/seed.js makes them
let serial = 0;
export const CATEGORIES = Object.freeze(MENU.map(([name]) => name));
export const PRODUCTS = Object.freeze(
  MENU.flatMap(([category, items]) =>
    items.map((item) =>
      Object.freeze({
        unit: 'piece',
        ...item,
        category,
        tracked: Boolean(item.supplier),
        code: item.code ?? ean13(`20026${String(++serial).padStart(7, '0')}`),
      }),
    ),
  ),
);
export const PRODUCT = Object.freeze(Object.fromEntries(PRODUCTS.map((p) => [p.key, p])));

// Who supplies the packaged items, and how the restaurant pays each one (services/demo-plan.js)
export const SUPPLIERS = Object.freeze({
  soda: { name: 'موزّع المشروبات الغازية', reference: 'G' },
  water: { name: 'مذخر الماء والعصائر', reference: 'M' },
  dairy: { name: 'معمل الألبان والمثلجات', reference: 'L' },
});

// The staff the owner adds on the first morning (permissions as the staff card's quick
// choices: «كاشير» and «مشرف»). The evening cashier leaves half way through the history and
// his account is disabled, so his invoices keep his name.
export const STAFF = Object.freeze({
  ali: { username: 'ali', displayName: 'علي حسين', preset: 'cashier' },
  haider: { username: 'haider', displayName: 'حيدر جاسم', preset: 'cashier' },
  mustafa: { username: 'mustafa', displayName: 'مصطفى كريم', preset: 'supervisor' },
});

// The customers who buy on account: nearby offices and regulars. Phones are obviously unreal.
export const CUSTOMERS = Object.freeze({
  office: { name: 'مكتب المحاسبة - الطابق الثاني', phone: '0770 000 0101', note: 'غداء الموظفين، يسدد أول كل شهر' },
  mobiles: { name: 'أبو حسن - محل الموبايلات', phone: '0771 000 0102', note: '' },
  garage: { name: 'ورشة تصليح السيارات المقابلة', phone: '0780 000 0103', note: 'يسدد كل خميس' },
  family: { name: 'أم علي - طلبات البيت', phone: '0790 000 0104', note: 'تدفع مقدمًا' },
  teacher: { name: 'الأستاذ كريم', phone: '0750 000 0105', note: '' },
});

/*
 * The receipt's logo: a palm tree on a dark round badge, drawn here as a 160 x 160 PNG
 * (grey and alpha) with node:zlib, so it needs no file and no image library. Black and white,
 * as a receipt printer prints it. Returns a data: URL that lib/logo.js accepts. Drawn once
 * per size: every plan sends it.
 */
const logos = new Map();
export function demoLogo(size = 160) {
  if (!logos.has(size)) logos.set(size, drawLogo(size));
  return logos.get(size);
}

function drawLogo(size) {
  const inBadge = (x, y) => x * x + y * y <= 0.93;
  const ring = (x, y) => {
    const r = Math.hypot(x, y);
    return r > 0.84 && r < 0.88;
  };
  // A frond: a leaf that leaves the crown in its direction and bends down towards its tip,
  // widest in its middle. Each is drawn as points along its curve.
  const crown = [0.02, -0.22];
  const fronds = [-165, -128, -95, -62, -22, 12, 168].map((deg) => {
    const a = (deg * Math.PI) / 180;
    const dir = [Math.cos(a), Math.sin(a)];
    const length = 0.42 + 0.08 * Math.abs(dir[0]);
    return Array.from({ length: 28 }, (_, i) => {
      const t = (i + 0.5) / 28;
      return [crown[0] + dir[0] * length * t, crown[1] + dir[1] * length * t + 0.3 * Math.abs(dir[0]) * t * t, 0.012 + 0.06 * Math.sin(Math.PI * t) * (1 - 0.35 * t)];
    });
  });
  const frond = (x, y) => fronds.some((points) => points.some(([px, py, w]) => (x - px) ** 2 + (y - py) ** 2 <= w * w));
  // A bunch of dates under the crown
  const dates = [[-0.05, -0.12], [0.06, -0.11], [0.0, -0.06]];
  const date = (x, y) => dates.some(([cx, cy]) => (x - cx) ** 2 + (y - cy) ** 2 <= 0.036 ** 2);
  // The trunk leans a little, and narrows towards the crown
  const trunk = (x, y) => {
    if (y < crown[1] || y > 0.6) return false;
    const t = (y - crown[1]) / (0.6 - crown[1]);
    const middle = crown[0] - 0.08 * t * t;
    return Math.abs(x - middle) <= 0.035 + 0.035 * t;
  };
  const ground = (x, y) => y > 0.58 && y < 0.66 && Math.abs(x) < 0.5 - (y - 0.58) * 2;
  const white = (x, y) => ring(x, y) || frond(x, y) || date(x, y) || trunk(x, y) || ground(x, y);

  // Four samples a side per pixel, for smooth edges
  const S = 4;
  const raw = Buffer.alloc(size * (1 + size * 2));
  for (let py = 0; py < size; py++) {
    const row = py * (1 + size * 2);
    raw[row] = 0; // no filter
    for (let px = 0; px < size; px++) {
      let cover = 0;
      let light = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = ((px + (sx + 0.5) / S) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / S) / size) * 2 - 1;
          if (!inBadge(x, y)) continue;
          cover++;
          if (white(x, y)) light++;
        }
      }
      const at = row + 1 + px * 2;
      raw[at] = cover ? Math.round(28 + (227 * light) / cover) : 0;
      raw[at + 1] = Math.round((255 * cover) / (S * S));
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits per sample
  ihdr[9] = 4; // grey and alpha
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
