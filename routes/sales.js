import { Router } from 'express';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Sale from '../models/Sale.js';
import Expense from '../models/Expense.js';
import Customer from '../models/Customer.js';
import DebtEntry from '../models/DebtEntry.js';
import { nextSequence } from '../models/Counter.js';
import { httpError } from '../lib/errors.js';
import { money, roundQty } from '../lib/util.js';
import { DAY_MS, requestedRange, timeZoneParam } from '../lib/range.js';

const router = Router();
const MAX_QUANTITY = 10000;
const MAX_LIST_RANGE_MS = 31 * DAY_MS;
const MAX_REPORT_RANGE_MS = 3 * 366 * DAY_MS;
const GROUP_FORMATS = { day: '%Y-%m-%d', month: '%Y-%m' };

// Sales made before returns existed have no return fields
const RETURNED_TOTAL = { $ifNull: ['$returnedTotal', 0] };
const RETURNED_COST = { $ifNull: ['$returnedCost', 0] };
const ITEM_KEPT_QTY = { $subtract: ['$items.quantity', { $ifNull: ['$items.returnedQuantity', 0] }] };
// In pieces or kg: a wholesale box of 10 sold twice is 20 pieces
const ITEM_KEPT_BASE = { $multiply: [ITEM_KEPT_QTY, { $ifNull: ['$items.packSize', 1] }] };

// Of what a credit sale put on the customer's account, the part not taken back by returns
const CREDIT_LEFT = { $subtract: [{ $ifNull: ['$debt', 0] }, { $sum: '$returns.toAccount' }] };
const creditLeft = (sale) => (sale.debt ?? 0) - (sale.returns ?? []).reduce((sum, r) => sum + (r.toAccount ?? 0), 0);

// What an invoice still counts for after its returns
function netOf(sale) {
  const returnedTotal = sale.returnedTotal ?? 0;
  const returnedCost = sale.returnedCost ?? 0;
  return {
    count: sale.returnStatus === 'full' ? 0 : 1,
    total: sale.total - returnedTotal,
    cost: sale.cost - returnedCost,
    profit: sale.profit - (returnedTotal - returnedCost),
    returns: returnedTotal,
    credit: creditLeft(sale),
  };
}

const summarize = (rows) =>
  rows.reduce(
    (acc, row) => ({
      count: acc.count + row.count,
      total: money(acc.total + row.total),
      cost: money(acc.cost + row.cost),
      profit: money(acc.profit + row.profit),
      returns: money(acc.returns + row.returns),
      credit: money(acc.credit + row.credit),
    }),
    { count: 0, total: 0, cost: 0, profit: 0, returns: 0, credit: 0 },
  );

// Net profit counts only money that came in: profit on sales, minus expenses, minus what
// was sold on credit and is still owed, plus debt payments collected in the period.
// Over time it adds up to the profit on sales minus expenses.
const netProfitOf = ({ profit, credit }, expenses, collected) => money(profit - expenses - credit + collected);
const withNet = (summary, expenses, collected) => ({
  ...summary,
  expenses: money(expenses),
  collected: money(collected),
  netProfit: netProfitOf(summary, expenses, collected),
});

/* Stock */

async function putBackInStock(entries) {
  if (!entries.length) return;
  await Product.bulkWrite(
    entries.map(([id, quantity]) => ({
      updateOne: { filter: { _id: id, trackStock: true }, update: { $inc: { stock: quantity } } },
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
    const { modifiedCount } = await Product.updateOne(filter, { $inc: { stock: -quantity } });
    if (!modifiedCount) {
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

// Invoices of one day (or a short range), newest first
router.get('/', async (req, res) => {
  const { start, end } = requestedRange(req.query, MAX_LIST_RANGE_MS);
  const [sales, expenses, collected] = await Promise.all([
    Sale.find({ createdAt: { $gte: start, $lt: end } }).sort({ createdAt: -1 }).lean(),
    Expense.totalBetween(start, end),
    DebtEntry.collectedBetween(start, end),
  ]);
  res.json({ summary: withNet(summarize(sales.map(netOf)), expenses, collected), sales });
});

// Totals for a month or any period, broken down by day or by month
router.get('/report', async (req, res) => {
  const { start, end } = requestedRange(req.query, MAX_REPORT_RANGE_MS);
  const groupBy = req.query.groupBy === 'month' ? 'month' : 'day';
  const timezone = timeZoneParam(req.query.tz);
  const format = GROUP_FORMATS[groupBy];
  const salesRows = Sale.aggregate([
    { $match: { createdAt: { $gte: start, $lt: end } } },
    {
      $group: {
        _id: { $dateToString: { format, date: '$createdAt', timezone } },
        count: { $sum: { $cond: [{ $eq: ['$returnStatus', 'full'] }, 0, 1] } },
        // Pieces only: weights are not pieces
        pieces: {
          $sum: {
            $sum: {
              $map: {
                input: '$items',
                as: 'i',
                in: {
                  $cond: [
                    { $eq: ['$$i.unit', 'kg'] },
                    0,
                    {
                      $multiply: [
                        { $subtract: ['$$i.quantity', { $ifNull: ['$$i.returnedQuantity', 0] }] },
                        { $ifNull: ['$$i.packSize', 1] },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        total: { $sum: { $subtract: ['$total', RETURNED_TOTAL] } },
        cost: { $sum: { $subtract: ['$cost', RETURNED_COST] } },
        profit: { $sum: { $subtract: ['$profit', { $subtract: [RETURNED_TOTAL, RETURNED_COST] }] } },
        returns: { $sum: RETURNED_TOTAL },
        credit: { $sum: CREDIT_LEFT },
      },
    },
  ]);
  const expenseRows = Expense.aggregate([
    { $match: { date: { $gte: start, $lt: end } } },
    { $group: { _id: { $dateToString: { format, date: '$date', timezone } }, expenses: { $sum: '$amount' } } },
  ]);
  const collectedRows = DebtEntry.aggregate([
    { $match: { kind: 'payment', date: { $gte: start, $lt: end } } },
    { $group: { _id: { $dateToString: { format, date: '$date', timezone } }, paid: { $sum: '$amount' } } },
  ]);

  // One row per day or month that had sales, expenses, debt payments or any mix
  const byKey = new Map();
  const periodFor = (key) => {
    if (!byKey.has(key)) {
      byKey.set(key, { key, count: 0, pieces: 0, total: 0, cost: 0, profit: 0, returns: 0, credit: 0, expenses: 0, collected: 0 });
    }
    return byKey.get(key);
  };
  const [salesData, expenseData, collectedData] = await Promise.all([salesRows, expenseRows, collectedRows]);
  for (const { _id, total, cost, profit, returns, credit, ...rest } of salesData) {
    Object.assign(periodFor(_id), rest, {
      total: money(total),
      cost: money(cost),
      profit: money(profit),
      returns: money(returns),
      credit: money(credit),
    });
  }
  for (const { _id, expenses } of expenseData) periodFor(_id).expenses = money(expenses);
  for (const { _id, paid } of collectedData) periodFor(_id).collected = money(-paid);

  const periods = [...byKey.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((p) => ({ ...p, netProfit: netProfitOf(p, p.expenses, p.collected) }));
  const sum = (field) => periods.reduce((total, p) => total + p[field], 0);
  res.json({ groupBy, summary: withNet(summarize(periods), sum('expenses'), sum('collected')), periods });
});

// Per-product totals for a period, from the prices stored on each invoice at the time of sale
router.get('/products', async (req, res) => {
  const { start, end } = requestedRange(req.query, MAX_REPORT_RANGE_MS);
  const rows = await Sale.aggregate([
    { $match: { createdAt: { $gte: start, $lt: end } } },
    // Oldest first, so $last picks the product's most recent name
    { $sort: { createdAt: 1 } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.product',
        name: { $last: '$items.name' },
        barcode: { $last: '$items.barcode' },
        unit: { $last: { $ifNull: ['$items.unit', 'piece'] } },
        invoices: { $sum: { $cond: [{ $gt: [ITEM_KEPT_QTY, 0] }, 1, 0] } },
        quantity: { $sum: ITEM_KEPT_BASE },
        total: { $sum: { $multiply: ['$items.unitPrice', ITEM_KEPT_QTY] } },
        cost: { $sum: { $multiply: ['$items.unitCost', ITEM_KEPT_QTY] } },
      },
    },
    // Fully returned products did not really sell
    { $match: { quantity: { $gt: 0 } } },
  ]);
  res.json(
    rows.map(({ _id, total, cost, quantity, ...rest }) => ({
      product: _id,
      ...rest,
      quantity: roundQty(quantity),
      total: money(total),
      cost: money(cost),
      profit: money(total - cost),
    })),
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
    const quantity = Number(line?.quantity);
    if (!mongoose.isObjectIdOrHexString(id)) throw httpError(400, 'الفاتورة تحتوي على منتج غير صالح');
    if (!(quantity > 0)) throw httpError(400, 'الكمية يجب أن تكون أكبر من صفر');
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
    if (wholesale && !p.hasWholesale) throw httpError(400, `«${p.name}» ليس له سعر جملة`);
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
      unitCost: money(p.purchasePrice * packSize),
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
  const cost = money(items.reduce((sum, i) => sum + i.unitCost * i.quantity, 0));
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

  const entry = {
    at: new Date(),
    items: lines.map(({ item, quantity }) => ({
      product: item.product,
      name: item.name,
      unit: item.unit,
      mode: item.mode,
      packSize: item.packSize,
      quantity,
      amount: money(item.unitPrice * quantity),
    })),
    cost: money(lines.reduce((sum, { item, quantity }) => sum + item.unitCost * quantity, 0)),
  };
  entry.amount = money(entry.items.reduce((sum, i) => sum + i.amount, 0));

  // On a credit sale the refund first comes off the customer's debt, up to what was put
  // on credit; anything beyond that is paid back in cash
  entry.toAccount = 0;
  if (sale.paymentType === 'credit' && sale.customer) {
    const alreadyToAccount = sale.returns.reduce((sum, r) => sum + (r.toAccount ?? 0), 0);
    entry.toAccount = money(Math.min(entry.amount, Math.max(0, (sale.debt ?? 0) - alreadyToAccount)));
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
