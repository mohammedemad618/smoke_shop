import { Router } from 'express';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Purchase from '../models/Purchase.js';
import { nextSequence } from '../models/Counter.js';
import { httpError } from '../lib/errors.js';
import { money, roundQty } from '../lib/util.js';
import { DAY_MS, requestedRange } from '../lib/range.js';

const router = Router();
const MAX_RANGE_MS = 3 * 366 * DAY_MS;
const MAX_ITEMS = 300;

const withRemaining = (p) => ({ ...p, remaining: p.status === 'active' ? money(p.total - p.paid) : 0 });

function parseDate(value, label) {
  if (value === undefined || value === null || value === '') return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw httpError(400, `${label} غير صالح`);
  return date;
}

// Builds an invoice line from what the form sent, checked against the product
function buildItem(raw, product) {
  const unit = product.unit ?? 'piece';
  const byPack = raw.mode === 'pack';
  if (byPack && !(product.hasWholesale && product.wholesaleQty > 0)) {
    throw httpError(400, `«${product.name}» ليس له علبة أو كيس محدد. اشترِه بالمفرد`);
  }
  const packSize = byPack ? product.wholesaleQty : 1;
  const quantity = Number(raw.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) throw httpError(400, `أدخل كمية «${product.name}»`);
  if ((byPack || unit === 'piece') && !Number.isInteger(quantity)) {
    throw httpError(400, `كمية «${product.name}» يجب أن تكون عددًا صحيحًا`);
  }
  const price = Number(raw.price);
  if (raw.price === '' || raw.price === null || !Number.isFinite(price) || price < 0) {
    throw httpError(400, `أدخل سعر شراء «${product.name}»`);
  }
  let salePrice = null;
  if (raw.salePrice !== undefined && raw.salePrice !== null && raw.salePrice !== '') {
    const value = Number(raw.salePrice);
    if (!Number.isFinite(value) || value < 0) throw httpError(400, `سعر بيع «${product.name}» غير صالح`);
    if (value !== product.salePrice) salePrice = money(value);
  }
  return {
    product: product._id,
    name: product.name,
    barcode: product.barcode,
    unit,
    mode: byPack ? 'pack' : 'unit',
    packSize,
    quantity: roundQty(quantity),
    price: money(price),
    total: money(quantity * price),
    stockQty: roundQty(quantity * packSize),
    unitCost: money(price / packSize),
    priceUpdated: price > 0,
    prevPurchasePrice: product.purchasePrice,
    salePrice,
    prevSalePrice: product.salePrice,
    startedTracking: !product.trackStock,
  };
}

// Puts the goods into the stock and makes the invoice's prices the products' prices.
// A product whose quantity was not tracked starts from what was bought.
function stockUpdates(items) {
  return items.map((item) => {
    const set = { trackStock: true };
    if (item.priceUpdated) set.purchasePrice = item.unitCost;
    if (item.salePrice !== null) set.salePrice = item.salePrice;
    const update = item.startedTracking ? { $set: { ...set, stock: item.stockQty } } : { $set: set, $inc: { stock: item.stockQty } };
    return { updateOne: { filter: { _id: item.product }, update } };
  });
}

// Takes the goods back out, and puts back the prices the invoice set if nobody has
// changed them since. Products bought again on a later invoice keep that invoice's prices.
function undoUpdates(items, laterBought = new Set()) {
  return items.flatMap((item) => {
    const ops = [{ updateOne: { filter: { _id: item.product }, update: { $inc: { stock: -item.stockQty } } } }];
    if (laterBought.has(String(item.product))) return ops;
    if (item.priceUpdated && item.unitCost !== item.prevPurchasePrice) {
      ops.push({
        updateOne: {
          filter: { _id: item.product, purchasePrice: item.unitCost },
          update: { $set: { purchasePrice: item.prevPurchasePrice } },
        },
      });
    }
    if (item.salePrice !== null) {
      ops.push({
        updateOne: {
          filter: { _id: item.product, salePrice: item.salePrice },
          update: { $set: { salePrice: item.prevSalePrice } },
        },
      });
    }
    return ops;
  });
}

// Invoices of a period (?from=&to=), newest first, with the period's totals and what is
// owed to suppliers over all invoices
router.get('/', async (req, res) => {
  const { start, end } = requestedRange(req.query, MAX_RANGE_MS);
  const [purchases, owedToSuppliers] = await Promise.all([
    Purchase.find({ date: { $gte: start, $lt: end } }).sort({ date: -1, number: -1 }).lean(),
    Purchase.owedToSuppliers(),
  ]);
  const active = purchases.filter((p) => p.status === 'active');
  const total = money(active.reduce((sum, p) => sum + p.total, 0));
  const paid = money(active.reduce((sum, p) => sum + p.paid, 0));
  res.json({ count: active.length, total, paid, remaining: money(total - paid), owedToSuppliers, purchases: purchases.map(withRemaining) });
});

// Suppliers bought from before, most recent first, with what is still owed to each
router.get('/suppliers', async (req, res) => {
  const rows = await Purchase.aggregate([
    { $match: { supplier: { $ne: '' } } },
    {
      $group: {
        _id: '$supplier',
        last: { $max: '$date' },
        owed: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, { $subtract: ['$total', '$paid'] }, 0] } },
      },
    },
    { $sort: { last: -1 } },
    { $limit: 200 },
  ]);
  res.json(rows.map((r) => ({ name: r._id, owed: money(r.owed), last: r.last })));
});

router.get('/:id', async (req, res) => {
  const purchase = await Purchase.findById(req.params.id).lean();
  if (!purchase) throw httpError(404, 'فاتورة الشراء غير موجودة');
  res.json(withRemaining(purchase));
});

router.post('/', async (req, res) => {
  const body = req.body;
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!rawItems.length) throw httpError(400, 'أضف منتجًا واحدًا على الأقل إلى الفاتورة');
  if (rawItems.length > MAX_ITEMS) throw httpError(400, `الفاتورة تتسع لـ ${MAX_ITEMS} صنف كحد أقصى`);
  const ids = rawItems.map((i) => String(i.product ?? ''));
  if (ids.some((id) => !mongoose.isObjectIdOrHexString(id))) throw httpError(400, 'منتج غير صالح في الفاتورة');
  const products = await Product.find({ _id: { $in: ids } }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const items = rawItems.map((raw, i) => {
    const product = byId.get(ids[i]);
    if (!product) throw httpError(400, 'أحد منتجات الفاتورة حُذف. أزله وأعد المحاولة');
    return buildItem(raw, product);
  });
  // A product on two lines (boxes and loose pieces) starts its tracking only once
  const seen = new Set();
  for (const item of items) {
    if (seen.has(String(item.product))) item.startedTracking = false;
    seen.add(String(item.product));
  }

  const total = money(items.reduce((sum, item) => sum + item.total, 0));
  const paid = body.paid === undefined || body.paid === null || body.paid === '' ? total : Number(body.paid);
  if (!Number.isFinite(paid) || paid < 0) throw httpError(400, 'أدخل المبلغ المدفوع للمورد');
  if (paid > total) throw httpError(400, 'المدفوع أكبر من إجمالي الفاتورة');
  const date = parseDate(body.date, 'تاريخ الفاتورة');

  await Product.bulkWrite(stockUpdates(items));
  try {
    const purchase = await Purchase.create({
      number: await nextSequence('purchase'),
      date,
      supplier: body.supplier ?? '',
      reference: body.reference ?? '',
      note: body.note ?? '',
      items,
      total,
      paid: money(paid),
      payments: paid > 0 ? [{ amount: money(paid), date }] : [],
    });
    res.status(201).json(withRemaining(purchase.toObject()));
  } catch (err) {
    await Product.bulkWrite(undoUpdates(items));
    throw err;
  }
});

// Pays off part or all of what is owed on an invoice
router.post('/:id/payments', async (req, res) => {
  const purchase = await Purchase.findById(req.params.id);
  if (!purchase) throw httpError(404, 'فاتورة الشراء غير موجودة');
  if (purchase.status !== 'active') throw httpError(409, 'هذه الفاتورة ملغاة');
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'أدخل مبلغًا أكبر من صفر');
  const remaining = money(purchase.total - purchase.paid);
  if (money(amount) > remaining) throw httpError(400, `المتبقي على هذه الفاتورة ${remaining} فقط`);
  purchase.payments.push({ amount: money(amount), date: parseDate(req.body.date, 'تاريخ الدفع') });
  purchase.paid = money(purchase.paid + amount);
  await purchase.save();
  res.json(withRemaining(purchase.toObject()));
});

// Cancels an invoice entered by mistake or returned to the supplier: its goods leave
// the stock again. Money already paid is between the shop and the supplier.
router.post('/:id/cancel', async (req, res) => {
  const purchase = await Purchase.findOneAndUpdate(
    { _id: req.params.id, status: 'active' },
    { $set: { status: 'cancelled', cancelledAt: new Date() }, $inc: { __v: 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (!purchase) {
    if (!(await Purchase.exists({ _id: req.params.id }))) throw httpError(404, 'فاتورة الشراء غير موجودة');
    throw httpError(409, 'هذه الفاتورة ملغاة من قبل');
  }
  const later = await Purchase.find(
    { status: 'active', createdAt: { $gt: purchase.createdAt }, 'items.product': { $in: purchase.items.map((i) => i.product) } },
    'items.product',
  ).lean();
  const laterBought = new Set(later.flatMap((p) => p.items.map((i) => String(i.product))));
  await Product.bulkWrite(undoUpdates(purchase.items, laterBought));
  res.json(withRemaining(purchase));
});

export default router;
