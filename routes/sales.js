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

const summarize = (rows) =>
  rows.reduce(
    (acc, row) => ({
      count: acc.count + (row.count ?? 1),
      total: money(acc.total + row.total),
      cost: money(acc.cost + row.cost),
      profit: money(acc.profit + row.profit),
    }),
    { count: 0, total: 0, cost: 0, profit: 0 },
  );

// Invoices of one day (or a short range), newest first
router.get('/', async (req, res) => {
  const { start, end } = requestedRange(req.query, MAX_LIST_RANGE_MS);
  const sales = await Sale.find({ createdAt: { $gte: start, $lt: end } }).sort({ createdAt: -1 }).lean();
  res.json({ summary: summarize(sales), sales });
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
        count: { $sum: 1 },
        pieces: { $sum: { $sum: '$items.quantity' } },
        total: { $sum: '$total' },
        cost: { $sum: '$cost' },
        profit: { $sum: '$profit' },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  const periods = rows.map(({ _id, total, cost, profit, ...rest }) => ({
    key: _id,
    ...rest,
    total: money(total),
    cost: money(cost),
    profit: money(profit),
  }));
  res.json({ groupBy, summary: summarize(periods), periods });
});

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
});

export default router;
