import { Router } from 'express';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Category from '../models/Category.js';
import DebtEntry from '../models/DebtEntry.js';
import StockCount from '../models/StockCount.js';
import { httpError } from '../lib/errors.js';
import { escapeRegex } from '../lib/util.js';

const router = Router();
const EDITABLE = [
  'name',
  'barcode',
  'purchasePrice',
  'salePrice',
  'category',
  'unit',
  'hasWholesale',
  'wholesaleQty',
  'wholesalePrice',
  'trackStock',
  'stock',
  'lowStockAlert',
  'blockWhenOut',
];

const pickEditable = (body) =>
  Object.fromEntries(EDITABLE.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));

// Rules that span fields: products sold by the piece count in whole pieces; a wholesale
// price needs its box size (pieces) or weight (kg).
function checkUnits(data) {
  const byPiece = (data.unit ?? 'piece') === 'piece';
  const wholePieces = (value, message) => {
    if (byPiece && value !== undefined && !Number.isInteger(Number(value))) throw httpError(400, message);
  };
  wholePieces(data.stock, 'كمية المخزن يجب أن تكون عددًا صحيحًا من القطع');
  wholePieces(data.lowStockAlert, 'حد التنبيه يجب أن يكون عددًا صحيحًا من القطع');
  if (data.hasWholesale) {
    const size = Number(data.wholesaleQty);
    const price = Number(data.wholesalePrice);
    if (byPiece && !(Number.isInteger(size) && size >= 2)) throw httpError(400, 'عدد القطع في العلبة يجب أن يكون 2 أو أكثر');
    if (!byPiece && !(size > 0)) throw httpError(400, 'أدخل وزن الجملة بالكيلوغرام');
    if (!Number.isFinite(price) || price < 0) throw httpError(400, 'أدخل سعر بيع الجملة');
  }
}

async function assertCategoryExists(id) {
  if (id === undefined) return;
  if (!mongoose.isObjectIdOrHexString(id) || !(await Category.exists({ _id: id }))) {
    throw httpError(400, 'اختر القسم');
  }
}

router.get('/', async (req, res) => {
  const filter = {};
  if (req.query.category) filter.category = String(req.query.category);
  const q = String(req.query.q ?? '').trim().slice(0, 100);
  if (q) {
    const pattern = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ name: pattern }, { barcode: pattern }];
  }
  const products = await Product.find(filter)
    .collation({ locale: 'ar' })
    .sort({ name: 1 })
    .populate('category', 'name')
    .lean();
  res.json(products);
});

// What the stock is worth, for the products page. For the whole shop it also brings the
// customers' debts, which are the shop's money too.
router.get('/valuation', async (req, res) => {
  const category = String(req.query.category ?? '');
  if (category && !mongoose.isObjectIdOrHexString(category)) throw httpError(400, 'اختر القسم');
  const [stock, debts, lastCount] = await Promise.all([
    Product.valuation(category ? { category: new mongoose.Types.ObjectId(category) } : {}),
    category ? null : DebtEntry.totals(),
    StockCount.findOne({ status: 'applied' }).sort({ appliedAt: -1 }).select('appliedAt').lean(),
  ]);
  res.json({ ...stock, debts, lastCountAt: lastCount?.appliedAt ?? null });
});

router.get('/barcode/:code', async (req, res) => {
  const product = await Product.findOne({ barcode: req.params.code.trim() }).populate('category', 'name').lean();
  if (!product) throw httpError(404, 'لا يوجد منتج بهذا الباركود');
  res.json(product);
});

router.post('/', async (req, res) => {
  const data = pickEditable(req.body);
  checkUnits(data);
  await assertCategoryExists(data.category);
  const product = await Product.create(data);
  await product.populate('category', 'name');
  res.status(201).json(product);
});

router.put('/:id', async (req, res) => {
  const data = pickEditable(req.body);
  checkUnits(data);
  await assertCategoryExists(data.category);
  const product = await Product.findByIdAndUpdate(req.params.id, data, {
    returnDocument: 'after',
    runValidators: true,
  }).populate('category', 'name');
  if (!product) throw httpError(404, 'المنتج غير موجود');
  res.json(product);
});

router.delete('/:id', async (req, res) => {
  const deleted = await Product.findByIdAndDelete(req.params.id);
  if (!deleted) throw httpError(404, 'المنتج غير موجود');
  res.status(204).end();
});

export default router;
