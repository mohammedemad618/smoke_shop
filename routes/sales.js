import { Router } from 'express';
import mongoose from 'mongoose';
import { httpError } from '../lib/errors.js';
import { clientIdOf, isDuplicateOf } from '../lib/idempotency.js';
import { REPORT_MS, runReport } from '../lib/limits.js';
import { lineAmount, money, precise, roundQty, stockChange } from '../lib/util.js';
import { roundingStepOf } from '../lib/shop-settings.js';
import { DAY_MS, requestedRange, timeZoneParam } from '../lib/range.js';
import { madeByOf } from '../lib/auth.js';
import { allow, can, forbidden, saleFor, seesCosts } from '../lib/permissions.js';

const router = Router();
const MAX_QUANTITY = 10000;
const MAX_LIST_RANGE_MS = 31 * DAY_MS;
const MAX_REPORT_RANGE_MS = 3 * 366 * DAY_MS;
const GROUP_FORMATS = { day: '%Y-%m-%d', month: '%Y-%m' };

// Net profit counts only money that came in: profit on sales, minus expenses, minus what
// was sold on credit (less what returns took off the account), plus what customers paid
// towards credit sales. Over time it adds up to the profit on sales minus expenses.
const netProfitOf = ({ profit, credit }, expenses, collected) => money(profit - expenses - credit + collected);

/* Stock */

async function putBackInStock(Product, entries) {
  if (!entries.length) return;
  await Product.bulkWrite(
    entries.map(([id, quantity]) => ({
      updateOne: { filter: { _id: id, trackStock: true }, update: stockChange(quantity) },
    })),
  );
}

// Takes sold quantities off tracked products. Products that block overselling only go
// down when enough is left; on a shortfall everything taken so far is put back.
async function takeFromStock(Product, products, quantities) {
  const taken = [];
  for (const p of products.filter((x) => x.trackStock)) {
    const quantity = quantities.get(String(p._id));
    const filter = p.blockWhenOut ? { _id: p._id, stock: { $gte: quantity } } : { _id: p._id };
    const { matchedCount } = await Product.updateOne(filter, stockChange(-quantity), { updatePipeline: true });
    if (!matchedCount) {
      await putBackInStock(Product, taken);
      const fresh = await Product.findById(p._id, 'stock').lean();
      const left = Math.max(fresh?.stock ?? 0, 0);
      throw httpError(409, left ? `المتوفر من «${p.name}» ${left} فقط` : `نفدت كمية «${p.name}» من المخزن`);
    }
    taken.push([p._id, quantity]);
  }
  return taken;
}

/* Reports */

// A period's figures follow the money: a sale counts on the day it was made, a return on
// the day the refund was given. An invoice returned today lowers today's sales and leaves
// the day it was sold as it closed.

// Pieces in a list of lines (sold or returned): weights are not pieces
const piecesIn = (lines) => ({
  $sum: {
    $map: {
      input: lines,
      as: 'i',
      in: { $cond: [{ $eq: ['$$i.unit', 'kg'] }, 0, { $multiply: ['$$i.quantity', { $ifNull: ['$$i.packSize', 1] }] }] },
    },
  },
});

/*
 * What customers paid that settles sales made on credit, dated when it counts: a payment on
 * its day, and money paid ahead on the day a later credit sale uses it. Paying back a debt
 * added by hand (money lent, or owed from before this system) is not money from sales, so
 * it does not count, and money paid ahead does not count until a sale uses it. Each
 * customer's account is replayed oldest first: payments settle the oldest open debts, and
 * a return settles its own invoice first.
 */
async function collectedEvents(DebtEntry, end) {
  const entries = await DebtEntry.find({ date: { $lt: end } }).sort({ customer: 1, date: 1, createdAt: 1 }).maxTimeMS(REPORT_MS).lean();
  const events = [];
  let customer = null;
  let open = [];
  let ahead = 0;
  for (const e of entries) {
    if (String(e.customer) !== customer) {
      customer = String(e.customer);
      open = [];
      ahead = 0;
    }
    if (e.amount > 0) {
      const used = Math.min(ahead, e.amount);
      ahead = money(ahead - used);
      if (used > 0 && e.kind === 'sale') events.push({ date: e.date, amount: used });
      const left = money(e.amount - used);
      if (left > 0) open.push({ kind: e.kind, sale: e.sale ? String(e.sale) : null, left });
      continue;
    }
    let rest = -e.amount;
    const ownFirst = e.kind === 'return' ? [...open].sort((a, b) => (b.sale === String(e.sale)) - (a.sale === String(e.sale))) : open;
    for (const debt of ownFirst) {
      if (rest <= 0) break;
      const used = Math.min(debt.left, rest);
      debt.left = money(debt.left - used);
      rest = money(rest - used);
      if (e.kind === 'payment' && debt.kind === 'sale') events.push({ date: e.date, amount: used });
    }
    open = open.filter((debt) => debt.left > 0);
    ahead = money(ahead + rest);
  }
  return events;
}

// The figures of [start, end), in one row ('all') or one row per day or month of the shop's
// time zone: invoices, pieces, sales, cost, profit, returns, credit, expenses, collected
async function periodFigures(m, start, end, groupBy = null, timezone = 'UTC') {
  const { Sale, Expense, DebtEntry } = m;
  const format = GROUP_FORMATS[groupBy];
  const keyOf = (date) => (format ? { $dateToString: { format, date, timezone } } : 'all');
  const inRange = { $gte: start, $lt: end };
  const lastReturn = { $max: '$returns.at' };
  const [sold, returned, expenses, events] = await Promise.all([
    Sale.aggregate([
      { $match: { createdAt: inRange } },
      {
        $group: {
          _id: keyOf('$createdAt'),
          // An invoice cancelled within the same day (or month) was not really a sale
          count: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$returnStatus', 'full'] },
                    { $lt: [lastReturn, end] },
                    { $eq: [keyOf(lastReturn), keyOf('$createdAt')] },
                  ],
                },
                0,
                1,
              ],
            },
          },
          pieces: { $sum: piecesIn('$items') },
          total: { $sum: '$total' },
          cost: { $sum: '$cost' },
          profit: { $sum: '$profit' },
          credit: { $sum: { $ifNull: ['$debt', 0] } },
        },
      },
    ]).option({ maxTimeMS: REPORT_MS }),
    Sale.aggregate([
      { $match: { 'returns.at': inRange } },
      { $unwind: '$returns' },
      { $match: { 'returns.at': inRange } },
      {
        $group: {
          _id: keyOf('$returns.at'),
          pieces: { $sum: piecesIn('$returns.items') },
          amount: { $sum: '$returns.amount' },
          cost: { $sum: '$returns.cost' },
          toAccount: { $sum: { $ifNull: ['$returns.toAccount', 0] } },
        },
      },
    ]).option({ maxTimeMS: REPORT_MS }),
    Expense.aggregate([{ $match: { date: inRange } }, { $group: { _id: keyOf('$date'), total: { $sum: '$amount' } } }]).option({ maxTimeMS: REPORT_MS }),
    collectedEvents(DebtEntry, end),
  ]);

  const rows = new Map();
  const rowFor = (key) => {
    if (!rows.has(key)) {
      rows.set(key, { key, count: 0, pieces: 0, total: 0, cost: 0, profit: 0, returns: 0, credit: 0, expenses: 0, collected: 0 });
    }
    return rows.get(key);
  };
  for (const s of sold) Object.assign(rowFor(s._id), { count: s.count, pieces: s.pieces, total: s.total, cost: s.cost, profit: s.profit, credit: s.credit });
  for (const r of returned) {
    const row = rowFor(r._id);
    row.pieces -= r.pieces;
    row.total -= r.amount;
    row.cost -= r.cost;
    row.profit -= r.amount - r.cost;
    row.returns += r.amount;
    row.credit -= r.toAccount;
  }
  for (const e of expenses) rowFor(e._id).expenses = e.total;
  const keyFormat = format && new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  for (const ev of events) {
    if (ev.date < start || ev.date >= end) continue;
    const key = format ? keyFormat.format(ev.date).slice(0, groupBy === 'month' ? 7 : 10) : 'all';
    rowFor(key).collected += ev.amount;
  }
  return [...rows.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((row) => {
      const figures = { ...row, pieces: roundQty(row.pieces) };
      for (const field of ['total', 'cost', 'profit', 'returns', 'credit', 'expenses', 'collected']) figures[field] = money(row[field]);
      return { ...figures, netProfit: netProfitOf(figures, figures.expenses, figures.collected) };
    });
}

const EMPTY_FIGURES = { count: 0, pieces: 0, total: 0, cost: 0, profit: 0, returns: 0, credit: 0, expenses: 0, collected: 0, netProfit: 0 };
const sumFigures = (rows) => {
  const sum = { ...EMPTY_FIGURES };
  for (const row of rows) for (const field of Object.keys(EMPTY_FIGURES)) sum[field] += row[field];
  for (const field of ['total', 'cost', 'profit', 'returns', 'credit', 'expenses', 'collected', 'netProfit']) sum[field] = money(sum[field]);
  sum.pieces = roundQty(sum.pieces);
  return sum;
};

// Invoices made in one day (or a short range), newest first, with the period's figures.
// An account with `returns` but not `reports` finds the invoice to return from here: it gets
// the invoices without their costs and profit, and no figures (summary null).
router.get('/', allow('reports', 'returns'), async (req, res) => {
  const { Sale } = req.models;
  const { start, end } = requestedRange(req.query, MAX_LIST_RANGE_MS);
  const reports = seesCosts(req.user);
  // The day's figures replay the customers' accounts: a report, one at a time per shop
  const [sales, rows] = await Promise.all([
    Sale.find({ createdAt: { $gte: start, $lt: end } }).sort({ createdAt: -1 }).lean(),
    reports ? runReport(req.tenant._id, () => periodFigures(req.models, start, end)) : null,
  ]);
  if (!reports) return res.json({ summary: null, sales: sales.map((s) => saleFor(req.user, s)) });
  const summary = { ...EMPTY_FIGURES, ...rows[0] };
  delete summary.key;
  res.json({ summary, sales });
});

// Figures for a month or any period, broken down by day or by month
router.get('/report', allow('reports'), async (req, res) => {
  const { start, end } = requestedRange(req.query, MAX_REPORT_RANGE_MS);
  const groupBy = req.query.groupBy === 'month' ? 'month' : 'day';
  const periods = await runReport(req.tenant._id, () => periodFigures(req.models, start, end, groupBy, timeZoneParam(req.query.tz)));
  res.json({ groupBy, summary: sumFigures(periods), periods });
});

// Per-product figures for a period, from the prices stored on each invoice at the time of
// sale: what was sold in the period, less what was returned in it (like the period totals)
router.get('/products', allow('reports'), async (req, res) => {
  const { Sale } = req.models;
  const { start, end } = requestedRange(req.query, MAX_REPORT_RANGE_MS);
  const inRange = { $gte: start, $lt: end };
  const baseQty = (line) => ({ $multiply: [`${line}.quantity`, { $ifNull: [`${line}.packSize`, 1] }] });
  const [sold, returned] = await runReport(req.tenant._id, () => Promise.all([
    Sale.aggregate([
      { $match: { createdAt: inRange } },
      // Oldest first, so $last picks the product's most recent name
      { $sort: { createdAt: 1 } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.product',
          name: { $last: '$items.name' },
          barcode: { $last: '$items.barcode' },
          unit: { $last: { $ifNull: ['$items.unit', 'piece'] } },
          // Invoices, not lines (one invoice may sell a product loose and by the box), and
          // not those that gave all of it back
          sales: {
            $addToSet: { $cond: [{ $lt: [{ $ifNull: ['$items.returnedQuantity', 0] }, '$items.quantity'] }, '$_id', null] },
          },
          quantity: { $sum: baseQty('$items') },
          total: { $sum: '$items.lineTotal' },
          cost: { $sum: { $multiply: ['$items.unitCost', '$items.quantity'] } },
        },
      },
    ]).option({ maxTimeMS: REPORT_MS }),
    Sale.aggregate([
      { $match: { 'returns.at': inRange } },
      { $unwind: '$returns' },
      { $match: { 'returns.at': inRange } },
      { $unwind: '$returns.items' },
      {
        $group: {
          _id: '$returns.items.product',
          name: { $last: '$returns.items.name' },
          unit: { $last: { $ifNull: ['$returns.items.unit', 'piece'] } },
          quantity: { $sum: baseQty('$returns.items') },
          amount: { $sum: '$returns.items.amount' },
          // At the cost of the invoice line it came back from
          cost: {
            $sum: {
              $multiply: [
                '$returns.items.quantity',
                {
                  $let: {
                    vars: {
                      line: {
                        $arrayElemAt: [
                          {
                            $filter: {
                              input: '$items',
                              as: 'i',
                              cond: {
                                $and: [
                                  { $eq: ['$$i.product', '$returns.items.product'] },
                                  { $eq: ['$$i.mode', '$returns.items.mode'] },
                                ],
                              },
                            },
                          },
                          0,
                        ],
                      },
                    },
                    in: { $ifNull: ['$$line.unitCost', 0] },
                  },
                },
              ],
            },
          },
        },
      },
    ]).option({ maxTimeMS: REPORT_MS }),
  ]));

  const rows = new Map();
  for (const s of sold) {
    rows.set(String(s._id), {
      product: s._id,
      name: s.name,
      barcode: s.barcode,
      unit: s.unit,
      invoices: s.sales.filter(Boolean).length,
      quantity: s.quantity,
      total: s.total,
      cost: s.cost,
    });
  }
  for (const r of returned) {
    const row = rows.get(String(r._id)) ?? { product: r._id, name: r.name, barcode: '', unit: r.unit, invoices: 0, quantity: 0, total: 0, cost: 0 };
    row.quantity -= r.quantity;
    row.total -= r.amount;
    row.cost -= r.cost;
    rows.set(String(r._id), row);
  }
  res.json(
    [...rows.values()]
      .map((row) => ({
        ...row,
        quantity: roundQty(row.quantity),
        total: money(row.total),
        cost: money(row.cost),
        profit: money(row.total - row.cost),
      }))
      // Sold and returned within the period: it did not really sell
      .filter((row) => row.quantity !== 0 || row.total !== 0),
  );
});

/* Selling */

// An invoice as the cashier shows it, with what its customer owes now; without `reports`,
// without its costs (lib/permissions.js)
const withBalance = async (req, sale) =>
  saleFor(req.user, { ...sale, customerBalance: sale.customer ? await req.models.DebtEntry.balanceOf(sale.customer) : undefined });
// The same, answering a sale sent again under an id already recorded: marked repeated. The
// cashier page decides on printing by itself (autoPrint) from the sales its tab printed, not
// from this mark: a repeated answer may be the first one to arrive (the earlier one lost)
const repeated = async (req, sale) => ({ ...(await withBalance(req, sale)), repeated: true });

// Every account sells for cash; selling on a customer's account needs `credit`. The sale
// records who made it, from the session.
router.post('/', allow('selling'), async (req, res) => {
  const { Product, Sale, Customer, DebtEntry, Counter, Setting } = req.models;
  // Sent again after an answer that never arrived: the invoice as it was recorded, and
  // nothing else happens (no second number, no stock taken again)
  const clientId = clientIdOf(req.body);
  if (clientId) {
    const done = await Sale.findOne({ clientId }).lean();
    if (done) return res.json(await repeated(req, done));
  }
  const lines = Array.isArray(req.body.items) ? req.body.items : [];
  if (lines.length === 0) throw httpError(400, 'أضف منتجًا واحدًا على الأقل إلى الفاتورة');

  // Merge repeated lines of the same product and sale type, keeping cart order
  const merged = new Map();
  for (const line of lines) {
    const id = String(line?.productId ?? '');
    const mode = line?.mode === 'wholesale' ? 'wholesale' : 'retail';
    // To the gram: a weight under half a gram is nothing
    const quantity = roundQty(Number(line?.quantity));
    if (!mongoose.isObjectIdOrHexString(id)) throw httpError(400, 'الفاتورة تحتوي على منتج غير صالح');
    if (!Number.isFinite(quantity) || quantity <= 0) throw httpError(400, 'الكمية يجب أن تكون أكبر من صفر');
    const key = `${id}:${mode}`;
    merged.set(key, { id, mode, quantity: roundQty((merged.get(key)?.quantity ?? 0) + quantity) });
  }
  if ([...merged.values()].some((l) => l.quantity > MAX_QUANTITY)) {
    throw httpError(400, `أقصى كمية للصنف الواحد ${MAX_QUANTITY}`);
  }

  // Prices always come from the database, never from the client, and so does the step each
  // line is rounded up to (the shop's «أصغر فئة نقدية» now, 0 when it does not round)
  const ids = [...new Set([...merged.values()].map((l) => l.id))];
  const [products, step] = await Promise.all([
    Product.find({ _id: { $in: ids } }).lean(),
    Setting.findById('shop').select('roundingStep').lean().then(roundingStepOf),
  ]);
  if (products.length !== ids.length) {
    throw httpError(400, 'بعض منتجات الفاتورة لم تعد موجودة. حدّث الصفحة وأعد المحاولة');
  }
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const items = [...merged.values()].map(({ id, mode, quantity }) => {
    const p = byId.get(id);
    const unit = p.unit ?? 'piece';
    const wholesale = mode === 'wholesale';
    if (wholesale && !(p.hasWholesale && p.wholesaleQty > 0)) throw httpError(400, `«${p.name}» ليس له سعر جملة`);
    // Pieces, boxes and wholesale bags are whole; only a retail weight can be a fraction
    if ((wholesale || unit === 'piece') && !Number.isInteger(quantity)) {
      throw httpError(400, `كمية «${p.name}» يجب أن تكون عددًا صحيحًا`);
    }
    const packSize = wholesale ? p.wholesaleQty : 1;
    const unitPrice = wholesale ? p.wholesalePrice : p.salePrice;
    return {
      product: p._id,
      name: p.name,
      barcode: p.barcode,
      unit,
      mode,
      packSize,
      quantity,
      unitPrice,
      unitCost: precise(p.purchasePrice * packSize),
      // The line, not each piece, goes up to the step: 3 x 600 is 2,000 at 250, not 2,250
      lineTotal: lineAmount(unitPrice, quantity, step),
    };
  });

  // What leaves the shelf, per product, in pieces or kg
  const baseQuantities = new Map();
  for (const item of items) {
    const id = String(item.product);
    baseQuantities.set(id, roundQty((baseQuantities.get(id) ?? 0) + item.quantity * item.packSize));
  }

  const total = money(items.reduce((sum, i) => sum + i.lineTotal, 0));
  // Line by line, like the totals, so a return of a whole line takes back exactly its cost
  const cost = money(items.reduce((sum, i) => sum + money(i.unitCost * i.quantity), 0));
  // Cash: an empty paid means the exact amount. Credit: paid is the part paid now (often
  // nothing) and the rest goes on the customer's account.
  const paymentType = req.body.paymentType === 'credit' ? 'credit' : 'cash';
  if (paymentType === 'credit' && !can(req.user, 'credit')) throw forbidden('credit');
  const paidInput = req.body.paid;
  const noPaid = paidInput === undefined || paidInput === null || paidInput === '';
  let customer = null;
  let paid;
  let change = 0;
  let debt = 0;
  if (paymentType === 'credit') {
    if (!mongoose.isObjectIdOrHexString(String(req.body.customerId ?? ''))) {
      throw httpError(400, 'اختر الزبون الذي يُسجَّل عليه الدين');
    }
    customer = await Customer.findById(req.body.customerId).lean();
    if (!customer) throw httpError(400, 'الزبون غير موجود');
    paid = noPaid ? 0 : money(paidInput);
    if (!Number.isFinite(paid) || paid < 0) throw httpError(400, 'المبلغ المدفوع غير صالح');
    if (paid >= total) throw httpError(400, 'المبلغ مدفوع بالكامل، اختر الدفع نقدًا');
    debt = money(total - paid);
  } else {
    paid = noPaid ? total : money(paidInput);
    if (!Number.isFinite(paid) || paid < total) throw httpError(400, 'المبلغ المدفوع أقل من إجمالي الفاتورة');
    change = money(paid - total);
  }

  const taken = await takeFromStock(Product, products, baseQuantities);
  let sale;
  try {
    sale = await Sale.create({
      number: await Counter.next('sale'),
      items,
      total,
      cost,
      profit: money(total - cost),
      paid,
      change,
      paymentType,
      customer: customer?._id,
      customerName: customer?.name,
      debt,
      roundingStep: step || undefined,
      clientId: clientId ?? undefined,
      madeBy: madeByOf(req.user),
    });
    if (debt > 0) {
      await DebtEntry.create({
        customer: customer._id,
        kind: 'sale',
        amount: debt,
        sale: sale._id,
        saleNumber: sale.number,
        date: sale.createdAt,
      });
    }
  } catch (err) {
    // No invoice without its debt record, and no stock taken for nothing
    if (sale) await Sale.deleteOne({ _id: sale._id });
    await putBackInStock(Product, taken);
    // The same sale sent twice at once: the other request recorded it, this one gave its
    // stock back and answers with that invoice
    if (clientId && isDuplicateOf(err, 'clientId')) {
      const done = await Sale.findOne({ clientId }).lean();
      if (done) return res.json(await repeated(req, done));
    }
    throw err;
  }
  res.status(201).json(await withBalance(req, sale.toObject()));
});

/* Returns */

// Body { items: [{ line, quantity }] } returns quantities of invoice lines (by index, in
// each line's sold unit). Without items, everything not yet returned comes back: the
// whole sale is cancelled. Needs `returns`; the return records who made it, from the session.
router.post('/:id/returns', allow('returns'), async (req, res) => {
  const { Product, Sale, DebtEntry } = req.models;
  const clientId = clientIdOf(req.body);
  const sale = await Sale.findById(req.params.id);
  if (!sale) throw httpError(404, 'الفاتورة غير موجودة');
  // A return sent again: what it gave back the first time, and nothing more
  const replay = (s) => {
    const done = clientId && s.returns.find((r) => r.clientId === clientId);
    return done && res.json({ sale: saleFor(req.user, s), refunded: money(done.amount - (done.toAccount ?? 0)), toAccount: done.toAccount ?? 0, customerName: s.customerName });
  };
  if (replay(sale)) return;

  const requested = Array.isArray(req.body.items) ? req.body.items : null;
  const lines = [];
  sale.items.forEach((item, index) => {
    const left = roundQty(item.quantity - (item.returnedQuantity ?? 0));
    const asked = requested
      ? roundQty(Number(requested.find((r) => Number(r?.line) === index)?.quantity ?? 0))
      : left;
    const whole = item.mode === 'wholesale' || item.unit !== 'kg';
    if (!Number.isFinite(asked) || asked < 0 || (whole && !Number.isInteger(asked))) {
      throw httpError(400, `كمية «${item.name}» المرتجعة غير صالحة`);
    }
    if (asked > left) throw httpError(400, `أقصى ما يمكن إرجاعه من «${item.name}» ${left}`);
    if (asked > 0) lines.push({ item, quantity: asked });
  });
  if (!lines.length) {
    throw httpError(400, sale.returnStatus === 'full' ? 'هذه الفاتورة مرتجعة بالكامل' : 'حدّد كمية واحدة على الأقل للإرجاع');
  }

  // A line gives back its share of what it was sold for, by the part of it returned so
  // far, so a line returned in several goes adds up to exactly its total and cost
  // (three returns of 0.111 kg of a 0.333 kg line make 443.89, not 3 x 147.96 = 443.88)
  const share = (value, item, quantity) => money((value * quantity) / item.quantity);
  // A sale made while the shop rounded up to its «أصغر فئة نقدية» gives back, for a line,
  // what was left of it before less what is left after, each rounded up as the line was
  // sold, at the sale's own step: 3 x 600 sold for 2,000 at 250, one back leaves 2 = 1,250,
  // so 750 comes back, and the other two then 1,250. Its cost still comes back by share.
  const step = sale.roundingStep ?? 0;
  const leftAmount = (item, left) => (left >= item.quantity ? item.lineTotal : left > 0 ? lineAmount(item.unitPrice, left, step) : 0);
  const refundOf = (item, before, after) =>
    step
      ? money(leftAmount(item, roundQty(item.quantity - before)) - leftAmount(item, roundQty(item.quantity - after)))
      : money(share(item.lineTotal, item, after) - share(item.lineTotal, item, before));
  let cost = 0;
  const items = lines.map(({ item, quantity }) => {
    const before = item.returnedQuantity ?? 0;
    const after = roundQty(before + quantity);
    const lineCost = item.unitCost * item.quantity;
    cost += share(lineCost, item, after) - share(lineCost, item, before);
    return {
      product: item.product,
      name: item.name,
      unit: item.unit,
      mode: item.mode,
      packSize: item.packSize,
      quantity,
      amount: refundOf(item, before, after),
    };
  });
  const entry = {
    at: new Date(),
    items,
    amount: money(items.reduce((sum, i) => sum + i.amount, 0)),
    cost: money(cost),
    ...(clientId ? { clientId } : {}),
    madeBy: madeByOf(req.user),
  };
  // The return that empties the invoice takes back exactly what is left of it, whatever
  // older returns rounded to
  const emptied = sale.items.every((item) => {
    const back = lines.find((l) => l.item === item)?.quantity ?? 0;
    return roundQty((item.returnedQuantity ?? 0) + back) >= item.quantity;
  });
  if (emptied) {
    const rest = money(sale.total - (sale.returnedTotal ?? 0));
    const last = items[items.length - 1];
    last.amount = money(last.amount + rest - entry.amount);
    entry.amount = rest;
    entry.cost = money(sale.cost - (sale.returnedCost ?? 0));
  }

  // On a credit sale the refund first comes off what the customer still owes, up to what
  // this invoice put on their account; the rest is paid back in cash. A customer who has
  // paid since owes less, so a return then is partly or wholly cash.
  entry.toAccount = 0;
  if (sale.paymentType === 'credit' && sale.customer) {
    const alreadyToAccount = sale.returns.reduce((sum, r) => sum + (r.toAccount ?? 0), 0);
    const leftOnSale = Math.max(0, (sale.debt ?? 0) - alreadyToAccount);
    const owedNow = Math.max(0, await DebtEntry.balanceOf(sale.customer));
    entry.toAccount = money(Math.min(entry.amount, leftOnSale, owedNow));
  }

  for (const { item, quantity } of lines) item.returnedQuantity = roundQty((item.returnedQuantity ?? 0) + quantity);
  sale.returns.push(entry);
  sale.returnedTotal = money((sale.returnedTotal ?? 0) + entry.amount);
  sale.returnedCost = money((sale.returnedCost ?? 0) + entry.cost);
  sale.returnStatus = sale.items.every((i) => i.returnedQuantity >= i.quantity) ? 'full' : 'partial';
  try {
    await sale.save();
  } catch (err) {
    // The same return sent twice at once: the first one saved, this one changed nothing
    if (clientId && (err instanceof mongoose.Error.VersionError || isDuplicateOf(err, 'returns.clientId'))) {
      if (replay(await Sale.findById(sale._id))) return;
    }
    throw err;
  }

  // Back on the shelf in pieces or kg: a returned box puts all its pieces back
  await putBackInStock(Product, lines.map(({ item, quantity }) => [item.product, roundQty(quantity * (item.packSize ?? 1))]));
  if (entry.toAccount > 0) {
    await DebtEntry.create({
      customer: sale.customer,
      kind: 'return',
      amount: -entry.toAccount,
      sale: sale._id,
      saleNumber: sale.number,
    });
  }
  res.status(201).json({
    sale: saleFor(req.user, sale),
    refunded: money(entry.amount - entry.toAccount), // cash back to the customer
    toAccount: entry.toAccount,
    customerName: sale.customerName,
  });
});

// The admin panel's and the owner's CSV exports use the same figures as the report
// (services/exports.js), so a month's file adds up to the month on the sales page
export { periodFigures, sumFigures };

export default router;
