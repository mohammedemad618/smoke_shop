import { Router } from 'express';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Sale from '../models/Sale.js';
import Expense from '../models/Expense.js';
import Customer from '../models/Customer.js';
import DebtEntry from '../models/DebtEntry.js';
import { nextSequence } from '../models/Counter.js';
import { httpError } from '../lib/errors.js';
import { money, precise, roundQty, stockChange } from '../lib/util.js';
import { DAY_MS, requestedRange, timeZoneParam } from '../lib/range.js';

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

async function putBackInStock(entries) {
  if (!entries.length) return;
  await Product.bulkWrite(
    entries.map(([id, quantity]) => ({
      updateOne: { filter: { _id: id, trackStock: true }, update: stockChange(quantity) },
    })),
  );
}

// Takes sold quantities off tracked products. Products that block overselling only go
// down when enough is left; on a shortfall everything taken so far is put back.
async function takeFromStock(products, quantities) {
  const taken = [];
  for (const p of products.filter((x) => x.trackStock)) {
    const quantity = quantities.get(String(p._id));
    const filter = p.blockWhenOut ? { _id: p._id, stock: { $gte: quantity } } : { _id: p._id };
    const { matchedCount } = await Product.updateOne(filter, stockChange(-quantity), { updatePipeline: true });
    if (!matchedCount) {
      await putBackInStock(taken);
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
async function collectedEvents(end) {
  const entries = await DebtEntry.find({ date: { $lt: end } }).sort({ customer: 1, date: 1, createdAt: 1 }).lean();
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
async function periodFigures(start, end, groupBy = null, timezone = 'UTC') {
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
    ]),
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
    ]),
    Expense.aggregate([{ $match: { date: inRange } }, { $group: { _id: keyOf('$date'), total: { $sum: '$amount' } } }]),
    collectedEvents(end),
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

// Invoices made in one day (or a short range), newest first, with the period's figures
router.get('/', async (req, res) => {
  const { start, end } = requestedRange(req.query, MAX_LIST_RANGE_MS);
  const [sales, rows] = await Promise.all([
    Sale.find({ createdAt: { $gte: start, $lt: end } }).sort({ createdAt: -1 }).lean(),
    periodFigures(start, end),
  ]);
  const summary = { ...EMPTY_FIGURES, ...rows[0] };
  delete summary.key;
  res.json({ summary, sales });
});

// Figures for a month or any period, broken down by day or by month
router.get('/report', async (req, res) => {
  const { start, end } = requestedRange(req.query, MAX_REPORT_RANGE_MS);
  const groupBy = req.query.groupBy === 'month' ? 'month' : 'day';
  const periods = await periodFigures(start, end, groupBy, timeZoneParam(req.query.tz));
  res.json({ groupBy, summary: sumFigures(periods), periods });
});

// Per-product figures for a period, from the prices stored on each invoice at the time of
// sale: what was sold in the period, less what was returned in it (like the period totals)
router.get('/products', async (req, res) => {
  const { start, end } = requestedRange(req.query, MAX_REPORT_RANGE_MS);
  const inRange = { $gte: start, $lt: end };
  const baseQty = (line) => ({ $multiply: [`${line}.quantity`, { $ifNull: [`${line}.packSize`, 1] }] });
  const [sold, returned] = await Promise.all([
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
    ]),
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
    ]),
  ]);

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

router.post('/', async (req, res) => {
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

  // Prices always come from the database, never from the client
  const ids = [...new Set([...merged.values()].map((l) => l.id))];
  const products = await Product.find({ _id: { $in: ids } }).lean();
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
      lineTotal: money(unitPrice * quantity),
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

  const taken = await takeFromStock(products, baseQuantities);
  let sale;
  try {
    sale = await Sale.create({
      number: await nextSequence('sale'),
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
    await putBackInStock(taken);
    throw err;
  }
  const customerBalance = customer ? await DebtEntry.balanceOf(customer._id) : undefined;
  res.status(201).json({ ...sale.toObject(), customerBalance });
});

/* Returns */

// Body { items: [{ line, quantity }] } returns quantities of invoice lines (by index, in
// each line's sold unit). Without items, everything not yet returned comes back: the
// whole sale is cancelled.
router.post('/:id/returns', async (req, res) => {
  const sale = await Sale.findById(req.params.id);
  if (!sale) throw httpError(404, 'الفاتورة غير موجودة');

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
      amount: money(share(item.lineTotal, item, after) - share(item.lineTotal, item, before)),
    };
  });
  const entry = {
    at: new Date(),
    items,
    amount: money(items.reduce((sum, i) => sum + i.amount, 0)),
    cost: money(cost),
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
  await sale.save();

  // Back on the shelf in pieces or kg: a returned box puts all its pieces back
  await putBackInStock(lines.map(({ item, quantity }) => [item.product, roundQty(quantity * (item.packSize ?? 1))]));
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
    sale,
    refunded: money(entry.amount - entry.toAccount), // cash back to the customer
    toAccount: entry.toAccount,
    customerName: sale.customerName,
  });
});

export default router;
