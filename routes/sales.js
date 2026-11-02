import { Router } from 'express';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Sale from '../models/Sale.js';
import { nextSequence } from '../models/Counter.js';
import { httpError } from '../lib/errors.js';
import { money } from '../lib/util.js';

const router = Router();
const MAX_QUANTITY = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LIST_RANGE_MS = 31 * DAY_MS;
const MAX_REPORT_RANGE_MS = 3 * 366 * DAY_MS;
const GROUP_FORMATS = { day: '%Y-%m-%d', month: '%Y-%m' };

// Sales made before returns existed have no return fields
const RETURNED_TOTAL = { $ifNull: ['$returnedTotal', 0] };
const RETURNED_COST = { $ifNull: ['$returnedCost', 0] };
const ITEM_KEPT_QTY = { $subtract: ['$items.quantity', { $ifNull: ['$items.returnedQuantity', 0] }] };

// The browser sends its own midnight-to-midnight range as ?from=&to= (ISO), so a day
// follows the shop's clock even when the server runs in UTC. Without them, fall back
// to today on the server's clock.
function requestedRange({ from, to }, maxMs) {
  const start = new Date(String(from ?? ''));
  const end = new Date(String(to ?? ''));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { start: today, end: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1) };
  }
  if (end <= start || end - start > maxMs) throw httpError(400, 'نطاق التاريخ غير صالح');
  return { start, end };
}

// IANA name from the browser (e.g. Asia/Baghdad), used to cut periods at local midnight
function timeZoneParam(value) {
  const timeZone = String(value ?? 'UTC');
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return timeZone;
  } catch {
    throw httpError(400, 'المنطقة الزمنية غير صالحة');
  }
}

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
    }),
    { count: 0, total: 0, cost: 0, profit: 0, returns: 0 },
  );

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
  const sales = await Sale.find({ createdAt: { $gte: start, $lt: end } }).sort({ createdAt: -1 }).lean();
  res.json({ summary: summarize(sales.map(netOf)), sales });
});

// Totals for a month or any period, broken down by day or by month
router.get('/report', async (req, res) => {
  const { start, end } = requestedRange(req.query, MAX_REPORT_RANGE_MS);
  const groupBy = req.query.groupBy === 'month' ? 'month' : 'day';
  const timezone = timeZoneParam(req.query.tz);
  const rows = await Sale.aggregate([
    { $match: { createdAt: { $gte: start, $lt: end } } },
    {
      $group: {
        _id: { $dateToString: { format: GROUP_FORMATS[groupBy], date: '$createdAt', timezone } },
        count: { $sum: { $cond: [{ $eq: ['$returnStatus', 'full'] }, 0, 1] } },
        pieces: {
          $sum: {
            $sum: {
              $map: {
                input: '$items',
                as: 'i',
                in: { $subtract: ['$$i.quantity', { $ifNull: ['$$i.returnedQuantity', 0] }] },
              },
            },
          },
        },
        total: { $sum: { $subtract: ['$total', RETURNED_TOTAL] } },
        cost: { $sum: { $subtract: ['$cost', RETURNED_COST] } },
        profit: { $sum: { $subtract: ['$profit', { $subtract: [RETURNED_TOTAL, RETURNED_COST] }] } },
        returns: { $sum: RETURNED_TOTAL },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  const periods = rows.map(({ _id, total, cost, profit, returns, ...rest }) => ({
    key: _id,
    ...rest,
    total: money(total),
    cost: money(cost),
    profit: money(profit),
    returns: money(returns),
  }));
  res.json({ groupBy, summary: summarize(periods), periods });
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
        invoices: { $sum: { $cond: [{ $gt: [ITEM_KEPT_QTY, 0] }, 1, 0] } },
        quantity: { $sum: ITEM_KEPT_QTY },
        total: { $sum: { $multiply: ['$items.unitPrice', ITEM_KEPT_QTY] } },
        cost: { $sum: { $multiply: ['$items.unitCost', ITEM_KEPT_QTY] } },
      },
    },
    // Fully returned products did not really sell
    { $match: { quantity: { $gt: 0 } } },
  ]);
  res.json(
    rows.map(({ _id, total, cost, ...rest }) => ({
      product: _id,
      ...rest,
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

  // Merge repeated lines of the same product, keeping cart order
  const quantities = new Map();
  for (const line of lines) {
    const id = String(line?.productId ?? '');
    const quantity = Number(line?.quantity);
    if (!mongoose.isObjectIdOrHexString(id)) throw httpError(400, 'الفاتورة تحتوي على منتج غير صالح');
    if (!Number.isInteger(quantity) || quantity < 1) throw httpError(400, 'الكمية يجب أن تكون عددًا صحيحًا موجبًا');
    quantities.set(id, (quantities.get(id) ?? 0) + quantity);
  }
  if ([...quantities.values()].some((q) => q > MAX_QUANTITY)) {
    throw httpError(400, `أقصى كمية للصنف الواحد ${MAX_QUANTITY}`);
  }

  // Prices always come from the database, never from the client
  const products = await Product.find({ _id: { $in: [...quantities.keys()] } }).lean();
  if (products.length !== quantities.size) {
    throw httpError(400, 'بعض منتجات الفاتورة لم تعد موجودة. حدّث الصفحة وأعد المحاولة');
  }
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const items = [...quantities].map(([id, quantity]) => {
    const p = byId.get(id);
    return {
      product: p._id,
      name: p.name,
      barcode: p.barcode,
      quantity,
      unitPrice: p.salePrice,
      unitCost: p.purchasePrice,
      lineTotal: money(p.salePrice * quantity),
    };
  });

  const total = money(items.reduce((sum, i) => sum + i.lineTotal, 0));
  const cost = money(items.reduce((sum, i) => sum + i.unitCost * i.quantity, 0));
  const paidInput = req.body.paid;
  const paid = paidInput === undefined || paidInput === null || paidInput === '' ? total : money(paidInput);
  if (!Number.isFinite(paid) || paid < total) throw httpError(400, 'المبلغ المدفوع أقل من إجمالي الفاتورة');

  const taken = await takeFromStock(products, quantities);
  try {
    const sale = await Sale.create({
      number: await nextSequence('sale'),
      items,
      total,
      cost,
      profit: money(total - cost),
      paid,
      change: money(paid - total),
    });
    res.status(201).json(sale);
  } catch (err) {
    await putBackInStock(taken);
    throw err;
  }
});

/* Returns */

// Body { items: [{ productId, quantity }] } returns those quantities. Without items,
// everything not yet returned comes back: the whole sale is cancelled.
router.post('/:id/returns', async (req, res) => {
  const sale = await Sale.findById(req.params.id);
  if (!sale) throw httpError(404, 'الفاتورة غير موجودة');

  const requested = Array.isArray(req.body.items) ? req.body.items : null;
  const lines = [];
  for (const item of sale.items) {
    const left = item.quantity - (item.returnedQuantity ?? 0);
    const asked = requested
      ? Number(requested.find((r) => String(r?.productId) === String(item.product))?.quantity ?? 0)
      : left;
    if (!Number.isInteger(asked) || asked < 0) throw httpError(400, 'الكمية المرتجعة يجب أن تكون عددًا صحيحًا');
    if (asked > left) throw httpError(400, `أقصى ما يمكن إرجاعه من «${item.name}» ${left}`);
    if (asked > 0) lines.push({ item, quantity: asked });
  }
  if (!lines.length) {
    throw httpError(400, sale.returnStatus === 'full' ? 'هذه الفاتورة مرتجعة بالكامل' : 'حدّد كمية واحدة على الأقل للإرجاع');
  }

  const entry = {
    at: new Date(),
    items: lines.map(({ item, quantity }) => ({
      product: item.product,
      name: item.name,
      quantity,
      amount: money(item.unitPrice * quantity),
    })),
    cost: money(lines.reduce((sum, { item, quantity }) => sum + item.unitCost * quantity, 0)),
  };
  entry.amount = money(entry.items.reduce((sum, i) => sum + i.amount, 0));

  for (const { item, quantity } of lines) item.returnedQuantity = (item.returnedQuantity ?? 0) + quantity;
  sale.returns.push(entry);
  sale.returnedTotal = money((sale.returnedTotal ?? 0) + entry.amount);
  sale.returnedCost = money((sale.returnedCost ?? 0) + entry.cost);
  sale.returnStatus = sale.items.every((i) => i.returnedQuantity >= i.quantity) ? 'full' : 'partial';
  await sale.save();

  await putBackInStock(lines.map(({ item, quantity }) => [item.product, quantity]));
  res.status(201).json({ sale, refunded: entry.amount });
});

export default router;
