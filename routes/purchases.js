import { Router } from 'express';
import mongoose from 'mongoose';
import { httpError } from '../lib/errors.js';
import { money, precise, roundQty, stockChange } from '../lib/util.js';
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

// Builds an invoice line from what the form sent, checked against the product. Quantities
// are kept to the gram and prices to the cent, and the line total comes from those.
function buildItem(raw, product) {
  const unit = product.unit ?? 'piece';
  const byPack = raw.mode === 'pack';
  if (byPack && !(product.hasWholesale && product.wholesaleQty > 0)) {
    throw httpError(400, `«${product.name}» ليس له علبة أو كيس محدد. اشترِه بالمفرد`);
  }
  const packSize = byPack ? product.wholesaleQty : 1;
  const quantity = roundQty(Number(raw.quantity));
  if (!Number.isFinite(quantity) || quantity <= 0) throw httpError(400, `أدخل كمية «${product.name}»`);
  if ((byPack || unit === 'piece') && !Number.isInteger(quantity)) {
    throw httpError(400, `كمية «${product.name}» يجب أن تكون عددًا صحيحًا`);
  }
  const rawPrice = Number(raw.price);
  if (raw.price === '' || raw.price === null || !Number.isFinite(rawPrice) || rawPrice < 0) {
    throw httpError(400, `أدخل سعر شراء «${product.name}»`);
  }
  const price = money(rawPrice);
  let salePrice = null;
  if (raw.salePrice !== undefined && raw.salePrice !== null && raw.salePrice !== '') {
    const value = money(Number(raw.salePrice));
    if (!Number.isFinite(value) || value < 0) throw httpError(400, `سعر بيع «${product.name}» غير صالح`);
    if (value !== product.salePrice) salePrice = value;
  }
  return {
    product: product._id,
    name: product.name,
    barcode: product.barcode,
    unit,
    mode: byPack ? 'pack' : 'unit',
    packSize,
    quantity,
    price,
    total: money(quantity * price),
    stockQty: roundQty(quantity * packSize),
    // Per piece or kilo, unrounded to the cent, so a box price shared over its pieces adds back up
    unitCost: precise(price / packSize),
    // A free item (price 0) leaves the purchase price as it was
    priceUpdated: price > 0,
    prevPurchasePrice: product.purchasePrice,
    salePrice,
    prevSalePrice: product.salePrice,
    startedTracking: !product.trackStock,
  };
}

// Puts a line's goods into the stock and makes its prices the product's prices. A product
// whose quantity was not tracked starts from what was bought; if another invoice started it
// in the meantime, this one adds to it instead of overwriting it.
async function receive(Product, item) {
  const set = { trackStock: true };
  if (item.priceUpdated) set.purchasePrice = item.unitCost;
  if (item.salePrice !== null) set.salePrice = item.salePrice;
  if (item.startedTracking) {
    const started = await Product.updateOne({ _id: item.product, trackStock: { $ne: true } }, { $set: { ...set, stock: item.stockQty } });
    if (started.matchedCount) return;
    item.startedTracking = false;
  }
  await Product.updateOne({ _id: item.product }, stockChange(item.stockQty, set), { updatePipeline: true });
}

/*
 * Takes an invoice's goods back out of the stock and puts back the prices it set, when the
 * product still has them (a later edit or invoice wins). The price put back is the one
 * before this invoice, walking past prices that came from invoices cancelled earlier; a
 * newer invoice still standing keeps its price. A product whose tracking this invoice
 * started goes back to untracked, unless a newer invoice or a stocktake has counted it since.
 */
async function giveBack(m, purchase) {
  const { Product, Purchase, StockCount } = m;
  const ids = purchase.items.map((i) => i.product);
  const [products, others, counts] = await Promise.all([
    Product.find({ _id: { $in: ids } }).lean(),
    Purchase.find({ _id: { $ne: purchase._id }, 'items.product': { $in: ids } }, 'status createdAt items').lean(),
    StockCount.find({ status: 'applied', appliedAt: { $gt: purchase.createdAt }, 'lines.product': { $in: ids } }, 'lines.product').lean(),
  ]);
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const countedSince = new Set(counts.flatMap((c) => c.lines.map((l) => String(l.product))));
  const at = purchase.createdAt;

  for (const item of purchase.items) {
    const id = String(item.product);
    const product = byId.get(id);
    if (!product) continue; // deleted since
    const lines = others.flatMap((p) =>
      p.items.filter((i) => String(i.product) === id).map((i) => ({ ...i, status: p.status, createdAt: p.createdAt })),
    );
    const newer = lines.filter((l) => l.status === 'active' && l.createdAt > at);
    const olderCancelled = lines.filter((l) => l.status === 'cancelled' && l.createdAt < at).sort((a, b) => b.createdAt - a.createdAt);
    const restore = (current, mine, before, changedBy, valueOf, beforeOf) => {
      if (current !== mine || newer.some(changedBy)) return undefined;
      let price = before;
      for (const l of olderCancelled) if (changedBy(l) && valueOf(l) === price) price = beforeOf(l);
      return price;
    };

    const set = {};
    if (item.priceUpdated) {
      const price = restore(product.purchasePrice, item.unitCost, item.prevPurchasePrice, (l) => l.priceUpdated, (l) => l.unitCost, (l) => l.prevPurchasePrice);
      if (price !== undefined) set.purchasePrice = price;
    }
    if (item.salePrice !== null && item.salePrice !== undefined) {
      const price = restore(product.salePrice, item.salePrice, item.prevSalePrice, (l) => l.salePrice != null, (l) => l.salePrice, (l) => l.prevSalePrice);
      if (price !== undefined) set.salePrice = price;
    }
    const untrack = item.startedTracking && newer.length === 0 && !countedSince.has(id);
    if (untrack) {
      await Product.updateOne({ _id: item.product }, { $set: { ...set, trackStock: false, stock: 0 } });
    } else {
      await Product.updateOne({ _id: item.product }, stockChange(-item.stockQty, set), { updatePipeline: true });
    }
  }
}

// Invoices of a period (?from=&to=), newest first, with the period's totals and what is
// owed to suppliers over all invoices
router.get('/', async (req, res) => {
  const { Purchase } = req.models;
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
  const { Purchase } = req.models;
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
  const { Purchase } = req.models;
  const purchase = await Purchase.findById(req.params.id).lean();
  if (!purchase) throw httpError(404, 'فاتورة الشراء غير موجودة');
  res.json(withRemaining(purchase));
});

router.post('/', async (req, res) => {
  const { Product, Purchase, Counter } = req.models;
  const body = req.body;
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!rawItems.length) throw httpError(400, 'أضف منتجًا واحدًا على الأقل إلى الفاتورة');
  if (rawItems.length > MAX_ITEMS) throw httpError(400, `الفاتورة تتسع لـ ${MAX_ITEMS} صنف كحد أقصى`);
  const ids = rawItems.map((i) => String(i.product ?? ''));
  if (ids.some((id) => !mongoose.isObjectIdOrHexString(id))) throw httpError(400, 'منتج غير صالح في الفاتورة');
  // One line per product, so the product's new purchase price is not ambiguous
  if (new Set(ids).size !== ids.length) throw httpError(400, 'منتج مكرر في الفاتورة. اجمع كميته في سطر واحد');
  const products = await Product.find({ _id: { $in: ids } }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const items = rawItems.map((raw, i) => {
    const product = byId.get(ids[i]);
    if (!product) throw httpError(400, 'أحد منتجات الفاتورة حُذف. أزله وأعد المحاولة');
    return buildItem(raw, product);
  });

  const total = money(items.reduce((sum, item) => sum + item.total, 0));
  const paid = body.paid === undefined || body.paid === null || body.paid === '' ? total : money(Number(body.paid));
  if (!Number.isFinite(paid) || paid < 0) throw httpError(400, 'أدخل المبلغ المدفوع للمورد');
  if (paid > total) throw httpError(400, 'المدفوع أكبر من إجمالي الفاتورة');
  const date = parseDate(body.date, 'تاريخ الفاتورة');

  const received = [];
  try {
    for (const item of items) {
      await receive(Product, item);
      received.push(item);
    }
    const purchase = await Purchase.create({
      number: await Counter.next('purchase'),
      date,
      supplier: body.supplier ?? '',
      reference: body.reference ?? '',
      note: body.note ?? '',
      items,
      total,
      paid,
      payments: paid > 0 ? [{ amount: paid, date }] : [],
    });
    res.status(201).json(withRemaining(purchase.toObject()));
  } catch (err) {
    // Nothing half done: the goods already put in come back out
    await giveBack(req.models, { _id: new mongoose.Types.ObjectId(), createdAt: new Date(), items: received });
    throw err;
  }
});

// Pays off part or all of what is owed on an invoice
router.post('/:id/payments', async (req, res) => {
  const { Purchase } = req.models;
  const purchase = await Purchase.findById(req.params.id);
  if (!purchase) throw httpError(404, 'فاتورة الشراء غير موجودة');
  if (purchase.status !== 'active') throw httpError(409, 'هذه الفاتورة ملغاة');
  const amount = money(Number(req.body.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'أدخل مبلغًا أكبر من صفر');
  const remaining = money(purchase.total - purchase.paid);
  if (amount > remaining) throw httpError(400, `المتبقي على هذه الفاتورة ${remaining} فقط`);
  purchase.payments.push({ amount, date: parseDate(req.body.date, 'تاريخ الدفع') });
  purchase.paid = money(purchase.paid + amount);
  await purchase.save();
  res.json(withRemaining(purchase.toObject()));
});

// Cancels an invoice entered by mistake or returned to the supplier: its goods leave
// the stock again. Money already paid is between the shop and the supplier.
router.post('/:id/cancel', async (req, res) => {
  const { Purchase } = req.models;
  const purchase = await Purchase.findOneAndUpdate(
    { _id: req.params.id, status: 'active' },
    { $set: { status: 'cancelled', cancelledAt: new Date() }, $inc: { __v: 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (!purchase) {
    if (!(await Purchase.exists({ _id: req.params.id }))) throw httpError(404, 'فاتورة الشراء غير موجودة');
    throw httpError(409, 'هذه الفاتورة ملغاة من قبل');
  }
  await giveBack(req.models, purchase);
  res.json(withRemaining(purchase));
});

export default router;
