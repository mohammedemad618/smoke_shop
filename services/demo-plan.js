// The demo shop's history as a plan: every request its owner and staff would have sent
// over `days` days, in the order they sent them, each with the moment it was sent
// (services/demo-shop.js sends them to the app, then moves each record to its moment). A
// pure function of the seed, the number of days and the time it is made for: the same seed
// on the same day gives the same history, and nothing is planned after `now`. Days are cut
// in the shop's time zone (Asia/Baghdad). No side effects on import.
import { roundTo } from '../public/js/rounding.js';
import { PRESETS } from '../public/js/permissions.js';
import { CATEGORIES, CUSTOMERS, DEMO_SETTINGS, DEMO_TIME_ZONE, PRODUCT, PRODUCTS, STAFF, SUPPLIERS, demoLogo } from './demo-data.js';

export const DEFAULT_SEED = 2026;
export const DEFAULT_DAYS = 90;
export const MIN_DAYS = 7;
export const MAX_DAYS = 365;
const MINUTE = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE;
// Nothing is planned in the last minute before the plan is made: every moment is in the
// past by the time its record is written
export const CUTOFF_MS = MINUTE;

const money = (n) => roundTo(n, 2);
const pad = (n) => String(n).padStart(2, '0');

/* Time in the shop's time zone */

const formats = new Map();
function partsOf(timeZone, ms) {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formats.set(timeZone, format);
  }
  return Object.fromEntries(format.formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
}
// How far the zone's clock is ahead of UTC at that moment
function offsetOf(timeZone, ms) {
  const p = partsOf(timeZone, ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
// 'YYYY-MM-DD' of a moment, in the zone
export function dayOf(timeZone, ms) {
  const p = partsOf(timeZone, ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
// The moment `minutes` after the zone's midnight starting `day` (past 1440 is the next day)
export function zonedTime(timeZone, day, minutes) {
  const [y, m, d] = day.split('-').map(Number);
  const local = Date.UTC(y, m - 1, d) + Math.round(minutes * 60) * 1000;
  return local - offsetOf(timeZone, local - offsetOf(timeZone, local));
}
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
// 0 Sunday ... 4 Thursday, 5 Friday, 6 Saturday
const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
const hm = (h, m = 0) => h * 60 + m;

/* A seeded random source (mulberry32) */

export function randomSource(seed) {
  let a = Number(seed) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    chance: (p) => next() < p,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    between: (lo, hi) => lo + next() * (hi - lo),
    pick: (list) => list[Math.floor(next() * list.length)],
    // [[value, weight], ...]
    weighted(pairs) {
      let left = next() * pairs.reduce((sum, [, w]) => sum + w, 0);
      for (const [value, w] of pairs) if ((left -= w) < 0) return value;
      return pairs.at(-1)[0];
    },
    // A browser-like request id (lib/idempotency.js)
    id: () => Array.from({ length: 4 }, () => Math.floor(next() * 2 ** 32).toString(16).padStart(8, '0')).join(''),
  };
  return r;
}

/* The restaurant's days */

// When orders come in (minutes after midnight, the last part after midnight), and how much
// of the day's orders each part gets: a lunch peak and a bigger dinner peak
const PARTS = [
  { name: 'opening', from: hm(11, 30), to: hm(13), share: 0.08 },
  { name: 'lunch', from: hm(13), to: hm(15, 30), share: 0.32 },
  { name: 'afternoon', from: hm(15, 30), to: hm(19, 30), share: 0.1 },
  { name: 'dinner', from: hm(19, 30), to: hm(23), share: 0.42 },
  { name: 'late', from: hm(23), to: hm(24, 30), share: 0.08 },
];
// Orders a day, by weekday: Thursday night and Friday are the busiest
const BASE_ORDERS = 44;
const WEEKDAY_FACTOR = [0.92, 0.88, 0.9, 0.97, 1.32, 1.45, 1.05];
// What kind of order comes in, by part of the day
const ORDER_KINDS = {
  opening: [['rice', 3], ['solo', 3.5], ['chicken', 1.5], ['grill', 1], ['light', 1]],
  lunch: [['rice', 3.5], ['solo', 2.5], ['grill', 2], ['chicken', 1.5], ['light', 0.5]],
  afternoon: [['solo', 3.5], ['light', 2.5], ['grill', 1.5], ['chicken', 1.5], ['rice', 1]],
  dinner: [['grill', 4], ['chicken', 2], ['solo', 2.5], ['light', 1.5]],
  late: [['solo', 5.5], ['grill', 1.5], ['light', 3]],
};
const RICE = [['beans', 4], ['okra', 3], ['biryaniChicken', 3], ['biryaniMeat', 2], ['quzi', 1.5], ['dolma', 2], ['tashreeb', 2]];
const SANDWICHES = [['shawarmaMeat', 3], ['shawarmaChicken', 4], ['kebabSandwich', 3], ['tikkaSandwich', 2], ['falafel', 3], ['burger', 1.5], ['crispy', 1.5]];
const SIDES = [['salad', 4], ['hummus', 3], ['mutabbal', 1.5], ['fattoush', 2], ['tabbouleh', 1.5], ['pickles', 2], ['kubba', 1]];
const MEAT_KG = [['kebabKg', 5], ['tikkaKg', 3], ['chickenTikkaKg', 3], ['chickenKebabKg', 2]];
const SKEWERS = [['kebabSkewer', 4], ['tikkaSkewer', 2], ['chickenSkewer', 3]];
const DESSERTS = [['kunafa', 3], ['custard', 2], ['iceCream', 2]];
// Packaged drinks by what a customer asks for: another of the kind when one runs out
const DRINK_KINDS = {
  can: ['cola', 'orangeSoda', 'lemonSoda'],
  family: ['colaFamily'],
  water: ['water', 'waterLarge'],
  juice: ['orangeJuice', 'mangoJuice'],
  laban: ['laban'],
  iceCream: ['iceCream'],
};
const TRACKED = PRODUCTS.filter((p) => p.tracked).map((p) => p.key);
// A week's sales of each packaged item, until the plan has a week of its own to go by
const FIRST_WEEK = { cola: 80, orangeSoda: 45, lemonSoda: 40, colaFamily: 20, water: 110, waterLarge: 22, orangeJuice: 25, mangoJuice: 25, laban: 35, iceCream: 25 };
// What the supplier charges for a piece; the soft drinks go up part way through
const SODA_RISE = 475;

/*
 * The plan for a shop filled over `days` days ending today (in DEMO_TIME_ZONE), up to `now`.
 * Returns { seed, days, timeZone, now, cutoff, firstDay, lastDay, steps, staffDays }:
 *   steps: in time order, each { at (ms), as (who sends it: 'owner' or a STAFF key), kind,
 *     ...what it needs }; services/demo-shop.js has the kinds
 *   staffDays: per staff key, { first, last }: when they signed in for their first shift
 *     and for their last one (a few minutes before its first request)
 */
export function demoPlan({ seed = DEFAULT_SEED, days = DEFAULT_DAYS, now = Date.now(), timeZone = DEMO_TIME_ZONE } = {}) {
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) throw new Error(`days must be a whole number from ${MIN_DAYS} to ${MAX_DAYS}`);
  const rnd = randomSource(seed);
  const cutoff = now - CUTOFF_MS;
  const lastDay = dayOf(timeZone, cutoff);
  const firstDay = addDays(lastDay, -(days - 1));
  const steps = [];
  const add = (step) => {
    steps.push(step);
    return step;
  };
  const time = (day, minutes) => zonedTime(timeZone, day, minutes);

  // The days on which the history turns: the evening cashier leaves, prices move, a
  // stocktake, the family that pays ahead, the teacher who stops coming
  const leaveDay = Math.max(2, Math.floor(days * 0.5));
  const priceDay = Math.floor(days * 0.55);
  const sodaRiseDay = Math.floor(days * 0.65);
  const stocktakeDay = days >= 35 ? days - 21 : Math.floor(days * 0.6);
  const familyFrom = Math.max(1, days - 20);
  const teacherUntil = Math.max(2, Math.floor(days * 0.33));
  const mobilesUntil = days - 7;
  // The dairy has had no laban for the last two weeks, and its deliveries of the last week
  // brought no ice cream: the history always ends with the laban out, for the summary to
  // show, and the ice cream running down (below its alert on some days, as are the soft
  // drinks before their Saturday delivery)
  const notDelivered = (key, index) => index > 0 && ((key === 'laban' && index >= days - 15) || (key === 'iceCream' && index >= days - 8));
  const maintenance = new Map([
    [Math.floor(days * 0.25), ['تصليح ثلاجة المشروبات', 150000]],
    [Math.floor(days * 0.55) + 1, ['صيانة المشواة وتبديل الشبك', 75000]],
    [Math.floor(days * 0.8), ['تبديل حنفية المطبخ', 25000]],
  ]);

  /* What the shop holds and sells, as the app will count it */

  const stock = Object.fromEntries(TRACKED.map((key) => [key, 0]));
  const price = Object.fromEntries(PRODUCTS.map((p) => [p.key, p.price]));
  const soldByDay = []; // per day: { key: quantity } of the packaged items
  let soldToday = {};
  const pendingReturns = []; // { at, lines: [[key, quantity]] } put back when their time comes
  const putBack = (until) => {
    pendingReturns.sort((a, b) => a.at - b.at);
    while (pendingReturns.length && pendingReturns[0].at <= until) {
      for (const [key, quantity] of pendingReturns.shift().lines) if (key in stock) stock[key] += quantity;
    }
  };
  // One drink of the kind asked for, from what is on the shelf: another of the kind, or none
  function drink(kind, quantity) {
    const options = DRINK_KINDS[kind];
    const first = rnd.pick(options);
    for (const key of [first, ...options.filter((k) => k !== first)]) {
      if (stock[key] >= quantity) {
        stock[key] -= quantity;
        soldToday[key] = (soldToday[key] ?? 0) + quantity;
        return [key, quantity];
      }
    }
    return null;
  }

  // An order's lines, at most 6, mains first: [[key, quantity], ...]
  function order(kind, persons) {
    const lines = new Map();
    const put = (key, quantity) => lines.set(key, roundTo((lines.get(key) ?? 0) + quantity, 3));
    const drinks = [];
    const drinkFor = (count) => {
      for (let i = 0; i < count; i++) drinks.push(rnd.weighted([['can', 5], ['water', 3], ['juice', 1], ['laban', persons > 2 ? 0.5 : 1.5]]));
    };
    if (kind === 'solo') {
      put(rnd.weighted(SANDWICHES), rnd.int(1, persons > 1 ? persons + 1 : 2));
      if (rnd.chance(0.3)) put('fries', 1);
      if (rnd.chance(0.65)) drinkFor(persons);
    } else if (kind === 'rice') {
      for (let i = 0; i < persons; i++) put(rnd.weighted(RICE), 1);
      if (rnd.chance(0.45)) put('lentilSoup', rnd.int(1, persons));
      if (rnd.chance(0.5)) put(rnd.weighted(SIDES.slice(0, 4)), 1);
      drinkFor(rnd.int(0, persons));
    } else if (kind === 'chicken') {
      put(rnd.weighted([['halfChicken', 3], ['wholeChicken', persons > 2 ? 3 : 0.5], ['broasted4', 2], ['broasted8', persons > 3 ? 2 : 0.3]]), 1);
      if (rnd.chance(0.6)) put('fries', 1);
      put(rnd.weighted([['samoon', 3], ['tannour', 2]]), persons + rnd.int(0, 2));
      if (rnd.chance(0.5)) put(rnd.weighted(SIDES), 1);
      if (persons >= 3 && rnd.chance(0.5)) drinks.push('family');
      else drinkFor(rnd.int(1, persons));
    } else if (kind === 'grill') {
      const style = rnd.weighted([['kg', 5], ['skewers', 3], ['plates', 1.5]]);
      if (style === 'kg') {
        const weight = Math.max(0.25, Math.round(persons * rnd.between(0.18, 0.32) * 4) / 4);
        const meats = weight >= 1 && rnd.chance(0.4) ? [rnd.weighted(MEAT_KG), rnd.weighted(MEAT_KG)] : [rnd.weighted(MEAT_KG)];
        const half = Math.round((weight / meats.length) * 4) / 4 || 0.25;
        meats.forEach((key, i) => put(key, i === 0 ? Math.max(0.25, roundTo(weight - half * (meats.length - 1), 3)) : half));
      } else if (style === 'skewers') {
        put(rnd.weighted(SKEWERS), persons * rnd.int(1, 2) + rnd.int(0, 1));
        if (persons > 2 && rnd.chance(0.5)) put('liver', 1);
      } else {
        put('mixedGrill', Math.max(1, Math.round(persons / 2)));
      }
      put(rnd.weighted([['samoon', 3], ['tannour', 2]]), persons + rnd.int(1, 3));
      put(rnd.weighted(SIDES), 1);
      if (persons > 2 && rnd.chance(0.5)) put(rnd.weighted(SIDES), 1);
      if (rnd.chance(0.35)) put('tea', persons);
      else if (persons >= 3 && rnd.chance(0.55)) drinks.push('family');
      else drinkFor(rnd.int(1, persons));
    } else {
      put(rnd.weighted([['tea', 6], ['limeTea', 2], ['coffee', 1.5], ['freshOrange', 1], ['lemonMint', 1]]), rnd.int(1, persons + 1));
      if (rnd.chance(0.5)) {
        const sweet = rnd.weighted(DESSERTS);
        if (sweet === 'iceCream') drinks.push('iceCream');
        else put(sweet, rnd.int(1, persons));
      }
    }
    for (const kindOfDrink of drinks) {
      if (lines.size >= 6) break;
      const got = drink(kindOfDrink, 1);
      if (got) put(...got);
    }
    return [...lines].slice(0, 6);
  }

  const totalOf = (lines) => money(lines.reduce((sum, [key, quantity]) => sum + money(price[key] * quantity), 0));
  // What a customer hands over: the exact amount, or the next round note
  const cashPaid = (total) => {
    const note = rnd.weighted([[0, 4], [1000, 3], [5000, 2], [10000, 1]]);
    return note ? Math.ceil(total / note) * note : total;
  };

  // Who is at the register: the morning cashier, the evening one (until he leaves), the
  // supervisor on their days off and after, the owner on a second register at busy dinners
  function cashierAt(index, weekday, minutes) {
    if (minutes < hm(18)) return weekday === 2 ? 'mustafa' : 'ali';
    if ((weekday === 4 || weekday === 5) && minutes >= hm(19, 30) && minutes < hm(23) && rnd.chance(0.3)) return 'owner';
    if (index < leaveDay) return weekday === 0 ? 'mustafa' : 'haider';
    return weekday === 3 ? 'owner' : 'mustafa';
  }

  let saleCount = 0;
  function sell({ at, as, lines, customer = null, paid }) {
    const total = totalOf(lines);
    return add({
      at,
      as,
      kind: 'sale',
      key: `s${++saleCount}`,
      clientId: rnd.id(),
      lines: lines.map(([product, quantity]) => ({ product, quantity })),
      total,
      ...(customer ? { customer, paid: paid ?? 0 } : { paid: paid === undefined ? cashPaid(total) : paid }),
    });
  }
  function giveBack({ at, as, sale, lines = null }) {
    const back = lines ?? sale.lines.map((l) => [l.product, l.quantity]);
    pendingReturns.push({ at, lines: back.map(([key, quantity]) => [key, quantity]) });
    add({
      at,
      as,
      kind: 'return',
      sale: sale.key,
      clientId: rnd.id(),
      ...(lines ? { lines: lines.map(([key, quantity]) => ({ line: sale.lines.findIndex((l) => l.product === key), quantity })) } : {}),
    });
  }

  /* Suppliers */

  const purchases = { soda: [], water: [], dairy: [] };
  let purchaseCount = 0;
  const lastWeek = (key) => {
    const week = soldByDay.slice(-7);
    if (week.length < 7) return FIRST_WEEK[key];
    return week.reduce((sum, day) => sum + (day[key] ?? 0), 0);
  };
  function deliver(supplier, at, as, index, paidShare) {
    const lines = [];
    for (const p of PRODUCTS.filter((x) => x.supplier === supplier && !notDelivered(x.key, index))) {
      // Enough for a week and a quarter, in whole cartons
      const target = Math.max(p.alert * 2, Math.ceil(lastWeek(p.key) * 1.3));
      const short = target - stock[p.key];
      if (short <= 0) continue;
      const cartons = Math.ceil(short / p.carton);
      const unitCost = DRINK_KINDS.can.includes(p.key) && index >= sodaRiseDay ? SODA_RISE : p.cost;
      stock[p.key] += cartons * p.carton;
      // By the piece, as the shop sells them
      lines.push({ product: p.key, mode: 'unit', quantity: cartons * p.carton, price: unitCost });
    }
    if (!lines.length) return null;
    const total = money(lines.reduce((sum, l) => sum + money(l.quantity * l.price), 0));
    const paid = paidShare >= 1 ? total : Math.round((total * paidShare) / 1000) * 1000;
    const { name, reference } = SUPPLIERS[supplier];
    const step = add({ at, as, kind: 'purchase', key: `p${++purchaseCount}`, clientId: rnd.id(), supplier: name, reference: `${reference}-${1040 + purchases[supplier].length * 3 + rnd.int(1, 2)}`, lines, total, paid });
    purchases[supplier].push(step);
    return step;
  }
  // What is left on an invoice, paid off
  const payRest = (at, as, purchase) => add({ at, as, kind: 'purchasePayment', purchase: purchase.key });

  /* The first morning: settings, the menu, the staff, the first deliveries */

  const open = firstDay;
  let clock = time(open, hm(9));
  const next = (minutes = 0.4) => (clock += Math.round(minutes * MINUTE));
  add({ at: next(), as: 'owner', kind: 'settings', body: { ...DEMO_SETTINGS, receiptLogo: demoLogo() } });
  add({ at: next(1), as: 'owner', kind: 'dropDefaultCategory' });
  for (const name of CATEGORIES) add({ at: next(0.5), as: 'owner', kind: 'category', key: name, body: { name } });
  for (const p of PRODUCTS) {
    const body = {
      barcode: p.code,
      name: p.name,
      category: p.category,
      purchasePrice: p.cost,
      salePrice: p.price,
      unit: p.unit,
      hasWholesale: false,
      trackStock: p.tracked,
      ...(p.tracked ? { stock: 0, lowStockAlert: p.alert, blockWhenOut: false } : { lowStockAlert: DEMO_SETTINGS.defaultLowStockAlert, blockWhenOut: false }),
    };
    add({ at: next(0.35), as: 'owner', kind: 'product', key: p.key, body });
  }
  clock = time(open, hm(9, 40));
  for (const [key, s] of Object.entries(STAFF)) {
    add({ at: next(2), as: 'owner', kind: 'staff', key, body: { username: s.username, displayName: s.displayName, permissions: [...PRESETS[s.preset].permissions] } });
  }
  const customerMade = new Set();
  const newCustomer = (key, at) => {
    if (customerMade.has(key)) return;
    customerMade.add(key);
    add({ at, as: 'owner', kind: 'customer', key, body: { ...CUSTOMERS[key] } });
  };
  newCustomer('office', time(open, hm(9, 52)));
  deliver('soda', time(open, hm(10)), 'owner', 0, 0.7);
  deliver('water', time(open, hm(10, 12)), 'owner', 0, 0);
  deliver('dairy', time(open, hm(10, 24)), 'owner', 0, 1);

  /* Every day */

  // The returns worth showing, each on the first chance from its day on: a wrong order
  // cancelled at the register, one drink given back, a quarter kilo given back, and a dish
  // taken off an office's account the next day
  const returnsDue = { cancel: Math.floor(days * 0.2), partial: Math.floor(days * 0.3), kg: Math.floor(days * 0.45), office: Math.floor(days * 0.4) };
  const returnsDone = {};
  const monthName = new Intl.DateTimeFormat('ar-u-nu-latn', { month: 'long', timeZone: 'UTC' });
  // Whether the supervisor works the evening of that day (the expenses he enters then)
  const supervisorEvening = (index, weekday) => (index < leaveDay ? weekday === 0 : weekday !== 3);
  let waterMondays = 0;
  let officePaid = null;
  let mobilesOwes = false;
  for (let index = 0; index < days; index++) {
    const day = addDays(firstDay, index);
    const weekday = weekdayOf(day);
    const dom = Number(day.slice(8));
    const at = (h, m = 0) => time(day, hm(h, m) + rnd.between(0, 4));
    putBack(time(day, hm(9)));

    // Mornings, before opening: the deliveries and what is paid to the suppliers
    if (index > 0) {
      if (weekday === 6 && purchases.soda.length) {
        payRest(at(10, 25), 'mustafa', purchases.soda.at(-1));
        deliver('soda', at(10, 31), 'mustafa', index, 0.6);
      }
      if (weekday === 1) {
        // The water and juice on account, settled every other Monday
        if (waterMondays++ % 2 === 1) {
          purchases.water.filter((p) => !p.settled).forEach((p, i) => {
            p.settled = true;
            payRest(time(day, hm(10, 36 + i * 2)), 'owner', p);
          });
        }
        deliver('water', at(10, 46), 'mustafa', index, 0);
      }
      if (weekday === 3) deliver('dairy', at(10, 15), 'mustafa', index, 1);
    }
    if (index === leaveDay) add({ at: at(10, 20), as: 'owner', kind: 'disableStaff', key: 'haider' });
    if (index === stocktakeDay) {
      const deltas = TRACKED.filter(() => rnd.chance(0.4)).map((key) => [key, rnd.weighted([[-2, 2], [-1, 4], [1, 1.5]])]);
      for (const [key, delta] of deltas) stock[key] = Math.max(0, stock[key] + delta);
      add({ at: at(10, 50), as: 'mustafa', kind: 'stocktake', deltas });
    }
    if (index === priceDay) {
      // Meat went up: the lamb tikka by the kilo and by the skewer
      for (const [key, value] of [['tikkaKg', 32000], ['tikkaSkewer', 4000]]) {
        price[key] = value;
        add({ at: at(11, 5), as: 'owner', kind: 'price', product: key, salePrice: value });
      }
    }

    // The running costs, dated that day as the expenses page dates them (its noon): the
    // owner's in the quiet afternoon, the supervisor's as his evening starts
    const expense = (as, category, amount, note) => {
      const by = as === 'mustafa' && !supervisorEvening(index, weekday) ? 'owner' : as;
      const minutes = by === 'mustafa' ? hm(18, 5) + rnd.between(0, 50) : hm(15, 45) + rnd.between(0, 120);
      add({ at: time(day, minutes), as: by, kind: 'expense', body: { date: new Date(time(day, hm(12))).toISOString(), category, amount, note } });
    };
    // The monthly payments: the generator on the 5th, the rent on the 15th (the lease runs
    // from mid-month), the wages on the month's last day. One that fell due in the history's
    // first week was made before the shop used the system, and the first month's wages are
    // entered for the days since its first morning. So the month so far («هذا الشهر» on the
    // summary) is never a loss, nor is the first month, however few days of it there are.
    const thisMonth = monthName.format(new Date(`${day}T00:00:00Z`));
    const lastOfMonth = addDays(day, 1).endsWith('-01');
    if (index >= 7 && dom === 5) expense('owner', 'اشتراك مولدة', 420000, `30 أمبير لشهر ${thisMonth}`);
    if (index >= 7 && dom === 15) expense('owner', 'إيجار', 1500000, `إيجار المحل لشهر ${thisMonth}`);
    if (index >= 7 && lastOfMonth) {
      const share = Math.min(1, (index + 1) / dom);
      const since = share < 1 ? ` (من ${Number(firstDay.slice(8))} ${thisMonth})` : '';
      const wage = (month) => Math.round((month * share) / 5000) * 5000;
      expense('owner', 'رواتب', wage(3600000), `رواتب المطبخ لشهر ${thisMonth}${since}`);
      expense('owner', 'رواتب', wage(2800000), `رواتب الصالة والكاشير لشهر ${thisMonth}${since}`);
    }
    if (dom === 10) expense('owner', 'إنترنت', 35000, '');
    if (dom === 20) expense('owner', 'كهرباء', rnd.int(17, 28) * 5000, 'فاتورة الكهرباء الوطنية');
    if (weekday === 6 || weekday === 3) {
      const cylinders = rnd.int(6, 8);
      expense('mustafa', 'غاز', cylinders * 8000, `${cylinders} قناني غاز`);
      // The grill burns charcoal: a few bags with each delivery of gas
      const bags = rnd.int(3, 4);
      expense('mustafa', 'فحم', bags * 12000, `${bags} أكياس فحم للمشواة`);
    }
    if (index % 10 === 3) expense('mustafa', 'مواد تنظيف', rnd.int(6, 11) * 5000, 'منظفات ومعقمات وأكياس نفايات');
    if (weekday === 1) expense('mustafa', 'تغليف', rnd.int(7, 10) * 5000, 'علب وأكياس للطلبات الخارجية');
    if (weekday === 4) expense('mustafa', 'نقل', rnd.int(4, 6) * 5000, 'أجرة نقل المواد من السوق');
    // A repair now and then, none in the history's first week (a short history is not all repairs)
    if (index >= 7 && maintenance.has(index)) expense('owner', 'صيانة', maintenance.get(index)[1], maintenance.get(index)[0]);

    // The customers on account who come today, each added by the owner before their first order
    const visits = [];
    if (weekday <= 4 && index >= 1 && rnd.chance(0.55)) visits.push({ customer: 'office', at: hm(13, 20) + rnd.between(0, 60), kind: 'office' });
    if ([6, 0, 1, 2, 3].includes(weekday) && rnd.chance(0.6)) visits.push({ customer: 'garage', at: hm(12, 30) + rnd.between(0, 60), kind: 'garage' });
    if (weekday === 4 && index < mobilesUntil && rnd.chance(0.75)) visits.push({ customer: 'mobiles', at: hm(21) + rnd.between(0, 90), kind: 'grill' });
    if ([familyFrom + 2, familyFrom + 6, familyFrom + 11, familyFrom + 15].includes(index)) visits.push({ customer: 'family', at: hm(20, 30) + rnd.between(0, 60), kind: 'chicken' });
    if (index >= 2 && index <= teacherUntil && (weekday === 1 || weekday === 3) && rnd.chance(0.6)) visits.push({ customer: 'teacher', at: hm(20) + rnd.between(0, 120), kind: 'solo' });
    if (index === familyFrom) newCustomer('family', time(day, hm(11, 12)));
    for (const v of visits) newCustomer(v.customer, time(day, hm(11, 5) + rnd.between(0, 10)));

    // What they pay: the office most of its month at the start of the next, the garage its
    // week every Thursday, the mobile shop's owner all of it on the Sunday after, the family
    // ahead, and the teacher half of his before he stops coming
    if (dom <= 3 && weekday <= 4 && officePaid !== day.slice(0, 7) && customerMade.has('office')) {
      officePaid = day.slice(0, 7);
      add({ at: at(12), as: 'owner', kind: 'payment', customer: 'office', share: 0.75, step: 5000, note: 'دفعة من حساب الشهر' });
    }
    if (weekday === 4 && customerMade.has('garage')) add({ at: at(16, 30), as: 'ali', kind: 'payment', customer: 'garage', share: 1, step: 250, note: 'حساب الأسبوع' });
    if (mobilesOwes && weekday === 0) {
      mobilesOwes = false;
      add({ at: at(19, 40), as: cashierAt(index, weekday, hm(19, 40)), kind: 'payment', customer: 'mobiles', share: 1, step: 250, note: '' });
    }
    if (index === familyFrom) add({ at: at(18, 30), as: 'owner', kind: 'payment', customer: 'family', amount: 100000, note: 'مبلغ مقدم للطلبات' });
    if (index === teacherUntil - 1 && customerMade.has('teacher')) add({ at: at(20, 40), as: cashierAt(index, weekday, hm(20, 40)), kind: 'payment', customer: 'teacher', share: 0.5, step: 1000, note: '' });

    // The day's orders, in time order, at least half a minute apart
    const factor = WEEKDAY_FACTOR[weekday] * rnd.between(0.9, 1.12) * (rnd.chance(0.05) ? 0.8 : 1);
    const count = Math.max(8, Math.round(BASE_ORDERS * factor));
    const orders = [];
    for (let i = 0; i < count; i++) {
      const part = rnd.weighted(PARTS.map((p) => [p, p.share]));
      orders.push({ at: rnd.between(part.from, part.to), part: part.name });
    }
    orders.push(...visits);
    orders.sort((a, b) => a.at - b.at);
    for (let i = 1; i < orders.length; i++) orders[i].at = Math.max(orders[i].at, orders[i - 1].at + 0.5);

    const due = (kind) => !returnsDone[kind] && index >= returnsDue[kind];
    for (const o of orders) {
      const when = time(day, o.at);
      putBack(when);
      const as = cashierAt(index, weekday, o.at);
      if (o.customer) {
        let lines;
        if (o.kind === 'office') lines = order(rnd.chance(0.6) ? 'rice' : 'solo', rnd.int(3, 6));
        else if (o.kind === 'garage') lines = [[rnd.weighted([['kebabSandwich', 3], ['falafel', 2], ['shawarmaChicken', 2]]), rnd.int(2, 5)], ...(rnd.chance(0.6) ? [['tea', rnd.int(2, 4)]] : [])];
        else lines = order(o.kind, o.customer === 'teacher' ? 1 : rnd.int(3, 5));
        const total = totalOf(lines);
        // Now and then the office pays part of it at the register
        const paid = o.customer === 'office' && rnd.chance(0.12) ? Math.min(Math.floor(total / 2 / 1000) * 1000, 10000) : 0;
        const sale = sell({ at: when, as, lines, customer: o.customer, paid });
        if (o.customer === 'mobiles') mobilesOwes = true;
        if (o.customer === 'office' && due('office') && lines.length >= 2 && Number.isInteger(lines[0][1])) {
          // Charged for a dish that never reached the office: taken off its account the next day
          returnsDone.office = true;
          giveBack({ at: time(addDays(day, 1), hm(12, 15)), as: 'owner', sale, lines: [[lines[0][0], 1]] });
        }
        continue;
      }
      const persons = rnd.weighted([[1, 3], [2, 3], [3, 2], [4, 1.5], [5, 0.7], [6, 0.4]]);
      const lines = order(rnd.weighted(ORDER_KINDS[o.part]), persons);
      if (!lines.length) continue;
      const sale = sell({ at: when, as, lines });
      const later = (minutes) => time(day, o.at + minutes);
      const drinkLine = lines.find(([key, q]) => key in stock && q >= 1);
      const kgLine = lines.find(([key, q]) => PRODUCT[key].unit === 'kg' && q >= 0.5);
      // Given back the same evening, never past midnight: a new month never starts with a
      // refund before its first sale
      const returnable = o.at >= hm(13) && o.at <= hm(23, 30);
      if (!returnable) continue;
      if (due('cancel')) {
        returnsDone.cancel = true;
        giveBack({ at: later(3), as, sale });
      } else if (due('partial') && lines.length >= 3 && drinkLine) {
        returnsDone.partial = true;
        giveBack({ at: later(6), as, sale, lines: [[drinkLine[0], 1]] });
      } else if (due('kg') && kgLine) {
        returnsDone.kg = true;
        giveBack({ at: later(10), as, sale, lines: [[kgLine[0], 0.25]] });
      } else if (rnd.chance(0.0025)) {
        giveBack({ at: later(rnd.between(2, 6)), as, sale });
      }
    }
    putBack(time(day, hm(24, 59)));
    soldByDay.push(soldToday);
    soldToday = {};
  }

  // What happened before the cutoff, in time order
  const planned = steps.filter((s) => s.at < cutoff).sort((a, b) => a.at - b.at);
  // When each employee signed in: a few minutes before the first request of each of their
  // shifts (a business day runs past midnight; its evening starts at 18:00)
  const staffDays = {};
  for (const s of planned) {
    if (!(s.as in STAFF)) continue;
    let day = dayOf(timeZone, s.at);
    let minutes = (s.at - time(day, 0)) / MINUTE;
    if (minutes < hm(5)) {
      day = addDays(day, -1);
      minutes += hm(24);
    }
    const shift = `${day}${minutes < hm(18) ? 'm' : 'e'}`;
    const signIn = s.at - 4 * MINUTE;
    const entry = (staffDays[s.as] ??= { first: signIn, last: signIn, shift });
    if (entry.shift !== shift) Object.assign(entry, { last: signIn, shift });
  }
  for (const entry of Object.values(staffDays)) delete entry.shift;
  return { seed, days, timeZone, now, cutoff, firstDay, lastDay, steps: planned, staffDays };
}
