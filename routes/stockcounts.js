import { Router } from 'express';
import Product from '../models/Product.js';
import StockCount from '../models/StockCount.js';
import { httpError } from '../lib/errors.js';
import { money, roundQty, stockChange } from '../lib/util.js';

const router = Router();

async function findOpenCount(id) {
  const count = await StockCount.findById(id).lean();
  if (!count) throw httpError(404, 'الجرد غير موجود');
  if (count.status !== 'open') throw httpError(409, 'هذا الجرد اعتُمد من قبل');
  return count;
}

// Past stocktakes, newest first, without their lines
router.get('/', async (req, res) => {
  res.json(await StockCount.find({ status: 'applied' }).sort({ appliedAt: -1 }).select('-lines').lean());
});

// The stocktake in progress, or null
router.get('/current', async (req, res) => {
  res.json(await StockCount.findOne({ status: 'open' }).lean());
});

router.get('/:id', async (req, res) => {
  const count = await StockCount.findById(req.params.id).lean();
  if (!count) throw httpError(404, 'الجرد غير موجود');
  res.json(count);
});

router.post('/', async (req, res) => {
  if (await StockCount.exists({ status: 'open' })) throw httpError(409, 'يوجد جرد مفتوح. أكمله أو ألغِه أولًا');
  res.status(201).json(await StockCount.create({}));
});

// Records how many of a product are on the shelf, replacing an earlier count of it
router.put('/:id/lines/:productId', async (req, res) => {
  const count = await findOpenCount(req.params.id);
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
  res.json(line);
});

router.delete('/:id/lines/:productId', async (req, res) => {
  const count = await findOpenCount(req.params.id);
  await StockCount.updateOne({ _id: count._id, status: 'open' }, { $pull: { lines: { product: req.params.productId } } });
  res.status(204).end();
});

// Corrects the stock of every counted product and keeps the stocktake as a record.
// Products that were not counted keep their quantities.
router.post('/:id/apply', async (req, res) => {
  const open = await findOpenCount(req.params.id);
  if (!open.lines.length) throw httpError(400, 'لم يُعدّ أي منتج بعد');
  const count = await StockCount.findOneAndUpdate(
    { _id: open._id, status: 'open' },
    { $set: { status: 'applied', appliedAt: new Date() } },
    { returnDocument: 'after' },
  ).lean();
  if (!count) throw httpError(409, 'هذا الجرد اعتُمد من قبل');

  // A product counted while untracked may have started being tracked since (a supplier
  // invoice starts it from what was bought); the count is then what was already on the
  // shelf, so it is added rather than overwriting what came in after
  const untrackedIds = count.lines.filter((l) => l.expected === null).map((l) => l.product);
  const trackedSince = new Set(
    (await Product.find({ _id: { $in: untrackedIds }, trackStock: true }, '_id').lean()).map((p) => String(p._id)),
  );
  const summary = { counted: count.lines.length, shortItems: 0, shortValue: 0, overItems: 0, overValue: 0, newlyTracked: 0 };
  const updates = count.lines.map((line) => {
    if (line.expected === null) {
      summary.newlyTracked++;
      if (trackedSince.has(String(line.product))) {
        return { updateOne: { filter: { _id: line.product }, update: stockChange(line.counted) } };
      }
      return {
        updateOne: {
          filter: { _id: line.product, trackStock: { $ne: true } },
          update: { $set: { trackStock: true, stock: line.counted } },
        },
      };
    }
    const diff = roundQty(line.counted - line.expected);
    if (diff < 0) {
      summary.shortItems++;
      summary.shortValue += -diff * line.purchasePrice;
    } else if (diff > 0) {
      summary.overItems++;
      summary.overValue += diff * line.purchasePrice;
    }
    return { updateOne: { filter: { _id: line.product }, update: stockChange(diff, { trackStock: true }) } };
  });
  await Product.bulkWrite(updates);

  const { capital, saleValue } = await Product.valuation();
  Object.assign(summary, {
    shortValue: money(summary.shortValue),
    overValue: money(summary.overValue),
    capital,
    saleValue,
  });
  await StockCount.updateOne({ _id: count._id }, { $set: { summary } });
  res.json({ ...count, summary });
});

// Throws the stocktake away; nothing in the stock has changed yet
router.delete('/:id', async (req, res) => {
  const { deletedCount } = await StockCount.deleteOne({ _id: req.params.id, status: 'open' });
  if (!deletedCount) await findOpenCount(req.params.id);
  res.status(204).end();
});

export default router;
