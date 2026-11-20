import { Router } from 'express';
import { httpError } from '../lib/errors.js';
import { money, roundQty } from '../lib/util.js';
import { addStock, commitInventory, inventoryOf, inventoryWrite, takeStock } from '../lib/inventory.js';
import { lotCost } from '../public/js/stock-cost.js';
import { allow, stockCountFor } from '../lib/permissions.js';

const router = Router();

async function findOpenCount(StockCount, id) {
  const count = await StockCount.findById(id).lean();
  if (!count) throw httpError(404, 'الجرد غير موجود');
  if (count.status !== 'open') throw httpError(409, 'هذا الجرد اعتُمد من قبل');
  return count;
}

function stockAdjustment(product, line) {
  const difference = roundQty(line.counted - (line.expected ?? 0));
  const unitCost = line.purchasePrice ?? product.purchasePrice;
  const set = { ...inventoryOf(product), trackStock: true };
  if (!product.trackStock) {
    const opening = line.expected === null ? 0 : set.stock;
    set.stock = Math.min(opening, 0);
    if (opening > 0) addStock(set, opening, product.purchasePrice);
  }
  const value = difference < 0 ? -lotCost(takeStock(set, -difference, unitCost)) : difference * unitCost;
  if (difference > 0) addStock(set, difference, unitCost);
  return { set, adjustmentValue: money(value) };
}

// Stocktakes are part of `products`; their values (at purchase price) are left out without
// `reports` (lib/permissions.js)

// Past stocktakes, newest first, without their lines
router.get('/', allow('products'), async (req, res) => {
  const { StockCount } = req.models;
  const counts = await StockCount.find({ status: 'applied' }).sort({ appliedAt: -1 }).select('-lines').lean();
  res.json(counts.map((c) => stockCountFor(req.user, c)));
});

// The stocktake in progress, or null
router.get('/current', allow('products'), async (req, res) => {
  const { StockCount } = req.models;
  res.json(stockCountFor(req.user, await StockCount.findOne({ status: 'open' }).lean()));
});

router.get('/:id', allow('products'), async (req, res) => {
  const { StockCount } = req.models;
  const count = await StockCount.findById(req.params.id).lean();
  if (!count) throw httpError(404, 'الجرد غير موجود');
  res.json(stockCountFor(req.user, count));
});

router.post('/', allow('products'), async (req, res) => {
  const { StockCount } = req.models;
  if (await StockCount.exists({ status: 'open' })) throw httpError(409, 'يوجد جرد مفتوح. أكمله أو ألغِه أولًا');
  res.status(201).json(stockCountFor(req.user, await StockCount.create({})));
});

// Records how many of a product are on the shelf, replacing an earlier count of it
router.put('/:id/lines/:productId', allow('products'), inventoryWrite(async (req, res) => {
  const { Product, StockCount } = req.models;
  const count = await findOpenCount(StockCount, req.params.id);
  const product = await Product.findById(req.params.productId).lean();
  if (!product) throw httpError(404, 'المنتج غير موجود');
  const raw = req.body.counted;
  const counted = Number(raw);
  if (raw === null || raw === '' || !Number.isFinite(counted) || counted < 0) {
    throw httpError(400, 'أدخل العدد الموجود، صفر أو أكثر');
  }
  const unit = product.unit ?? 'piece';
  if (unit === 'piece' && !Number.isInteger(counted)) throw httpError(400, 'العدد يجب أن يكون عددًا صحيحًا من القطع');

  const line = {
    product: product._id,
    name: product.name,
    barcode: product.barcode,
    unit,
    category: product.category,
    expected: product.trackStock ? product.stock : null,
    counted: roundQty(counted),
    purchasePrice: product.purchasePrice,
    salePrice: product.salePrice,
    countedAt: new Date(),
  };
  if (line.expected !== null) line.adjustmentValue = stockAdjustment(product, line).adjustmentValue;
  const replaced = await StockCount.updateOne(
    { _id: count._id, status: 'open', 'lines.product': product._id },
    { $set: { 'lines.$': line } },
  );
  if (!replaced.matchedCount) {
    const added = await StockCount.updateOne(
      { _id: count._id, status: 'open', 'lines.product': { $ne: product._id } },
      { $push: { lines: line } },
    );
    if (!added.matchedCount) throw httpError(409, 'تغيّر الجرد في نفس اللحظة. حدّث الصفحة وأعد المحاولة');
  }
  res.json(stockCountFor(req.user, { lines: [line] }).lines[0]);
}));

router.delete('/:id/lines/:productId', allow('products'), inventoryWrite(async (req, res) => {
  const { StockCount } = req.models;
  const count = await findOpenCount(StockCount, req.params.id);
  await StockCount.updateOne({ _id: count._id, status: 'open' }, { $pull: { lines: { product: req.params.productId } } });
  res.status(204).end();
}));

// Corrects the stock of every counted product and keeps the stocktake as a record.
// Products that were not counted keep their quantities.
router.post('/:id/apply', allow('products'), inventoryWrite(async (req, res) => {
  const { Product, StockCount } = req.models;
  const open = await findOpenCount(StockCount, req.params.id);
  if (!open.lines.length) throw httpError(400, 'لم يُعدّ أي منتج بعد');
  const products = await Product.find({ _id: { $in: open.lines.map((line) => line.product) } }).lean();
  const byId = new Map(products.map((product) => [String(product._id), product]));
  const summary = { counted: open.lines.length, shortItems: 0, shortValue: 0, overItems: 0, overValue: 0, newlyTracked: 0 };
  const changes = [];
  for (const line of open.lines) {
    const product = byId.get(String(line.product));
    if (!product) continue;
    const { set, adjustmentValue } = stockAdjustment(product, line);
    changes.push({ product, set });
    if (line.expected === null) {
      summary.newlyTracked++;
      continue;
    }
    line.adjustmentValue = adjustmentValue;
    if (line.counted < line.expected) {
      summary.shortItems++;
      summary.shortValue -= adjustmentValue;
    } else if (line.counted > line.expected) {
      summary.overItems++;
      summary.overValue += adjustmentValue;
    }
  }
  const undoStock = await commitInventory(Product, changes);
  let count;
  try {
    const { capital, saleValue } = await Product.valuation();
    Object.assign(summary, { shortValue: money(summary.shortValue), overValue: money(summary.overValue), capital, saleValue });
    count = await StockCount.findOneAndUpdate(
      { _id: open._id, status: 'open' },
      { $set: { status: 'applied', appliedAt: new Date(), lines: open.lines, summary } },
      { returnDocument: 'after' },
    ).lean();
    if (!count) throw httpError(409, 'هذا الجرد اعتُمد من قبل');
  } catch (err) {
    await undoStock();
    throw err;
  }
  res.json(stockCountFor(req.user, count));
}));

// Throws the stocktake away; nothing in the stock has changed yet, so it is part of counting
// rather than deleting a record
router.delete('/:id', allow('products'), inventoryWrite(async (req, res) => {
  const { StockCount } = req.models;
  const { deletedCount } = await StockCount.deleteOne({ _id: req.params.id, status: 'open' });
  if (!deletedCount) await findOpenCount(StockCount, req.params.id);
  res.status(204).end();
}));

export default router;
